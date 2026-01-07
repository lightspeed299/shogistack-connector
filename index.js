const io = require("socket.io-client");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const readline = require("readline");

// 設定ファイルのパス
const CONFIG_PATH = path.join(process.cwd(), "config.json");

// デフォルト設定
const DEFAULT_OPTIONS = {
  "USI_Hash": 1024,
  "Threads": 4,
  "MultiPV": 5
};

// --- メイン処理 ---
(async () => {
  console.log("==========================================");
  console.log("   ShogiStack Connector (v1.0)");
  console.log("==========================================");

  // 1. 設定ファイルの確認と作成
  let config;
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    } else {
      console.log("\n⚠️ 設定ファイル(config.json)が見つかりません。");
      console.log("🔰 初回セットアップを開始します。\n");
      config = await runSetupWizard();
    }
  } catch (err) {
    console.error("❌ 設定ファイルの読み込みに失敗しました:", err.message);
    console.log("config.json を削除して再起動すると直るかもしれません。");
    await waitExit();
    return;
  }

  // 2. サーバー接続開始
  startConnection(config);
})();

// --- 対話型セットアップウィザード ---
function runSetupWizard() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const ask = (question) => new Promise(resolve => rl.question(question, resolve));

  return new Promise(async (resolve) => {
    try {
      // APIキーの入力
      let apiKey = "";
      while (!apiKey) {
        apiKey = await ask("【Q1】Web画面の「APIキー」を貼り付けてEnterキーを押してください:\n> ");
        apiKey = apiKey.trim();
      }

      // エンジンパスの入力
      let enginePath = "";
      while (!enginePath) {
        console.log("\n【Q2】使いたい将棋エンジン(.exe)を、この画面にドラッグ＆ドロップしてEnterを押してください:");
        let input = await ask("> ");
        
        // ドラッグ＆ドロップで入る引用符(")を削除
        input = input.trim().replace(/^"|"$/g, '');
        
        if (fs.existsSync(input) && input.endsWith(".exe")) {
          enginePath = input.replace(/\\/g, "/"); // Windowsのパス区切りを修正
        } else {
          console.log("❌ エラー: 正しいexeファイルではないか、ファイルが見つかりません。");
        }
      }

      // 設定オブジェクト作成
      const newConfig = {
        enginePath: enginePath,
        apiKey: apiKey,
        engineOptions: DEFAULT_OPTIONS
      };

      // ファイルに保存
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(newConfig, null, 2));
      console.log("\n✅ 設定を 'config.json' に保存しました！");
      console.log("次回からは自動的に接続されます。\n");

      rl.close();
      resolve(newConfig);

    } catch (e) {
      console.error("セットアップエラー:", e);
      rl.close();
      process.exit(1);
    }
  });
}

// --- 接続とエンジンの処理 (以前と同じロジック) ---
function startConnection(config) {
  // config.jsonにURLが書いてあればそれを使い、なければハードコードしたURLを使う
  // ★重要: 下の "https://..." の部分は、手順1でコピーしたあなたのサーバーURLに書き換えてください！
  const SERVER_URL = config.serverUrl || "https://shogistack-server.onrender.com"; 

  console.log(`🔌 サーバー(${SERVER_URL})に接続中...`);

  const socket = io(SERVER_URL, {
    auth: {
      type: 'connector',
      token: config.apiKey
    }
  });

  let engineProcess = null;

  socket.on("connect", () => {
    console.log(`✅ 接続成功! (ID: ${socket.id})`);
    console.log("Web画面で解析を開始してください。");
    startEngine();
  });

  socket.on("connect_error", (err) => {
    console.error(`❌ 接続エラー: ${err.message}`);
    console.log("5秒後に再接続します...");
    setTimeout(() => socket.connect(), 5000);
  });

  socket.on("disconnect", () => {
    console.log("⚠️ サーバーから切断されました");
  });

  // 解析リクエスト
  socket.on("request_analysis", (data) => {
    const sfen = data.sfen;
    if (!engineProcess || !sfen) return;
    console.log(`🔍 解析開始: ${sfen.substring(0, 20)}...`);
    engineProcess.stdin.write("stop\n"); 
    engineProcess.stdin.write(`position sfen ${sfen}\n`);
    engineProcess.stdin.write("go infinite\n");
  });

  socket.on("stop_analysis", () => {
    if (engineProcess) {
      console.log("⏹ 解析停止");
      engineProcess.stdin.write("stop\n");
    }
  });

  // エンジン起動関数
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
        if (trimmed.startsWith("info") && trimmed.includes("score")) {
          socket.emit("connector_analysis_update", { info: trimmed });
        }
      }
    });
// ★修正: エンジンのエラーログを表示するように変更
    engineProcess.stderr.on("data", (data) => {
      const msg = data.toString();
      // 余計なログは無視しつつ、エラーっぽいやつだけ表示
      if (msg.includes("Error") || msg.includes("Failed") || msg.includes("cannot open")) {
        console.error(`⚠️ エンジンエラー: ${msg}`);
      }
    });

    // ★追加: エンジンが勝手に終了した場合のログ
    engineProcess.on("close", (code) => {
      console.log(`⚠️ エンジンが終了しました (Exit Code: ${code})`);
      console.log("  -> 評価関数ファイル(nn.eval)は入っていますか？");
      console.log("  -> PCのCPUに対応したexeですか？");
    });
  }
}

// エラー時にウィンドウがすぐ閉じないようにする
async function waitExit() {
  console.log("\n終了するには何かキーを押してください...");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', process.exit.bind(process, 0));
}