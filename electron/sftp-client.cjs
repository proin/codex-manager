'use strict';

const { spawn } = require('node:child_process');
const { buildSshArgs, secureProxyCommand, runProcess, terminateProcessGroup } = require('./host-ssh.cjs');
const { sshExecutable } = require('./local-commands.cjs');

const TYPE = { INIT: 1, VERSION: 2, OPEN: 3, CLOSE: 4, READ: 5, WRITE: 6, LSTAT: 7, FSTAT: 8, OPENDIR: 11, READDIR: 12, REMOVE: 13, MKDIR: 14, RMDIR: 15, REALPATH: 16, STAT: 17, RENAME: 18, READLINK: 19, SYMLINK: 20, STATUS: 101, HANDLE: 102, DATA: 103, NAME: 104, ATTRS: 105 };
const FLAGS = { READ: 1, WRITE: 2, CREAT: 8, EXCL: 32 };
const MAX_PACKET = 1024 * 1024;
const CHUNK_SIZE = 32 * 1024;
const u32 = (value) => { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b; };
const u64 = (value) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(value)); return b; };
const bytes = (value) => { const b = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8'); return Buffer.concat([u32(b.length), b]); };
const packet = (type, body) => { const b = Buffer.concat([Buffer.from([type]), body]); return Buffer.concat([u32(b.length), b]); };

class Reader {
  constructor(buffer) { this.buffer = buffer; this.offset = 0; }
  take(count) { if (!Number.isInteger(count) || count < 0 || this.offset + count > this.buffer.length) throw new Error('SFTP 응답이 올바르지 않습니다.'); const b = this.buffer.subarray(this.offset, this.offset + count); this.offset += count; return b; }
  uint32() { return this.take(4).readUInt32BE(); }
  uint64() { const value = this.take(8).readBigUInt64BE(); if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('파일 크기가 지원 범위를 초과합니다.'); return Number(value); }
  string() { return this.take(this.uint32()); }
  text() { const b = this.string(); const value = b.toString('utf8'); if (!Buffer.from(value, 'utf8').equals(b) || value.includes('\0')) throw new Error('서버 파일 이름을 읽지 못했습니다.'); return value; }
  attrs() {
    const flags = this.uint32(); if (flags & ~0x8000000f) throw new Error('SFTP 파일 정보가 올바르지 않습니다.');
    const a = {};
    if (flags & 1) a.size = this.uint64();
    if (flags & 2) { a.uid = this.uint32(); a.gid = this.uint32(); }
    if (flags & 4) a.mode = this.uint32();
    if (flags & 8) { a.accessedAt = this.uint32() * 1000; a.modifiedAt = this.uint32() * 1000; }
    if (flags & 0x80000000) { const n = this.uint32(); if (n > 1000) throw new Error('SFTP 파일 정보가 너무 큽니다.'); for (let i = 0; i < n; i++) { this.string(); this.string(); } }
    return a;
  }
  end() { if (this.offset !== this.buffer.length) throw new Error('SFTP 응답에 불필요한 데이터가 있습니다.'); }
}

class SftpError extends Error {
  constructor(code, message) { super(message || ({ 2: '파일 또는 폴더를 찾을 수 없습니다.', 3: '파일 접근 권한이 없습니다.', 4: '서버 파일 작업을 완료하지 못했습니다.', 8: '서버가 이 파일 작업을 지원하지 않습니다.' }[code] || 'SFTP 요청에 실패했습니다.')); this.name = 'SftpError'; this.code = code; }
}
function canceled() { const e = new Error('파일 작업이 취소되었습니다.'); e.name = 'AbortError'; return e; }
function connectionError(stderr) {
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|No .* host key is known/i.test(stderr)) return new Error('SSH 서버 키를 확인하지 못했습니다. SSH 버튼으로 접속한 뒤 다시 시도하십시오.');
  if (/Permission denied|Authentication failed|Too many authentication failures|passphrase/i.test(stderr)) return new Error('SSH 인증에 실패했습니다. SSH 버튼으로 접속하여 키 등록과 SSH 에이전트 설정을 확인하십시오.');
  return new Error('SFTP 연결이 종료되었습니다. SSH 버튼으로 접속하여 연결과 SFTP 지원 여부를 확인하십시오.');
}

class SftpClient {
  constructor(child, { signal, timeoutMs = 20000 } = {}) {
    this.child = child; this.signal = signal; this.timeoutMs = timeoutMs; this.pending = new Map(); this.nextId = 1; this.buffer = Buffer.alloc(0); this.stderr = ''; this.closed = false; this.error = null;
    this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    this.handshakeTimer = setTimeout(() => this.fail(new Error('SFTP 서버가 제한 시간 안에 응답하지 않았습니다.')), timeoutMs);
    child.stdout.on('data', chunk => this.receive(chunk));
    child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk.toString()).slice(-8192); });
    child.stdin.on('error', () => this.fail(connectionError(this.stderr)));
    child.once('error', () => this.fail(new Error('SSH 명령을 실행하지 못했습니다. SSH 프로그램 설치를 확인하십시오.')));
    child.once('close', () => this.fail(connectionError(this.stderr)));
    this.abort = () => this.fail(canceled());
    signal?.addEventListener('abort', this.abort, { once: true });
    if (signal?.aborted) this.abort();
    else child.stdin.write(packet(TYPE.INIT, u32(3)));
  }

  receive(chunk) {
    if (this.closed) return;
    try {
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
      while (this.buffer.length >= 4) {
        const size = this.buffer.readUInt32BE();
        if (size < 1 || size > MAX_PACKET) throw new Error('SFTP 응답 크기가 올바르지 않습니다.');
        if (this.buffer.length < size + 4) break;
        const body = this.buffer.subarray(4, size + 4); this.buffer = this.buffer.subarray(size + 4);
        const type = body[0], r = new Reader(body.subarray(1));
        if (type === TYPE.VERSION) {
          if (!this.readyResolve) throw new Error('SFTP 초기 응답이 중복되었습니다.');
          if (r.uint32() !== 3) throw new Error('이 서버의 SFTP 버전은 지원하지 않습니다.');
          while (r.offset < r.buffer.length) { r.string(); r.string(); }
          clearTimeout(this.handshakeTimer); this.readyResolve(); this.readyResolve = null; this.readyReject = null;
          continue;
        }
        if (this.readyResolve) throw new Error('SFTP 초기 응답이 올바르지 않습니다.');
        const id = r.uint32(), item = this.pending.get(id);
        if (!item) throw new Error('SFTP 요청 번호가 올바르지 않습니다.');
        this.pending.delete(id); clearTimeout(item.timer);
        try {
          if (type === TYPE.STATUS) {
            const code = r.uint32(); r.text(); r.text(); r.end();
            if (code === 0 && item.expected === TYPE.STATUS) item.resolve(null);
            else if (code === 1 && item.eof) item.resolve(null);
            else item.reject(new SftpError(code));
          } else if (type !== item.expected) throw new Error('SFTP 응답 종류가 올바르지 않습니다.');
          else { const result = item.parse(r); r.end(); item.resolve(result); }
        } catch (e) { item.reject(e); this.fail(e); }
      }
      if (this.buffer.length > MAX_PACKET + 4) throw new Error('SFTP 응답이 너무 큽니다.');
    } catch (e) { this.fail(e); }
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true; this.error = error; clearTimeout(this.handshakeTimer);
    this.signal?.removeEventListener('abort', this.abort);
    this.readyReject?.(error); this.readyResolve = null; this.readyReject = null;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear(); this.buffer = Buffer.alloc(0);
    terminateProcessGroup(this.child); this.child.stdin.destroy(); this.child.stdout.destroy(); this.child.stderr.destroy();
  }
  close() { this.fail(new Error('SFTP 연결을 종료했습니다.')); }
  async request(type, fields, expected = TYPE.STATUS, parse = () => null, eof = false) {
    await this.ready;
    if (this.closed) throw this.error;
    if (this.pending.size >= 32) throw new Error('동시에 실행하는 SFTP 요청이 너무 많습니다.');
    const id = this.nextId++; if (this.nextId > 0xffffffff) this.nextId = 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error('SFTP 요청 시간이 초과되었습니다.')), this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, expected, parse, eof });
      this.child.stdin.write(packet(type, Buffer.concat([u32(id), ...fields])));
    });
  }
  async realpath(p) { const names = await this.request(TYPE.REALPATH, [bytes(p)], TYPE.NAME, readNames); if (names.length !== 1 || !names[0].name.startsWith('/')) throw new Error('서버 파일 경로가 올바르지 않습니다.'); return names[0].name; }
  stat(p) { return this.request(TYPE.STAT, [bytes(p)], TYPE.ATTRS, r => r.attrs()); }
  lstat(p) { return this.request(TYPE.LSTAT, [bytes(p)], TYPE.ATTRS, r => r.attrs()); }
  fstat(h) { return this.request(TYPE.FSTAT, [bytes(h)], TYPE.ATTRS, r => r.attrs()); }
  open(p, flags, mode = 0o600) { return this.request(TYPE.OPEN, [bytes(p), u32(flags), u32(4), u32(mode)], TYPE.HANDLE, r => r.string()); }
  closeHandle(h) { return this.request(TYPE.CLOSE, [bytes(h)]); }
  read(h, offset, length = CHUNK_SIZE) { if (!Number.isInteger(length) || length < 1 || length > CHUNK_SIZE) throw new Error('전송 데이터 크기가 올바르지 않습니다.'); return this.request(TYPE.READ, [bytes(h), u64(offset), u32(length)], TYPE.DATA, r => { const data = r.string(); if (data.length > length) throw new Error('SFTP 파일 응답이 너무 큽니다.'); return data; }, true); }
  write(h, offset, data) { if (data.length > CHUNK_SIZE) throw new Error('전송 데이터가 너무 큽니다.'); return this.request(TYPE.WRITE, [bytes(h), u64(offset), bytes(data)]); }
  opendir(p) { return this.request(TYPE.OPENDIR, [bytes(p)], TYPE.HANDLE, r => r.string()); }
  readdir(h) { return this.request(TYPE.READDIR, [bytes(h)], TYPE.NAME, readNames, true); }
  remove(p) { return this.request(TYPE.REMOVE, [bytes(p)]); }
  mkdir(p, mode = 0o755) { return this.request(TYPE.MKDIR, [bytes(p), u32(4), u32(mode)]); }
  rmdir(p) { return this.request(TYPE.RMDIR, [bytes(p)]); }
  rename(from, to) { return this.request(TYPE.RENAME, [bytes(from), bytes(to)]); }
  async readlink(p) { const names = await this.request(TYPE.READLINK, [bytes(p)], TYPE.NAME, readNames); if (names.length !== 1) throw new Error('연결 파일의 경로를 읽지 못했습니다.'); return names[0].name; }
  // OpenSSH's v3 implementation takes target first, then link path.
  symlink(target, p) { return this.request(TYPE.SYMLINK, [bytes(target), bytes(p)]); }
}
function readNames(r) {
  const count = r.uint32(); if (count > 10000) throw new Error('한 번에 받은 파일 목록이 너무 큽니다.');
  return Array.from({ length: count }, () => { const name = r.text(); r.text(); return { name, ...r.attrs() }; });
}
async function connectSftp({ configPath, host, signal, platform = process.platform, spawnImpl = spawn, runCommand = runProcess, proxyResolver = secureProxyCommand, timeoutMs } = {}) {
  const proxyCommand = await proxyResolver(runCommand, configPath, host, { signal, platform });
  if (signal?.aborted) throw canceled();
  const args = ['-s', ...buildSshArgs(configPath, host, 'sftp', { proxyCommand })];
  const child = spawnImpl(sshExecutable(platform), args, { shell: false, detached: platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, SSH_ASKPASS_REQUIRE: 'never', DISPLAY: '' } });
  const client = new SftpClient(child, { signal, timeoutMs });
  await client.ready; return client;
}
module.exports = { SftpClient, connectSftp, SftpError, FLAGS, CHUNK_SIZE, TYPE, Reader, packet, u32, u64, bytes, canceled };
