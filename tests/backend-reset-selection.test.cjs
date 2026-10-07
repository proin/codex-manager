'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { AccountService, validateResetSelections } = require('../electron/account-service.cjs');

const seconds = () => Math.floor(Date.now() / 1000);
const credit = (id = 'chosen-credit', properties = {}) => ({
  id, resetType: 'codexRateLimits', status: 'available',
  grantedAt: seconds() - 86400, expiresAt: seconds() + 86400,
  title: '초기화권', description: null, ...properties,
});
const limits = (credits, availableCount = 2) => ({
  rateLimits: { limitId: 'codex', primary: { usedPercent: 75, windowDurationMins: 300, resetsAt: seconds() + 500 }, secondary: null },
  rateLimitsByLimitId: null, rateLimitResetCredits: { availableCount, credits },
});

async function harness(t, handler = async () => undefined) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-selected-credit-test-'));
  const calls = [];
  class Client extends EventEmitter {
    constructor(options) { super(); this.id = path.basename(options.env.CODEX_HOME); }
    async start() { return this; }
    async request(method, params) {
      calls.push({ id: this.id, method, params });
      const response = await handler(this.id, method, params);
      if (response !== undefined) return response;
      if (method === 'account/read') return { account: { type: 'chatgpt', email: `${this.id}@example.test`, planType: 'plus' } };
      if (method === 'account/rateLimits/read') return limits([credit('first-credit'), credit()]);
      if (method.endsWith('/consume')) return { outcome: 'reset' };
      return {};
    }
    close() { this.emit('close'); }
  }
  const config = { dataDir, command: '/example/codex', clientFactory: options => new Client(options) };
  const service = new AccountService(config);
  await service.init();
  const id = (await service.addAccount('계정')).accounts[0].id;
  await service.refreshAccounts([id]);
  calls.length = 0;
  t.after(async () => { await service.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { service, config, id, calls, dataDir };
}

test('selected credit is re-read, persisted before consume, and returned in the public attempt', async t => {
  let h;
  h = await harness(t, async (id, method, params) => {
    if (!method.endsWith('/consume')) return;
    const saved = JSON.parse(await fs.readFile(path.join(h.dataDir, 'accounts.json'), 'utf8'));
    const attempt = saved.accounts.find(row => row.id === id).resetAttempt;
    assert.equal(attempt.creditId, 'chosen-credit');
    assert.equal(attempt.idempotencyKey, params.idempotencyKey);
    assert.equal(attempt.status, 'pending');
  });
  await h.service.resetAccounts([h.id], { [h.id]: 'chosen-credit' });
  const consume = h.calls.find(call => call.method.endsWith('/consume'));
  assert.equal(consume.params.creditId, 'chosen-credit');
  assert.deepEqual(h.calls.map(call => call.method), [
    'account/read', 'account/rateLimits/read', 'account/rateLimitResetCredit/consume',
    'account/read', 'account/rateLimits/read',
  ]);
  const attempt = h.service.snapshot().accounts[0].resetAttempt;
  assert.equal(attempt.creditId, 'chosen-credit');
  assert.equal(attempt.outcome, 'reset');
  assert.equal(attempt.idempotencyKey, undefined);
});

test('selection must still be valid in the refreshed account list before consumption', async t => {
  const cases = [
    ['no details', null, /목록을 조회/],
    ['empty details', [], /찾을 수 없습니다/],
    ['different credit', [credit('other')], /찾을 수 없습니다/],
    ['duplicate credit id', [credit(), credit()], /찾을 수 없습니다/],
    ['redeemed', [credit('chosen-credit', { status: 'redeemed' })], /사용할 수 없습니다/],
    ['redeeming', [credit('chosen-credit', { status: 'redeeming' })], /사용할 수 없습니다/],
    ['unknown status', [credit('chosen-credit', { status: 'unknown' })], /사용할 수 없습니다/],
    ['unknown type', [credit('chosen-credit', { resetType: 'unknown' })], /이 앱에서 사용할/],
    ['expired', [credit('chosen-credit', { expiresAt: seconds() - 1 })], /사용기간이 지났/],
    ['future', [credit('chosen-credit', { grantedAt: seconds() + 3600 })], /아직 사용할/],
    ['invalid grant', [credit('chosen-credit', { grantedAt: null })], /사용기간을 확인/],
    ['invalid expiry', [credit('chosen-credit', { expiresAt: 'tomorrow' })], /사용기간을 확인/],
    ['reversed dates', [credit('chosen-credit', { expiresAt: seconds() - 172800 })], /사용기간을 확인/],
  ];
  for (const [name, details, expected] of cases) {
    await t.test(name, async tt => {
      let stale = false;
      const h = await harness(tt, async (_id, method) => {
        if (stale && method === 'account/rateLimits/read') return limits(details);
      });
      stale = true;
      await h.service.resetAccounts([h.id], { [h.id]: 'chosen-credit' });
      assert.equal(h.calls.filter(call => call.method.endsWith('/consume')).length, 0);
      assert.equal(h.service.snapshot().accounts[0].resetAttempt, undefined);
      assert.match(h.service.snapshot().accounts[0].error, expected);
    });
  }
});

test('credits without an expiration can be selected without inventing a deadline', async t => {
  for (const expiry of [null, undefined]) {
    await t.test(String(expiry), async tt => {
      const h = await harness(tt, async (_id, method) => {
        if (method === 'account/rateLimits/read') return limits([credit('chosen-credit', { expiresAt: expiry })]);
      });
      await h.service.resetAccounts([h.id], { [h.id]: 'chosen-credit' });
      assert.equal(h.calls.filter(call => call.method.endsWith('/consume')).length, 1);
    });
  }
});

test('uncertain retries preserve the selected credit and request key after restart, even if the credit disappeared', async t => {
  let attempts = 0;
  let disappeared = false;
  const h = await harness(t, async (_id, method) => {
    if (method === 'account/rateLimits/read' && disappeared) return limits([], 0);
    if (method.endsWith('/consume')) {
      if (attempts++ === 0) { disappeared = true; throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' }); }
      return { outcome: 'alreadyRedeemed' };
    }
  });
  await h.service.resetAccounts([h.id], { [h.id]: 'chosen-credit' });
  assert.equal(h.service.snapshot().accounts[0].resetAttempt.status, 'uncertain');
  const first = h.calls.find(call => call.method.endsWith('/consume')).params;
  await h.service.close();
  const reloaded = new AccountService(h.config);
  t.after(() => reloaded.close());
  await reloaded.init();
  assert.equal(reloaded.snapshot().accounts[0].resetAttempt.creditId, 'chosen-credit');
  await assert.rejects(reloaded.resetAccounts([h.id], { [h.id]: 'first-credit' }), /같은 초기화권/);
  assert.equal(h.calls.filter(call => call.method.endsWith('/consume')).length, 1);
  await reloaded.resetAccounts([h.id], null);
  const consume = h.calls.filter(call => call.method.endsWith('/consume'));
  assert.equal(consume.length, 2);
  assert.deepEqual(consume[1].params, first);
  assert.equal(reloaded.snapshot().accounts[0].resetAttempt.outcome, 'alreadyRedeemed');
});

test('overlapping identical selections share a request and a different selection is rejected', async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let entered;
  const consuming = new Promise(resolve => { entered = resolve; });
  const h = await harness(t, async (_id, method) => {
    if (!method.endsWith('/consume')) return;
    entered();
    await held;
  });
  const first = h.service.resetAccounts([h.id], { [h.id]: 'chosen-credit' });
  await consuming;
  const duplicate = h.service.resetAccounts([h.id], { [h.id]: 'chosen-credit' });
  await assert.rejects(h.service.resetAccounts([h.id], { [h.id]: 'first-credit' }), /처리가 끝난/);
  release();
  await Promise.all([first, duplicate]);
  assert.equal(h.calls.filter(call => call.method.endsWith('/consume')).length, 1);
});

test('invalid persisted selected credit cannot silently fall back to automatic redemption', async t => {
  const h = await harness(t, async (_id, method) => {
    if (method.endsWith('/consume')) throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' });
  });
  await h.service.resetAccounts([h.id], { [h.id]: 'chosen-credit' });
  await h.service.close();
  const filename = path.join(h.dataDir, 'accounts.json');
  const saved = JSON.parse(await fs.readFile(filename, 'utf8'));
  saved.accounts[0].resetAttempt.creditId = { invalid: true };
  const content = JSON.stringify(saved);
  await fs.writeFile(filename, content);
  const before = h.calls.length;
  const reloaded = new AccountService(h.config);
  t.after(() => reloaded.close());
  await assert.rejects(reloaded.init(), /저장된 초기화권 정보/);
  assert.equal(h.calls.length, before);
  assert.equal(await fs.readFile(filename, 'utf8'), content);
});

test('IPC selection validation requires every new account, rejects malformed or unrelated data, and permits only original-credit retries', () => {
  const accounts = [{ id: 'a' }, { id: 'b' }];
  const requireSelection = { requireSelection: true };
  for (const bad of [null, undefined, {}, [], 'credit', 4, { a: 'chosen-credit', b: '' }, { a: 'chosen-credit' }, { a: 'chosen-credit', b: 'other', c: 'extra' }, { a: 'chosen-credit', b: 'x\n' }, new Date()]) {
    assert.throws(() => validateResetSelections(['a', 'b'], bad, accounts, requireSelection), /선택|정보/);
  }
  const valid = { a: 'credit-a', b: 'credit-b' };
  assert.deepEqual(validateResetSelections(['a', 'b'], valid, accounts, requireSelection), valid);
  assert.equal(validateResetSelections(['a'], null, accounts), null);
  const retry = [{ id: 'a', resetAttempt: { status: 'uncertain', creditId: 'original' } }];
  assert.equal(validateResetSelections(['a'], null, retry, requireSelection), null);
  assert.deepEqual(validateResetSelections(['a'], { a: 'original' }, retry, requireSelection), { a: 'original' });
  assert.throws(() => validateResetSelections(['a'], { a: 'different' }, retry, requireSelection), /같은 초기화권/);
  assert.throws(() => validateResetSelections(['missing'], null, accounts, requireSelection), /계정을 찾을/);
});
