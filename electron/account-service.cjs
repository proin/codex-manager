'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { RpcClient } = require('./rpc-client.cjs');
const { emptyStatistics, restoreStatistics, publicDetails, tokenUsage, recordSnapshot, recordReset } = require('./statistics.cjs');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OUTCOMES = {
  reset: '사용량이 초기화되었습니다.',
  alreadyRedeemed: '이미 처리된 초기화 요청입니다.',
  nothingToReset: '초기화할 사용량이 없습니다.',
  noCredit: '사용할 초기화권이 없습니다.',
};
const clone = (value) => structuredClone(value);
const now = () => new Date().toISOString();

function validCreditId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024
    && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
}

// New IPC requests select a credit; null remains available for legacy retries.
function validateResetSelections(ids, selections, accounts, { requireSelection = false } = {}) {
  if (selections != null && (typeof selections !== 'object' || Array.isArray(selections)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(selections)))) {
    throw new Error('사용할 초기화권을 선택하십시오.');
  }
  if (selections != null) {
    const entries = Object.entries(selections);
    if (entries.length > ids.length || entries.some(([id, value]) => !ids.includes(id) || !validCreditId(value))) {
      throw new Error('선택한 초기화권 정보가 올바르지 않습니다.');
    }
  }
  for (const id of ids) {
    const account = accounts.find(row => row.id === id);
    if (!account) throw new Error('계정을 찾을 수 없습니다.');
    const retry = account.resetAttempt?.status === 'uncertain';
    const selected = selections != null && Object.hasOwn(selections, id) ? selections[id] : null;
    if (retry && selected != null && selected !== account.resetAttempt.creditId) {
      throw new Error('처리 결과를 받지 못한 요청은 같은 초기화권으로 다시 시도하십시오.');
    }
    if (!retry && selected == null && (requireSelection || selections != null)) {
      throw new Error('사용할 초기화권을 선택하십시오.');
    }
  }
  return selections == null ? null : Object.fromEntries(Object.entries(selections));
}

function selectedCreditError(summary, creditId) {
  if (!Array.isArray(summary?.credits)) return '이 계정의 초기화권 목록을 조회할 수 없습니다. 다시 조회하십시오.';
  const matches = summary.credits.filter(row => row?.id === creditId);
  if (matches.length !== 1) return '선택한 초기화권을 찾을 수 없습니다. 목록을 다시 조회하십시오.';
  const credit = matches[0];
  if (credit.resetType !== 'codexRateLimits') return '선택한 초기화권은 이 앱에서 사용할 수 없습니다.';
  if (credit.status !== 'available') return '선택한 초기화권은 사용할 수 없습니다. 목록을 다시 조회하십시오.';
  const timestamp = Date.now() / 1000;
  if (!Number.isSafeInteger(credit.grantedAt) || credit.grantedAt < 0
    || (credit.expiresAt != null && (!Number.isSafeInteger(credit.expiresAt) || credit.expiresAt < credit.grantedAt))) {
    return '선택한 초기화권의 사용기간을 확인할 수 없습니다.';
  }
  if (credit.grantedAt > timestamp) return '선택한 초기화권은 아직 사용할 수 없습니다.';
  if (credit.expiresAt != null && credit.expiresAt <= timestamp) return '선택한 초기화권의 사용기간이 지났습니다.';
  return null;
}

function labelValue(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 60 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error('계정 이름은 1~60자로 입력하십시오.');
  }
  return value.trim();
}

function friendlyError(error, operation = '요청') {
  if (error?.code === 'MISSING_COMMAND') return 'Codex CLI를 설치한 뒤 다시 시도하십시오.';
  if (error?.code === 'TIMEOUT') return `${operation} 시간이 초과되었습니다. 다시 시도하십시오.`;
  if (error?.code === 'SPAWN_ERROR') return 'Codex를 실행하지 못했습니다. 설치 경로를 확인하십시오.';
  if (error?.code === -32601 || error?.code === -32602) return '설치된 Codex가 이 기능을 지원하지 않습니다. Codex를 업데이트하십시오.';
  return `${operation}에 실패했습니다. 연결 상태와 로그인을 확인하십시오.`;
}

function profileEnvironment(profileDir) {
  const env = {};
  const allowed = /^(HOME|PATH|USER|USERNAME|LOGNAME|LANG|LC_[A-Z_]+|TMPDIR|TMP|TEMP|SYSTEMROOT|WINDIR|APPDATA|LOCALAPPDATA|USERPROFILE|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_FILE|SSL_CERT_DIR)$/i;
  for (const [key, value] of Object.entries(process.env)) if (allowed.test(key)) env[key] = value;
  env.CODEX_HOME = profileDir;
  return env;
}

class AccountService {
  constructor({ dataDir, command = '', args = ['app-server'], onChange = () => {}, clientFactory = (options) => new RpcClient(options) }) {
    if (!dataDir || !path.isAbsolute(dataDir)) throw new Error('계정 저장 폴더의 전체 경로가 필요합니다.');
    this.dataDir = dataDir;
    this.command = command;
    this.args = args.includes('app-server') ? [...args] : [...args, 'app-server'];
    this.onChange = onChange;
    this.clientFactory = clientFactory;
    this.accounts = [];
    this.activity = [];
    this.refresh = { running: false, done: 0, total: 0 };
    this.clients = new Map();
    this.refreshTasks = new Map();
    this.detailTasks = new Map();
    this.resetTasks = new Map();
    this.resetTaskSelections = new Map();
    this.removing = new Set();
    this.loginEpochs = new Map();
    this.earlyLogins = new Map();
    this.loginStarting = new Set();
    this.activeReads = 0;
    this.readQueue = [];
    this.activeResets = 0;
    this.resetQueue = [];
    this.activeBatches = 0;
    this.saveChain = Promise.resolve();
    this.closed = false;
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return this.snapshot();
    await fs.mkdir(path.join(this.dataDir, 'profiles'), { recursive: true, mode: 0o700 });
    await fs.chmod(this.dataDir, 0o700);
    await fs.chmod(path.join(this.dataDir, 'profiles'), 0o700);
    let saved;
    try { saved = JSON.parse(await fs.readFile(path.join(this.dataDir, 'accounts.json'), 'utf8')); } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('저장된 계정 목록을 읽지 못했습니다. 계정 파일을 보존한 상태로 앱을 종료하십시오.');
    }
    if (saved) {
      if (saved.version !== 1 || !Array.isArray(saved.accounts) || saved.accounts.length > 100) {
        throw new Error('계정 파일 형식이 올바르지 않습니다. 기존 파일은 변경하지 않았습니다.');
      }
      const ids = new Set();
      this.accounts = saved.accounts.map((row) => {
        if (!row || !UUID.test(row.id) || ids.has(row.id)) throw new Error('저장된 계정 식별자가 올바르지 않습니다.');
        ids.add(row.id);
        const account = {
          id: row.id, label: labelValue(row.label),
          email: typeof row.email === 'string' ? row.email : null,
          planType: typeof row.planType === 'string' ? row.planType : null,
          status: row.email || row.usage ? 'ready' : 'signedOut',
          usage: row.usage && typeof row.usage === 'object' ? row.usage : null,
          lastUpdated: typeof row.lastUpdated === 'string' ? row.lastUpdated : null,
          authStarted: Boolean(row.authStarted || row.email || row.usage || row.status === 'loggingIn'),
        };
        if (row.status === 'error') { account.status = 'error'; account.error = '사용량을 다시 조회하십시오.'; }
        if (row.status === 'signedOut') account.status = 'signedOut';
        if (row.resetAttempt && UUID.test(row.resetAttempt.idempotencyKey)) {
          if (row.resetAttempt.creditId != null && !validCreditId(row.resetAttempt.creditId)) {
            throw new Error('저장된 초기화권 정보가 올바르지 않습니다. 기존 파일은 변경하지 않았습니다.');
          }
          account.resetAttempt = {
            idempotencyKey: row.resetAttempt.idempotencyKey,
            ...(row.resetAttempt.creditId != null ? { creditId: row.resetAttempt.creditId } : {}),
            accountEmail: typeof row.resetAttempt.accountEmail === 'string' ? row.resetAttempt.accountEmail : account.email,
            status: ['pending', 'uncertain'].includes(row.resetAttempt.status) ? 'uncertain' : 'completed',
            outcome: Object.hasOwn(OUTCOMES, row.resetAttempt.outcome) ? row.resetAttempt.outcome : undefined,
            startedAt: row.resetAttempt.startedAt,
            completedAt: row.resetAttempt.completedAt,
            needsRefresh: Boolean(row.resetAttempt.needsRefresh),
          };
          account.resetAttempt.message = account.resetAttempt.status === 'uncertain'
            ? '초기화 결과를 받지 못했습니다. 같은 요청으로 다시 시도하십시오.'
            : OUTCOMES[account.resetAttempt.outcome] || '사용량을 다시 조회하십시오.';
        }
        account.statistics = restoreStatistics(row.statistics, account);
        return account;
      });
      // Reconstruct only known local activity fields; never return arbitrary persisted properties.
      this.activity = Array.isArray(saved.activity) ? saved.activity.slice(-100).filter((row) => row && typeof row.message === 'string').map((row) => ({
        id: String(row.id || randomUUID()), time: String(row.time || ''),
        accountId: String(row.accountId || ''), label: String(row.label || ''),
        type: String(row.type || 'info'), message: row.message.slice(0, 300),
      })) : [];
    }
    this._markDuplicates();
    this.initialized = true;
    await this._save();
    this._emit();
    return this.snapshot();
  }

  snapshot() {
    return clone({
      accounts: this.accounts.map(({ resetAttempt, authStarted, statistics, ...account }) => ({
        ...account,
        ...(resetAttempt ? { resetAttempt: {
          status: resetAttempt.status, outcome: resetAttempt.outcome,
          message: resetAttempt.message, needsRefresh: resetAttempt.needsRefresh,
          creditId: resetAttempt.creditId ?? null,
        } } : {}),
      })),
      activity: this.activity,
      refresh: this.refresh,
    });
  }

  async addAccount(label) {
    this._assertOpen();
    if (this.accounts.length >= 100) throw new Error('계정은 최대 100개까지 추가할 수 있습니다.');
    const account = { id: randomUUID(), label: labelValue(label), email: null, planType: null, status: 'signedOut', usage: null, lastUpdated: null, authStarted: false };
    account.statistics = emptyStatistics(null);
    await this._prepareProfile(account.id);
    this.accounts.push(account);
    this._activity(account, 'account', '계정을 추가했습니다.');
    await this._save();
    return this._emit();
  }

  async renameAccount(id, label) {
    const account = this._account(id);
    account.label = labelValue(label);
    await this._save();
    return this._emit();
  }

  async login(id, method = 'chatgpt') {
    const account = this._account(id);
    if (!['chatgpt', 'chatgptDeviceCode'].includes(method)) throw new Error('지원하지 않는 로그인 방식입니다.');
    if (this.removing.has(id)) throw new Error('계정을 삭제하고 있습니다.');
    if (this.resetTasks.has(id)) throw new Error('초기화권 처리가 끝난 뒤 로그인하십시오.');
    if (this.loginStarting.size || this.accounts.some((row) => row.status === 'loggingIn')) throw new Error('진행 중인 로그인을 완료하거나 취소한 뒤 다시 시도하십시오.');
    const epoch = (this.loginEpochs.get(id) || 0) + 1;
    this.loginEpochs.set(id, epoch);
    this.loginStarting.add(id);
    account.status = 'loggingIn';
    delete account.error;
    this._emit();
    try {
      if (this.refreshTasks.has(id)) await this.refreshTasks.get(id);
      if (this.detailTasks.has(id)) await this.detailTasks.get(id);
      if (this.loginEpochs.get(id) !== epoch) return this.snapshot();
      const client = await this._client(id);
      account.authStarted = true;
      await this._save();
      const result = await client.request('account/login/start', { type: method });
      if (this.loginEpochs.get(id) !== epoch || !this.accounts.includes(account)) {
        if (result.loginId) await client.request('account/login/cancel', { loginId: result.loginId }).catch(() => {});
        return this.snapshot();
      }
      const url = result.authUrl || result.verificationUrl;
      if (typeof result.loginId !== 'string' || typeof url !== 'string') throw new Error('Invalid login response');
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || !['auth.openai.com', 'auth0.openai.com', 'chatgpt.com'].includes(parsed.hostname) || parsed.username || parsed.password) throw new Error('Invalid login URL');
      account.login = { loginId: result.loginId, url, type: method, ...(result.userCode ? { userCode: result.userCode } : {}) };
      account.status = 'loggingIn';
      this.loginStarting.delete(id);
      this._activity(account, 'login', '브라우저에서 로그인을 완료하십시오.');
      await this._save();
      const snapshot = this._emit();
      const early = this.earlyLogins.get(id);
      if (early) { this.earlyLogins.delete(id); void this._loginCompleted(id, client, early); }
      return snapshot;
    } catch (error) {
      if (this.loginEpochs.get(id) === epoch && this.accounts.includes(account)) {
        account.status = 'error';
        account.error = friendlyError(error, '로그인 시작');
        delete account.login;
        this._activity(account, 'error', account.error);
        await this._save();
      }
      return this._emit();
    } finally { this.loginStarting.delete(id); this._closeIdleClient(id); }
  }

  async cancelLogin(id) {
    const account = this._account(id);
    if (account.status !== 'loggingIn') return this.snapshot();
    this.loginEpochs.set(id, (this.loginEpochs.get(id) || 0) + 1);
    this.earlyLogins.delete(id);
    const client = this.clients.get(id);
    if (account.login?.loginId && client) {
      try { await client.request('account/login/cancel', { loginId: account.login.loginId }); } catch { client.close(); }
    } else if (client) client.close();
    delete account.login;
    delete account.error;
    account.status = account.email ? 'ready' : 'signedOut';
    this._activity(account, 'login', '로그인을 취소했습니다.');
    await this._save();
    this._closeIdleClient(id);
    return this._emit();
  }

  async refreshAccounts(ids) {
    const selected = this._select(ids).filter((account) => !this.removing.has(account.id));
    if (!selected.length) return this.snapshot();
    if (!this.activeBatches) this.refresh = { running: true, done: 0, total: 0 };
    this.activeBatches++;
    this.refresh.running = true;
    this.refresh.total += selected.length;
    this._emit();
    try {
      await Promise.all(selected.map(async (account) => {
        try {
          if (this.resetTasks.has(account.id)) await this.resetTasks.get(account.id);
          if (this.accounts.includes(account) && account.status !== 'loggingIn') await this._refreshAccount(account.id);
        } finally { this.refresh.done++; this._emit(); }
      }));
    } finally {
      this.activeBatches--;
      this.refresh.running = this.activeBatches > 0;
      this._emit();
    }
    return this.snapshot();
  }

  getAccountDetails(id) {
    return publicDetails(this._account(id));
  }

  refreshAccountDetails(id) {
    const account = this._account(id);
    if (this.detailTasks.has(id)) return this.detailTasks.get(id);
    if (this.removing.has(id) || account.status === 'loggingIn' || this.loginStarting.has(id)) return Promise.resolve(this.getAccountDetails(id));
    // Capture preceding operations before publishing this task so a later reset/read
    // can wait for it without either operation waiting on itself.
    const preceding = [this.resetTasks.get(id), this.refreshTasks.get(id)].filter(Boolean);
    const task = Promise.resolve().then(async () => {
      await Promise.all(preceding);
      if (this.closed || !this.accounts.includes(account)) return null;
      if (account.status === 'loggingIn' || this.loginStarting.has(id) || this.removing.has(id)) return this.getAccountDetails(id);
      return this._withReadSlot(() => this._readAccountDetails(id));
    }).finally(() => {
      if (this.detailTasks.get(id) === task) this.detailTasks.delete(id);
      this._closeIdleClient(id);
    });
    this.detailTasks.set(id, task);
    return task;
  }

  async _readAccountDetails(id) {
    const account = this._account(id);
    const expectedEmail = this._emailKey(account.email);
    const epoch = this.loginEpochs.get(id) || 0;
    const statistics = account.statistics;
    const isCurrent = () => !this.closed && this.accounts.includes(account)
      && account.statistics === statistics && this._emailKey(account.email) === expectedEmail
      && (this.loginEpochs.get(id) || 0) === epoch;
    try {
      if (!expectedEmail) throw new Error('No account email');
      const client = await this._client(id);
      const identity = await client.request('account/read', { refreshToken: true });
      if (!isCurrent()) return publicDetails(account);
      if (identity?.account?.type !== 'chatgpt' || this._emailKey(identity.account.email) !== expectedEmail) {
        statistics.usageError = '로그인한 계정이 변경되었습니다. 계정 목록에서 다시 조회하십시오.';
      } else {
        const response = await client.request('account/usage/read', {});
        if (!isCurrent()) return publicDetails(account);
        const usage = tokenUsage(response);
        if (!usage) throw new Error('Invalid account usage response');
        statistics.tokenUsage = usage;
        statistics.usageFetchedAt = now();
        statistics.updatedAt = statistics.usageFetchedAt;
        statistics.usageError = null;
      }
      await this._save();
    } catch (error) {
      if (isCurrent()) {
        statistics.usageError = friendlyError(error, '상세 사용량 조회');
        await this._save();
      }
    }
    return publicDetails(account);
  }

  async resetAccounts(ids, selections = null) {
    if (!Array.isArray(ids) || !ids.length) throw new Error('초기화할 계정을 선택하십시오.');
    const selected = this._select(ids);
    const validated = validateResetSelections(selected.map(account => account.id), selections, selected);
    for (const account of selected) {
      const creditId = validated?.[account.id] ?? (account.resetAttempt?.status === 'uncertain' ? account.resetAttempt.creditId ?? null : null);
      if (this.resetTasks.has(account.id) && this.resetTaskSelections.get(account.id) !== creditId) {
        throw new Error('초기화권 처리가 끝난 뒤 다른 초기화권을 선택하십시오.');
      }
    }
    await Promise.all(selected.map((account) => {
      if (this.resetTasks.has(account.id)) return this.resetTasks.get(account.id);
      const creditId = validated?.[account.id] ?? (account.resetAttempt?.status === 'uncertain' ? account.resetAttempt.creditId ?? null : null);
      const precedingDetails = this.detailTasks.get(account.id);
      const task = Promise.resolve().then(async () => {
        if (precedingDetails) await precedingDetails;
        return this._withResetSlot(() => this._resetAccount(account.id, creditId));
      }).finally(() => {
        if (this.resetTasks.get(account.id) === task) {
          this.resetTasks.delete(account.id);
          this.resetTaskSelections.delete(account.id);
        }
        this._closeIdleClient(account.id);
      });
      this.resetTasks.set(account.id, task);
      this.resetTaskSelections.set(account.id, creditId);
      return task;
    }));
    return this.snapshot();
  }

  async removeAccount(id) {
    const account = this._account(id);
    if (this.resetTasks.has(id) || account.resetAttempt?.status === 'uncertain') throw new Error('초기화권 처리 결과를 조회한 뒤 계정을 삭제하십시오.');
    if (this.removing.has(id)) throw new Error('계정을 삭제하고 있습니다.');
    this.removing.add(id);
    try {
      if (account.status === 'loggingIn') await this.cancelLogin(id);
      if (this.refreshTasks.has(id)) await this.refreshTasks.get(id);
      if (this.detailTasks.has(id)) await this.detailTasks.get(id);
      // Logout must succeed before dropping metadata or deleting the isolated keychain profile.
      if (account.authStarted || account.email || account.usage) {
        const client = await this._client(id);
        try { await client.request('account/logout', {}); } catch (error) { throw new Error(friendlyError(error, '로그아웃')); }
        client.close();
      }
      this.clients.delete(id);
      this.accounts = this.accounts.filter((row) => row.id !== id);
      this._markDuplicates();
      this._activity(account, 'account', '계정을 삭제했습니다.');
      await this._save();
      await fs.rm(path.join(this.dataDir, 'profiles', id), { recursive: true, force: true });
      return this._emit();
    } finally { this.removing.delete(id); }
  }

  async close() {
    this.closed = true;
    for (const client of this.clients.values()) client.close();
    this.clients.clear();
    await this.saveChain.catch(() => {});
  }

  _assertOpen() { if (this.closed) throw new Error('앱이 종료되고 있습니다.'); }

  _account(id) {
    this._assertOpen();
    if (typeof id !== 'string' || !UUID.test(id)) throw new Error('계정 식별자가 올바르지 않습니다.');
    const account = this.accounts.find((row) => row.id === id);
    if (!account) throw new Error('계정을 찾을 수 없습니다.');
    return account;
  }

  _select(ids) {
    this._assertOpen();
    if (ids === undefined) return [...this.accounts];
    if (!Array.isArray(ids) || ids.length > 100) throw new Error('계정 선택이 올바르지 않습니다.');
    return [...new Set(ids)].map((id) => this._account(id));
  }

  async _prepareProfile(id) {
    const dir = path.join(this.dataDir, 'profiles', id);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.chmod(dir, 0o700);
    // All account processes use this explicit profile and mandatory OS credential storage.
    await fs.writeFile(path.join(dir, 'config.toml'), 'cli_auth_credentials_store = "keyring"\n', { mode: 0o600 });
    await fs.chmod(path.join(dir, 'config.toml'), 0o600);
    return dir;
  }

  async _client(id) {
    this._assertOpen();
    const existing = this.clients.get(id);
    if (existing && !existing.closed) return existing;
    const profileDir = await this._prepareProfile(id);
    this._account(id); // A close or removal during mkdir must not start another process.
    // Preparing a profile is asynchronous; another operation may already have opened it.
    const opened = this.clients.get(id);
    if (opened && !opened.closed) return opened;
    const client = this.clientFactory({
      command: this.command, args: this.args, env: profileEnvironment(profileDir),
      cwd: profileDir, timeoutMs: 20_000,
    });
    this.clients.set(id, client);
    client.on('notification', (method, params) => {
      if (method !== 'account/login/completed') return;
      if (this.loginStarting.has(id)) this.earlyLogins.set(id, params);
      else void this._loginCompleted(id, client, params);
    });
    client.on('close', () => { if (this.clients.get(id) === client) this.clients.delete(id); });
    try { await client.start(); return client; } catch (error) {
      if (this.clients.get(id) === client) this.clients.delete(id);
      client.close();
      throw error;
    }
  }

  async _loginCompleted(id, client, result) {
    if (this.closed || this.clients.get(id) !== client) return;
    const account = this.accounts.find((row) => row.id === id);
    if (!account || account.status !== 'loggingIn' || !account.login || result.loginId !== account.login.loginId) return;
    delete account.login;
    if (result.success) {
      account.status = 'loading';
      this._activity(account, 'login', '로그인했습니다.');
      try { await this._save(); await this._refreshAccount(id); } catch {
        account.status = 'error'; account.error = '로그인 정보를 저장하지 못했습니다. 다시 조회하십시오.';
      }
    } else {
      account.status = 'error';
      account.error = '로그인에 실패했습니다. 다시 로그인하십시오.';
      this._activity(account, 'error', account.error);
      await this._save().catch(() => {});
    }
    this._emit();
  }

  _refreshAccount(id) {
    if (this.refreshTasks.has(id)) return this.refreshTasks.get(id);
    const precedingDetails = this.detailTasks.get(id);
    const task = Promise.resolve().then(async () => {
      if (precedingDetails) await precedingDetails;
      return this._withReadSlot(() => this._readAccount(id));
    }).finally(() => {
      if (this.refreshTasks.get(id) === task) this.refreshTasks.delete(id);
      this._closeIdleClient(id);
    });
    this.refreshTasks.set(id, task);
    return task;
  }

  async _withReadSlot(operation) {
    if (this.activeReads >= 4) await new Promise((resolve) => this.readQueue.push(resolve));
    else this.activeReads++;
    try { return await operation(); } finally {
      const next = this.readQueue.shift();
      if (next) next(); else this.activeReads--;
    }
  }

  async _withResetSlot(operation) {
    if (this.activeResets >= 4) await new Promise((resolve) => this.resetQueue.push(resolve));
    else this.activeResets++;
    try { return await operation(); } finally {
      const next = this.resetQueue.shift();
      if (next) next(); else this.activeResets--;
    }
  }

  _closeIdleClient(id) {
    if (this.resetTasks.has(id) || this.refreshTasks.has(id) || this.detailTasks.has(id) || this.loginStarting.has(id)) return;
    const account = this.accounts.find((row) => row.id === id);
    if (account?.status === 'loggingIn' || account?.login) return;
    this.clients.get(id)?.close();
  }

  async _readAccount(id, { expectedEmail, quiet = false } = {}) {
    const account = this._account(id);
    if (expectedEmail === undefined && ['pending', 'uncertain'].includes(account.resetAttempt?.status)) {
      expectedEmail = account.resetAttempt.accountEmail;
    }
    const startedLogin = account.status === 'loggingIn';
    if (!startedLogin) account.status = 'loading';
    delete account.error;
    this._emit();
    try {
      const client = await this._client(id);
      const response = await client.request('account/read', { refreshToken: true });
      if (!response?.account || response.account.type !== 'chatgpt') {
        account.status = 'signedOut';
        account.error = 'ChatGPT 계정으로 로그인하십시오.';
        await this._save(); this._emit(); return false;
      }
      const email = response.account.email ?? null;
      if (expectedEmail !== undefined && this._emailKey(expectedEmail) !== this._emailKey(email)) {
        account.status = 'error';
        account.error = '로그인한 계정이 변경되었습니다. 다시 로그인한 뒤 조회하십시오.';
        await this._save(); this._emit(); return false;
      }
      if (this._emailKey(account.email) !== this._emailKey(email)) {
        // Never attach an old identity's statistics or quota to a new login.
        account.statistics = emptyStatistics(email);
        account.usage = null;
        account.lastUpdated = null;
        if (account.resetAttempt?.status === 'completed') delete account.resetAttempt;
      }
      account.email = email;
      account.planType = response.account.planType || 'unknown';
      const usage = await client.request('account/rateLimits/read', {});
      if (!usage || !Object.hasOwn(usage, 'rateLimits')) throw new Error('Invalid usage response');
      account.usage = {
        rateLimits: usage.rateLimits,
        rateLimitsByLimitId: usage.rateLimitsByLimitId ?? null,
        rateLimitResetCredits: usage.rateLimitResetCredits ?? null,
      };
      account.lastUpdated = now();
      recordSnapshot(account.statistics, account.usage, account.lastUpdated);
      account.status = account.login || this.loginStarting.has(id) ? 'loggingIn' : 'ready';
      delete account.error;
      this._markDuplicates();
      if (account.resetAttempt?.status === 'completed') account.resetAttempt.needsRefresh = false;
      if (!quiet) this._activity(account, 'refresh', '사용량을 조회했습니다.');
      await this._save();
      this._emit();
      return true;
    } catch (error) {
      if (!this.closed && this.accounts.includes(account)) {
        account.status = account.login || this.loginStarting.has(id) ? 'loggingIn' : 'error';
        account.error = friendlyError(error, '사용량 조회');
        this._activity(account, 'error', account.error);
        await this._save(); this._emit();
      }
      return false;
    }
  }

  async _resetAccount(id, creditId = null) {
    const account = this._account(id);
    const expectedEmail = account.resetAttempt?.status === 'uncertain' ? account.resetAttempt.accountEmail : account.email;
    const fail = async (message) => {
      account.error = message;
      this._activity(account, 'error', message);
      await this._save(); this._emit();
    };
    if (this.removing.has(id) || account.status === 'loggingIn') return fail('로그인을 완료한 뒤 초기화하십시오.');
    if (this.refreshTasks.has(id)) await this.refreshTasks.get(id);
    const retry = account.resetAttempt?.status === 'uncertain';
    if (!this._emailKey(expectedEmail)) return fail('이메일을 확인할 수 없는 계정은 초기화할 수 없습니다. 다시 로그인하십시오.');
    if (this._isDuplicate(account)) return fail('같은 이메일의 계정이 중복 등록되어 있습니다. 중복 계정을 삭제한 뒤 초기화하십시오.');
    // Every explicit action re-reads this profile. A failed read never permits a new redemption.
    if (!await this._withReadSlot(() => this._readAccount(id, { expectedEmail, quiet: true }))) return;
    if (this._isDuplicate(account)) return fail('같은 이메일의 계정이 중복 등록되어 있습니다. 중복 계정을 삭제한 뒤 초기화하십시오.');
    if (!retry && (!Number.isSafeInteger(account.usage.rateLimitResetCredits?.availableCount)
      || account.usage.rateLimitResetCredits.availableCount < 0)) return fail('이 계정의 초기화권 정보를 조회할 수 없습니다.');
    if (!retry && account.usage.rateLimitResetCredits.availableCount <= 0) return fail('사용할 초기화권이 없습니다.');
    if (!retry && creditId != null) {
      const message = selectedCreditError(account.usage.rateLimitResetCredits, creditId);
      if (message) return fail(message);
    }
    const attempt = retry ? account.resetAttempt : {
      idempotencyKey: randomUUID(), accountEmail: expectedEmail, startedAt: now(),
      ...(creditId != null ? { creditId } : {}),
    };
    attempt.status = 'pending';
    attempt.needsRefresh = true;
    attempt.message = '초기화권을 적용하고 있습니다.';
    account.resetAttempt = attempt;
    recordReset(account.statistics, account.id, attempt);
    try {
      // Persist and fsync before sending. A crash can only leave an explicitly retryable request.
      await this._save();
    } catch {
      attempt.status = 'uncertain';
      attempt.message = '초기화 요청을 저장하지 못했습니다. 요청은 전송하지 않았습니다.';
      this._emit(); return;
    }
    this._emit();
    try {
      const client = await this._client(id);
      const result = await client.request('account/rateLimitResetCredit/consume', {
        idempotencyKey: attempt.idempotencyKey,
        ...(attempt.creditId != null ? { creditId: attempt.creditId } : {}),
      });
      if (!Object.hasOwn(OUTCOMES, result?.outcome)) throw new Error('Invalid reset response');
      attempt.status = 'completed';
      attempt.outcome = result.outcome;
      attempt.completedAt = now();
      attempt.message = OUTCOMES[result.outcome];
      recordReset(account.statistics, account.id, attempt);
      this._activity(account, 'reset', attempt.message);
      await this._save();
    } catch (error) {
      attempt.status = 'uncertain';
      attempt.message = '초기화 결과를 받지 못했습니다. 같은 요청으로 다시 시도하십시오.';
      recordReset(account.statistics, account.id, attempt);
      account.error = friendlyError(error, '초기화권 적용');
      this._activity(account, 'error', attempt.message);
      await this._save();
    }
    // Reading does not consume a credit. It never changes an uncertain attempt into success.
    await this._withReadSlot(() => this._readAccount(id, { expectedEmail, quiet: true }));
    this._emit();
  }

  _activity(account, type, message) {
    this.activity.push({ id: randomUUID(), time: now(), accountId: account.id, label: account.label, type, message });
    this.activity = this.activity.slice(-100);
  }

  _emailKey(email) { return typeof email === 'string' ? email.trim().toLowerCase() : ''; }

  _isDuplicate(account) {
    const email = this._emailKey(account.email);
    return Boolean(email && this.accounts.some((row) => row.id !== account.id && this._emailKey(row.email) === email));
  }

  _markDuplicates() {
    for (const account of this.accounts) {
      if (this._isDuplicate(account)) account.warning = '같은 이메일의 계정이 중복 등록되어 있습니다. 중복 계정을 삭제하십시오.';
      else delete account.warning;
    }
  }

  _emit() {
    const snapshot = this.snapshot();
    try { this.onChange(snapshot); } catch { /* UI listeners cannot interrupt an account operation. */ }
    return snapshot;
  }

  _save() {
    const payload = JSON.stringify({
      version: 1,
      accounts: this.accounts.map(({ login, ...account }) => account),
      activity: this.activity,
    }, null, 2);
    const write = this.saveChain.catch(() => {}).then(async () => {
      const temporary = path.join(this.dataDir, 'accounts.json.tmp');
      let file;
      try {
        file = await fs.open(temporary, 'w', 0o600);
        await file.chmod(0o600);
        await file.writeFile(payload, 'utf8');
        await file.sync();
      } finally { if (file) await file.close(); }
      await fs.rename(temporary, path.join(this.dataDir, 'accounts.json'));
      // Make the rename durable as well as the file content.
      const directory = await fs.open(this.dataDir, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    });
    this.saveChain = write;
    return write;
  }
}

module.exports = { AccountService, profileEnvironment, validateResetSelections };
