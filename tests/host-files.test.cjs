'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { HostFileService } = require('../electron/host-files.cjs');
const { SftpClient, CHUNK_SIZE } = require('../electron/sftp-client.cjs');

const SERVER = '/usr/libexec/sftp-server';
async function fixture(t, options = {}) {
  try { await fs.access(SERVER); } catch { t.skip('A local OpenSSH SFTP server is not installed.'); return null; }
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cam-files-service-'))), remote = path.join(root, 'remote'), local = path.join(root, 'local'); await fs.mkdir(remote); await fs.mkdir(local);
  const host = { id: 'one', alias: 'fixture', hostName: 'fixture.invalid', optionsText: '' };
  let revision = 'one', starts = 0;
  const hostService = { active: new Map(), state: { configPath: '/fixture-ssh-config', revision: 'one', hosts: [host] }, requireHost: id => { assert.equal(id, 'one'); return host; }, config: { read: async () => ({ configPath: '/fixture-ssh-config', revision, hosts: [host] }) } };
  const connect = async ({ signal }) => {
    starts++;
    const child = spawn(SERVER, ['-e'], { cwd: remote, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const client = new SftpClient(child, { signal, timeoutMs: 1000 }); await client.ready;
    options.wrap?.(client, starts); return client;
  };
  const events = [], service = new HostFileService({ hostService, connect, onChange: values => { events.push(values); options.onChange?.(values, service); } });
  t.after(async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, remote, local, service, events, host, hostService, changeRevision: value => { revision = value; }, starts: () => starts };
}

test('file browsing and ordinary create, rename, move and delete operations use real SFTP', async t => {
  const f = await fixture(t); if (!f) return;
  await fs.writeFile(path.join(f.remote, '한글.txt'), 'hello'); await fs.symlink('missing', path.join(f.remote, 'broken-link'));
  const listing = await f.service.listFiles('one'); assert.equal(listing.home, f.remote); assert.equal(listing.path, f.remote); assert.equal(listing.entries.find(e => e.name === 'broken-link').type, 'symlink'); assert.equal(listing.entries.find(e => e.name === '한글.txt').size, 5);
  await f.service.createDirectory('one', 'folder'); await f.service.renameFile('one', '한글.txt', 'renamed.txt'); await f.service.moveFiles('one', ['renamed.txt'], 'folder');
  assert.equal(await fs.readFile(path.join(f.remote, 'folder', 'renamed.txt'), 'utf8'), 'hello');
  await f.service.deleteFiles('one', ['folder']); await assert.rejects(fs.stat(path.join(f.remote, 'folder')), e => e.code === 'ENOENT');
});

test('recursive upload and download preserve binary content, Unicode and symlinks without traversing links', async t => {
  const f = await fixture(t); if (!f) return;
  const source = path.join(f.local, '폴더'), nested = path.join(source, 'nested'); await fs.mkdir(nested, { recursive: true });
  const data = Buffer.alloc(CHUNK_SIZE * 4 + 31); for (let i = 0; i < data.length; i++) data[i] = i % 251;
  await fs.writeFile(path.join(nested, '파일.bin'), data); await fs.writeFile(path.join(source, 'zero'), ''); await fs.symlink('../outside', path.join(source, 'link')); await fs.writeFile(path.join(f.local, 'outside'), 'do not traverse');
  const uploaded = await f.service.uploadFiles('one', [source], f.remote); assert.equal(uploaded.status, 'completed'); assert.equal(uploaded.completedBytes, data.length); assert.equal(uploaded.totalBytes, data.length); assert.equal(uploaded.completedFiles, 3);
  assert.deepEqual(await fs.readFile(path.join(f.remote, '폴더', 'nested', '파일.bin')), data); assert.equal(await fs.readlink(path.join(f.remote, '폴더', 'link')), '../outside');
  const downloads = path.join(f.local, 'downloads'); await fs.mkdir(downloads);
  const downloaded = await f.service.downloadFiles('one', [path.join(f.remote, '폴더')], downloads); assert.equal(downloaded.status, 'completed'); assert.deepEqual(await fs.readFile(path.join(downloads, '폴더', 'nested', '파일.bin')), data); assert.equal(await fs.readlink(path.join(downloads, '폴더', 'link')), '../outside');
  assert.ok(f.events.some(values => values[0].status === 'running' && values[0].completedBytes > 0)); assert.equal(f.service.getTransfers()[0].status, 'completed');
});

test('all destinations are preflighted and existing upload/download files remain intact', async t => {
  const f = await fixture(t); if (!f) return;
  const source = path.join(f.local, 'existing'); await fs.writeFile(source, 'new'); await fs.writeFile(path.join(f.remote, 'existing'), 'remote original');
  const upload = await f.service.uploadFiles('one', [source], f.remote); assert.equal(upload.status, 'error'); assert.match(upload.error, /같은 이름/); assert.equal(await fs.readFile(path.join(f.remote, 'existing'), 'utf8'), 'remote original');
  const result = await f.service.downloadFiles('one', [path.join(f.remote, 'existing')], f.local); assert.equal(result.status, 'error'); assert.equal(await fs.readFile(source, 'utf8'), 'new');
  await assert.rejects(f.service.renameFile('one', 'existing', 'existing'), /같은 이름/);
  assert.deepEqual((await fs.readdir(f.remote)).sort(), ['existing']);
});

test('recursive deletion removes symlinks themselves and rejects root, home and canonical home aliases', async t => {
  const f = await fixture(t); if (!f) return;
  const outside = path.join(f.root, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'keep'), 'keep'); await fs.mkdir(path.join(f.remote, 'folder')); await fs.symlink(outside, path.join(f.remote, 'folder', 'link'));
  await f.service.deleteFiles('one', ['folder']); assert.equal(await fs.readFile(path.join(outside, 'keep'), 'utf8'), 'keep');
  for (const p of ['/', f.remote, path.join(f.remote, 'nested', '..')]) await assert.rejects(f.service.deleteFiles('one', [p]), /홈 폴더/);
  await fs.writeFile(path.join(f.remote, 'keep'), 'keep'); await assert.rejects(f.service.deleteFiles('one', ['keep', '/']), /홈 폴더/); assert.equal(await fs.readFile(path.join(f.remote, 'keep'), 'utf8'), 'keep');
});

test('SSH config changes prevent opening a file connection or changing files', async t => {
  const f = await fixture(t); if (!f) return;
  f.changeRevision('changed'); await assert.rejects(f.service.listFiles('one'), /SSH 설정이 변경/); await assert.rejects(f.service.createDirectory('one', 'never-created'), /SSH 설정이 변경/); assert.equal(f.starts(), 0); assert.deepEqual(await fs.readdir(f.remote), []);
});

test('canceling upload retains completed files and removes the current exclusive partial file', async t => {
  let canceled = false;
  const f = await fixture(t, { onChange: (values, service) => { const current = values[0]; if (!canceled && current.status === 'running' && current.completedBytes > 2) { canceled = true; service.cancelTransfer(current.id); } } }); if (!f) return;
  const first = path.join(f.local, 'first'), second = path.join(f.local, 'second'); await fs.writeFile(first, 'ok'); await fs.writeFile(second, Buffer.alloc(CHUNK_SIZE * 10, 7));
  const result = await f.service.uploadFiles('one', [first, second], f.remote); assert.equal(result.status, 'canceled'); assert.equal(result.completedFiles, 1); assert.match(result.message, /완료된 파일: 1개/);
  assert.equal(await fs.readFile(path.join(f.remote, 'first'), 'utf8'), 'ok'); assert.deepEqual((await fs.readdir(f.remote)).sort(), ['first']); assert.equal(f.service.cancelTransfer(result.id), false);
});

test('canceling download never publishes a partial destination and removes its temporary file', async t => {
  let canceled = false;
  const f = await fixture(t, { onChange: (values, service) => { const current = values[0]; if (!canceled && current.status === 'running' && current.completedBytes > 0) { canceled = true; service.cancelTransfer(current.id); } } }); if (!f) return;
  await fs.writeFile(path.join(f.remote, 'large'), Buffer.alloc(CHUNK_SIZE * 8, 9));
  const result = await f.service.downloadFiles('one', ['large'], f.local); assert.equal(result.status, 'canceled'); assert.deepEqual(await fs.readdir(f.local), []); assert.equal(await fs.readFile(path.join(f.remote, 'large')).then(b => b.length), CHUNK_SIZE * 8);
});

test('a raced local destination is never overwritten when completed data is published', async t => {
  let f, inserted = false;
  f = await fixture(t, { wrap: client => { const original = client.closeHandle.bind(client); client.closeHandle = async handle => { await original(handle); if (!inserted) { inserted = true; await fs.writeFile(path.join(f.local, 'file'), 'raced original'); } }; } }); if (!f) return;
  await fs.writeFile(path.join(f.remote, 'file'), 'new');
  const result = await f.service.downloadFiles('one', ['file'], f.local); assert.equal(result.status, 'error'); assert.equal(await fs.readFile(path.join(f.local, 'file'), 'utf8'), 'raced original'); assert.deepEqual(await fs.readdir(f.local), ['file']);
});

test('concurrent mutation is rejected while a transfer owns the host and app close cancels pending work', async t => {
  let reached, release; const ready = new Promise(resolve => { reached = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { wrap: client => { const original = client.write.bind(client); client.write = async (...args) => { reached(); await gate; return original(...args); }; } }); if (!f) return;
  const source = path.join(f.local, 'large'); await fs.writeFile(source, Buffer.alloc(CHUNK_SIZE * 3));
  const upload = f.service.uploadFiles('one', [source], f.remote); await ready;
  assert.equal(f.hostService.active.has('one'), true);
  await assert.rejects(f.service.createDirectory('one', 'busy'), /진행 중/); await assert.rejects(f.service.uploadFiles('one', [source], f.remote), /진행 중/);
  const closing = f.service.close(); release(); await closing; assert.equal((await upload).status, 'canceled'); assert.deepEqual(await fs.readdir(f.remote), []); assert.equal(f.hostService.active.has('one'), false); await assert.rejects(f.service.listFiles('one'), /종료/);
});

test('cancel cleanup never reconnects a changed SSH alias to remove a remote temporary file', async t => {
  let f, canceled = false;
  f = await fixture(t, { onChange: (values, service) => {
    const current = values[0];
    if (!canceled && current.status === 'running' && current.completedBytes > 0) { canceled = true; f.changeRevision('different-server'); f.host.hostName = 'changed.invalid'; service.cancelTransfer(current.id); }
  } }); if (!f) return;
  const source = path.join(f.local, 'large'); await fs.writeFile(source, Buffer.alloc(CHUNK_SIZE * 4));
  const result = await f.service.uploadFiles('one', [source], f.remote);
  assert.equal(result.status, 'canceled'); assert.match(result.error, /임시 파일/); assert.equal(f.starts(), 1);
  const remaining = await fs.readdir(f.remote); assert.equal(remaining.length, 1); assert.match(remaining[0], /^\.codex-manager-.*\.part$/);
});

test('a nested delete or move selection fails before mutating its parent folder', async t => {
  const f = await fixture(t); if (!f) return;
  await fs.mkdir(path.join(f.remote, 'folder')); await fs.mkdir(path.join(f.remote, 'target')); await fs.writeFile(path.join(f.remote, 'folder', 'file'), 'keep');
  await assert.rejects(f.service.deleteFiles('one', ['folder', 'folder/file']), /함께 선택/);
  await assert.rejects(f.service.moveFiles('one', ['folder', 'folder/file'], 'target'), /함께 선택/);
  assert.equal(await fs.readFile(path.join(f.remote, 'folder', 'file'), 'utf8'), 'keep');
});

test('a selected local directory replaced by a symlink during preflight cannot upload outside content', async t => {
  let f, changed = false;
  f = await fixture(t, { wrap: client => {
    const original = client.lstat.bind(client);
    client.lstat = async remote => {
      if (!changed && remote === path.join(f.remote, 'selected')) {
        changed = true; await fs.rename(path.join(f.local, 'selected'), path.join(f.local, 'original')); await fs.symlink(path.join(f.local, 'outside'), path.join(f.local, 'selected'));
      }
      return original(remote);
    };
  } }); if (!f) return;
  const source = path.join(f.local, 'selected'); await fs.mkdir(source); await fs.writeFile(path.join(source, 'file'), 'selected'); await fs.mkdir(path.join(f.local, 'outside')); await fs.writeFile(path.join(f.local, 'outside', 'secret'), 'unselected');
  const result = await f.service.uploadFiles('one', [source], f.remote);
  assert.equal(result.status, 'error'); assert.match(result.error, /변경되었습니다/); assert.deepEqual(await fs.readdir(f.remote), []);
});

test('a directory ancestor replaced after planning cannot redirect a file read to outside content', async t => {
  let f, changed = false;
  f = await fixture(t, { wrap: client => {
    const original = client.mkdir.bind(client);
    client.mkdir = async (...args) => {
      const result = await original(...args);
      if (!changed) { changed = true; await fs.rename(path.join(f.local, 'selected'), path.join(f.local, 'original')); await fs.symlink(path.join(f.local, 'outside'), path.join(f.local, 'selected')); }
      return result;
    };
  } }); if (!f) return;
  const source = path.join(f.local, 'selected'); await fs.mkdir(source); await fs.writeFile(path.join(source, 'file'), 'selected'); await fs.mkdir(path.join(f.local, 'outside')); await fs.writeFile(path.join(f.local, 'outside', 'file'), 'outside-secret');
  const result = await f.service.uploadFiles('one', [source], f.remote);
  assert.equal(result.status, 'error'); assert.equal(result.completedFiles, 0); assert.match(result.error, /변경되었습니다/); assert.deepEqual(await fs.readdir(path.join(f.remote, 'selected')), []);
});

test('cleanup validates configuration again after the new SFTP handshake before removing files', async t => {
  let f, canceled = false, cleanupRemoves = 0;
  f = await fixture(t, {
    onChange: (values, service) => { const current = values[0]; if (!canceled && current.status === 'running' && current.completedBytes > 0) { canceled = true; service.cancelTransfer(current.id); } },
    wrap: (client, starts) => {
      if (starts !== 2) return;
      f.changeRevision('changed-during-cleanup-handshake');
      const original = client.remove.bind(client); client.remove = async p => { cleanupRemoves++; return original(p); };
    },
  }); if (!f) return;
  const source = path.join(f.local, 'large'); await fs.writeFile(source, Buffer.alloc(CHUNK_SIZE * 4));
  const result = await f.service.uploadFiles('one', [source], f.remote);
  assert.equal(result.status, 'canceled'); assert.match(result.error, /임시 파일/); assert.equal(f.starts(), 2); assert.equal(cleanupRemoves, 0);
});

test('Markdown preview reads Unicode across SFTP chunk boundaries, strips BOM and supports empty files', async t => {
  const f = await fixture(t); if (!f) return;
  const content = '# 한글 제목\r\n\n' + 'a'.repeat(CHUNK_SIZE - 17) + '파일 내용과 😀 이모지\n'.repeat(30);
  await fs.writeFile(path.join(f.remote, '안내.MARKDOWN'), '\uFEFF' + content);
  const result = await f.service.readTextFile('one', '안내.MARKDOWN');
  assert.equal(result.hostId, 'one'); assert.equal(result.path, path.join(f.remote, '안내.MARKDOWN')); assert.equal(result.name, '안내.MARKDOWN'); assert.equal(result.content, content);
  assert.equal(result.size, Buffer.byteLength('\uFEFF' + content)); assert.equal(typeof result.modifiedAt, 'number');
  await fs.writeFile(path.join(f.remote, 'empty.md'), '');
  assert.equal((await f.service.readTextFile('one', 'empty.md')).content, '');
  assert.equal(f.service.getTransfers().length, 0); assert.equal(f.hostService.active.size, 0); assert.deepEqual(await fs.readdir(f.local), []);
});

test('Markdown preview rejects unsupported names, symlinks and directories without opening them', async t => {
  let opened = 0;
  const f = await fixture(t, { wrap: client => { const original = client.open.bind(client); client.open = (...args) => { opened++; return original(...args); }; } }); if (!f) return;
  await fs.writeFile(path.join(f.remote, 'data.txt'), 'text'); await fs.writeFile(path.join(f.remote, 'real.md'), '# document');
  await fs.symlink('real.md', path.join(f.remote, 'link.md')); await fs.mkdir(path.join(f.remote, 'folder.md'));
  await assert.rejects(f.service.readTextFile('one', 'data.txt'), /마크다운 파일을 선택/);
  for (const file of ['link.md', 'folder.md']) await assert.rejects(f.service.readTextFile('one', file), /일반 마크다운 파일/);
  assert.equal(opened, 0); assert.equal(await fs.readFile(path.join(f.remote, 'real.md'), 'utf8'), '# document');
});

test('Markdown preview rejects invalid UTF-8, NUL bytes and binary control characters', async t => {
  const f = await fixture(t); if (!f) return;
  for (const [name, data, message] of [
    ['invalid.md', Buffer.from([0xc3, 0x28]), /UTF-8/],
    ['nul.md', Buffer.from('# document\0data'), /텍스트 파일이 아닙니다/],
    ['control.md', Buffer.from('# document\x01data'), /텍스트 파일이 아닙니다/],
  ]) {
    await fs.writeFile(path.join(f.remote, name), data);
    await assert.rejects(f.service.readTextFile('one', name), message);
    assert.deepEqual(await fs.readFile(path.join(f.remote, name)), data);
  }
});

test('Markdown previews are bounded to 2 MiB and the exact maximum is accepted', async t => {
  let reads = 0, requestedBytes = 0;
  const f = await fixture(t, { wrap: client => { const original = client.read.bind(client); client.read = (...args) => { reads++; requestedBytes += args[2]; assert.ok(args[2] <= CHUNK_SIZE); return original(...args); }; } }); if (!f) return;
  const maximum = 2 * 1024 * 1024;
  await fs.writeFile(path.join(f.remote, 'too-large.md'), Buffer.alloc(maximum + 1, 97));
  await assert.rejects(f.service.readTextFile('one', 'too-large.md'), /2 MB 이하/); assert.equal(reads, 0);
  await fs.writeFile(path.join(f.remote, 'maximum.md'), Buffer.alloc(maximum, 97));
  const result = await f.service.readTextFile('one', 'maximum.md'); assert.equal(result.size, maximum); assert.equal(result.content.length, maximum); assert.equal(requestedBytes, maximum + 1);
});

test('Markdown preview detects a file that grows, shrinks or changes metadata while reading', async t => {
  let f, action = null, changed = false;
  f = await fixture(t, { wrap: client => {
    const original = client.read.bind(client);
    client.read = async (...args) => {
      const data = await original(...args);
      if (action && !changed && args[1] === 0) { changed = true; await action(); }
      return data;
    };
  } }); if (!f) return;
  const selected = path.join(f.remote, 'changing.md');
  for (const mutation of [
    async () => fs.appendFile(selected, 'appended'),
    async () => fs.truncate(selected, 5),
    async () => { const old = await fs.stat(selected); await fs.utimes(selected, old.atime, new Date(old.mtimeMs + 5000)); },
  ]) {
    await fs.writeFile(selected, 'a'.repeat(CHUNK_SIZE + 10)); action = mutation; changed = false;
    await assert.rejects(f.service.readTextFile('one', 'changing.md'), /변경/);
    assert.equal(changed, true);
  }
});

test('Markdown preview checks the file handle before reading and rejects a raced path replacement', async t => {
  let f, changed = false, reads = 0;
  f = await fixture(t, { wrap: client => {
    const originalOpen = client.open.bind(client), originalRead = client.read.bind(client);
    client.open = async (...args) => {
      if (!changed) { changed = true; await fs.rename(path.join(f.remote, 'selected.md'), path.join(f.remote, 'original.md')); await fs.writeFile(path.join(f.remote, 'selected.md'), 'different content'); }
      return originalOpen(...args);
    };
    client.read = (...args) => { reads++; return originalRead(...args); };
  } }); if (!f) return;
  await fs.writeFile(path.join(f.remote, 'selected.md'), '# original');
  await assert.rejects(f.service.readTextFile('one', 'selected.md'), /변경/); assert.equal(reads, 0);
  assert.equal(await fs.readFile(path.join(f.remote, 'original.md'), 'utf8'), '# original');
});

test('Markdown preview rejects a path replaced by a symlink after opening the original file', async t => {
  let f, changed = false;
  f = await fixture(t, { wrap: client => {
    const originalRead = client.read.bind(client);
    client.read = async (...args) => {
      const data = await originalRead(...args);
      if (!changed) { changed = true; await fs.rename(path.join(f.remote, 'selected.md'), path.join(f.remote, 'original.md')); await fs.symlink('other.md', path.join(f.remote, 'selected.md')); }
      return data;
    };
  } }); if (!f) return;
  await fs.writeFile(path.join(f.remote, 'selected.md'), '# original'); await fs.writeFile(path.join(f.remote, 'other.md'), '# another');
  await assert.rejects(f.service.readTextFile('one', 'selected.md'), /변경/);
  assert.equal(await fs.readFile(path.join(f.remote, 'original.md'), 'utf8'), '# original');
});

test('Markdown preview revalidates SSH configuration before returning the content', async t => {
  let f, changed = false;
  f = await fixture(t, { wrap: client => { const original = client.read.bind(client); client.read = async (...args) => { const data = await original(...args); if (!changed) { changed = true; f.changeRevision('different-host'); } return data; }; } }); if (!f) return;
  await fs.writeFile(path.join(f.remote, 'document.md'), '# document');
  await assert.rejects(f.service.readTextFile('one', 'document.md'), /SSH 설정이 변경/);
});

test('closing file management cancels pending Markdown reads and releases every session', async t => {
  let reached, release; const ready = new Promise(resolve => { reached = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { wrap: client => { const original = client.read.bind(client); client.read = async (...args) => { reached(); await gate; return original(...args); }; } }); if (!f) return;
  await fs.writeFile(path.join(f.remote, 'document.md'), '# document');
  const preview = f.service.readTextFile('one', 'document.md'), rejection = assert.rejects(preview, e => e.name === 'AbortError'); await ready;
  const closing = f.service.close(); release(); await rejection; await closing;
  assert.equal(f.service.sessions.size, 0); assert.equal(f.service.operations.size, 0); assert.equal(f.hostService.active.size, 0);
  await assert.rejects(f.service.readTextFile('one', 'document.md'), /종료/);
  assert.equal(await fs.readFile(path.join(f.remote, 'document.md'), 'utf8'), '# document');
});
