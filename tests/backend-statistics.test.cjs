'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { AccountService } = require('../electron/account-service.cjs');
const { tokenUsage, restoreStatistics, recordSnapshot, emptyStatistics } = require('../electron/statistics.cjs');

const pause = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
const recent = (hours = 0) => new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
const quota = () => ({
  rateLimits: null,
  rateLimitsByLimitId: { codex: { limitId: 'codex', limitName: 'Codex', primary: { usedPercent: 13.456, windowDurationMins: 300, resetsAt: 1_800_000_000 }, secondary: null, credits: { balance: '19.75', unlimited: false, hasCredits: true } } },
  rateLimitResetCredits: { availableCount: 2 },
});
const usage = () => ({ summary: { lifetimeTokens: 1234, peakDailyTokens: null, longestRunningTurnSec: 12.75, currentStreakDays: 3, longestStreakDays: 4 }, dailyUsageBuckets: [{ startDate: '2026-10-01', tokens: 765 }, { startDate: '2026-10-02', tokens: 469 }] });

async function harness(t, handler = async () => undefined) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-manager-statistics-'));
  const calls = [];
  const clients = [];
  class FakeClient extends EventEmitter {
    constructor(config) { super(); this.id = path.basename(config.env.CODEX_HOME); this.closed = false; clients.push(this); }
    async start() { return this; }
    async request(method, params) {
      calls.push({ id: this.id, method, params });
      const custom = await handler(this.id, method, params, this);
      if (custom !== undefined) return custom;
      if (method === 'account/read') return { account: { type: 'chatgpt', email: `${this.id}@example.test`, planType: 'plus' } };
      if (method === 'account/rateLimits/read') return quota();
      if (method === 'account/usage/read') return usage();
      if (method.endsWith('/consume')) return { outcome: 'reset' };
      if (method === 'account/login/start') return { loginId: `login-${this.id}`, authUrl: 'https://auth.openai.com/authorize' };
      return {};
    }
    close() { this.closed = true; this.emit('close'); }
  }
  const config = { dataDir, command: '/mock/codex', clientFactory: (options) => new FakeClient(options) };
  const service = new AccountService(config);
  await service.init();
  t.after(async () => { await service.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  async function add() { return (await service.addAccount('계정')).accounts.at(-1).id; }
  return { service, config, dataDir, calls, clients, add };
}

test('details are cached, private from the list, precision preserving, and persisted across restarts', async (t) => {
  const h = await harness(t);
  const id = await h.add();
  await h.service.refreshAccounts([id]);
  const beforeCalls = h.calls.length;
  const cached = h.service.getAccountDetails(id);
  assert.equal(h.calls.length, beforeCalls);
  assert.equal(cached.accountId, id);
  assert.equal(cached.snapshots.length, 1);
  assert.equal(cached.snapshots[0].buckets[0].primary.usedPercent, 13.456);
  assert.equal(cached.snapshots[0].creditBalance, 19.75);
  assert.equal(cached.tokenUsage, null);
  cached.snapshots[0].creditBalance = 999;
  assert.equal(h.service.getAccountDetails(id).snapshots[0].creditBalance, 19.75);
  const fresh = await h.service.refreshAccountDetails(id);
  assert.deepEqual(h.calls.slice(beforeCalls).map((row) => row.method), ['account/read', 'account/usage/read']);
  assert.deepEqual(fresh.tokenUsage, usage());
  assert.equal(fresh.usageError, null);
  assert.ok(fresh.usageFetchedAt);
  assert.ok(!JSON.stringify(h.service.snapshot()).includes('snapshots'));
  assert.ok(!JSON.stringify(h.service.snapshot()).includes('lifetimeTokens'));
  await h.service.close();
  const reloaded = new AccountService(h.config);
  t.after(() => reloaded.close());
  const calls = h.calls.length;
  await reloaded.init();
  assert.equal(h.calls.length, calls);
  assert.deepEqual(reloaded.getAccountDetails(id), fresh);
});

test('official nullable fields and missing daily dates are not fabricated as zero', () => {
  assert.deepEqual(tokenUsage({ summary: null, dailyUsageBuckets: null }), { summary: null, dailyUsageBuckets: null });
  assert.deepEqual(tokenUsage({ summary: null, dailyUsageBuckets: [] }), { summary: null, dailyUsageBuckets: [] });
  assert.equal(tokenUsage({ bogus: true }), null);
  const normalized = tokenUsage({ summary: { lifetimeTokens: '99', longestRunningTurnSec: 4.5 }, dailyUsageBuckets: [
    { startDate: '2026-10-03', tokens: 0 }, { startDate: '2026-10-01', tokens: 10 },
    { startDate: '2026-10-01', tokens: 11 }, { startDate: '2026-02-30', tokens: 30 },
    { startDate: '2026-10-04', tokens: -1 }, { startDate: 'unknown', tokens: 100 },
  ] });
  assert.equal(normalized.summary.lifetimeTokens, null);
  assert.equal(normalized.summary.longestRunningTurnSec, 4.5);
  assert.deepEqual(normalized.dailyUsageBuckets, [{ startDate: '2026-10-01', tokens: 11 }, { startDate: '2026-10-03', tokens: 0 }]);
});

test('a detail API failure preserves normal quota, completed reset, and the previous token response', async (t) => {
  let failed = false;
  const h = await harness(t, async (_id, method) => {
    if (failed && method === 'account/usage/read') throw Object.assign(new Error('private-response'), { code: -32601 });
  });
  const id = await h.add();
  await h.service.refreshAccounts([id]);
  await h.service.resetAccounts([id]);
  await h.service.refreshAccountDetails(id);
  const previous = h.service.getAccountDetails(id);
  const normal = h.service.snapshot().accounts[0];
  failed = true;
  const fresh = await h.service.refreshAccountDetails(id);
  assert.deepEqual(h.service.snapshot().accounts[0], normal);
  assert.deepEqual(fresh.tokenUsage, previous.tokenUsage);
  assert.equal(fresh.usageFetchedAt, previous.usageFetchedAt);
  assert.match(fresh.usageError, /지원하지 않습니다/);
  assert.ok(!JSON.stringify(fresh).includes('private-response'));
  assert.equal(h.clients.at(-1).closed, true);
});

test('one reset request remains one event when an uncertain result is recovered after restart', async (t) => {
  let attempts = 0;
  const h = await harness(t, async (_id, method) => {
    if (method.endsWith('/consume')) {
      if (attempts++ === 0) throw Object.assign(new Error('lost reply'), { code: 'TIMEOUT' });
      return { outcome: 'alreadyRedeemed' };
    }
  });
  const id = await h.add();
  await h.service.refreshAccounts([id]);
  await h.service.resetAccounts([id]);
  const unknown = h.service.getAccountDetails(id).resets;
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].outcome, 'uncertain');
  assert.equal(unknown[0].usedCount, null);
  assert.equal(unknown[0].timeKind, 'requested');
  const privateKey = h.calls.find((row) => row.method.endsWith('/consume')).params.idempotencyKey;
  assert.ok(!JSON.stringify(h.service.getAccountDetails(id)).includes(privateKey));
  await h.service.close();
  const reloaded = new AccountService(h.config);
  t.after(() => reloaded.close());
  await reloaded.init();
  await reloaded.resetAccounts([id]);
  const recovered = reloaded.getAccountDetails(id).resets;
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].id, unknown[0].id);
  assert.equal(recovered[0].requestedAt, unknown[0].requestedAt);
  assert.equal(recovered[0].outcome, 'alreadyRedeemed');
  assert.equal(recovered[0].usedCount, 1);
  assert.equal(recovered[0].timeKind, 'confirmed');
});

test('only reset and already-redeemed consume one; other completed outcomes consume zero', async (t) => {
  const outcomes = ['reset', 'nothingToReset', 'noCredit'];
  const h = await harness(t, async (_id, method) => method.endsWith('/consume') ? { outcome: outcomes.shift() } : undefined);
  const id = await h.add();
  await h.service.refreshAccounts([id]);
  await h.service.resetAccounts([id]);
  await h.service.resetAccounts([id]);
  await h.service.resetAccounts([id]);
  const events = h.service.getAccountDetails(id).resets;
  assert.deepEqual(events.map((row) => row.outcome), ['reset', 'nothingToReset', 'noCredit']);
  assert.deepEqual(events.map((row) => row.usedCount), [1, 0, 0]);
  assert.ok(events.every((row) => row.timeKind === 'completed'));
});

test('legacy storage migrates the saved quota and reset date once without making up older events', async (t) => {
  const h = await harness(t);
  const id = await h.add();
  await h.service.close();
  const filename = path.join(h.dataDir, 'accounts.json');
  const saved = JSON.parse(await fs.readFile(filename, 'utf8'));
  const row = saved.accounts[0];
  delete row.statistics;
  row.email = 'legacy@example.test';
  row.usage = quota();
  row.lastUpdated = recent(1);
  row.resetAttempt = { idempotencyKey: randomUUID(), accountEmail: row.email, status: 'completed', outcome: 'reset', startedAt: recent(3), completedAt: recent(2) };
  await fs.writeFile(filename, JSON.stringify(saved));
  for (let iteration = 0; iteration < 2; iteration++) {
    const reloaded = new AccountService(h.config);
    await reloaded.init();
    const details = reloaded.getAccountDetails(id);
    assert.equal(details.snapshots.length, 1);
    assert.equal(details.snapshots[0].time, row.lastUpdated);
    assert.equal(details.resets.length, 1);
    assert.equal(details.resets[0].time, row.resetAttempt.completedAt);
    assert.equal(details.trackingStartedAt, row.resetAttempt.startedAt);
    await reloaded.close();
  }
  assert.equal(h.calls.length, 0);
});

test('an identity mismatch cannot read detailed usage; changing login clears the old identity history', async (t) => {
  let changed = false;
  const h = await harness(t, async (_id, method) => changed && method === 'account/read'
    ? { account: { type: 'chatgpt', email: 'different@example.test', planType: 'pro' } } : undefined);
  const id = await h.add();
  await h.service.refreshAccounts([id]);
  await h.service.resetAccounts([id]);
  await h.service.refreshAccountDetails(id);
  const normal = h.service.snapshot().accounts[0];
  changed = true;
  const calls = h.calls.length;
  const rejected = await h.service.refreshAccountDetails(id);
  assert.deepEqual(h.calls.slice(calls).map((row) => row.method), ['account/read']);
  assert.deepEqual(h.service.snapshot().accounts[0], normal);
  assert.match(rejected.usageError, /계정이 변경/);
  await h.service.refreshAccounts([id]);
  const changedDetails = h.service.getAccountDetails(id);
  assert.equal(changedDetails.email, 'different@example.test');
  assert.equal(changedDetails.tokenUsage, null);
  assert.equal(changedDetails.resets.length, 0);
  assert.equal(changedDetails.snapshots.length, 1);
  assert.equal(h.service.snapshot().accounts[0].resetAttempt, undefined);
});

test('a new identity with failed quota retrieval cannot inherit the former account quota', async (t) => {
  let changed = false;
  const h = await harness(t, async (_id, method) => {
    if (changed && method === 'account/read') return { account: { type: 'chatgpt', email: 'new@example.test', planType: 'plus' } };
    if (changed && method === 'account/rateLimits/read') throw new Error('unavailable');
  });
  const id = await h.add();
  await h.service.refreshAccounts([id]);
  await h.service.refreshAccountDetails(id);
  changed = true;
  await h.service.refreshAccounts([id]);
  const account = h.service.snapshot().accounts[0];
  assert.equal(account.email, 'new@example.test');
  assert.equal(account.usage, null);
  assert.equal(account.lastUpdated, null);
  const details = h.service.getAccountDetails(id);
  assert.equal(details.tokenUsage, null);
  assert.deepEqual(details.snapshots, []);
});

test('overlapping detail requests join and queued reset and quota refresh do not deadlock or close the active reader', async (t) => {
  let release;
  const h = await harness(t, async (_id, method, _params, client) => {
    if (method !== 'account/usage/read') return;
    await new Promise((resolve) => { release = resolve; });
    assert.equal(client.closed, false);
    return usage();
  });
  const id = await h.add();
  await h.service.refreshAccounts([id]);
  const detail = h.service.refreshAccountDetails(id);
  assert.equal(h.service.refreshAccountDetails(id), detail);
  for (let i = 0; i < 100 && !release; i++) await pause();
  assert.ok(release);
  const reset = h.service.resetAccounts([id]);
  const refresh = h.service.refreshAccounts([id]);
  await pause();
  assert.equal(h.calls.filter((row) => row.method.endsWith('/consume')).length, 0);
  release();
  await Promise.all([detail, reset, refresh]);
  assert.equal(h.calls.filter((row) => row.method === 'account/usage/read').length, 1);
  assert.equal(h.calls.filter((row) => row.method.endsWith('/consume')).length, 1);
  assert.equal(h.service.snapshot().accounts[0].status, 'ready');
  assert.equal(h.clients.at(-1).closed, true);
});

test('starting login waits for detailed reads and discards their old response', async (t) => {
  let release;
  const h = await harness(t, async (_id, method) => {
    if (method === 'account/usage/read') { await new Promise((resolve) => { release = resolve; }); return usage(); }
  });
  const id = await h.add();
  await h.service.refreshAccounts([id]);
  const reading = h.service.refreshAccountDetails(id);
  for (let i = 0; i < 100 && !release; i++) await pause();
  const loggingIn = h.service.login(id);
  await pause();
  assert.equal(h.calls.filter((row) => row.method === 'account/login/start').length, 0);
  release();
  await Promise.all([reading, loggingIn]);
  assert.equal(h.service.getAccountDetails(id).tokenUsage, null);
  assert.equal(h.service.snapshot().accounts[0].status, 'loggingIn');
});

test('removal waits for a detail reader before logging out and removes only its profile', async (t) => {
  let release;
  const h = await harness(t, async (_id, method) => {
    if (method === 'account/usage/read') { await new Promise((resolve) => { release = resolve; }); return usage(); }
  });
  const id = await h.add();
  const other = await h.add();
  await h.service.refreshAccounts([id]);
  const reading = h.service.refreshAccountDetails(id);
  for (let i = 0; i < 100 && !release; i++) await pause();
  const removal = h.service.removeAccount(id);
  await pause();
  assert.equal(h.calls.filter((row) => row.method === 'account/logout').length, 0);
  release();
  await Promise.all([reading, removal]);
  assert.deepEqual(h.service.snapshot().accounts.map((row) => row.id), [other]);
});

test('quota retention drops old points and caps volume while preserving tracking start', () => {
  const email = 'sample@example.test';
  const trackingStart = recent(24 * 120);
  const statistics = emptyStatistics(email, trackingStart);
  recordSnapshot(statistics, quota(), recent(24 * 100));
  recordSnapshot(statistics, quota(), recent(1));
  assert.equal(statistics.snapshots.length, 1);
  assert.equal(statistics.trackingStartedAt, trackingStart);
  const point = statistics.snapshots[0];
  const restored = restoreStatistics({ ...statistics, snapshots: Array.from({ length: 10_010 }, () => point), extraSecret: 'private' }, { id: randomUUID(), email }, recent());
  assert.equal(restored.snapshots.length, 10_000);
  assert.equal(restored.extraSecret, undefined);
  assert.equal(restored.trackingStartedAt, statistics.trackingStartedAt);
});
