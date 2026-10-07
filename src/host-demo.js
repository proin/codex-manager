export function createDemoHostBridge() {
  const listeners = new Set();
  const currentTime = new Date().toISOString();
  const key = { privateKeyPath: '/demo/.ssh/id_ed25519', publicKeyPath: '/demo/.ssh/id_ed25519.pub', privateExists: true, publicExists: true, fingerprint: 'SHA256:examplePublicKeyFingerprintForPreview', publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICodexManagerPreviewKey example@computer' };
  const registered = new Set(['demo-host-1']);
  let state = {
    configPath: '/demo/.ssh/config', revision: 'demo-1', refresh: { running: false, completed: 0, total: 0 },
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
  const pause = () => new Promise(resolve => setTimeout(resolve, 180));
  const keysFor = id => registered.has(id) ? [{ id: 'example-key', keyType: 'ssh-ed25519', comment: 'example@computer', fingerprint: key.fingerprint, matchesLocal: true }] : [];
  const revision = () => { state.revision = crypto.randomUUID(); };
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
      state.hosts = state.hosts.filter(item => item.id !== id); revision(); return emit();
    },
    reorderHosts: async (ids, expectedRevision) => {
      if (expectedRevision !== state.revision) throw new Error('SSH 설정이 변경되었습니다. 목록을 새로고침한 후 다시 정렬하십시오.');
      if (!Array.isArray(ids) || ids.length !== state.hosts.length || new Set(ids).size !== ids.length || ids.some(id => !state.hosts.some(host => host.id === id))) throw new Error('호스트 목록을 다시 불러오십시오.');
      const hosts = new Map(state.hosts.map(host => [host.id, host]));
      state.hosts = ids.map(id => hosts.get(id)); revision(); return emit();
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
    upgradeCodex: async id => {
      const host = getHost(id); host.operation = { type: 'upgrade', running: true }; emit(); await pause();
      host.codex = { ...host.codex, available: true, version: '0.150.0' }; host.operation = { type: 'upgrade', running: false, message: 'Codex 업그레이드가 완료되었습니다. (예시)' }; return emit();
    },
  };
}
