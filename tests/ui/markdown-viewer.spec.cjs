const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const screenshot = async (page, name) => {
  const directory = path.resolve('release/verification/0.3.4');
  fs.mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, name) });
};

const files = (page, alias = 'dev-server') => page.getByRole('region', { name: `${alias} 파일 브라우저`, exact: true });
const article = page => page.getByRole('article', { name: '마크다운 문서', exact: true });
const file = (page, name, alias) => files(page, alias).getByRole('button', { name: `${name} 파일 선택`, exact: true });
const calls = (page, method) => page.evaluate(method => window.markdownCalls.filter(item => item.method === method), method);

async function install(page, options = {}) {
  await page.addInitScript(options => {
    const calls = window.markdownCalls = [], home = '/home/demo', timestamp = '2026-10-10T14:30:00Z';
    const host = { id: 'host-1', alias: 'dev-server', hostPatterns: 'dev-server', hostName: '192.0.2.10', user: 'ubuntu', connectable: true, connection: { status: 'online' }, codex: { available: true, version: '0.149.0' } };
    const state = { configPath: '/example/ssh/config', revision: 'r1', groups: [], hosts: [host, { ...host, id: 'host-2', alias: 'second-server', hostPatterns: 'second-server' }], refresh: { running: false }, batchUpgrade: { running: false, hostIds: [] } };
    const account = { accounts: [], refresh: { running: false }, runtime: { available: true } };
    window.accountManager = { getState: async () => account, onState: () => () => {} };
    const entry = (path, type = 'file') => ({ path, name: path.split('/').at(-1), type, size: type === 'directory' ? 0 : 1024, modifiedAt: timestamp, mode: type === 'directory' ? '755' : '644' });
    const documents = {
      [`${home}/README.md`]: options.content || '# 사용 안내\n\n문서를 **읽고** 파일을 관리합니다.\n\n## 기능\n\n| 이름 | 상태 |\n| --- | --- |\n| 탐색 | 완료 |\n\n- [x] 파일 조회\n- [ ] 파일 업로드\n\n> 선택한 문서는 읽기 전용입니다.\n\n```js\nconst value = 42;\n```\n\n~~이전 내용~~\n\n[다음 문서](docs/guide.markdown)\n\n[다음 문서 제목](docs/guide.markdown#세부-설명)\n\n[기능으로 이동](#기능)\n\n[웹사이트](https://example.com/help)\n',
      [`${home}/docs/guide.markdown`]: '# 다음 문서\n\n[처음 문서](../README.md)\n\n[이름에 공백이 있는 문서](../Read%20Me.md)\n\n## 세부 설명\n\n[처음 기능](../README.md#기능)\n\n[자기 제목](guide.markdown#세부-설명)\n',
      [`${home}/Read Me.md`]: '# 공백 문서\n\n파일 이름에 공백을 사용할 수 있습니다.\n',
      [`${home}/OTHER.md`]: '# 다른 문서\n\n이 문서는 새 요청의 내용입니다.\n',
    };
    let failures = options.failOnce ? 1 : 0;
    window.hostManager = {
      getState: async () => structuredClone(state), onState: () => () => {}, refreshHosts: async () => structuredClone(state),
      getHostDetails: async id => ({ host: structuredClone(state.hosts.find(item => item.id === id)), effective: { hostName: host.hostName, user: host.user, port: 22 }, key: {} }),
      listFiles: async (id, path) => {
        calls.push({ method: 'list', id, path });
        const resolved = path || home;
        return { path: resolved, home, entries: resolved === home ? [entry(`${home}/docs`, 'directory'), entry(`${home}/README.md`), entry(`${home}/OTHER.md`), entry(`${home}/Read Me.md`)] : resolved === `${home}/docs` ? [entry(`${home}/docs/guide.markdown`)] : [] };
      },
      getFileTransfers: async () => [], onFileTransfers: () => () => {},
      readTextFile: async (id, path) => {
        calls.push({ method: 'read', id, path });
        if (failures) { failures--; throw new Error('이 문서를 읽을 수 없습니다.'); }
        if (options.stale && id === 'host-1' && path === `${home}/README.md`) return new Promise(resolve => { window.resolveOldMarkdown = () => resolve({ hostId: id, path, name: 'README.md', content: '# 이전 요청의 문서\n\n이 내용은 표시하지 않습니다.', size: 1024, modifiedAt: timestamp }); });
        const content = id === 'host-2' ? '# 두 번째 호스트\n\n새 호스트의 문서입니다.' : documents[path];
        if (content === undefined) throw new Error('문서를 찾을 수 없습니다.');
        return { hostId: id, path, name: path.split('/').at(-1), content, size: 1024, modifiedAt: timestamp };
      },
      openFileLink: async url => { calls.push({ method: 'link', url }); if (options.linkFails) throw new Error('브라우저를 열지 못했습니다.'); return { success: true }; },
    };
    if (options.unsupported) delete window.hostManager.readTextFile;
  }, options);
}

async function openFiles(page, alias = 'dev-server') {
  await page.getByRole('button', { name: `${alias} 파일 관리`, exact: true }).click();
  await expect(files(page, alias).getByRole('table', { name: '원격 파일 목록', exact: true })).toBeVisible();
}
async function open(page, options = {}, name = 'README.md') {
  await install(page, options); await page.goto('/');
  await page.getByRole('button', { name: '호스트관리', exact: true }).click();
  await openFiles(page); await file(page, name).dblclick();
}
async function showFileInfo(page) {
  await files(page).getByRole('button', { name: '파일 옵션', exact: true }).click();
  const option = files(page).getByRole('menuitemcheckbox', { name: '파일 정보 표시', exact: true });
  await expect(option).toHaveAttribute('aria-checked', 'false');
  await option.click();
  if (await option.isVisible()) await option.press('Escape');
}

test.beforeEach(async ({ page }) => { page.uiErrors = []; page.on('pageerror', error => page.uiErrors.push(error.message)); });
test.afterEach(async ({ page }) => expect(page.uiErrors).toEqual([]));

test('GitHub 스타일로 제목·표·작업 목록·코드·인용을 표시하고 파일 정보와 목록 이동을 유지', async ({ page }) => {
  await page.setViewportSize({ width: 1340, height: 760 });
  await open(page);
  await expect(article(page).getByRole('heading', { name: '사용 안내', exact: true })).toBeVisible();
  await expect(article(page).getByRole('table')).toContainText('탐색');
  const tasks = article(page).getByRole('checkbox'); await expect(tasks).toHaveCount(2); await expect(tasks.nth(0)).toBeChecked(); await expect(tasks.nth(1)).not.toBeChecked(); await expect(tasks.nth(0)).toBeDisabled();
  await expect(article(page).locator('pre code')).toHaveText('const value = 42;\n');
  await expect(article(page).locator('blockquote')).toContainText('읽기 전용'); await expect(article(page).locator('del')).toHaveText('이전 내용');
  await expect(page.getByRole('complementary', { name: '파일 정보', exact: true })).toBeHidden(); await showFileInfo(page);
  await expect(page.getByRole('complementary', { name: '파일 정보', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await article(page).evaluate(element => getComputedStyle(element).color)).toBe('rgb(31, 35, 40)');
  expect(await article(page).getByRole('table').evaluate(element => getComputedStyle(element).minWidth)).toBe('0px');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await expect(page.getByRole('button', { name: '파일 목록', exact: true })).toBeInViewport();
  await screenshot(page, 'markdown-wide.png');
  await page.getByRole('button', { name: '파일 목록', exact: true }).click(); await expect(file(page, 'README.md')).toBeVisible(); await expect(article(page)).toHaveCount(0);
  await page.getByRole('button', { name: '호스트 목록으로 돌아가기', exact: true }).click(); await expect(page.getByRole('table', { name: '호스트 목록', exact: true })).toBeVisible();
});

test('상대 마크다운 링크는 같은 호스트의 문서를 열고 외부 링크는 클릭할 때만 브라우저를 요청', async ({ page }) => {
  await open(page); await expect(article(page)).toBeVisible(); expect(await calls(page, 'link')).toEqual([]);
  const address = page.url(); await article(page).getByRole('link', { name: '웹사이트', exact: true }).click();
  expect(await calls(page, 'link')).toEqual([{ method: 'link', url: 'https://example.com/help' }]); expect(page.url()).toBe(address);
  await article(page).getByRole('link', { name: '다음 문서', exact: true }).click(); await expect(article(page).getByRole('heading', { name: '다음 문서', exact: true })).toBeVisible();
  await article(page).getByRole('link', { name: '이름에 공백이 있는 문서', exact: true }).click(); await expect(article(page).getByRole('heading', { name: '공백 문서', exact: true })).toBeVisible();
  expect(await calls(page, 'read')).toEqual([{ method: 'read', id: 'host-1', path: '/home/demo/README.md' }, { method: 'read', id: 'host-1', path: '/home/demo/docs/guide.markdown' }, { method: 'read', id: 'host-1', path: '/home/demo/Read Me.md' }]);
});

test('문서의 위치 링크는 해당 제목으로 이동하고 다른 화면의 요소를 조작하지 않음', async ({ page }) => {
  await open(page, { content: '# 시작\n\n[같은 제목 두 번째](#반복-1)\n\n[다른 화면](#host-list)\n\n## 반복\n\n처음 제목\n\n## 반복\n\n두 번째 제목\n' });
  const headings = article(page).getByRole('heading', { name: '반복', exact: true }); await expect(headings).toHaveCount(2);
  const url = page.url(); await article(page).getByRole('link', { name: '같은 제목 두 번째', exact: true }).click(); await expect(headings.nth(1)).toBeFocused(); expect(page.url()).toBe(url);
  await article(page).getByRole('link', { name: '다른 화면', exact: true }).click(); await expect(article(page)).toBeVisible(); expect(await calls(page, 'link')).toEqual([]);
});

test('다른 마크다운 파일의 제목 링크를 유지하고 다시 같은 제목으로 이동할 수 있음', async ({ page }) => {
  await open(page); await showFileInfo(page); await article(page).getByRole('link', { name: '다음 문서 제목', exact: true }).click();
  await expect(article(page).getByRole('heading', { name: '세부 설명', exact: true })).toBeFocused();
  await expect(page.getByRole('complementary', { name: '파일 정보', exact: true })).toContainText('guide.markdown');
  await article(page).getByRole('link', { name: '자기 제목', exact: true }).click(); await expect(article(page).getByRole('heading', { name: '세부 설명', exact: true })).toBeFocused(); expect(await calls(page, 'read')).toHaveLength(2);
  await article(page).getByRole('link', { name: '처음 기능', exact: true }).click(); await expect(article(page).getByRole('heading', { name: '기능', exact: true })).toBeFocused();
  await article(page).getByRole('link', { name: '다음 문서 제목', exact: true }).click(); await expect(article(page).getByRole('heading', { name: '세부 설명', exact: true })).toBeFocused();
});

test('원격 문서의 이미지·HTML·위험한 링크는 실행하거나 외부로 요청하지 않음', async ({ page }) => {
  const network = [];
  page.on('request', request => { if (request.url().includes('markdown-tracker.invalid')) network.push(request.url()); });
  const content = '# 문서 안전\n\n![서버 이미지](https://markdown-tracker.invalid/image?token=private)\n\n![로컬 이미지](file:///etc/passwd)\n\n![폴더 이미지](./photo.png)\n\n<script>window.markdownInjected = true</script>\n\n<img src="https://markdown-tracker.invalid/html" onerror="window.markdownInjected = true">\n\n[스크립트](javascript:alert%281%29)\n\n[데이터](data:text/html;base64,AAA)\n\n[로컬 파일](file:///etc/passwd)\n\n[SSH 링크](ssh://server)\n\n[다른 서버](//markdown-tracker.invalid/link)\n\n[인코딩된 주소](jav%61script%3Aalert.md)\n\n[일반 파일](./config.json)\n';
  await open(page, { content }); await expect(article(page).getByRole('heading', { name: '문서 안전', exact: true })).toBeVisible();
  await expect(article(page).locator('img, script, iframe')).toHaveCount(0); await expect(article(page).getByRole('img')).toHaveCount(3);
  await expect(article(page).getByRole('link')).toHaveCount(0);
  expect(await page.evaluate(() => window.markdownInjected)).toBeUndefined(); expect(await calls(page, 'link')).toEqual([]); expect(network).toEqual([]);
  await expect(article(page)).not.toContainText('token=private');
});

test('문서 오류는 재시도 전에 한 번만 요청하고 목록으로 돌아갈 수 있음', async ({ page }) => {
  await open(page, { failOnce: true }); await expect(page.getByRole('alert')).toContainText('이 문서를 읽을 수 없습니다.');
  await expect(article(page)).toHaveCount(0); expect(await calls(page, 'read')).toHaveLength(1);
  await page.getByRole('button', { name: '다시 시도', exact: true }).click(); await expect(article(page).getByRole('heading', { name: '사용 안내', exact: true })).toBeVisible(); expect(await calls(page, 'read')).toHaveLength(2);
  await page.getByRole('button', { name: '파일 목록', exact: true }).click(); await expect(file(page, 'README.md')).toBeVisible();
});

test('닫힌 문서의 늦은 응답이 새 문서나 새 호스트의 내용을 덮어쓰지 않음', async ({ page }) => {
  await open(page, { stale: true }); await expect(page.getByRole('status')).toContainText('문서를 불러오는 중입니다.');
  await expect.poll(() => page.evaluate(() => Boolean(window.resolveOldMarkdown))).toBe(true);
  await page.getByRole('button', { name: '파일 목록', exact: true }).click(); await file(page, 'OTHER.md').dblclick(); await expect(article(page).getByRole('heading', { name: '다른 문서', exact: true })).toBeVisible();
  await page.evaluate(() => window.resolveOldMarkdown()); await expect(article(page).getByRole('heading', { name: '다른 문서', exact: true })).toBeVisible(); await expect(article(page)).not.toContainText('이전 요청');
  await page.getByRole('button', { name: '호스트 목록으로 돌아가기', exact: true }).click(); await openFiles(page, 'second-server'); await file(page, 'README.md', 'second-server').dblclick();
  await expect(article(page).getByRole('heading', { name: '두 번째 호스트', exact: true })).toBeVisible(); await page.evaluate(() => window.resolveOldMarkdown()); await expect(article(page)).not.toContainText('이전 요청');
});

test('키보드로 문서를 열고 제목에 초점을 맞추며 Escape로 파일 목록에 돌아감', async ({ page }) => {
  await install(page); await page.goto('/'); await page.getByRole('button', { name: '호스트관리', exact: true }).click(); await openFiles(page);
  await file(page, 'README.md').focus(); await page.keyboard.press('Enter'); await expect(article(page)).toBeVisible();
  await expect(page.getByRole('region', { name: 'README.md 미리보기', exact: true }).getByRole('heading', { name: 'README.md', exact: true })).toBeFocused();
  const link = article(page).getByRole('link', { name: '웹사이트', exact: true }); await link.focus(); await page.keyboard.press('Enter'); expect(await calls(page, 'link')).toHaveLength(1);
  await page.keyboard.press('Escape'); await expect(file(page, 'README.md')).toBeVisible(); await expect(article(page)).toHaveCount(0);
});

test('외부 브라우저 오류는 문서 내용을 보존하고 자동 재시도하지 않음', async ({ page }) => {
  await open(page, { linkFails: true }); await article(page).getByRole('link', { name: '웹사이트', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('브라우저를 열지 못했습니다.'); await expect(article(page).getByRole('heading', { name: '사용 안내', exact: true })).toBeVisible(); expect(await calls(page, 'link')).toHaveLength(1);
});

test('미리보기 기능이 없는 연결은 안내를 표시하고 파일 목록을 유지', async ({ page }) => {
  await open(page, { unsupported: true }); await expect(page.getByRole('alert')).toContainText('문서 미리보기는 최신 데스크톱 앱에서 사용할 수 있습니다.'); expect(await calls(page, 'read')).toEqual([]);
  await page.getByRole('button', { name: '파일 목록', exact: true }).click(); await expect(file(page, 'README.md')).toBeVisible();
});

test('좁은 창에서도 마크다운 표와 코드를 문서 영역 안에서 읽을 수 있음', async ({ page }) => {
  await page.setViewportSize({ width: 880, height: 440 }); await open(page, { content: '# 긴 문서\n\n| 이름 | 설명 |\n| --- | --- |\n| 파일 | ' + '긴 설명 '.repeat(60) + ' |\n\n```text\n' + 'long-line '.repeat(80) + '\n```\n' });
  await expect(article(page).getByRole('heading', { name: '긴 문서', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await expect(page.getByRole('button', { name: '파일 목록', exact: true })).toBeInViewport();
  await screenshot(page, 'markdown-compact.png');
  await page.getByRole('button', { name: '파일 목록', exact: true }).click(); await expect(file(page, 'README.md')).toBeVisible();
});

test('문서 미리보기에서도 헤더 경로 입력으로 다른 폴더를 직접 열 수 있음', async ({ page }) => {
  await open(page); await expect(article(page)).toBeVisible();
  const navigator = files(page).getByRole('textbox', { name: '원격 폴더 경로', exact: true });
  await expect(navigator).toHaveValue('/home/demo');
  await navigator.fill('/home/demo/docs'); await navigator.press('Enter');
  await expect(article(page)).toHaveCount(0); await expect(file(page, 'guide.markdown')).toBeVisible(); await expect(navigator).toHaveValue('/home/demo/docs');
  expect((await calls(page, 'list')).at(-1)).toEqual({ method: 'list', id: 'host-1', path: '/home/demo/docs' });
});
