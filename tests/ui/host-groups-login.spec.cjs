const { test, expect } = require('@playwright/test');
const table = page => page.getByRole('table', { name: '호스트 목록', exact: true });
const row = (page, alias) => table(page).locator('tbody > tr[data-host-id]').filter({ has: page.getByRole('button', { name: `${alias} 호스트 정보`, exact: true }) });
const groupRow = (page, id) => table(page).locator(`tr[data-group-id="${id || ''}"]`);
const ids = page => table(page).locator('tbody > tr[data-host-id]').evaluateAll(rows => rows.map(row => row.dataset.hostId));

async function installMock(page, options = {}) {
  await page.addInitScript(({ grouped = false, moveFails = false, groupConflict = false }) => {
    window.hostCalls = [];
    const listeners = new Set();
    const base = { connectable: true, port: '22', user: 'ubuntu', proxyJump: '', identityFile: '', connection: { status: 'online', checkedAt: '2026-10-08T00:00:00Z' }, codex: { available: true, version: '0.149.0', accountEmail: 'old@example.com', loginStatus: 'chatgpt' } };
    let state = JSON.parse(localStorage.getItem('host-tree-test-state') || 'null') || {
      configPath: '/example/ssh/config', revision: 'rev-1', refresh: { running: false },
      groups: grouped ? [{ id: 'group-1', name: '개발 서버', collapsed: false }, { id: 'group-2', name: '운영 서버', collapsed: false }] : [],
      hosts: [
        { ...structuredClone(base), id: 'host-1', alias: 'dev-server', hostPatterns: 'dev-server', hostName: '192.0.2.10', groupId: grouped ? 'group-1' : null },
        { ...structuredClone(base), id: 'host-2', alias: 'prod-server', hostPatterns: 'prod-server', hostName: '192.0.2.20', groupId: grouped ? 'group-2' : null },
        { ...structuredClone(base), id: 'host-3', alias: 'backup-server', hostPatterns: 'backup-server', hostName: '192.0.2.30', groupId: null },
      ],
    };
    let serial = Number(state.revision.replace('rev-', '')), conflict = groupConflict;
    const snapshot = () => structuredClone(state);
    const emit = () => { listeners.forEach(callback => callback(snapshot())); return snapshot(); };
    const persist = () => { state.revision = `rev-${++serial}`; localStorage.setItem('host-tree-test-state', JSON.stringify({ ...state, hosts: state.hosts.map(({ login, ...host }) => host) })); return emit(); };
    const check = revision => { if (revision !== state.revision) throw new Error('호스트 목록이 변경되었습니다. 다시 저장하십시오.'); };
    const host = id => state.hosts.find(host => host.id === id);
    const order = ids => { const hosts = new Map(state.hosts.map(item => [item.id, item])); state.hosts = ids.map(id => hosts.get(id)); };
    window.accountManager = { getState: async () => ({ accounts: [], runtime: { available: true }, refresh: { running: false } }), onState: () => () => {} };
    window.hostTreeSnapshot = snapshot;
    window.removeMockHost = id => { state.hosts = state.hosts.filter(item => item.id !== id); return emit(); };
    window.changeHostLogin = (id, status, fields = {}) => {
      host(id).login = { attemptId: host(id).login?.attemptId || 'attempt-1', status, ...fields };
      if (status === 'completed') host(id).codex.accountEmail = fields.accountEmail;
      return emit();
    };
    window.hostManager = {
      getState: async () => snapshot(), onState: callback => { listeners.add(callback); return () => listeners.delete(callback); }, reloadHosts: async () => emit(),
      refreshHosts: async () => emit(), cancelRefresh: async () => emit(),
      getHostDetails: async id => ({ host: structuredClone(host(id)), effective: { ...host(id) }, key: {} }),
      saveHost: async (draft, revision) => { check(revision); window.hostCalls.push({ method: 'saveHost', revision, draft }); Object.assign(host(draft.id), draft); return persist(); },
      saveGroup: async (draft, revision) => {
        window.hostCalls.push({ method: 'saveGroup', revision, draft }); check(revision);
        if (conflict) { conflict = false; state.groups.push({ id: 'external-group', name: '외부 그룹', collapsed: false }); persist(); throw new Error('호스트 목록이 변경되었습니다. 다시 저장하십시오.'); }
        if (draft.id) state.groups.find(group => group.id === draft.id).name = draft.name;
        else state.groups.push({ id: `group-${state.groups.length + 1}`, name: draft.name, collapsed: false });
        return persist();
      },
      deleteGroup: async (id, revision) => { check(revision); window.hostCalls.push({ method: 'deleteGroup', id, revision }); state.groups = state.groups.filter(group => group.id !== id); state.hosts.forEach(item => { if (item.groupId === id) item.groupId = null; }); return persist(); },
      setGroupCollapsed: async (id, collapsed, revision) => { check(revision); window.hostCalls.push({ method: 'collapse', id, collapsed, revision }); state.groups.find(group => group.id === id).collapsed = collapsed; return persist(); },
      moveHostToGroup: async (id, groupId, revision, ids) => { check(revision); window.hostCalls.push({ method: 'move', id, groupId, revision, ids }); if (moveFails) throw new Error('호스트 그룹을 변경하지 못했습니다.'); host(id).groupId = groupId; if (ids) order(ids); return persist(); },
      reorderHosts: async (ids, revision) => { check(revision); window.hostCalls.push({ method: 'order', ids, revision }); order(ids); return persist(); },
      startCodexLogin: async id => { window.hostCalls.push({ method: 'startLogin', id }); host(id).login = { attemptId: 'attempt-1', status: 'waiting', url: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234' }; return emit(); },
      openCodexLogin: async id => { window.hostCalls.push({ method: 'openLogin', id }); return true; },
      copyCodexLoginCode: async id => { window.hostCalls.push({ method: 'copyLoginCode', id }); return true; },
      cancelCodexLogin: async id => { window.hostCalls.push({ method: 'cancelLogin', id }); host(id).login = { attemptId: 'attempt-1', status: 'canceled' }; return emit(); },
    };
  }, options);
}
async function openHosts(page) { await page.goto('/'); await page.getByRole('button', { name: '호스트관리', exact: true }).click(); await expect(table(page)).toBeVisible(); }
async function addGroup(page, name) { await page.getByRole('button', { name: '그룹 추가', exact: true }).click(); const dialog = page.getByRole('dialog', { name: '그룹 추가', exact: true }); await dialog.getByRole('textbox', { name: '그룹 이름', exact: true }).fill(name); await dialog.getByRole('button', { name: '저장', exact: true }).click(); await expect(dialog).toBeHidden(); }
async function openLogin(page) { await row(page, 'dev-server').getByRole('button', { name: '계정 전환', exact: true }).click(); return page.getByRole('dialog', { name: 'Codex 계정 전환', exact: true }); }

test.beforeEach(async ({ page }) => { page.uiErrors = []; page.on('pageerror', error => page.uiErrors.push(error.message)); });
test.afterEach(async ({ page }) => expect(page.uiErrors).toEqual([]));

test('그룹을 추가·수정하고 호스트를 배정하며 접기 상태를 다시 열어도 유지', async ({ page }) => {
  await installMock(page); await openHosts(page); await addGroup(page, '개발');
  await groupRow(page, 'group-1').getByRole('button', { name: '개발 그룹 이름 변경', exact: true }).click();
  const form = page.getByRole('dialog', { name: '그룹 이름 변경', exact: true });
  await form.getByRole('textbox', { name: '그룹 이름', exact: true }).fill('개발 서버'); await form.getByRole('button', { name: '저장', exact: true }).click();
  await row(page, 'dev-server').getByRole('button', { name: 'dev-server 호스트 정보', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '접속 정보 수정', exact: true }).click();
  const hostForm = page.getByRole('dialog', { name: '호스트 수정', exact: true });
  await hostForm.getByRole('combobox', { name: '그룹', exact: true }).selectOption('group-1'); await hostForm.getByRole('button', { name: '저장', exact: true }).click();
  await expect(groupRow(page, 'group-1')).toContainText('1개'); await expect(groupRow(page, null)).toContainText('2개');
  await groupRow(page, 'group-1').getByRole('button', { name: '개발 서버 접기', exact: true }).click(); await expect(row(page, 'dev-server')).toBeHidden();
  await page.reload(); await page.getByRole('button', { name: '호스트관리', exact: true }).click();
  await expect(row(page, 'dev-server')).toBeHidden();
  await groupRow(page, 'group-1').getByRole('button', { name: '개발 서버 펼치기', exact: true }).click(); await expect(row(page, 'dev-server')).toBeVisible();
  await groupRow(page, 'group-1').getByRole('button', { name: '개발 서버 그룹 삭제', exact: true }).click();
  const deletion = page.getByRole('alertdialog', { name: '그룹 삭제', exact: true }); await expect(deletion).toContainText('호스트는 유지');
  await deletion.getByRole('button', { name: '그룹 삭제', exact: true }).click();
  await expect.poll(() => ids(page)).toEqual(['host-1', 'host-2', 'host-3']); await expect(table(page).locator('[data-group-id]')).toHaveCount(0);
  expect(await page.evaluate(() => window.hostTreeSnapshot().hosts.every(host => host.groupId === null))).toBe(true);
});

test('폴더와 다른 그룹의 호스트 행으로 드래그하여 이동하고 같은 그룹 안에서 키보드로 정렬', async ({ page }) => {
  await installMock(page, { grouped: true }); await openHosts(page);
  await row(page, 'backup-server').getByRole('button', { name: 'backup-server 순서 변경', exact: true }).dragTo(groupRow(page, 'group-1'));
  await expect.poll(() => ids(page)).toEqual(['host-1', 'host-3', 'host-2']);
  expect(await page.evaluate(() => window.hostTreeSnapshot().hosts.find(host => host.id === 'host-3').groupId)).toBe('group-1');
  const handle = row(page, 'backup-server').getByRole('button', { name: 'backup-server 순서 변경', exact: true }); await handle.focus(); await page.keyboard.press('ArrowUp');
  await expect.poll(() => ids(page)).toEqual(['host-3', 'host-1', 'host-2']); await expect(handle).toBeFocused();
  await handle.dragTo(row(page, 'prod-server'), { targetPosition: { x: 50, y: 8 } }); await expect.poll(() => ids(page)).toEqual(['host-1', 'host-3', 'host-2']);
  expect(await page.evaluate(() => window.hostTreeSnapshot().hosts.find(host => host.id === 'host-3').groupId)).toBe('group-2');
  await row(page, 'backup-server').getByRole('button', { name: 'backup-server 순서 변경', exact: true }).dragTo(groupRow(page, null));
  expect(await page.evaluate(() => window.hostTreeSnapshot().hosts.find(host => host.id === 'host-3').groupId)).toBeNull();
  const calls = await page.evaluate(() => window.hostCalls.filter(call => ['move', 'order'].includes(call.method)));
  expect(calls.map(call => call.revision)).toEqual(['rev-1', 'rev-2', 'rev-3', 'rev-4']);
});

test('그룹 저장 충돌은 목록을 다시 읽고 입력 내용을 유지하여 최신 설정으로 다시 저장', async ({ page }) => {
  await installMock(page, { groupConflict: true }); await openHosts(page);
  await page.getByRole('button', { name: '그룹 추가', exact: true }).click(); const form = page.getByRole('dialog', { name: '그룹 추가', exact: true });
  await form.getByRole('textbox', { name: '그룹 이름', exact: true }).fill('개발 서버'); await form.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('호스트 목록이 변경되었습니다.'); await expect(form.getByRole('textbox')).toHaveValue('개발 서버');
  await form.getByRole('button', { name: '저장', exact: true }).click(); await expect(form).toBeHidden();
  await expect(table(page)).toContainText('외부 그룹'); await expect(table(page)).toContainText('개발 서버');
  expect(await page.evaluate(() => window.hostCalls.filter(call => call.method === 'saveGroup').map(call => call.revision))).toEqual(['rev-1', 'rev-2']);
});

test('그룹 이동 실패는 호스트 배정을 유지하고 오류를 표시', async ({ page }) => {
  await installMock(page, { grouped: true, moveFails: true }); await openHosts(page);
  await row(page, 'backup-server').getByRole('button', { name: 'backup-server 순서 변경', exact: true }).dragTo(groupRow(page, 'group-1'));
  await expect(page.getByRole('alert')).toContainText('호스트 그룹을 변경하지 못했습니다.'); expect(await page.evaluate(() => window.hostTreeSnapshot().hosts.find(host => host.id === 'host-3').groupId)).toBeNull();
  await expect(row(page, 'backup-server').getByRole('button', { name: 'backup-server 순서 변경', exact: true })).toBeEnabled();
});

test('기기 인증은 로그인 시작을 누른 뒤만 요청하며 페이지 열기·코드 복사 후 인증 계정을 표시', async ({ page }) => {
  await installMock(page); await openHosts(page); const dialog = await openLogin(page);
  await expect(dialog).toContainText('dev-server'); await expect(dialog).toContainText('192.0.2.10');
  expect(await page.evaluate(() => window.hostCalls.filter(call => call.method === 'startLogin'))).toEqual([]);
  await dialog.getByRole('button', { name: '로그인 시작', exact: true }).click(); await expect(dialog).toContainText('ABCD-1234'); await expect(dialog).toContainText('브라우저 인증을 기다리고 있습니다.');
  await dialog.getByRole('button', { name: '로그인 페이지 열기', exact: true }).click(); await dialog.getByRole('button', { name: '인증 코드 복사', exact: true }).click(); await expect(dialog.getByRole('button', { name: '복사 완료', exact: true })).toBeVisible();
  await page.evaluate(() => window.changeHostLogin('host-1', 'verifying')); await expect(dialog).toContainText('로그인 계정을 조회하고 있습니다.');
  await page.evaluate(() => window.changeHostLogin('host-1', 'completed', { accountEmail: 'new@example.com' })); await expect(dialog).toContainText('계정 전환 완료'); await expect(dialog).toContainText('new@example.com'); await expect(dialog).not.toContainText('ABCD-1234');
  await expect(dialog.getByRole('button', { name: '로그인 시작', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: '로그인 시작', exact: true }).click(); await expect(dialog).toContainText('ABCD-1234');
  await dialog.getByRole('button', { name: '로그인 취소', exact: true }).click(); await expect(dialog).toContainText('로그인이 취소되었습니다.');
  await dialog.getByRole('button', { name: '닫기', exact: true }).last().click(); await expect(row(page, 'dev-server')).toContainText('new@example.com');
  expect(await page.evaluate(() => window.hostCalls.filter(call => ['startLogin', 'openLogin', 'copyLoginCode'].includes(call.method)))).toEqual([{ method: 'startLogin', id: 'host-1' }, { method: 'openLogin', id: 'host-1' }, { method: 'copyLoginCode', id: 'host-1' }, { method: 'startLogin', id: 'host-1' }]);
});

test('진행 중인 기기 인증을 취소하거나 모달을 닫으면 인증을 중지하고 기존 계정을 유지', async ({ page }) => {
  await installMock(page); await openHosts(page); let dialog = await openLogin(page); await dialog.getByRole('button', { name: '로그인 시작', exact: true }).click();
  await dialog.getByRole('button', { name: '로그인 취소', exact: true }).click(); await expect(dialog).toContainText('로그인이 취소되었습니다.'); await expect(dialog).not.toContainText('ABCD-1234');
  await dialog.getByRole('button', { name: '로그인 시작', exact: true }).click(); await page.keyboard.press('Escape'); await expect(dialog).toBeHidden(); await expect(row(page, 'dev-server')).toContainText('old@example.com');
  expect(await page.evaluate(() => window.hostCalls.filter(call => call.method === 'cancelLogin'))).toHaveLength(2);
});

test('계정관리로 이동하면 진행 중인 호스트 기기 인증을 취소', async ({ page }) => {
  await installMock(page); await openHosts(page); const dialog = await openLogin(page); await dialog.getByRole('button', { name: '로그인 시작', exact: true }).click();
  await page.getByRole('button', { name: '계정관리', exact: true }).evaluate(button => button.click());
  await expect(page.getByRole('table', { name: '계정 목록', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.hostCalls.filter(call => call.method === 'cancelLogin'))).toEqual([{ method: 'cancelLogin', id: 'host-1' }]);
  await page.getByRole('button', { name: '호스트관리', exact: true }).click(); await expect(row(page, 'dev-server')).toContainText('old@example.com');
  await row(page, 'dev-server').getByRole('button', { name: '계정 전환', exact: true }).click(); await expect(dialog).toContainText('로그인이 취소되었습니다.');
});

test('기기 인증 실패는 오류와 다시 시작 버튼을 표시하고 다른 호스트 계정을 유지', async ({ page }) => {
  await installMock(page); await openHosts(page); const dialog = await openLogin(page); await dialog.getByRole('button', { name: '로그인 시작', exact: true }).click();
  await page.evaluate(() => window.changeHostLogin('host-1', 'error', { error: '기기 인증 시간이 만료되었습니다.' }));
  await expect(dialog.getByRole('alert')).toHaveText('기기 인증 시간이 만료되었습니다.'); await expect(dialog.getByRole('button', { name: '로그인 시작', exact: true })).toBeEnabled(); await expect(dialog).not.toContainText('ABCD-1234');
  await dialog.getByRole('button', { name: '로그인 시작', exact: true }).click(); await expect(dialog).toContainText('ABCD-1234'); await expect(dialog.getByRole('alert')).toBeHidden();
  await dialog.getByRole('button', { name: '취소하고 닫기', exact: true }).click(); await expect(row(page, 'prod-server')).toContainText('old@example.com');
});

test('그룹 행과 작업 버튼은 좁은 창에서 스크롤로 접근하고 호스트 행은 한 줄 유지', async ({ page }) => {
  await installMock(page, { grouped: true }); await page.setViewportSize({ width: 880, height: 440 }); await openHosts(page);
  const heights = await table(page).locator('tr[data-host-id]').evaluateAll(rows => rows.map(row => row.getBoundingClientRect().height)); expect(heights.every(height => height <= 50)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await table(page).locator('tbody').evaluate(element => { element.closest('.table-scroll').scrollLeft = element.closest('.table-scroll').scrollWidth; });
  await expect(row(page, 'dev-server').getByRole('button', { name: '계정 전환', exact: true })).toBeInViewport();
  await page.screenshot({ path: 'test-results/host-tree-compact.png' });
  await openLogin(page); await expect(page.getByRole('dialog')).toContainText('기기 인증'); await expect(page.getByRole('dialog').getByRole('button', { name: '로그인 시작', exact: true })).toBeInViewport();
});

test('로그인 대상이 외부 설정에서 삭제되면 다른 호스트의 상세 정보로 대체하지 않음', async ({ page }) => {
  await installMock(page); await openHosts(page);
  await row(page, 'prod-server').getByRole('button', { name: 'prod-server 호스트 정보', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '닫기', exact: true }).last().click();
  const login = await openLogin(page); await expect(login).toContainText('dev-server');
  await page.evaluate(() => window.removeMockHost('host-1'));
  await expect(login).toBeHidden(); await expect(row(page, 'prod-server')).toContainText('old@example.com');
  expect(await page.evaluate(() => window.hostCalls.filter(call => call.method === 'startLogin'))).toEqual([]);
});
