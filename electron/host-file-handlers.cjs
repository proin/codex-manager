'use strict';

function createHostFileHandlers({ fileService, hostService, dialog, shell, getWindow = () => null }) {
  let choosing = false;
  const captureHost = (id) => {
    const host = hostService.requireHost(id, true);
    const state = hostService.state;
    return JSON.stringify([host.id, host.alias, host.optionsText, host.hostName, host.user, host.port, host.identityFile, host.proxyJump, state.configPath, state.connectionRevision || state.revision]);
  };
  const select = async (id, options) => {
    const signature = captureHost(id);
    if (choosing) throw new Error('파일 선택 창을 닫은 뒤 다시 선택하십시오.');
    choosing = true;
    try {
      const window = getWindow();
      const result = await (window && !window.isDestroyed()
        ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options));
      if (result.canceled) return null;
      if (signature !== captureHost(id)) throw new Error('호스트 접속 정보가 변경되었습니다. 파일을 다시 선택하십시오.');
      if (!Array.isArray(result.filePaths) || !result.filePaths.length || result.filePaths.length > 500
        || result.filePaths.some(value => typeof value !== 'string' || !value || value.includes('\0'))) {
        throw new Error('선택한 파일 경로를 읽지 못했습니다.');
      }
      return result.filePaths;
    } finally { choosing = false; }
  };
  return {
    listFiles: (id, remotePath) => fileService.listFiles(id, remotePath),
    readTextFile: (id, remotePath) => fileService.readTextFile(id, remotePath),
    openFileLink: async value => {
      if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u0020\u007f]/.test(value)) throw new Error('링크 주소를 열 수 없습니다.');
      let url;
      try { url = new URL(value); } catch { throw new Error('링크 주소를 열 수 없습니다.'); }
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error('링크 주소를 열 수 없습니다.');
      await shell.openExternal(url.href);
      return { opened: true };
    },
    createDirectory: (id, remotePath) => fileService.createDirectory(id, remotePath),
    renameFile: (id, sourcePath, targetPath) => fileService.renameFile(id, sourcePath, targetPath),
    moveFiles: (id, remotePaths, targetDirectory) => fileService.moveFiles(id, remotePaths, targetDirectory),
    deleteFiles: (id, remotePaths) => fileService.deleteFiles(id, remotePaths),
    uploadFiles: async (id, targetDirectory, options = {}) => {
      if (!options || typeof options !== 'object' || Array.isArray(options)
        || Object.keys(options).some(key => key !== 'directory')
        || (options.directory !== undefined && typeof options.directory !== 'boolean')) {
        throw new Error('업로드할 항목을 올바르게 선택하십시오.');
      }
      const paths = await select(id, {
        title: options.directory ? '업로드할 폴더 선택' : '업로드할 파일 선택',
        properties: [options.directory ? 'openDirectory' : 'openFile', 'multiSelections', 'showHiddenFiles'],
      });
      if (!paths) return { canceled: true };
      return fileService.uploadFiles(id, paths, targetDirectory);
    },
    downloadFiles: async (id, remotePaths) => {
      if (!Array.isArray(remotePaths) || !remotePaths.length || remotePaths.length > 500
        || remotePaths.some(value => typeof value !== 'string' || !value || value.includes('\0'))) {
        throw new Error('다운로드할 파일을 선택하십시오.');
      }
      const paths = await select(id, { title: '다운로드할 위치 선택', properties: ['openDirectory', 'createDirectory'] });
      if (!paths) return { canceled: true };
      return fileService.downloadFiles(id, remotePaths, paths[0]);
    },
    getFileTransfers: () => fileService.getTransfers(),
    cancelFileTransfer: id => fileService.cancelTransfer(id),
  };
}

module.exports = { createHostFileHandlers };
