# ShogiStack Connector

お手持ちのPCの将棋エンジン（USI対応）を ShogiStack に接続し、ブラウザ上でリアルタイムAI解析を行うためのデスクトップアプリです。

## ダウンロード

[最新版をダウンロード](https://github.com/lightspeed299/shogistack-connector/releases/latest) — Windows専用

## 機能

- **GUIセットアップ** — APIキー入力・エンジン選択をウィザード形式で案内
- **ファイル選択ダイアログ** — ネイティブのファイル選択でエンジンを指定
- **自動アップデート** — 新バージョンをアプリ内からワンクリックでインストール
- **設定画面** — スレッド数・Hash・MultiPV・FV_SCALE をGUI上で変更可能

## セットアップ手順

1. **インストーラーをダウンロード** — [Releases](https://github.com/lightspeed299/shogistack-connector/releases) から最新版を取得
2. **初回セットアップ** — 初めて起動するとウィザードが表示されます
   - ShogiStack で発行した API キーを貼り付け
   - エンジンの実行ファイル（.exe）を「選択」ボタンで指定
   - スレッド数等を設定
3. **接続完了** — セットアップ後、自動的にサーバーへ接続されます

## 開発

```bash
# 依存関係インストール
npm install

# 開発起動
npm start

# インストーラービルド (Windows)
npm run build
```

## 設定ファイルの場所

- Windows: `%APPDATA%\shogistack-connector\config.json`

設定を最初からやり直すには、上記ファイルを削除してアプリを再起動してください。

## 注意事項

- 本ソフトにはエンジン本体や評価関数は含まれていません。各開発者のライセンスに従い、ご自身で導入してください。
- 本ソフトの使用により生じたいかなる損害についても、開発者は一切の責任を負いません。

## ライセンス

All rights reserved. 無断転載・再配布を禁じます。