'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');

const OUTPUT_LIMIT = 256 * 1024;
const PROBE_TIMEOUT_MS = 15000;
const SSH_OPTIONS = {
  ConnectTimeout: '5', ConnectionAttempts: '1', ServerAliveInterval: '3',
  ServerAliveCountMax: '1', StrictHostKeyChecking: 'yes', UpdateHostKeys: 'no',
  PermitLocalCommand: 'no', ClearAllForwardings: 'yes', ForwardAgent: 'no',
  ControlMaster: 'no', ControlPath: 'none', ControlPersist: 'no', RemoteCommand: 'none',
};

function assertAlias(alias) {
  if (typeof alias !== 'string' || !alias || /^-/.test(alias) || /[\s*?!\x00-\x1f\x7f]/.test(alias)) {
    throw new Error('개별 호스트 이름을 선택하십시오.');
  }
  return alias;
}

function shellQuote(value) { return `'${String(value).replace(/'/g, `'"'"'`)}'`; }

// Windows OpenSSH launches ProxyCommand directly; it does not parse POSIX quotes.
function localCommandQuote(value, platform = process.platform) {
  if (platform !== 'win32') return shellQuote(value);
  return `"${String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

function buildSshArgs(configPath, host, command, { password = false, identityFile, proxyCommand } = {}) {
  assertAlias(host.alias);
  const options = { ...SSH_OPTIONS, BatchMode: password ? 'no' : 'yes', NumberOfPasswordPrompts: password ? '1' : '0', ...(proxyCommand ? { ProxyCommand: proxyCommand, ProxyJump: 'none' } : {}) };
  return ['-F', configPath, '-T', ...Object.entries(options).flatMap(([key, value]) => ['-o', `${key}=${value}`]),
    ...(identityFile ? ['-i', identityFile] : []), '--', host.alias, command];
}

function terminateProcessGroup(child, platform = process.platform, spawnImpl = spawn) {
  if (!child?.pid) return;
  if (platform === 'win32') {
    // ProxyJump opens additional ssh processes, so cancel the whole Windows tree.
    const fallback = () => { try { child.kill('SIGKILL'); } catch { /* Already exited. */ } };
    try {
      const killer = spawnImpl('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
      killer.once('error', fallback);
      killer.once('close', (code) => { if (code !== 0) fallback(); });
      return;
    } catch { fallback(); return; }
  }
  if (platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL'); return; } catch { /* Already exited. */ }
  }
  try { child.kill('SIGKILL'); } catch { /* Already exited. */ }
}

function runProcess(command, args, options = {}) {
  const spawnImpl = options.spawnImpl || spawn;
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let child; let timer; let stdout = ''; let stderr = ''; let settled = false;
    const finish = (extra = {}, terminate = false) => {
      if (settled) return;
      settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
      if (terminate) { terminateProcessGroup(child); child?.stdin?.destroy(); child?.stdout?.destroy(); child?.stderr?.destroy(); }
      resolve({ code: 255, stdout, stderr, timedOut: false, canceled: false, durationMs: Date.now() - startedAt, ...extra });
    };
    const abort = () => finish({ canceled: true }, true);
    if (options.signal?.aborted) { abort(); return; }
    try {
      child = spawnImpl(command, args, {
        env: { ...process.env, SSH_ASKPASS_REQUIRE: 'never', DISPLAY: '', ...options.env },
        detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch { finish({ stderr: 'SSH 명령을 실행하지 못했습니다.' }); return; }
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > OUTPUT_LIMIT) { finish({ stderr: '호스트 응답이 너무 큽니다.' }, true); return; }
      try { options.onStdout?.(chunk.toString(), child, finish); } catch { finish({ stderr: '호스트 응답을 읽지 못했습니다.' }, true); }
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-16000); });
    child.stdin.on('error', () => {});
    child.once('error', () => finish({ stderr: 'SSH 명령을 실행하지 못했습니다.' }, true));
    child.once('close', (code, signal) => finish({ code: code ?? 255, signal }));
    options.signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => finish({ timedOut: true }, true), options.timeoutMs || PROBE_TIMEOUT_MS);
    try {
      if (options.onStart) options.onStart(child);
      else child.stdin.end(options.input || '');
    } catch { finish({ stderr: 'SSH 입력을 전달하지 못했습니다.' }, true); }
    if (options.signal?.aborted) abort();
  });
}

function commandError(result, mutation = false) {
  if (result.canceled) return new Error(mutation ? '작업이 중지되었습니다. 서버 상태를 다시 조회하십시오.' : '조회가 중지되었습니다.');
  if (result.timedOut) return new Error(mutation ? '작업 시간이 초과되었습니다. 서버 상태를 다시 조회하십시오.' : '호스트가 제한 시간 안에 응답하지 않았습니다.');
  const error = String(result.stderr || '');
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|No .* host key is known/i.test(error)) return new Error('SSH 서버 키를 확인하지 못했습니다. 터미널에서 해당 호스트에 접속한 뒤 다시 시도하십시오.');
  if (/Permission denied|Authentication failed|Too many authentication failures/i.test(error)) return new Error('SSH 인증에 실패했습니다. 키 또는 서버 비밀번호를 확인하십시오.');
  if (/Could not resolve hostname|Name or service not known|nodename nor servname/i.test(error)) return new Error('호스트 주소를 찾을 수 없습니다.');
  if (/Connection refused/i.test(error)) return new Error('SSH 연결이 거부되었습니다. 주소와 포트를 확인하십시오.');
  if (/unsupported-install/i.test(error)) return new Error('이 설치 방식은 자동 업그레이드를 지원하지 않습니다. 서버에서 Codex를 업그레이드하십시오.');
  return new Error(mutation ? '서버 작업을 완료하지 못했습니다. SSH 접속과 설치 권한을 확인하십시오.' : '호스트에 연결하지 못했습니다. SSH 접속 정보를 확인하십시오.');
}

async function withAskpass(password, callback, { platform = process.platform } = {}) {
  if (password == null || password === '') return callback({});
  if (typeof password !== 'string' || password.length > 4096 || /[\r\n\x00]/.test(password)) throw new Error('서버 비밀번호를 올바르게 입력하십시오.');
  if (platform === 'win32') throw new Error('Windows에서는 SSH 키로 접속하십시오.');
  let secret = password;
  // /tmp avoids macOS Unix socket path limits for long Application Support paths.
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cam-ssh-'));
  await fs.chmod(directory, 0o700);
  const socketPath = path.join(directory, 'p');
  const token = crypto.randomBytes(32).toString('hex');
  const server = net.createServer({ allowHalfOpen: true }, (client) => {
    let request = '';
    client.setTimeout(5000, () => client.destroy());
    client.on('error', () => {});
    client.on('data', (chunk) => {
      request += chunk.toString();
      if (request.length > 8192) { client.destroy(); return; }
      if (!request.includes('\n')) return;
      try {
        const data = JSON.parse(request.trim());
        // Never answer host-key, PIN, or private-key passphrase prompts.
        const allowed = data.token === token && /password:/i.test(data.prompt || '') && !/passphrase|pin|yes\/no|authenticity/i.test(data.prompt || '');
        client.end(JSON.stringify(allowed ? { password: secret } : {}));
      } catch { client.end('{}'); }
      request = '';
    });
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    await fs.chmod(socketPath, 0o600);
    const helper = path.join(directory, 'askpass');
    await fs.writeFile(helper, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shellQuote(process.execPath)} ${shellQuote(path.join(__dirname, 'ssh-askpass.cjs'))} "$@"\n`, { mode: 0o700 });
    return await callback({ SSH_ASKPASS: helper, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: 'codex-manager', CODEX_MANAGER_ASKPASS_SOCKET: socketPath, CODEX_MANAGER_ASKPASS_TOKEN: token });
  } finally {
    secret = '';
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function parseEffectiveConfig(text) {
  const values = {};
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^([^\s]+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const [ , key, value ] = match;
    if (!Object.hasOwn(values, key)) values[key] = value;
  }
  return { hostName: values.hostname || '', user: values.user || '', port: values.port || '22', identityFile: values.identityfile || '', proxyJump: values.proxyjump === 'none' ? '' : values.proxyjump || '', identities: String(text).split(/\r?\n/).filter((line) => line.startsWith('identityfile ')).map((line) => line.slice(13)) };
}

function parseAuthorizedKeys(text, localPublicKey = '') {
  const local = publicKeyParts(localPublicKey);
  const keys = [];
  String(text).split(/\r?\n/).forEach((line, index) => {
    if (!line.trim() || line.trimStart().startsWith('#')) return;
    const part = publicKeyParts(line);
    if (!part) return;
    keys.push({ id: crypto.createHash('sha256').update(`${index}:${line}`).digest('hex').slice(0, 16), lineNumber: index + 1, keyType: part.type, comment: part.comment, fingerprint: `SHA256:${crypto.createHash('sha256').update(Buffer.from(part.blob, 'base64')).digest('base64').replace(/=+$/, '')}`, matchesLocal: Boolean(local && part.type === local.type && part.blob === local.blob) });
  });
  return keys;
}

function publicKeyParts(value) {
  if (typeof value !== 'string' || /[\r\n\x00]/.test(value)) return null;
  const tokens = value.trim().split(/\s+/);
  const index = tokens.findIndex((token) => /^(?:ssh-(?:rsa|ed25519|dss)|ecdsa-sha2-[\w-]+|sk-[\w@.-]+|rsa-sha2-[\w-]+)$/.test(token));
  if (index < 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(tokens[index + 1] || '')) return null;
  return { type: tokens[index], blob: tokens[index + 1], comment: tokens.slice(index + 2).join(' ') };
}

function registrationScript(publicKey) {
  const parts = publicKeyParts(publicKey);
  if (!parts || !publicKey.trim().startsWith(parts.type + ' ')) throw new Error('등록할 공개 키를 읽지 못했습니다.');
  return `set -eu\nmkdir -p "$HOME/.ssh"\nchmod 700 "$HOME/.ssh"\ntouch "$HOME/.ssh/authorized_keys"\nif ! awk -v type=${shellQuote(parts.type)} -v blob=${shellQuote(parts.blob)} '{ for (i=1;i<NF;i++) if ($i==type && $(i+1)==blob) found=1 } END { exit found ? 0 : 1 }' "$HOME/.ssh/authorized_keys"; then\n  printf '\\n%s\\n' ${shellQuote(publicKey.trim())} >> "$HOME/.ssh/authorized_keys"\nfi\nchmod 600 "$HOME/.ssh/authorized_keys"\nprintf 'CODEX_KEY_REGISTERED\\n'\n`;
}

// This script reads executable metadata and then replaces its shell with
// app-server. No authentication file is opened by the manager.
const DISCOVER_SCRIPT = `
PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
export PATH
if ! command -v codex >/dev/null 2>&1; then
  for directory in "$HOME"/.nvm/versions/node/*/bin "$HOME"/.local/share/fnm/node-versions/*/installation/bin; do
    if [ -x "$directory/codex" ]; then PATH="$directory:$PATH"; export PATH; break; fi
  done
fi
codex_bin=$(command -v codex 2>/dev/null || true)
if [ -z "$codex_bin" ]; then printf 'CODEX_MANAGER_META {"available":false}\\n'; exit 0; fi
codex_real="$codex_bin"
for step in 1 2 3 4 5 6 7 8; do
  [ -L "$codex_real" ] || break
  target=$(readlink "$codex_real")
  case "$target" in /*) codex_real="$target" ;; *) codex_real="$(dirname "$codex_real")/$target" ;; esac
done
install_method=manual
case "$codex_real" in */node_modules/@openai/codex/*|*/node_modules/@openai/codex-*/vendor/*) install_method=npm ;; esac
if [ "$install_method" = manual ]; then
  case "$codex_real" in */Caskroom/codex/*) install_method=homebrew ;; esac
fi
version=$("$codex_bin" --version 2>/dev/null | sed -n 's/^codex-cli \\([0-9][0-9A-Za-z.+-]*\\).*$/\\1/p' | head -n 1)
if [ -z "$version" ]; then printf 'CODEX_MANAGER_META {"available":false}\\n'; exit 0; fi
printf 'CODEX_MANAGER_META {"available":true,"version":"%s","installMethod":"%s"}\\n' "$version" "$install_method"
`;

function remoteShell(script) { return `exec "\${SHELL:-/bin/sh}" -lc ${shellQuote(script)}`; }

async function probeCodex(run, configPath, host, options = {}) {
  let metadata = null; let buffer = ''; let account = null; let accountError = false; let accountRead = false;
  const command = remoteShell(`${DISCOVER_SCRIPT}\nexec "$codex_bin" app-server\n`);
  const result = await run('ssh', buildSshArgs(configPath, host, command, options), {
    signal: options.signal, timeoutMs: options.timeoutMs || PROBE_TIMEOUT_MS,
    onStart: (child) => child.stdin.write(`${JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'codex_account_manager', title: 'Codex Account Manager', version: '0.2.3' } } })}\n`),
    onStdout: (chunk, child, finish) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
        if (line.startsWith('CODEX_MANAGER_META ')) {
          metadata = JSON.parse(line.slice(19));
          if (!metadata.available) finish({ code: 0 }, true);
          continue;
        }
        let message; try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1 && !message.method) {
          if (message.error) { accountError = true; finish({ code: 0 }, true); return; }
          child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n${JSON.stringify({ id: 2, method: 'account/read', params: { refreshToken: false } })}\n`);
        } else if (message.id === 2 && !message.method) {
          accountRead = true;
          if (message.error) accountError = true;
          else account = message.result?.account || null;
          finish({ code: 0 }, true); return;
        } else if (message.method && Object.hasOwn(message, 'id')) {
          child.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: 'Unsupported server request' } })}\n`);
        }
      }
    },
  });
  if (result.code !== 0 && !metadata?.available) throw commandError(result);
  if (!metadata) throw new Error('호스트에서 Codex 정보를 읽지 못했습니다.');
  accountError ||= metadata.available && (!accountRead || result.code !== 0);
  return {
    available: Boolean(metadata.available), version: metadata.version || null,
    installMethod: metadata.installMethod || null,
    accountEmail: account?.type === 'chatgpt' && typeof account.email === 'string' ? account.email : null,
    accountPlan: account?.type === 'chatgpt' && typeof account.planType === 'string' ? account.planType : null,
    loginStatus: !metadata.available ? 'unavailable' : accountError ? 'unknown' : account?.type === 'chatgpt' ? 'chatgpt' : account?.type === 'apiKey' ? 'apiKey' : account ? String(account.type || 'other') : 'loggedOut',
  };
}

async function secureProxyCommand(run, configPath, host, { password = false, signal, platform = process.platform } = {}) {
  const common = { ...SSH_OPTIONS, BatchMode: password ? 'no' : 'yes', NumberOfPasswordPrompts: password ? '1' : '0', ProxyJump: 'none' };
  const resolve = async (alias, overrides = [], seen = []) => {
    assertAlias(alias);
    if (seen.includes(alias) || seen.length >= 8) throw new Error('중간 접속 호스트 설정을 확인하십시오.');
    const result = await run('ssh', ['-F', configPath, '-G', ...overrides, '--', alias], { signal, timeoutMs: 5000 });
    if (result.code !== 0) throw commandError(result);
    const effective = parseEffectiveConfig(result.stdout);
    if (!effective.proxyJump) return null;
    if (!/^[A-Za-z0-9_.:@,[\]-]+$/.test(effective.proxyJump)) throw new Error('중간 접속 호스트 설정을 확인하십시오.');
    const jumps = effective.proxyJump.split(',');
    let previous = null;
    for (const jump of jumps) {
      const match = /^(?:([A-Za-z0-9_.-]+)@)?(\[[A-Fa-f0-9:]+\]|[A-Za-z0-9_.-]+)(?::([0-9]+))?$/.exec(jump);
      if (!match) throw new Error('중간 접속 호스트 설정을 확인하십시오.');
      const jumpAlias = match[2].replace(/^\[|\]$/g, '');
      const jumpOverrides = [...(match[1] ? ['-l', match[1]] : []), ...(match[3] ? ['-p', match[3]] : [])];
      const nested = previous || await resolve(jumpAlias, jumpOverrides, [...seen, alias]);
      const args = ['-F', configPath, '-T', ...Object.entries(common).flatMap(([key, value]) => ['-o', `${key}=${value}`]), ...(nested ? ['-o', `ProxyCommand=${nested.replace(/%/g, '%%')}`] : []), ...jumpOverrides, '-W', '[%h]:%p', '--', jumpAlias];
      previous = [platform === 'win32' ? 'ssh.exe' : 'ssh', ...args].map((value) => localCommandQuote(value, platform)).join(' ');
    }
    return previous;
  };
  return resolve(host.alias);
}

function upgradeScript() {
  return remoteShell(`set -e\n${DISCOVER_SCRIPT}\ncase "$install_method" in\n npm) command -v npm >/dev/null 2>&1 || exit 1; npm install -g @openai/codex@latest ;;\n homebrew) command -v brew >/dev/null 2>&1 || exit 1; brew upgrade --cask codex ;;\n *) printf 'unsupported-install\\n' >&2; exit 1 ;;\nesac\n"$codex_bin" --version\n`);
}

module.exports = { SSH_OPTIONS, PROBE_TIMEOUT_MS, assertAlias, shellQuote, localCommandQuote, buildSshArgs, runProcess, terminateProcessGroup, commandError, withAskpass, parseEffectiveConfig, parseAuthorizedKeys, publicKeyParts, registrationScript, DISCOVER_SCRIPT, remoteShell, probeCodex, secureProxyCommand, upgradeScript };
