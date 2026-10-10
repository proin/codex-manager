'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { HostService } = require('../electron/host-service.cjs');
const { SshConfigStore } = require('../electron/ssh-config.cjs');
const { buildSshArgs, parseAuthorizedKeys, registrationScript, probeCodex, secureProxyCommand, withAskpass, runProcess, terminateProcessGroup, localCommandQuote, upgradeScript } = require('../electron/host-ssh.cjs');

const host = { id: 'host-one', alias: 'one', hostPatterns: 'one', hostName: '192.0.2.1', user: 'operator', port: '22', identityFile: '', proxyJump: '', optionsText: '', connectable: true };
const publicKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEV4YW1wbGUtZXhhbXBsZS1leGFtcGxlLWtleTE example';
const keyStore = { status: async () => ({ privateExists: true, publicExists: true, privateKeyPath: '/tmp/test-key', publicKeyPath: '/tmp/test-key.pub', publicKey }), generate: async () => ({ privateExists: true, publicExists: true, privateKeyPath: '/tmp/test-key', publicKeyPath: '/tmp/test-key.pub', publicKey }) };
const codex = { available: true, version: '0.159.0', accountEmail: 'operator@example.invalid', accountPlan: 'pro', loginStatus: 'chatgpt', installMethod: 'npm' };

function makeService(overrides = {}, count = 2) {
  const hosts = Array.from({ length: count }, (_, index) => ({ ...host, id: `host-${index}`, alias: `host${index}`, hostPatterns: `host${index}` }));
  const store = { read: async () => ({ configPath: '/tmp/test-ssh-config', revision: 'revision-one', hosts }), save: async () => { throw new Error('unexpected save'); }, remove: async () => { throw new Error('unexpected remove'); } };
  return new HostService({ configStore: store, keyStore, probe: async () => codex, effectiveConfig: async (item) => ({ hostName: item.hostName, user: item.user, port: item.port, identities: [] }), ...overrides });
}

test('SSH probes block prompts, forwarding and shared control sockets', () => {
  const args = buildSshArgs('/tmp/config with spaces', host, 'true');
  for (const value of ['BatchMode=yes', 'NumberOfPasswordPrompts=0', 'StrictHostKeyChecking=yes', 'UpdateHostKeys=no', 'ForwardAgent=no', 'ControlPath=none', 'ControlMaster=no', 'PermitLocalCommand=no']) assert.ok(args.includes(value));
  assert.equal(args[1], '/tmp/config with spaces');
  for (const alias of ['-oProxyCommand=x', 'host; bad', '*', '', 'a\nb']) assert.throws(() => buildSshArgs('/tmp/config', { alias }, 'true'));
  const passwordArgs = buildSshArgs('/tmp/config', host, 'true', { password: true });
  assert.ok(passwordArgs.includes('BatchMode=no'));
  assert.ok(passwordArgs.includes('StrictHostKeyChecking=yes'));
});

test('host refresh publishes independent results and bounds concurrency to six', async () => {
  let running = 0; let highest = 0;
  const events = [];
  const service = makeService({ onChange: (state) => events.push(state), probe: async (item) => {
    running += 1; highest = Math.max(highest, running);
    await new Promise((resolve) => setTimeout(resolve, 8));
    running -= 1;
    if (item.id === 'host-2') throw new Error('host unreachable');
    return codex;
  } }, 9);
  await service.init();
  const state = await service.refreshHosts();
  assert.equal(highest, 6);
  assert.equal(state.completed, 9);
  assert.equal(state.hosts[2].connection.status, 'offline');
  assert.equal(state.hosts[2].codex.version, null);
  assert.equal(state.hosts[8].connection.status, 'online');
  assert.equal(state.hosts[8].codex.version, '0.159.0');
  assert.ok(events.some((state) => state.completed === 1 && state.refresh.running));
  assert.equal(state.refresh.running, false);
});

test('canceling refresh aborts in-flight probes and does not publish their late answers', async () => {
  const signals = [];
  const service = makeService({ probe: (_host, { signal }) => new Promise((resolve) => {
    signals.push(signal);
    signal.addEventListener('abort', () => resolve(codex), { once: true });
  }) });
  await service.init();
  const pending = service.refreshHosts();
  await new Promise((resolve) => setImmediate(resolve));
  service.cancelRefresh();
  await pending;
  assert.equal(signals.length, 2);
  assert.ok(signals.every((signal) => signal.aborted));
  assert.ok(service.snapshot().hosts.every((item) => item.codex.version === null && item.connection.status === 'unknown'));
});

test('missing SSH config does not prevent account app startup', async () => {
  const service = makeService({ configStore: { read: async () => { throw new Error('SSH 설정을 읽지 못했습니다.'); } } });
  const state = await service.init();
  assert.equal(state.error, 'SSH 설정을 읽지 못했습니다.');
  assert.deepEqual(state.hosts, []);
});

test('external SSH config changes block host operations before mutation', async () => {
  let revision = 'one'; let mutated = false;
  const service = makeService({ configStore: { read: async () => ({ configPath: '/tmp/config', revision, hosts: [host] }) }, keyStore: { ...keyStore, generate: async () => { mutated = true; return {}; } } });
  await service.init();
  revision = 'changed-by-remote-mgmt';
  await assert.rejects(service.generateKey(host.id), /SSH 설정이 변경되었습니다/);
  assert.equal(mutated, false);
});

test('registration preserves other authorized keys and compares key values instead of comments', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cam-register-test-'));
  try {
    await fs.mkdir(path.join(directory, '.ssh'));
    const file = path.join(directory, '.ssh', 'authorized_keys');
    const other = '# existing comment\nssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAAgQOther other\n';
    await fs.writeFile(file, other);
    const script = registrationScript(publicKey);
    for (let pass = 0; pass < 2; pass += 1) {
      const result = await runProcess('sh', ['-s'], { input: script, env: { HOME: directory } });
      assert.equal(result.code, 0);
    }
    const text = await fs.readFile(file, 'utf8');
    assert.ok(text.startsWith(other));
    assert.equal(text.split(publicKey).length - 1, 1);
    const keys = parseAuthorizedKeys(text.replace('example', 'changed-comment'), publicKey);
    assert.equal(keys.length, 2);
    assert.equal(keys.filter((key) => key.matchesLocal).length, 1);
    assert.throws(() => registrationScript(`${publicKey}\necho unsafe`));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('askpass keeps the password out of files, argv and environment and removes temporary files', async () => {
  if (process.platform === 'win32') return;
  let helper;
  await withAskpass('fixture-password', async (env) => {
    helper = env.SSH_ASKPASS;
    assert.equal(JSON.stringify(env).includes('fixture-password'), false);
    assert.equal((await fs.readFile(helper, 'utf8')).includes('fixture-password'), false);
    const result = await runProcess(helper, ['operator@host password:'], { env });
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), 'fixture-password');
    const refused = await runProcess(helper, ['Enter passphrase for key:'], { env });
    assert.notEqual(refused.code, 0);
  });
  await assert.rejects(fs.stat(helper), { code: 'ENOENT' });
});

test('remote account probe initializes app-server and only reads account metadata', async () => {
  const requests = [];
  const run = async (_command, _args, options) => {
    let count = 0;
    const child = { stdin: { write: (text) => {
      for (const line of text.trim().split('\n')) {
        const message = JSON.parse(line); requests.push(message);
        if (message.method === 'initialize') queueMicrotask(() => options.onStdout('{"id":1,"result":{}}\n', child, finish));
        if (message.method === 'account/read') queueMicrotask(() => options.onStdout('{"id":2,"result":{"account":{"type":"chatgpt","email":"operator@example.invalid","planType":"pro","accessToken":"DO_NOT_RETURN"}}}\n', child, finish));
      }
    } } };
    let done;
    const promise = new Promise((resolve) => { done = resolve; });
    const finish = (result) => { count += 1; done({ stdout: '', stderr: '', ...result }); };
    options.onStdout('CODEX_MANAGER_META {"available":true,"version":"0.159.0","installMethod":"npm"}\n', child, finish);
    options.onStart(child);
    const result = await promise;
    assert.equal(count, 1);
    return result;
  };
  const result = await probeCodex(run, '/tmp/config', host);
  assert.deepEqual(requests.map((item) => item.method), ['initialize', 'initialized', 'account/read']);
  assert.equal(requests[2].params.refreshToken, false);
  assert.equal(result.accountEmail, 'operator@example.invalid');
  assert.equal(JSON.stringify(result).includes('DO_NOT_RETURN'), false);
});

test('account-only failures retain the Codex version and unknown login status', async () => {
  const result = await probeCodex(async (_command, _args, options) => {
    options.onStdout('CODEX_MANAGER_META {"available":true,"version":"0.149.0","installMethod":"npm"}\n', {}, () => {});
    return { code: 255, timedOut: true };
  }, '/tmp/config', host);
  assert.equal(result.version, '0.149.0');
  assert.equal(result.available, true);
  assert.equal(result.loginStatus, 'unknown');
});

test('all jump stages inherit strict verification, disabled forwarding and password mode', async () => {
  const observed = [];
  const run = async (_command, args) => {
    observed.push(args);
    const alias = args.at(-1);
    return { code: 0, stdout: `hostname ${alias}\nuser operator\nport 22\nproxyjump ${alias === 'one' ? 'jump-a,jump-b' : 'none'}\n` };
  };
  const proxyCommand = await secureProxyCommand(run, '/tmp/config', host);
  assert.ok(proxyCommand.includes('jump-b'));
  assert.ok(proxyCommand.includes('jump-a'));
  assert.equal(proxyCommand.split('StrictHostKeyChecking=yes').length - 1, 2);
  assert.equal(proxyCommand.split('BatchMode=yes').length - 1, 2);
  assert.equal(proxyCommand.split('ForwardAgent=no').length - 1, 2);
  assert.ok(proxyCommand.includes('%%h'));
  assert.ok(observed.every((args) => args.includes('-G')));
});

test('Windows jump commands use native executable quoting for a spaced config path and retain each stage security options', async () => {
  const configPath = "C:\\Users\\O'Connor\\SSH Settings\\config";
  const run = async (_command, args) => {
    const alias = args.at(-1);
    return { code: 0, stdout: `hostname ${alias}\nuser operator\nport 22\nproxyjump ${alias === 'one' ? 'jump-a,jump-b' : 'none'}\n` };
  };
  const command = await secureProxyCommand(run, configPath, host, { platform: 'win32' });
  assert.ok(command.startsWith('"ssh.exe" "-F" "C:\\Users\\O\'Connor\\SSH Settings\\config"'));
  assert.ok(command.includes('ProxyCommand=\\"ssh.exe\\"'));
  assert.equal(command.split('StrictHostKeyChecking=yes').length - 1, 2);
  assert.equal(command.split('ForwardAgent=no').length - 1, 2);
  assert.ok(command.includes('%%h'));
  assert.equal(command.includes("'\"'\"'"), false);
  assert.equal(localCommandQuote('C:\\keys\\', 'win32'), '"C:\\keys\\\\"');
  assert.equal(localCommandQuote('an "argument"', 'win32'), '"an \\"argument\\""');
});

test('Windows cancellation terminates the SSH process tree without a shell and falls back if taskkill fails', () => {
  const calls = []; const kills = []; const killer = new EventEmitter();
  const child = { pid: 8123, kill: (signal) => kills.push(signal) };
  terminateProcessGroup(child, 'win32', (...args) => { calls.push(args); return killer; });
  assert.deepEqual(calls[0], ['taskkill.exe', ['/PID', '8123', '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' }]);
  assert.deepEqual(kills, []);
  killer.emit('close', 1);
  assert.deepEqual(kills, ['SIGKILL']);
});

test('Windows key authentication does not create an askpass helper and password authentication reports its limitation', async () => {
  const result = await withAskpass('', async (env) => env, { platform: 'win32' });
  assert.deepEqual(result, {});
  let called = false;
  await assert.rejects(withAskpass('fixture-password', async () => { called = true; }, { platform: 'win32' }), /Windows에서는 SSH 키/);
  assert.equal(called, false);
});

test('unsupported binary installation does not run arbitrary npm or sudo upgrade', () => {
  const command = upgradeScript();
  assert.ok(command.includes('unsupported-install'));
  assert.ok(command.includes('npm install -g @openai/codex@latest'));
  assert.ok(command.includes('brew upgrade --cask codex'));
  assert.equal(/sudo/.test(command), false);
});

test('a failed npm installation stops the upgrade script before it can report the old version as success', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cam-failed-upgrade-'));
  try {
    const bin = path.join(directory, '.local', 'bin');
    const packageBin = path.join(directory, '.local', 'lib', 'node_modules', '@openai', 'codex', 'bin');
    await fs.mkdir(bin, { recursive: true });
    await fs.mkdir(packageBin, { recursive: true });
    await fs.writeFile(path.join(packageBin, 'codex.js'), '#!/bin/sh\nprintf "codex-cli 0.149.0\\n"\n', { mode: 0o700 });
    await fs.symlink('../lib/node_modules/@openai/codex/bin/codex.js', path.join(bin, 'codex'));
    await fs.writeFile(path.join(bin, 'npm'), '#!/bin/sh\nprintf "fixture-installation-failed\\n" >&2\nexit 17\n', { mode: 0o700 });
    const result = await runProcess('sh', ['-c', upgradeScript()], { env: { HOME: directory, SHELL: '/bin/sh' } });
    assert.equal(result.code, 17);
    assert.match(result.stderr, /fixture-installation-failed/);
    assert.doesNotMatch(result.stdout, /^codex-cli/m);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('upgrade returns and publishes the version read from the server after completion', async () => {
  const commands = [];
  const service = makeService({ runCommand: async (_command, args) => { commands.push(args); return { code: 0, stdout: args.includes('-G') ? 'hostname one\nuser operator\nport 22\nproxyjump none\n' : 'codex-cli 0.159.0\n' }; } });
  await service.init();
  const result = await service.upgradeCodex('host-0');
  assert.equal(result.version, '0.159.0');
  assert.equal(service.snapshot().hosts[0].codex.version, '0.159.0');
  assert.equal(service.snapshot().hosts[0].operation.running, false);
  assert.ok(commands.some((args) => args.at(-1).includes('npm install -g')));
});

test('inherited SSH keys are selected from effective settings and remote path tokens are expanded', async () => {
  const tried = [];
  const service = makeService({ keyStore: { status: async (item) => {
    tried.push(item.identityFile);
    return { privateExists: item.identityFile === '/keys/192.0.2.1-operator-2222', publicExists: false, privateKeyPath: item.identityFile };
  } }, effectiveConfig: async () => ({ hostName: '192.0.2.1', user: 'operator', port: '2222', identities: ['/keys/missing', '/keys/%h-%r-%p'] }) });
  await service.init();
  const detail = await service.getHostDetails('host-0');
  assert.deepEqual(tried, ['/keys/missing', '/keys/192.0.2.1-operator-2222']);
  assert.equal(detail.key.privateKeyPath, '/keys/192.0.2.1-operator-2222');
});

test('explicit IdentityFile remains selected when it is missing', async () => {
  const explicit = { ...host, identityFile: '/keys/%h-explicit' };
  const tried = [];
  const service = makeService({ configStore: { read: async () => ({ configPath: '/tmp/config', revision: 'one', hosts: [explicit] }) }, keyStore: { status: async (item) => { tried.push(item.identityFile); return { privateExists: false, publicExists: false, privateKeyPath: item.identityFile }; } }, effectiveConfig: async () => ({ hostName: '192.0.2.2', user: 'operator', port: '22', identities: ['/keys/existing-other'] }) });
  await service.init();
  assert.equal((await service.getHostDetails(host.id)).key.privateKeyPath, '/keys/192.0.2.2-explicit');
  assert.deepEqual(tried, ['/keys/192.0.2.2-explicit']);
});

test('a host operation leaves other host probes running and ignores same-host stale data', async () => {
  const finish = new Map();
  let generating;
  const service = makeService({ probe: (item) => new Promise((resolve) => finish.set(item.id, resolve)), keyStore: { ...keyStore, generate: () => new Promise((resolve) => { generating = resolve; }) } });
  await service.init();
  const refresh = service.refreshHosts();
  await new Promise((resolve) => setImmediate(resolve));
  const operation = service.generateKey('host-0');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.snapshot().refresh.running, true);
  finish.get('host-1')(codex);
  finish.get('host-0')({ ...codex, version: 'old-stale-version' });
  await refresh;
  assert.equal(service.snapshot().hosts[1].codex.version, '0.159.0');
  assert.equal(service.snapshot().hosts[0].codex.version, null);
  assert.equal(service.snapshot().hosts[0].operation.running, true);
  generating(await keyStore.status());
  await operation;
});

test('dedicated key generation replaces IdentityFile none with the selected key path', async () => {
  let hosts = [{ ...host, identityFile: 'none' }];
  let revision = 'one';
  const dedicated = { privateExists: true, publicExists: true, privateKeyPath: '/tmp/ssh/codex-manager_ed25519', publicKeyPath: '/tmp/ssh/codex-manager_ed25519.pub', publicKey };
  const service = makeService({ configStore: { read: async () => ({ configPath: '/tmp/config', revision, hosts }), save: async (draft, expected) => { assert.equal(expected, revision); hosts = [draft]; revision = 'two'; return { configPath: '/tmp/config', revision, hosts }; } }, keyStore: { status: async () => dedicated, generate: async () => dedicated } });
  await service.init();
  await service.generateKey(host.id);
  assert.equal(service.snapshot().hosts[0].identityFile, dedicated.privateKeyPath);
  assert.equal(service.snapshot().hosts[0].operation.running, false);
});

test('process timeout terminates its child process group', async () => {
  if (process.platform === 'win32') return;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cam-process-test-'));
  const file = path.join(directory, 'pid');
  try {
    const childCode = 'setInterval(()=>{},1000)';
    const parentCode = `const{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(file)},String(c.pid));setInterval(()=>{},1000)`;
    const result = await runProcess(process.execPath, ['-e', parentCode], { timeoutMs: 400 });
    assert.equal(result.timedOut, true);
    const pid = Number(await fs.readFile(file, 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

async function orderedService(t, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cam-host-order-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'config');
  await fs.writeFile(configPath, 'Host alpha\n  HostName 192.0.2.1\n  User operator\nHost beta\n  HostName 192.0.2.2\n  User operator\n', { mode: 0o600 });
  const service = makeService({ configStore: new SshConfigStore({ configPath }), ...overrides });
  t.after(() => service.close());
  await service.init();
  return { service, configPath };
}

test('host order persists without losing per-host probe data and rejected saves leave state intact', async t => {
  const { service, configPath } = await orderedService(t);
  await service.refreshHosts();
  const before = service.snapshot();
  const ids = before.hosts.map(item => item.id).reverse();
  const reordered = await service.reorderHosts(ids, before.revision);
  assert.deepEqual(reordered.hosts.map(item => item.id), ids);
  for (const item of reordered.hosts) {
    const previous = before.hosts.find(entry => entry.id === item.id);
    assert.deepEqual(item.connection, previous.connection);
    assert.deepEqual(item.codex, previous.codex);
    assert.deepEqual(item.operation, previous.operation);
  }
  assert.deepEqual((await service.reloadHosts()).hosts.map(item => item.id), ids);
  await assert.rejects(service.reorderHosts(ids, before.revision), /설정이 변경/);
  await assert.rejects(service.reorderHosts([ids[0], ids[0]], reordered.revision), /모든 호스트/);
  assert.deepEqual(service.snapshot().hosts, reordered.hosts);
  await fs.appendFile(configPath, '# external change\n');
  await assert.rejects(service.reorderHosts(ids.reverse(), reordered.revision), /설정이 변경/);
  assert.deepEqual(service.snapshot().hosts, reordered.hosts);
});

test('reordering while probes run keeps their signals and publishes late answers by host ID', async t => {
  const finish = new Map();
  const signals = new Map();
  const { service } = await orderedService(t, { probe: (item, { signal }) => new Promise(resolve => { finish.set(item.id, resolve); signals.set(item.id, signal); }) });
  const before = service.snapshot();
  const refresh = service.refreshHosts();
  await new Promise(resolve => setImmediate(resolve));
  const ids = before.hosts.map(item => item.id).reverse();
  const reordered = await service.reorderHosts(ids, before.revision);
  assert.equal(reordered.refresh.running, true);
  assert.ok([...signals.values()].every(signal => !signal.aborted));
  finish.get(before.hosts[0].id)({ ...codex, accountEmail: 'alpha@example.invalid' });
  finish.get(before.hosts[1].id)({ ...codex, accountEmail: 'beta@example.invalid' });
  const result = await refresh;
  assert.deepEqual(result.hosts.map(item => item.id), ids);
  assert.deepEqual(result.hosts.map(item => item.codex.accountEmail), ['beta@example.invalid', 'alpha@example.invalid']);
  assert.ok(result.hosts.every(item => item.connection.status === 'online'));
  assert.equal(result.completed, 2);
});

test('reordering during a Codex upgrade keeps its final version and running operation on the same host', async t => {
  let completeUpgrade;
  const { service } = await orderedService(t, { probe: async () => ({ ...codex, version: '0.200.0' }), runCommand: async (_command, args) => {
    if (args.includes('-G')) return { code: 0, stdout: 'hostname alpha\nuser operator\nport 22\nproxyjump none\n' };
    return new Promise(resolve => { completeUpgrade = resolve; });
  } });
  const before = service.snapshot();
  const target = before.hosts[0].id;
  const upgrade = service.upgradeCodex(target);
  while (!completeUpgrade) await new Promise(resolve => setImmediate(resolve));
  const reordered = await service.reorderHosts(before.hosts.map(item => item.id).reverse(), before.revision);
  assert.equal(reordered.hosts.find(item => item.id === target).operation.status, 'running');
  assert.equal(service.active.get(target).signal.aborted, false);
  completeUpgrade({ code: 0, stdout: 'codex-cli 0.200.0\n' });
  await upgrade;
  const result = service.snapshot();
  assert.equal(result.hosts[1].id, target);
  assert.equal(result.hosts[1].codex.version, '0.200.0');
  assert.equal(result.hosts[1].connection.status, 'online');
  assert.equal(result.hosts[1].operation.status, 'completed');
  assert.equal(result.hosts[1].operation.running, false);
});

test('host operation status separates completed messages from failure details', async () => {
  const successful = makeService();
  await successful.init();
  await successful.generateKey('host-0');
  assert.equal(successful.snapshot().hosts[0].operation.status, 'completed');
  assert.equal(successful.snapshot().hosts[0].operation.error, undefined);
  const failed = makeService({ keyStore: { ...keyStore, generate: async () => { throw new Error('fixture key failure'); } } });
  await failed.init();
  await assert.rejects(failed.generateKey('host-0'), /fixture key failure/);
  assert.equal(failed.snapshot().hosts[0].operation.status, 'error');
  assert.equal(failed.snapshot().hosts[0].operation.error, 'fixture key failure');
  assert.equal(failed.snapshot().hosts[1].operation.status, 'idle');
});

test('batch Codex upgrades start all nine hosts together and retain independent results', async t => {
  let running = 0; let highest = 0;
  const started = [], complete = new Map();
  const service = makeService({ probe: async () => ({ ...codex, version: '0.200.0' }), runCommand: async (_command, args, options) => {
    if (args.includes('-G')) return { code: 0, stdout: 'hostname server\nuser operator\nport 22\nproxyjump none\n' };
    const alias = args.at(-2);
    started.push(alias); running += 1; highest = Math.max(highest, running);
    return new Promise(resolve => {
      let finished = false;
      const finish = result => { if (finished) return; finished = true; running -= 1; resolve(result); };
      complete.set(alias, finish);
      options.signal.addEventListener('abort', () => finish({ code: 255, canceled: true }), { once: true });
    });
  } }, 9);
  t.after(() => service.close());
  await service.init();
  for (const item of service.state.hosts) item.codex = { ...codex };
  const ids = service.snapshot().hosts.map(item => item.id).reverse();
  const batch = service.upgradeCodexBatch(ids);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started.length, 9);
  assert.equal(highest, 9);
  assert.equal(service.active.size, 9);
  assert.deepEqual(service.snapshot().batchUpgrade, { running: true, hostIds: ids });
  for (const [alias, finish] of complete) finish(alias === 'host4' ? { code: 1, stderr: 'Permission denied' } : { code: 0, stdout: 'codex-cli 0.200.0\n' });
  const result = await batch;
  assert.deepEqual(result.results.map(item => item.id), ids);
  assert.equal(result.results.filter(item => item.success).length, 8);
  assert.deepEqual(result.results.find(item => item.id === 'host-4'), { id: 'host-4', success: false, error: 'SSH 인증에 실패했습니다. 키 또는 서버 비밀번호를 확인하십시오.' });
  assert.equal(result.state.hosts[4].operation.status, 'error');
  assert.equal(result.state.hosts[8].codex.version, '0.200.0');
  assert.deepEqual(result.state, service.snapshot());
  assert.deepEqual(result.state.batchUpgrade, { running: false, hostIds: [] });
  assert.equal(service.active.size, 0);
});

test('completed batch targets remain reserved after a fresh snapshot and menu re-entry', async t => {
  const complete = new Map(), events = [], probes = [];
  const service = makeService({ onChange: state => events.push(state), probe: async item => { probes.push(item.id); return { ...codex, version: '0.200.0' }; } }, 3);
  t.after(() => service.close());
  await service.init();
  for (const item of service.state.hosts) item.codex = { ...codex };
  service.executeOnHost = async (item, _command, { signal }) => new Promise((resolve, reject) => {
    complete.set(item.id, resolve);
    signal.addEventListener('abort', () => reject(new Error('fixture upgrade canceled')), { once: true });
  });
  const ids = ['host-0', 'host-1'];
  const batch = service.upgradeCodexBatch(ids);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(complete.size, 2);
  complete.get('host-0')({ code: 0 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.active.has('host-0'), false);
  assert.equal(service.snapshot().hosts[0].operation.running, false);
  assert.equal(service.snapshot().hosts[0].operation.status, 'completed');
  assert.deepEqual(service.snapshot().batchUpgrade, { running: true, hostIds: ids });
  const reentered = await service.reloadHosts();
  assert.deepEqual(reentered.batchUpgrade, { running: true, hostIds: ids });
  reentered.batchUpgrade.hostIds.length = 0;
  assert.deepEqual(service.snapshot().batchUpgrade.hostIds, ids);
  await assert.rejects(service.upgradeCodexBatch(['host-0']), /일괄 업그레이드가 진행 중/);
  for (const request of [
    () => service.upgradeCodex('host-0'),
    () => service.generateKey('host-0'),
    () => service.inspectKeys('host-0'),
    () => service.registerKey('host-0'),
    () => service.startCodexLogin('host-0'),
  ]) await assert.rejects(request(), /다른 작업/);
  await assert.rejects(service.saveHost({ ...service.requireHost('host-0') }, reentered.revision), /작업이 진행 중/);
  await assert.rejects(service.deleteHosts(['host-0', 'host-2'], reentered.revision), /작업이 진행 중/);
  await assert.rejects(service.deleteHost('host-0', reentered.revision), /작업이 진행 중/);
  assert.equal(complete.size, 2);
  await service.generateKey('host-2');
  assert.equal(service.requireHost('host-2').operation.status, 'completed');
  await service.refreshHosts(['host-0']);
  assert.deepEqual(probes, ['host-0']);
  service.config.reorder = async orderedIds => {
    const current = await service.config.read();
    return { ...current, hosts: orderedIds.map(id => current.hosts.find(item => item.id === id)) };
  };
  const reordered = await service.reorderHosts(['host-2', 'host-1', 'host-0'], reentered.revision);
  assert.deepEqual(reordered.batchUpgrade, { running: true, hostIds: ids });
  assert.equal(service.active.get('host-1').signal.aborted, false);
  complete.get('host-1')({ code: 0 });
  const result = await batch;
  assert.deepEqual(result.results, ids.map(id => ({ id, success: true })));
  assert.deepEqual(result.state.batchUpgrade, { running: false, hostIds: [] });
  assert.equal(result.state.hosts.find(item => item.id === 'host-0').codex.version, '0.200.0');
  assert.ok(events.some(state => state.batchUpgrade.running && state.hosts.find(item => item.id === 'host-0').operation.status === 'completed'));
  assert.equal(events.at(-1).batchUpgrade.running, false);
  assert.equal(service.active.size, 0);
  assert.equal(service.pending.size, 0);
});

test('failed batch targets stay reserved until other targets finish and can be retried afterward', async t => {
  const complete = new Map();
  const service = makeService();
  t.after(() => service.close());
  await service.init();
  for (const item of service.state.hosts) item.codex = { ...codex };
  service.executeOnHost = async (item, _command, { signal }) => new Promise((resolve, reject) => {
    complete.set(item.id, { resolve, reject });
    signal.addEventListener('abort', () => reject(new Error('fixture upgrade canceled')), { once: true });
  });
  const batch = service.upgradeCodexBatch(['host-0', 'host-1']);
  await new Promise(resolve => setImmediate(resolve));
  complete.get('host-0').reject(new Error('fixture upgrade failed'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.requireHost('host-0').operation.status, 'error');
  assert.equal(service.requireHost('host-0').operation.running, false);
  assert.equal(service.active.has('host-0'), false);
  assert.deepEqual(service.snapshot().batchUpgrade, { running: true, hostIds: ['host-0', 'host-1'] });
  await assert.rejects(service.upgradeCodex('host-0'), /다른 작업/);
  complete.get('host-1').resolve({ code: 0 });
  const result = await batch;
  assert.deepEqual(result.results, [{ id: 'host-0', success: false, error: 'fixture upgrade failed' }, { id: 'host-1', success: true }]);
  assert.deepEqual(result.state.batchUpgrade, { running: false, hostIds: [] });
  service.executeOnHost = async () => ({ code: 0 });
  const retry = await service.upgradeCodexBatch(['host-0']);
  assert.deepEqual(retry.results, [{ id: 'host-0', success: true }]);
  assert.deepEqual(retry.state.batchUpgrade, { running: false, hostIds: [] });
  assert.equal(service.pending.size, 0);
});

test('closing aborts unfinished batch hosts and releases all batch reservations', async () => {
  const complete = new Map(), signals = [];
  const service = makeService();
  await service.init();
  for (const item of service.state.hosts) item.codex = { ...codex };
  service.executeOnHost = async (item, _command, { signal }) => new Promise((resolve, reject) => {
    complete.set(item.id, resolve); signals.push(signal);
    signal.addEventListener('abort', () => reject(new Error('fixture upgrade canceled')), { once: true });
  });
  const batch = service.upgradeCodexBatch(['host-0', 'host-1']);
  await new Promise(resolve => setImmediate(resolve));
  complete.get('host-0')({ code: 0 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.requireHost('host-0').operation.running, false);
  assert.equal(service.snapshot().batchUpgrade.running, true);
  await service.close();
  const result = await batch;
  assert.deepEqual(result.results, [{ id: 'host-0', success: true }, { id: 'host-1', success: false, error: 'fixture upgrade canceled' }]);
  assert.equal(signals[1].aborted, true);
  assert.deepEqual(service.snapshot().batchUpgrade, { running: false, hostIds: [] });
  assert.equal(service.active.size, 0);
  assert.equal(service.pending.size, 0);
  await assert.rejects(service.upgradeCodexBatch(['host-0']), /종료되었습니다/);
});

test('batch upgrades skip busy and unsupported hosts without blocking an eligible host', async t => {
  let upgrades = 0;
  const service = makeService({ runCommand: async (_command, args) => {
    if (args.includes('-G')) return { code: 0, stdout: 'hostname server\nuser operator\nport 22\nproxyjump none\n' };
    upgrades += 1; return { code: 0, stdout: 'codex-cli 0.200.0\n' };
  }, probe: async () => ({ ...codex, version: '0.200.0' }) }, 6);
  t.after(() => service.close());
  await service.init();
  for (const item of service.state.hosts) item.codex = { ...codex };
  const controller = new AbortController();
  service.active.set('host-0', controller);
  service.state.hosts[0].operation = { type: 'codexLogin', running: true, status: 'running', message: '' };
  service.state.hosts[2].codex.available = false;
  service.state.hosts[3].connectable = false;
  service.state.hosts[4].codex.installMethod = 'manual';
  service.state.hosts[5].codex.available = null;
  const result = await service.upgradeCodexBatch(service.state.hosts.map(item => item.id));
  assert.equal(upgrades, 2);
  assert.deepEqual(result.results.map(item => item.success), [false, true, false, false, false, true]);
  assert.match(result.results[0].error, /다른 작업/);
  assert.match(result.results[2].error, /설치되어 있지/);
  assert.match(result.results[3].error, /개별 호스트/);
  assert.match(result.results[4].error, /자동 업그레이드/);
  assert.equal(controller.signal.aborted, false);
  assert.equal(result.state.hosts[0].operation.running, true);
  assert.equal(result.state.hosts[1].codex.version, '0.200.0');
  service.active.delete('host-0');
});

test('batch upgrades discover the server installation before usage has been refreshed', async t => {
  let upgrades = 0;
  const service = makeService({ runCommand: async (_command, args) => {
    if (args.includes('-G')) return { code: 0, stdout: 'hostname server\nuser operator\nport 22\nproxyjump none\n' };
    assert.ok(args.at(-1).includes('npm install -g @openai/codex@latest'));
    upgrades += 1; return { code: 0, stdout: 'codex-cli 0.200.0\n' };
  }, probe: async () => ({ ...codex, version: '0.200.0' }) }, 1);
  t.after(() => service.close());
  await service.init();
  assert.equal(service.snapshot().hosts[0].codex.available, null);
  assert.equal(service.snapshot().hosts[0].codex.installMethod, null);
  const result = await service.upgradeCodexBatch(['host-0']);
  assert.equal(upgrades, 1);
  assert.deepEqual(result.results, [{ id: 'host-0', success: true }]);
  assert.equal(result.state.hosts[0].codex.version, '0.200.0');
});

test('invalid batch selections reject before canceling probes or starting any upgrade', async t => {
  const signals = [];
  const service = makeService({ probe: (_item, { signal }) => new Promise(resolve => {
    signals.push(signal); signal.addEventListener('abort', () => resolve(codex), { once: true });
  }) });
  t.after(() => service.close());
  await service.init();
  const refresh = service.refreshHosts();
  await new Promise(resolve => setImmediate(resolve));
  let upgrades = 0;
  service.upgradeCodex = async () => { upgrades += 1; };
  for (const ids of [null, {}, [], ['host-0', 'host-0'], ['host-0', 'missing'], ['host-0', 1], [''], ['x'.repeat(257)]]) await assert.rejects(service.upgradeCodexBatch(ids));
  assert.equal(upgrades, 0);
  assert.deepEqual(service.snapshot().batchUpgrade, { running: false, hostIds: [] });
  assert.equal(service.snapshot().refresh.running, true);
  assert.ok(signals.every(signal => !signal.aborted));
  service.cancelRefresh(); await refresh;
});

test('batch upgrades cancel read-only probes and ignore their older Codex versions', async t => {
  const signals = [];
  let finishOldProbe;
  const service = makeService({ probe: (_item, { signal }) => new Promise(resolve => { signals.push(signal); finishOldProbe = resolve; }) }, 1);
  t.after(() => service.close());
  await service.init();
  service.state.hosts[0].codex = { ...codex };
  const refresh = service.refreshHosts();
  await new Promise(resolve => setImmediate(resolve));
  service.upgradeCodex = async id => { service.requireHost(id).codex = { ...codex, version: '0.200.0' }; };
  const result = await service.upgradeCodexBatch(['host-0']);
  assert.equal(signals[0].aborted, true);
  assert.equal(result.results[0].success, true);
  finishOldProbe({ ...codex, version: '0.100.0' }); await refresh;
  assert.equal(service.snapshot().hosts[0].codex.version, '0.200.0');
});

test('batch deletion validates every host and blocks active work before touching SSH config', async t => {
  const { service, configPath } = await orderedService(t);
  const before = service.snapshot(), original = await fs.readFile(configPath, 'utf8');
  const ids = before.hosts.map(item => item.id);
  for (const selected of [[], [ids[0], ids[0]], [ids[0], 'missing'], [ids[0], 1]]) await assert.rejects(service.deleteHosts(selected, before.revision));
  await assert.rejects(service.deleteHosts(ids, 'outdated-revision'), /설정이 변경/);
  const controller = new AbortController();
  service.active.set(ids[1], controller);
  await assert.rejects(service.deleteHosts(ids, before.revision), /작업이 진행 중/);
  assert.equal(controller.signal.aborted, false);
  assert.equal(await fs.readFile(configPath, 'utf8'), original);
  assert.deepEqual(await fs.readdir(path.dirname(configPath)), ['config']);
  assert.deepEqual(service.snapshot(), before);
  service.active.delete(ids[1]);
});

test('batch deletion cancels probing and deletes all selected hosts with a single backup', async t => {
  const signals = [];
  const { service, configPath } = await orderedService(t, { probe: (_item, { signal }) => new Promise(resolve => {
    signals.push(signal); signal.addEventListener('abort', () => resolve(codex), { once: true });
  }) });
  const before = service.snapshot(), original = await fs.readFile(configPath, 'utf8');
  const refresh = service.refreshHosts();
  await new Promise(resolve => setImmediate(resolve));
  const result = await service.deleteHosts(before.hosts.map(item => item.id), before.revision);
  await refresh;
  assert.deepEqual(result.hosts, []);
  assert.equal(result.refresh.running, false);
  assert.ok(signals.every(signal => signal.aborted));
  assert.equal(await fs.readFile(configPath, 'utf8'), '');
  const backups = (await fs.readdir(path.dirname(configPath))).filter(name => name.includes('.codex-manager-backup-'));
  assert.equal(backups.length, 1);
  assert.equal(await fs.readFile(path.join(path.dirname(configPath), backups[0]), 'utf8'), original);
  assert.equal(service.active.size, 0);
});

test('pending deletion reserves targets against upgrades, login and another deletion', async t => {
  let completeDelete; let deleted = 0;
  const hosts = [{ ...host, id: 'host-0', alias: 'host0' }, { ...host, id: 'host-1', alias: 'host1' }];
  const service = makeService({ configStore: {
    read: async () => ({ configPath: '/tmp/test-config', revision: 'one', hosts }),
    removeMany: async () => { deleted += 1; return new Promise(resolve => { completeDelete = resolve; }); },
  } });
  t.after(() => service.close());
  await service.init();
  const unrelated = new AbortController(); service.active.set('host-1', unrelated);
  const deletion = service.deleteHosts(['host-0'], 'one');
  await assert.rejects(service.upgradeCodex('host-0'), /다른 작업/);
  await assert.rejects(service.startCodexLogin('host-0'), /다른 작업/);
  await assert.rejects(service.deleteHosts(['host-0'], 'one'), /작업이 진행 중/);
  assert.equal(deleted, 1);
  assert.equal(unrelated.signal.aborted, false);
  completeDelete({ configPath: '/tmp/test-config', revision: 'two', hosts: [hosts[1]], groups: [] });
  const result = await deletion;
  assert.deepEqual(result.hosts.map(item => item.id), ['host-1']);
  assert.equal(service.active.has('host-0'), false);
  assert.equal(service.active.get('host-1'), unrelated);
  assert.equal(service.pending.size, 0);
  service.active.delete('host-1');
});

test('failed and competing deletions release reservations without a partial config write', async t => {
  const { service, configPath } = await orderedService(t);
  const before = service.snapshot(), ids = before.hosts.map(item => item.id);
  const external = (await fs.readFile(configPath, 'utf8')) + '# external change\n';
  await fs.writeFile(configPath, external);
  await assert.rejects(service.deleteHosts(ids, before.revision), /설정이 변경/);
  assert.equal(service.active.size, 0);
  assert.equal(service.pending.size, 0);
  assert.equal(await fs.readFile(configPath, 'utf8'), external);
  assert.deepEqual(await fs.readdir(path.dirname(configPath)), ['config']);
  const latest = await service.reloadHosts();
  const results = await Promise.allSettled([
    service.deleteHosts([ids[0]], latest.revision),
    service.deleteHosts([ids[1]], latest.revision),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal(service.snapshot().hosts.length, 1);
  assert.equal(service.active.size, 0);
  const backups = (await fs.readdir(path.dirname(configPath))).filter(name => name.includes('.codex-manager-backup-'));
  assert.equal(backups.length, 1);
  assert.equal(await fs.readFile(path.join(path.dirname(configPath), backups[0]), 'utf8'), external);
});
