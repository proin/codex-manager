const { test, expect } = require('@playwright/test');

const now = Math.floor(Date.now() / 1000);
const credit = (id, overrides = {}) => ({
  id, resetType: 'codexRateLimits', status: 'available', grantedAt: now - 86400,
  expiresAt: now + 14 * 86400, title: `${id} 초기화권`, description: null, ...overrides,
});

async function installBridge(page, options = {}) {
  await page.addInitScript(config => {
    let state = {
      accounts: [{
        id: 'personal', label: '개인 계정', email: 'personal@example.com', status: 'ready', planType: 'plus',
        usage: {
          rateLimits: { limitId: 'codex', primary: null, secondary: null },
          rateLimitResetCredits: config.initial,
        },
      }],
      activity: [], refresh: { running: false }, runtime: { available: true },
    };
    let readCount = 0;
    const listeners = new Set();
    const snapshot = () => structuredClone(state);
    window.operationCalls = [];
    window.accountManager = {
      getState: async () => snapshot(),
      onState: callback => { listeners.add(callback); return () => listeners.delete(callback); },
      refreshAccounts: async ids => {
        window.operationCalls.push({ method: 'refresh', ids });
        const step = config.refreshSteps?.[readCount++];
        if (step?.error) throw new Error(step.error);
        if (step?.metadata !== undefined) state.accounts[0].usage.rateLimitResetCredits = step.metadata;
        if (step?.email !== undefined) state.accounts[0].email = step.email;
        listeners.forEach(callback => callback(snapshot()));
        return snapshot();
      },
      resetAccounts: async (ids, creditIds) => {
        window.operationCalls.push({ method: 'reset', ids, creditIds });
        return snapshot();
      },
    };
  }, {
    initial: { availableCount: 2, credits: [credit('first-credit'), credit('second-credit')] },
    ...options,
  });
  await page.goto('/');
}

async function openPicker(page) {
  await page.getByRole('button', { name: '초기화권 사용', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '초기화권 목록', exact: true });
  await expect(picker).toBeVisible();
  await expect(picker.getByRole('button', { name: '목록 새로 조회', exact: true })).toBeEnabled();
  return picker;
}

test.beforeEach(async ({ page }) => {
  page.uiErrors = [];
  page.on('pageerror', error => page.uiErrors.push(error.message));
});
test.afterEach(async ({ page }) => expect(page.uiErrors).toEqual([]));

test('초기화권 정보와 사용 기간을 표시하고 고른 초기화권만 사용', async ({ page }) => {
  const first = credit('first-credit', { title: '첫 번째 초기화권', description: '추가 사용량 초기화' });
  const second = credit('second-credit', { title: '두 번째 초기화권' });
  await installBridge(page, { initial: { availableCount: 2, credits: [first, second] } });
  const picker = await openPicker(page);
  await expect(picker.getByRole('region', { name: '개인 계정 초기화권', exact: true })).toContainText('personal@example.com');
  await expect(picker).toContainText('첫 번째 초기화권');
  await expect(picker).toContainText('추가 사용량 초기화');
  await expect(picker.getByRole('columnheader', { name: '발급 일시', exact: true })).toBeVisible();
  await expect(picker.getByRole('columnheader', { name: '만료 일시', exact: true })).toBeVisible();
  const dates = await page.evaluate(({ grantedAt, expiresAt }) => [grantedAt, expiresAt].map(value => new Date(value * 1000).toLocaleString('ko-KR', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  })), first);
  const firstRow = picker.locator('tbody > tr').filter({ has: page.getByRole('radio', { name: /first-credit/ }) });
  await expect(firstRow.locator('td').nth(2)).toHaveText(dates[0]);
  await expect(firstRow.locator('td').nth(3)).toHaveText(dates[1]);
  await expect(picker.getByRole('radio')).toHaveCount(2);
  await expect(picker.locator('input[type="radio"]:checked')).toHaveCount(0);
  await expect(picker.getByRole('button', { name: '선택 완료', exact: true })).toBeDisabled();
  await picker.getByRole('radio', { name: /second-credit/ }).check();
  await picker.getByRole('button', { name: '선택 완료', exact: true }).click();
  const confirmation = page.getByRole('alertdialog', { name: '초기화권 사용 확인', exact: true });
  await expect(confirmation).toContainText('두 번째 초기화권');
  expect(await page.evaluate(() => window.operationCalls.filter(call => call.method === 'reset'))).toEqual([]);
  await confirmation.getByRole('button', { name: '사용', exact: true }).click();
  await expect(confirmation).toBeHidden();
  expect(await page.evaluate(() => window.operationCalls.filter(call => call.method === 'reset'))).toEqual([
    { method: 'reset', ids: ['personal'], creditIds: { personal: 'second-credit' } },
  ]);
});

test('만료·사용 완료·사용 기간 전·미지원 초기화권은 선택할 수 없음', async ({ page }) => {
  await installBridge(page, { initial: { availableCount: 1, credits: [
    credit('usable'),
    credit('expired', { expiresAt: now - 1 }),
    credit('redeemed', { status: 'redeemed' }),
    credit('future', { grantedAt: now + 86400 }),
    credit('unsupported', { resetType: 'unknown' }),
    credit('unknown-status', { status: 'unknown' }),
  ] } });
  const picker = await openPicker(page);
  await expect(picker.getByRole('radio', { name: /usable/ })).toBeEnabled();
  for (const id of ['expired', 'redeemed', 'future', 'unsupported', 'unknown-status']) {
    await expect(picker.getByRole('radio', { name: new RegExp(id) })).toBeDisabled();
  }
  for (const text of ['만료', '사용 완료', '사용 기간 전', '지원하지 않는 초기화권', '정보 없음']) {
    await expect(picker).toContainText(text);
  }
  await expect(picker.getByRole('button', { name: '선택 완료', exact: true })).toBeDisabled();
  await picker.screenshot({ path: 'test-results/reset-credit-list.png' });
});

test('보유 개수만 제공되거나 목록이 비어 있을 때 초기화권을 만들어 표시하지 않음', async ({ page }) => {
  await installBridge(page, { initial: { availableCount: 3, credits: null }, refreshSteps: [
    { metadata: { availableCount: 3, credits: null } },
    { metadata: { availableCount: 3, credits: [] } },
    { metadata: { availableCount: 0, credits: [credit('usable')] } },
  ] });
  const picker = await openPicker(page);
  await expect(picker).toContainText('초기화권 목록 정보가 제공되지 않았습니다.');
  await expect(picker.getByRole('radio')).toHaveCount(0);
  await expect(picker.getByRole('button', { name: '선택 완료', exact: true })).toBeDisabled();
  await picker.getByRole('button', { name: '목록 새로 조회', exact: true }).click();
  await expect(picker).toContainText('보유 개수와 목록이 일치하지 않습니다.');
  await expect(picker.getByRole('radio')).toHaveCount(0);
  await expect(picker.getByRole('button', { name: '선택 완료', exact: true })).toBeDisabled();
  await picker.getByRole('button', { name: '목록 새로 조회', exact: true }).click();
  await expect(picker.getByRole('radio', { name: /usable/ })).toBeDisabled();
  await expect(picker.getByRole('button', { name: '선택 완료', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => window.operationCalls.filter(call => call.method === 'reset'))).toEqual([]);
});

test('확인 화면에서 목록으로 돌아가면 선택한 초기화권을 유지하고 취소하면 사용하지 않음', async ({ page }) => {
  await installBridge(page);
  const picker = await openPicker(page);
  await picker.getByRole('radio', { name: /second-credit/ }).check();
  await picker.getByRole('button', { name: '선택 완료', exact: true }).click();
  const confirmation = page.getByRole('alertdialog', { name: '초기화권 사용 확인', exact: true });
  await confirmation.getByRole('button', { name: '목록으로 돌아가기', exact: true }).click();
  await expect(picker.getByRole('radio', { name: /second-credit/ })).toBeChecked();
  await expect(picker.getByRole('button', { name: '선택 완료', exact: true })).toBeEnabled();
  await picker.getByRole('button', { name: '취소', exact: true }).click();
  await expect(picker).toBeHidden();
  expect(await page.evaluate(() => window.operationCalls.filter(call => call.method === 'reset'))).toEqual([]);
  const reopened = await openPicker(page);
  await expect(reopened.locator('input[type="radio"]:checked')).toHaveCount(0);
});

test('목록을 다시 조회한 뒤 사용할 수 없어진 초기화권은 선택 해제', async ({ page }) => {
  await installBridge(page, { refreshSteps: [
    {},
    { metadata: { availableCount: 1, credits: [credit('first-credit'), credit('second-credit', { status: 'redeemed' })] } },
  ] });
  const picker = await openPicker(page);
  await picker.getByRole('radio', { name: /second-credit/ }).check();
  await picker.getByRole('button', { name: '목록 새로 조회', exact: true }).click();
  await expect(picker.getByRole('radio', { name: /second-credit/ })).toBeDisabled();
  await expect(picker.getByRole('radio', { name: /second-credit/ })).not.toBeChecked();
  await expect(picker.getByRole('button', { name: '선택 완료', exact: true })).toBeDisabled();
  await picker.getByRole('radio', { name: /first-credit/ }).check();
  await expect(picker.getByRole('button', { name: '선택 완료', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => window.operationCalls.filter(call => call.method === 'reset'))).toEqual([]);
});

test('목록 조회 실패 후 저장된 초기화권을 새로 사용하지 않음', async ({ page }) => {
  await installBridge(page, { refreshSteps: [{ error: '초기화권 목록 조회 실패' }] });
  const picker = await openPicker(page);
  await expect(picker).toContainText('초기화권 목록 조회 실패');
  await expect(picker.getByRole('button', { name: '선택 완료', exact: true })).toBeDisabled();
  await expect(picker.locator('input[type="radio"]:not(:disabled)')).toHaveCount(0);
  expect(await page.evaluate(() => window.operationCalls.filter(call => call.method === 'reset'))).toEqual([]);
});
