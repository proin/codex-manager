'use strict';

const { DISCOVER_SCRIPT, remoteShell, buildSshArgs, commandError } = require('./host-ssh.cjs');

const DEVICE_AUTH_TIMEOUT_MS = 15 * 60 * 1000;
const LOGIN_HOSTS = new Set(['auth.openai.com', 'auth0.openai.com', 'chatgpt.com']);

function loginError(message, kind = 'error') { const error = new Error(message); error.kind = kind; return error; }
function boundedString(value, limit) { return typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value); }

function validateDeviceLogin(result) {
  const url = result?.verificationUrl;
  if (!boundedString(result?.loginId, 256) || !boundedString(url, 4096) || !boundedString(result?.userCode, 64) || !/^[A-Z0-9-]+$/i.test(result.userCode)) {
    throw loginError('서버에서 로그인 코드와 주소를 받지 못했습니다. Codex를 업그레이드한 뒤 다시 시도하십시오.');
  }
  let parsed;
  try { parsed = new URL(url); } catch { throw loginError('서버에서 올바른 로그인 주소를 받지 못했습니다.'); }
  if (parsed.protocol !== 'https:' || !LOGIN_HOSTS.has(parsed.hostname) || parsed.username || parsed.password || parsed.port) {
    throw loginError('서버에서 올바른 로그인 주소를 받지 못했습니다.');
  }
  return { loginId: result.loginId, url: parsed.href, userCode: result.userCode };
}

// The existing remote Codex profile performs the login. No logout, profile
// override, authentication-file access, or credential transfer is performed.
async function loginCodexOnHost(run, configPath, host, options = {}) {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs || DEVICE_AUTH_TIMEOUT_MS;
  let child; let finishRun; let buffer = ''; let metadata; let login; let verified;
  let failure; let stopReason; let stopTimer; let finished = false; let initialized = false; let verifying = false;
  const earlyCompletions = new Map();
  const send = (message) => {
    if (!child?.stdin || controller.signal.aborted) return;
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const finish = (error, result) => {
    if (finished) return;
    finished = true; failure = error || null; verified = result;
    finishRun?.({ code: error ? 255 : 0 }, true);
  };
  const stop = (reason) => {
    if (finished || stopReason) return;
    stopReason = reason;
    if (login && child) {
      try { send({ id: 4, method: 'account/login/cancel', params: { loginId: login.loginId } }); } catch { /* Termination also cancels a pending device flow. */ }
      // Give the server a brief opportunity to acknowledge cancellation before
      // terminating SSH and all ProxyJump processes.
      stopTimer = setTimeout(() => controller.abort(), 250);
    } else controller.abort();
  };
  const canceled = () => stop('canceled');
  const completed = (params) => {
    if (stopReason || finished || verifying || !login || params.loginId !== login.loginId) return;
    if (params.success !== true) { finish(loginError('로그인에 실패했습니다. ChatGPT의 보안 설정에서 기기 코드 로그인을 허용한 뒤 다시 시도하십시오.')); return; }
    verifying = true;
    options.onState?.({ status: 'verifying' });
    send({ id: 3, method: 'account/read', params: { refreshToken: false } });
  };
  const timeout = setTimeout(() => stop('timeout'), timeoutMs);
  options.signal?.addEventListener('abort', canceled, { once: true });
  if (options.signal?.aborted) canceled();
  let result;
  try {
    result = await run('ssh', buildSshArgs(configPath, host, remoteShell(`${DISCOVER_SCRIPT}\nexec "$codex_bin" app-server\n`), options), {
      signal: controller.signal, timeoutMs: timeoutMs + 1000,
      // Do not retain protocol replies or Codex logs in process output.
      captureOutput: false,
      onStart: (process) => {
        child = process;
        if (stopReason) { controller.abort(); return; }
        send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'codex_account_manager', title: 'Codex Account Manager', version: '0.2.4' } } });
      },
      onStdout: (chunk, process, finishProcess) => {
        child = process; finishRun = finishProcess;
        if (finished) return;
        buffer += chunk;
        if (buffer.length > 65536) { finish(loginError('서버의 로그인 응답을 읽지 못했습니다.')); return; }
        let newline;
        while (!finished && (newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
          if (line.startsWith('CODEX_MANAGER_META ')) {
            let value;
            try { value = JSON.parse(line.slice(19)); } catch { finish(loginError('서버에서 Codex 정보를 읽지 못했습니다.')); return; }
            if (value.available !== true) { finish(loginError('호스트에 Codex가 설치되어 있지 않습니다.')); return; }
            metadata = {
              available: true,
              version: boundedString(value.version, 64) && /^[0-9]+\.[0-9]+\.[0-9]+[A-Za-z0-9.+-]*$/.test(value.version) ? value.version : null,
              installMethod: ['npm', 'homebrew', 'manual'].includes(value.installMethod) ? value.installMethod : null,
            };
            continue;
          }
          let message;
          try { message = JSON.parse(line); } catch { continue; }
          if (!message || typeof message !== 'object') continue;
          if (stopReason) {
            if (message.id === 4 && !message.method) controller.abort();
            continue;
          }
          if (message.method && Object.hasOwn(message, 'id')) {
            send({ id: message.id, error: { code: -32601, message: 'Unsupported server request' } });
          } else if (message.id === 1 && !message.method) {
            if (initialized) continue;
            if (message.error || !metadata) { finish(loginError('호스트의 Codex에 연결하지 못했습니다. Codex를 업그레이드한 뒤 다시 시도하십시오.')); return; }
            initialized = true;
            send({ method: 'initialized' });
            send({ id: 2, method: 'account/login/start', params: { type: 'chatgptDeviceCode' } });
          } else if (message.id === 2 && !message.method) {
            if (!initialized || login) continue;
            if (message.error) { finish(loginError('기기 코드 로그인을 시작하지 못했습니다. ChatGPT의 보안 설정과 호스트의 Codex 버전을 확인하십시오.')); return; }
            try { login = validateDeviceLogin(message.result); } catch (error) { finish(error); return; }
            options.onState?.({ status: 'waiting', url: login.url, userCode: login.userCode });
            const early = earlyCompletions.get(login.loginId);
            earlyCompletions.clear();
            if (early) completed(early);
          } else if (message.method === 'account/login/completed') {
            const params = message.params;
            if (!boundedString(params?.loginId, 256)) continue;
            const completion = { loginId: params.loginId, success: params.success === true };
            if (login) completed(completion);
            else if (earlyCompletions.size < 4) earlyCompletions.set(params.loginId, completion);
          } else if (message.id === 3 && !message.method) {
            if (!verifying) continue;
            const account = message.result?.account;
            if (message.error || account?.type !== 'chatgpt' || !boundedString(account.email, 254) || !/^[^\s@]+@[^\s@]+$/.test(account.email) || !metadata) {
              finish(loginError('로그인 요청을 처리했습니다. 호스트의 로그인 계정을 다시 조회하십시오.')); return;
            }
            finish(null, { ...metadata, accountEmail: account.email, accountPlan: boundedString(account.planType, 80) ? account.planType : null, loginStatus: 'chatgpt' });
          }
        }
      },
    });
  } finally {
    clearTimeout(timeout); clearTimeout(stopTimer);
    options.signal?.removeEventListener('abort', canceled);
    buffer = ''; earlyCompletions.clear(); child = null; login = null;
  }
  if (stopReason === 'canceled') throw loginError('계정 전환을 취소했습니다.', 'canceled');
  if (stopReason === 'timeout' || result?.timedOut) throw loginError('로그인 제한 시간이 지났습니다. 다시 시작하십시오.', 'timeout');
  if (failure) throw failure;
  if (!verified) throw loginError(result?.code !== 0 ? commandError(result || {}).message : '로그인이 완료되지 않았습니다. 다시 시도하십시오.');
  return verified;
}

module.exports = { loginCodexOnHost, validateDeviceLogin, DEVICE_AUTH_TIMEOUT_MS };
