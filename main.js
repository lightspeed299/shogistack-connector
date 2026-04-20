// ShogiStack Connector — Electron Main Process
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const io = require('socket.io-client');
const { spawn } = require('child_process');
const { autoUpdater } = require('electron-updater');

const CURRENT_VERSION = `v${require('./package.json').version}`;

// --- 設定ファイル ---
// Electron標準の userData (%APPDATA%\shogistack-connector) を使用
function getConfigPath() {
  const dir = app.getPath('userData');
  return path.join(dir, 'config.json');
}

// app.whenReady() 後に初期化するため遅延
let CONFIG_PATH;

// 旧フォルダ (ShogiStackConnector) → 新フォルダ (shogistack-connector) へ移行
function migrateOldConfig() {
  const oldDir = path.join(process.env.APPDATA || '', 'ShogiStackConnector');
  const oldFile = path.join(oldDir, 'config.json');
  if (fs.existsSync(oldFile) && !fs.existsSync(CONFIG_PATH)) {
    try {
      fs.copyFileSync(oldFile, CONFIG_PATH);
      fs.rmSync(oldDir, { recursive: true, force: true });
      log('旧設定を移行しました');
    } catch (e) { /* 移行失敗は無視 */ }
  } else if (fs.existsSync(oldDir) && fs.existsSync(CONFIG_PATH)) {
    // 両方あれば旧フォルダだけ削除
    try { fs.rmSync(oldDir, { recursive: true, force: true }); } catch (e) { /* */ }
  }
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    }
  } catch (e) {
    log(`設定読み込みエラー: ${e.message}`);
  }
  return null;
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// --- ログ送信 ---
let mainWindow = null;

function log(msg) {
  const timestamp = new Date().toLocaleTimeString('ja-JP', { hour12: false });
  const entry = `${timestamp}  ${msg}`;
  console.log(entry);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('log-message', entry);
  }
}

function sendStatus(status) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('status-update', status);
  }
}

// --- USI入力サニタイズ ---
function sanitizeUSI(str) {
  return String(str).replace(/[\r\n\x00-\x1f]/g, '');
}

// --- Socket.io + Engine ---
let socket = null;
let engineProcess = null;
let isAnalyzing = false;
let isChangingOption = false;
let lastSfen = null;
let lastTurn = null;
let currentConfig = null;

function connectToServer(config) {
  currentConfig = config;
  const serverUrl = config.serverUrl || 'https://shogistack-server.onrender.com';

  if (socket) {
    socket.disconnect();
    socket = null;
  }

  log(`サーバー(${serverUrl})に接続中...`);
  sendStatus({ connected: false, engineRunning: false });

  socket = io(serverUrl, {
    auth: { type: 'connector', token: config.apiKey }
  });

  socket.on('connect', () => {
    log(`接続成功 (ID: ${socket.id})`);
    socket.emit('connector_ready');
    sendStatus({ connected: true, engineRunning: !!engineProcess });
    startEngine(config);
  });

  socket.on('connect_error', (err) => {
    log(`接続エラー: ${err.message}`);
    sendStatus({ connected: false, engineRunning: false });
  });

  socket.on('disconnect', (reason) => {
    log(`切断されました (${reason})`);
    sendStatus({ connected: false, engineRunning: !!engineProcess });
    if (reason === 'io server disconnect') socket.connect();
  });

  // --- 解析リクエスト ---
  socket.on('request_analysis', (data) => {
    const { sfen, turn } = data;
    if (isChangingOption) {
      lastSfen = sfen;
      lastTurn = turn;
      return;
    }
    if (!engineProcess || !sfen) return;
    lastSfen = sfen;
    lastTurn = turn;
    isAnalyzing = true;
    log('解析開始...');
    engineProcess.stdin.write('stop\n');
    engineProcess.stdin.write(`position sfen ${sanitizeUSI(sfen)}\n`);
    engineProcess.stdin.write('go infinite\n');
  });

  socket.on('stop_analysis', () => {
    if (isChangingOption) { isAnalyzing = false; return; }
    if (engineProcess) {
      log('解析停止');
      isAnalyzing = false;
      engineProcess.stdin.write('stop\n');
      engineProcess.stdin.write('usinewgame\n');
      engineProcess.stdin.write('isready\n');
    }
  });

  socket.on('reset_engine', async () => {
    if (!engineProcess) return;
    log('エンジンリセット');
    const wasAnalyzing = isAnalyzing;
    if (wasAnalyzing) {
      engineProcess.stdin.write('stop\n');
      await waitForStop(engineProcess);
    }
    isAnalyzing = false;
    engineProcess.stdin.write('usinewgame\n');
    engineProcess.stdin.write('isready\n');
    await waitForReady(engineProcess);
    if (wasAnalyzing && lastSfen) {
      isAnalyzing = true;
      engineProcess.stdin.write(`position sfen ${sanitizeUSI(lastSfen)}\n`);
      engineProcess.stdin.write('go infinite\n');
    }
  });

  socket.on('set_engine_option', async (data) => {
    if (!engineProcess || isChangingOption) return;
    const { name, value } = data;
    log(`オプション変更: ${name} = ${value}`);
    isChangingOption = true;

    if (!config.engineOptions) config.engineOptions = {};
    config.engineOptions[name] = value;
    try { saveConfig(config); } catch (e) { log(`設定保存エラー: ${e.message}`); }

    const wasAnalyzing = isAnalyzing;
    if (wasAnalyzing) {
      engineProcess.stdin.write('stop\n');
      await waitForStop(engineProcess);
    }
    engineProcess.stdin.write(`setoption name ${sanitizeUSI(name)} value ${sanitizeUSI(value)}\n`);
    engineProcess.stdin.write('isready\n');
    await waitForReady(engineProcess);
    if (wasAnalyzing && lastSfen) {
      engineProcess.stdin.write(`position sfen ${lastSfen}\n`);
      engineProcess.stdin.write('go infinite\n');
    }
    isChangingOption = false;
  });
}

function disconnectFromServer() {
  if (engineProcess) {
    try { engineProcess.stdin.write('quit\n'); } catch (e) {}
    engineProcess.kill();
    engineProcess = null;
  }
  if (socket) {
    socket.disconnect();
    socket = null;
  }
  isAnalyzing = false;
  sendStatus({ connected: false, engineRunning: false });
  log('切断しました');
}

// --- エンジン起動 ---
function startEngine(config) {
  if (engineProcess) engineProcess.kill();
  const enginePath = config.enginePath;

  if (!enginePath || !fs.existsSync(enginePath)) {
    log(`エンジンが見つかりません: ${enginePath || '(未設定)'}`);
    sendStatus({ connected: !!socket?.connected, engineRunning: false });
    return;
  }

  log(`エンジン起動: ${path.basename(enginePath)}`);
  engineProcess = spawn(enginePath, [], { cwd: path.dirname(enginePath) });

  engineProcess.stdin.write('usi\n');
  if (config.engineOptions) {
    for (const [key, value] of Object.entries(config.engineOptions)) {
      engineProcess.stdin.write(`setoption name ${key} value ${value}\n`);
    }
  }
  engineProcess.stdin.write('isready\n');
  engineProcess.stdin.write('usinewgame\n');

  engineProcess.stdout.on('data', (chunk) => {
    const lines = chunk.toString().split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === 'readyok') {
        log('エンジン準備完了');
        sendStatus({ connected: !!socket?.connected, engineRunning: true });
      }
      if (isAnalyzing && trimmed.startsWith('info') && trimmed.includes('score')) {
        if (socket?.connected) {
          socket.emit('connector_analysis_update', {
            info: trimmed,
            sfen: lastSfen,
            turn: lastTurn
          });
        }
      }
    }
  });

  engineProcess.stderr.on('data', (data) => {
    const msg = data.toString();
    if (msg.includes('Error') || msg.includes('Failed') || msg.includes('cannot open')) {
      log(`エンジンエラー: ${msg.trim()}`);
    }
  });

  engineProcess.on('close', (code) => {
    log(`エンジン終了 (code: ${code})`);
    engineProcess = null;
    sendStatus({ connected: !!socket?.connected, engineRunning: false });
  });
}

// --- 補助関数 ---
function waitForStop(proc) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => { proc.stdout.off('data', listener); resolve(); }, 1000);
    const listener = (data) => {
      for (const line of data.toString().split('\n')) {
        if (line.trim().startsWith('bestmove') || line.trim().includes('depth 0')) {
          clearTimeout(timeout); proc.stdout.off('data', listener); resolve(); return;
        }
      }
    };
    proc.stdout.on('data', listener);
  });
}

function waitForReady(proc) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => { proc.stdout.off('data', listener); log('readyokタイムアウト'); resolve(); }, 5000);
    const listener = (data) => {
      for (const line of data.toString().split('\n')) {
        if (line.trim() === 'readyok') {
          clearTimeout(timeout); proc.stdout.off('data', listener); resolve(); return;
        }
      }
    };
    proc.stdout.on('data', listener);
  });
}

// --- IPC Handlers ---
function setupIPC() {
  ipcMain.handle('get-config', () => loadConfig());
  ipcMain.handle('get-version', () => CURRENT_VERSION);
  ipcMain.handle('get-system-info', () => ({
    cpuCores: os.cpus().length,
    totalMemoryMB: Math.floor(os.totalmem() / (1024 * 1024)),
  }));

  ipcMain.handle('save-config', (_, config) => {
    if (!config || typeof config !== 'object' || typeof config.apiKey !== 'string' || typeof config.enginePath !== 'string') {
      return false;
    }
    saveConfig(config);
    return true;
  });

  ipcMain.handle('select-engine-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'エンジンを選択',
      filters: [
        { name: '実行ファイル', extensions: ['exe'] },
        { name: 'すべてのファイル', extensions: ['*'] }
      ],
      properties: ['openFile']
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0].replace(/\\/g, '/');
  });

  ipcMain.handle('check-eval-files', (_, enginePath) => {
    try {
      if (!enginePath || !enginePath.endsWith('.exe')) return { ok: false, files: [] };
      const dir = path.dirname(enginePath.replace(/\//g, path.sep));
      const files = fs.readdirSync(dir);
      // NNUE系: nn.bin, *.nnue, nn*.bin
      const nnueFiles = files.filter(f =>
        /^nn.*\.bin$/i.test(f) || /\.nnue$/i.test(f)
      );
      // DL系: *.onnx
      const dlFiles = files.filter(f => /\.onnx$/i.test(f));
      // eval/ サブフォルダ
      const hasEvalDir = files.some(f => {
        const full = path.join(dir, f);
        return f.toLowerCase() === 'eval' && fs.statSync(full).isDirectory();
      });

      if (nnueFiles.length > 0) {
        return { ok: true, type: 'NNUE', files: nnueFiles };
      }
      if (dlFiles.length > 0) {
        return { ok: true, type: 'DL', files: dlFiles };
      }
      if (hasEvalDir) {
        return { ok: true, type: 'eval/', files: ['eval/'] };
      }
      return { ok: false, files: [] };
    } catch (e) {
      return { ok: false, error: e.message, files: [] };
    }
  });

  ipcMain.handle('connect', (_, config) => {
    connectToServer(config);
    return true;
  });

  ipcMain.handle('disconnect', () => {
    disconnectFromServer();
    return true;
  });

  // --- 自動アップデート ---
  ipcMain.handle('check-for-update', () => {
    autoUpdater.checkForUpdates().catch(() => {});
  });
  ipcMain.handle('install-update', () => {
    disconnectFromServer();
    autoUpdater.quitAndInstall();
  });
}

// --- ウィンドウ作成 ---
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 520,
    height: 680,
    minWidth: 420,
    minHeight: 520,
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, 'assets', 'icon.png'),
    title: `ShogiStack Connector ${CURRENT_VERSION}`,
    autoHideMenuBar: true,
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// --- アプリ起動 ---
app.whenReady().then(() => {
  CONFIG_PATH = getConfigPath();
  migrateOldConfig();
  setupIPC();
  createWindow();
  setupAutoUpdater();
});

app.on('window-all-closed', () => {
  disconnectFromServer();
  app.quit();
});

// --- 自動アップデート ---
function setupAutoUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('update-available', (info) => {
    log(`新バージョン ${info.version} が利用可能です`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-available', info.version);
    }
  });

  autoUpdater.on('download-progress', (progress) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-progress', Math.round(progress.percent));
    }
  });

  autoUpdater.on('update-downloaded', () => {
    log('アップデートのダウンロード完了');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-downloaded');
    }
  });

  autoUpdater.on('error', (err) => {
    // latest.yml未公開やネットワークエラーは無視
    if (err.message && (err.message.includes('latest.yml') || err.message.includes('net::') || err.message.includes('404'))) {
      return;
    }
    log(`アップデート確認エラー: ${err.message}`);
  });

  // 起動5秒後にチェック
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 5000);
}
