// ShogiStack Connector — Renderer (app.js)
(async () => {
  const $ = (sel) => document.querySelector(sel);
  const config = await window.connector.getConfig();
  const version = await window.connector.getVersion();
  const sysInfo = await window.connector.getSystemInfo();

  // スレッド/Hash上限をシステム仕様に合わせる
  const maxThreads = sysInfo.cpuCores;
  const maxHashMB = Math.floor(sysInfo.totalMemoryMB * 0.75); // メモリの75%まで
  applyLimits('wizard-threads', 'wizard-hash', maxThreads, maxHashMB);
  applyLimits('cfg-threads', 'cfg-hash', maxThreads, maxHashMB);

  function applyLimits(threadsId, hashId, maxT, maxH) {
    const tEl = $(`#${threadsId}`);
    const hEl = $(`#${hashId}`);
    if (tEl) { tEl.max = maxT; tEl.title = `最大 ${maxT} (CPU論理コア数)`; }
    if (hEl) { hEl.max = maxH; hEl.title = `最大 ${maxH} MB (搭載メモリの75%)`; }
  }

  // 設定があればメイン画面、なければウィザード
  if (config && config.apiKey && config.enginePath) {
    showMain(config);
  } else {
    showWizard();
  }

  // ========== Wizard ==========
  function showWizard() {
    $('#wizard').classList.remove('hidden');
    $('#main').classList.add('hidden');
    showStep(1);

    // Step 1: API Key
    const apikeyInput = $('#wizard-apikey');
    const next1 = $('#wizard-next1');
    apikeyInput.addEventListener('input', () => {
      next1.disabled = !apikeyInput.value.trim();
    });
    next1.addEventListener('click', () => showStep(2));

    // Step 2: Engine
    const engineInput = $('#wizard-engine');
    const next2 = $('#wizard-next2');
    $('#wizard-browse').addEventListener('click', async () => {
      const filePath = await window.connector.selectEngineFile();
      if (filePath) {
        engineInput.value = filePath;
        next2.disabled = false;
        checkEvalFiles(filePath);
      }
    });
    next2.addEventListener('click', () => showStep(3));
    $('#wizard-back2').addEventListener('click', () => showStep(1));

    // Step 3: Options
    $('#wizard-back3').addEventListener('click', () => showStep(2));
    $('#wizard-finish').addEventListener('click', async () => {
      const newConfig = {
        serverUrl: 'https://shogistack-server.onrender.com',
        apiKey: apikeyInput.value.trim(),
        enginePath: engineInput.value,
        engineOptions: {
          Threads: parseInt($('#wizard-threads').value, 10) || 4,
          USI_Hash: parseInt($('#wizard-hash').value, 10) || 1024,
          MultiPV: parseInt($('#wizard-multipv').value, 10) || 3,
          fv_scale: parseInt($('#wizard-fvscale').value, 10) || 24,
        }
      };
      await window.connector.saveConfig(newConfig);
      showMain(newConfig);
      window.connector.connect(newConfig);
    });
  }

  function showStep(n) {
    for (let i = 1; i <= 3; i++) {
      $(`#wizard-step${i}`).classList.toggle('hidden', i !== n);
    }
  }

  async function checkEvalFiles(enginePath) {
    const statusEl = $('#wizard-eval-status');
    statusEl.textContent = '評価関数を確認中...';
    statusEl.className = 'eval-status';

    const result = await window.connector.checkEvalFiles(enginePath);
    if (result.ok) {
      statusEl.textContent = `評価関数を検出 (${result.type}): ${result.files.join(', ')}`;
      statusEl.style.color = '#008000';
    } else {
      statusEl.textContent = '評価関数が見つかりません。エンジンと同じフォルダに配置してください。';
      statusEl.style.color = '#cc6600';
    }
  }

  // ========== Main Screen ==========
  function showMain(cfg) {
    $('#wizard').classList.add('hidden');
    $('#main').classList.remove('hidden');
    $('#version').textContent = version;

    populateSettings(cfg);
    setupMainHandlers(cfg);

    // 既存設定があれば自動接続
    if (cfg.apiKey && cfg.enginePath) {
      window.connector.connect(cfg);
    }
  }

  function populateSettings(cfg) {
    $('#cfg-apikey').value = cfg.apiKey || '';
    $('#cfg-engine').value = cfg.enginePath || '';
    const opts = cfg.engineOptions || {};
    $('#cfg-threads').value = opts.Threads || 4;
    $('#cfg-hash').value = opts.USI_Hash || 1024;
    $('#cfg-multipv').value = opts.MultiPV || 3;
    $('#cfg-fvscale').value = opts.fv_scale || 24;

    if (cfg.enginePath) {
      const name = cfg.enginePath.split('/').pop();
      $('#engine-name').textContent = name;
    }
  }

  function setupMainHandlers(cfg) {
    // API Key visibility toggle
    let keyVisible = false;
    $('#btn-toggle-key').addEventListener('click', () => {
      keyVisible = !keyVisible;
      $('#cfg-apikey').type = keyVisible ? 'text' : 'password';
      $('#btn-toggle-key').textContent = keyVisible ? '非表示' : '表示';
    });

    // Engine select
    $('#btn-select-engine').addEventListener('click', async () => {
      const filePath = await window.connector.selectEngineFile();
      if (filePath) {
        $('#cfg-engine').value = filePath;
        $('#engine-name').textContent = filePath.split('/').pop();
        const result = await window.connector.checkEvalFiles(filePath);
        if (result.ok) {
          addLog(`評価関数を検出 (${result.type}): ${result.files.join(', ')}`);
        } else {
          addLog('⚠ 評価関数が見つかりません。エンジンと同じフォルダに配置してください。');
        }
      }
    });

    // Save
    $('#btn-save').addEventListener('click', async () => {
      let threads = parseInt($('#cfg-threads').value, 10) || 4;
      let hash = parseInt($('#cfg-hash').value, 10) || 1024;
      if (threads > maxThreads) { threads = maxThreads; $('#cfg-threads').value = threads; addLog(`Threadsを${maxThreads}に制限しました (CPUコア数上限)`); }
      if (hash > maxHashMB) { hash = maxHashMB; $('#cfg-hash').value = hash; addLog(`Hashを${maxHashMB}MBに制限しました (メモリ75%上限)`); }
      const updated = {
        serverUrl: cfg.serverUrl || 'https://shogistack-server.onrender.com',
        apiKey: $('#cfg-apikey').value,
        enginePath: $('#cfg-engine').value,
        engineOptions: {
          Threads: threads,
          USI_Hash: hash,
          MultiPV: parseInt($('#cfg-multipv').value, 10) || 3,
          fv_scale: parseInt($('#cfg-fvscale').value, 10) || 24,
        }
      };
      await window.connector.saveConfig(updated);
      addLog('設定を保存しました');
    });

    // Reconnect
    $('#btn-reconnect').addEventListener('click', async () => {
      await window.connector.disconnect();
      const freshConfig = await window.connector.getConfig();
      if (freshConfig) {
        populateSettings(freshConfig);
        window.connector.connect(freshConfig);
      }
    });
  }

  // ========== Status & Logs ==========
  window.connector.onStatusUpdate((status) => {
    const badge = $('#status-badge');
    const text = $('#status-text');
    const engineStatus = $('#engine-status');

    if (status.connected) {
      badge.className = 'status-badge online';
      text.textContent = 'ONLINE';
    } else {
      badge.className = 'status-badge offline';
      text.textContent = 'OFFLINE';
    }

    engineStatus.textContent = status.engineRunning ? '待機中' : '停止';

    // ステータスバー更新
    const sbConn = $('#sb-connection');
    const sbEngine = $('#sb-engine');
    if (sbConn) sbConn.textContent = `接続: ${status.connected ? 'オンライン' : 'オフライン'}`;
    if (sbEngine) sbEngine.textContent = `エンジン: ${status.engineRunning ? '待機中' : '停止'}`;
  });

  window.connector.onLogMessage((msg) => {
    addLog(msg);
  });

  function addLog(msg) {
    const container = $('#log-container');
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    entry.textContent = msg;
    container.appendChild(entry);
    container.scrollTop = container.scrollHeight;

    // 最大100件
    while (container.children.length > 100) {
      container.removeChild(container.firstChild);
    }
  }

  // ★ログコピー機能
  $('#btn-copy-log').addEventListener('click', async () => {
    const container = $('#log-container');
    const lines = Array.from(container.children).map(el => el.textContent);
    const text = lines.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      const btn = $('#btn-copy-log');
      btn.textContent = '✅ コピー済み';
      setTimeout(() => { btn.textContent = '📋 コピー'; }, 2000);
    } catch {
      // フォールバック: 手動選択
      const range = document.createRange();
      range.selectNodeContents(container);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
    }
  });

  // ========== Auto Update ==========
  window.connector.onUpdateAvailable((version) => {
    const bar = $('#update-bar');
    const msg = $('#update-msg');
    const btn = $('#btn-update');
    bar.classList.remove('hidden');
    bar.className = 'update-bar';
    msg.textContent = `v${version} が利用可能です`;
    btn.textContent = 'ダウンロード';
    btn.onclick = () => {
      window.connector.downloadUpdate();
      msg.textContent = `v${version} をダウンロード中...`;
      bar.className = 'update-bar downloading';
      btn.disabled = true;
    };
  });

  window.connector.onUpdateProgress((percent) => {
    const msg = $('#update-msg');
    msg.textContent = `ダウンロード中... ${percent}%`;
  });

  window.connector.onUpdateDownloaded(() => {
    const bar = $('#update-bar');
    const msg = $('#update-msg');
    const btn = $('#btn-update');
    bar.className = 'update-bar ready';
    msg.textContent = 'アップデート準備完了';
    btn.textContent = '再起動してインストール';
    btn.disabled = false;
    btn.onclick = () => {
      window.connector.installUpdate();
    };
  });
})();
