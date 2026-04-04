const io = require("socket.io-client");
const { spawn, exec } = require("child_process");
const path = require("path");
const fs = require("fs");
const readline = require("readline");
const https = require("https");
const os = require("os");

// ★バージョン設定
const CURRENT_VERSION = "v3.2";
const REPO_OWNER = "lightspeed299";
const REPO_NAME = "shogistack-connector";

// --- 設定ファイルのパス解決 ---
function getConfigPath() {
  const platform = process.platform;
  let configDir;
  if (platform === 'win32') {
    configDir = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ShogiStackConnector');
  } else {
    configDir = path.join(os.homedir(), '.config', 'shogistack-connector');
  }
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  return path.join(configDir, 'config.json');
}

const CONFIG_PATH = getConfigPath();
const LOCAL_CONFIG_PATH = path.join(process.cwd(), "config.json");

// --- メイン処理 ---
(async () => {
  console.log("==========================================");
  console.log(`   ShogiStack Connector (${CURRENT_VERSION})`);
  console.log("==========================================");
  console.log(`📂 設定保存先: ${CONFIG_PATH}`);

  // 0. アップデート確認
  await checkUpdate();

  // 1. 設定ファイルの確認と作成
  let config;
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    } else if (fs.existsSync(LOCAL_CONFIG_PATH)) {
      console.log("♻️  古い設定ファイルが見つかりました。移行します...");
      const oldConfig = fs.readFileSync(LOCAL_CONFIG_PATH, "utf-8");
      fs.writeFileSync(CONFIG_PATH, oldConfig);
      config = JSON.parse(oldConfig);
    } else {
      console.log("\n🔰 初回セットアップを開始します。\n");
      config = await runSetupWizard();
    }
  } catch (err) {
    console.error("❌ 設定読み込み失敗:", err.message);
    console.log("設定ファイルを削除して再起動してください。");
    await waitExit();
    return;
  }

  // 2. サーバー接続開始
  startConnection(config);
})();

// --- アップデート確認機能 ---
function checkUpdate() {
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`,
      method: 'GET',
      headers: { 'User-Agent': 'ShogiStack-Connector' }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', async () => {
        try {
          if (res.statusCode === 200) {
            const release = JSON.parse(data);
            const latestVersion = release.tag_name;

            if (latestVersion && latestVersion !== CURRENT_VERSION) {
              console.log(`\n✨ 新しいバージョンがあります: ${latestVersion} (現在: ${CURRENT_VERSION})`);
              const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
              const ask = (q) => new Promise(r => rl.question(q, r));
              const answer = await ask(">> ダウンロードページを開きますか？ (Y/n): ");
              rl.close();

              if (!answer || answer.toLowerCase().startsWith('y')) {
                console.log("🌐 ブラウザを開いています...");
                const url = release.html_url;
                let startCommand;
                if (process.platform === 'win32') {
                  startCommand = `start "" "${url}"`;
                } else if (process.platform === 'darwin') {
                  startCommand = `open "${url}"`;
                } else {
                  startCommand = `xdg-open "${url}"`;
                }

                // ★修正: ブラウザが開くのを待ってから終了する
                exec(startCommand, (err) => {
                  if (err) {
                    console.error("ブラウザを自動で開けませんでした。以下のURLを手動で開いてください:");
                    console.log(url);
                  }
                  console.log("新しいバージョンをダウンロードして、フォルダごと置き換えてください。設定は引き継がれます。");

                  setTimeout(() => {
                    process.exit(0);
                  }, 1000);
                });

                // execは非同期なのでここでreturnしてはいけない（コールバック内でexitする）
                return;
              }
            }
          }
        } catch (e) { }
        resolve();
      });
    });
    req.on('error', () => resolve());
    req.end();
  });
}

// --- セットアップウィザード ---
function runSetupWizard() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (question) => new Promise(resolve => rl.question(question, resolve));

  return new Promise(async (resolve) => {
    try {
      let apiKey = "";
      while (!apiKey) {
        console.log("【Q1】Web画面の「APIキー」を貼り付けてEnterを押してください");
        apiKey = await ask("> ");
        apiKey = apiKey.trim();
      }

      let enginePath = "";
      console.log("\n【Q2】将棋エンジンを指定してください。");
      console.log("※ 注意: 後で消してしまう場所のファイルは使わないでください。");
      console.log("  「ダウンロード」フォルダなど、ずっと残る場所にあるエンジンを推奨します。");
      console.log("\nエンジンのexeファイル(YaneuraOu等の探索部など)を、");
      console.log("この黒い画面にドラッグ＆ドロップして、Enterを押してください。");

      while (!enginePath) {
        let input = await ask("> ");
        input = input.trim().replace(/^"|"$/g, '');

        if (fs.existsSync(input) && input.toLowerCase().endsWith(".exe")) {
          console.log(`✅ 探索部(exe)を確認しました: ${path.basename(input)}`);
          enginePath = input.replace(/\\/g, "/");
        } else if (input === "") {
        } else {
          console.log("❌ エラー: 正しいexeファイルではありません。");
        }
      }

      const engineDir = path.dirname(enginePath);
      const dirFiles = fs.readdirSync(engineDir);
      const hasEval = dirFiles.some(f => f.includes(".eval") || f.includes(".nnue") || f === "eval");

      if (hasEval) {
        console.log("✅ 評価関数ファイルを確認しました。");
      } else {
        console.log("⚠️ 注意: 同じフォルダに評価関数(nn.eval/evalフォルダ)が見当たりません。")
      }

      let threads = 4;
      while (true) {
        console.log("\n【Q3】CPUスレッド数 (数字を入れてEnter)");
        const input = await ask("> ");
        if (!input.trim()) break;
        const val = parseInt(input, 10);
        if (!isNaN(val) && val >= 1) {
          threads = val;
          break;
        }
      }

      let fvScale = 24;
      while (true) {
        console.log("\n【Q4】評価値スケール (FV_SCALE) (数字を入れてEnter, 24～36が一般的です)");
        const input = await ask("> ");
        if (!input.trim()) break;
        const val = parseInt(input, 10);
        if (!isNaN(val) && val >= 1) {
          fvScale = val;
          break;
        }
      }

      const newConfig = {
        serverUrl: "https://shogistack-server.onrender.com",
        apiKey: apiKey,
        enginePath: enginePath,
        engineOptions: {
          "USI_Hash": 1024,
          "Threads": threads,
          "MultiPV": 3,
          "fv_scale": fvScale
        }
      };

      fs.writeFileSync(CONFIG_PATH, JSON.stringify(newConfig, null, 2));
      console.log(`\n✅ 設定を保存しました！\n場所: ${CONFIG_PATH}`);

      rl.close();
      resolve(newConfig);

    } catch (e) {
      console.error("セットアップエラー:", e);
      rl.close();
      process.exit(1);
    }
  });
}

// --- 接続とエンジンの処理 ---
function startConnection(config) {
  const PRODUCTION_URL = config.serverUrl || "https://shogistack-server.onrender.com";
  const LOCAL_URL = "http://localhost:3001";

  // ★ localhost を先に試し、3秒で接続できなければ本番にフォールバック
  console.log(`🔌 ローカルサーバー(${LOCAL_URL})を確認中...`);
  const testSocket = io(LOCAL_URL, {
    auth: { type: 'connector', token: config.apiKey },
    timeout: 3000,
    reconnection: false,
  });

  testSocket.on("connect", () => {
    console.log(`✅ ローカルサーバーに接続しました！`);
    testSocket.disconnect();
    connectToServer(LOCAL_URL, config);
  });

  testSocket.on("connect_error", () => {
    testSocket.disconnect();
    console.log(`⚠️ ローカル接続失敗。本番サーバー(${PRODUCTION_URL})に接続します...`);
    connectToServer(PRODUCTION_URL, config);
  });
}

function connectToServer(serverUrl, config) {
  console.log(`🔌 サーバー(${serverUrl})に接続中...`);

  const socket = io(serverUrl, {
    auth: { type: 'connector', token: config.apiKey }
  });

  let engineProcess = null;
  let isAnalyzing = false;
  let lastSfen = null;
  let isChangingOption = false;

  socket.on("connect", () => {
    console.log(`✅ 接続成功! (ID: ${socket.id})`);
    socket.emit("connector_ready");
    console.log("Web画面で解析を開始してください。");
    startEngine();
  });

  socket.on("connect_error", (err) => {
    console.error(`❌ 接続エラー: ${err.message}`);
    console.log("5秒後に再接続します...");
    setTimeout(() => socket.connect(), 5000);
  });

  socket.on("disconnect", (reason) => {
    console.log(`⚠️ サーバーから切断されました (理由: ${reason})`);
    if (reason === "io server disconnect") socket.connect();
  });

  socket.on("request_analysis", (data) => {
    const sfen = data.sfen;
    if (isChangingOption) {
      lastSfen = sfen;
      return;
    }

    if (!engineProcess || !sfen) return;
    lastSfen = sfen;
    isAnalyzing = true;
    console.log(`🔍 解析開始...`);
    engineProcess.stdin.write("stop\n");
    engineProcess.stdin.write(`position sfen ${sfen}\n`);
    engineProcess.stdin.write("go infinite\n");
  });

  socket.on("stop_analysis", () => {
    if (isChangingOption) {
      isAnalyzing = false;
      return;
    }
    if (engineProcess) {
      console.log("⏹ 解析停止 (ハッシュクリア)");
      isAnalyzing = false;
      engineProcess.stdin.write("stop\n");
      // ★ShogiGUI準拠: 停止時にusinewgameでハッシュテーブルをクリア
      engineProcess.stdin.write("usinewgame\n");
      engineProcess.stdin.write("isready\n");
    }
  });

  // ★ハッシュリセット専用（棋譜読み込み時等）
  socket.on("reset_engine", async () => {
    if (!engineProcess) return;
    console.log("🔄 エンジンリセット (ハッシュクリア)");
    const wasAnalyzing = isAnalyzing;
    if (wasAnalyzing) {
      engineProcess.stdin.write("stop\n");
      await waitForStop(engineProcess);
    }
    isAnalyzing = false;
    engineProcess.stdin.write("usinewgame\n");
    engineProcess.stdin.write("isready\n");
    await waitForReady(engineProcess);
    if (wasAnalyzing && lastSfen) {
      console.log("🔄 解析再開...");
      isAnalyzing = true;
      engineProcess.stdin.write(`position sfen ${lastSfen}\n`);
      engineProcess.stdin.write("go infinite\n");
    }
  });

  // --- 解析中に設定を変更する ---
  socket.on("set_engine_option", async (data) => {
    if (!engineProcess) return;

    if (isChangingOption) {
      console.log("⚠️ 設定変更処理中のため、新たなリクエストをスキップしました");
      return;
    }

    const { name, value } = data;
    console.log(`⚙ オプション変更: ${name} = ${value}`);

    isChangingOption = true;

    if (!config.engineOptions) config.engineOptions = {};
    config.engineOptions[name] = value;
    try {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    } catch (e) {
      console.error("⚠️ 設定保存エラー:", e.message);
    }

    const wasAnalyzing = isAnalyzing;
    if (wasAnalyzing) {
      engineProcess.stdin.write("stop\n");
      await waitForStop(engineProcess);
    }

    engineProcess.stdin.write(`setoption name ${name} value ${value}\n`);

    engineProcess.stdin.write("isready\n");
    await waitForReady(engineProcess);

    if (wasAnalyzing && lastSfen) {
      console.log("🔄 解析再開...");
      engineProcess.stdin.write(`position sfen ${lastSfen}\n`);
      engineProcess.stdin.write("go infinite\n");
    }

    isChangingOption = false;
  });

  // --- 補助関数: エンジンが止まるまで待つ ---
  function waitForStop(engineProc) {
    return new Promise((resolve) => {
      let resolved = false;
      const timeoutId = setTimeout(() => {
        if (!resolved) {
          engineProc.stdout.off('data', listener);
          resolve();
        }
      }, 1000);

      const listener = (data) => {
        const lines = data.toString().split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith("bestmove") || trimmed.includes("depth 0")) {
            clearTimeout(timeoutId);
            engineProc.stdout.off('data', listener);
            resolved = true;
            resolve();
            return;
          }
        }
      };
      engineProc.stdout.on('data', listener);
    });
  }

  // --- 補助関数: readyokを待つ ---
  function waitForReady(engineProc) {
    return new Promise((resolve) => {
      let resolved = false;
      const timeoutId = setTimeout(() => {
        if (!resolved) {
          engineProc.stdout.off('data', listener);
          console.log("⚠️ readyok待ちタイムアウト(強制続行)");
          resolve();
        }
      }, 5000);

      const listener = (data) => {
        const lines = data.toString().split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed === "readyok") {
            clearTimeout(timeoutId);
            engineProc.stdout.off('data', listener);
            resolved = true;
            resolve();
            return;
          }
        }
      };
      engineProc.stdout.on('data', listener);
    });
  }

  function startEngine() {
    if (engineProcess) engineProcess.kill();
    const enginePath = config.enginePath;
    const cwd = path.dirname(enginePath);

    if (!fs.existsSync(enginePath)) {
      console.error(`❌ エンジンが見つかりません: ${enginePath}`);
      return;
    }

    console.log(`🚀 エンジン起動: ${path.basename(enginePath)}`);

    engineProcess = spawn(enginePath, [], { cwd: cwd });

    engineProcess.stdin.write("usi\n");
    if (config.engineOptions) {
      for (const [key, value] of Object.entries(config.engineOptions)) {
        engineProcess.stdin.write(`setoption name ${key} value ${value}\n`);
      }
    }
    engineProcess.stdin.write("isready\n");
    engineProcess.stdin.write("usinewgame\n");

    engineProcess.stdout.on("data", (chunk) => {
      const lines = chunk.toString().split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        // ★ isAnalyzing ガード: 解析停止後のinfo出力はクライアントに送らない
        if (isAnalyzing && trimmed.startsWith("info") && trimmed.includes("score")) {
          socket.emit("connector_analysis_update", { info: trimmed });
        }
      }
    });

    engineProcess.stderr.on("data", (data) => {
      const msg = data.toString();
      if (msg.includes("Error") || msg.includes("Failed") || msg.includes("cannot open")) {
        console.error(`⚠️ エンジン出力: ${msg}`);
      }
    });

    engineProcess.on("close", (code) => {
      console.log(`⚠️ エンジンが終了しました (Exit Code: ${code})`);
    });
  }
}

async function waitExit() {
  console.log("\n終了するには何かキーを押してください...");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', process.exit.bind(process, 0));
}