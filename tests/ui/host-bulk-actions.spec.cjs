const { test, expect } = require('@playwright/test');

const hostTable = page => page.getByRole('table', { name: '호스트 목록', exact: true });
const hostRow = (page, alias) => hostTable(page).locator('tbody > tr[data-host-id]').filter({ has: page.getByRole('button', { name: `${alias} 호스트 정보`, exact: true }) });
const selection = (page, alias) => hostRow(page, alias).getByRole('checkbox', { name: `${alias} 선택`, exact: true });
const selectAll = page => page.getByRole('checkbox', { name: '전체 호스트 선택', exact: true });
const selectedUpgrade = page => page.getByRole('button', { name: '선택 업그레이드', exact: true });
const selectedDelete = page => page.getByRole('button', { name: '선택 삭제', exact: true });
const refreshButton = page => page.getByRole('button', { name: '새로고침', exact: true });
const selectedList = dialog => dialog.getByRole('region', { name: '선택 호스트 목록', exact: true });
const upgradeDialog = page => page.getByRole('alertdialog', { name: '선택 호스트 업그레이드', exact: true });
const deletionDialog = page => page.getByRole('alertdialog', { name: '선택 호스트 삭제', exact: true });
const hostIds = page => hostTable(page).locator('tbody > tr[data-host-id]').evaluateAll(rows => rows.map(row => row.dataset.hostId));
async function expectNoSelection(page) {
  await expect(selectedUpgrade(page)).toBeHidden(); await expect(selectedDelete(page)).toBeHidden();
  await expect(page.getByText('0개 선택', { exact: true })).toBeHidden();
}

async function installMock(page, options = {}) {
  await page.addInitScript(({ collapsed = false, deletionConflict = false, commonSetting = false, reuseDeletedIds = false, delayedRefresh = false, reloadFailsFirst = false, emptyHosts = false, restoredBatch = false }) => {
    const listeners = new Set();
    const base = { connectable: true, port: '22', user: 'operator', proxyJump: '', identityFile: '', connection: { status: 'online' }, operation: { type: null, running: false, status: 'idle', message: '' }, codex: { available: true, version: '0.149.0', accountEmail: 'operator@example.invalid', loginStatus: 'chatgpt' } };
    let state = {
      configPath: '/fixture/ssh/config', revision: 'rev-1', groups: [{ id: 'group-dev', name: '개발 서버', collapsed }, { id: 'group-backup', name: '백업 서버', collapsed: false }], refresh: { running: false }, batchUpgrade: { running: false, hostIds: [] },
      hosts: [
        { ...structuredClone(base), id: 'host-1', alias: 'dev-server', hostPatterns: 'dev-server', hostName: '192.0.2.10', groupId: 'group-dev' },
        { ...structuredClone(base), id: 'host-2', alias: 'prod-server', hostPatterns: 'prod-server', hostName: '192.0.2.20', groupId: 'group-dev' },
        { ...structuredClone(base), id: 'host-3', alias: 'backup-server', hostPatterns: 'backup-server', hostName: '192.0.2.30', groupId: 'group-backup' },
        { ...structuredClone(base), id: 'host-4', alias: 'gpu-server', hostPatterns: 'gpu-server', hostName: '192.0.2.40', groupId: null },
      ],
    };
    if (commonSetting) state.hosts.push({ ...structuredClone(base), id: 'host-common', alias: '*', hostPatterns: '*', hostName: '', connectable: false, groupId: null });
    if (emptyHosts) state.hosts = [];
    if (restoredBatch) {
      state.batchUpgrade = { running: true, hostIds: ['host-1', 'host-2'] };
      state.hosts[0].codex.version = '0.161.0';
      state.hosts[0].operation = { type: 'upgradeCodex', running: false, status: 'completed' };
      state.hosts[1].operation = { type: 'upgradeCodex', running: true, status: 'running' };
    }
    let serial = 1; let conflict = deletionConflict; let batch = restoredBatch ? { ids: ['host-1', 'host-2'], resolve: () => {}, results: new Map([['host-1', { id: 'host-1', success: true }]]) } : null; let deletion; let reload; let refresh; let reloadFailure = reloadFailsFirst;
    const snapshot = () => structuredClone(state);
    const emit = () => { for (const listener of listeners) listener(snapshot()); return snapshot(); };
    const persist = () => { state.revision = `rev-${++serial}`; return emit(); };
    const host = id => state.hosts.find(item => item.id === id);
    const check = revision => { if (state.revision !== revision) throw new Error('호스트 목록이 변경되었습니다. 다시 시도하십시오.'); };
    const order = ids => { const rows = new Map(state.hosts.map(item => [item.id, item])); state.hosts = ids.map(id => rows.get(id)); };
    window.hostBulkCalls = [];
    window.hostBulkSnapshot = snapshot;
    window.finishHostBulkReload = (includeLatest = false) => {
      if (!reload) throw new Error('No fixture reload');
      const current = reload; reload = null;
      if (reloadFailure) {
        const mode = reloadFailure; reloadFailure = false;
        if (mode === 'snapshot') { state.error = 'SSH 설정 파일을 읽을 수 없습니다.'; current.resolve(emit()); }
        else current.reject(new Error('SSH 설정 파일을 읽을 수 없습니다.'));
        return;
      }
      state.error = null;
      if (includeLatest) {
        state.hosts = state.hosts.filter(item => item.id !== 'host-1');
        state.hosts.push({ ...structuredClone(base), id: 'host-latest', alias: 'latest-server', hostPatterns: 'latest-server', hostName: '192.0.2.60', groupId: null });
      }
      current.resolve(persist());
    };
    window.finishHostBulkRefresh = () => {
      if (!refresh) throw new Error('No fixture refresh');
      const current = refresh; refresh = null;
      for (const id of current.ids) {
        host(id).connection = { status: 'online' };
        host(id).codex.version = '0.162.0';
      }
      state.refresh = { running: false, completed: current.ids.length, total: current.ids.length };
      current.resolve(emit());
    };
    window.removeHostBulkFixture = id => { state.hosts = state.hosts.filter(item => item.id !== id); return persist(); };
    window.changeHostBulkOperation = (id, operation) => { host(id).operation = operation; return emit(); };
    window.completeHostBulkUpgrade = (id, success, error = '설치 권한이 없어 업그레이드를 완료하지 못했습니다.') => {
      if (!batch || !batch.ids.includes(id)) throw new Error('No matching fixture upgrade');
      const item = host(id);
      if (success) item.codex.version = '0.161.0';
      item.operation = { type: 'upgradeCodex', running: false, status: success ? 'completed' : 'error', message: success ? '업그레이드를 완료했습니다.' : error, ...(success ? {} : { error }) };
      batch.results.set(id, { id, success, ...(success ? { version: '0.161.0' } : { error }) });
      return emit();
    };
    window.finishHostBulkUpgrade = () => {
      if (!batch || batch.results.size !== batch.ids.length) throw new Error('Finish each fixture host first');
      const current = batch; batch = null;
      state.batchUpgrade = { running: false, hostIds: [] }; emit();
      current.resolve({ state: snapshot(), results: current.ids.map(id => current.results.get(id)) });
    };
    window.finishHostBulkDelete = () => {
      if (!deletion) throw new Error('No fixture deletion');
      const current = deletion; deletion = null;
      const removed = state.hosts.filter(item => current.ids.includes(item.id));
      state.hosts = state.hosts.filter(item => !current.ids.includes(item.id));
      // Removing an earlier duplicate Host block can assign its parser ID to
      // the next block. The replacement has the same ID and SSH alias, but
      // points to a different server and must not inherit its selection.
      if (reuseDeletedIds) state.hosts.push(...removed.map(item => ({ ...item, hostName: '192.0.2.110', codex: { ...item.codex, accountEmail: 'replacement@example.invalid' } })));
      current.resolve(persist());
    };
    window.accountManager = { getState: async () => ({ accounts: [], runtime: { available: true }, refresh: { running: false } }), onState: () => () => {} };
    window.hostManager = {
      getState: async () => snapshot(), onState: callback => { listeners.add(callback); return () => listeners.delete(callback); },
      reloadHosts: async () => {
        window.hostBulkCalls.push({ method: 'reload' });
        if (!delayedRefresh) return emit();
        return new Promise((resolve, reject) => { reload = { resolve, reject }; });
      },
      refreshHosts: async ids => {
        const targets = ids || state.hosts.filter(item => item.connectable !== false).map(item => item.id);
        window.hostBulkCalls.push({ method: 'refresh', targetIds: [...targets] });
        if (!delayedRefresh) return emit();
        const pending = new Promise(resolve => { refresh = { resolve, ids: [...targets] }; });
        state.refresh = { running: true, completed: 0, total: targets.length }; emit();
        return pending;
      },
      cancelRefresh: async () => emit(),
      getHostDetails: async id => ({ host: structuredClone(host(id)), effective: { ...host(id) }, key: {} }),
      setGroupCollapsed: async (id, value, revision) => { check(revision); state.groups.find(group => group.id === id).collapsed = value; return persist(); },
      reorderHosts: async (ids, revision) => { check(revision); window.hostBulkCalls.push({ method: 'reorder', ids, revision }); order(ids); return persist(); },
      moveHostToGroup: async (id, groupId, revision, ids) => { check(revision); host(id).groupId = groupId; if (ids) order(ids); return persist(); },
      upgradeCodex: async id => { window.hostBulkCalls.push({ method: 'upgradeSingle', id }); return { message: 'Fixture upgrade only' }; },
      upgradeCodexBatch: ids => {
        window.hostBulkCalls.push({ method: 'upgradeBatch', ids: [...ids] });
        if (batch) throw new Error('Another fixture batch is running');
        const pending = new Promise(resolve => { batch = { ids: [...ids], resolve, results: new Map() }; });
        state.batchUpgrade = { running: true, hostIds: [...ids] };
        for (const id of ids) host(id).operation = { type: 'upgradeCodex', running: true, status: 'running', message: '' };
        emit();
        return pending;
      },
      deleteHosts: async (ids, revision) => {
        window.hostBulkCalls.push({ method: 'deleteHosts', ids: [...ids], revision }); check(revision);
        if (conflict) {
          conflict = false;
          state.hosts.push({ ...structuredClone(base), id: 'host-external', alias: 'external-server', hostPatterns: 'external-server', hostName: '192.0.2.50', groupId: null });
          persist();
          throw new Error('호스트 목록이 변경되었습니다. 다시 시도하십시오.');
        }
        return new Promise(resolve => { deletion = { ids: [...ids], resolve }; });
      },
      deleteHost: async (id, revision) => {
        window.hostBulkCalls.push({ method: 'deleteSingle', id, revision });
        if (!reuseDeletedIds) throw new Error('Unexpected single deletion');
        check(revision);
        return new Promise(resolve => { deletion = { ids: [id], resolve }; });
      },
      startCodexLogin: async id => { window.hostBulkCalls.push({ method: 'startLogin', id }); throw new Error('Unexpected login'); },
    };
  }, options);
}

async function openHosts(page) {
  await page.goto('/');
  await page.getByRole('button', { name: '호스트관리', exact: true }).click();
  await expect(hostTable(page)).toBeVisible();
}

test.beforeEach(async ({ page }) => { page.uiErrors = []; page.on('pageerror', error => page.uiErrors.push(error.message)); });
test.afterEach(async ({ page }) => expect(page.uiErrors).toEqual([]));

test('개별 선택과 전체 선택을 표시하고 일부 선택은 중간 상태로 구분', async ({ page }) => {
  await installMock(page); await openHosts(page);
  await expectNoSelection(page);
  await selection(page, 'dev-server').check();
  await expect(selection(page, 'dev-server')).toBeChecked(); await expect(selectAll(page)).not.toBeChecked();
  expect(await selectAll(page).evaluate(input => input.indeterminate)).toBe(true);
  await expect(page.getByRole('dialog')).toBeHidden(); await expect(selectedUpgrade(page)).toBeEnabled();
  await selectAll(page).check();
  await expect(selectAll(page)).toBeChecked();
  for (const alias of ['dev-server', 'prod-server', 'backup-server', 'gpu-server']) await expect(selection(page, alias)).toBeChecked();
  expect(await selectAll(page).evaluate(input => input.indeterminate)).toBe(false);
  await selection(page, 'prod-server').uncheck();
  expect(await selectAll(page).evaluate(input => input.indeterminate)).toBe(true);
  await selectAll(page).check(); await selectAll(page).uncheck();
  await expectNoSelection(page);
});

test('새로고침은 목록을 먼저 읽고 최신 호스트를 한 번 조회하며 처리 중 반복 실행을 차단', async ({ page }) => {
  await installMock(page, { delayedRefresh: true }); await openHosts(page);
  await expect(page.getByRole('button', { name: '목록 새로고침', exact: true })).toBeHidden();
  await expect(page.getByRole('button', { name: '전체 조회', exact: true })).toBeHidden();
  await refreshButton(page).evaluate(button => { button.click(); button.click(); });
  await expect(refreshButton(page)).toBeDisabled();
  expect(await page.evaluate(() => window.hostBulkCalls)).toEqual([{ method: 'reload' }]);
  await refreshButton(page).evaluate(button => button.click());
  expect(await page.evaluate(() => window.hostBulkCalls)).toEqual([{ method: 'reload' }]);
  await page.evaluate(() => window.finishHostBulkReload(true));
  await expect(hostRow(page, 'latest-server')).toBeVisible(); await expect(hostRow(page, 'dev-server')).toBeHidden();
  await expect(refreshButton(page)).toBeDisabled();
  expect(await page.evaluate(() => window.hostBulkCalls)).toEqual([{ method: 'reload' }, { method: 'refresh', targetIds: ['host-2', 'host-3', 'host-4', 'host-latest'] }]);
  await refreshButton(page).evaluate(button => button.click());
  expect(await page.evaluate(() => window.hostBulkCalls.filter(call => call.method === 'refresh'))).toHaveLength(1);
  await page.evaluate(() => window.finishHostBulkRefresh());
  await expect(refreshButton(page)).toBeEnabled(); await expect(hostRow(page, 'latest-server')).toContainText('0.162.0');
});

for (const mode of ['throw', 'snapshot']) {
  test(`새로고침의 ${mode === 'throw' ? '목록 읽기 오류' : '설정 오류 응답'}는 호스트 조회를 시작하지 않고 다시 시도 가능`, async ({ page }) => {
    await installMock(page, { delayedRefresh: true, reloadFailsFirst: mode }); await openHosts(page);
    await refreshButton(page).click(); await expect(refreshButton(page)).toBeDisabled();
    await page.evaluate(() => window.finishHostBulkReload());
    await expect(page.getByRole('alert').filter({ hasText: 'SSH 설정 파일을 읽을 수 없습니다.' }).first()).toBeVisible();
    await expect(refreshButton(page)).toBeEnabled();
    expect(await page.evaluate(() => window.hostBulkCalls)).toEqual([{ method: 'reload' }]);
    await refreshButton(page).click(); await page.evaluate(() => window.finishHostBulkReload(true));
    await expect(hostRow(page, 'latest-server')).toBeVisible();
    expect(await page.evaluate(() => window.hostBulkCalls)).toEqual([{ method: 'reload' }, { method: 'reload' }, { method: 'refresh', targetIds: ['host-2', 'host-3', 'host-4', 'host-latest'] }]);
    await page.evaluate(() => window.finishHostBulkRefresh()); await expect(refreshButton(page)).toBeEnabled();
  });
}

test('빈 호스트 목록에서도 새로고침으로 목록을 읽고 새로 추가된 호스트를 조회', async ({ page }) => {
  await installMock(page, { delayedRefresh: true, emptyHosts: true }); await openHosts(page);
  expect(await hostIds(page)).toEqual([]); await expectNoSelection(page); await expect(refreshButton(page)).toBeEnabled();
  await refreshButton(page).click();
  expect(await page.evaluate(() => window.hostBulkCalls)).toEqual([{ method: 'reload' }]);
  await page.evaluate(() => window.finishHostBulkReload(true));
  await expect(hostRow(page, 'latest-server')).toBeVisible();
  expect(await page.evaluate(() => window.hostBulkCalls)).toEqual([{ method: 'reload' }, { method: 'refresh', targetIds: ['host-latest'] }]);
  await page.evaluate(() => window.finishHostBulkRefresh()); await expect(refreshButton(page)).toBeEnabled();
});

test('접힌 그룹의 호스트도 전체 선택에 포함하고 다시 펼쳐도 선택을 유지', async ({ page }) => {
  await installMock(page, { collapsed: true }); await openHosts(page);
  await expect(hostRow(page, 'dev-server')).toBeHidden(); await expect(hostRow(page, 'prod-server')).toBeHidden();
  await selectAll(page).check(); await expect(selectAll(page)).toBeChecked();
  await selectedDelete(page).click();
  const dialog = deletionDialog(page);
  for (const alias of ['dev-server', 'prod-server', 'backup-server', 'gpu-server']) await expect(selectedList(dialog)).toContainText(alias);
  await dialog.getByRole('button', { name: '취소', exact: true }).click();
  await hostTable(page).getByRole('button', { name: '개발 서버 펼치기', exact: true }).click();
  await expect(selection(page, 'dev-server')).toBeChecked(); await expect(selection(page, 'prod-server')).toBeChecked();
  expect(await page.evaluate(() => window.hostBulkCalls.filter(call => call.method === 'deleteHosts'))).toEqual([]);
});

test('외부에서 삭제된 호스트는 선택 목록에서 제거하고 남은 선택을 유지', async ({ page }) => {
  await installMock(page); await openHosts(page);
  await selection(page, 'dev-server').check(); await selection(page, 'prod-server').check();
  await page.evaluate(() => window.removeHostBulkFixture('host-1'));
  await expect(hostRow(page, 'dev-server')).toBeHidden(); await expect(selection(page, 'prod-server')).toBeChecked();
  await selectedDelete(page).click(); const dialog = deletionDialog(page);
  await expect(selectedList(dialog)).toContainText('prod-server'); await expect(selectedList(dialog)).not.toContainText('dev-server');
  await dialog.getByRole('button', { name: '취소', exact: true }).click();
  await page.evaluate(() => window.removeHostBulkFixture('host-2'));
  await expectNoSelection(page);
  expect(await selectAll(page).evaluate(input => input.indeterminate)).toBe(false);
});

test('선택 상태는 호스트 이름과 ID에 연결하여 표시 순서를 바꿔도 유지', async ({ page }) => {
  await installMock(page); await openHosts(page);
  await selection(page, 'dev-server').check(); await selection(page, 'prod-server').check();
  const handle = hostRow(page, 'prod-server').getByRole('button', { name: 'prod-server 순서 변경', exact: true });
  await handle.focus(); await page.keyboard.press('ArrowUp');
  await expect.poll(() => hostIds(page)).toEqual(['host-2', 'host-1', 'host-3', 'host-4']);
  await expect(selection(page, 'dev-server')).toBeChecked(); await expect(selection(page, 'prod-server')).toBeChecked(); await expect(selection(page, 'backup-server')).not.toBeChecked();
  await selectedDelete(page).click(); const dialog = deletionDialog(page);
  await expect(selectedList(dialog)).toContainText('dev-server'); await expect(selectedList(dialog)).toContainText('prod-server'); await expect(selectedList(dialog)).not.toContainText('backup-server');
  await dialog.getByRole('button', { name: '취소', exact: true }).click();
});

test('선택 업그레이드는 확인 후 모두 시작하고 전체 완료까지 중복 작업을 막으며 호스트별 결과를 표시', async ({ page }) => {
  await installMock(page); await openHosts(page);
  await selection(page, 'dev-server').check(); await selection(page, 'prod-server').check();
  await selectedUpgrade(page).click(); let dialog = upgradeDialog(page);
  await expect(selectedList(dialog)).toContainText('dev-server'); await expect(selectedList(dialog)).toContainText('prod-server'); await expect(selectedList(dialog)).not.toContainText('backup-server');
  expect(await page.evaluate(() => window.hostBulkCalls.filter(call => call.method === 'upgradeBatch'))).toEqual([]);
  await dialog.getByRole('button', { name: '취소', exact: true }).click();
  expect(await page.evaluate(() => window.hostBulkCalls.filter(call => call.method === 'upgradeBatch'))).toEqual([]);
  await selectedUpgrade(page).click(); dialog = upgradeDialog(page);
  await dialog.getByRole('button', { name: '업그레이드', exact: true }).click(); await expect(dialog).toBeHidden();
  await expect(hostRow(page, 'dev-server')).toContainText('업그레이드 중'); await expect(hostRow(page, 'prod-server')).toContainText('업그레이드 중');
  await expect(selectedUpgrade(page)).toBeDisabled(); await expect(selectedDelete(page)).toBeDisabled();
  await expect(hostRow(page, 'dev-server').getByRole('button', { name: /^업그레이드(?: 중)?$/ })).toBeDisabled();
  await expect(hostRow(page, 'prod-server').getByRole('button', { name: '계정 전환', exact: true })).toBeDisabled();
  await selectedUpgrade(page).evaluate(button => button.click());
  await page.evaluate(() => window.completeHostBulkUpgrade('host-1', true));
  await expect(hostRow(page, 'dev-server')).toContainText('0.161.0'); await expect(selectedUpgrade(page)).toBeDisabled();
  await page.evaluate(() => window.completeHostBulkUpgrade('host-2', false));
  await expect(selectedUpgrade(page)).toBeDisabled(); await expect(selectedDelete(page)).toBeDisabled();
  await hostRow(page, 'dev-server').getByRole('button', { name: '업그레이드', exact: true }).evaluate(button => button.click());
  expect(await page.evaluate(() => window.hostBulkCalls.filter(call => ['upgradeBatch', 'upgradeSingle'].includes(call.method)))).toEqual([{ method: 'upgradeBatch', ids: ['host-1', 'host-2'] }]);
  await page.evaluate(() => window.finishHostBulkUpgrade());
  const results = page.getByRole('region', { name: '일괄 업그레이드 결과', exact: true });
  await expect(results).toContainText('성공 1개'); await expect(results).toContainText('실패 1개');
  await expect(results).toContainText('prod-server'); await expect(results).toContainText('설치 권한이 없어 업그레이드를 완료하지 못했습니다.');
  await expect(selectedUpgrade(page)).toBeEnabled(); await expect(hostRow(page, 'backup-server')).toContainText('0.149.0');
  expect(await page.evaluate(() => window.hostBulkCalls.filter(call => call.method === 'startLogin'))).toEqual([]);
  await expect(page.getByRole('button', { name: /선택.*계정 전환|일괄.*계정 전환/ })).toHaveCount(0);
});

test('선택 삭제는 대상 목록을 먼저 표시하고 취소 시 유지하며 실행 시 선택한 ID만 삭제', async ({ page }) => {
  await installMock(page); await openHosts(page);
  await expectNoSelection(page);
  await selection(page, 'dev-server').check(); await selection(page, 'backup-server').check();
  await selectedDelete(page).click(); let dialog = deletionDialog(page);
  await expect(selectedList(dialog)).toContainText('dev-server'); await expect(selectedList(dialog)).toContainText('backup-server'); await expect(selectedList(dialog)).not.toContainText('prod-server'); await expect(selectedList(dialog)).not.toContainText('gpu-server');
  await dialog.getByRole('button', { name: '취소', exact: true }).click();
  expect(await page.evaluate(() => window.hostBulkCalls.filter(call => call.method === 'deleteHosts'))).toEqual([]);
  await expect(selection(page, 'dev-server')).toBeChecked();
  await selectedDelete(page).click(); dialog = deletionDialog(page);
  await dialog.getByRole('button', { name: '호스트 삭제', exact: true }).click();
  expect(await page.evaluate(() => window.hostBulkCalls.filter(call => call.method === 'deleteHosts'))).toEqual([{ method: 'deleteHosts', ids: ['host-1', 'host-3'], revision: 'rev-1' }]);
  await page.evaluate(() => window.finishHostBulkDelete());
  await expect(dialog).toBeHidden(); await expect.poll(() => hostIds(page)).toEqual(['host-2', 'host-4']);
  await expectNoSelection(page);
  expect(await page.evaluate(() => window.hostBulkCalls.filter(call => call.method === 'deleteSingle'))).toEqual([]);
});

test('선택 삭제 충돌은 선택 대상을 유지하고 최신 설정으로 다시 시도하며 외부 추가 호스트는 보존', async ({ page }) => {
  await installMock(page, { deletionConflict: true }); await openHosts(page);
  await selection(page, 'dev-server').check(); await selection(page, 'backup-server').check();
  await selectedDelete(page).click(); const dialog = deletionDialog(page);
  await dialog.getByRole('button', { name: '호스트 삭제', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('호스트 목록이 변경되었습니다.'); await expect(dialog).toBeVisible();
  await expect(selectedList(dialog)).toContainText('dev-server'); await expect(selectedList(dialog)).toContainText('backup-server'); await expect(selectedList(dialog)).not.toContainText('external-server');
  await dialog.getByRole('button', { name: '호스트 삭제', exact: true }).click();
  expect(await page.evaluate(() => window.hostBulkCalls.filter(call => call.method === 'deleteHosts'))).toEqual([
    { method: 'deleteHosts', ids: ['host-1', 'host-3'], revision: 'rev-1' },
    { method: 'deleteHosts', ids: ['host-1', 'host-3'], revision: 'rev-2' },
  ]);
  await page.evaluate(() => window.finishHostBulkDelete());
  await expect(dialog).toBeHidden(); await expect.poll(() => hostIds(page)).toEqual(['host-2', 'host-4', 'host-external']);
  await expect(hostRow(page, 'external-server')).toBeVisible();
});

test('선택 삭제 응답에서 같은 ID가 다른 호스트에 재사용되어도 삭제한 ID의 선택을 해제', async ({ page }) => {
  await installMock(page, { reuseDeletedIds: true }); await openHosts(page);
  await selection(page, 'dev-server').check(); await selectedDelete(page).click();
  const dialog = deletionDialog(page);
  await dialog.getByRole('button', { name: '호스트 삭제', exact: true }).click();
  await page.evaluate(() => window.finishHostBulkDelete());
  await expect(dialog).toBeHidden();
  await expect(hostRow(page, 'dev-server')).toHaveAttribute('data-host-id', 'host-1');
  await expect(hostRow(page, 'dev-server')).toContainText('192.0.2.110');
  await expect(hostRow(page, 'dev-server')).toContainText('replacement@example.invalid');
  await expect(selection(page, 'dev-server')).not.toBeChecked();
  await expect(selectAll(page)).not.toBeChecked();
  await expectNoSelection(page);
});

test('개별 삭제 후 같은 ID가 다른 호스트에 재사용되어도 해당 ID의 선택을 해제', async ({ page }) => {
  await installMock(page, { reuseDeletedIds: true }); await openHosts(page);
  await selection(page, 'dev-server').check();
  await hostRow(page, 'dev-server').getByRole('button', { name: 'dev-server 호스트 정보', exact: true }).click();
  await page.getByRole('dialog', { name: 'dev-server 호스트 정보', exact: true }).getByRole('button', { name: '호스트 삭제', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: '호스트 삭제', exact: true });
  await dialog.getByRole('button', { name: '호스트 삭제', exact: true }).click();
  expect(await page.evaluate(() => window.hostBulkCalls.filter(call => call.method === 'deleteSingle'))).toEqual([{ method: 'deleteSingle', id: 'host-1', revision: 'rev-1' }]);
  await page.evaluate(() => window.finishHostBulkDelete());
  await expect(dialog).toBeHidden();
  await expect(hostRow(page, 'dev-server')).toContainText('192.0.2.110');
  await expect(selection(page, 'dev-server')).not.toBeChecked();
  await expectNoSelection(page);
});

test('공통 설정 행도 선택하되 업그레이드 실패를 개별 표시하고 다른 호스트는 완료', async ({ page }) => {
  await installMock(page, { commonSetting: true }); await openHosts(page);
  await selectAll(page).check(); await expect(selection(page, '*')).toBeChecked();
  await selectedUpgrade(page).click(); const dialog = upgradeDialog(page);
  await expect(selectedList(dialog).locator('li')).toHaveCount(5);
  await dialog.getByRole('button', { name: '업그레이드', exact: true }).click();
  expect(await page.evaluate(() => window.hostBulkCalls.filter(call => call.method === 'upgradeBatch'))).toEqual([{ method: 'upgradeBatch', ids: ['host-1', 'host-2', 'host-3', 'host-4', 'host-common'] }]);
  await page.evaluate(() => {
    for (const id of ['host-1', 'host-2', 'host-3', 'host-4']) window.completeHostBulkUpgrade(id, true);
    window.completeHostBulkUpgrade('host-common', false, '공통 설정은 업그레이드할 수 없습니다.');
    window.finishHostBulkUpgrade();
  });
  const results = page.getByRole('region', { name: '일괄 업그레이드 결과', exact: true });
  await expect(results).toContainText('성공 4개'); await expect(results).toContainText('실패 1개');
  await expect(results.locator('li')).toContainText('*'); await expect(results).toContainText('공통 설정은 업그레이드할 수 없습니다.');
  await expect(hostRow(page, 'dev-server')).toContainText('0.161.0'); await expect(selectedUpgrade(page)).toBeEnabled();
});

test('개별 작업 중인 호스트는 선택을 유지하되 삭제를 막고 업그레이드 확인 목록에는 포함', async ({ page }) => {
  await installMock(page); await openHosts(page);
  await page.evaluate(() => window.changeHostBulkOperation('host-2', { type: 'generateKey', running: true, status: 'running' }));
  await selection(page, 'dev-server').check(); await selection(page, 'prod-server').check();
  await expect(selectedDelete(page)).toBeDisabled(); await expect(selectedUpgrade(page)).toBeEnabled();
  await selectedUpgrade(page).click(); const upgrade = upgradeDialog(page);
  await expect(selectedList(upgrade)).toContainText('dev-server'); await expect(selectedList(upgrade)).toContainText('prod-server');
  await upgrade.getByRole('button', { name: '취소', exact: true }).click();
  await page.evaluate(() => window.changeHostBulkOperation('host-2', { type: 'generateKey', running: false, status: 'completed' }));
  await expect(selectedDelete(page)).toBeEnabled(); await selectedDelete(page).click(); const deletion = deletionDialog(page);
  await page.evaluate(() => window.changeHostBulkOperation('host-1', { type: 'inspectKeys', running: true, status: 'running' }));
  await expect(deletion.getByRole('button', { name: '호스트 삭제', exact: true })).toBeDisabled();
  await expect(deletion.getByRole('alert')).toContainText('작업 중인 호스트가 있습니다.');
  await page.evaluate(() => window.changeHostBulkOperation('host-1', { type: 'inspectKeys', running: false, status: 'completed' }));
  await expect(deletion.getByRole('button', { name: '호스트 삭제', exact: true })).toBeEnabled();
  await deletion.getByRole('button', { name: '취소', exact: true }).click();
  expect(await page.evaluate(() => window.hostBulkCalls.filter(call => ['deleteHosts', 'upgradeBatch'].includes(call.method)))).toEqual([]);
});

test('좁은 화면에서 선택 전후 도구 버튼을 한 줄로 표시하고 표만 가로로 스크롤', async ({ page }) => {
  await installMock(page); await page.setViewportSize({ width: 880, height: 440 }); await openHosts(page);
  const checkToolbar = async selected => {
    const buttons = [...(selected ? [selectedUpgrade(page), selectedDelete(page)] : []), refreshButton(page), page.getByRole('button', { name: '그룹 추가', exact: true }), page.getByRole('button', { name: '호스트 추가', exact: true })];
    for (const button of buttons) await expect(button).toBeInViewport();
    const boxes = await Promise.all(buttons.map(button => button.boundingBox()));
    const centers = boxes.map(box => box.y + box.height / 2);
    expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(2);
    const actions = await page.locator('.host-toolbar-actions').boundingBox();
    expect(actions.height).toBeLessThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (selected) expect(boxes[1].x + boxes[1].width).toBeLessThanOrEqual(boxes[2].x);
  };
  await expectNoSelection(page); await checkToolbar(false);
  await page.screenshot({ path: 'test-results/hosts-toolbar-unselected-compact.png' });
  await selection(page, 'dev-server').check();
  const heights = await hostTable(page).locator('tbody > tr[data-host-id]').evaluateAll(rows => rows.map(row => row.getBoundingClientRect().height));
  expect(heights).toHaveLength(4); expect(heights.every(height => height > 24 && height <= 50)).toBe(true);
  await checkToolbar(true); await expect(selectAll(page)).toBeInViewport();
  await page.screenshot({ path: 'test-results/hosts-toolbar-selected-compact.png' });
  const overflow = await hostTable(page).evaluate(table => { const container = table.closest('.table-scroll'); return { scroll: container.scrollWidth, client: container.clientWidth }; });
  expect(overflow.scroll).toBeGreaterThan(overflow.client);
  await hostTable(page).evaluate(table => { const container = table.closest('.table-scroll'); container.scrollLeft = container.scrollWidth; });
  await expect(hostRow(page, 'dev-server').getByRole('button', { name: '계정 전환', exact: true })).toBeInViewport();
  await page.screenshot({ path: 'test-results/hosts-bulk-compact.png' });
});


test('일괄 작업 중 메뉴를 다시 열어도 완료 호스트의 잠금과 선택 없는 진행 표시를 유지', async ({ page }) => {
  await installMock(page); await openHosts(page);
  await selection(page, 'dev-server').check(); await selection(page, 'prod-server').check();
  await selectedUpgrade(page).click(); await upgradeDialog(page).getByRole('button', { name: '업그레이드', exact: true }).click();
  await page.evaluate(() => window.completeHostBulkUpgrade('host-1', true));
  await expect(hostRow(page, 'dev-server')).toContainText('0.161.0');
  expect(await page.evaluate(() => window.hostBulkSnapshot().hosts.find(host => host.id === 'host-1').operation.running)).toBe(false);
  await page.getByRole('button', { name: '계정관리', exact: true }).click();
  await expect(page.getByRole('table', { name: '계정 목록', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '호스트관리', exact: true }).click();
  await expectNoSelection(page);
  await expect(page.locator('.host-batch-progress')).toContainText('2개 호스트 업그레이드 중');
  await expect(refreshButton(page)).toBeDisabled();
  const completed = hostRow(page, 'dev-server');
  await expect(completed.getByRole('button', { name: '업그레이드', exact: true })).toBeDisabled();
  await expect(completed.getByRole('button', { name: '계정 전환', exact: true })).toBeDisabled();
  await expect(completed.getByRole('button', { name: 'dev-server 호스트 조회', exact: true })).toBeDisabled();
  await expect(completed.locator('.spin')).toHaveCount(0);
  await expect(hostRow(page, 'gpu-server').getByRole('button', { name: '업그레이드', exact: true })).toBeEnabled();
  await selection(page, 'dev-server').check();
  await expect(selectedUpgrade(page)).toBeDisabled(); await expect(selectedDelete(page)).toBeDisabled();
  await selection(page, 'dev-server').uncheck();
  await expectNoSelection(page); await expect(page.locator('.host-batch-progress')).toBeVisible();
  await page.evaluate(() => { window.completeHostBulkUpgrade('host-2', false); window.finishHostBulkUpgrade(); });
  await expect(page.locator('.host-batch-progress')).toBeHidden(); await expect(refreshButton(page)).toBeEnabled();
  await expect(completed.getByRole('button', { name: '업그레이드', exact: true })).toBeEnabled();
  await selection(page, 'dev-server').check(); await expect(selectedUpgrade(page)).toBeEnabled(); await expect(selectedDelete(page)).toBeEnabled();
  expect(await page.evaluate(() => window.hostBulkCalls.filter(call => ['upgradeBatch', 'upgradeSingle', 'deleteHosts'].includes(call.method)))).toEqual([{ method: 'upgradeBatch', ids: ['host-1', 'host-2'] }]);
});

test('서버에서 진행 중인 일괄 작업을 첫 화면과 페이지 재마운트에서 복원하고 전체 종료 후 잠금 해제', async ({ page }) => {
  await installMock(page, { restoredBatch: true }); await openHosts(page);
  await expectNoSelection(page); await expect(page.locator('.host-batch-progress')).toBeVisible();
  await expect(hostRow(page, 'dev-server').getByRole('button', { name: '업그레이드', exact: true })).toBeDisabled();
  await expect(hostRow(page, 'dev-server').locator('.spin')).toHaveCount(0);
  await page.reload(); await page.getByRole('button', { name: '호스트관리', exact: true }).click();
  await expectNoSelection(page); await expect(page.locator('.host-batch-progress')).toContainText('2개 호스트 업그레이드 중');
  await expect(refreshButton(page)).toBeDisabled(); await selection(page, 'dev-server').check();
  await expect(selectedUpgrade(page)).toBeDisabled(); await expect(selectedDelete(page)).toBeDisabled();
  await page.evaluate(() => { window.completeHostBulkUpgrade('host-2', true); window.finishHostBulkUpgrade(); });
  await expect(page.locator('.host-batch-progress')).toBeHidden();
  await expect(selectedUpgrade(page)).toBeEnabled(); await expect(selectedDelete(page)).toBeEnabled(); await expect(refreshButton(page)).toBeEnabled();
  expect(await page.evaluate(() => window.hostBulkCalls.filter(call => ['upgradeBatch', 'upgradeSingle', 'deleteHosts', 'reload'].includes(call.method)))).toEqual([]);
});
