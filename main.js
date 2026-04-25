// ShogiStack Connector — Electron Main Process
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const io = require('socket.io-client');
const { spawn } = require('child_process');
const { autoUpdater } = require('electron-updater');

const CURRENT_VERSION = `v${require('./package.json').version}`;

function sanitizeDeviceMeta(value, fallback, maxLength) {
  const cleaned = String(value || '')
    .replace(/[\r\n\x00-\x1f\x7f<>]/g, '')
    .trim();
  return (cleaned || fallback).slice(0, maxLength);
}

function getConnectorIdentity() {
  return {
    deviceName: sanitizeDeviceMeta(os.hostname(), 'Windows PC', 64),
    platform: sanitizeDeviceMeta(`${os.type()} ${os.arch()}`, 'Windows', 32),
    version: CURRENT_VERSION,
  };
}

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
let isChangingOptionTimer = null;
let lastSfen = null;
let lastTurn = null;
let currentConfig = null;

// ★エンジン自動再起動（クラッシュ時）: 1分間に最大3回まで
const ENGINE_RESTART_LIMIT = 3;
const ENGINE_RESTART_WINDOW_MS = 60 * 1000;
let engineRestartTimestamps = [];

// ★安全な stdin.write ヘルパー（破損パイプへの書き込みを防止）
function safeWrite(cmd) {
  if (engineProcess && engineProcess.stdin && engineProcess.stdin.writable) {
    try {
      engineProcess.stdin.write(cmd);
      return true;
    } catch (e) {
      log(`stdin書き込みエラー: ${e.message}`);
      return false;
    }
  }
  return false;
}

// ★isChangingOption 安全タイムアウト設定/解除
function setChangingOption(value) {
  isChangingOption = value;
  if (isChangingOptionTimer) {
    clearTimeout(isChangingOptionTimer);
    isChangingOptionTimer = null;
  }
  if (value) {
    isChangingOptionTimer = setTimeout(() => {
      if (isChangingOption) {
        log('⚠️ isChangingOption 安全タイムアウト: 強制リセット');
        isChangingOption = false;
        isChangingOptionTimer = null;
      }
    }, 15000);
  }
}

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
    auth: { type: 'connector', token: config.apiKey, ...getConnectorIdentity() }
  });

  socket.on('connect', () => {
    log(`接続成功 (ID: ${socket.id})`);
    log(`[DIAG] エンジン状態: ${engineProcess ? 'running (PID: ' + engineProcess.pid + ')' : 'stopped'}`);
    log(`[DIAG] 現在の設定: Threads=${config.engineOptions?.Threads || '未設定'}, MultiPV=${config.engineOptions?.MultiPV || '未設定'}`);
    socket.emit('connector_ready');
    sendStatus({ connected: true, engineRunning: !!engineProcess });
    startEngine(config);
  });

  socket.on('connect_error', (err) => {
    log(`[DIAG] 接続エラー: ${err.message} (type: ${err.type || 'unknown'})`);
    sendStatus({ connected: false, engineRunning: false });
  });

  socket.on('disconnect', (reason) => {
    log(`[DIAG] 切断 (reason: ${reason}, engineRunning: ${!!engineProcess})`);
    sendStatus({ connected: false, engineRunning: !!engineProcess });
    if (reason === 'io server disconnect') {
      log('[DIAG] サーバー側切断 → 手動再接続を試行');
      socket.connect();
    }
  });

  // ★診断: 再接続イベント
  socket.io.on('reconnect_attempt', (attempt) => {
    log(`[DIAG] 再接続試行 #${attempt}`);
  });
  socket.io.on('reconnect', (attempt) => {
    log(`[DIAG] 再接続成功 (${attempt}回目)`);
  });
  socket.io.on('reconnect_error', (err) => {
    log(`[DIAG] 再接続エラー: ${err.message}`);
  });

  // ★設定同期: ブラウザ接続時に現在のエンジン設定を返す
  socket.on('request_engine_settings', () => {
    log(`[DIAG] ブラウザから設定リクエスト受信 → Threads=${currentConfig?.engineOptions?.Threads}, MultiPV=${currentConfig?.engineOptions?.MultiPV}`);
    if (currentConfig?.engineOptions && socket?.connected) {
      socket.emit('connector_engine_settings', {
        Threads: currentConfig.engineOptions.Threads,
        MultiPV: currentConfig.engineOptions.MultiPV,
      });
    }
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
    safeWrite('stop\n');
    safeWrite(`position sfen ${sanitizeUSI(sfen)}\n`);
    safeWrite('go infinite\n');
  });

  socket.on('stop_analysis', () => {
    if (isChangingOption) { isAnalyzing = false; return; }
    log('解析停止');
    isAnalyzing = false;
    safeWrite('stop\n');
    safeWrite('usinewgame\n');
    safeWrite('isready\n');
  });

  socket.on('reset_engine', async () => {
    if (!engineProcess) return;
    log('エンジンリセット');
    try {
      const wasAnalyzing = isAnalyzing;
      if (wasAnalyzing) {
        safeWrite('stop\n');
        await waitForStop(engineProcess);
      }
      isAnalyzing = false;
      safeWrite('usinewgame\n');
      safeWrite('isready\n');
      await waitForReady(engineProcess);
      if (wasAnalyzing && lastSfen) {
        isAnalyzing = true;
        safeWrite(`position sfen ${sanitizeUSI(lastSfen)}\n`);
        safeWrite('go infinite\n');
      }
    } catch (e) {
      log(`エンジンリセットエラー: ${e.message}`);
      isAnalyzing = false;
    }
  });

  socket.on('set_engine_option', async (data) => {
    if (!engineProcess || isChangingOption) {
      log(`[DIAG] set_engine_option 拒否 (engineProcess: ${!!engineProcess}, isChangingOption: ${isChangingOption})`);
      return;
    }
    const { name, value } = data;
    const oldValue = config.engineOptions?.[name];
    log(`[DIAG] オプション変更: ${name} = ${oldValue} → ${value} (ブラウザからの要求)`);
    setChangingOption(true);

    if (!config.engineOptions) config.engineOptions = {};
    config.engineOptions[name] = value;
    try { saveConfig(config); } catch (e) { log(`設定保存エラー: ${e.message}`); }

    try {
      const wasAnalyzing = isAnalyzing;
      if (wasAnalyzing) {
        safeWrite('stop\n');
        await waitForStop(engineProcess);
      }
      safeWrite(`setoption name ${sanitizeUSI(name)} value ${sanitizeUSI(value)}\n`);
      safeWrite('isready\n');
      await waitForReady(engineProcess);
      if (wasAnalyzing && lastSfen) {
        safeWrite(`position sfen ${lastSfen}\n`);
        safeWrite('go infinite\n');
      }
    } catch (e) {
      log(`オプション変更エラー: ${e.message}`);
    } finally {
      setChangingOption(false);
      // ★設定同期: 変更後の実際の値をブラウザへ通知
      if (socket?.connected && currentConfig?.engineOptions) {
        socket.emit('connector_engine_settings', {
          Threads: currentConfig.engineOptions.Threads,
          MultiPV: currentConfig.engineOptions.MultiPV,
        });
      }
    }
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
let isStartingEngine = false;

// ★旧エンジンを安全に終了させる（quit → SIGTERM → 3秒後にフォースキル）
function killEngineProcess() {
  return new Promise((resolve) => {
    if (!engineProcess) { resolve(); return; }

    const proc = engineProcess;
    engineProcess = null;

    let settled = false;
    const settle = () => { if (settled) return; settled = true; resolve(); };

    // 3秒で強制終了（Windowsでは大きなプロセスの終了に時間がかかる）
    const forceTimer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      settle();
    }, 3000);

    proc.once('close', () => {
      clearTimeout(forceTimer);
      settle();
    });

    // USIプロトコルで正常終了を要求 → 1秒後にSIGTERM
    try { proc.stdin.write('quit\n'); } catch {}
    setTimeout(() => { try { proc.kill(); } catch {} }, 1000);
  });
}

async function startEngine(config) {
  // ★再入防止: 同時に複数のstartEngineが走らないようにする
  if (isStartingEngine) {
    log('エンジン起動中のため、起動要求をスキップしました');
    return;
  }
  isStartingEngine = true;

  try {
    // ★修正: 旧エンジンの終了を待ってから新エンジンを起動（二重起動防止）
    await killEngineProcess();

    const enginePath = config.enginePath;

    if (!enginePath || !fs.existsSync(enginePath)) {
      log(`エンジンが見つかりません: ${enginePath || '(未設定)'}`);
      sendStatus({ connected: !!socket?.connected, engineRunning: false });
      return;
    }

    log(`エンジン起動: ${path.basename(enginePath)}`);
    log(`[DIAG] 適用オプション: ${JSON.stringify(config.engineOptions || {})}`);
    const proc = spawn(enginePath, [], { cwd: path.dirname(enginePath) });
    engineProcess = proc;

    proc.stdin.write('usi\n');
    if (config.engineOptions) {
      for (const [key, value] of Object.entries(config.engineOptions)) {
        proc.stdin.write(`setoption name ${key} value ${value}\n`);
      }
    }
    proc.stdin.write('isready\n');
    proc.stdin.write('usinewgame\n');

    // ★info行スロットリング: MultiPVごとに最新のみ150ms間隔で送信（NPS改善）
    let pendingInfoLines = [];
    let infoFlushTimer = null;
    const INFO_THROTTLE_MS = 150;

    proc.stdout.on('data', (chunk) => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === 'readyok') {
          log('エンジン準備完了');
          sendStatus({ connected: !!socket?.connected, engineRunning: true });
        }
        if (isAnalyzing && trimmed.startsWith('info') && trimmed.includes('score')) {
          if (socket?.connected) {
            pendingInfoLines.push({ info: trimmed, sfen: lastSfen, turn: lastTurn });

            if (!infoFlushTimer) {
              infoFlushTimer = setTimeout(() => {
                // MultiPVごとに最新のinfoだけを送信
                const latest = new Map();
                for (const item of pendingInfoLines) {
                  const mpvMatch = item.info.match(/multipv (\d+)/);
                  const mpv = mpvMatch ? mpvMatch[1] : '1';
                  latest.set(mpv, item);
                }
                for (const data of latest.values()) {
                  socket.emit('connector_analysis_update', data);
                }
                pendingInfoLines = [];
                infoFlushTimer = null;
              }, INFO_THROTTLE_MS);
            }
          }
        }
      }
    });

    proc.stderr.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('Error') || msg.includes('Failed') || msg.includes('cannot open')) {
        log(`エンジンエラー: ${msg.trim()}`);
      }
    });

    proc.on('close', (code) => {
      // ★ガード: 古いプロセスのハンドラが新プロセスの参照を上書きしないようにする
      if (engineProcess !== proc) return;

      log(`エンジン終了 (code: ${code})`);
      engineProcess = null;
      // ★デッドロック防止: エンジン終了時にフラグを強制リセット
      setChangingOption(false);
      isAnalyzing = false;
      sendStatus({ connected: !!socket?.connected, engineRunning: false });

      // ★エンジン自動再起動（意図しないクラッシュ時）
      if (currentConfig && socket?.connected && code !== 0 && code !== null) {
        const now = Date.now();
        engineRestartTimestamps = engineRestartTimestamps.filter(t => now - t < ENGINE_RESTART_WINDOW_MS);
        if (engineRestartTimestamps.length < ENGINE_RESTART_LIMIT) {
          engineRestartTimestamps.push(now);
          log(`⚠️ エンジンがクラッシュしました。自動再起動します... (${engineRestartTimestamps.length}/${ENGINE_RESTART_LIMIT})`);
          setTimeout(() => startEngine(currentConfig), 1000);
        } else {
          log('❌ エンジンの再起動回数が上限に達しました。手動で再接続してください。');
        }
      }
    });
  } finally {
    isStartingEngine = false;
  }
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
      // eval/ サブフォルダ内のファイルも検出
      const evalDir = files.find(f => {
        const full = path.join(dir, f);
        return f.toLowerCase() === 'eval' && fs.statSync(full).isDirectory();
      });
      let evalContents = [];
      if (evalDir) {
        try {
          evalContents = fs.readdirSync(path.join(dir, evalDir))
            .filter(f => /\.(bin|nnue)$/i.test(f));
        } catch (_) { /* ignore */ }
      }

      if (nnueFiles.length > 0) {
        return { ok: true, type: 'NNUE', files: nnueFiles };
      }
      if (dlFiles.length > 0) {
        return { ok: true, type: 'DL', files: dlFiles };
      }
      if (evalDir) {
        const display = evalContents.length > 0
          ? evalContents.map(f => `eval/${f}`)
          : ['eval/'];
        return { ok: true, type: 'evalフォルダ', files: display };
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
  ipcMain.handle('download-update', () => {
    autoUpdater.downloadUpdate().catch((err) => {
      log(`ダウンロードエラー: ${err.message}`);
    });
  });
  ipcMain.handle('install-update', () => {
    disconnectFromServer();
    autoUpdater.quitAndInstall(true, true);
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
    icon: path.join(__dirname, 'assets', 'icon.ico'),
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
