export function createDemoHostBridge() {
  const listeners = new Set();
  const currentTime = new Date().toISOString();
  const key = { privateKeyPath: '/demo/.ssh/id_ed25519', publicKeyPath: '/demo/.ssh/id_ed25519.pub', privateExists: true, publicExists: true, fingerprint: 'SHA256:examplePublicKeyFingerprintForPreview', publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICodexManagerPreviewKey example@computer' };
  const registered = new Set(['demo-host-1']);
  let state = {
    configPath: '/demo/.ssh/config', revision: 'demo-1', groups: [], refresh: { running: false, completed: 0, total: 0 }, batchUpgrade: { running: false, hostIds: [] },
    hosts: [
      { id: 'demo-host-1', alias: 'dev-server', hostPatterns: 'dev-server', hostName: '192.0.2.10', user: 'ubuntu', port: '22', identityFile: '/demo/.ssh/id_ed25519', proxyJump: '', connectable: true, connection: { status: 'online', checkedAt: currentTime }, codex: { available: true, version: '0.149.0', accountEmail: 'developer@example.com', accountPlan: 'Pro', loginStatus: 'chatgpt', installMethod: 'npm' } },
      { id: 'demo-host-2', alias: 'research-server', hostPatterns: 'research-server', hostName: '192.0.2.20', user: 'researcher', port: '2222', identityFile: '/demo/.ssh/id_ed25519', proxyJump: 'dev-server', connectable: true, connection: { status: 'online', checkedAt: currentTime }, codex: { available: true, version: '0.148.0', accountEmail: 'research@example.com', accountPlan: 'Plus', loginStatus: 'chatgpt', installMethod: 'npm' } },
      { id: 'demo-host-3', alias: 'backup-server', hostPatterns: 'backup-server', hostName: '192.0.2.30', user: 'ubuntu', port: '', identityFile: '', proxyJump: '', connectable: true, connection: { status: 'offline', message: '호스트에 접속하지 못했습니다.', checkedAt: currentTime }, codex: { version: null, accountEmail: null, available: null } },
    ],
  };
  const snapshot = () => structuredClone(state);
  const emit = () => { const result = snapshot(); listeners.forEach(callback => callback(result)); return result; };
  const getHost = id => {
    const host = state.hosts.find(item => item.id === id);
    if (!host) throw new Error('호스트를 찾을 수 없습니다.');
    return host;
  };
  const pause = (delay = 180) => new Promise(resolve => setTimeout(resolve, delay));
  const keysFor = id => registered.has(id) ? [{ id: 'example-key', keyType: 'ssh-ed25519', comment: 'example@computer', fingerprint: key.fingerprint, matchesLocal: true }] : [];
  const revision = () => { state.revision = crypto.randomUUID(); };
  const isBusy = (host, batchHostId) => (state.batchUpgrade.running && state.batchUpgrade.hostIds.includes(host.id) && host.id !== batchHostId) || host.operation?.running || ['starting', 'waiting', 'verifying'].includes(host.login?.status) || ['checking', 'loading', 'connecting'].includes(host.connection?.status);
  const validateIds = ids => {
    if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || ids.some(id => !state.hosts.some(host => host.id === id))) throw new Error('호스트 목록을 다시 불러오십시오.');
  };
  const upgrade = async (id, batchHostId) => {
    const host = getHost(id);
    if (host.connectable === false) throw new Error('공통 설정은 업그레이드할 수 없습니다.');
    if (isBusy(host, batchHostId)) throw new Error('호스트에서 다른 작업을 진행하고 있습니다.');
    if (host.codex?.available === false) throw new Error('Codex가 설치되지 않았습니다.');
    host.operation = { type: 'upgradeCodex', running: true, status: 'running' }; emit();
    try {
      await pause(id === 'demo-host-2' ? 650 : 420);
      if (host.connection?.status === 'offline' || id === 'demo-host-3') throw new Error('서버에 접속하지 못해 Codex를 업그레이드하지 못했습니다. (예시)');
      host.codex = { ...host.codex, available: true, version: '0.150.0' };
      host.operation = { type: 'upgradeCodex', running: false, status: 'completed' }; emit();
    } catch (error) {
      host.operation = { type: 'upgradeCodex', running: false, status: 'error', error: error.message }; emit(); throw error;
    }
  };
  return {
    getState: async () => snapshot(), onState: callback => { listeners.add(callback); return () => listeners.delete(callback); },
    reloadHosts: async () => emit(),
    saveHost: async (draft, expectedRevision) => {
      if (expectedRevision !== state.revision) throw new Error('SSH 설정이 변경되었습니다. 목록을 새로고침한 후 다시 저장하십시오.');
      if (draft.id) Object.assign(getHost(draft.id), draft);
      else state.hosts.push({ ...draft, hostPatterns: draft.alias, id: crypto.randomUUID(), connectable: true, connection: { status: 'unknown' }, codex: {} });
      revision(); return emit();
    },
    deleteHost: async (id, expectedRevision) => {
      if (expectedRevision !== state.revision) throw new Error('SSH 설정이 변경되었습니다. 목록을 새로고침한 후 다시 삭제하십시오.');
      if (isBusy(getHost(id))) throw new Error('작업 중인 호스트는 삭제할 수 없습니다.');
      state.hosts = state.hosts.filter(item => item.id !== id); revision(); return emit();
    },
    deleteHosts: async (ids, expectedRevision) => {
      if (expectedRevision !== state.revision) throw new Error('SSH 설정이 변경되었습니다. 목록을 새로고침한 후 다시 삭제하십시오.');
      validateIds(ids);
      if (ids.some(id => isBusy(getHost(id)))) throw new Error('작업 중인 호스트는 삭제할 수 없습니다.');
      const removed = new Set(ids); state.hosts = state.hosts.filter(host => !removed.has(host.id));
      revision(); return emit();
    },
    reorderHosts: async (ids, expectedRevision) => {
      if (expectedRevision !== state.revision) throw new Error('SSH 설정이 변경되었습니다. 목록을 새로고침한 후 다시 정렬하십시오.');
      if (!Array.isArray(ids) || ids.length !== state.hosts.length || new Set(ids).size !== ids.length || ids.some(id => !state.hosts.some(host => host.id === id))) throw new Error('호스트 목록을 다시 불러오십시오.');
      const hosts = new Map(state.hosts.map(host => [host.id, host]));
      state.hosts = ids.map(id => hosts.get(id)); revision(); return emit();
    },
    saveGroup: async (draft, expectedRevision) => {
      if (expectedRevision !== state.revision) throw new Error('호스트 목록이 변경되었습니다. 다시 저장하십시오.');
      const name = String(draft.name || '').trim();
      if (!name) throw new Error('그룹 이름을 입력하십시오.');
      if (state.groups.some(group => group.id !== draft.id && group.name === name)) throw new Error('같은 이름의 그룹이 있습니다.');
      const group = draft.id && state.groups.find(item => item.id === draft.id);
      if (draft.id && !group) throw new Error('그룹을 찾을 수 없습니다.');
      if (group) group.name = name;
      else state.groups.push({ id: crypto.randomUUID(), name, collapsed: false });
      revision(); return emit();
    },
    deleteGroup: async (id, expectedRevision) => {
      if (expectedRevision !== state.revision) throw new Error('호스트 목록이 변경되었습니다. 다시 삭제하십시오.');
      state.groups = state.groups.filter(group => group.id !== id);
      state.hosts.forEach(host => { if (host.groupId === id) host.groupId = null; });
      revision(); return emit();
    },
    setGroupCollapsed: async (id, collapsed, expectedRevision) => {
      if (expectedRevision !== state.revision) throw new Error('호스트 목록이 변경되었습니다. 다시 접으십시오.');
      const group = state.groups.find(item => item.id === id);
      if (!group) throw new Error('그룹을 찾을 수 없습니다.');
      group.collapsed = collapsed; revision(); return emit();
    },
    moveHostToGroup: async (id, groupId, expectedRevision, ids) => {
      if (expectedRevision !== state.revision) throw new Error('호스트 목록이 변경되었습니다. 다시 이동하십시오.');
      if (groupId && !state.groups.some(group => group.id === groupId)) throw new Error('그룹을 찾을 수 없습니다.');
      getHost(id).groupId = groupId || null;
      if (ids) { const hosts = new Map(state.hosts.map(host => [host.id, host])); state.hosts = ids.map(id => hosts.get(id)); }
      revision(); return emit();
    },
    refreshHosts: async ids => {
      const targets = state.hosts.filter(item => !ids || ids.includes(item.id));
      state.refresh = { running: true, completed: 0, total: targets.length };
      targets.forEach(item => { item.connection.status = 'checking'; }); emit();
      for (const host of targets) {
        await pause(); if (!state.refresh.running) break;
        host.connection = { status: host.id === 'demo-host-3' ? 'offline' : 'online', checkedAt: new Date().toISOString(), ...(host.id === 'demo-host-3' ? { message: '호스트에 접속하지 못했습니다.' } : {}) };
        state.refresh.completed++; emit();
      }
      state.refresh.running = false; return emit();
    },
    cancelRefresh: async () => { state.refresh.running = false; state.hosts.forEach(item => { if (item.connection.status === 'checking') item.connection.status = 'canceled'; }); return emit(); },
    getHostDetails: async id => {
      const host = getHost(id);
      return { host: structuredClone(host), effective: { ...host, port: host.port || '22', identityFile: host.identityFile || key.privateKeyPath }, key: structuredClone(key) };
    },
    generateKey: async () => { key.privateExists = true; key.publicExists = true; return structuredClone(key); },
    inspectKeys: async id => { getHost(id); await pause(); return { registered: registered.has(id), keys: keysFor(id), key: structuredClone(key) }; },
    registerKey: async id => { getHost(id); await pause(); registered.add(id); return { registered: true, keys: keysFor(id), message: '공개 키가 등록되었습니다. (예시)' }; },
    startCodexLogin: async id => {
      const host = getHost(id), attemptId = crypto.randomUUID();
      host.login = { attemptId, status: 'starting' }; emit(); await pause();
      if (host.login?.attemptId === attemptId && host.login.status === 'starting') host.login = { attemptId, status: 'waiting', url: 'https://auth.openai.com/codex/device', userCode: 'DEMO-1234' };
      return emit();
    },
    openCodexLogin: async id => {
      const host = getHost(id), attemptId = host.login?.attemptId;
      if (!['waiting', 'verifying'].includes(host.login?.status)) throw new Error('진행 중인 로그인이 없습니다.');
      host.login.status = 'verifying'; emit(); await pause();
      if (host.login?.attemptId === attemptId && host.login.status === 'verifying') {
        host.codex = { ...host.codex, accountEmail: 'switched@example.com', loginStatus: 'chatgpt' };
        host.login = { attemptId, status: 'completed', accountEmail: host.codex.accountEmail }; emit();
      }
      return true;
    },
    copyCodexLoginCode: async id => {
      const code = getHost(id).login?.userCode;
      if (!code) throw new Error('인증 코드가 없습니다.');
      await navigator.clipboard.writeText(code); return true;
    },
    cancelCodexLogin: async id => { const host = getHost(id); host.login = { attemptId: host.login?.attemptId, status: 'canceled' }; return emit(); },
    upgradeCodex: async id => { await upgrade(id); return emit(); },
    upgradeCodexBatch: async ids => {
      validateIds(ids);
      if (state.batchUpgrade.running) throw new Error('일괄 업그레이드가 진행 중입니다.');
      state.batchUpgrade = { running: true, hostIds: [...ids] }; emit();
      let results;
      try {
        results = await Promise.all(ids.map(async id => {
          try { await upgrade(id, id); return { id, success: true }; }
          catch (error) { return { id, success: false, error: error.message }; }
        }));
      } finally { state.batchUpgrade = { running: false, hostIds: [] }; }
      return { state: emit(), results };
    },
  };
}
