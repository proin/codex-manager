const { contextBridge, ipcRenderer } = require('electron');

const invoke = (method) => (...args) => ipcRenderer.invoke(`accounts:${method}`, ...args);
contextBridge.exposeInMainWorld('accountManager', Object.freeze({
  getState: invoke('getState'),
  getAccountDetails: invoke('getAccountDetails'),
  refreshAccountDetails: invoke('refreshAccountDetails'),
  addAccount: invoke('addAccount'),
  renameAccount: invoke('renameAccount'),
  login: invoke('login'),
  cancelLogin: invoke('cancelLogin'),
  refreshAccounts: invoke('refreshAccounts'),
  resetAccounts: (ids, selections = null) => ipcRenderer.invoke('accounts:resetAccounts', ids, selections),
  removeAccount: invoke('removeAccount'),
  openLogin: invoke('openLogin'),
  openUsagePage: invoke('openUsagePage'),
  chooseCodexBinary: invoke('chooseCodexBinary'),
  onState(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('accounts:state', listener);
    return () => ipcRenderer.removeListener('accounts:state', listener);
  },
}));

const invokeHost = method => (...args) => ipcRenderer.invoke(`hosts:${method}`, ...args);
contextBridge.exposeInMainWorld('hostManager', Object.freeze({
  getState: invokeHost('getState'),
  reloadHosts: invokeHost('reloadHosts'),
  saveHost: invokeHost('saveHost'),
  deleteHost: invokeHost('deleteHost'),
  reorderHosts: invokeHost('reorderHosts'),
  saveGroup: invokeHost('saveGroup'),
  deleteGroup: invokeHost('deleteGroup'),
  setGroupCollapsed: invokeHost('setGroupCollapsed'),
  moveHostToGroup: invokeHost('moveHostToGroup'),
  refreshHosts: invokeHost('refreshHosts'),
  cancelRefresh: invokeHost('cancelRefresh'),
  getHostDetails: invokeHost('getHostDetails'),
  generateKey: invokeHost('generateKey'),
  inspectKeys: invokeHost('inspectKeys'),
  registerKey: invokeHost('registerKey'),
  upgradeCodex: invokeHost('upgradeCodex'),
  startCodexLogin: invokeHost('startCodexLogin'),
  cancelCodexLogin: invokeHost('cancelCodexLogin'),
  openCodexLogin: invokeHost('openCodexLogin'),
  copyCodexLoginCode: invokeHost('copyCodexLoginCode'),
  onState(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('hosts:state', listener);
    return () => ipcRenderer.removeListener('hosts:state', listener);
  },
}));
