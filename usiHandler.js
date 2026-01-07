// packages/connector/usiHandler.js
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

class UsiHandler {
  constructor(config, onInfoUpdate) {
    this.config = config;
    this.engineProcess = null;
    this.onInfoUpdate = onInfoUpdate; // 解析結果を親に送るコールバック
    this.isReady = false;
    this.buffer = ""; // USI出力のバッファ
    this.lastSendTime = 0;
    this.pendingInfo = null; // 送信待ちの最新情報
  }

  start() {
    const enginePath = path.resolve(this.config.enginePath);
    if (!fs.existsSync(enginePath)) {
      console.error(`❌ エンジンが見つかりません: ${enginePath}`);
      return false;
    }

    console.log(`🚀 エンジン起動: ${enginePath}`);
    this.engineProcess = spawn(enginePath, [], { cwd: path.dirname(enginePath) });

    this.engineProcess.stdout.on('data', (data) => {
      this.handleOutput(data.toString());
    });

    this.engineProcess.stderr.on('data', (data) => {
      console.error(`Engine Error: ${data}`);
    });

    this.sendCommand('usi');
    return true;
  }

  stop() {
    if (this.engineProcess) {
      this.sendCommand('quit');
      this.engineProcess.kill();
      this.engineProcess = null;
      this.isReady = false;
    }
  }

  sendCommand(cmd) {
    if (this.engineProcess) {
      this.engineProcess.stdin.write(cmd + '\n');
    }
  }

  // Webからの命令を受け取る
  go(sfen, timeSettings) {
    if (!this.isReady) return;
    
    this.sendCommand('stop'); // 前の思考を止める
    this.sendCommand(`position sfen ${sfen}`);
    
    // 無制限解析（ユーザーが止めるまで考える）
    this.sendCommand('go infinite');
  }

  handleOutput(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop(); // 最後の不完全な行をバッファに戻す

    for (const line of lines) {
      const trimLine = line.trim();
      if (trimLine === 'usiok') {
        this.isReady = true;
        console.log('✅ エンジン準備完了 (usiok)');
        // オプション設定などをここに書く
        if (this.config.engineOptions) {
             for (const [key, val] of Object.entries(this.config.engineOptions)) {
                 this.sendCommand(`setoption name ${key} value ${val}`);
             }
        }
        this.sendCommand('isready');
      } 
      else if (trimLine === 'readyok') {
        // 準備完了
      } 
      else if (trimLine.startsWith('info') && trimLine.includes('score')) {
        this.parseInfo(trimLine);
      }
    }
  }

  // USIのinfoコマンドをパースして、間引きながら送信
  parseInfo(line) {
    // 簡易パース (正規表現などで必要なデータを抜く)
    // 例: info depth 15 seldepth 22 score cp 88 nodes 12345 pv 7g7f ...
    
    // 間引き処理: 500msに1回だけ送信
    const now = Date.now();
    this.pendingInfo = line; // 最新情報を保持

    if (now - this.lastSendTime > 500) {
      this.onInfoUpdate(this.pendingInfo);
      this.lastSendTime = now;
      this.pendingInfo = null;
    }
  }
}

module.exports = UsiHandler;