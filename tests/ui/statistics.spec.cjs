const { test, expect } = require('@playwright/test');

test.use({ timezoneId: 'Asia/Seoul' });

const label = '통계 계정';
const accountId = 'statistics-account';
const fixedTime = '2026-10-02T12:00:00+09:00';
const rowFor = page => page.getByRole('table', { name: '계정 목록', exact: true })
  .locator('tbody > tr').filter({ has: page.getByRole('checkbox', { name: `${label} 선택`, exact: true }) });

function sampleData({ missingUsage = false } = {}) {
  const bucket = {
    limitId: 'codex', limitName: 'Codex',
    primary: { usedPercent: 27.6, windowDurationMins: 300, resetsAt: null },
    secondary: { usedPercent: 73.4, windowDurationMins: 10080, resetsAt: null },
    credits: { hasCredits: true, unlimited: false, balance: '1234.6' },
  };
  return {
    state: {
      accounts: [{
        id: accountId, label, email: 'statistics@example.com', planType: 'plus', status: 'ready',
        lastUpdated: '2026-10-02T02:00:00.000Z',
        usage: { rateLimits: bucket, rateLimitsByLimitId: { codex: bucket }, rateLimitResetCredits: { availableCount: 3 } },
      }],
      activity: [], refresh: { running: false, done: 0, total: 0 },
      runtime: { available: true, version: '0.149.0' },
    },
    details: {
      accountId, email: 'statistics@example.com',
      trackingStartedAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-10-02T02:00:00.000Z',
      usageFetchedAt: '2026-10-02T02:00:00.000Z', usageError: null,
      tokenUsage: missingUsage ? null : {
        summary: { lifetimeTokens: 123456700, peakDailyTokens: 12000000, longestRunningTurnSec: 3600.8, currentStreakDays: 2, longestStreakDays: 9 },
        dailyUsageBuckets: [
          { startDate: '2026-10-02', tokens: 1234600 },
          { startDate: '2026-10-01', tokens: 800300 },
          { startDate: '2026-09-30', tokens: 500200 },
          { startDate: '2026-09-28', tokens: 150 },
          { startDate: '2026-09-27', tokens: 0 },
          { startDate: '2026-09-20', tokens: 200600 },
          { startDate: '2026-08-20', tokens: 600400 },
        ],
      },
      snapshots: [
        { time: '2026-09-30T02:00:00.000Z', buckets: [{ ...bucket, primary: { ...bucket.primary, usedPercent: 90.2 } }], creditBalance: 1500.8, creditsUnlimited: false, resetCredits: 4 },
        { time: '2026-10-02T02:00:00.000Z', buckets: [bucket], creditBalance: 1234.6, creditsUnlimited: false, resetCredits: 3 },
      ],
      resets: [
        { id: 'reset-used', time: '2026-10-02T01:00:00.000Z', requestedAt: '2026-10-02T00:59:00.000Z', outcome: 'reset', usedCount: 1, timeKind: 'completed' },
        { id: 'reset-none', time: '2026-10-01T01:00:00.000Z', requestedAt: '2026-10-01T00:59:00.000Z', outcome: 'noCredit', usedCount: 0, timeKind: 'completed' },
        { id: 'reset-uncertain', time: '2026-09-30T01:00:00.000Z', requestedAt: '2026-09-30T01:00:00.000Z', outcome: 'uncertain', usedCount: null, timeKind: 'requested' },
      ],
    },
  };
}

async function installMock(page, options) {
  await page.clock.setFixedTime(new Date(fixedTime));
  await page.addInitScript(({ state, details }) => {
    window.statisticsCalls = [];
    window.statisticsRefreshError = false;
    let refreshCount = 0;
    window.accountManager = {
      getState: async () => structuredClone(state),
      onState: () => () => {},
      getAccountDetails: async id => {
        window.statisticsCalls.push({ method: 'get', id });
        return structuredClone(details);
      },
      refreshAccountDetails: async id => {
        window.statisticsCalls.push({ method: 'refresh', id });
        refreshCount += 1;
        if (window.statisticsRefreshError) throw new Error('연결을 다시 시도하십시오.');
        const next = structuredClone(details);
        if (next.tokenUsage && refreshCount > 1) next.tokenUsage.dailyUsageBuckets.find(row => row.startDate === '2026-10-02').tokens = 8888800;
        next.usageFetchedAt = '2026-10-02T03:00:00.000Z';
        return next;
      },
    };
  }, sampleData(options));
  await page.goto('/');
}

async function openDetails(page) {
  await page.getByRole('button', { name: `${label} 상세 통계`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `${label} 상세 통계`, exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.beforeEach(async ({ page }) => {
  page.statisticsErrors = [];
  page.on('pageerror', error => page.statisticsErrors.push(error.message));
});
test.afterEach(async ({ page }) => expect(page.statisticsErrors).toEqual([]));

test('목록의 숫자를 정수와 오른쪽 정렬로 표시하고 없는 갱신 시간은 생략', async ({ page }) => {
  await installMock(page);
  const row = rowFor(page);
  await expect(row.locator('.usage-value strong')).toHaveText(['72%', '27%']);
  await expect(row.locator('.credit-balance')).toHaveText('1,235');
  await expect(row.locator('.credit-value b')).toHaveText('3');
  await expect(page.getByText('갱신 시간 없음', { exact: true })).toHaveCount(0);
  for (const index of [2, 3, 4]) await expect(row.locator('td').nth(index)).toHaveCSS('text-align', 'right');
  expect(await page.evaluate(() => window.statisticsCalls)).toEqual([]);
});

test('선택한 계정의 통계에서 날짜 누락과 토큰 수를 구분하고 표시 간격을 변경', async ({ page }) => {
  await installMock(page);
  const dialog = await openDetails(page);
  await dialog.getByLabel('조회 기간', { exact: true }).selectOption('7');
  const table = dialog.getByRole('table', { name: '기간별 사용량', exact: true });
  await expect(table.locator('tbody > tr')).toHaveCount(7);
  await expect(table.getByRole('cell', { name: '1.23M', exact: true })).toBeVisible();
  await expect(table.getByRole('cell', { name: '0.8M', exact: true })).toBeVisible();
  await expect(table.getByRole('cell', { name: '0.5M', exact: true })).toBeVisible();
  await expect(table.getByRole('cell', { name: '<0.01M', exact: true })).toBeVisible();
  await expect(table.getByRole('cell', { name: '0M', exact: true })).toBeVisible();
  await expect(table.locator('tbody > tr').filter({ hasText: /2026-09-29|9[./월]\s*29/ }).getByRole('cell', { name: '—', exact: true })).toBeVisible();
  await expect(dialog.locator('.details-summary')).toContainText('123.46M');
  await expect(dialog.locator('.details-summary')).toContainText('12M');
  const tokenChart = dialog.getByRole('img', { name: '기간별 토큰 사용량 그래프', exact: true });
  await expect(tokenChart).toBeVisible();
  await expect(tokenChart).toContainText('1.23M');
  await expect(tokenChart).toContainText('0M');
  await dialog.getByLabel('표시 간격', { exact: true }).selectOption('week');
  // Format the raw sum (2,535,250), not the sum of the rounded daily labels.
  await expect(table.getByRole('cell', { name: '2.54M', exact: true })).toBeVisible();
  await dialog.getByLabel('조회 기간', { exact: true }).selectOption('90');
  await dialog.getByLabel('표시 간격', { exact: true }).selectOption('month');
  await expect(table.getByRole('cell', { name: '0.6M', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.statisticsCalls)).toEqual([{ method: 'get', id: accountId }, { method: 'refresh', id: accountId }]);
  await dialog.getByRole('button', { name: '닫기', exact: true }).last().click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: `${label} 상세 통계`, exact: true })).toBeFocused();
});

test('새로 조회한 통계를 표시하고 조회 실패 시 기존 기록을 유지', async ({ page }) => {
  await installMock(page);
  const dialog = await openDetails(page);
  await dialog.getByLabel('조회 기간', { exact: true }).selectOption('7');
  const table = dialog.getByRole('table', { name: '기간별 사용량', exact: true });
  await dialog.getByRole('button', { name: '통계 새로 조회', exact: true }).click();
  await expect(table.getByRole('cell', { name: '8.89M', exact: true })).toBeVisible();
  await page.evaluate(() => { window.statisticsRefreshError = true; });
  await dialog.getByRole('button', { name: '통계 새로 조회', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('통계를 조회하지 못했습니다.');
  await expect(table.getByRole('cell', { name: '8.89M', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.statisticsCalls)).toEqual([
    { method: 'get', id: accountId }, { method: 'refresh', id: accountId }, { method: 'refresh', id: accountId }, { method: 'refresh', id: accountId },
  ]);
});

test('토큰 정보가 없을 때 사용량을 0으로 만들지 않고 잔여량과 초기화 기록은 표시', async ({ page }) => {
  await installMock(page, { missingUsage: true });
  const dialog = await openDetails(page);
  await expect(dialog.getByText('사용량 정보가 없습니다.', { exact: true })).toBeVisible();
  await dialog.getByRole('tab', { name: '잔여량 변화', exact: true }).click();
  await expect(dialog.getByRole('tab', { name: '잔여량 변화', exact: true })).toHaveAttribute('aria-selected', 'true');
  const quota = dialog.getByRole('table', { name: '잔여량 조회 기록', exact: true });
  await expect(quota.getByRole('cell', { name: '72%', exact: true })).toBeVisible();
  await expect(quota.getByRole('cell', { name: '10%', exact: true })).toBeVisible();
  await expect(quota.getByRole('cell', { name: '1,235', exact: true })).toBeVisible();
  const resets = dialog.getByRole('table', { name: '초기화권 사용 기록', exact: true });
  await expect(resets.locator('tbody > tr')).toHaveCount(3);
  await expect(resets.getByRole('row').filter({ hasText: '사용 완료' }).getByRole('cell', { name: '1개', exact: true })).toBeVisible();
  await expect(resets.getByRole('row').filter({ hasText: '초기화권 없음' }).getByRole('cell', { name: '0개', exact: true })).toBeVisible();
  await expect(resets.getByRole('row').filter({ hasText: '결과 미확정' }).getByRole('cell', { name: '—', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.statisticsCalls)).toEqual([{ method: 'get', id: accountId }, { method: 'refresh', id: accountId }]);
});

test('다른 계정으로 이동한 뒤 도착한 이전 계정 응답은 상세 통계를 바꾸지 않음', async ({ page }) => {
  const data = sampleData();
  const otherId = 'other-statistics-account';
  const otherLabel = '다른 계정';
  data.state.accounts.push({ ...structuredClone(data.state.accounts[0]), id: otherId, label: otherLabel, email: 'other@example.com' });
  const otherDetails = {
    ...structuredClone(data.details), accountId: otherId, email: 'other@example.com',
    tokenUsage: {
      ...structuredClone(data.details.tokenUsage),
      dailyUsageBuckets: [{ startDate: '2026-10-02', tokens: 4321600 }],
    },
  };
  await page.clock.setFixedTime(new Date(fixedTime));
  await page.addInitScript(({ state, details, otherDetails }) => {
    window.statisticsCalls = [];
    window.resolvePreviousAccount = null;
    window.accountManager = {
      getState: async () => structuredClone(state),
      onState: () => () => {},
      getAccountDetails: async id => {
        window.statisticsCalls.push({ method: 'get', id });
        return structuredClone(id === details.accountId ? details : otherDetails);
      },
      refreshAccountDetails: id => {
        window.statisticsCalls.push({ method: 'refresh', id });
        if (id === otherDetails.accountId) return Promise.resolve(structuredClone(otherDetails));
        return new Promise(resolve => {
          window.resolvePreviousAccount = () => {
            const delayed = structuredClone(details);
            delayed.tokenUsage.dailyUsageBuckets = [{ startDate: '2026-10-02', tokens: 99999800 }];
            resolve(delayed);
          };
        });
      },
    };
  }, { ...data, otherDetails });
  await page.goto('/');
  const firstDialog = await openDetails(page);
  await expect.poll(() => page.evaluate(() => typeof window.resolvePreviousAccount)).toBe('function');
  await firstDialog.getByRole('button', { name: '닫기', exact: true }).last().click();
  await page.getByRole('button', { name: `${otherLabel} 상세 통계`, exact: true }).click();
  const secondDialog = page.getByRole('dialog', { name: `${otherLabel} 상세 통계`, exact: true });
  const table = secondDialog.getByRole('table', { name: '기간별 사용량', exact: true });
  await expect(table.getByRole('cell', { name: '4.32M', exact: true })).toBeVisible();

  await page.evaluate(async () => {
    window.resolvePreviousAccount();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });

  await expect(secondDialog).toBeVisible();
  await expect(secondDialog).toContainText('other@example.com');
  await expect(secondDialog).not.toContainText('statistics@example.com');
  await expect(secondDialog).not.toContainText('100M');
  await expect(table.getByRole('cell', { name: '4.32M', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.statisticsCalls)).toEqual([
    { method: 'get', id: accountId }, { method: 'refresh', id: accountId },
    { method: 'get', id: otherId }, { method: 'refresh', id: otherId },
  ]);
});

test('앱 창 크기별 토큰 통계와 잔여량 화면을 저장', async ({ page }) => {
  await installMock(page);
  const dialog = await openDetails(page);
  for (const width of [1180, 960]) {
    await page.setViewportSize({ width, height: 680 });
    await dialog.getByRole('tab', { name: '사용량 추이', exact: true }).click();
    await expect(dialog.getByRole('img', { name: '기간별 토큰 사용량 그래프', exact: true })).toBeVisible();
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(680);
    await page.screenshot({ path: `test-results/statistics-tokens-${width}x680.png` });
    await dialog.getByRole('tab', { name: '잔여량 변화', exact: true }).click();
    await expect(dialog.getByRole('img', { name: '사용량 잔여 비율 그래프', exact: true })).toBeVisible();
    await page.screenshot({ path: `test-results/statistics-quota-${width}x680.png` });
  }
});
