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
  const fileListeners = new Set(), transfers = [], fileStores = new Map();
  const fileHome = '/home/demo';
  const fileSnapshot = () => structuredClone(transfers);
  const emitFiles = () => { const result = fileSnapshot(); fileListeners.forEach(callback => callback(result)); return result; };
  const basename = path => path.slice(path.lastIndexOf('/') + 1);
  const parent = path => path.slice(0, path.lastIndexOf('/')) || '/';
  const demoMarkdown = '# 서버 파일\n\n서버의 파일과 폴더를 관리합니다.\n\n## 파일 관리\n\n| 작업 | 설명 |\n| --- | --- |\n| 업로드 | 이 컴퓨터의 파일을 서버에 복사 |\n| 다운로드 | 서버의 파일을 이 컴퓨터에 저장 |\n| 이동 | 다른 폴더로 이동 |\n\n- [x] 폴더 탐색\n- [x] 마크다운 미리보기\n\n```sh\nls -la\n```\n\n> 문서는 읽기 전용으로 표시됩니다.\n\n[프로젝트 안내](projects/guide.markdown)\n';
  const fileEntry = (path, type, size = 0) => ({ name: basename(path), path, type, size, modifiedAt: currentTime, mode: type === 'directory' ? '755' : '644' });
  const fileStore = id => {
    const host = getHost(id);
    if (host.connectable === false) throw new Error('공통 설정에서는 파일에 접근할 수 없습니다.');
    if (!fileStores.has(id)) fileStores.set(id, new Map([
      fileEntry('/', 'directory'), fileEntry('/home', 'directory'), fileEntry(fileHome, 'directory'),
      fileEntry(`${fileHome}/projects`, 'directory'), fileEntry(`${fileHome}/logs`, 'directory'),
      { ...fileEntry(`${fileHome}/README.md`, 'file', new TextEncoder().encode(demoMarkdown).length), content: demoMarkdown }, fileEntry(`${fileHome}/.profile`, 'file', 560),
      { ...fileEntry(`${fileHome}/projects/guide.markdown`, 'file', 512), content: '# 프로젝트 안내\n\n프로젝트 파일은 이 폴더에서 관리합니다.\n\n[파일 관리 안내](../README.md)\n' },
      fileEntry(`${fileHome}/projects/codex-manager`, 'directory'), fileEntry(`${fileHome}/projects/server.js`, 'file', 3072),
      fileEntry(`${fileHome}/logs/app.log`, 'file', 32768),
    ].map(entry => [entry.path, entry])));
    return fileStores.get(id);
  };
  const fileList = (id, path = fileHome) => {
    const store = fileStore(id), target = path || fileHome;
    if (store.get(target)?.type !== 'directory') throw new Error('폴더를 찾을 수 없습니다. (예시)');
    return { path: target, home: fileHome, entries: structuredClone([...store.values()].filter(entry => entry.path !== target && parent(entry.path) === target)) };
  };
  const relocate = (id, paths, targetDirectory, explicitTarget) => {
    const store = fileStore(id), moves = paths.map(path => [path, explicitTarget || `${targetDirectory === '/' ? '' : targetDirectory}/${basename(path)}`]);
    for (const [source, target] of moves) {
      if (!store.has(source) || source === '/') throw new Error('파일을 찾을 수 없습니다. (예시)');
      if (store.has(target) || target.startsWith(`${source}/`)) throw new Error('같은 이름이 있거나 폴더 내부로 이동할 수 없습니다. (예시)');
      if (store.get(parent(target))?.type !== 'directory') throw new Error('이동할 폴더를 찾을 수 없습니다. (예시)');
    }
    for (const [source, target] of moves) for (const entry of [...store.values()]) {
      if (entry.path === source || entry.path.startsWith(`${source}/`)) { store.delete(entry.path); const path = `${target}${entry.path.slice(source.length)}`; store.set(path, { ...entry, path, name: basename(path) }); }
    }
    return { success: true };
  };
  const transfer = async (id, direction, paths, directory) => {
    fileStore(id);
    const item = { id: crypto.randomUUID(), hostId: id, direction, status: 'running', completedBytes: 0, totalBytes: 1024 * 256, currentFile: paths[0], message: '예시 파일 전송' };
    transfers.push(item); emitFiles();
    for (let index = 1; index <= 4; index++) {
      await pause(280); if (item.status === 'canceled') return fileSnapshot();
      item.completedBytes = item.totalBytes * index / 4; emitFiles();
    }
    if (direction === 'upload') {
      const store = fileStore(id), path = `${directory}/uploaded-${transfers.length}${paths[0] === 'example-folder' ? '' : '.txt'}`;
      store.set(path, fileEntry(path, paths[0] === 'example-folder' ? 'directory' : 'file', item.totalBytes));
    }
    item.status = 'completed'; return emitFiles();
  };
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
    openSshTerminal: async id => { getHost(id); throw new Error('예시 화면에서는 외부 터미널을 열지 않습니다.'); },
    listFiles: async (id, path) => fileList(id, path),
    readTextFile: async (id, path) => {
      const entry = fileStore(id).get(path);
      if (!entry || entry.type !== 'file' || !/\.(?:md|markdown)$/i.test(path)) throw new Error('마크다운 파일을 찾을 수 없습니다. (예시)');
      return { hostId: id, path, name: entry.name, content: entry.content || '# 예시 문서\n', size: entry.size, modifiedAt: entry.modifiedAt };
    },
    openFileLink: async () => { throw new Error('예시 화면에서는 외부 링크를 열지 않습니다.'); },
    createDirectory: async (id, path) => { const store = fileStore(id); if (store.has(path)) throw new Error('같은 이름의 파일이나 폴더가 있습니다. (예시)'); if (store.get(parent(path))?.type !== 'directory') throw new Error('상위 폴더를 찾을 수 없습니다. (예시)'); store.set(path, fileEntry(path, 'directory')); return { success: true }; },
    renameFile: async (id, source, target) => relocate(id, [source], parent(target), target),
    moveFiles: async (id, paths, targetDirectory) => relocate(id, paths, targetDirectory),
    deleteFiles: async (id, paths) => { const store = fileStore(id); paths.forEach(path => { for (const entry of [...store.values()]) if (entry.path === path || entry.path.startsWith(`${path}/`)) store.delete(entry.path); }); return { success: true }; },
    uploadFiles: async (id, directory, options) => transfer(id, 'upload', [options?.directory ? 'example-folder' : 'example.txt'], directory),
    downloadFiles: async (id, paths) => transfer(id, 'download', paths),
    getFileTransfers: async () => fileSnapshot(),
    onFileTransfers: callback => { fileListeners.add(callback); return () => fileListeners.delete(callback); },
    cancelFileTransfer: async transferId => { const item = transfers.find(item => item.id === transferId); if (item?.status === 'running') item.status = 'canceled'; return emitFiles(); },
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
