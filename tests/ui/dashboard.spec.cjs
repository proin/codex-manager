const { test, expect } = require('@playwright/test');

const accountRow = (page, label) => page.locator('tbody > tr').filter({
  has: page.getByRole('checkbox', { name: `${label} 선택`, exact: true }),
});

test.beforeEach(async ({ page }) => {
  page.uiErrors = [];
  page.on('pageerror', error => page.uiErrors.push(error.message));
});
test.afterEach(async ({ page }) => expect(page.uiErrors).toEqual([]));

test('계정 목록에 사용량, 크레딧, 초기화권 표시', async ({ page }) => {
  await page.goto('/?demo=1');
  await expect(page.getByRole('heading', { name: '계정', exact: true })).toBeVisible();
  await expect(page.getByText('예시 데이터', { exact: true })).toBeVisible();
  await expect(page.locator('tbody > tr')).toHaveCount(5);
  await expect(page.getByRole('columnheader', { name: '사용량', exact: true })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: '크레딧', exact: true })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: '초기화권', exact: true })).toBeVisible();
  const personal = accountRow(page, '개인 계정');
  await expect(personal).toContainText('personal@example.com');
  await expect(personal.locator('.usage-value strong')).toHaveText(['72%', '56%']);
  await expect(personal.locator('.credit-balance')).toHaveText('1,200');
  await expect(personal.locator('.credit-value b')).toHaveText('2');
  await expect(accountRow(page, '프로젝트 계정').locator('.credit-balance')).toHaveText('무제한');
  await expect(accountRow(page, '연구 계정').locator('.credit-balance')).toHaveText('0');
  await expect(accountRow(page, '업무 계정').locator('.credit-balance')).toHaveText('—');
  await expect(page.getByRole('navigation', { name: '관리 메뉴', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '계정관리', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('button', { name: '호스트관리', exact: true })).toBeVisible();
  await expect(page.getByRole('searchbox')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '최근 작업', exact: true })).toHaveCount(0);
  await expect(page.locator('.stats-grid')).toHaveCount(0);
});

test('정보가 없는 값은 0과 구분하고 초기화권 목록에서 안내', async ({ page }) => {
  await page.goto('/?demo=1');
  for (const label of ['업무 계정', '테스트 계정']) {
    const row = accountRow(page, label);
    await expect(row.locator('.credit-value b')).toHaveText('—');
    await expect(row.locator('.credit-balance')).toHaveText('—');
  }
  await expect(accountRow(page, '테스트 계정').getByRole('button', { name: '초기화권 사용', exact: true })).toBeDisabled();
  await accountRow(page, '업무 계정').getByRole('button', { name: '초기화권 사용', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '초기화권 목록', exact: true });
  await expect(picker).toContainText('초기화권 목록 정보가 제공되지 않았습니다.');
  await expect(picker.getByRole('radio')).toHaveCount(0);
  await expect(picker.getByRole('button', { name: '선택 완료', exact: true })).toBeDisabled();
  await picker.getByRole('button', { name: '취소', exact: true }).click();
  await expect(accountRow(page, '테스트 계정').locator('.usage-value strong')).toHaveText(['—', '—']);
  await expect(accountRow(page, '연구 계정').locator('.credit-balance')).toHaveText('0');
});

test('초기화권 목록에서 선택하고 알림 이후 선택한 계정에만 적용', async ({ page }) => {
  await page.goto('/?demo=1');
  await page.getByRole('checkbox', { name: '개인 계정 선택', exact: true }).check();
  await page.getByRole('checkbox', { name: '프로젝트 계정 선택', exact: true }).check();
  await page.locator('.selection-bar').getByRole('button', { name: /초기화권 사용/ }).click();
  const picker = page.getByRole('dialog', { name: '초기화권 목록', exact: true });
  await expect(picker).toBeVisible();
  await expect(picker.getByRole('button', { name: '선택 완료', exact: true })).toBeDisabled();
  await picker.getByRole('button', { name: '취소', exact: true }).click();
  await expect(picker).toBeHidden();
  const personal = accountRow(page, '개인 계정');
  const project = accountRow(page, '프로젝트 계정');
  await expect(personal.locator('.credit-value b')).toHaveText('2');
  await expect(project.locator('.credit-value b')).toHaveText('5');
  await page.locator('.selection-bar').getByRole('button', { name: /초기화권 사용/ }).click();
  for (const label of ['개인 계정', '프로젝트 계정']) {
    await picker.getByRole('region', { name: `${label} 초기화권`, exact: true }).locator('input[type="radio"]:not(:disabled)').first().check();
  }
  await picker.getByRole('button', { name: '선택 완료', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: '초기화권 사용 확인', exact: true });
  await expect(dialog).toContainText('계정마다 초기화권 1개를 사용합니다.');
  await expect(dialog).toContainText('personal@example.com');
  await expect(dialog).toContainText('project@example.com');
  await expect(dialog).not.toContainText('research@example.com');
  await expect(personal.locator('.credit-value b')).toHaveText('2');
  await expect(project.locator('.credit-value b')).toHaveText('5');
  await dialog.getByRole('button', { name: '목록으로 돌아가기', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(personal.locator('.credit-value b')).toHaveText('2');
  await expect(project.locator('.credit-value b')).toHaveText('5');
  await expect(picker.locator('input[type="radio"]:checked')).toHaveCount(2);
  await picker.getByRole('button', { name: '선택 완료', exact: true }).click();
  await dialog.getByRole('button', { name: '사용', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(personal.locator('.credit-value b')).toHaveText('1');
  await expect(project.locator('.credit-value b')).toHaveText('4');
  await expect(personal.locator('.usage-value strong')).toHaveText(['100%', '100%']);
  await expect(project.locator('.usage-value strong')).toHaveText(['100%', '100%']);
  const research = accountRow(page, '연구 계정');
  await expect(research.locator('.credit-value b')).toHaveText('1');
  await expect(research.locator('.usage-value strong')).toHaveText(['8%', '22%']);
});

test('개별 초기화권은 목록 조회와 선택 이후 사용을 눌러야 적용', async ({ page }) => {
  await page.addInitScript(() => {
    window.operationCalls = [];
    const now = Math.floor(Date.now() / 1000);
    const state = {
      accounts: [{ id: 'personal', label: '개인 계정', email: 'personal@example.com', status: 'ready', planType: 'plus', usage: { rateLimits: { limitId: 'codex', primary: null, secondary: null }, rateLimitResetCredits: { availableCount: 2, credits: [{ id: 'personal-credit', resetType: 'codexRateLimits', status: 'available', grantedAt: now - 86400, expiresAt: now + 86400 * 14, title: '개인 초기화권', description: null }] } } }],
      activity: [], refresh: { running: false }, runtime: { available: true },
    };
    window.accountManager = {
      getState: async () => state,
      onState: () => () => {},
      refreshAccounts: async ids => { window.operationCalls.push({ method: 'refresh', ids }); return state; },
      resetAccounts: async (ids, creditIds) => { window.operationCalls.push({ method: 'reset', ids, creditIds }); return state; },
    };
  });
  await page.goto('/');
  await accountRow(page, '개인 계정').getByRole('button', { name: '초기화권 사용', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '초기화권 목록', exact: true });
  await expect(picker).toBeVisible();
  await expect(picker.getByRole('radio', { name: /personal-credit/ })).toBeEnabled();
  expect(await page.evaluate(() => window.operationCalls)).toEqual([{ method: 'refresh', ids: ['personal'] }]);
  await picker.getByRole('button', { name: '취소', exact: true }).click();
  expect(await page.evaluate(() => window.operationCalls.filter(call => call.method === 'reset'))).toEqual([]);
  await accountRow(page, '개인 계정').getByRole('button', { name: '초기화권 사용', exact: true }).click();
  await picker.getByRole('radio', { name: /personal-credit/ }).check();
  await picker.getByRole('button', { name: '선택 완료', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: '초기화권 사용 확인', exact: true });
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => window.operationCalls.filter(call => call.method === 'reset'))).toEqual([]);
  await dialog.getByRole('button', { name: '사용', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(await page.evaluate(() => window.operationCalls)).toEqual([
    { method: 'refresh', ids: ['personal'] },
    { method: 'refresh', ids: ['personal'] },
    { method: 'reset', ids: ['personal'], creditIds: { personal: 'personal-credit' } },
  ]);
});

test('기기 코드 로그인과 취소, 이름 변경과 삭제', async ({ page }) => {
  await page.goto('/?demo=1');
  await page.getByRole('button', { name: '계정 추가', exact: true }).click();
  await page.locator('#account-label').fill('추가 계정');
  await page.locator('#login-method').selectOption('chatgptDeviceCode');
  await page.getByRole('button', { name: '로그인 시작', exact: true }).click();
  await expect(page.getByLabel('로그인 코드')).toHaveText('DEMO-CODE');
  await page.getByRole('button', { name: '로그인 취소', exact: true }).click();
  await page.getByRole('button', { name: '추가 계정 메뉴', exact: true }).click();
  await page.getByRole('button', { name: '이름 변경', exact: true }).click();
  await page.locator('#rename-label').fill('변경한 계정');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await page.getByRole('button', { name: '변경한 계정 메뉴', exact: true }).click();
  await page.locator('.dropdown').getByRole('button', { name: '계정 삭제', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '계정 삭제', exact: true }).click();
  await expect(page.locator('tbody > tr')).toHaveCount(5);
});

test('전체 조회 진행 표시와 화면 크기 점검', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/?demo=1');
  await page.getByRole('button', { name: '전체 조회', exact: true }).click();
  await expect(page.getByRole('button', { name: /조회 중/ })).toBeVisible();
  await expect(page.getByRole('button', { name: '전체 조회', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/accounts-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 960, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByRole('button', { name: '계정 추가', exact: true })).toBeVisible();
  await expect(page.locator('tbody > tr')).toHaveCount(5);
  await page.screenshot({ path: 'test-results/accounts-compact.png', fullPage: true });
});

test('일반 브라우저에서는 예시 계정을 자동으로 표시하지 않음', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('계정 관리 기능은 데스크톱 앱에서 사용할 수 있습니다.')).toBeVisible();
  await expect(page.getByText('personal@example.com')).toHaveCount(0);
});

test('불명확한 결과도 알림 이후 처리하고 완료한 작업은 사용량만 조회', async ({ page }) => {
  await page.addInitScript(() => {
    window.operationCalls = [];
    const account = (id, resetAttempt) => ({ id, label: id, email: `${id}@example.com`, status: 'ready', planType: 'plus', usage: { rateLimits: { limitId: 'codex', primary: null, secondary: null }, rateLimitResetCredits: { availableCount: 0 } }, resetAttempt });
    const state = { accounts: [account('retry', { status: 'uncertain', requestId: 'original-request' }), account('finished', { status: 'completed', needsRefresh: true })], activity: [], refresh: { running: false }, runtime: { available: true } };
    window.accountManager = { getState: async () => state, onState: () => () => {}, resetAccounts: async ids => { window.operationCalls.push({ method: 'reset', ids }); return state; }, refreshAccounts: async ids => { window.operationCalls.push({ method: 'refresh', ids }); return state; } };
  });
  await page.goto('/');
  await page.getByRole('button', { name: '결과 다시 확인', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: '초기화 결과 확인', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('retry@example.com');
  expect(await page.evaluate(() => window.operationCalls)).toEqual([]);
  await dialog.getByRole('button', { name: '취소', exact: true }).click();
  expect(await page.evaluate(() => window.operationCalls)).toEqual([]);
  await page.getByRole('button', { name: '결과 다시 확인', exact: true }).click();
  await dialog.getByRole('button', { name: '계속', exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: '사용량 다시 조회', exact: true }).click();
  expect(await page.evaluate(() => window.operationCalls)).toEqual([{ method: 'reset', ids: ['retry'] }, { method: 'refresh', ids: ['finished'] }]);
});
