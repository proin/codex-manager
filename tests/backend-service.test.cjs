'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { AccountService, profileEnvironment } = require('../electron/account-service.cjs');

const tick = () => new Promise((resolve) => setImmediate(resolve));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const limits = (count = 2) => ({
  rateLimits: { limitId: 'codex', primary: { usedPercent: 75, windowDurationMins: 300, resetsAt: 1_800_000_000 }, secondary: null },
  rateLimitsByLimitId: null, rateLimitResetCredits: { availableCount: count, credits: null },
});

async function harness(t, handler = async () => undefined) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-manager-test-'));
  const calls = [];
  const clients = new Map();
  const options = [];
  class FakeClient extends EventEmitter {
    constructor(config) { super(); this.id = path.basename(config.env.CODEX_HOME); this.closed = false; options.push(config); }
    async start() { return this; }
    async request(method, params) {
      calls.push({ id: this.id, method, params });
      const custom = await handler(this.id, method, params, this);
      if (custom !== undefined) return custom;
      if (method === 'account/read') return { account: { type: 'chatgpt', email: `${this.id}@example.test`, planType: 'plus' } };
      if (method === 'account/rateLimits/read') return limits();
      if (method === 'account/rateLimitResetCredit/consume') return { outcome: 'reset' };
      if (method === 'account/login/start') return { type: params.type, loginId: `login-${this.id}`, authUrl: 'https://auth.openai.com/authorize?state=private-state' };
      return {};
    }
    close() { this.closed = true; this.emit('close'); }
  }
  const config = { dataDir, command: '/example/codex', args: [], clientFactory: (config) => {
    const client = new FakeClient(config); clients.set(client.id, client); return client;
  } };
  const service = new AccountService(config);
  await service.init();
  t.after(async () => { await service.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  async function add(label = '계정') {
    const state = await service.addAccount(label);
    return state.accounts.at(-1).id;
  }
  return { service, config, dataDir, calls, clients, options, add };
}

test('separate profiles, safe permissions, normalized app-server arguments, and environment isolation', async (t) => {
  const h = await harness(t);
  const first = await h.add('첫 계정');
  const second = await h.add('두 번째');
  await h.service.refreshAccounts();
  assert.equal(h.options.length, 2);
  assert.notEqual(h.options[0].env.CODEX_HOME, h.options[1].env.CODEX_HOME);
  assert.deepEqual(h.options[0].args, ['app-server']);
  for (const id of [first, second]) {
    const dir = path.join(h.dataDir, 'profiles', id);
    assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
    assert.equal(await fs.readFile(path.join(dir, 'config.toml'), 'utf8'), 'cli_auth_credentials_store = "keyring"\n');
  }
  assert.equal((await fs.stat(path.join(h.dataDir, 'accounts.json'))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(h.dataDir)).mode & 0o777, 0o700);
  const forbidden = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CHATGPT_ACCESS_TOKEN', 'CODEX_REFRESH_TOKEN_URL_OVERRIDE', 'CODEX_REVOKE_TOKEN_URL_OVERRIDE', 'NODE_OPTIONS'];
  const old = Object.fromEntries(forbidden.map((key) => [key, process.env[key]]));
  try {
    forbidden.forEach((key) => { process.env[key] = 'private-value'; });
    const env = profileEnvironment('/isolated/profile');
    forbidden.forEach((key) => assert.equal(env[key], undefined));
    assert.equal(env.CODEX_HOME, '/isolated/profile');
  } finally {
    for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test('one failed account preserves older usage while other accounts complete, with at most four reads', async (t) => {
  let failId;
  let active = 0;
  let maximum = 0;
  const h = await harness(t, async (id, method) => {
    if (method === 'account/read') {
      active++; maximum = Math.max(maximum, active);
      await pause(5); active--;
    }
    if (method === 'account/rateLimits/read' && id === failId) throw new Error('secret-token-must-not-be-shown');
  });
  for (let i = 0; i < 7; i++) await h.add(`계정 ${i + 1}`);
  await h.service.refreshAccounts();
  const previous = h.service.snapshot().accounts[0];
  failId = previous.id;
  await h.service.refreshAccounts();
  const state = h.service.snapshot();
  const failed = state.accounts[0];
  assert.equal(failed.status, 'error');
  assert.deepEqual(failed.usage, previous.usage);
  assert.equal(failed.lastUpdated, previous.lastUpdated);
  assert.ok(maximum <= 4);
  assert.equal(state.accounts.filter((account) => account.status === 'ready').length, 6);
  assert.deepEqual(state.refresh, { running: false, done: 7, total: 7 });
  assert.ok(!JSON.stringify(state).includes('secret-token'));
});

test('overlapping reads join the same account request', async (t) => {
  const h = await harness(t, async (_id, method) => { if (method === 'account/read') await pause(15); });
  const id = await h.add();
  await Promise.all([h.service.refreshAccounts([id]), h.service.refreshAccounts([id])]);
  assert.equal(h.calls.filter((call) => call.method === 'account/read').length, 1);
  assert.equal(h.calls.filter((call) => call.method === 'account/rateLimits/read').length, 1);
  assert.deepEqual(h.service.snapshot().refresh, { running: false, done: 2, total: 2 });
});

test('reset journal is durable before send, concurrent clicks redeem once, and usage is re-read', async (t) => {
  let h;
  let sentKey;
  h = await harness(t, async (id, method, params) => {
    if (method !== 'account/rateLimitResetCredit/consume') return;
    sentKey = params.idempotencyKey;
    const saved = JSON.parse(await fs.readFile(path.join(h.dataDir, 'accounts.json'), 'utf8'));
    const account = saved.accounts.find((row) => row.id === id);
    assert.equal(account.resetAttempt.idempotencyKey, sentKey);
    assert.equal(account.resetAttempt.status, 'pending');
    await pause(10);
    return { outcome: 'reset' };
  });
  const id = await h.add();
  await h.service.refreshAccounts([id]);
  h.calls.length = 0;
  await Promise.all([h.service.resetAccounts([id]), h.service.resetAccounts([id])]);
  assert.equal(h.calls.filter((call) => call.method.endsWith('/consume')).length, 1);
  assert.deepEqual(h.calls.map((call) => call.method), ['account/read', 'account/rateLimits/read', 'account/rateLimitResetCredit/consume', 'account/read', 'account/rateLimits/read']);
  assert.equal(h.service.snapshot().accounts[0].resetAttempt.outcome, 'reset');
  assert.equal(h.service.snapshot().accounts[0].resetAttempt.needsRefresh, false);
  assert.ok(!JSON.stringify(h.service.snapshot()).includes(sentKey));
});

test('unknown reset result is never retried on startup and explicit retry reuses the original key', async (t) => {
  let attempts = 0;
  const h = await harness(t, async (_id, method) => {
    if (method === 'account/rateLimitResetCredit/consume' && attempts++ === 0) throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' });
    if (method === 'account/rateLimitResetCredit/consume') return { outcome: 'alreadyRedeemed' };
  });
  const id = await h.add();
  await h.service.refreshAccounts([id]);
  await h.service.resetAccounts([id]);
  assert.equal(h.service.snapshot().accounts[0].resetAttempt.status, 'uncertain');
  const firstKey = h.calls.find((call) => call.method.endsWith('/consume')).params.idempotencyKey;
  await h.service.close();
  const reloaded = new AccountService(h.config);
  t.after(() => reloaded.close());
  const before = h.calls.length;
  await reloaded.init();
  assert.equal(h.calls.length, before);
  assert.equal(reloaded.snapshot().accounts[0].resetAttempt.status, 'uncertain');
  await reloaded.resetAccounts([id]);
  const keys = h.calls.filter((call) => call.method.endsWith('/consume')).map((call) => call.params.idempotencyKey);
  assert.deepEqual(keys, [firstKey, firstKey]);
  assert.equal(reloaded.snapshot().accounts[0].resetAttempt.outcome, 'alreadyRedeemed');
});

test('a crash during pending reset restores an uncertain result without network calls', async (t) => {
  const h = await harness(t);
  const id = await h.add();
  await h.service.close();
  const filename = path.join(h.dataDir, 'accounts.json');
  const saved = JSON.parse(await fs.readFile(filename, 'utf8'));
  saved.accounts[0].status = 'loading';
  saved.accounts[0].resetAttempt = { status: 'pending', idempotencyKey: id, needsRefresh: true };
  await fs.writeFile(filename, JSON.stringify(saved));
  const reloaded = new AccountService(h.config);
  t.after(() => reloaded.close());
  const state = await reloaded.init();
  assert.equal(state.accounts[0].resetAttempt.status, 'uncertain');
  assert.equal(h.calls.length, 0);
});

test('an uncertain reset can recover expired login without changing its account or request key', async (t) => {
  let authMode = 'original';
  let attempts = 0;
  const h = await harness(t, async (id, method) => {
    if (method === 'account/read' && authMode === 'expired') return { account: null };
    if (method === 'account/read' && authMode === 'different') return { account: { type: 'chatgpt', email: 'different@example.test', planType: 'plus' } };
    if (method === 'account/rateLimitResetCredit/consume') {
      if (attempts++ === 0) throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' });
      return { outcome: 'alreadyRedeemed' };
    }
  });
  const id = await h.add();
  await h.service.refreshAccounts();
  const originalEmail = h.service.snapshot().accounts[0].email;
  await h.service.resetAccounts([id]);
  const firstKey = h.calls.find((call) => call.method.endsWith('/consume')).params.idempotencyKey;
  authMode = 'expired';
  await h.service.refreshAccounts();
  assert.equal(h.service.snapshot().accounts[0].status, 'signedOut');
  await h.service.login(id);
  authMode = 'different';
  h.clients.get(id).emit('notification', 'account/login/completed', { loginId: `login-${id}`, success: true });
  for (let count = 0; count < 100 && h.service.snapshot().accounts[0].status !== 'error'; count++) await pause(5);
  assert.equal(h.service.snapshot().accounts[0].email, originalEmail);
  await h.service.resetAccounts([id]);
  assert.equal(h.calls.filter((call) => call.method.endsWith('/consume')).length, 1);
  await h.service.login(id);
  authMode = 'original';
  h.clients.get(id).emit('notification', 'account/login/completed', { loginId: `login-${id}`, success: true });
  for (let count = 0; count < 100 && h.service.snapshot().accounts[0].status !== 'ready'; count++) await pause(5);
  await h.service.resetAccounts([id]);
  const consume = h.calls.filter((call) => call.method.endsWith('/consume'));
  assert.equal(consume.length, 2);
  assert.equal(consume[1].params.idempotencyKey, firstKey);
  assert.equal(h.service.snapshot().accounts[0].resetAttempt.outcome, 'alreadyRedeemed');
});

test('failed reset preflight, unknown email, and duplicate emails never consume a credit', async (t) => {
  let mode = 'distinct';
  const h = await harness(t, async (id, method) => {
    if (method !== 'account/read') return;
    if (mode === 'failed') throw new Error('connection unavailable');
    if (mode === 'duplicate') return { account: { type: 'chatgpt', email: 'Same@Example.test', planType: 'plus' } };
    if (mode === 'unknown') return { account: { type: 'chatgpt', email: null, planType: 'plus' } };
  });
  const first = await h.add('첫 계정');
  const second = await h.add('두 번째');
  await h.service.refreshAccounts();
  mode = 'failed';
  await h.service.resetAccounts([first, second]);
  mode = 'unknown';
  await h.service.refreshAccounts();
  await h.service.resetAccounts([first, second]);
  mode = 'duplicate';
  await h.service.refreshAccounts();
  assert.ok(h.service.snapshot().accounts.every((row) => row.warning?.includes('중복')));
  await h.service.resetAccounts([first, second]);
  assert.equal(h.calls.filter((call) => call.method.endsWith('/consume')).length, 0);
});

test('a changed account during reset preflight is blocked and old usage is retained', async (t) => {
  let changed = false;
  const h = await harness(t, async (_id, method) => {
    if (changed && method === 'account/read') return { account: { type: 'chatgpt', email: 'unexpected@example.test', planType: 'pro' } };
  });
  const id = await h.add();
  await h.service.refreshAccounts();
  const before = h.service.snapshot().accounts[0];
  changed = true;
  await h.service.resetAccounts([id]);
  const after = h.service.snapshot().accounts[0];
  assert.equal(after.email, before.email);
  assert.deepEqual(after.usage, before.usage);
  assert.match(after.error, /계정이 변경/);
  assert.equal(h.calls.filter((call) => call.method.endsWith('/consume')).length, 0);
});

test('login returns a URL, completes through notification, and never persists temporary authorization URLs', async (t) => {
  const h = await harness(t);
  const id = await h.add();
  const other = await h.add();
  const state = await h.service.login(id);
  assert.equal(state.accounts[0].status, 'loggingIn');
  assert.equal(state.accounts[0].login.url, 'https://auth.openai.com/authorize?state=private-state');
  await assert.rejects(h.service.login(other), /진행 중인 로그인/);
  assert.ok(!(await fs.readFile(path.join(h.dataDir, 'accounts.json'), 'utf8')).includes('private-state'));
  h.clients.get(id).emit('notification', 'account/login/completed', { loginId: `login-${id}`, success: true });
  for (let count = 0; count < 100 && h.service.snapshot().accounts[0].status !== 'ready'; count++) await pause(5);
  assert.equal(h.service.snapshot().accounts[0].status, 'ready');
  assert.equal(h.service.snapshot().accounts[0].login, undefined);
  assert.ok(h.service.snapshot().accounts[0].usage);
});

test('logout failure preserves account/profile and an untouched local account can be removed without Codex', async (t) => {
  const h = await harness(t, async (_id, method) => { if (method === 'account/logout') throw new Error('secret-keychain-error'); });
  const id = await h.add();
  await h.service.refreshAccounts();
  await assert.rejects(h.service.removeAccount(id), /로그아웃/);
  assert.equal(h.service.snapshot().accounts.length, 1);
  await fs.stat(path.join(h.dataDir, 'profiles', id));
  const untouched = await h.add('미로그인');
  const before = h.calls.length;
  await h.service.removeAccount(untouched);
  assert.equal(h.calls.length, before);
  assert.equal(h.service.snapshot().accounts.length, 1);
});

test('closing while profile creation is pending never spawns a new process', async (t) => {
  const h = await harness(t);
  const id = await h.add();
  let release;
  const original = h.service._prepareProfile.bind(h.service);
  h.service._prepareProfile = async (id) => { await new Promise((resolve) => { release = resolve; }); return original(id); };
  const pending = h.service.refreshAccounts([id]);
  await tick();
  await h.service.close();
  release();
  await pending;
  assert.equal(h.options.length, 0);
});

test('invalid IDs and names do not escape profile storage', async (t) => {
  const h = await harness(t);
  await assert.rejects(h.service.addAccount(' \n '));
  await assert.rejects(h.service.addAccount('x'.repeat(61)));
  await assert.rejects(h.service.removeAccount('../../other-profile'));
  await assert.rejects(h.service.refreshAccounts(['../outside']));
  assert.equal(h.service.snapshot().accounts.length, 0);
});
