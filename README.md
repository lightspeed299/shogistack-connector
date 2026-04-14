# ShogiStack Connector

ShogiStack の研究室解析を、ローカルの USI エンジンで動かすための Connector です。

この Connector はローカル PC 上で USI エンジンを起動し、ShogiStack Web 側へ解析情報を中継します。

## 対応バージョンと互換性

- v3.2.2 は後方互換です。既存設定はそのまま引き継がれます。
- 設定ファイルは AppData に保存されるため、更新時に再設定は不要です。
- ただし、研究室の評価グラフの取り違え修正を有効にするには v3.2.2 以降への更新が必要です。
- 古い Connector でも接続自体はできますが、高速で局面送りしたときの評価グラフ乱れは残る場合があります。

## v3.2.2 の変更点

- 解析更新 payload に局面 SFEN と手番を追加
- 高速再生時でも別局面の遅延解析結果を識別しやすく改善
- 後手評価の符号反転前データがグラフへ混ざる問題の根本修正に対応

## v3.2.1 の変更点

- 開発用 localhost フォールバックを削除
- 本番サーバーへ直接接続する方式へ統一
- 起動時の不要な待ち時間を解消

## 更新方法

1. release から最新版の zip をダウンロードします。
2. 古い Connector フォルダを新しいものと入れ替えます。
3. 設定は引き継がれるので、そのまま exe を起動してください。

## ビルド方法

```powershell
npm install
npm run build
```

出力先:

- dist/shogistack-connector.exe

## 初回セットアップ

起動後、画面の案内に従って以下を設定します。

- ShogiStack Web 画面の API キー
- 使用する USI エンジンの exe パス
- Threads
- fv_scale

## 注意

- エンジン本体と評価関数は、消さない場所に置いてください。
- 更新時は exe だけでなくフォルダごと入れ替えて問題ありません。
- 既存設定が壊れた場合は AppData 内の ShogiStackConnector/config.json を確認してください。