'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { SftpClient, connectSftp, SftpError, FLAGS, CHUNK_SIZE, TYPE, packet, u32, bytes } = require('../electron/sftp-client.cjs');

const SERVER = '/usr/libexec/sftp-server';
async function fixture(t) {
  try { await fs.access(SERVER); } catch { t.skip('A local OpenSSH SFTP server is not installed.'); return null; }
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cam-sftp-protocol-')));
  const child = spawn(SERVER, ['-e'], { cwd: directory, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const client = new SftpClient(child); await client.ready;
  t.after(async () => { client.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, client };
}
function fakeChild() {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
  return child;
}
function handshake(child) { child.stdout.write(packet(TYPE.VERSION, u32(3))); }

test('real OpenSSH SFTP transports binary data, Unicode paths and directory metadata', async t => {
  const f = await fixture(t); if (!f) return;
  const { client, directory } = f; assert.equal(await client.realpath('.'), directory);
  const name = path.join(directory, "한글 ' $() ; 파일.bin"), data = Buffer.alloc(CHUNK_SIZE + 17);
  for (let i = 0; i < data.length; i++) data[i] = i % 256;
  const handle = await client.open(name, FLAGS.WRITE | FLAGS.CREAT | FLAGS.EXCL);
  await client.write(handle, 0, data.subarray(0, CHUNK_SIZE)); await client.write(handle, CHUNK_SIZE, data.subarray(CHUNK_SIZE)); await client.closeHandle(handle);
  assert.deepEqual(await fs.readFile(name), data); assert.equal((await client.lstat(name)).size, data.length);
  const read = await client.open(name, FLAGS.READ);
  assert.deepEqual(await client.read(read, 0), data.subarray(0, CHUNK_SIZE)); assert.deepEqual(await client.read(read, CHUNK_SIZE), data.subarray(CHUNK_SIZE)); assert.equal(await client.read(read, data.length), null); await client.closeHandle(read);
  await client.mkdir(path.join(directory, '폴더')); await client.symlink(name, path.join(directory, '연결'));
  assert.equal((await client.lstat(path.join(directory, '연결'))).mode & 0o170000, 0o120000); assert.equal(await client.readlink(path.join(directory, '연결')), name);
  const dir = await client.opendir(directory), entries = [];
  for (;;) { const page = await client.readdir(dir); if (page === null) break; entries.push(...page); }
  await client.closeHandle(dir); assert.ok(entries.some(e => e.name === path.basename(name)));
});

test('v3 rename and exclusive file creation refuse existing destinations without overwrite', async t => {
  const f = await fixture(t); if (!f) return;
  const from = path.join(f.directory, 'source'), to = path.join(f.directory, 'destination'); await fs.writeFile(from, 'source'); await fs.writeFile(to, 'original');
  await assert.rejects(f.client.rename(from, to), SftpError); await assert.rejects(f.client.open(to, FLAGS.WRITE | FLAGS.CREAT | FLAGS.EXCL), SftpError);
  assert.equal(await fs.readFile(to, 'utf8'), 'original'); assert.equal(await fs.readFile(from, 'utf8'), 'source');
  await assert.rejects(f.client.lstat(path.join(f.directory, 'missing')), e => e.code === 2);
  assert.equal(await f.client.realpath('.'), f.directory, 'ordinary server status errors leave the session usable');
});

test('FSTAT reads the open file metadata even after its path is replaced', async t => {
  const f = await fixture(t); if (!f) return;
  const name = path.join(f.directory, 'preview.md'); await fs.writeFile(name, 'original');
  const handle = await f.client.open(name, FLAGS.READ);
  try {
    await fs.rename(name, path.join(f.directory, 'old.md')); await fs.writeFile(name, 'new');
    assert.equal((await f.client.fstat(handle)).size, 8);
    assert.equal((await f.client.lstat(name)).size, 3);
    assert.equal((await f.client.read(handle, 0)).toString(), 'original');
  } finally { await f.client.closeHandle(handle); }
});

test('fragmented packets resolve matching requests and malformed packets close the transport', async () => {
  const child = fakeChild(), client = new SftpClient(child, { timeoutMs: 500 }); handshake(child); await client.ready;
  const request = client.lstat('/test'); await new Promise(resolve => setImmediate(resolve));
  const response = packet(TYPE.ATTRS, Buffer.concat([u32(1), u32(5), Buffer.from('0000000000000003', 'hex'), u32(0o100644)]));
  for (const byte of response) child.stdout.write(Buffer.from([byte])); assert.equal((await request).size, 3);
  const malformed = client.lstat('/again'); await new Promise(resolve => setImmediate(resolve));
  child.stdout.write(packet(TYPE.ATTRS, Buffer.concat([u32(2), u32(1)])));
  await assert.rejects(malformed, /응답이 올바르지/); assert.equal(client.closed, true);
});

test('oversized frames, invalid request ids and unsupported versions are rejected', async () => {
  for (const body of [Buffer.from('0010000200', 'hex'), packet(TYPE.VERSION, u32(4))]) {
    const child = fakeChild(), client = new SftpClient(child, { timeoutMs: 500 }); child.stdout.write(body); await assert.rejects(client.ready); assert.equal(client.closed, true);
  }
  const child = fakeChild(), client = new SftpClient(child, { timeoutMs: 500 }); handshake(child); await client.ready;
  const request = client.stat('/test'); await new Promise(resolve => setImmediate(resolve)); child.stdout.write(packet(TYPE.ATTRS, Buffer.concat([u32(999), u32(0)])));
  await assert.rejects(request, /요청 번호/);
});

test('abort and response timeouts reject pending operations and terminate the transport', async () => {
  const controller = new AbortController(), child = fakeChild(), client = new SftpClient(child, { signal: controller.signal, timeoutMs: 100 }); handshake(child); await client.ready;
  const request = client.lstat('/test'); controller.abort(); await assert.rejects(request, e => e.name === 'AbortError'); assert.equal(client.closed, true);
  const timedChild = fakeChild(), timed = new SftpClient(timedChild, { timeoutMs: 10 }); handshake(timedChild); await timed.ready; await assert.rejects(timed.stat('/test'), /시간이 초과/); assert.equal(timed.closed, true);
});

test('subsystem launch keeps strict SSH options, ProxyJump and literal host arguments', async () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    let invoked, proxyOptions; const child = fakeChild();
    const pending = connectSftp({ platform, configPath: '/tmp/config with spaces', host: { alias: 'safe-host' }, proxyResolver: async (_run, _config, _host, options) => { proxyOptions = options; return 'ssh safe-proxy'; }, spawnImpl: (command, args, options) => { invoked = { command, args, options }; setImmediate(() => handshake(child)); return child; } });
    const client = await pending; client.close();
    assert.equal(invoked.command, platform === 'darwin' ? '/usr/bin/ssh' : 'ssh'); assert.equal(invoked.args[0], '-s'); assert.deepEqual(invoked.args.slice(-3), ['--', 'safe-host', 'sftp']); assert.equal(invoked.options.shell, false);
    assert.equal(invoked.options.detached, platform !== 'win32'); assert.equal(proxyOptions.platform, platform);
    for (const value of ['StrictHostKeyChecking=yes', 'BatchMode=yes', 'PermitLocalCommand=no', 'ForwardAgent=no', 'ProxyJump=none', 'ProxyCommand=ssh safe-proxy']) assert.ok(invoked.args.includes(value));
    assert.equal(invoked.options.env.SSH_ASKPASS_REQUIRE, 'never');
  }
});

test('authentication and unknown server keys provide the SSH button recovery action', async () => {
  for (const stderr of ['Permission denied (publickey).', 'Host key verification failed.']) {
    const child = fakeChild(), client = new SftpClient(child); child.stderr.write(stderr); child.emit('close', 255); await assert.rejects(client.ready, /SSH 버튼/);
  }
});

test('a server cannot return file data larger than the requested chunk', async () => {
  const child = fakeChild(), client = new SftpClient(child); handshake(child); await client.ready;
  const request = client.read(Buffer.from('h'), 0, 2); await new Promise(resolve => setImmediate(resolve)); child.stdout.write(packet(TYPE.DATA, Buffer.concat([u32(1), bytes('oversized')])));
  await assert.rejects(request, /응답이 너무 큽니다/); assert.equal(client.closed, true);
});
