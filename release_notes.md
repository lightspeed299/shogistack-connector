## v4.2.2 Security Update

- **Security: Electron を 41.3.0 に更新**
  - 旧 Electron 30 系に残っていた high severity の脆弱性を解消
  - Connector 単体の `npm audit` で high / critical / moderate / low すべて 0 件を確認
- **Maintenance: リリース定義を package.json に反映**
  - 自動更新で配布されるアプリ表示版も `v4.2.2` に更新

## v4.0.7 Engine Settings Sync

- **New: エンジン設定のConnector→ブラウザ同期**
  - ブラウザ接続時にConnectorが現在のThreads/MultiPV値をブラウザに通知
  - エンジン設定変更後も最新の値をブラウザへ即時反映
  - Connectorが唯一の設定ソースとなり、状態の競合を構造的に排除

## v4.0.6 Bug Fixes

- **Fix: 解析が永続的に「Thinking...」状態になる致命的バグを修正**
  - `set_engine_option` ハンドラで async 関数内の例外が未捕捉だったため、エンジンクラッシュ時に `isChangingOption` フラグが永久に `true` のまま残り、全ての解析リクエストとエンジン設定変更がサイレントに破棄されていた
  - try-catch-finally で確実にフラグをリセットするように修正
  - `reset_engine` ハンドラにも同様の try-catch を追加
- **Fix: エンジンプロセスへの書き込みエラーで例外が発生する問題を修正**
  - `safeWrite()` ヘルパーを導入し、全ての `stdin.write` を安全なラッパー経由に変更
  - 破損パイプへの書き込み時にクラッシュせず、エラーログを出力して継続
- **New: `isChangingOption` 安全タイムアウト（15秒）**
  - 万が一フラグがスタックした場合、15秒後に自動リセットする防御機構を追加
- **New: エンジンクラッシュ時の自動再起動**
  - 異常終了を検出した場合、1秒後に自動再起動を試行（1分間に最大3回まで）
  - エンジン終了時に `isChangingOption` / `isAnalyzing` フラグを強制リセット

## v4.0.5 Bug Fixes

- **Fix: exe にアプリアイコンが埋め込まれていない問題を修正**
  - signAndEditExecutable: false がアイコン埋め込みも無効化していた
  - afterPack フックで rcedit を使い、パッケージング後に手動でアイコンを埋め込む方式に変更
  - タスクバー・ショートカット・Alt+Tab すべてで正しいアイコンが表示される
