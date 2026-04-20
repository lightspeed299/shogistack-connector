// ShogiStack Connector — Renderer (app.js)
(async () => {
  const $ = (sel) => document.querySelector(sel);
  const config = await window.connector.getConfig();
  const version = await window.connector.getVersion();

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

  function checkEvalFiles(enginePath) {
    // Renderer側ではファイルシステムにアクセスできないので、
    // 評価関数チェックは省略（Main Process側でエンジン起動時に判定される）
    const statusEl = $('#wizard-eval-status');
    const dir = enginePath.substring(0, enginePath.lastIndexOf('/'));
    statusEl.textContent = `エンジンフォルダ: ${dir}`;
    statusEl.className = 'eval-status';
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
      $('#btn-toggle-key').textContent = keyVisible ? '🙈' : '👁';
    });

    // Engine select
    $('#btn-select-engine').addEventListener('click', async () => {
      const filePath = await window.connector.selectEngineFile();
      if (filePath) {
        $('#cfg-engine').value = filePath;
        $('#engine-name').textContent = filePath.split('/').pop();
      }
    });

    // Save
    $('#btn-save').addEventListener('click', async () => {
      const updated = {
        serverUrl: cfg.serverUrl || 'https://shogistack-server.onrender.com',
        apiKey: $('#cfg-apikey').value,
        enginePath: $('#cfg-engine').value,
        engineOptions: {
          Threads: parseInt($('#cfg-threads').value, 10) || 4,
          USI_Hash: parseInt($('#cfg-hash').value, 10) || 1024,
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

    engineStatus.textContent = status.engineRunning ? '稼働中' : '停止';
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
})();
