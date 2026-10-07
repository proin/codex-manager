#!/usr/bin/env node
'use strict';

// Read-only integration test. Never starts a login, copies credentials, or consumes a reset.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { findRuntime } = require('../electron/runtime.cjs');

const execute = promisify(execFile);

function isolatedEnvironment(home) {
  const environment = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'WINDIR']) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  environment.CODEX_HOME = home;
  return environment;
}

async function connect(runtime, home, environment) {
  const child = spawn(runtime.command, [...runtime.args, 'app-server', '--listen', 'stdio://'], {
    cwd: home, env: environment, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false,
  });
  const pending = new Map();
  let sequence = 0;
  let closed = false;
  const closedPromise = new Promise((resolve) => child.once('close', () => { closed = true; resolve(); }));
  const rejectPending = (message) => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(message)); }
    pending.clear();
  };
  child.on('error', () => rejectPending('app-server could not start.'));
  child.on('exit', () => rejectPending('app-server closed before responding.'));
  child.stdin.on('error', () => rejectPending('app-server input closed.'));
  // Do not print server logs; logs can include environment-specific account data.
  child.stderr.on('data', () => {});
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    entry.resolve(message);
  });
  return {
    request(method, params) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out.`)); }, 10000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) })}\n`);
      });
    },
    notify(method) { child.stdin.write(`${JSON.stringify({ method })}\n`); },
    async close() {
      rejectPending('Integration test finished.');
      lines.close();
      child.stdin.end();
      if (!closed) child.kill('SIGTERM');
      let timer;
      await Promise.race([closedPromise, new Promise((resolve) => { timer = setTimeout(resolve, 1500); })]);
      clearTimeout(timer);
      if (!closed) { child.kill('SIGKILL'); await closedPromise; }
    },
  };
}

async function main() {
  const runtime = await findRuntime(process.argv[2]);
  if (!runtime.available) throw new Error(runtime.error);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-account-manager-smoke-'));
  await fs.chmod(temporary, 0o700);
  const home = path.join(temporary, 'home');
  const schemaDirectory = path.join(temporary, 'schema');
  let client;
  try {
    await fs.mkdir(home, { mode: 0o700 });
    await fs.mkdir(schemaDirectory, { mode: 0o700 });
    await fs.writeFile(path.join(home, 'config.toml'), 'cli_auth_credentials_store = "keyring"\n', { mode: 0o600 });
    const environment = isolatedEnvironment(home);
    await execute(runtime.command, [...runtime.args, 'app-server', 'generate-json-schema', '--out', schemaDirectory], {
      cwd: home, env: environment, timeout: 20000, maxBuffer: 1024 * 1024, windowsHide: true, shell: false,
    });
    const schema = await fs.readFile(path.join(schemaDirectory, 'ClientRequest.json'), 'utf8');
    const capability = {
      login: schema.includes('"account/login/start"'),
      deviceCode: schema.includes('"chatgptDeviceCode"'),
      account: schema.includes('"account/read"'),
      usage: schema.includes('"account/rateLimits/read"'),
      usageHistory: schema.includes('"account/usage/read"'),
      reset: schema.includes('"account/rateLimitResetCredit/consume"'),
      selectedResetCredit: schema.includes('"creditId"'),
    };
    if (!Object.values(capability).every(Boolean)) throw new Error('The installed Codex CLI does not expose all required account methods.');
    client = await connect(runtime, home, environment);
    const initialized = await client.request('initialize', {
      clientInfo: { name: 'codex_account_manager_smoke', title: 'Codex Account Manager Test', version: require('../package.json').version },
    });
    if (!initialized.result || initialized.error) throw new Error('app-server initialization failed.');
    client.notify('initialized');
    const account = await client.request('account/read', { refreshToken: false });
    if (account.error || account.result?.account !== null) throw new Error('The isolated test did not return an unauthenticated account.');
    const limits = await client.request('account/rateLimits/read');
    if (!limits.error || limits.error.code === -32601 || !/auth|log.?in|sign.?in|chatgpt/i.test(limits.error.message || '')) {
      throw new Error('Expected an authentication error for isolated rate-limit lookup.');
    }
    const history = await client.request('account/usage/read');
    if (!history.error || history.error.code === -32601 || !/auth|log.?in|sign.?in|chatgpt/i.test(history.error.message || '')) {
      throw new Error('Expected an authentication error for isolated usage-history lookup.');
    }
    console.log(JSON.stringify({
      ok: true,
      runtime: { path: runtime.path, version: runtime.version },
      schema: capability,
      initialized: true,
      account: null,
      usageRequiresLogin: true,
      usageHistoryRequiresLogin: true,
      loginStarted: false,
      resetConsumed: false,
    }, null, 2));
  } finally {
    if (client) await client.close();
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`Runtime integration test failed: ${error.message}`);
  process.exitCode = 1;
});
