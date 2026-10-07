'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { HostService } = require('../electron/host-service.cjs');
const { loginCodexOnHost, validateDeviceLogin } = require('../electron/host-device-auth.cjs');
const { runProcess } = require('../electron/host-ssh.cjs');

const host = { id: 'host-one', alias: 'one', hostName: '192.0.2.1', user: 'operator', port: '22', identityFile: '', proxyJump: '', optionsText: '', connectable: true, groupId: null };
const codex = { available: true, version: '0.149.0', accountEmail: 'before@example.invalid', accountPlan: 'pro', loginStatus: 'chatgpt', installMethod: 'npm' };
const login = { type: 'chatgptDeviceCode', loginId: 'fixture-login', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-EFGH' };

async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Fixture did not finish');
    await new Promise(resolve => setImmediate(resolve));
  }
}

function protocolFixture(options = {}) {
  const fixture = { requests: [], states: [], finishCount: 0, signal: null, send: null };
  fixture.run = async (command, args, settings) => {
    fixture.command = command; fixture.args = args; fixture.settings = settings; fixture.signal = settings.signal;
    let resolve;
    const pending = new Promise(done => { resolve = done; });
    const finish = (result, terminate) => {
      fixture.finishCount += 1;
      fixture.terminated = Boolean(terminate);
      resolve({ stdout: '', stderr: '', ...result });
    };
    const child = { stdin: { write(text) {
      for (const line of text.trim().split('\n')) {
        const message = JSON.parse(line); fixture.requests.push(message);
        if (message.method === 'initialize') queueMicrotask(() => fixture.send({ id: 1, ...(options.initError ? { error: { message: 'DO_NOT_RETURN' } } : { result: {} }) }));
        if (message.method === 'account/login/start' && !options.holdStart) queueMicrotask(() => {
          if (options.early) fixture.send({ method: 'account/login/completed', params: { loginId: login.loginId, success: true } });
          fixture.send({ id: 2, ...(options.startError ? { error: { message: 'DO_NOT_RETURN' } } : { result: options.login || login }) });
          if (options.complete) fixture.send({ method: 'account/login/completed', params: { loginId: login.loginId, success: true } });
        });
        if (message.method === 'account/read') queueMicrotask(() => fixture.send({ id: 3, result: { account: { type: 'chatgpt', email: 'after@example.invalid', planType: 'plus', accessToken: 'DO_NOT_RETURN', refreshToken: 'DO_NOT_RETURN' } } }));
        if (message.method === 'account/login/cancel') queueMicrotask(() => fixture.send({ id: 4, result: { status: 'canceled' } }));
      }
    } } };
    fixture.send = message => {
      const text = `${typeof message === 'string' ? message : JSON.stringify(message)}\n`;
      // Exercise fragmented protocol lines, including a split JSON string.
      const midpoint = Math.floor(text.length / 2);
      settings.onStdout(text.slice(0, midpoint), child, finish);
      settings.onStdout(text.slice(midpoint), child, finish);
    };
    settings.signal.addEventListener('abort', () => resolve({ code: 255, canceled: true, stdout: '', stderr: '' }), { once: true });
    if (settings.signal.aborted) { resolve({ code: 255, canceled: true }); return pending; }
    fixture.send(`CODEX_MANAGER_META ${JSON.stringify(options.unavailable ? { available: false } : { available: true, version: '0.149.0', installMethod: 'npm' })}`);
    if (!fixture.finishCount) settings.onStart(child);
    return pending;
  };
  return fixture;
}

test('remote device auth exposes only the URL and code and verifies the resulting account', async () => {
  const fixture = protocolFixture({ complete: true });
  const result = await loginCodexOnHost(fixture.run, '/tmp/config', host, { onState: state => fixture.states.push(state) });
  assert.deepEqual(fixture.requests.map(item => item.method), ['initialize', 'initialized', 'account/login/start', 'account/read']);
  assert.deepEqual(fixture.requests[2].params, { type: 'chatgptDeviceCode' });
  assert.equal(fixture.requests[3].params.refreshToken, false);
  assert.deepEqual(fixture.states, [{ status: 'waiting', url: login.verificationUrl, userCode: login.userCode }, { status: 'verifying' }]);
  assert.equal(result.accountEmail, 'after@example.invalid');
  assert.equal(result.loginStatus, 'chatgpt');
  assert.equal(JSON.stringify({ result, states: fixture.states }).includes('DO_NOT_RETURN'), false);
  assert.equal(fixture.settings.captureOutput, false);
  assert.equal(fixture.terminated, true);
  assert.match(fixture.args.at(-1), /app-server/);
  assert.doesNotMatch(fixture.args.at(-1), /auth\.json|logout|CODEX_HOME=/);
});

test('early completion is matched by login ID and duplicate completion does not reread the account', async () => {
  const fixture = protocolFixture({ early: true, complete: true });
  const result = await loginCodexOnHost(fixture.run, '/tmp/config', host);
  assert.equal(result.accountEmail, 'after@example.invalid');
  assert.equal(fixture.requests.filter(item => item.method === 'account/read').length, 1);
});

test('stale notifications and unsolicited account results do not complete a device login', async () => {
  const fixture = protocolFixture();
  const task = loginCodexOnHost(fixture.run, '/tmp/config', host);
  await until(() => fixture.requests.some(item => item.method === 'account/login/start'));
  fixture.send({ id: 3, result: { account: { type: 'chatgpt', email: 'stale@example.invalid' } } });
  fixture.send({ method: 'account/login/completed', params: { loginId: 'old-login', success: true } });
  assert.equal(fixture.requests.filter(item => item.method === 'account/read').length, 0);
  fixture.send({ method: 'account/login/completed', params: { loginId: login.loginId, success: true } });
  assert.equal((await task).accountEmail, 'after@example.invalid');
});

test('device login rejects untrusted URLs, credentials, ports and malformed codes', () => {
  for (const verificationUrl of ['http://auth.openai.com/device', 'https://auth.openai.com.example.invalid/device', 'https://user@auth.openai.com/device', 'https://user:pass@auth.openai.com/device', 'https://auth.openai.com:444/device', 'https://example.invalid/device', 'javascript:alert(1)', 'https://auth.openai.com/device\n']) {
    assert.throws(() => validateDeviceLogin({ ...login, verificationUrl }), /로그인 주소|로그인 코드/);
  }
  for (const userCode of ['', 'ABCD\nEFGH', '<script>', 'X'.repeat(65)]) assert.throws(() => validateDeviceLogin({ ...login, userCode }));
  for (const verificationUrl of ['https://auth.openai.com/device', 'https://auth0.openai.com/device', 'https://chatgpt.com/device']) assert.equal(validateDeviceLogin({ ...login, verificationUrl }).url, verificationUrl);
});

test('invalid login responses and RPC errors never expose remote error messages', async () => {
  for (const options of [{ login: { ...login, verificationUrl: 'https://example.invalid/device' } }, { startError: true }, { initError: true }]) {
    const fixture = protocolFixture(options);
    await assert.rejects(loginCodexOnHost(fixture.run, '/tmp/config', host), error => !error.message.includes('DO_NOT_RETURN'));
    assert.equal(fixture.requests.some(item => item.method === 'account/read'), false);
    assert.equal(fixture.terminated, true);
  }
});

test('canceling a waiting login sends the matching cancel RPC and terminates its process', async () => {
  const fixture = protocolFixture(); const controller = new AbortController();
  const task = loginCodexOnHost(fixture.run, '/tmp/config', host, { signal: controller.signal });
  await until(() => fixture.requests.some(item => item.method === 'account/login/start'));
  controller.abort();
  fixture.send({ method: 'account/login/completed', params: { loginId: login.loginId, success: true } });
  await assert.rejects(task, error => error.kind === 'canceled');
  assert.deepEqual(fixture.requests.find(item => item.method === 'account/login/cancel').params, { loginId: login.loginId });
  assert.equal(fixture.signal.aborted, true);
  assert.equal(fixture.requests.some(item => item.method === 'account/read'), false);
});

test('canceling before a code arrives terminates SSH without starting another flow', async () => {
  const fixture = protocolFixture({ holdStart: true }); const controller = new AbortController();
  const task = loginCodexOnHost(fixture.run, '/tmp/config', host, { signal: controller.signal });
  await until(() => fixture.requests.some(item => item.method === 'account/login/start'));
  controller.abort();
  await assert.rejects(task, error => error.kind === 'canceled');
  assert.equal(fixture.signal.aborted, true);
  assert.equal(fixture.requests.some(item => item.method === 'account/login/cancel'), false);
});

test('device flow has a finite timeout and missing Codex does not request login', async () => {
  const timed = protocolFixture();
  await assert.rejects(loginCodexOnHost(timed.run, '/tmp/config', host, { timeoutMs: 12 }), error => error.kind === 'timeout');
  assert.equal(timed.signal.aborted, true);
  assert.ok(timed.requests.some(item => item.method === 'account/login/cancel'));
  const missing = protocolFixture({ unavailable: true });
  await assert.rejects(loginCodexOnHost(missing.run, '/tmp/config', host), /설치되어 있지 않습니다/);
  assert.deepEqual(missing.requests, []);
});

test('login process output and logs are not retained by the process runner', async () => {
  const result = await runProcess(process.execPath, ['-e', 'process.stdout.write("FIXTURE_PRIVATE_REPLY");process.stderr.write("FIXTURE_PRIVATE_LOG")'], { captureOutput: false, timeoutMs: 5000 });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('a local stdio process completes the device protocol without any SSH connection', async () => {
  const processCode = `
    const readline = require('node:readline');
    const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
    process.stdout.write('CODEX_MANAGER_META {"available":true,"version":"0.149.0","installMethod":"npm"}\\n');
    process.stderr.write('FIXTURE_PRIVATE_LOG\\n');
    readline.createInterface({ input: process.stdin }).on('line', line => {
      const request = JSON.parse(line);
      if (request.method === 'initialize') send({ id: request.id, result: {} });
      if (request.method === 'account/login/start') {
        send({ id: request.id, result: ${JSON.stringify(login)} });
        setTimeout(() => send({ method: 'account/login/completed', params: { loginId: 'fixture-login', success: true } }), 5);
      }
      if (request.method === 'account/read') send({ id: request.id, result: { account: { type: 'chatgpt', email: 'stdio@example.invalid', accessToken: 'FIXTURE_PRIVATE_REPLY' } } });
    });
  `;
  let processResult;
  const run = async (_command, _args, settings) => { processResult = await runProcess(process.execPath, ['-e', processCode], settings); return processResult; };
  const account = await loginCodexOnHost(run, '/tmp/unused-config', host, { timeoutMs: 2000 });
  assert.equal(account.accountEmail, 'stdio@example.invalid');
  assert.equal(JSON.stringify(account).includes('FIXTURE_PRIVATE_REPLY'), false);
  assert.equal(processResult.code, 0);
  assert.equal(processResult.stdout, '');
  assert.equal(processResult.stderr, '');
});

test('remote server requests are declined without exposing or requesting credentials', async () => {
  const fixture = protocolFixture(); const controller = new AbortController();
  const task = loginCodexOnHost(fixture.run, '/tmp/config', host, { signal: controller.signal });
  await until(() => fixture.requests.some(item => item.method === 'account/login/start'));
  fixture.send({ id: 91, method: 'account/chatgptAuthTokens/refresh', params: {} });
  assert.deepEqual(fixture.requests.find(item => item.id === 91), { id: 91, error: { code: -32601, message: 'Unsupported server request' } });
  controller.abort();
  await assert.rejects(task, error => error.kind === 'canceled');
});

function serviceFixture(options = {}) {
  let config = { configPath: '/tmp/config', revision: 'one', connectionRevision: 'ssh-one', groups: [], hosts: [{ ...host }] };
  const fixture = { requests: [], states: [], complete: null, signal: null, loginCalls: 0 };
  const store = { read: async () => structuredClone(config), ...options.store };
  fixture.setConfig = value => { config = { ...config, ...value }; };
  fixture.service = new HostService({
    configStore: store,
    keyStore: { status: async () => ({ privateExists: true, privateKeyPath: '/tmp/fixture-key' }) },
    effectiveConfig: async () => ({ hostName: host.hostName, user: host.user, port: host.port, identities: [] }),
    runCommand: async (_command, args) => { fixture.requests.push(args); return { code: 0, stdout: 'hostname one\nuser operator\nport 22\nproxyjump none\n' }; },
    probe: async () => codex,
    deviceLogin: async (_run, _path, _host, settings) => {
      fixture.loginCalls += 1; fixture.signal = settings.signal;
      settings.onState({ status: 'waiting', url: login.verificationUrl, userCode: login.userCode });
      return new Promise((resolve, reject) => {
        fixture.complete = () => { settings.onState({ status: 'verifying' }); resolve({ ...codex, accountEmail: 'after@example.invalid' }); };
        settings.signal.addEventListener('abort', () => { const error = new Error('Fixture canceled'); error.kind = 'canceled'; reject(error); }, { once: true });
      });
    },
    onChange: state => fixture.states.push(state), ...options.service,
  });
  return fixture;
}

test('host login returns starting state immediately, verifies the account and clears its code', async t => {
  const fixture = serviceFixture(); const service = fixture.service;
  t.after(() => service.close());
  await service.init(); await service.refreshHosts();
  const started = await service.startCodexLogin(host.id);
  assert.equal(started.hosts[0].login.status, 'starting');
  assert.equal(started.hosts[0].codex.accountEmail, 'before@example.invalid');
  await until(() => fixture.complete);
  assert.equal(service.snapshot().hosts[0].login.userCode, login.userCode);
  await assert.rejects(service.startCodexLogin(host.id), /다른 작업/);
  await assert.rejects(service.upgradeCodex(host.id), /다른 작업/);
  fixture.complete();
  await until(() => !service.active.has(host.id));
  const done = service.snapshot().hosts[0];
  assert.equal(done.login.status, 'completed');
  assert.equal(done.login.userCode, undefined);
  assert.equal(done.codex.accountEmail, 'after@example.invalid');
  assert.ok(fixture.states.some(state => state.hosts[0].login?.status === 'verifying' && state.hosts[0].login?.userCode === login.userCode));
});

test('host login cancellation and app close preserve the existing account and discard the code', async () => {
  const fixture = serviceFixture(); const service = fixture.service;
  await service.init(); await service.refreshHosts(); await service.startCodexLogin(host.id);
  await until(() => fixture.complete);
  const canceled = await service.cancelCodexLogin(host.id);
  assert.equal(canceled.hosts[0].login.status, 'canceled');
  assert.equal(canceled.hosts[0].login.url, undefined);
  assert.equal(canceled.hosts[0].codex.accountEmail, 'before@example.invalid');
  assert.equal(fixture.signal.aborted, true);
  fixture.complete = null;
  await service.startCodexLogin(host.id);
  await until(() => fixture.complete);
  await service.close();
  assert.equal(fixture.signal.aborted, true);
  assert.equal(service.logins.size, 0);
  assert.equal(service.pending.size, 0);
});

test('group metadata, folding and display order changes retain an in-progress login', async t => {
  const fixture = serviceFixture(); const service = fixture.service;
  t.after(() => service.close());
  await service.init(); await service.startCodexLogin(host.id);
  await until(() => fixture.complete);
  const before = service.snapshot().hosts[0].login;
  fixture.setConfig({ revision: 'group-change', groups: [{ id: 'servers', name: '서버', collapsed: true }], hosts: [{ ...host, groupId: 'servers', lineNumber: 99 }] });
  const changed = await service.reloadHosts();
  assert.deepEqual(changed.hosts[0].login, before);
  assert.equal(changed.groups[0].collapsed, true);
  assert.equal(fixture.signal.aborted, false);
  fixture.complete();
  await until(() => !service.active.has(host.id));
  assert.equal(service.snapshot().hosts[0].login.status, 'completed');
  assert.equal(service.snapshot().hosts[0].groupId, 'servers');
});

test('SSH option changes clear the login code immediately and ignore a late account result', async t => {
  const fixture = serviceFixture(); const service = fixture.service;
  t.after(() => service.close());
  await service.init(); await service.refreshHosts(); await service.startCodexLogin(host.id);
  await until(() => fixture.complete);
  fixture.setConfig({ revision: 'global-change', connectionRevision: 'ssh-two' });
  const changed = await service.reloadHosts();
  assert.equal(changed.hosts[0].login.status, 'error');
  assert.equal(changed.hosts[0].login.url, undefined);
  assert.equal(fixture.signal.aborted, true);
  fixture.complete();
  await until(() => !service.active.has(host.id));
  assert.equal(service.snapshot().hosts[0].codex.accountEmail, 'before@example.invalid');
});

test('the login monitor cancels external SSH changes without requiring a UI reload', async t => {
  const fixture = serviceFixture({ service: { loginCheckIntervalMs: 5 } }); const service = fixture.service;
  t.after(() => service.close());
  await service.init(); await service.startCodexLogin(host.id);
  await until(() => fixture.complete);
  fixture.setConfig({ revision: 'changed-outside', connectionRevision: 'ssh-two' });
  await until(() => !service.active.has(host.id));
  assert.equal(fixture.signal.aborted, true);
  assert.equal(service.snapshot().hosts[0].login.status, 'error');
  assert.equal(service.snapshot().hosts[0].login.userCode, undefined);
});

test('an SSH setting change during key selection blocks device auth before it begins', async t => {
  let releaseKey; let keyStarted = false;
  const fixture = serviceFixture({ service: { keyStore: { status: () => { keyStarted = true; return new Promise(resolve => { releaseKey = resolve; }); } } } }); const service = fixture.service;
  t.after(() => service.close());
  await service.init(); await service.startCodexLogin(host.id);
  await until(() => keyStarted);
  fixture.setConfig({ revision: 'changed-during-setup', connectionRevision: 'ssh-two' });
  releaseKey({ privateExists: false });
  await until(() => !service.active.has(host.id));
  assert.equal(fixture.loginCalls, 0);
  assert.equal(service.snapshot().hosts[0].login.status, 'error');
});

test('a login attempt expires without clearing the remote existing account', async t => {
  const fixture = serviceFixture({ service: { loginTimeoutMs: 15 } }); const service = fixture.service;
  t.after(() => service.close());
  await service.init(); await service.refreshHosts(); await service.startCodexLogin(host.id);
  await until(() => !service.active.has(host.id));
  const item = service.snapshot().hosts[0];
  assert.equal(item.login.status, 'error');
  assert.match(item.login.error, /제한 시간/);
  assert.equal(item.login.userCode, undefined);
  assert.equal(item.codex.accountEmail, 'before@example.invalid');
});

test('group service methods delegate to the store and publish its complete state', async t => {
  const calls = []; const fixture = serviceFixture(); const service = fixture.service;
  t.after(() => service.close());
  await service.init();
  for (const method of ['saveGroup', 'deleteGroup', 'setGroupCollapsed', 'moveHostToGroup']) service.config[method] = async (...args) => {
    calls.push([method, ...args]);
    return { configPath: '/tmp/config', revision: 'one', connectionRevision: 'ssh-one', groups: [{ id: 'group-one', name: '서버', collapsed: false }], hosts: [{ ...host, groupId: 'group-one' }] };
  };
  await service.saveGroup({ name: '서버' }, 'one');
  await service.setGroupCollapsed('group-one', true, 'one');
  await service.moveHostToGroup(host.id, null, 'one', [host.id]);
  await service.deleteGroup('group-one', 'one');
  assert.deepEqual(calls.map(call => call[0]), ['saveGroup', 'setGroupCollapsed', 'moveHostToGroup', 'deleteGroup']);
  assert.equal(service.snapshot().groups.length, 1);
  assert.deepEqual(calls[2].slice(1), [host.id, null, 'one', [host.id]]);
});
