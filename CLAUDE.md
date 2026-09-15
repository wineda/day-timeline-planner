# Day Timeline Planner — 開発ガイド（Claude Code 向け）

Obsidian プラグイン。タスクを日付ノートの Markdown ブロック（見出し + メタ行 + フィールド行 + 本文）として保存する。
利用者の説明は README.md。このファイルは「変更するときに何を揃えるか」を書く。

## 構成

- `app/` … npm プロジェクト本体（`cd app` してから npm を使う）
  - `src/markdown/blocks.ts` … **保存形式の正本**。フィールドの解析・書き出しはここだけに置く（Obsidian 非依存）
  - `src/markdown/edit.ts` … 追加・更新・削除・並べ替え（ブロック単位の部分置換）
  - `src/model.ts` … ビューが扱う `Task` 型
  - `src/settings.ts` / `src/modal.ts` / `src/view.ts` … 設定・編集ダイアログ・タイムライン
  - `test/` … vitest。`test/fixtures/*.md` は保存形式の**実例**（README の説明と一致させる）
  - `dist/` … リリース成果物（`main.js` / `manifest.json` / `styles.css`）。**コミットする**
- `manifest.json`（ルート） … BRAT 用の `app/manifest.json` のコピー
- `.github/workflows/ci.yml` … テスト・ビルド・dist の一致検証（全ブランチ）
- `.github/workflows/release.yml` … master への push で GitHub Release を作る

## コマンド

```bash
cd app
npm ci
npm test           # vitest（保存形式の往復テストなど）
npm run build      # tsc の型チェック + esbuild → app/main.js
```

## 変更の完了条件

コミットする前に、変更の種類ごとに次を揃える。CI が同じことを検証する。

### どの変更でも

- `npm test` と `npm run build` が通る
- README.md（ルート）の該当箇所を直す。README はルートの1本だけが正

### `src/` か `styles.css` を変えたとき（プラグインの動作が変わる）

1. `app/manifest.json` の `version` を上げる（機能追加・修正は minor。`2.116.0` → `2.117.0`）
2. `app/versions.json` に新バージョンの行を足す（`"2.117.0": "1.5.0"`）
3. ルートの `manifest.json` を `app/manifest.json` と同じにする
4. `npm run build` して `app/main.js` を `app/dist/main.js` へコピー。`app/styles.css` と `app/manifest.json` も `app/dist/` へコピー
5. コミットメッセージは日本語で、末尾に `(v2.117.0)` を付ける

テスト・ドキュメント・CI だけの変更ではバージョンを上げない（dist も変わらない）。

### 保存形式（フィールド・メタ行・ブロックの構造）に触るとき

利用者のノートと、ノートを読む AI の指示書がこの形式に依存している。次を**同じコミットで**揃える。

1. `src/markdown/blocks.ts` の解析・書き出し（新しいフィールドは既存の `parseXxxLine` / `renderXxxLine` の対と同じ形で）
2. `src/markdown/edit.ts` の `TaskPatch` / `NewTaskInput` / `updateTask`
3. `src/model.ts` の `Task` と `src/store.ts` の変換
4. `test/fixtures/daily-fields.md` に実例を足し、`test/blocks.test.ts` の全フィールド・往復テストに加える
5. README.md「保存形式」の一覧
6. 既存ノートとの互換: 旧表記を読めるようにし、書き出しは新表記に統一する（例: `期日:` → `期限:`）

## 書き方の約束

- コメント・コミットメッセージ・UI 文言は日本語
- ノートの書き換えは**ブロック単位の部分置換**。利用者の本文や並び順を勝手に変えない
- 解析は寛容に（別表記・全角コロン・太字を読む）、書き出しは1つの形に固定する
- モデル名や AI の識別子をコミットやコードに書かない
