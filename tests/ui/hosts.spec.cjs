const { test, expect } = require('@playwright/test');

const hostRow = (page, alias) => page.getByRole('table', { name: '호스트 목록', exact: true }).locator('tbody > tr').filter({ has: page.getByRole('button', { name: `${alias} 호스트 정보`, exact: true }) });

test.beforeEach(async ({ page }) => {
  page.uiErrors = [];
  page.on('pageerror', error => page.uiErrors.push(error.message));
});
test.afterEach(async ({ page }) => expect(page.uiErrors).toEqual([]));

async function installMock(page, options = {}) {
  await page.addInitScript(({ unread = false, configError = false, missingPublic = false, registeredInitially = false, inspectFails = false, registerFails = false, secondHost = false, compactRows = false, reorderFails = false }) => {
    window.hostCalls = [];
    const listeners = new Set();
    const key = { privateKeyPath: '/example/id_ed25519', publicKeyPath: '/example/id_ed25519.pub', privateExists: true, publicExists: true, fingerprint: 'SHA256:test-fingerprint', publicKey: 'ssh-ed25519 EXAMPLE_PUBLIC_KEY user@computer' };
    const host = { id: 'host-1', alias: 'dev-server', hostPatterns: 'dev-server', hostName: '192.0.2.10', user: 'ubuntu', port: '2222', identityFile: '/example/id_ed25519', proxyJump: 'bastion', connectable: true, connection: { status: 'online' }, codex: { available: true, version: '0.149.0', accountEmail: 'developer@example.com', loginStatus: 'chatgpt' } };
    const state = { configPath: '/example/ssh/config', revision: 'revision-1', hosts: [host], refresh: { running: false } };
    if (secondHost) state.hosts.push({ ...structuredClone(host), id: 'host-2', alias: 'prod-server', hostPatterns: 'prod-server', hostName: '192.0.2.20' });
    if (compactRows) {
      Object.assign(host, {
        alias: 'research-processing-production-cluster', hostPatterns: 'research-processing-production-cluster',
        hostName: 'research-workers.internal.example.company', user: 'administrator',
        connection: { status: 'online', checkedAt: '2026-10-08T03:10:30.000Z', message: 'SSH 연결을 완료했습니다.' },
        codex: { available: true, version: '0.159.0', accountEmail: 'research.operations.administrator@example.organization.com', accountPlan: 'pro', loginStatus: 'chatgpt' },
        operation: { type: 'upgradeCodex', running: false, message: 'Codex 업그레이드 성공 표시 문구' },
      });
      state.hosts.push({ ...structuredClone(host), id: 'host-2', alias: 'prod-server', hostPatterns: 'prod-server', hostName: '192.0.2.20',
        connection: { status: 'offline', checkedAt: '2026-10-08T03:12:40.000Z', message: 'SSH 연결이 거부되었습니다. production-workers.private.example.company의 2222 포트와 원격 서버의 SSH 설정을 확인하십시오. 재시도 전에 네트워크 연결과 서버 접근 권한을 확인하십시오.' },
        codex: { available: null, version: null, accountEmail: null, accountPlan: null, loginStatus: 'unknown' },
        operation: { type: null, running: false, message: '' },
      });
      state.hosts.push({ ...structuredClone(host), id: 'host-3', alias: 'backup-server', hostPatterns: 'backup-server', hostName: '192.0.2.30',
        connection: { status: 'online', checkedAt: '2026-10-08T03:15:10.000Z', message: '' },
        codex: { available: true, version: '0.158.0', accountEmail: 'backup@example.com', accountPlan: 'team', loginStatus: 'chatgpt' },
        operation: { type: null, running: false, message: '' },
      });
      const savedOrder = JSON.parse(localStorage.getItem('host-test-order') || 'null');
      if (Array.isArray(savedOrder)) {
        const positions = new Map(savedOrder.map((id, index) => [id, index]));
        state.hosts.sort((left, right) => (positions.get(left.id) ?? 99) - (positions.get(right.id) ?? 99));
      }
    }
    if (unread) { host.connection = { status: 'unknown', checkedAt: null }; host.codex = { available: null, version: null, loginStatus: 'unknown' }; }
    if (configError) { state.error = 'SSH 설정 파일을 읽을 수 없습니다.'; state.hosts = []; }
    if (missingPublic) key.publicExists = false;
    const accountState = { accounts: [], refresh: { running: false }, runtime: { available: true } };
    window.accountManager = { getState: async () => accountState, onState: () => () => {} };
    const emit = () => { listeners.forEach(callback => callback(structuredClone(state))); return structuredClone(state); };
    let registered = registeredInitially;
    window.hostManager = {
      getState: async () => { window.hostCalls.push({ method: 'getState' }); return structuredClone(state); },
      onState: callback => { listeners.add(callback); return () => listeners.delete(callback); },
      reloadHosts: async () => { window.hostCalls.push({ method: 'reload' }); return emit(); },
      refreshHosts: async ids => { window.hostCalls.push({ method: 'refresh', ids }); host.connection = { status: 'online', checkedAt: new Date().toISOString() }; host.codex = { available: true, version: '0.149.0', accountEmail: 'developer@example.com', loginStatus: 'chatgpt' }; return emit(); },
      cancelRefresh: async () => emit(),
      getHostDetails: async id => { window.hostCalls.push({ method: 'details', id }); const target = state.hosts.find(item => item.id === id); return { host: structuredClone(target), effective: { ...target }, key: structuredClone(key) }; },
      inspectKeys: async (id, password) => { window.hostCalls.push({ method: 'inspect', id, password }); if (inspectFails) throw new Error(`서버에 접속하지 못했습니다. ${password || ''}`); return { registered, key: structuredClone(key), keys: registered ? [{ id: 'key-1', comment: 'user@computer', keyType: 'ssh-ed25519', fingerprint: key.fingerprint, matchesLocal: true }] : [] }; },
      registerKey: async (id, password) => { window.hostCalls.push({ method: 'register', id, password }); if (registerFails) throw new Error(`공개 키를 등록하지 못했습니다. ${password || ''}`); registered = true; return { registered: true, message: '공개 키가 등록되었습니다.' }; },
      generateKey: async id => { window.hostCalls.push({ method: 'generate', id }); key.publicExists = true; return structuredClone(key); },
      saveHost: async (draft, revision) => { window.hostCalls.push({ method: 'save', draft, revision }); Object.assign(host, draft); return emit(); },
      deleteHost: async (id, revision) => { window.hostCalls.push({ method: 'delete', id, revision }); state.hosts = []; return emit(); },
      upgradeCodex: async id => { window.hostCalls.push({ method: 'upgrade', id }); host.codex.version = '0.150.0'; return emit(); },
      reorderHosts: async (ids, revision) => {
        window.hostCalls.push({ method: 'reorder', ids, revision });
        if (reorderFails) throw new Error('호스트 순서를 저장하지 못했습니다.');
        const positions = new Map(ids.map((id, index) => [id, index]));
        state.hosts.sort((left, right) => positions.get(left.id) - positions.get(right.id));
        localStorage.setItem('host-test-order', JSON.stringify(ids));
        return emit();
      },
    };
  }, options);
}

async function openHosts(page) {
  await page.goto('/');
  await page.getByRole('button', { name: '호스트관리', exact: true }).click();
  await expect(page.getByRole('heading', { name: '호스트관리', exact: true })).toBeVisible();
}

test('사이드바에서 계정관리와 호스트관리를 전환하고 공통 SSH 목록 표시', async ({ page }) => {
  await page.goto('/?demo=1');
  await expect(page.getByRole('table', { name: '계정 목록', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '호스트관리', exact: true }).click();
  await expect(page.getByRole('heading', { name: '호스트관리', exact: true })).toBeVisible();
  await expect(page.getByRole('table', { name: '호스트 목록', exact: true }).locator('tbody > tr')).toHaveCount(3);
  await expect(hostRow(page, 'dev-server')).toContainText('0.149.0');
  await expect(hostRow(page, 'dev-server')).toContainText('developer@example.com');
  await expect(hostRow(page, 'backup-server')).toContainText('접속 실패');
  await expect(hostRow(page, 'backup-server').locator('.host-version')).toHaveText('—');
  await expect(page.getByText('/demo/.ssh/config', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '계정관리', exact: true }).click();
  await expect(page.getByRole('table', { name: '계정 목록', exact: true })).toBeVisible();
});

test('호스트 조회는 메뉴를 연 후 시작하고 개별 호스트만 조회', async ({ page }) => {
  await installMock(page);
  await page.goto('/');
  expect(await page.evaluate(() => window.hostCalls)).toEqual([]);
  await page.getByRole('button', { name: '호스트관리', exact: true }).click();
  await hostRow(page, 'dev-server').getByRole('button', { name: 'dev-server 호스트 조회', exact: true }).click();
  expect(await page.evaluate(() => window.hostCalls)).toEqual([{ method: 'getState' }, { method: 'refresh', ids: ['host-1'] }]);
});

test('호스트 모달에서 SSH 정보와 키 등록을 표시하고 비밀번호를 저장하지 않음', async ({ page }) => {
  await installMock(page); await openHosts(page);
  await hostRow(page, 'dev-server').getByRole('button', { name: 'dev-server 호스트 정보', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'dev-server 호스트 정보', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('192.0.2.10');
  await expect(dialog).toContainText('ubuntu');
  await expect(dialog).toContainText('2222');
  await expect(dialog).toContainText('/example/id_ed25519');
  await expect(dialog).toContainText('bastion');
  await expect(dialog.getByRole('tab', { name: '접속 정보', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.getByRole('region', { name: '호스트 Codex 정보', exact: true })).toContainText('developer@example.com');
  await expect(dialog.getByRole('textbox', { name: '서버 비밀번호 (선택)', exact: true })).toBeHidden();
  await dialog.getByRole('tab', { name: '키 등록', exact: true }).click();
  await expect(dialog).toContainText('SHA256:test-fingerprint');
  await expect(dialog.getByRole('textbox', { name: '등록할 공개 키', exact: true })).toHaveValue('ssh-ed25519 EXAMPLE_PUBLIC_KEY user@computer');
  await expect(dialog.getByRole('region', { name: '서버에 등록된 키', exact: true })).not.toContainText('0개');
  await dialog.getByRole('textbox', { name: '서버 비밀번호 (선택)', exact: true }).fill('example-server-password');
  await dialog.getByRole('tab', { name: '접속 정보', exact: true }).click();
  await dialog.getByRole('tab', { name: '키 등록', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: '서버 비밀번호 (선택)', exact: true })).toHaveValue('example-server-password');
  expect(await page.evaluate(() => window.hostCalls.filter(call => call.method === 'inspect'))).toEqual([]);
  expect(await page.evaluate(() => window.hostCalls.filter(call => call.method === 'register'))).toEqual([]);
  await dialog.getByRole('button', { name: '미등록 시 등록', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '미등록 시 등록', exact: true })).toBeEnabled();
  await expect(dialog.getByRole('textbox', { name: '서버 비밀번호 (선택)', exact: true })).toHaveValue('');
  await expect(dialog.getByRole('region', { name: '서버에 등록된 키', exact: true })).toContainText('user@computer');
  await expect(dialog.getByRole('region', { name: '서버에 등록된 키', exact: true })).toContainText('이 컴퓨터');
  await expect(dialog.getByRole('region', { name: '처리 결과', exact: true })).toContainText('공개 키가 등록되었습니다.');
  await expect(dialog.getByRole('region', { name: '처리 결과', exact: true })).not.toContainText('example-server-password');
  const keyCalls = await page.evaluate(() => window.hostCalls.filter(call => ['inspect', 'register'].includes(call.method)));
  expect(keyCalls[0]).toEqual({ method: 'inspect', id: 'host-1', password: 'example-server-password' });
  expect(keyCalls[1]).toEqual({ method: 'register', id: 'host-1', password: 'example-server-password' });
  expect(await page.evaluate(() => window.hostCalls.filter(call => call.method === 'register'))).toEqual([{ method: 'register', id: 'host-1', password: 'example-server-password' }]);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(hostRow(page, 'dev-server').getByRole('button', { name: 'dev-server 호스트 정보', exact: true })).toBeFocused();
});

test('상세 탭을 키보드로 전환하고 조회 결과를 유지하며 다른 호스트는 접속 정보부터 표시', async ({ page }) => {
  await installMock(page, { secondHost: true }); await openHosts(page);
  await hostRow(page, 'dev-server').getByRole('button', { name: 'dev-server 호스트 정보', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'dev-server 호스트 정보', exact: true });
  const infoTab = dialog.getByRole('tab', { name: '접속 정보', exact: true });
  const keyTab = dialog.getByRole('tab', { name: '키 등록', exact: true });
  const infoPanel = dialog.getByRole('tabpanel', { name: '접속 정보', exact: true });
  const keyPanel = dialog.getByRole('tabpanel', { name: '키 등록', exact: true });
  await expect(infoTab).toHaveAttribute('aria-selected', 'true');
  await expect(infoPanel).toBeVisible();
  await expect(keyPanel).toBeHidden();
  await infoTab.focus();
  await page.keyboard.press('ArrowRight');
  await expect(keyTab).toBeFocused();
  await expect(keyTab).toHaveAttribute('aria-selected', 'true');
  await expect(infoPanel).toBeHidden();
  await expect(keyPanel).toBeVisible();
  expect(await page.evaluate(() => window.hostCalls.filter(call => ['inspect', 'register', 'generate'].includes(call.method)))).toEqual([]);
  await page.keyboard.press('Home');
  await expect(infoTab).toBeFocused();
  await page.keyboard.press('End');
  await expect(keyTab).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(infoTab).toBeFocused();
  await keyTab.click();
  await dialog.getByRole('button', { name: '등록 상태 조회', exact: true }).click();
  await expect(dialog.getByRole('region', { name: '서버에 등록된 키', exact: true })).toContainText('등록된 키가 없습니다.');
  const results = dialog.getByRole('region', { name: '처리 결과', exact: true });
  const resultText = await results.textContent();
  expect(resultText).not.toBe('');
  await infoTab.click();
  await keyTab.click();
  await expect(results).toHaveText(resultText);
  expect(await page.evaluate(() => window.hostCalls.filter(call => call.method === 'inspect'))).toHaveLength(1);
  await page.keyboard.press('Escape');
  await hostRow(page, 'prod-server').getByRole('button', { name: 'prod-server 호스트 정보', exact: true }).click();
  const next = page.getByRole('dialog', { name: 'prod-server 호스트 정보', exact: true });
  await expect(next.getByRole('tab', { name: '접속 정보', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(next.getByRole('tabpanel', { name: '접속 정보', exact: true })).toContainText('192.0.2.20');
});

test('비밀번호를 지우고 이미 등록된 키는 중복 등록하지 않음', async ({ page }) => {
  await installMock(page, { registeredInitially: true }); await openHosts(page);
  await hostRow(page, 'dev-server').getByRole('button', { name: 'dev-server 호스트 정보', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'dev-server 호스트 정보', exact: true });
  await dialog.getByRole('tab', { name: '키 등록', exact: true }).click();
  const password = dialog.getByRole('textbox', { name: '서버 비밀번호 (선택)', exact: true });
  await password.fill('password-to-clear');
  await dialog.getByRole('button', { name: '비밀번호 지우기', exact: true }).click();
  await expect(password).toHaveValue('');
  await password.fill('password-for-inspection');
  await dialog.getByRole('button', { name: '미등록 시 등록', exact: true }).click();
  await expect(password).toHaveValue('');
  await expect(dialog.getByRole('region', { name: '서버에 등록된 키', exact: true })).toContainText('이 컴퓨터');
  await expect(dialog.getByRole('region', { name: '처리 결과', exact: true })).not.toContainText('password-for-inspection');
  expect(await page.evaluate(() => window.hostCalls.filter(call => call.method === 'register'))).toEqual([]);
  expect(await page.evaluate(() => window.hostCalls.filter(call => call.method === 'inspect'))).toEqual([{ method: 'inspect', id: 'host-1', password: 'password-for-inspection' }]);
  await password.fill('password-before-closing');
  await page.keyboard.press('Escape');
  await hostRow(page, 'dev-server').getByRole('button', { name: 'dev-server 호스트 정보', exact: true }).click();
  await dialog.getByRole('tab', { name: '키 등록', exact: true }).click();
  await expect(password).toHaveValue('');
});

test('등록 전 조회가 실패하면 키를 쓰지 않고 비밀번호를 지움', async ({ page }) => {
  await installMock(page, { inspectFails: true }); await openHosts(page);
  await hostRow(page, 'dev-server').getByRole('button', { name: 'dev-server 호스트 정보', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'dev-server 호스트 정보', exact: true });
  await dialog.getByRole('tab', { name: '키 등록', exact: true }).click();
  const password = dialog.getByRole('textbox', { name: '서버 비밀번호 (선택)', exact: true });
  await password.fill('password-for-failed-inspection');
  await dialog.getByRole('button', { name: '미등록 시 등록', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('서버에 접속하지 못했습니다.');
  await expect(password).toHaveValue('');
  await expect(dialog.getByRole('button', { name: '미등록 시 등록', exact: true })).toBeEnabled();
  await expect(dialog.getByRole('region', { name: '처리 결과', exact: true })).not.toContainText('password-for-failed-inspection');
  expect(await page.evaluate(() => window.hostCalls.filter(call => call.method === 'register'))).toEqual([]);
});

test('키 등록 실패 후 비밀번호를 지우고 실패 결과를 표시', async ({ page }) => {
  await installMock(page, { registerFails: true }); await openHosts(page);
  await hostRow(page, 'dev-server').getByRole('button', { name: 'dev-server 호스트 정보', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'dev-server 호스트 정보', exact: true });
  await dialog.getByRole('tab', { name: '키 등록', exact: true }).click();
  const password = dialog.getByRole('textbox', { name: '서버 비밀번호 (선택)', exact: true });
  await password.fill('password-for-failed-registration');
  await dialog.getByRole('button', { name: '미등록 시 등록', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('공개 키를 등록하지 못했습니다.');
  await expect(password).toHaveValue('');
  await expect(dialog.getByRole('button', { name: '미등록 시 등록', exact: true })).toBeEnabled();
  await expect(dialog.getByRole('region', { name: '처리 결과', exact: true })).not.toContainText('password-for-failed-registration');
  expect(await page.evaluate(() => window.hostCalls.filter(call => ['inspect', 'register'].includes(call.method)))).toEqual([
    { method: 'inspect', id: 'host-1', password: 'password-for-failed-registration' },
    { method: 'register', id: 'host-1', password: 'password-for-failed-registration' },
  ]);
});

test('Codex 업그레이드는 호스트를 표시하는 확인창에서만 실행', async ({ page }) => {
  await installMock(page); await openHosts(page);
  await hostRow(page, 'dev-server').getByRole('button', { name: '업그레이드', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Codex 업그레이드', exact: true });
  await expect(dialog).toContainText('dev-server');
  await expect(dialog).toContainText('192.0.2.10');
  expect(await page.evaluate(() => window.hostCalls.filter(call => call.method === 'upgrade'))).toEqual([]);
  await dialog.getByRole('button', { name: '취소', exact: true }).click();
  expect(await page.evaluate(() => window.hostCalls.filter(call => call.method === 'upgrade'))).toEqual([]);
  await hostRow(page, 'dev-server').getByRole('button', { name: '업그레이드', exact: true }).click();
  await dialog.getByRole('button', { name: '업그레이드', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(hostRow(page, 'dev-server')).toContainText('0.150.0');
  expect(await page.evaluate(() => window.hostCalls.filter(call => call.method === 'upgrade'))).toEqual([{ method: 'upgrade', id: 'host-1' }]);
});

test('SSH 접속 정보를 수정하고 원래 설정 버전으로 저장', async ({ page }) => {
  await installMock(page); await openHosts(page);
  await hostRow(page, 'dev-server').getByRole('button', { name: 'dev-server 호스트 정보', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '접속 정보 수정', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '호스트 수정', exact: true });
  await dialog.getByRole('textbox', { name: '호스트 주소', exact: true }).fill('192.0.2.11');
  await dialog.getByRole('spinbutton', { name: 'SSH 포트', exact: true }).fill('2200');
  await dialog.getByRole('button', { name: '저장', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(hostRow(page, 'dev-server')).toContainText('192.0.2.11');
  const calls = await page.evaluate(() => window.hostCalls.filter(call => call.method === 'save'));
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ revision: 'revision-1', draft: { id: 'host-1', hostPatterns: 'dev-server', hostName: '192.0.2.11', port: '2200', proxyJump: 'bastion' } });
});

test('호스트 삭제는 공통 목록 삭제 안내 이후 실행', async ({ page }) => {
  await installMock(page); await openHosts(page);
  await hostRow(page, 'dev-server').getByRole('button', { name: 'dev-server 호스트 정보', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '호스트 삭제', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: '호스트 삭제', exact: true });
  await expect(dialog).toContainText('remote-mgmt 목록에서도 삭제됩니다.');
  expect(await page.evaluate(() => window.hostCalls.filter(call => call.method === 'delete'))).toEqual([]);
  await dialog.getByRole('button', { name: '호스트 삭제', exact: true }).click();
  await expect(page.getByRole('table', { name: '호스트 목록', exact: true })).toContainText('등록된 호스트가 없습니다.');
  expect(await page.evaluate(() => window.hostCalls.filter(call => call.method === 'delete'))).toEqual([{ method: 'delete', id: 'host-1', revision: 'revision-1' }]);
});

test('좁은 창에서도 사이드바와 호스트 목록이 화면 밖으로 넘치지 않음', async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 800 });
  await page.goto('/?demo=1');
  await page.getByRole('button', { name: '호스트관리', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByRole('button', { name: '호스트 추가', exact: true })).toBeVisible();
  await hostRow(page, 'research-server').getByRole('button', { name: 'research-server 호스트 정보', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'research-server 호스트 정보', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('button', { name: '닫기', exact: true }).last()).toBeVisible();
});


test('조회 전 호스트는 호스트 메뉴 진입 때 한 번 조회', async ({ page }) => {
  await installMock(page, { unread: true });
  await page.goto('/');
  expect(await page.evaluate(() => window.hostCalls)).toEqual([]);
  await page.getByRole('button', { name: '호스트관리', exact: true }).click();
  await expect(hostRow(page, 'dev-server')).toContainText('0.149.0');
  expect(await page.evaluate(() => window.hostCalls.filter(call => call.method === 'refresh'))).toEqual([{ method: 'refresh', ids: ['host-1'] }]);
  await page.getByRole('button', { name: '계정관리', exact: true }).click();
  await page.getByRole('button', { name: '호스트관리', exact: true }).click();
  await expect(hostRow(page, 'dev-server')).toContainText('developer@example.com');
  expect(await page.evaluate(() => window.hostCalls.filter(call => call.method === 'refresh'))).toHaveLength(1);
});

test('SSH 설정 읽기 오류를 빈 목록과 함께 표시', async ({ page }) => {
  await installMock(page, { configError: true }); await openHosts(page);
  await expect(page.getByRole('alert')).toHaveText('SSH 설정 파일을 읽을 수 없습니다.');
  expect(await page.evaluate(() => window.hostCalls.filter(call => call.method === 'refresh'))).toEqual([]);
});

test('기존 개인 키의 공개 키 파일 생성 후 등록 버튼 활성화', async ({ page }) => {
  await installMock(page, { missingPublic: true }); await openHosts(page);
  await hostRow(page, 'dev-server').getByRole('button', { name: 'dev-server 호스트 정보', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'dev-server 호스트 정보', exact: true });
  await dialog.getByRole('tab', { name: '키 등록', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '미등록 시 등록', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: '공개 키 생성', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '미등록 시 등록', exact: true })).toBeEnabled();
  await expect(dialog).toContainText('SHA256:test-fingerprint');
  expect(await page.evaluate(() => window.hostCalls.filter(call => call.method === 'generate'))).toEqual([{ method: 'generate', id: 'host-1' }]);
});

test('호스트 목록과 상세 모달의 기본 창과 좁은 창 배치', async ({ page }) => {
  await page.setViewportSize({ width: 1340, height: 760 });
  await page.goto('/?demo=1');
  await page.getByRole('button', { name: '호스트관리', exact: true }).click();
  await expect(hostRow(page, 'dev-server')).toContainText('developer@example.com');
  await page.screenshot({ path: 'test-results/hosts-desktop.png', fullPage: true });
  await hostRow(page, 'dev-server').getByRole('button', { name: 'dev-server 호스트 정보', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'dev-server 호스트 정보', exact: true });
  await expect(dialog.getByRole('tab', { name: '접속 정보', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.getByRole('tabpanel', { name: '접속 정보', exact: true })).toContainText('developer@example.com');
  await expect(dialog.getByRole('button', { name: '닫기', exact: true }).last()).toBeVisible();
  await page.screenshot({ path: 'test-results/host-details-tabs-desktop.png', fullPage: true });
  await dialog.getByRole('tab', { name: '키 등록', exact: true }).click();
  await dialog.getByRole('button', { name: '등록 상태 조회', exact: true }).click();
  await expect(dialog.getByRole('region', { name: '서버에 등록된 키', exact: true })).toContainText('이 컴퓨터');
  await expect(dialog.getByRole('region', { name: '처리 결과', exact: true })).toContainText('등록 상태 조회 완료');
  const desktopKeys = await dialog.getByRole('region', { name: '서버에 등록된 키', exact: true }).boundingBox();
  const desktopResults = await dialog.getByRole('region', { name: '처리 결과', exact: true }).boundingBox();
  expect(desktopResults.x).toBeGreaterThan(desktopKeys.x + desktopKeys.width - 1);
  await expect(dialog.getByRole('region', { name: '처리 결과', exact: true }).getByRole('heading', { name: '처리 결과', exact: true })).toBeInViewport();
  await expect(dialog.getByRole('region', { name: '처리 결과', exact: true }).locator('li').first()).toBeInViewport();
  await page.screenshot({ path: 'test-results/host-keys-tabs-desktop.png', fullPage: true });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 880, height: 440 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/hosts-compact.png', fullPage: true });
  await hostRow(page, 'dev-server').getByRole('button', { name: 'dev-server 호스트 정보', exact: true }).click();
  await expect(dialog.getByRole('tab', { name: '접속 정보', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.getByRole('button', { name: '접속 정보 수정', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '닫기', exact: true }).last()).toBeVisible();
  await page.screenshot({ path: 'test-results/host-details-tabs-compact.png', fullPage: true });
  await dialog.getByRole('tab', { name: '키 등록', exact: true }).click();
  await dialog.getByRole('button', { name: '등록 상태 조회', exact: true }).click();
  await expect(dialog.getByRole('region', { name: '처리 결과', exact: true })).toContainText('등록 상태 조회 완료');
  await expect(dialog.getByRole('textbox', { name: '등록할 공개 키', exact: true })).toHaveValue(/ssh-ed25519/);
  const compactKeys = await dialog.getByRole('region', { name: '서버에 등록된 키', exact: true }).boundingBox();
  const compactResults = await dialog.getByRole('region', { name: '처리 결과', exact: true }).boundingBox();
  expect(compactResults.y).toBeGreaterThan(compactKeys.y + compactKeys.height - 1);
  await dialog.locator('.modal-body').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(dialog.getByRole('tablist')).toBeVisible();
  await expect(dialog.getByRole('button', { name: '닫기', exact: true }).last()).toBeVisible();
  const tabs = await dialog.getByRole('tablist').boundingBox();
  const footer = await dialog.getByRole('button', { name: '닫기', exact: true }).last().boundingBox();
  expect(tabs.y).toBeGreaterThanOrEqual(0);
  expect(tabs.y + tabs.height).toBeLessThanOrEqual(440);
  expect(footer.y + footer.height).toBeLessThanOrEqual(440);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/host-keys-tabs-compact.png' });
});

const longHostAlias = 'research-processing-production-cluster';
const longHostEmail = 'research.operations.administrator@example.organization.com';
const longHostError = 'SSH 연결이 거부되었습니다. production-workers.private.example.company의 2222 포트와 원격 서버의 SSH 설정을 확인하십시오. 재시도 전에 네트워크 연결과 서버 접근 권한을 확인하십시오.';

async function hostIds(page) {
  return page.getByRole('table', { name: '호스트 목록', exact: true }).locator('tbody > tr').evaluateAll(rows => rows.map(row => row.dataset.hostId));
}

async function dragBefore(page, sourceAlias, targetAlias) {
  const target = hostRow(page, targetAlias);
  await hostRow(page, sourceAlias).getByRole('button', { name: `${sourceAlias} 순서 변경`, exact: true }).dragTo(target, { targetPosition: { x: 50, y: 8 } });
}

test('긴 호스트 정보도 한 줄로 표시하고 성공 문구·조회 시각·플랜은 목록에서 제외', async ({ page }) => {
  await installMock(page, { compactRows: true });
  await page.setViewportSize({ width: 1340, height: 760 });
  await openHosts(page);
  const table = page.getByRole('table', { name: '호스트 목록', exact: true });
  await expect(table.getByRole('columnheader', { name: '접속 주소', exact: true })).toBeVisible();
  await expect(hostRow(page, longHostAlias)).toContainText('research-workers.internal.example.company');
  await expect(hostRow(page, longHostAlias)).toContainText(longHostEmail);
  await expect(table).not.toContainText('Codex 업그레이드 성공 표시 문구');
  await expect(table).not.toContainText('SSH 연결을 완료했습니다.');
  await expect(table).not.toContainText('2026-10-08');
  await expect(table).not.toContainText('03:10');
  await expect(table.getByText('Pro', { exact: true })).toHaveCount(0);
  await expect(table.getByText('Team', { exact: true })).toHaveCount(0);
  await expect(table.getByText('pro', { exact: true })).toHaveCount(0);
  await expect(table.getByText('team', { exact: true })).toHaveCount(0);
  await expect(table).not.toContainText(longHostError);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const desktopHeights = await table.locator('tbody > tr').evaluateAll(rows => rows.map(row => row.getBoundingClientRect().height));
  expect(desktopHeights).toHaveLength(3);
  expect(desktopHeights.every(height => height > 24 && height <= 50)).toBe(true);
  await page.screenshot({ path: 'test-results/hosts-single-line-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 880, height: 440 });
  const compactHeights = await table.locator('tbody > tr').evaluateAll(rows => rows.map(row => row.getBoundingClientRect().height));
  expect(compactHeights.every(height => height > 24 && height <= 50)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/hosts-single-line-compact.png' });
});

test('접속 실패 원인은 마우스와 키보드로 열고 Escape로 닫음', async ({ page }) => {
  await installMock(page, { compactRows: true });
  await page.setViewportSize({ width: 880, height: 440 });
  await openHosts(page);
  const button = hostRow(page, 'prod-server').getByRole('button', { name: 'prod-server 접속 실패 상세', exact: true });
  const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toBeHidden();
  await button.hover();
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText(longHostError);
  await expect(tooltip.getByText('접속 실패', { exact: true })).toBeVisible();
  await expect(button).toHaveAttribute('aria-describedby', await tooltip.getAttribute('id'));
  const bounds = await tooltip.boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(880);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(440);
  await page.screenshot({ path: 'test-results/host-error-popover-compact.png' });
  await page.mouse.move(10, 10);
  await expect(tooltip).toBeHidden();
  await button.focus();
  await expect(button).toBeFocused();
  await expect(tooltip).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(tooltip).toBeHidden();
  await expect(button).toBeFocused();
  await expect(page.getByRole('dialog')).toBeHidden();
});

test('드래그한 호스트 순서를 저장하고 앱 목록을 다시 열어도 유지', async ({ page }) => {
  await installMock(page, { compactRows: true }); await openHosts(page);
  expect(await hostIds(page)).toEqual(['host-1', 'host-2', 'host-3']);
  await dragBefore(page, 'backup-server', longHostAlias);
  await expect.poll(() => hostIds(page)).toEqual(['host-3', 'host-1', 'host-2']);
  expect(await page.evaluate(() => window.hostCalls.filter(call => call.method === 'reorder'))).toEqual([{ method: 'reorder', ids: ['host-3', 'host-1', 'host-2'], revision: 'revision-1' }]);
  expect(await page.evaluate(() => window.hostCalls.filter(call => call.method === 'details'))).toEqual([]);
  await page.getByRole('button', { name: '계정관리', exact: true }).click();
  await page.getByRole('button', { name: '호스트관리', exact: true }).click();
  expect(await hostIds(page)).toEqual(['host-3', 'host-1', 'host-2']);
  await page.reload();
  await page.getByRole('button', { name: '호스트관리', exact: true }).click();
  await expect.poll(() => hostIds(page)).toEqual(['host-3', 'host-1', 'host-2']);
  expect(await page.evaluate(() => window.hostCalls.filter(call => call.method === 'reorder'))).toEqual([]);
});

test('순서 저장이 실패하면 원래 목록을 복원하고 실패 문구 표시', async ({ page }) => {
  await installMock(page, { compactRows: true, reorderFails: true }); await openHosts(page);
  await dragBefore(page, 'backup-server', longHostAlias);
  await expect(page.getByRole('alert')).toContainText('호스트 순서를 저장하지 못했습니다.');
  expect(await hostIds(page)).toEqual(['host-1', 'host-2', 'host-3']);
  expect(await page.evaluate(() => window.hostCalls.filter(call => call.method === 'reorder'))).toEqual([{ method: 'reorder', ids: ['host-3', 'host-1', 'host-2'], revision: 'revision-1' }]);
  await expect(hostRow(page, 'backup-server').getByRole('button', { name: 'backup-server 순서 변경', exact: true })).toBeEnabled();
  await page.reload();
  await page.getByRole('button', { name: '호스트관리', exact: true }).click();
  expect(await hostIds(page)).toEqual(['host-1', 'host-2', 'host-3']);
});

test('키보드 위·아래 화살표로 호스트 순서를 바꾸고 포커스를 유지', async ({ page }) => {
  await installMock(page, { compactRows: true }); await openHosts(page);
  const handle = hostRow(page, 'prod-server').getByRole('button', { name: 'prod-server 순서 변경', exact: true });
  await handle.focus();
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => hostIds(page)).toEqual(['host-2', 'host-1', 'host-3']);
  await expect(handle).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => hostIds(page)).toEqual(['host-1', 'host-2', 'host-3']);
  await expect(handle).toBeFocused();
  expect(await page.evaluate(() => window.hostCalls.filter(call => call.method === 'reorder'))).toEqual([
    { method: 'reorder', ids: ['host-2', 'host-1', 'host-3'], revision: 'revision-1' },
    { method: 'reorder', ids: ['host-1', 'host-2', 'host-3'], revision: 'revision-1' },
  ]);
  expect(await page.evaluate(() => window.hostCalls.filter(call => call.method === 'details'))).toEqual([]);
  await expect(page.getByRole('dialog')).toBeHidden();
});
