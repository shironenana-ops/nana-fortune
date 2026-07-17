# 鑑定エンジンのNode.jsサーバービルド

## 共通エンジン

既存エンジンは`src/lib/shironeEngine.ts`です。free／light／deepの文章生成ロジックはこの1ファイルだけを正本とし、サーバー側へ複製しません。

`src/server/shironeEngineServer.ts`はNode.js用の薄い入口です。既存`runShironeEngine()`を呼ぶだけで、認証、権限、HTTP、履歴、AWS、ログの責務を持ちません。サーバー入力では`today`を必須にし、OS時刻・タイムゾーンへの暗黙依存を防ぎます。

## コマンド

```powershell
npm run build:reading-server
npm run test:reading-server
```

- 対象：Node.js 22以上
- 形式：単一ESM bundle
- 出力：`dist/reading-engine/index.mjs`
- source map：生成しない
- builder：既存依存のesbuild
- Astro runtime：不要

`dist/`は既存`.gitignore`対象で、成果物はGit管理しません。再現可能なソース、fixture、build scriptだけを管理します。

## 依存監査

共通エンジンにimport、乱数、DOM、Storage、Astro、`import.meta.env`依存はありません。`today`省略時だけローカル`new Date()`を使います。ブラウザ互換性維持のため既存関数は変更せず、サーバー入口で`today`を必須化しました。

性別は現在の`ShironeEngineInput`に存在せず、エンジン計算へ使われません。サーバー入口で独自に追加・解釈していません。

## 将来のNode Lambda

将来のLambda handlerはこのbundleの`runShironeEngineOnServer()`へ、サーバーで検証・正規化した入力と日本時間基準の`today`を渡します。認証、会員取得、mode解決、冪等性、履歴保存は外側のadapterで実装します。

今回はLambda handler、API、AWS SDK、DynamoDB、token検証、CORS、権利判定、履歴保存、UI接続を実装していません。

## ロールバック

追加scriptと`src/server`入口を参照しなければ既存ブラウザ経路へ影響しません。問題時はサーバー成果物を削除して直前コミットへ戻し、`/result`の既存free経路を維持します。
