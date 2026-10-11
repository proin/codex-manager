'use strict';

const fs = require('node:fs/promises');
const { constants: FS_CONSTANTS } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { connectSftp, FLAGS, CHUNK_SIZE, canceled } = require('./sftp-client.cjs');

const MAX_ENTRIES = 100000;
const MAX_DEPTH = 100;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
function remotePath(value, home) {
  if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > 32768) throw new Error('파일 경로가 올바르지 않습니다.');
  return path.posix.resolve(home, value || '.');
}
function fileType(mode) { return ({ 0o040000: 'directory', 0o100000: 'file', 0o120000: 'symlink' }[mode & 0o170000] || 'other'); }
function entryName(name) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) throw new Error('서버 파일 이름이 올바르지 않습니다.');
  return name;
}
function paths(value) {
  if (!Array.isArray(value) || !value.length || value.length > 10000 || value.some(p => typeof p !== 'string' || !p || p.includes('\0') || Buffer.byteLength(p) > 32768)) throw new Error('파일 또는 폴더를 선택하십시오.');
  if (new Set(value).size !== value.length) throw new Error('같은 파일을 중복 선택할 수 없습니다.');
  return value;
}
function nonOverlapping(values) {
  const sorted = [...values].sort();
  for (let i = 1; i < sorted.length; i++) if (sorted[i] === sorted[i - 1] || sorted[i].startsWith(sorted[i - 1] + '/')) throw new Error('폴더와 그 안의 파일을 함께 선택할 수 없습니다.');
}
function signature(host) { return JSON.stringify([host.alias, host.optionsText, host.hostName, host.user, host.port, host.identityFile, host.proxyJump]); }
function checkAbort(signal) { if (signal.aborted) throw canceled(); }
function sameRemoteFile(left, right) {
  return ['size', 'mode', 'modifiedAt', 'uid', 'gid'].every(key => left[key] === right[key]);
}
function readableTextFile(info) {
  if (fileType(info.mode || 0) !== 'file') throw new Error('일반 마크다운 파일만 미리 볼 수 있습니다. 연결 파일은 다운로드하여 여십시오.');
  if (!Number.isSafeInteger(info.size) || info.size < 0) throw new Error('파일 크기를 읽지 못했습니다. 파일을 다운로드하여 여십시오.');
  if (info.size > MAX_TEXT_BYTES) throw new Error('파일이 너무 큽니다. 2 MB 이하의 마크다운 파일만 미리 볼 수 있습니다.');
}
async function missing(client, p) { try { await client.lstat(p); return false; } catch (e) { if (e.code === 2) return true; throw e; } }
async function assertMissing(client, p) { if (!await missing(client, p)) throw new Error(`같은 이름의 파일 또는 폴더가 있습니다: ${path.posix.basename(p)}`); }
async function localMissing(p) { try { await fs.lstat(p); return false; } catch (e) { if (e.code === 'ENOENT') return true; throw e; } }
async function assertLocalMissing(p) { if (!await localMissing(p)) throw new Error(`같은 이름의 파일 또는 폴더가 있습니다: ${path.basename(p)}`); }
async function readDirectory(client, p) {
  const handle = await client.opendir(p), result = [];
  try {
    for (;;) {
      const entries = await client.readdir(handle); if (entries === null) break;
      if (!entries.length) throw new Error('서버가 비어 있는 파일 목록을 반복해서 보냈습니다.');
      for (const item of entries) {
        if (item.name === '.' || item.name === '..') continue;
        entryName(item.name); result.push(item);
        if (result.length > MAX_ENTRIES) throw new Error('파일 목록이 너무 큽니다.');
      }
    }
  } finally { await client.closeHandle(handle).catch(() => {}); }
  return result;
}
function protectedPath(p, home) { if (p === '/' || p === home) throw new Error('최상위 폴더와 사용자 홈 폴더는 변경하거나 삭제할 수 없습니다.'); }
function localName(name) {
  entryName(name);
  if (process.platform === 'win32' && (/[\\:*?"<>|\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name))) throw new Error(`이 컴퓨터에 저장할 수 없는 파일 이름입니다: ${name}`);
  return name;
}
function transferError(error) {
  return { EACCES: '이 컴퓨터의 파일 접근 권한이 없습니다.', EPERM: '이 컴퓨터에서 파일 작업을 허용하지 않습니다.', ENOENT: '이 컴퓨터의 파일 또는 폴더를 찾을 수 없습니다.', EEXIST: '같은 이름의 파일 또는 폴더가 있습니다. 기존 파일은 유지됩니다.', ENOSPC: '이 컴퓨터의 저장 공간이 부족합니다.', ELOOP: '업로드할 파일이 연결 파일로 변경되었습니다. 다시 선택하십시오.' }[error.code] || error.message || '파일 전송을 완료하지 못했습니다.';
}
function nativeType(info) { return info.isDirectory() ? 'directory' : info.isSymbolicLink() ? 'symlink' : info.isFile() ? 'file' : 'other'; }
function sameLocalFile(info, anchor) { return nativeType(info) === anchor.type && info.dev === anchor.dev && info.ino === anchor.ino; }
async function verifyLocalAnchors(anchors) {
  for (const anchor of anchors) {
    const info = await fs.lstat(anchor.source);
    if (!sameLocalFile(info, anchor) || (anchor.canonical && await fs.realpath(anchor.source) !== anchor.canonical)) throw new Error('업로드할 파일 또는 상위 폴더가 변경되었습니다. 다시 선택하십시오.');
  }
}

class HostFileService {
  constructor(options = {}) {
    if (!options.hostService) throw new Error('호스트 관리 서비스가 필요합니다.');
    this.hostService = options.hostService; this.onChange = options.onChange || (() => {});
    this.connect = options.connect || connectSftp; this.connectionOptions = { runCommand: this.hostService.run, ...(options.connectionOptions || {}) };
    this.records = new Map(); this.active = new Map(); this.operations = new Set(); this.sessions = new Set(); this.writeHosts = new Set(); this.closed = false;
  }
  getTransfers() { return [...this.records.values()].reverse().map(record => structuredClone(record)); }
  publish() { try { this.onChange(this.getTransfers()); } catch { /* A window may be closing. */ } }
  async validate(id, expected) {
    if (this.closed) throw new Error('파일 관리가 종료되었습니다.');
    const current = this.hostService.requireHost(id, true), state = this.hostService.state;
    const ref = expected || { host: structuredClone(current), configPath: state.configPath, revision: state.revision, connectionRevision: state.connectionRevision };
    const latest = await this.hostService.config.read();
    const latestHost = latest.hosts.find(h => h.id === id);
    if (!latestHost || signature(latestHost) !== signature(ref.host) || signature(current) !== signature(ref.host) || latest.configPath !== ref.configPath || state.configPath !== ref.configPath || (ref.connectionRevision ? latest.connectionRevision !== ref.connectionRevision : latest.revision !== ref.revision)) throw new Error('SSH 설정이 변경되었습니다. 호스트 목록을 새로고침하십시오.');
    return ref;
  }
  async connection(id, signal, expected) {
    const ref = await this.validate(id, expected); checkAbort(signal);
    const client = await this.connect({ ...this.connectionOptions, configPath: ref.configPath, host: ref.host, signal });
    this.sessions.add(client);
    try { await this.validate(id, ref); checkAbort(signal); return { client, ref, home: await client.realpath('.') }; }
    catch (e) { this.sessions.delete(client); client.close(); throw e; }
  }
  release(client) { this.sessions.delete(client); client?.close(); }
  reserveHost(id, controller) {
    if (this.hostService.active?.has(id) || this.hostService.isBatchTarget?.(id)) throw new Error('이 호스트의 작업이 진행 중입니다. 완료 후 다시 시도하십시오.');
    this.hostService.active?.set(id, controller);
  }
  releaseHost(id, controller) { if (this.hostService.active?.get(id) === controller) this.hostService.active.delete(id); }
  async validateCleanup(id, ref) {
    const latest = await this.hostService.config.read(), latestHost = latest.hosts.find(h => h.id === id);
    if (!latestHost || signature(latestHost) !== signature(ref.host) || latest.configPath !== ref.configPath || (ref.connectionRevision ? latest.connectionRevision !== ref.connectionRevision : latest.revision !== ref.revision)) throw new Error('SSH 설정이 변경되었습니다.');
  }
  async operation(id, work, { write = false } = {}) {
    if (write && this.writeHosts.has(id)) throw new Error('이 호스트의 파일 작업이 진행 중입니다. 완료 후 다시 시도하십시오.');
    if (write) this.writeHosts.add(id);
    const controller = new AbortController();
    try { if (write) this.reserveHost(id, controller); } catch (e) { this.writeHosts.delete(id); throw e; }
    const task = (async () => {
      let client;
      try { const session = await this.connection(id, controller.signal); client = session.client; return await work(session, controller.signal); }
      finally { this.release(client); if (write) { this.writeHosts.delete(id); this.releaseHost(id, controller); } }
    })();
    const record = { task, controller }; this.operations.add(record);
    try { return await task; } finally { this.operations.delete(record); }
  }
  async listFiles(id, requestedPath = '') {
    return this.operation(id, async ({ client, home }) => {
      const p = await client.realpath(remotePath(requestedPath, home));
      const entries = (await readDirectory(client, p)).map(item => ({ name: item.name, path: path.posix.join(p, item.name), type: fileType(item.mode || 0), size: item.size ?? null, modifiedAt: item.modifiedAt ?? null, mode: item.mode ?? null }));
      entries.sort((a, b) => (a.type === 'directory' ? 0 : 1) - (b.type === 'directory' ? 0 : 1) || a.name.localeCompare(b.name));
      return { hostId: id, path: p, home, entries };
    });
  }
  async readTextFile(id, requestedPath) {
    return this.operation(id, async ({ client, home, ref }, signal) => {
      const selected = remotePath(requestedPath, home);
      if (!/\.(?:md|markdown)$/i.test(selected)) throw new Error('마크다운 파일을 선택하십시오.');
      const before = await client.lstat(selected); readableTextFile(before);
      const p = await client.realpath(selected), canonical = await client.lstat(p);
      if (!sameRemoteFile(before, canonical)) throw new Error('파일이 변경되었습니다. 다시 여십시오.');
      let handle;
      try {
        checkAbort(signal); handle = await client.open(p, FLAGS.READ);
        const opened = await client.fstat(handle); readableTextFile(opened);
        if (!sameRemoteFile(before, opened)) throw new Error('파일이 변경되었습니다. 다시 여십시오.');
        // Metadata sets the read bound. Never grow the preview buffer beyond 2 MiB.
        const chunks = []; let offset = 0;
        while (offset < before.size) {
          checkAbort(signal);
          const length = Math.min(CHUNK_SIZE, before.size - offset), chunk = await client.read(handle, offset, length);
          checkAbort(signal);
          if (!Buffer.isBuffer(chunk) || !chunk.length || chunk.length > length) throw new Error('파일이 변경되었거나 내용을 읽지 못했습니다. 다시 여십시오.');
          chunks.push(chunk); offset += chunk.length;
        }
        // Detect growth even if the server has not updated its timestamp yet.
        if (await client.read(handle, offset, 1) !== null) throw new Error('파일이 변경되었습니다. 다시 여십시오.');
        checkAbort(signal);
        const afterOpen = await client.fstat(handle), afterPath = await client.lstat(selected);
        if (!sameRemoteFile(before, afterOpen) || !sameRemoteFile(before, afterPath) || await client.realpath(selected) !== p) throw new Error('파일이 변경되었습니다. 다시 여십시오.');
        await this.validate(id, ref); checkAbort(signal);
        let content;
        try { content = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, offset)); }
        catch { throw new Error('UTF-8로 저장된 마크다운 파일만 미리 볼 수 있습니다. 파일을 다운로드하여 여십시오.'); }
        if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(content)) throw new Error('텍스트 파일이 아닙니다. 파일을 다운로드하여 여십시오.');
        return { hostId: id, path: selected, name: path.posix.basename(selected), content, size: offset, modifiedAt: before.modifiedAt ?? null };
      } finally { if (handle) await client.closeHandle(handle).catch(() => {}); }
    });
  }
  async createDirectory(id, requestedPath) {
    return this.operation(id, async ({ client, home }) => { const p = remotePath(requestedPath, home); protectedPath(p, home); await assertMissing(client, p); await client.mkdir(p); return { path: p }; }, { write: true });
  }
  async renameFile(id, sourcePath, targetPath) {
    return this.operation(id, async ({ client, home }) => {
      const from = remotePath(sourcePath, home), to = remotePath(targetPath, home); protectedPath(from, home); protectedPath(to, home);
      const attrs = await client.lstat(from); if (fileType(attrs.mode || 0) === 'directory') protectedPath(await client.realpath(from), home);
      await assertMissing(client, to); await client.rename(from, to); return { path: to, sourcePath: from };
    }, { write: true });
  }
  async moveFiles(id, selectedPaths, targetDirectory) {
    paths(selectedPaths);
    return this.operation(id, async ({ client, home }, signal) => {
      const target = await client.realpath(remotePath(targetDirectory, home)); if (fileType((await client.stat(target)).mode || 0) !== 'directory') throw new Error('이동할 폴더를 선택하십시오.');
      nonOverlapping(selectedPaths.map(item => remotePath(item, home)));
      const moves = [];
      for (const item of selectedPaths) {
        const from = remotePath(item, home); protectedPath(from, home); const info = await client.lstat(from), to = path.posix.join(target, path.posix.basename(from));
        if (fileType(info.mode || 0) === 'directory') { const actual = await client.realpath(from); protectedPath(actual, home); if (target === actual || target.startsWith(actual + '/')) throw new Error('폴더를 자신의 하위 폴더로 이동할 수 없습니다.'); }
        await assertMissing(client, to); moves.push({ from, to });
      }
      if (new Set(moves.map(m => m.to)).size !== moves.length) throw new Error('같은 이름의 파일이 선택되었습니다.');
      const moved = [];
      try { for (const move of moves) { checkAbort(signal); await client.rename(move.from, move.to); moved.push(move.to); } }
      catch (e) { e.message += ` 완료된 이동: ${moved.length}개. 폴더를 새로고침하십시오.`; throw e; }
      return { paths: moved, path: target };
    }, { write: true });
  }
  async deleteFiles(id, selectedPaths) {
    paths(selectedPaths);
    return this.operation(id, async ({ client, home }, signal) => {
      const selected = [];
      nonOverlapping(selectedPaths.map(item => remotePath(item, home)));
      // Validate every top-level item before removing any of them.
      for (const item of selectedPaths) {
        const p = remotePath(item, home); protectedPath(p, home); const attrs = await client.lstat(p);
        if (fileType(attrs.mode || 0) === 'directory') protectedPath(await client.realpath(p), home);
        selected.push(p);
      }
      let removed = 0;
      const remove = async (p, depth = 0) => {
        checkAbort(signal); if (depth > MAX_DEPTH || removed >= MAX_ENTRIES) throw new Error('삭제할 폴더가 너무 크거나 깊습니다.');
        const attrs = await client.lstat(p);
        if (fileType(attrs.mode || 0) === 'directory') {
          protectedPath(await client.realpath(p), home);
          for (const item of await readDirectory(client, p)) await remove(path.posix.join(p, item.name), depth + 1);
          await client.rmdir(p);
        } else await client.remove(p); // LSTAT ensures symlinks are removed, never traversed.
        removed++;
      };
      try { for (const p of selected) await remove(p); }
      catch (e) { e.message += ` 삭제된 항목: ${removed}개. 폴더를 새로고침하십시오.`; throw e; }
      return { paths: selected, removed };
    }, { write: true });
  }

  async transfer(id, direction, work) {
    if (this.closed) throw new Error('파일 관리가 종료되었습니다.');
    this.hostService.requireHost(id, true);
    if (this.writeHosts.has(id)) throw new Error('이 호스트의 파일 작업이 진행 중입니다. 완료 후 다시 시도하십시오.');
    this.writeHosts.add(id);
    const record = { id: crypto.randomUUID(), hostId: id, direction, status: 'running', completedBytes: 0, totalBytes: 0, currentFile: '', error: null, message: '파일 목록을 읽고 있습니다.', completedFiles: 0 };
    this.records.set(record.id, record);
    for (const [key, value] of this.records) { if (this.records.size <= 100) break; if (value.status !== 'running') this.records.delete(key); }
    const controller = new AbortController();
    try { this.reserveHost(id, controller); } catch (e) { this.writeHosts.delete(id); this.records.delete(record.id); throw e; }
    const task = (async () => {
      let client, ref;
      const partials = new Set();
      let lastPublished = 0;
      const state = { record, signal: controller.signal, partials, update: (patch, force = false) => { Object.assign(record, patch); const now = Date.now(); if (force || Object.keys(patch).length || now - lastPublished >= 100) { lastPublished = now; this.publish(); } } };
      try {
        const session = await this.connection(id, controller.signal); client = session.client; ref = session.ref;
        await work(session, state); checkAbort(controller.signal);
        record.status = 'completed'; record.message = '전송을 완료했습니다.';
      } catch (e) {
        record.status = controller.signal.aborted || e.name === 'AbortError' ? 'canceled' : 'error';
        record.error = record.status === 'error' ? transferError(e) : null;
        record.message = `${record.status === 'canceled' ? '전송을 취소했습니다.' : '전송을 완료하지 못했습니다.'} 완료된 파일: ${record.completedFiles}개. 생성된 폴더와 완료된 파일은 유지됩니다.`;
      } finally {
        this.release(client);
        if (partials.size) {
          try {
            if (direction === 'upload') {
              // Cancellation closes the transport. Reconnect only to remove our exclusive temp files.
              // Never resolve a modified SSH alias for cleanup on another server.
              await this.validateCleanup(id, ref);
              const cleanupController = new AbortController(); const timer = setTimeout(() => cleanupController.abort(), 15000);
              let cleanup;
              try { cleanup = await this.connect({ ...this.connectionOptions, configPath: ref.configPath, host: ref.host, signal: cleanupController.signal }); await this.validateCleanup(id, ref); for (const p of partials) { try { await cleanup.remove(p); } catch (e) { if (e.code !== 2) throw e; } } }
              finally { clearTimeout(timer); cleanup?.close(); }
            } else for (const p of partials) await fs.rm(p, { force: true });
          } catch { record.error = [record.error, '임시 파일을 지우지 못했습니다. 폴더를 새로고침하여 확인하십시오.'].filter(Boolean).join(' '); record.message += ' 임시 파일 정리가 필요합니다.'; if (record.status === 'completed') record.status = 'error'; }
        }
        this.writeHosts.delete(id); this.releaseHost(id, controller); this.active.delete(record.id); this.publish();
      }
      return structuredClone(record);
    })();
    this.active.set(record.id, { controller, task }); this.publish();
    return task;
  }
  async uploadFiles(id, localPaths, targetDirectory) {
    paths(localPaths);
    return this.transfer(id, 'upload', async ({ client, home }, state) => {
      const target = await client.realpath(remotePath(targetDirectory, home)); if (fileType((await client.stat(target)).mode || 0) !== 'directory') throw new Error('업로드할 폴더를 선택하십시오.');
      const plan = []; const targets = new Set();
      const visit = async (source, destination, depth = 0, ancestors = []) => {
        checkAbort(state.signal); if (depth > MAX_DEPTH || plan.length >= MAX_ENTRIES) throw new Error('전송할 폴더가 너무 크거나 깊습니다.');
        await verifyLocalAnchors(ancestors);
        const info = await fs.lstat(source), type = nativeType(info);
        if (type === 'other') throw new Error('일반 파일과 폴더, 연결 파일만 전송할 수 있습니다.');
        const canonical = type === 'symlink' ? null : await fs.realpath(source);
        const parent = ancestors.at(-1);
        if (canonical && parent && canonical !== path.join(parent.canonical, path.basename(source))) throw new Error('업로드할 상위 폴더가 변경되었습니다. 다시 선택하십시오.');
        const anchor = { source, type, canonical, dev: info.dev, ino: info.ino }, anchors = [...ancestors, anchor];
        await verifyLocalAnchors(anchors);
        if (targets.has(destination)) throw new Error('같은 이름의 파일이 선택되었습니다.'); targets.add(destination);
        // Descendants cannot already exist when their top-level folder is absent.
        if (depth === 0) await assertMissing(client, destination);
        await verifyLocalAnchors(anchors);
        plan.push({ source, destination, type, size: info.size, modifiedAt: info.mtimeMs, mode: info.mode, anchors, anchor, link: type === 'symlink' ? await fs.readlink(source) : null });
        if (type === 'file') state.record.totalBytes += info.size;
        if (type === 'directory') {
          const names = await fs.readdir(source); await verifyLocalAnchors(anchors);
          for (const name of names) await visit(path.join(source, name), path.posix.join(destination, entryName(name)), depth + 1, anchors);
        }
      };
      for (const sourcePath of localPaths) {
        if (!path.isAbsolute(sourcePath)) throw new Error('이 컴퓨터의 파일 경로가 올바르지 않습니다.');
        const source = path.resolve(sourcePath); await visit(source, path.posix.join(target, entryName(path.basename(source))));
      }
      state.update({ message: '파일을 업로드하고 있습니다.' });
      for (const item of plan) {
        checkAbort(state.signal); state.update({ currentFile: item.destination });
        await verifyLocalAnchors(item.anchors);
        if (item.type === 'directory') await client.mkdir(item.destination, (item.mode & 0o777) | 0o700);
        else if (item.type === 'symlink') { await assertMissing(client, item.destination); await verifyLocalAnchors(item.anchors); if (await fs.readlink(item.source) !== item.link) throw new Error('업로드할 연결 파일이 변경되었습니다. 다시 선택하십시오.'); await client.symlink(item.link, item.destination); state.record.completedFiles++; }
        else {
          const temp = path.posix.join(path.posix.dirname(item.destination), `.codex-manager-${crypto.randomUUID()}.part`);
          let local, remote;
          try {
            local = await fs.open(item.source, FS_CONSTANTS.O_RDONLY | (FS_CONSTANTS.O_NOFOLLOW || 0)); const current = await local.stat(); if (!sameLocalFile(current, item.anchor) || current.size !== item.size || current.mtimeMs !== item.modifiedAt) throw new Error('업로드할 파일이 변경되었습니다. 다시 선택하십시오.');
            await verifyLocalAnchors(item.anchors);
            remote = await client.open(temp, FLAGS.WRITE | FLAGS.CREAT | FLAGS.EXCL, item.mode & 0o777); state.partials.add(temp);
            const buffer = Buffer.alloc(CHUNK_SIZE); let offset = 0;
            while (offset < item.size) {
              checkAbort(state.signal); const { bytesRead } = await local.read(buffer, 0, Math.min(CHUNK_SIZE, item.size - offset), offset); if (!bytesRead) throw new Error('업로드할 파일이 전송 중 변경되었습니다.');
              await client.write(remote, offset, buffer.subarray(0, bytesRead)); offset += bytesRead; state.record.completedBytes += bytesRead; state.update({}, offset === bytesRead || offset === item.size);
            }
            const after = await local.stat(); if (after.size !== current.size || after.mtimeMs !== current.mtimeMs) throw new Error('업로드할 파일이 전송 중 변경되었습니다.');
            await client.closeHandle(remote); remote = null; checkAbort(state.signal);
            await assertMissing(client, item.destination); await client.rename(temp, item.destination); state.partials.delete(temp); state.record.completedFiles++;
          } finally { await local?.close().catch(() => {}); if (remote) await client.closeHandle(remote).catch(() => {}); }
        }
        state.update({});
      }
    });
  }
  async downloadFiles(id, remotePaths, localDirectory) {
    paths(remotePaths);
    if (typeof localDirectory !== 'string' || !path.isAbsolute(localDirectory) || localDirectory.includes('\0')) throw new Error('다운로드할 폴더를 선택하십시오.');
    return this.transfer(id, 'download', async ({ client, home }, state) => {
      const target = await fs.realpath(localDirectory); if (!(await fs.stat(target)).isDirectory()) throw new Error('다운로드할 폴더를 선택하십시오.');
      const plan = [], targets = new Set();
      const visit = async (source, destination, depth = 0) => {
        checkAbort(state.signal); if (depth > MAX_DEPTH || plan.length >= MAX_ENTRIES) throw new Error('전송할 폴더가 너무 크거나 깊습니다.');
        const info = await client.lstat(source), type = fileType(info.mode || 0);
        if (type === 'other') throw new Error('일반 파일과 폴더, 연결 파일만 전송할 수 있습니다.');
        const key = process.platform === 'win32' ? destination.toLowerCase() : destination; if (targets.has(key)) throw new Error('같은 이름의 파일이 선택되었습니다.'); targets.add(key);
        if (depth === 0) await assertLocalMissing(destination);
        plan.push({ source, destination, type, size: info.size || 0, modifiedAt: info.modifiedAt, mode: info.mode, link: type === 'symlink' ? await client.readlink(source) : null });
        if (type === 'file') state.record.totalBytes += info.size || 0;
        if (type === 'directory') for (const item of await readDirectory(client, source)) await visit(path.posix.join(source, item.name), path.join(destination, localName(item.name)), depth + 1);
      };
      for (const requested of remotePaths) { const source = remotePath(requested, home); protectedPath(source, home); await visit(source, path.join(target, localName(path.posix.basename(source)))); }
      state.update({ message: '파일을 다운로드하고 있습니다.' });
      for (const item of plan) {
        checkAbort(state.signal); state.update({ currentFile: item.source });
        if (item.type === 'directory') await fs.mkdir(item.destination, { mode: (item.mode & 0o777) | 0o700 });
        else if (item.type === 'symlink') { await assertLocalMissing(item.destination); await fs.symlink(item.link, item.destination); state.record.completedFiles++; }
        else {
          const temp = path.join(path.dirname(item.destination), `.codex-manager-${crypto.randomUUID()}.part`); let local, remote;
          try {
            local = await fs.open(temp, 'wx', item.mode & 0o777); state.partials.add(temp);
            remote = await client.open(item.source, FLAGS.READ); const bufferLimit = CHUNK_SIZE; let offset = 0;
            while (offset < item.size) {
              checkAbort(state.signal); const data = await client.read(remote, offset, Math.min(bufferLimit, item.size - offset)); if (!data?.length || data.length > Math.min(bufferLimit, item.size - offset)) throw new Error('다운로드할 파일이 전송 중 변경되었거나 응답이 올바르지 않습니다.');
              let written = 0; while (written < data.length) { const result = await local.write(data, written, data.length - written, offset + written); if (!result.bytesWritten) throw new Error('다운로드할 파일을 저장하지 못했습니다.'); written += result.bytesWritten; }
              offset += data.length; state.record.completedBytes += data.length; state.update({}, offset === data.length || offset === item.size);
            }
            const after = await client.lstat(item.source); if (after.size !== item.size || (item.modifiedAt != null && after.modifiedAt !== item.modifiedAt)) throw new Error('다운로드할 파일이 전송 중 변경되었습니다.');
            await client.closeHandle(remote); remote = null; await local.sync(); await local.close(); local = null; checkAbort(state.signal);
            // link is an atomic no-overwrite publish on the destination filesystem.
            try { await fs.link(temp, item.destination); }
            catch (e) { if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes(e.code)) throw e; await fs.copyFile(temp, item.destination, FS_CONSTANTS.COPYFILE_EXCL); }
            await fs.unlink(temp); state.partials.delete(temp); state.record.completedFiles++;
          } finally { await local?.close().catch(() => {}); if (remote) await client.closeHandle(remote).catch(() => {}); }
        }
        state.update({});
      }
    });
  }
  cancelTransfer(id) { const active = this.active.get(id); if (!active) return false; active.controller.abort(); return true; }
  async close() {
    this.closed = true;
    for (const entry of this.active.values()) entry.controller.abort();
    for (const entry of this.operations) entry.controller.abort();
    await Promise.allSettled([...this.active.values()].map(entry => entry.task).concat([...this.operations].map(entry => entry.task)));
    for (const client of this.sessions) client.close(); this.sessions.clear();
  }
}
module.exports = { HostFileService, remotePath, fileType, readDirectory };
