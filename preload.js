// ShogiStack Connector — Preload (Security Bridge)
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('connector', {
  // 設定
  getConfig: () => ipcRenderer.invoke('get-config'),
  getVersion: () => ipcRenderer.invoke('get-version'),
  getSystemInfo: () => ipcRenderer.invoke('get-system-info'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),

  // エンジン選択
  selectEngineFile: () => ipcRenderer.invoke('select-engine-file'),
  checkEvalFiles: (enginePath) => ipcRenderer.invoke('check-eval-files', enginePath),

  // 接続制御
  connect: (config) => ipcRenderer.invoke('connect', config),
  disconnect: () => ipcRenderer.invoke('disconnect'),

  // 自動アップデート
  checkForUpdate: () => ipcRenderer.invoke('check-for-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),

  // イベント受信
  onStatusUpdate: (callback) => {
    ipcRenderer.on('status-update', (_, data) => callback(data));
  },
  onLogMessage: (callback) => {
    ipcRenderer.on('log-message', (_, msg) => callback(msg));
  },
  onUpdateAvailable: (callback) => {
    ipcRenderer.on('update-available', (_, version) => callback(version));
  },
  onUpdateProgress: (callback) => {
    ipcRenderer.on('update-progress', (_, percent) => callback(percent));
  },
  onUpdateDownloaded: (callback) => {
    ipcRenderer.on('update-downloaded', () => callback());
  },
});
