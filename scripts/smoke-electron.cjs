const { _electron: electron, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const root = path.resolve(__dirname, '..');
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-manager-app-'));
  const sshConfigPath = path.join(dataDir, 'ssh', 'config');
  await fs.mkdir(path.dirname(sshConfigPath), { mode: 0o700 });
  await fs.writeFile(sshConfigPath, '# Isolated SSH test configuration\n', { mode: 0o600 });
  let application;
  try {
    const executableIndex = process.argv.indexOf('--executable');
    const suppliedExecutable = executableIndex < 0 ? null : process.argv[executableIndex + 1];
    if (executableIndex >= 0 && (!suppliedExecutable || suppliedExecutable.startsWith('--'))) {
      throw new Error('--executable 뒤에 앱 실행 파일 경로를 지정하십시오.');
    }
    const packaged = process.argv.includes('--packaged') || Boolean(suppliedExecutable);
    const defaultExecutable = process.platform === 'darwin'
      ? path.join(root, `release/mac-${process.arch}/Codex Account Manager.app/Contents/MacOS/Codex Account Manager`)
      : process.platform === 'win32'
        ? path.join(root, 'release/installers/windows/win-unpacked/Codex Account Manager.exe') : null;
    const executablePath = suppliedExecutable ? path.resolve(suppliedExecutable) : defaultExecutable;
    if (packaged && !executablePath) throw new Error('이 운영체제에서는 --executable로 실행 파일을 지정하십시오.');
    application = await electron.launch({
      ...(packaged ? { executablePath } : {}),
      args: packaged ? [] : [root],
      env: { ...process.env, CODEX_MANAGER_DATA_DIR: dataDir, CODEX_MANAGER_SSH_CONFIG: sshConfigPath }, timeout: 30000,
    });
    const page = await application.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('heading', { name: /^계정/ }).waitFor();
    const initial = await page.evaluate(() => window.accountManager.getState());
    assert.equal(initial.runtime.available, true, initial.runtime.error);
    assert.equal(initial.accounts.length, 0);
    const added = await page.evaluate(() => window.accountManager.addAccount('연결 점검 계정'));
    assert.equal(added.accounts.length, 1);
    const id = added.accounts[0].id;
    await assert.rejects(page.evaluate(id => window.accountManager.resetAccounts([id]), id), /초기화권/);
    await assert.rejects(page.evaluate(id => window.accountManager.resetAccounts([id], { [id]: '' }), id), /초기화권/);
    const refreshed = await page.evaluate(id => window.accountManager.refreshAccounts([id]), id);
    assert.equal(refreshed.accounts[0].status, 'signedOut', refreshed.accounts[0].error);
    assert.equal(refreshed.accounts[0].usage, null);
    const details = await page.evaluate(id => window.accountManager.getAccountDetails(id), id);
    assert.equal(details.accountId, id);
    assert.deepEqual(details.resets, []);
    const detailRefresh = await page.evaluate(id => window.accountManager.refreshAccountDetails(id), id);
    assert.equal(detailRefresh.tokenUsage, null);
    assert.equal(typeof detailRefresh.usageError, 'string');
    const afterDetails = await page.evaluate(() => window.accountManager.getState());
    assert.equal(afterDetails.accounts[0].status, 'signedOut');
    const config = await fs.readFile(path.join(dataDir, 'profiles', id, 'config.toml'), 'utf8');
    assert.match(config, /cli_auth_credentials_store\s*=\s*"keyring"/);
    const removed = await page.evaluate(id => window.accountManager.removeAccount(id), id);
    assert.equal(removed.accounts.length, 0);
    await page.getByText('등록된 계정이 없습니다.', { exact: true }).waitFor();
    await page.getByRole('button', { name: '호스트관리', exact: true }).click();
    await page.getByRole('heading', { name: '호스트관리', exact: true }).waitFor();
    const hostInitial = await page.evaluate(() => window.hostManager.getState());
    assert.equal(hostInitial.hosts.length, 0);
    assert.equal(hostInitial.configPath, sshConfigPath);
    await assert.rejects(page.evaluate(() => window.hostManager.startCodexLogin('missing-host')), /호스트/);
    const hostAdded = await page.evaluate(({ revision, identityFile }) => window.hostManager.saveHost({ alias: 'isolated-test', hostName: '192.0.2.1', user: 'test', port: '22', identityFile }, revision), { revision: hostInitial.revision, identityFile: path.join(dataDir, 'ssh', 'id_isolated_test') });
    assert.equal(hostAdded.hosts.length, 1);
    assert.equal(hostAdded.hosts[0].alias, 'isolated-test');
    await assert.rejects(page.evaluate(id => window.hostManager.openCodexLogin(id), hostAdded.hosts[0].id), /로그인/);
    await assert.rejects(page.evaluate(id => window.hostManager.copyCodexLoginCode(id), hostAdded.hosts[0].id), /로그인/);
    await page.getByRole('button', { name: 'isolated-test 호스트 정보', exact: true }).click();
    const hostDialog = page.getByRole('dialog', { name: 'isolated-test 호스트 정보', exact: true });
    assert.equal(await hostDialog.getByRole('tab', { name: '접속 정보', exact: true }).getAttribute('aria-selected'), 'true');
    await hostDialog.getByRole('tabpanel', { name: '접속 정보', exact: true }).getByText('192.0.2.1', { exact: true }).waitFor();
    await hostDialog.getByRole('tab', { name: '키 등록', exact: true }).click();
    await hostDialog.getByRole('button', { name: '키 생성', exact: true }).waitFor();
    assert.equal(await hostDialog.getByRole('button', { name: '미등록 시 등록', exact: true }).isDisabled(), true);
    await hostDialog.getByRole('region', { name: '서버에 등록된 키', exact: true }).waitFor();
    await hostDialog.getByRole('region', { name: '처리 결과', exact: true }).waitFor();
    await hostDialog.getByRole('button', { name: '닫기', exact: true }).last().click();
    const twoHosts = await page.evaluate(({ revision, identityFile }) => window.hostManager.saveHost({ alias: 'isolated-second', hostName: '192.0.2.2', user: 'test', identityFile }, revision), { revision: hostAdded.revision, identityFile: path.join(dataDir, 'ssh', 'id_isolated_second') });
    const second = twoHosts.hosts.find(host => host.alias === 'isolated-second');
    const firstRow = page.getByRole('table', { name: '호스트 목록', exact: true }).locator('tbody > tr').filter({ has: page.getByRole('button', { name: 'isolated-test 호스트 정보', exact: true }) });
    await firstRow.getByRole('button', { name: '계정 전환', exact: true }).click();
    const loginDialog = page.getByRole('dialog', { name: 'Codex 계정 전환', exact: true });
    await expect(loginDialog).toBeVisible();
    await expect(loginDialog).toContainText('isolated-test');
    await expect(loginDialog.getByRole('button', { name: '로그인 시작', exact: true })).toBeVisible();
    await fs.mkdir(path.join(root, 'test-results'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'test-results/app-host-login.png'), fullPage: true });
    await loginDialog.getByRole('button', { name: '닫기', exact: true }).last().click();
    assert.equal((await page.evaluate(() => window.hostManager.getState())).hosts.find(host => host.id === hostAdded.hosts[0].id).login == null, true);
    const secondHandle = page.getByRole('button', { name: 'isolated-second 순서 변경', exact: true });
    await secondHandle.dragTo(firstRow, { targetPosition: { x: 50, y: 8 } });
    await expect.poll(async () => (await page.evaluate(() => window.hostManager.getState())).hosts.map(host => host.id)).toEqual([second.id, hostAdded.hosts[0].id]);
    await expect(secondHandle).toBeEnabled();
    const reordered = await page.evaluate(() => window.hostManager.getState());
    assert.deepEqual(reordered.hosts.map(host => host.id), [second.id, hostAdded.hosts[0].id]);
    await assert.rejects(page.evaluate(({ ids, revision }) => window.hostManager.reorderHosts(ids, revision), { ids: reordered.hosts.map(host => host.id), revision: hostAdded.revision }), /변경|다시|다른/);
    const reloaded = await page.evaluate(() => window.hostManager.reloadHosts());
    assert.deepEqual(reloaded.hosts.map(host => host.id), reordered.hosts.map(host => host.id));
    assert.deepEqual(reloaded.groups, []);
    const groupAdded = await page.evaluate(revision => window.hostManager.saveGroup({ name: '연결 점검 그룹' }, revision), reloaded.revision);
    const group = groupAdded.groups[0];
    assert.equal(group.name, '연결 점검 그룹');
    const assigned = await page.evaluate(({ id, groupId, revision }) => window.hostManager.moveHostToGroup(id, groupId, revision), { id: second.id, groupId: group.id, revision: groupAdded.revision });
    assert.equal(assigned.hosts.find(host => host.id === second.id).groupId, group.id);
    await expect(page.getByRole('button', { name: '연결 점검 그룹 접기', exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(root, 'test-results/app-host-groups.png'), fullPage: true });
    const collapsed = await page.evaluate(({ id, revision }) => window.hostManager.setGroupCollapsed(id, true, revision), { id: group.id, revision: assigned.revision });
    assert.equal(collapsed.groups[0].collapsed, true);
    await expect(page.getByRole('button', { name: 'isolated-second 호스트 정보', exact: true })).toBeHidden();
    const groupedReloaded = await page.evaluate(() => window.hostManager.reloadHosts());
    assert.equal(groupedReloaded.groups[0].collapsed, true);
    assert.equal(groupedReloaded.hosts.find(host => host.id === second.id).groupId, group.id);
    await assert.rejects(page.evaluate(({ id, revision }) => window.hostManager.setGroupCollapsed(id, false, revision), { id: group.id, revision: assigned.revision }), /변경|다시|다른/);
    const groupRenamed = await page.evaluate(({ id, revision }) => window.hostManager.saveGroup({ id, name: '그룹 이름 변경' }, revision), { id: group.id, revision: groupedReloaded.revision });
    assert.equal(groupRenamed.groups[0].name, '그룹 이름 변경');
    const groupRemoved = await page.evaluate(({ id, revision }) => window.hostManager.deleteGroup(id, revision), { id: group.id, revision: groupRenamed.revision });
    assert.deepEqual(groupRemoved.groups, []);
    assert.equal(groupRemoved.hosts.length, 2);
    assert.equal(groupRemoved.hosts.find(host => host.id === second.id).groupId, null);
    await expect(page.getByRole('button', { name: 'isolated-second 호스트 정보', exact: true })).toBeVisible();
    await assert.rejects(page.evaluate(({ id, revision }) => window.hostManager.deleteHost(id, revision), { id: hostAdded.hosts[0].id, revision: hostInitial.revision }), /변경|다시|다른/);
    const oneRemoved = await page.evaluate(({ id, revision }) => window.hostManager.deleteHost(id, revision), { id: hostAdded.hosts[0].id, revision: groupRemoved.revision });
    assert.equal(oneRemoved.hosts.length, 1);
    const hostRemoved = await page.evaluate(({ id, revision }) => window.hostManager.deleteHost(id, revision), { id: second.id, revision: oneRemoved.revision });
    assert.equal(hostRemoved.hosts.length, 0);
    assert.match(await fs.readFile(sshConfigPath, 'utf8'), /Isolated SSH test configuration/);
    await page.getByRole('button', { name: '계정관리', exact: true }).click();
    await fs.mkdir(path.join(root, 'test-results'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'test-results/app-empty.png'), fullPage: true });
    assert.deepEqual(errors, []);
    console.log(`Electron 앱 검사 통과: Codex ${initial.runtime.version}, 계정 추가·격리 연결·삭제, 호스트 상세 탭·드래그 순서 저장·그룹 이동·접기 저장·변경 충돌·삭제, 화면 오류 없음`);
  } finally {
    if (application) await application.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
