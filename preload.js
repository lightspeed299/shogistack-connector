// ShogiStack Connector — Preload (Security Bridge)
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('connector', {
  // 設定
  getConfig: () => ipcRenderer.invoke('get-config'),
  getVersion: () => ipcRenderer.invoke('get-version'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),

  // エンジン選択
  selectEngineFile: () => ipcRenderer.invoke('select-engine-file'),

  // 接続制御
  connect: (config) => ipcRenderer.invoke('connect', config),
  disconnect: () => ipcRenderer.invoke('disconnect'),

  // イベント受信
  onStatusUpdate: (callback) => {
    ipcRenderer.on('status-update', (_, data) => callback(data));
  },
  onLogMessage: (callback) => {
    ipcRenderer.on('log-message', (_, msg) => callback(msg));
  },
});
