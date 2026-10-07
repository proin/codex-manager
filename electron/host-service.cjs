'use strict';

const { SshConfigStore } = require('./ssh-config.cjs');
const { LocalKeyStore } = require('./local-keys.cjs');
const { SSH_OPTIONS, PROBE_TIMEOUT_MS, assertAlias, buildSshArgs, runProcess, commandError, withAskpass, parseEffectiveConfig, parseAuthorizedKeys, registrationScript, probeCodex, secureProxyCommand, upgradeScript } = require('./host-ssh.cjs');

const CONCURRENCY = 6;
function copy(value) { return structuredClone(value); }
function validatePassword(password) {
  if (password == null) return '';
  if (typeof password !== 'string' || password.length > 4096 || /[\r\n\x00]/.test(password)) throw new Error('서버 비밀번호를 올바르게 입력하십시오.');
  return password;
}
function emptyCodex() { return { available: null, version: null, accountEmail: null, accountPlan: null, loginStatus: 'unknown', installMethod: null }; }
function hostSignature(host) { return JSON.stringify([host.alias, host.optionsText, host.hostName, host.user, host.port, host.identityFile, host.proxyJump]); }
function hasIdentity(host) { return Boolean(host.identityFile?.trim() && host.identityFile.trim().toLowerCase() !== 'none'); }

class HostService {
  constructor(options = {}) {
    this.config = options.configStore || new SshConfigStore({ configPath: options.configPath });
    this.keys = options.keyStore || new LocalKeyStore({ sshDir: options.sshDir });
    this.run = options.runCommand || runProcess;
    this.probe = options.probe || (async (host, opts) => probeCodex(this.run, this.state.configPath, host, { ...opts, proxyCommand: await secureProxyCommand(this.run, this.state.configPath, host, opts) }));
    this.askpass = options.withAskpass || withAskpass;
    this.effectiveResolver = options.effectiveConfig;
    this.onChange = options.onChange || (() => {});
    this.state = { configPath: options.configPath || '', revision: '', hosts: [], error: null, refreshing: false, completed: 0, total: 0 };
    this.refresh = null;
    this.active = new Map();
    this.pending = new Set();
    this.closed = false;
  }

  async init() {
    try { return await this.reloadHosts(); }
    catch (error) { this.state.error = error.message; this.publish(); return this.snapshot(); }
  }

  snapshot() { return copy({ ...this.state, refresh: { running: this.state.refreshing, completed: this.state.completed, total: this.state.total } }); }
  publish() { try { this.onChange(this.snapshot()); } catch { /* Window may be closing. */ } }

  requireHost(id, connectable = false) {
    if (this.closed) throw new Error('호스트 관리가 종료되었습니다.');
    if (typeof id !== 'string' || id.length > 256 || !id) throw new Error('호스트를 선택하십시오.');
    const host = this.state.hosts.find((entry) => entry.id === id);
    if (!host) throw new Error('호스트를 찾을 수 없습니다. 목록을 다시 불러오십시오.');
    if (connectable) { if (host.connectable === false) throw new Error('개별 호스트를 선택하십시오.'); assertAlias(host.alias); }
    return host;
  }

  applyConfig(result) {
    const previous = new Map(this.state.hosts.map((host) => [host.id, host]));
    this.state.configPath = result.configPath;
    this.state.revision = result.revision;
    this.state.error = null;
    this.state.hosts = result.hosts.map((host) => {
      const old = previous.get(host.id);
      const same = old && hostSignature(old) === hostSignature(host);
      const next = { ...host, connection: same ? old.connection : { status: 'unknown', message: '', checkedAt: null }, codex: same ? old.codex : emptyCodex(), operation: (same || this.active.has(host.id)) && old ? old.operation : { type: null, running: false, message: '', status: 'idle' } };
      // Display order changes must keep references used by active host operations.
      return same ? Object.assign(old, next) : next;
    });
    this.publish();
    return this.snapshot();
  }

  async reloadHosts() {
    this.cancelRefresh();
    try { return this.applyConfig(await this.config.read()); }
    catch (error) { this.state.error = error.message || 'SSH 호스트 목록을 읽지 못했습니다.'; this.publish(); throw error; }
  }

  async saveHost(draft, revision) {
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) throw new Error('호스트 정보를 입력하십시오.');
    if (typeof revision !== 'string' || revision.length > 256) throw new Error('호스트 목록을 다시 불러오십시오.');
    if (draft.id && this.active.has(draft.id)) throw new Error('호스트 작업이 진행 중입니다. 완료 후 저장하십시오.');
    this.cancelRefresh();
    return this.applyConfig(await this.config.save(draft, revision));
  }

  async deleteHost(id, revision) {
    this.requireHost(id);
    if (typeof revision !== 'string' || revision.length > 256) throw new Error('호스트 목록을 다시 불러오십시오.');
    if (this.active.has(id)) throw new Error('호스트 작업이 진행 중입니다. 완료 후 삭제하십시오.');
    this.cancelRefresh();
    return this.applyConfig(await this.config.remove(id, revision));
  }

  async reorderHosts(ids, revision) {
    if (this.closed) throw new Error('호스트 관리가 종료되었습니다.');
    if (typeof revision !== 'string' || !revision || revision.length > 256) throw new Error('호스트 목록을 다시 불러오십시오.');
    if (!Array.isArray(ids) || ids.length > 10000 || ids.some(id => typeof id !== 'string' || !id || id.length > 256)) throw new Error('순서를 변경할 호스트 목록을 올바르게 입력하십시오.');
    // This writes only a display-order comment, so running probes and key tasks remain valid.
    return this.applyConfig(await this.config.reorder(ids, revision));
  }

  cancelRefresh() {
    if (!this.refresh) return this.snapshot();
    this.refresh.controller.abort();
    this.refresh = null;
    this.state.refreshing = false;
    for (const host of this.state.hosts) {
      if (host.connection.status === 'checking') host.connection = { status: 'unknown', message: '조회가 중지되었습니다.', checkedAt: host.connection.checkedAt };
    }
    this.publish();
    return this.snapshot();
  }

  async refreshHosts(ids) {
    if (this.closed) throw new Error('호스트 관리가 종료되었습니다.');
    if (ids !== undefined && (!Array.isArray(ids) || ids.length > 10000 || ids.some((id) => typeof id !== 'string' || id.length > 256))) throw new Error('조회할 호스트를 선택하십시오.');
    const selected = ids === undefined ? this.state.hosts : [...new Set(ids)].map((id) => this.requireHost(id));
    const hosts = selected.filter((host) => host.connectable !== false && !this.active.has(host.id));
    this.cancelRefresh();
    const entry = { controller: new AbortController() };
    this.refresh = entry;
    const { signal } = entry.controller;
    this.state.refreshing = hosts.length > 0;
    this.state.completed = 0;
    this.state.total = hosts.length;
    for (const host of hosts) host.connection = { ...host.connection, status: 'checking', message: '' };
    this.publish();
    let cursor = 0;
    let finishPending;
    const pending = new Promise((resolve) => { finishPending = resolve; });
    this.pending.add(pending);
    try {
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, hosts.length) }, async () => {
        while (!signal.aborted && cursor < hosts.length) {
          const host = hosts[cursor++];
          const signature = hostSignature(host);
          let codex; let error;
          const deadline = new AbortController();
          const abort = () => deadline.abort();
          signal.addEventListener('abort', abort, { once: true });
          const timer = setTimeout(abort, PROBE_TIMEOUT_MS);
          try {
            const key = await this.selectedKey(host, deadline.signal);
            codex = await this.probe(host, { signal: deadline.signal, timeoutMs: PROBE_TIMEOUT_MS, identityFile: key.privateExists ? key.privateKeyPath : undefined });
          } catch (caught) { error = deadline.signal.aborted && !signal.aborted ? new Error('호스트가 제한 시간 안에 응답하지 않았습니다.') : caught; }
          finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
          if (signal.aborted || this.refresh !== entry) break;
          this.state.completed += 1;
          const current = this.state.hosts.find((item) => item.id === host.id);
          if (!current || hostSignature(current) !== signature || this.active.has(host.id)) { this.publish(); continue; }
          current.codex = codex || emptyCodex();
          current.connection = { status: error ? 'offline' : 'online', message: error?.message || (codex.available ? '' : 'Codex가 설치되어 있지 않습니다.'), checkedAt: new Date().toISOString() };
          this.publish();
        }
      }));
    } finally {
      if (this.refresh === entry) { this.refresh = null; this.state.refreshing = false; this.publish(); }
      this.pending.delete(pending); finishPending();
    }
    return this.snapshot();
  }

  async effective(host, signal) {
    if (this.effectiveResolver) return this.effectiveResolver(host, signal);
    if (host.connectable === false) return { hostName: host.hostName, user: host.user, port: host.port, identityFile: host.identityFile, proxyJump: host.proxyJump };
    assertAlias(host.alias);
    const args = ['-F', this.state.configPath, '-G', ...Object.entries(SSH_OPTIONS).flatMap(([key, value]) => ['-o', `${key}=${value}`]), '--', host.alias];
    const result = await this.run('ssh', args, { timeoutMs: 5000, signal });
    if (result.code !== 0) throw commandError(result);
    return parseEffectiveConfig(result.stdout);
  }

  async getHostDetails(id) {
    const host = this.requireHost(id);
    const effective = await this.effective(host);
    const key = await this.selectedKey(host, undefined, effective);
    return { host: copy(host), effective, key };
  }

  async selectedKey(host, signal, effectiveConfig) {
    const effective = effectiveConfig || await this.effective(host, signal);
    const context = { ...host, hostName: effective.hostName || host.hostName, user: effective.user || host.user, port: effective.port || host.port };
    const expand = (identityFile) => String(identityFile).replace(/%%|%[hrpn]/g, (token) => token === '%%' ? '%' : ({ '%h': context.hostName, '%r': context.user, '%p': context.port, '%n': host.alias })[token] || token);
    if (hasIdentity(host)) return this.keys.status({ ...context, identityFile: expand(host.identityFile) });
    for (const identityFile of effective.identities || []) {
      if (!identityFile || identityFile.toLowerCase() === 'none') continue;
      try {
        const key = await this.keys.status({ ...context, identityFile: expand(identityFile) });
        if (key.privateExists || key.publicExists) return key;
      } catch { /* Try the next identity configured by OpenSSH. */ }
    }
    return this.keys.status({ ...context, identityFile: '' });
  }

  async operation(id, type, work) {
    const host = this.requireHost(id, true);
    if (this.active.has(id)) throw new Error('이 호스트에서 다른 작업이 진행 중입니다.');
    const controller = new AbortController();
    this.active.set(id, controller);
    if (host.connection.status === 'checking') host.connection = { ...host.connection, status: 'unknown', message: '' };
    host.operation = { type, running: true, message: '', status: 'running' };
    let finishPending;
    const pending = new Promise((resolve) => { finishPending = resolve; });
    this.pending.add(pending);
    this.publish();
    try {
      const latest = await this.config.read();
      if (latest.revision !== this.state.revision) throw new Error('SSH 설정이 변경되었습니다. 목록을 다시 불러오십시오.');
      const result = await work(host, controller.signal);
      const current = this.state.hosts.find((entry) => entry.id === id);
      if (current) current.operation = { type, running: false, message: result?.message || '작업을 완료했습니다.', status: 'completed' };
      this.publish();
      return result;
    } catch (error) {
      const current = this.state.hosts.find((entry) => entry.id === id);
      if (current) current.operation = { type, running: false, message: error.message, status: 'error', error: error.message };
      this.publish();
      throw error;
    } finally { this.active.delete(id); this.pending.delete(pending); finishPending(); }
  }

  async generateKey(id) {
    return this.operation(id, 'generateKey', async (host, signal) => {
      const selected = await this.selectedKey(host, signal);
      const key = await this.keys.generate({ ...host, identityFile: selected.privateKeyPath });
      if (!hasIdentity(host) && /codex-manager_ed25519$/.test(key.privateKeyPath || '')) {
        this.applyConfig(await this.config.save({ ...host, identityFile: key.privateKeyPath }, this.state.revision));
      }
      return { ...key, message: 'SSH 키를 준비했습니다.' };
    });
  }

  async executeOnHost(host, command, { password = '', signal, input, timeoutMs = PROBE_TIMEOUT_MS, mutation = false } = {}) {
    const key = await this.selectedKey(host, signal);
    const proxyCommand = await secureProxyCommand(this.run, this.state.configPath, host, { password: Boolean(password), signal });
    return this.askpass(password, async (env) => {
      const result = await this.run('ssh', buildSshArgs(this.state.configPath, host, command, { password: Boolean(password), identityFile: key.privateExists ? key.privateKeyPath : undefined, proxyCommand }), { signal, input, timeoutMs, env });
      if (result.code !== 0) throw commandError(result, mutation);
      return result;
    });
  }

  async readKeys(host, password, signal) {
    const key = await this.selectedKey(host, signal);
    const result = await this.executeOnHost(host, 'if [ -f "$HOME/.ssh/authorized_keys" ]; then cat "$HOME/.ssh/authorized_keys"; fi', { password, signal });
    const keys = parseAuthorizedKeys(result.stdout, key.publicKey || '');
    return { registered: keys.some((item) => item.matchesLocal), keys, key };
  }

  async inspectKeys(id, password) {
    const secret = validatePassword(password);
    return this.operation(id, 'inspectKeys', (host, signal) => this.readKeys(host, secret, signal));
  }

  async registerKey(id, password) {
    const secret = validatePassword(password);
    return this.operation(id, 'registerKey', async (host, signal) => {
      const key = await this.selectedKey(host, signal);
      if (!key.privateExists || !key.publicExists || !key.publicKey) throw new Error('SSH 키를 먼저 준비하십시오.');
      if (!hasIdentity(host) && /codex-manager_ed25519$/.test(key.privateKeyPath || '')) {
        this.applyConfig(await this.config.save({ ...host, identityFile: key.privateKeyPath }, this.state.revision));
      }
      await this.executeOnHost(host, 'sh -s', { password: secret, signal, input: registrationScript(key.publicKey), mutation: true });
      const result = await this.readKeys(host, '', signal).catch(() => null);
      if (!result?.registered) {
        throw new Error('키 등록 요청을 처리했습니다. 비밀번호 없는 접속과 등록 목록을 다시 조회하십시오.');
      }
      return { ...result, message: 'SSH 키를 등록했습니다. 비밀번호 없이 접속할 수 있습니다.' };
    });
  }

  async upgradeCodex(id) {
    return this.operation(id, 'upgradeCodex', async (host, signal) => {
      await this.executeOnHost(host, upgradeScript(), { signal, timeoutMs: 180000, mutation: true });
      const key = await this.selectedKey(host, signal);
      const codex = await this.probe(host, { signal, timeoutMs: PROBE_TIMEOUT_MS, identityFile: key.privateExists ? key.privateKeyPath : undefined });
      if (!codex.available || !codex.version) throw new Error('업그레이드 요청을 처리했습니다. Codex 버전을 다시 조회하십시오.');
      host.codex = codex;
      host.connection = { status: 'online', message: '', checkedAt: new Date().toISOString() };
      return { codex, version: codex.version, message: `Codex ${codex.version}로 업그레이드했습니다.` };
    });
  }

  async close() {
    this.closed = true;
    this.cancelRefresh();
    for (const controller of this.active.values()) controller.abort();
    await Promise.allSettled([...this.pending]);
    this.active.clear();
  }
}

module.exports = { HostService, CONCURRENCY, validatePassword };
