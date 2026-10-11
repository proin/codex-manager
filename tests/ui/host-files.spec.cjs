const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

async function screenshot(page, name) {
  const directory = path.resolve('release/verification/0.3.4');
  fs.mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, name) });
}

const row = (page, alias = 'dev-server') => page.getByRole('table', { name: '호스트 목록', exact: true }).locator('tbody > tr').filter({ has: page.getByRole('button', { name: `${alias} 호스트 정보`, exact: true }) });
const files = page => page.getByRole('region', { name: / 파일 브라우저$/, exact: false });
const fileRow = (page, name) => files(page).getByRole('table', { name: '원격 파일 목록', exact: true }).locator('tbody > tr').filter({ has: page.getByRole('checkbox', { name: `${name} 선택`, exact: true }) });

async function install(page, options = {}) {
  await page.addInitScript(options => {
    const calls = window.filesCalls = [], listeners = new Set(), transferListeners = new Set();
    const timestamp = '2026-10-10T14:30:00Z', home = '/home/demo';
    const entry = (path, type, size = 0) => ({ path, name: path.split('/').at(-1), type, size, modifiedAt: timestamp, mode: type === 'directory' ? '755' : '644' });
    const store = new Map([
      entry('/', 'directory'), entry('/home', 'directory'), entry(home, 'directory'),
      entry(`${home}/projects`, 'directory'), entry(`${home}/logs`, 'directory'),
      entry(`${home}/README.md`, 'file', 1842), entry(`${home}/data.bin`, 'file', 1024 * 1024 * 5), entry(`${home}/.profile`, 'file', 234),
      entry(`${home}/projects/app.js`, 'file', 2048), entry(`${home}/logs/app.log`, 'file', 512),
    ].map(item => [item.path, item]));
    if (options.longPath) {
      let directory = '';
      for (const segment of options.longPath.split('/').filter(Boolean)) { directory += `/${segment}`; store.set(directory, entry(directory, 'directory')); }
      store.set(`${options.longPath}/notes.txt`, entry(`${options.longPath}/notes.txt`, 'file', 256));
    }
    if (options.unknownSize) { store.get(`${home}/README.md`).size = null; store.get(`${home}/README.md`).mode = 33188; }
    const host = { id: 'host-1', alias: 'dev-server', hostPatterns: 'dev-server', hostName: '192.0.2.10', user: 'ubuntu', connectable: true, connection: { status: 'online', checkedAt: timestamp }, codex: { available: options.noCodex ? false : true, version: '0.149.0' } };
    const state = { configPath: '/example/ssh/config', revision: 'r1', groups: [], hosts: [host, { ...structuredClone(host), id: 'host-2', alias: 'second-server', hostPatterns: 'second-server' }, { ...structuredClone(host), id: 'wildcard', alias: '*', hostPatterns: '*', connectable: false }], refresh: { running: false }, batchUpgrade: { running: false, hostIds: [] } };
    const account = { accounts: [], refresh: { running: false }, runtime: { available: true } };
    window.accountManager = { getState: async () => account, onState: () => () => {} };
    const parent = path => path.slice(0, path.lastIndexOf('/')) || '/';
    const snapshot = path => ({ path: path || home, home, entries: structuredClone([...store.values()].filter(item => item.path !== (path || home) && parent(item.path) === (path || home))) });
    const move = (sources, destination, explicit) => {
      for (const source of sources) {
        const target = explicit || `${destination}/${source.split('/').at(-1)}`;
        if (store.has(target)) throw new Error('같은 이름의 파일이 있습니다.');
        for (const item of [...store.values()]) if (item.path === source || item.path.startsWith(`${source}/`)) { store.delete(item.path); const path = `${target}${item.path.slice(source.length)}`; store.set(path, { ...item, path, name: path.split('/').at(-1) }); }
      }
      return { success: true };
    };
    const transfers = options.restoredTransfer ? [{ id: 'restored-1', hostId: 'host-1', direction: 'upload', status: 'running', completedBytes: 2048, totalBytes: 8192, currentFile: '/home/demo/large.bin', message: '1개 파일 전송 완료. 취소 시 남은 임시 파일을 확인하십시오.' }] : [];
    const emitTransfers = () => { const result = structuredClone(transfers); transferListeners.forEach(callback => callback(result)); return result; };
    window.finishRestoredUpload = status => { const path = `${home}/partial-upload.txt`; store.set(path, entry(path, 'file', 512)); transfers[0].status = status; emitTransfers(); };

    let settle;
    const transfer = async (hostId, direction, paths, directory) => {
      if (options.nativeCancel) return { canceled: true };
      if (!options.liveTransfer) return { success: true };
      const item = { id: 'transfer-1', hostId, direction, status: 'running', completedBytes: 1024 * 128, totalBytes: 1024 * 512, currentFile: paths[0], message: '' };
      transfers.push(item); emitTransfers();
      window.completeFileTransfer = () => {
        if (direction === 'upload') { const path = `${directory}/uploaded.txt`; store.set(path, entry(path, 'file', 512)); }
        item.status = 'completed'; item.completedBytes = item.totalBytes; emitTransfers(); settle?.(structuredClone(transfers));
      };
      return new Promise(resolve => { settle = resolve; });
    };
    window.hostManager = {
      getState: async () => structuredClone(state), onState: callback => { listeners.add(callback); return () => listeners.delete(callback); },
      getHostDetails: async id => { calls.push({ method: 'details', id }); return { host: structuredClone(state.hosts.find(item => item.id === id)), effective: { hostName: host.hostName, user: host.user, port: 22 }, key: {} }; },
      refreshHosts: async () => structuredClone(state),
      openSshTerminal: async id => { calls.push({ method: 'terminal', id }); if (options.terminalFails) throw new Error('기본 터미널을 열지 못했습니다.'); return { success: true }; },
      listFiles: async (id, path) => {
        calls.push({ method: 'list', id, path });
        if (options.staleInitial && !window.initialFileRequestStarted) { window.initialFileRequestStarted = true; const result = snapshot(home); return new Promise(resolve => { window.resolveInitialFiles = () => resolve(result); }); }
        if (options.staleHost && id === 'host-1') return new Promise(resolve => { window.resolveOldHostFiles = () => resolve({ ...snapshot(home), path: '/old-host', entries: [entry('/old-host/private.txt', 'file', 1)] }); });
        if (options.movePending && path === `${home}/projects`) { const result = snapshot(path); return new Promise(resolve => { window.resolveMoveFolderFiles = () => resolve(result); }); }
        if (options.moveFails && path === `${home}/projects`) throw new Error('이 폴더에 접근할 수 없습니다.');
        if (options.listFails) throw new Error('파일 목록 조회 실패');
        if (store.get(path || home)?.type !== 'directory') throw new Error('폴더를 찾을 수 없습니다.');
        return snapshot(path);
      },
      createDirectory: async (id, path) => { calls.push({ method: 'mkdir', id, path }); if (store.has(path)) throw new Error('같은 이름의 파일이 있습니다.'); store.set(path, entry(path, 'directory')); return { success: true }; },
      renameFile: async (id, source, target) => { calls.push({ method: 'rename', id, source, target }); if (options.mutationFails) throw new Error('이름 변경 권한이 없습니다.'); return move([source], parent(target), target); },
      moveFiles: async (id, paths, destination) => { calls.push({ method: 'move', id, paths, destination }); return move(paths, destination); },
      deleteFiles: async (id, paths) => { calls.push({ method: 'delete', id, paths }); for (const path of paths) for (const item of [...store.values()]) if (item.path === path || item.path.startsWith(`${path}/`)) store.delete(item.path); return { success: true }; },
      uploadFiles: async (id, directory, config) => { calls.push({ method: 'upload', id, directory, config }); return transfer(id, 'upload', [config?.directory ? 'folder' : 'upload.txt'], directory); },
      downloadFiles: async (id, paths) => { calls.push({ method: 'download', id, paths }); return transfer(id, 'download', paths); },
      readTextFile: async (id, path) => { calls.push({ method: 'readText', id, path }); return { hostId: id, path, name: path.split('/').at(-1), content: '# 프로젝트 안내\n\n파일 미리보기입니다.', size: 60, modifiedAt: timestamp }; },
      openFileLink: async url => { calls.push({ method: 'openLink', url }); },
      getFileTransfers: async () => { const snapshot = structuredClone(transfers); if (options.deferredTransferSnapshot) return new Promise(resolve => { window.resolveFileTransferSnapshot = () => resolve(snapshot); }); return snapshot; }, onFileTransfers: callback => { transferListeners.add(callback); return () => transferListeners.delete(callback); },
      cancelFileTransfer: async id => { calls.push({ method: 'cancel', id }); transfers.find(item => item.id === id).status = 'canceled'; const snapshot = emitTransfers(); settle?.(snapshot); return snapshot; },
    };
    if (options.unsupportedFiles) delete window.hostManager.listFiles;
  }, options);
}

async function openHosts(page) {
  await page.goto('/'); await page.getByRole('button', { name: '호스트관리', exact: true }).click();
  await expect(page.getByRole('table', { name: '호스트 목록', exact: true })).toBeVisible();
}
async function openFiles(page, alias = 'dev-server') {
  await row(page, alias).getByRole('button', { name: `${alias} 파일 관리`, exact: true }).click();
}
async function openPath(page, path) {
  const navigator = files(page).getByRole('textbox', { name: '원격 폴더 경로', exact: true });
  await navigator.fill(path);
  await navigator.press('Enter');
}
async function fileOption(page, name, enabled) {
  const button = files(page).getByRole('button', { name: '파일 옵션', exact: true });
  await button.click();
  const option = files(page).getByRole('menuitemcheckbox', { name, exact: true });
  if ((await option.getAttribute('aria-checked')) !== String(enabled)) await option.click();
  if (await option.isVisible()) await option.press('Escape');
}
async function searchFiles(page, value) {
  const field = files(page).getByRole('searchbox', { name: '파일 이름 검색', exact: true });
  if (!await field.isVisible()) await files(page).getByRole('button', { name: '파일 검색', exact: true }).click();
  await field.fill(value);
}

async function expectCompactHeader(page) {
  const header = files(page).locator('.host-files-header');
  const bounds = await header.boundingBox();
  expect(bounds.height).toBeLessThanOrEqual(48);
  const controls = await header.locator('button, summary, input').evaluateAll(elements => elements.map(element => {
    const rectangle = element.getBoundingClientRect(), style = getComputedStyle(element);
    return { left: rectangle.left, right: rectangle.right, center: rectangle.top + rectangle.height / 2, width: rectangle.width, height: rectangle.height, visible: style.display !== 'none' && style.visibility !== 'hidden' };
  }).filter(element => element.visible && element.width > 0 && element.height > 0));
  expect(controls.length).toBeGreaterThanOrEqual(8);
  expect(Math.max(...controls.map(element => element.center)) - Math.min(...controls.map(element => element.center))).toBeLessThanOrEqual(3);
  for (const element of controls) {
    expect(element.left).toBeGreaterThanOrEqual(bounds.x);
    expect(element.right).toBeLessThanOrEqual(bounds.x + bounds.width);
  }
  const content = await files(page).locator('.host-files-content').boundingBox();
  const table = await files(page).getByRole('table', { name: '원격 파일 목록', exact: true }).boundingBox();
  expect(Math.abs(table.x - content.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(table.width - content.width)).toBeLessThanOrEqual(1);
  expect(table.y - (bounds.y + bounds.height)).toBeLessThanOrEqual(1);
  expect(await files(page).locator('.host-files-content').evaluate(element => ({ padding: getComputedStyle(element).padding, margin: getComputedStyle(element).margin }))).toEqual({ padding: '0px', margin: '0px' });
  await expect(files(page).locator('.host-files-footer')).toHaveCount(0);
  await expect(files(page)).not.toContainText('폴더와 마크다운 문서는 두 번 클릭하여 엽니다.');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
}
async function upload(page, directory = false) {
  await files(page).getByRole('button', { name: '업로드', exact: true }).click();
  await files(page).getByRole('menuitem', { name: directory ? '폴더 업로드' : '파일 업로드', exact: true }).click();
}
const calls = (page, method) => page.evaluate(method => window.filesCalls.filter(item => item.method === method), method);

test.beforeEach(async ({ page }) => { page.uiErrors = []; page.on('pageerror', error => page.uiErrors.push(error.message)); });
test.afterEach(async ({ page }) => expect(page.uiErrors).toEqual([]));

test('SSH 버튼은 업그레이드 왼쪽에 있고 Codex 미설치 호스트도 외부 터미널을 열 수 있음', async ({ page }) => {
  await install(page, { noCodex: true }); await openHosts(page);
  const host = row(page), terminal = host.getByRole('button', { name: 'dev-server SSH 접속', exact: true });
  await expect(terminal).toBeEnabled(); await expect(host.getByRole('button', { name: '업그레이드', exact: true })).toBeDisabled();
  const names = await host.locator('.host-row-actions > button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')));
  expect(names.indexOf('dev-server SSH 접속')).toBeLessThan(names.indexOf('업그레이드'));
  await terminal.click(); expect(await calls(page, 'terminal')).toEqual([{ method: 'terminal', id: 'host-1' }]);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(row(page, '*').getByRole('button', { name: '* SSH 접속', exact: true })).toBeDisabled();
});

test('터미널 실행 오류를 표시하고 자동으로 재시도하지 않음', async ({ page }) => {
  await install(page, { terminalFails: true }); await openHosts(page);
  await row(page).getByRole('button', { name: 'dev-server SSH 접속', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('기본 터미널을 열지 못했습니다.');
  expect(await calls(page, 'terminal')).toHaveLength(1);
});


test('파일 관리는 본문과 우측 정보 영역을 사용하고 목록으로 돌아가면 원래 호스트에 초점 복원', async ({ page }) => {
  await install(page); await openHosts(page); await openFiles(page);
  await expect(fileRow(page, 'README.md')).toBeVisible(); await expect(page.getByRole('dialog')).toHaveCount(0);
  const inspector = files(page).getByRole('complementary', { name: '파일 정보', exact: true }); await expect(inspector).toBeHidden();
  await fileOption(page, '파일 정보 표시', true); await expect(inspector).toBeVisible();
  const contentBox = await files(page).locator('.host-files-content').boundingBox(), inspectorBox = await inspector.boundingBox();
  expect(inspectorBox.x).toBeGreaterThan(contentBox.x + contentBox.width - 1); expect(inspectorBox.width).toBeGreaterThanOrEqual(240); expect(inspectorBox.width).toBeLessThanOrEqual(280);
  await files(page).getByRole('button', { name: '호스트 목록으로 돌아가기', exact: true }).click();
  await expect(row(page).getByRole('button', { name: 'dev-server 파일 관리', exact: true })).toBeFocused();
});

test('상세 모달 파일 탭에서 파일 관리 열기 전에는 파일 목록을 조회하지 않음', async ({ page }) => {
  await install(page); await openHosts(page); await row(page).getByRole('button', { name: 'dev-server 호스트 정보', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'dev-server 호스트 정보', exact: true });
  await dialog.getByRole('tab', { name: '파일', exact: true }).click(); expect(await calls(page, 'list')).toEqual([]);
  await dialog.getByRole('button', { name: '파일 관리 열기', exact: true }).click();
  await expect(dialog).toBeHidden(); await expect(fileRow(page, 'README.md')).toBeVisible();
});

test('폴더 이름으로 탐색하고 기본 목록에는 이름·크기·수정일만 표시', async ({ page }) => {
  await install(page); await openHosts(page); await openFiles(page);
  await expect(fileRow(page, 'README.md')).toContainText('2 KiB'); await expect(fileRow(page, 'data.bin')).toContainText('5 MiB');
  expect(await files(page).getByRole('table').getByRole('columnheader').allTextContents()).toEqual(['', '이름', '크기', '수정일']);
  const first = files(page).getByRole('table').locator('tbody > tr').first(); await expect(first).toContainText('logs');
  expect(await fileRow(page, 'data.bin').locator('td').nth(2).evaluate(element => getComputedStyle(element).textAlign)).toBe('right');
  await expect(files(page).getByRole('textbox', { name: '원격 폴더 경로', exact: true })).toHaveValue('/home/demo');
  await expect(fileRow(page, '.profile')).toHaveCount(0); await fileOption(page, '숨김 파일 표시', true); await expect(fileRow(page, '.profile')).toBeVisible();
  await searchFiles(page, 'readme'); await expect(files(page).getByRole('table').locator('tbody > tr')).toHaveCount(1); await searchFiles(page, ''); await files(page).getByRole('button', { name: '검색 닫기', exact: true }).click();
  const requests = (await calls(page, 'list')).length;
  await fileRow(page, 'projects').getByRole('checkbox').check(); await expect(fileRow(page, 'projects').getByRole('checkbox')).toBeChecked(); expect(await calls(page, 'list')).toHaveLength(requests);
  await fileRow(page, 'projects').getByRole('checkbox').uncheck(); await fileRow(page, 'projects').locator('td').nth(2).click(); await expect(fileRow(page, 'projects').getByRole('checkbox')).toBeChecked(); expect(await calls(page, 'list')).toHaveLength(requests);
  await fileRow(page, 'projects').getByRole('button', { name: 'projects 폴더 열기', exact: true }).click(); await expect(fileRow(page, 'app.js')).toBeVisible(); expect(await calls(page, 'list')).toHaveLength(requests + 1); expect((await calls(page, 'list')).at(-1).path).toBe('/home/demo/projects');
  await openPath(page, '/home/demo'); await expect(fileRow(page, 'README.md')).toBeVisible();
  await files(page).getByRole('button', { name: '이전 폴더', exact: true }).click(); await expect(fileRow(page, 'app.js')).toBeVisible();
});

test('경로를 직접 입력하고 Enter로 이동하며 경로 단축키와 Escape로 입력을 복원', async ({ page }) => {
  await install(page); await openHosts(page); await openFiles(page); await expect(fileRow(page, 'README.md')).toBeVisible();
  const navigator = files(page).getByRole('textbox', { name: '원격 폴더 경로', exact: true });
  await expect(navigator).toBeVisible(); await expect(navigator).toHaveValue('/home/demo');
  await fileRow(page, 'README.md').getByRole('button').click();
  const requests = (await calls(page, 'list')).length;
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+l' : 'Control+l');
  await expect(navigator).toBeFocused();
  expect(await navigator.evaluate(input => [input.selectionStart, input.selectionEnd])).toEqual([0, '/home/demo'.length]);
  await navigator.fill('/home/demo/logs'); await navigator.press('Escape');
  await expect(navigator).toHaveValue('/home/demo'); expect(await calls(page, 'list')).toHaveLength(requests); await expect(fileRow(page, 'README.md').getByRole('checkbox')).toBeChecked();
  await openPath(page, '/home/demo/logs'); await expect(fileRow(page, 'app.log')).toBeVisible(); await expect(navigator).toHaveValue('/home/demo/logs');
  expect((await calls(page, 'list')).at(-1)).toEqual({ method: 'list', id: 'host-1', path: '/home/demo/logs' });
  await files(page).getByRole('button', { name: '이전 폴더', exact: true }).click(); await expect(fileRow(page, 'README.md')).toBeVisible(); await expect(navigator).toHaveValue('/home/demo');
});

test('잘못된 경로 조회 후 기존 목록을 보존하고 Escape로 폴더 경로 복원', async ({ page }) => {
  await install(page); await openHosts(page); await openFiles(page); await expect(fileRow(page, 'README.md')).toBeVisible();
  await openPath(page, '/missing/folder'); await expect(files(page).getByRole('alert')).toContainText('폴더를 찾을 수 없습니다.');
  await expect(fileRow(page, 'README.md')).toBeVisible(); expect(await calls(page, 'list')).toHaveLength(2);
  const navigator = files(page).getByRole('textbox', { name: '원격 폴더 경로', exact: true });
  await expect(navigator).toHaveValue('/missing/folder'); await navigator.press('Escape'); await expect(navigator).toHaveValue('/home/demo'); expect(await calls(page, 'list')).toHaveLength(2);
});

test('직접 입력한 경로 조회 실패 후 다시 시도하면 같은 경로를 요청하고 기존 목록 유지', async ({ page }) => {
  await install(page); await openHosts(page); await openFiles(page); await expect(fileRow(page, 'README.md')).toBeVisible();
  await openPath(page, '/not-readable'); await expect(files(page).getByRole('alert')).toContainText('폴더를 찾을 수 없습니다.'); await expect(fileRow(page, 'README.md')).toBeVisible();
  await files(page).getByRole('alert').getByRole('button', { name: '다시 시도', exact: true }).click();
  await expect.poll(async () => (await calls(page, 'list')).length).toBe(3);
  expect((await calls(page, 'list')).slice(1)).toEqual([
    { method: 'list', id: 'host-1', path: '/not-readable' },
    { method: 'list', id: 'host-1', path: '/not-readable' },
  ]);
  await expect(files(page).getByRole('alert')).toContainText('폴더를 찾을 수 없습니다.'); await expect(fileRow(page, 'README.md')).toBeVisible();
});

test('같은 폴더를 상대 경로로 열어도 입력창은 전체 경로로 표시', async ({ page }) => {
  await install(page); await openHosts(page); await openFiles(page); await expect(fileRow(page, 'README.md')).toBeVisible();
  const navigator = files(page).getByRole('textbox', { name: '원격 폴더 경로', exact: true });
  for (const relativePath of ['.', '../demo']) {
    await navigator.fill(relativePath); await navigator.press('Enter');
    await expect(navigator).toHaveValue('/home/demo'); await expect(fileRow(page, 'README.md')).toBeVisible();
  }
});

test('상위 경로 목록에서 폴더를 선택해 이동하고 Escape로 메뉴를 닫아 초점 복원', async ({ page }) => {
  await install(page); await openHosts(page); await openFiles(page); await expect(fileRow(page, 'README.md')).toBeVisible();
  await openPath(page, '/home/demo/projects'); await expect(fileRow(page, 'app.js')).toBeVisible();
  const button = files(page).getByRole('button', { name: '상위 경로 목록', exact: true });
  await button.focus(); await button.press('Enter');
  const menu = files(page).getByRole('menu', { name: '상위 경로', exact: true });
  await expect(menu).toBeVisible();
  for (const destination of ['/', '/home', '/home/demo', '/home/demo/projects']) await expect(menu.getByRole('menuitem', { name: destination, exact: true })).toBeVisible();
  await menu.getByRole('menuitem', { name: '/home/demo', exact: true }).focus(); await page.keyboard.press('Escape'); await expect(menu).toBeHidden(); await expect(button).toBeFocused();
  await button.press('Enter'); await menu.getByRole('menuitem', { name: '/home/demo', exact: true }).click();
  await expect(menu).toBeHidden(); await expect(fileRow(page, 'README.md')).toBeVisible(); await expect(files(page).getByRole('textbox', { name: '원격 폴더 경로', exact: true })).toHaveValue('/home/demo');
  expect((await calls(page, 'list')).at(-1)).toEqual({ method: 'list', id: 'host-1', path: '/home/demo' });
});

test('숨김 파일과 파일 정보는 헤더 옵션에서 선택하고 키보드로 메뉴를 열고 닫음', async ({ page }) => {
  await install(page); await openHosts(page); await openFiles(page); await expect(fileRow(page, 'README.md')).toBeVisible();
  const button = files(page).getByRole('button', { name: '파일 옵션', exact: true });
  await expect(files(page).getByRole('checkbox', { name: '숨김 파일 표시', exact: true })).toHaveCount(0); await expect(fileRow(page, '.profile')).toHaveCount(0);
  await expect(files(page).getByRole('complementary', { name: '파일 정보', exact: true })).toBeHidden();
  await button.focus(); await button.press('Enter');
  const menu = files(page).getByRole('menu', { name: '파일 옵션', exact: true });
  const hidden = menu.getByRole('menuitemcheckbox', { name: '숨김 파일 표시', exact: true });
  await expect(menu).toBeVisible(); await expect(hidden).toHaveAttribute('aria-checked', 'false');
  await hidden.focus(); await hidden.press('Escape'); await expect(menu).toBeHidden(); await expect(button).toBeFocused();
  await fileOption(page, '숨김 파일 표시', true); await expect(fileRow(page, '.profile')).toBeVisible();
  await fileOption(page, '숨김 파일 표시', false); await expect(fileRow(page, '.profile')).toHaveCount(0);
  await fileOption(page, '파일 정보 표시', true); await expect(files(page).getByRole('complementary', { name: '파일 정보', exact: true })).toBeVisible();
  await fileOption(page, '파일 정보 표시', false); await expect(files(page).getByRole('complementary', { name: '파일 정보', exact: true })).toBeHidden();
  expect(await calls(page, 'list')).toHaveLength(1);
});

test('긴 경로와 선택 작업도 작은 창에서 한 줄 헤더를 유지', async ({ page }) => {
  const longPath = '/home/demo/projects/' + Array.from({ length: 18 }, (_, index) => `folder-with-a-long-name-${index}`).join('/');
  await install(page, { longPath }); await page.setViewportSize({ width: 1340, height: 760 }); await openHosts(page); await openFiles(page); await expect(fileRow(page, 'README.md')).toBeVisible();
  await openPath(page, longPath); await expect(fileRow(page, 'notes.txt')).toBeVisible(); await fileRow(page, 'notes.txt').getByRole('checkbox').check();
  await expect(files(page).getByRole('textbox', { name: '원격 폴더 경로', exact: true })).toHaveValue(longPath); await expectCompactHeader(page);
  await page.setViewportSize({ width: 880, height: 440 }); await expectCompactHeader(page);
  for (const name of ['다운로드', '이름 변경', '이동', '삭제', '파일 옵션']) await expect(files(page).locator('.host-files-header').getByRole('button', { name, exact: true })).toBeInViewport();
  await screenshot(page, 'host-files-long-path.png');
});

test('파일 선택과 마크다운 미리보기를 유지하고 폴더는 Enter로 열기', async ({ page }) => {
  await install(page); await openHosts(page); await openFiles(page);
  await fileRow(page, 'README.md').getByRole('button').click(); await expect(fileRow(page, 'README.md').getByRole('checkbox')).toBeChecked();
  await fileOption(page, '파일 정보 표시', true);
  const inspector = files(page).getByRole('complementary', { name: '파일 정보', exact: true }); await expect(inspector).toContainText('README.md'); await expect(inspector.getByRole('button', { name: '미리보기', exact: true })).toBeVisible(); expect(await calls(page, 'readText')).toEqual([]);
  await fileRow(page, 'README.md').getByRole('button').dblclick(); await expect(files(page).getByRole('article', { name: '마크다운 문서', exact: true })).toContainText('프로젝트 안내'); expect(await calls(page, 'download')).toEqual([]);
  await files(page).getByRole('button', { name: '파일 목록', exact: true }).click(); await expect(fileRow(page, 'README.md')).toBeVisible();
  const requests = (await calls(page, 'list')).length;
  await fileRow(page, 'projects').getByRole('button', { name: 'projects 폴더 열기', exact: true }).focus(); await page.keyboard.press('Enter'); await expect(fileRow(page, 'app.js')).toBeVisible(); expect(await calls(page, 'list')).toHaveLength(requests + 1);
});

test('선택 작업은 선택 전 비활성화하고 Escape로 선택 해제', async ({ page }) => {
  await install(page); await openHosts(page); await openFiles(page); await expect(fileRow(page, 'README.md')).toBeVisible();
  await expect(files(page).getByRole('button', { name: '다운로드', exact: true })).toBeDisabled();
  await fileRow(page, 'README.md').getByRole('button').click(); await expect(files(page).getByRole('button', { name: '다운로드', exact: true })).toBeEnabled();
  await page.keyboard.press('Escape'); await expect(fileRow(page, 'README.md').getByRole('checkbox')).not.toBeChecked(); await expect(files(page).getByRole('button', { name: '다운로드', exact: true })).toBeDisabled();
});

test('늦게 도착한 이전 폴더 응답이 새 폴더 목록을 덮어쓰지 않음', async ({ page }) => {
  await install(page, { staleInitial: true }); await openHosts(page); await openFiles(page); await expect.poll(() => page.evaluate(() => Boolean(window.resolveInitialFiles))).toBe(true);
  await openPath(page, '/home/demo/logs'); await expect(fileRow(page, 'app.log')).toBeVisible(); await page.evaluate(() => window.resolveInitialFiles());
  await expect(files(page).getByRole('textbox', { name: '원격 폴더 경로', exact: true })).toHaveValue('/home/demo/logs'); await expect(fileRow(page, 'README.md')).toHaveCount(0);
});

test('새 폴더·이름 변경·선택 삭제는 확인 버튼을 눌러야 실행', async ({ page }) => {
  await install(page); await openHosts(page); await openFiles(page); await expect(fileRow(page, 'README.md')).toBeVisible();
  await files(page).getByRole('button', { name: '새 폴더', exact: true }).click(); const create = files(page).getByRole('form', { name: '새 폴더', exact: true });
  await create.getByRole('textbox', { name: '폴더 이름', exact: true }).fill('reports'); expect(await calls(page, 'mkdir')).toEqual([]); await create.getByRole('button', { name: '폴더 만들기', exact: true }).click(); await expect(fileRow(page, 'reports')).toBeVisible();
  await fileRow(page, 'README.md').getByRole('checkbox').check(); await files(page).locator('.host-files-header').getByRole('button', { name: '이름 변경', exact: true }).click(); const rename = files(page).getByRole('form', { name: '이름 변경', exact: true });
  await rename.getByRole('textbox', { name: '새 이름', exact: true }).fill('GUIDE.md'); expect(await calls(page, 'rename')).toEqual([]); await rename.getByRole('button', { name: '이름 변경', exact: true }).click(); await expect(fileRow(page, 'GUIDE.md')).toBeVisible();
  await fileRow(page, 'GUIDE.md').getByRole('checkbox').check(); await fileRow(page, 'reports').getByRole('checkbox').check(); await files(page).getByRole('button', { name: '삭제', exact: true }).click(); const deletion = files(page).getByRole('form', { name: '파일 삭제 확인', exact: true });
  await expect(deletion).toContainText('복구할 수 없습니다.'); expect(await calls(page, 'delete')).toEqual([]); await deletion.getByRole('button', { name: '취소', exact: true }).click(); expect(await calls(page, 'delete')).toEqual([]);
  await files(page).getByRole('button', { name: '삭제', exact: true }).click(); await deletion.getByRole('button', { name: '파일 삭제', exact: true }).click(); await expect(fileRow(page, 'GUIDE.md')).toHaveCount(0); await expect(fileRow(page, 'reports')).toHaveCount(0);
});

test('폴더를 선택하여 여러 파일 이동하고 드래그 이동도 먼저 확인', async ({ page }) => {
  await install(page); await openHosts(page); await openFiles(page); await expect(fileRow(page, 'README.md')).toBeVisible();
  await fileRow(page, 'README.md').getByRole('checkbox').check(); await fileRow(page, 'data.bin').getByRole('checkbox').check(); await files(page).getByRole('button', { name: '이동', exact: true }).click(); const move = files(page).getByRole('form', { name: '파일 이동', exact: true });
  await expect(move.getByRole('textbox', { name: '이동할 폴더 경로', exact: true })).toHaveCount(0); await move.getByRole('button', { name: 'projects 이동 폴더 열기', exact: true }).click(); expect(await calls(page, 'move')).toEqual([]);
  await move.getByRole('button', { name: '이 폴더로 이동', exact: true }).click(); await expect(fileRow(page, 'README.md')).toHaveCount(0); expect((await calls(page, 'move'))[0].destination).toBe('/home/demo/projects');
  await fileRow(page, 'projects').getByRole('button', { name: 'projects 폴더 열기', exact: true }).click(); await expect(fileRow(page, 'README.md')).toBeVisible(); await expect(fileRow(page, 'data.bin')).toBeVisible(); await files(page).getByRole('button', { name: '홈 폴더', exact: true }).click();
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer()); await fileRow(page, 'logs').dispatchEvent('dragstart', { dataTransfer }); await fileRow(page, 'projects').dispatchEvent('dragover', { dataTransfer }); await fileRow(page, 'projects').dispatchEvent('drop', { dataTransfer });
  await expect(move).toBeVisible(); await expect(move.locator('.host-files-picker-target')).toContainText('projects'); expect(await calls(page, 'move')).toHaveLength(1); await move.getByRole('button', { name: '취소', exact: true }).click();
});

test('선택한 폴더와 그 하위 폴더는 이동 대상으로 표시하지 않음', async ({ page }) => {
  await install(page); await openHosts(page); await openFiles(page); await fileRow(page, 'projects').getByRole('checkbox').check(); await files(page).getByRole('button', { name: '이동', exact: true }).click();
  const move = files(page).getByRole('form', { name: '파일 이동', exact: true }); await expect(move.getByRole('button', { name: 'projects 이동 폴더 열기', exact: true })).toHaveCount(0); await expect(move.getByRole('button', { name: 'logs 이동 폴더 열기', exact: true })).toBeVisible();
});

test('업로드 메뉴에서 파일·폴더를 선택하고 선택 취소를 성공으로 표시하지 않음', async ({ page }) => {
  await install(page, { nativeCancel: true }); await openHosts(page); await openFiles(page); await expect(fileRow(page, 'README.md')).toBeVisible();
  await upload(page); await expect(files(page).getByRole('button', { name: '업로드', exact: true })).toBeEnabled(); await upload(page, true);
  await fileRow(page, 'README.md').getByRole('checkbox').check(); await files(page).getByRole('button', { name: '다운로드', exact: true }).click(); await expect(files(page).getByRole('button', { name: '다운로드', exact: true })).toBeEnabled();
  await expect(files(page).locator('.host-files-notice')).toHaveCount(0); await expect(files(page).getByRole('region', { name: '파일 전송', exact: true })).toHaveCount(0); const uploads = await calls(page, 'upload'); expect(uploads).toHaveLength(2); expect(uploads[1].config).toEqual({ directory: true }); expect(await calls(page, 'download')).toHaveLength(1);
});

test('우측에서 여러 파일 다운로드 진행률과 전송 취소 표시', async ({ page }) => {
  await install(page, { liveTransfer: true }); await openHosts(page); await openFiles(page); await expect(fileRow(page, 'README.md')).toBeVisible();
  await fileRow(page, 'README.md').getByRole('checkbox').check(); await fileRow(page, 'data.bin').getByRole('checkbox').check(); await files(page).getByRole('button', { name: '다운로드', exact: true }).click();
  const transfers = files(page).getByRole('region', { name: '파일 전송', exact: true }); await expect(transfers).toContainText('25% · 128 KiB / 512 KiB'); await expect(transfers.getByRole('progressbar', { name: 'transfer-1 전송 진행률', exact: true })).toHaveAttribute('value', '25');
  expect((await calls(page, 'download'))[0].paths).toEqual(['/home/demo/README.md', '/home/demo/data.bin']); await transfers.getByRole('button', { name: 'transfer-1 전송 취소', exact: true }).click(); await expect(transfers).toContainText('취소'); await expect(transfers.getByRole('progressbar')).toHaveCount(0); await expect(files(page).getByRole('button', { name: '다운로드', exact: true })).toBeEnabled();
});

test('전송 중 목록·계정 메뉴를 이동해도 전송이 유지되고 다시 열면 중복 작업 차단', async ({ page }) => {
  await install(page, { liveTransfer: true }); await openHosts(page); await openFiles(page); await expect(fileRow(page, 'README.md')).toBeVisible(); await upload(page);
  await expect(files(page).getByRole('region', { name: '파일 전송', exact: true })).toContainText('전송 중'); await files(page).getByRole('button', { name: '호스트 목록으로 돌아가기', exact: true }).click(); expect(await calls(page, 'cancel')).toEqual([]);
  await page.getByRole('button', { name: '계정관리', exact: true }).click(); await page.getByRole('button', { name: '호스트관리', exact: true }).click(); await openFiles(page); await expect(fileRow(page, 'README.md')).toBeVisible();
  await expect(files(page).getByRole('button', { name: '업로드', exact: true })).toBeDisabled(); await expect(files(page).getByRole('button', { name: '새 폴더', exact: true })).toBeDisabled(); expect(await calls(page, 'upload')).toHaveLength(1); expect(await calls(page, 'cancel')).toEqual([]);
  await page.evaluate(() => window.completeFileTransfer()); await expect(fileRow(page, 'uploaded.txt')).toBeVisible(); await expect(files(page).getByRole('region', { name: '파일 전송', exact: true })).toContainText('완료'); await expect(files(page).getByRole('button', { name: '새 폴더', exact: true })).toBeEnabled();
});

test('파일 작업 실패 후 이름 입력을 보존하고 자동으로 재시도하지 않음', async ({ page }) => {
  await install(page, { mutationFails: true }); await openHosts(page); await openFiles(page); await expect(fileRow(page, 'README.md')).toBeVisible(); await fileRow(page, 'README.md').getByRole('checkbox').check();
  await files(page).locator('.host-files-header').getByRole('button', { name: '이름 변경', exact: true }).click(); const form = files(page).getByRole('form', { name: '이름 변경', exact: true }); await form.getByRole('textbox').fill('guide.md'); await form.getByRole('button', { name: '이름 변경', exact: true }).click();
  await expect(files(page).getByRole('alert')).toContainText('이름 변경 권한이 없습니다.'); await expect(form.getByRole('textbox')).toHaveValue('guide.md'); expect(await calls(page, 'rename')).toHaveLength(1); await expect(fileRow(page, 'README.md')).toBeVisible();
});

test('파일 탭 키보드 이동은 진입 화면을 표시하고 공통 SSH 설정은 파일 접근 제한', async ({ page }) => {
  await install(page); await openHosts(page); await row(page).getByRole('button', { name: 'dev-server 호스트 정보', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'dev-server 호스트 정보', exact: true }), info = dialog.getByRole('tab', { name: '접속 정보', exact: true }), fileTab = dialog.getByRole('tab', { name: '파일', exact: true });
  await info.focus(); await page.keyboard.press('End'); await expect(fileTab).toBeFocused(); await expect(fileTab).toHaveAttribute('aria-selected', 'true'); await expect(dialog.getByRole('button', { name: '파일 관리 열기', exact: true })).toBeVisible(); expect(await calls(page, 'list')).toEqual([]);
  const panel = await fileTab.getAttribute('aria-controls'); await expect(dialog.locator(`[id="${panel}"]`)).toHaveAttribute('aria-labelledby', await fileTab.getAttribute('id')); await page.keyboard.press('ArrowRight'); await expect(info).toBeFocused(); await page.keyboard.press('Escape');
  await expect(row(page, '*').getByRole('button', { name: '* 파일 관리', exact: true })).toBeDisabled(); await row(page, '*').getByRole('button', { name: '* 호스트 정보', exact: true }).click(); await expect(page.getByRole('dialog', { name: '* 호스트 정보', exact: true }).getByRole('tab', { name: '파일', exact: true })).toBeDisabled();
});

test('닫힌 호스트의 늦은 응답이 다른 호스트 파일 목록을 덮어쓰지 않음', async ({ page }) => {
  await install(page, { staleHost: true }); await openHosts(page); await openFiles(page); await expect.poll(() => page.evaluate(() => Boolean(window.resolveOldHostFiles))).toBe(true); await files(page).getByRole('button', { name: '호스트 목록으로 돌아가기', exact: true }).click();
  await openFiles(page, 'second-server'); await expect(fileRow(page, 'README.md')).toBeVisible(); await page.evaluate(() => window.resolveOldHostFiles()); await expect(fileRow(page, 'private.txt')).toHaveCount(0); await expect(files(page).getByRole('textbox', { name: '원격 폴더 경로', exact: true })).toHaveValue('/home/demo');
});

test('조회되지 않은 크기는 0으로 표시하지 않고 권한 열은 생략', async ({ page }) => {
  await install(page, { unknownSize: true }); await openHosts(page); await openFiles(page); await expect(fileRow(page, 'README.md')).toBeVisible(); await expect(fileRow(page, 'README.md').locator('td').nth(2)).toHaveText('—'); await expect(files(page).getByRole('columnheader', { name: '권한', exact: true })).toHaveCount(0);
  await fileRow(page, 'README.md').getByRole('button').click(); await fileOption(page, '파일 정보 표시', true); const inspector = files(page).getByRole('complementary', { name: '파일 정보', exact: true }); await expect(inspector.locator('dl')).toContainText('크기—');
});

test('기존 전송은 중복 작업을 막고 폴더 이동과 취소는 계속 사용 가능', async ({ page }) => {
  await install(page, { restoredTransfer: true }); await openHosts(page); await openFiles(page); const transfers = files(page).getByRole('region', { name: '파일 전송', exact: true });
  await expect(transfers).toContainText('large.bin'); await expect(transfers).toContainText('1개 파일 전송 완료. 취소 시 남은 임시 파일을 확인하십시오.'); await expect(files(page).getByRole('button', { name: '새 폴더', exact: true })).toBeDisabled();
  await openPath(page, '/home/demo/logs'); await expect(fileRow(page, 'app.log')).toBeVisible(); await transfers.getByRole('button', { name: 'restored-1 전송 취소', exact: true }).click(); await expect(files(page).getByRole('button', { name: '새 폴더', exact: true })).toBeEnabled(); expect(await calls(page, 'upload')).toEqual([]);
});

test('구버전 연결에서는 파일 기능 안내를 표시하고 요청하지 않음', async ({ page }) => {
  await install(page, { unsupportedFiles: true }); await openHosts(page); await openFiles(page); await expect(files(page).getByRole('alert')).toContainText('파일 기능은 최신 데스크톱 앱에서 사용할 수 있습니다.'); expect(await calls(page, 'list')).toEqual([]); await expect(files(page).getByRole('button', { name: '새 폴더', exact: true })).toBeDisabled();
});

test('목록 조회 오류는 다시 시도 버튼으로 복구하고 자동 재시도하지 않음', async ({ page }) => {
  await install(page, { listFails: true }); await openHosts(page); await openFiles(page); await expect(files(page).getByRole('alert')).toContainText('파일 목록 조회 실패'); expect(await calls(page, 'list')).toHaveLength(1);
  await files(page).getByRole('alert').getByRole('button', { name: '다시 시도', exact: true }).click(); await expect.poll(async () => (await calls(page, 'list')).length).toBe(2);
});

test('헤더와 선택 작업은 한 줄이며 파일 표는 넓은 창과 작은 창 모두 본문 전체 폭 사용', async ({ page }) => {
  await install(page); await page.setViewportSize({ width: 1340, height: 760 }); await openHosts(page); const host = row(page), actions = host.locator('.host-row-actions');
  const actionBoxes = await actions.locator('button').evaluateAll(buttons => buttons.map(button => { const box = button.getBoundingClientRect(); return { top: box.top, bottom: box.bottom }; })); expect(Math.max(...actionBoxes.map(box => box.top)) - Math.min(...actionBoxes.map(box => box.top))).toBeLessThanOrEqual(3); expect((await host.boundingBox()).height).toBeLessThanOrEqual(48);
  const actionCell = await host.locator('td').last().boundingBox();
  const actionEdges = await actions.locator('button').evaluateAll(buttons => buttons.map(button => { const box = button.getBoundingClientRect(); return { left: box.left, right: box.right }; }));
  for (const button of actionEdges) { expect(button.left).toBeGreaterThanOrEqual(actionCell.x); expect(button.right).toBeLessThanOrEqual(actionCell.x + actionCell.width); }
  await screenshot(page, 'host-list-wide.png');
  await openFiles(page); await expect(fileRow(page, 'README.md')).toBeVisible();
  await expect(files(page).getByRole('complementary', { name: '파일 정보', exact: true })).toBeHidden(); await expectCompactHeader(page);
  await fileRow(page, 'README.md').getByRole('checkbox').check(); await fileRow(page, 'data.bin').getByRole('checkbox').check(); await expectCompactHeader(page); await screenshot(page, 'host-files-wide.png');
  await page.setViewportSize({ width: 880, height: 440 }); const back = files(page).getByRole('button', { name: '호스트 목록으로 돌아가기', exact: true }); await expect(back).toBeVisible(); const backBox = await back.boundingBox(); expect(backBox.y).toBeGreaterThanOrEqual(0); expect(backBox.y + backBox.height).toBeLessThanOrEqual(440);
  await expect(files(page).getByRole('complementary', { name: '파일 정보', exact: true })).toBeHidden(); await expect(files(page).getByRole('button', { name: '다운로드', exact: true })).toBeVisible(); await expect(files(page).getByRole('button', { name: '파일 검색', exact: true })).toBeInViewport();
  await expectCompactHeader(page);
  await fileOption(page, '파일 정보 표시', true); await expect(files(page).getByRole('complementary', { name: '파일 정보', exact: true })).toBeVisible(); await files(page).getByRole('button', { name: '파일 정보 닫기', exact: true }).click(); await expectCompactHeader(page); await screenshot(page, 'host-files-compact.png');
  await back.click(); await expect(row(page)).toBeVisible();
});


test('이동할 폴더를 조회 중이거나 조회에 실패하면 이동을 실행할 수 없음', async ({ page }) => {
  await install(page, { movePending: true }); await openHosts(page); await openFiles(page); await fileRow(page, 'README.md').getByRole('checkbox').check(); await files(page).getByRole('button', { name: '이동', exact: true }).click();
  const move = files(page).getByRole('form', { name: '파일 이동', exact: true }); await move.getByRole('button', { name: 'projects 이동 폴더 열기', exact: true }).click(); await expect(move.getByRole('button', { name: '이 폴더로 이동', exact: true })).toBeDisabled(); expect(await calls(page, 'move')).toEqual([]);
  await page.evaluate(() => window.resolveMoveFolderFiles()); await expect(move.getByRole('button', { name: '이 폴더로 이동', exact: true })).toBeEnabled();
});

test('이동할 폴더 조회 실패 시 입력을 보존하고 이동을 막음', async ({ page }) => {
  await install(page, { moveFails: true }); await openHosts(page); await openFiles(page); await fileRow(page, 'README.md').getByRole('checkbox').check(); await files(page).getByRole('button', { name: '이동', exact: true }).click();
  const move = files(page).getByRole('form', { name: '파일 이동', exact: true }); await move.getByRole('button', { name: 'projects 이동 폴더 열기', exact: true }).click(); await expect(move.getByRole('alert')).toContainText('이 폴더에 접근할 수 없습니다.'); await expect(move.getByRole('button', { name: '이 폴더로 이동', exact: true })).toBeDisabled(); await expect(move.locator('.host-files-picker-target')).toContainText('projects'); expect(await calls(page, 'move')).toEqual([]);
});

test('목록을 처음 불러오는 동안 업로드가 완료되면 뒤늦은 목록 응답 후 다시 조회', async ({ page }) => {
  await install(page, { restoredTransfer: true, staleInitial: true }); await openHosts(page); await openFiles(page); await expect.poll(() => page.evaluate(() => Boolean(window.resolveInitialFiles))).toBe(true);
  await page.evaluate(() => window.finishRestoredUpload('completed')); await page.evaluate(() => window.resolveInitialFiles()); await expect(fileRow(page, 'partial-upload.txt')).toBeVisible(); expect(await calls(page, 'list')).toHaveLength(2);
});

for (const status of ['error', 'canceled']) test(`업로드가 ${status === 'error' ? '실패' : '취소'}해도 전송된 항목을 목록에 표시`, async ({ page }) => {
  await install(page, { restoredTransfer: true }); await openHosts(page); await openFiles(page); await expect(fileRow(page, 'README.md')).toBeVisible(); await page.evaluate(status => window.finishRestoredUpload(status), status); await expect(fileRow(page, 'partial-upload.txt')).toBeVisible(); await expect(files(page).getByRole('button', { name: '새 폴더', exact: true })).toBeEnabled();
});


for (const status of ['error', 'canceled']) test(`초기 전송 조회보다 먼저 ${status === 'error' ? '실패' : '취소'} 알림을 받으면 첫 목록 뒤 다시 조회`, async ({ page }) => {
  await install(page, { restoredTransfer: true, staleInitial: true, deferredTransferSnapshot: true }); await openHosts(page); await openFiles(page); await expect.poll(() => page.evaluate(() => Boolean(window.resolveInitialFiles && window.resolveFileTransferSnapshot))).toBe(true);
  await page.evaluate(status => window.finishRestoredUpload(status), status); await page.evaluate(() => window.resolveInitialFiles()); await expect(fileRow(page, 'partial-upload.txt')).toBeVisible(); expect(await calls(page, 'list')).toHaveLength(2);
  await page.evaluate(() => window.resolveFileTransferSnapshot()); await expect(files(page).getByRole('button', { name: '새 폴더', exact: true })).toBeEnabled(); await expect(files(page).getByRole('region', { name: '파일 전송', exact: true })).toContainText(status === 'error' ? '실패' : '취소');
});


test('파일 탐색과 선택 작업은 아이콘으로 표시하고 업로드 메뉴 설명을 유지', async ({ page }) => {
  await install(page); await openHosts(page); await openFiles(page);
  await fileRow(page, 'README.md').getByRole('checkbox').check();
  for (const name of ['이전 폴더', '상위 폴더', '홈 폴더', '파일 새로고침', '새 폴더', '다운로드', '이름 변경', '이동', '삭제']) {
    await expect(files(page).getByRole('button', { name, exact: true })).toHaveText('');
  }
  const rename = files(page).getByRole('button', { name: '이름 변경', exact: true });
  await rename.focus(); await expect(page.locator('.action-tooltip')).toHaveText('이름 변경'); await rename.press('Escape'); await expect(page.locator('.action-tooltip')).toBeHidden(); await expect(rename).toBeFocused(); await expect(fileRow(page, 'README.md').getByRole('checkbox')).toBeChecked();
  await files(page).getByRole('button', { name: '업로드', exact: true }).click();
  await expect(files(page).getByRole('menuitem', { name: '파일 업로드', exact: true })).toBeVisible();
  await expect(files(page).getByRole('menuitem', { name: '폴더 업로드', exact: true })).toBeVisible();
  expect(await calls(page, 'upload')).toEqual([]);
  await files(page).getByRole('menuitem', { name: '파일 업로드', exact: true }).press('Escape');
  await rename.focus(); await expect(page.locator('.action-tooltip')).toHaveText('이름 변경'); await rename.press('Escape'); await expect(page.locator('.action-tooltip')).toBeHidden(); await rename.press('Escape'); await expect(fileRow(page, 'README.md').getByRole('checkbox')).not.toBeChecked(); await expect(rename).toBeDisabled();
});
