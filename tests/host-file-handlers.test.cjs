'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHostFileHandlers } = require('../electron/host-file-handlers.cjs');

function fixture(selection = { canceled: false, filePaths: ['/chosen/file.txt'] }) {
  const host = { id: 'host-1', alias: 'server', hostName: '192.0.2.1', port: '22' };
  const calls = [];
  const fileService = Object.fromEntries(['listFiles', 'readTextFile', 'createDirectory', 'renameFile', 'moveFiles', 'deleteFiles', 'uploadFiles', 'downloadFiles', 'cancelTransfer'].map(method => [method, async (...args) => { calls.push({ method, args }); return { ok: true }; }]));
  fileService.getTransfers = () => [];
  const hostService = { state: { configPath: '/chosen/ssh/config', connectionRevision: 'connection-1', revision: 'revision-1' }, requireHost(id) { if (id !== host.id) throw new Error('호스트를 찾을 수 없습니다.'); return host; } };
  const pickerCalls = [];
  const dialog = { async showOpenDialog(...args) { pickerCalls.push(args); return typeof selection === 'function' ? selection() : selection; } };
  const openedLinks = [];
  const shell = { async openExternal(url) { openedLinks.push(url); } };
  return { handlers: createHostFileHandlers({ fileService, hostService, dialog, shell }), host, hostService, calls, pickerCalls, openedLinks };
}

test('마크다운 읽기는 선택한 호스트와 파일을 서비스에 전달한다', async () => {
  const { handlers, calls } = fixture();
  await handlers.readTextFile('host-1', '/home/user/README.md');
  assert.deepEqual(calls, [{ method: 'readTextFile', args: ['host-1', '/home/user/README.md'] }]);
});

test('문서의 웹 링크는 기본 브라우저로 연다', async () => {
  const { handlers, openedLinks } = fixture();
  assert.deepEqual(await handlers.openFileLink('https://example.com/docs?q=%ED%8C%8C%EC%9D%BC#readme'), { opened: true });
  await handlers.openFileLink('http://example.com');
  assert.deepEqual(openedLinks, ['https://example.com/docs?q=%ED%8C%8C%EC%9D%BC#readme', 'http://example.com/']);
});

test('웹 주소가 아닌 링크와 로그인 정보가 포함된 링크는 열지 않는다', async () => {
  const { handlers, openedLinks } = fixture();
  for (const value of [null, {}, '', 'javascript:alert(1)', 'data:text/html,hello', 'file:///etc/passwd', 'ssh://host', '//example.com', 'https://user:pass@example.com', 'https://example.com/\nfile', `https://example.com/${'a'.repeat(4096)}`]) {
    await assert.rejects(handlers.openFileLink(value), /링크 주소/);
  }
  assert.deepEqual(openedLinks, []);
});

test('업로드 경로는 화면 입력 대신 운영체제 파일 선택에서 가져온다', async () => {
  const { handlers, calls, pickerCalls } = fixture();
  await handlers.uploadFiles('host-1', '/home/user');
  assert.deepEqual(calls, [{ method: 'uploadFiles', args: ['host-1', ['/chosen/file.txt'], '/home/user'] }]);
  assert.deepEqual(pickerCalls[0][0].properties, ['openFile', 'multiSelections', 'showHiddenFiles']);
});

test('폴더 업로드는 폴더 선택 창을 사용한다', async () => {
  const { handlers, pickerCalls } = fixture();
  await handlers.uploadFiles('host-1', '/home/user', { directory: true });
  assert.deepEqual(pickerCalls[0][0].properties, ['openDirectory', 'multiSelections', 'showHiddenFiles']);
});

test('파일 선택을 취소하면 전송을 시작하지 않는다', async () => {
  const { handlers, calls } = fixture({ canceled: true, filePaths: [] });
  assert.deepEqual(await handlers.uploadFiles('host-1', '/home/user'), { canceled: true });
  assert.deepEqual(await handlers.downloadFiles('host-1', ['/home/user/file.txt']), { canceled: true });
  assert.equal(calls.length, 0);
});

test('다운로드는 운영체제에서 선택한 폴더에만 저장한다', async () => {
  const { handlers, calls, pickerCalls } = fixture({ canceled: false, filePaths: ['/chosen/downloads'] });
  await handlers.downloadFiles('host-1', ['/remote/a', '/remote/b']);
  assert.deepEqual(calls, [{ method: 'downloadFiles', args: ['host-1', ['/remote/a', '/remote/b'], '/chosen/downloads'] }]);
  assert.deepEqual(pickerCalls[0][0].properties, ['openDirectory', 'createDirectory']);
});

test('선택 창이 열린 동안 접속 주소가 변경되면 전송을 막는다', async () => {
  let resolve;
  const { handlers, host, calls } = fixture(() => new Promise(done => { resolve = done; }));
  const pending = handlers.uploadFiles('host-1', '/home/user');
  host.hostName = '192.0.2.2';
  resolve({ canceled: false, filePaths: ['/chosen/file.txt'] });
  await assert.rejects(pending, /접속 정보가 변경/);
  assert.equal(calls.length, 0);
});

test('동시에 여러 파일 선택 창을 열지 않고 취소 후 다시 열 수 있다', async () => {
  let resolve;
  const { handlers, pickerCalls } = fixture(() => new Promise(done => { resolve = done; }));
  const first = handlers.uploadFiles('host-1', '/home/user');
  await assert.rejects(handlers.downloadFiles('host-1', ['/remote/a']), /선택 창/);
  assert.equal(pickerCalls.length, 1);
  resolve({ canceled: true });
  await first;
  const next = handlers.uploadFiles('host-1', '/home/user');
  resolve({ canceled: true });
  assert.deepEqual(await next, { canceled: true });
});

test('파일 선택 중 공통 SSH 설정을 다시 읽으면 기존 선택으로 전송하지 않는다', async () => {
  let resolve;
  const { handlers, hostService, calls } = fixture(() => new Promise(done => { resolve = done; }));
  const pending = handlers.downloadFiles('host-1', ['/remote/a']);
  hostService.state.connectionRevision = 'connection-2';
  resolve({ canceled: false, filePaths: ['/chosen/downloads'] });
  await assert.rejects(pending, /접속 정보가 변경/);
  assert.equal(calls.length, 0);
});

test('파일 선택 중 표시 순서만 바뀌면 접속 설정이 같아 전송할 수 있다', async () => {
  let resolve;
  const { handlers, hostService, calls } = fixture(() => new Promise(done => { resolve = done; }));
  const pending = handlers.uploadFiles('host-1', '/remote');
  hostService.state.revision = 'revision-order-2';
  resolve({ canceled: false, filePaths: ['/chosen/file.txt'] });
  await pending;
  assert.equal(calls.length, 1);
});

test('잘못된 호스트와 업로드 옵션은 파일 선택 전 거부한다', async () => {
  const { handlers, calls, pickerCalls } = fixture();
  await assert.rejects(handlers.uploadFiles('missing', '/remote'), /호스트/);
  await assert.rejects(handlers.uploadFiles('host-1', '/remote', { localPath: '/private/file' }), /선택/);
  await assert.rejects(handlers.uploadFiles('host-1', '/remote', { directory: 'true' }), /선택/);
  await assert.rejects(handlers.downloadFiles('host-1', []), /선택/);
  assert.equal(pickerCalls.length, 0);
  assert.equal(calls.length, 0);
});

test('파일 선택 결과가 올바르지 않으면 전송하지 않는다', async () => {
  const { handlers, calls } = fixture({ canceled: false, filePaths: ['/chosen/a\0b'] });
  await assert.rejects(handlers.uploadFiles('host-1', '/remote'), /경로/);
  assert.equal(calls.length, 0);
});
