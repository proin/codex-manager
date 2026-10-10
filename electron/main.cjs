const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Menu, session } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { AccountService, validateResetSelections } = require('./account-service.cjs');
const { findRuntime } = require('./runtime.cjs');
const { HostService } = require('./host-service.cjs');

app.setName('Codex Account Manager');
if (process.env.CODEX_MANAGER_DATA_DIR) app.setPath('userData', path.resolve(process.env.CODEX_MANAGER_DATA_DIR));
const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.quit();
let mainWindow;
let service;
let hostService;
let runtime;
let quitting = false;
let changingRuntime = false;
const dataDir = app.getPath('userData');
const settingsPath = path.join(dataDir, 'runtime.json');
const indexPath = path.join(__dirname, '../dist/index.html');
const devUrl = !app.isPackaged && process.env.CODEX_MANAGER_DEV_URL === 'http://127.0.0.1:5178'
  ? process.env.CODEX_MANAGER_DEV_URL : null;

function state() {
  return { ...service.snapshot(), runtime: { available: runtime.available, path: runtime.path, version: runtime.version, error: runtime.error } };
}
function publish() {
  if (mainWindow && !mainWindow.isDestroyed() && service) mainWindow.webContents.send('accounts:state', state());
}
function publishHosts() {
  if (mainWindow && !mainWindow.isDestroyed() && hostService) mainWindow.webContents.send('hosts:state', hostService.snapshot());
}
function trusted(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('허용되지 않은 요청입니다.');
  const actual = new URL(event.senderFrame.url);
  const expected = new URL(devUrl || pathToFileURL(indexPath).href);
  if (actual.protocol !== expected.protocol || actual.host !== expected.host || (!devUrl && actual.pathname !== expected.pathname)) throw new Error('허용되지 않은 화면입니다.');
}
function accountId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new Error('계정을 선택하십시오.');
  return id;
}
function ids(value, optional = false) {
  if (optional && value == null) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 500) throw new Error('계정을 선택하십시오.');
  return [...new Set(value.map(accountId))];
}
async function openLogin(id) {
  const account = service.snapshot().accounts.find(row => row.id === accountId(id));
  const value = account?.login?.url;
  if (!value) throw new Error('로그인을 먼저 시작하십시오.');
  const url = new URL(value);
  if (url.protocol !== 'https:' || !['auth.openai.com', 'auth0.openai.com', 'chatgpt.com'].includes(url.hostname) || url.username || url.password) throw new Error('로그인 주소를 열 수 없습니다.');
  await shell.openExternal(url.href);
}
function remoteLogin(id) {
  const host = hostService.requireHost(id, true);
  const login = host.login;
  if (!login || !['waiting', 'verifying'].includes(login.status)) throw new Error('호스트 로그인을 먼저 시작하십시오.');
  return login;
}
async function openCodexLogin(id) {
  const login = remoteLogin(id);
  let url;
  try { url = new URL(login.url); } catch { throw new Error('로그인 주소를 열 수 없습니다.'); }
  if (url.protocol !== 'https:' || !['auth.openai.com', 'auth0.openai.com', 'chatgpt.com'].includes(url.hostname) || url.username || url.password || (url.port && url.port !== '443')) throw new Error('로그인 주소를 열 수 없습니다.');
  await shell.openExternal(url.href);
}
function copyCodexLoginCode(id) {
  const code = remoteLogin(id).userCode;
  if (typeof code !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(code)) throw new Error('인증 코드를 복사할 수 없습니다.');
  clipboard.writeText(code);
  return true;
}
async function setupService(command) {
  service = new AccountService({ dataDir, command: command.command || '', args: [...(command.args || []), 'app-server'], onChange: publish });
  await service.init();
}
function registerHandlers() {
  const methods = {
    getState: async () => state(),
    getAccountDetails: async id => service.getAccountDetails(accountId(id)),
    refreshAccountDetails: async id => service.refreshAccountDetails(accountId(id)),
    addAccount: async label => { await service.addAccount(label); return state(); },
    renameAccount: async (id, label) => { await service.renameAccount(accountId(id), label); return state(); },
    login: async (id, method) => {
      if (!['chatgpt', 'chatgptDeviceCode', undefined].includes(method)) throw new Error('로그인 방식을 선택하십시오.');
      await service.login(accountId(id), method || 'chatgpt');
      if (service.snapshot().accounts.find(row => row.id === id)?.login?.url) await openLogin(id);
      return state();
    },
    cancelLogin: async id => { await service.cancelLogin(accountId(id)); return state(); },
    refreshAccounts: async selected => { await service.refreshAccounts(ids(selected, true)); return state(); },
    resetAccounts: async (selected, selections = null) => {
      const selectedIds = ids(selected);
      const credits = validateResetSelections(selectedIds, selections, service.snapshot().accounts, { requireSelection: true });
      await service.resetAccounts(selectedIds, credits);
      return state();
    },
    removeAccount: async id => { await service.removeAccount(accountId(id)); return state(); },
    openLogin,
    openUsagePage: async () => shell.openExternal('https://chatgpt.com/codex/settings/usage'),
    chooseCodexBinary: async () => {
      const active = service.snapshot();
      if (changingRuntime || active.refresh?.running || active.accounts.some(a => a.status === 'loading' || a.status === 'loggingIn' || a.resetAttempt?.status === 'pending')) throw new Error('진행 중인 작업이 끝난 뒤 변경하십시오.');
      changingRuntime = true;
      try {
        const selection = await dialog.showOpenDialog(mainWindow, { title: 'Codex 실행 파일 선택', properties: ['openFile', 'showHiddenFiles'] });
        if (selection.canceled) return state();
        const found = await findRuntime(selection.filePaths[0]);
        if (!found.available) throw new Error(found.error || 'Codex 실행 파일을 찾을 수 없습니다.');
        await service.close();
        runtime = found;
        await fs.writeFile(settingsPath, JSON.stringify({ path: found.path }), { mode: 0o600 });
        await setupService(found);
        publish();
        return state();
      } finally { changingRuntime = false; }
    },
  };
  for (const [method, handler] of Object.entries(methods)) {
    ipcMain.handle(`accounts:${method}`, async (event, ...args) => {
      trusted(event);
      if (changingRuntime && method !== 'getState' && method !== 'chooseCodexBinary') throw new Error('Codex 실행 파일을 변경하고 있습니다.');
      return handler(...args);
    });
  }
  const hostMethods = {
    getState: () => hostService.snapshot(),
    reloadHosts: () => hostService.reloadHosts(),
    saveHost: (draft, revision) => hostService.saveHost(draft, revision),
    deleteHost: (id, revision) => hostService.deleteHost(id, revision),
    deleteHosts: (selected, revision) => hostService.deleteHosts(selected, revision),
    reorderHosts: (selected, revision) => hostService.reorderHosts(selected, revision),
    saveGroup: (draft, revision) => hostService.saveGroup(draft, revision),
    deleteGroup: (id, revision) => hostService.deleteGroup(id, revision),
    setGroupCollapsed: (id, collapsed, revision) => hostService.setGroupCollapsed(id, collapsed, revision),
    moveHostToGroup: (id, groupId, revision, orderedIds) => hostService.moveHostToGroup(id, groupId, revision, orderedIds),
    refreshHosts: selected => hostService.refreshHosts(selected),
    cancelRefresh: () => hostService.cancelRefresh(),
    getHostDetails: id => hostService.getHostDetails(id),
    generateKey: id => hostService.generateKey(id),
    inspectKeys: (id, password) => hostService.inspectKeys(id, password),
    registerKey: (id, password) => hostService.registerKey(id, password),
    upgradeCodex: async id => { await hostService.upgradeCodex(id); return hostService.snapshot(); },
    upgradeCodexBatch: selected => hostService.upgradeCodexBatch(selected),
    startCodexLogin: id => hostService.startCodexLogin(id),
    cancelCodexLogin: id => hostService.cancelCodexLogin(id),
    openCodexLogin,
    copyCodexLoginCode,
  };
  for (const [method, handler] of Object.entries(hostMethods)) {
    ipcMain.handle(`hosts:${method}`, async (event, ...args) => {
      trusted(event);
      return handler(...args);
    });
  }
}
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1340, height: 760, minWidth: 880, minHeight: 440,
    title: 'Codex Account Manager', backgroundColor: '#f5f6f8', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());
  mainWindow.once('ready-to-show', () => mainWindow.show());
  if (devUrl) mainWindow.loadURL(devUrl);
  else mainWindow.loadFile(indexPath);
  mainWindow.on('closed', () => { mainWindow = null; });
}
app.on('second-instance', () => { if (mainWindow) { mainWindow.restore(); mainWindow.focus(); } });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (quitting || !service) return;
  event.preventDefault();
  quitting = true;
  Promise.allSettled([service.close(), hostService?.close()]).finally(() => app.quit());
});
if (hasLock) app.whenReady().then(async () => {
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  let customPath;
  try { customPath = JSON.parse(await fs.readFile(settingsPath, 'utf8')).path; } catch {}
  runtime = await findRuntime(customPath);
  await setupService(runtime);
  const configPath = process.env.CODEX_MANAGER_SSH_CONFIG ? path.resolve(process.env.CODEX_MANAGER_SSH_CONFIG) : undefined;
  hostService = new HostService({ configPath, sshDir: configPath ? path.dirname(configPath) : undefined, onChange: publishHosts });
  await hostService.init();
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Codex Account Manager', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { type: 'separator' }, { role: 'quit' }] },
    { label: '편집', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '보기', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }, ...(!app.isPackaged ? [{ role: 'toggleDevTools' }] : [])] },
  ]));
  registerHandlers();
  createWindow();
  mainWindow.webContents.once('did-finish-load', () => {
    const saved = service.snapshot().accounts.filter(account => account.email || account.usage).map(account => account.id);
    if (runtime.available && saved.length) void service.refreshAccounts(saved).catch(() => {});
  });
}).catch(() => {
  dialog.showErrorBox('앱 시작 실패', '저장 폴더 또는 Codex 실행 파일을 확인한 뒤 다시 실행하십시오.');
  app.quit();
});
