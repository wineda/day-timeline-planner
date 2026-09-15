# Day Timeline Planner — 開発ガイド（Claude Code 向け）

Obsidian プラグイン。タスクを日付ノートの Markdown ブロック（見出し + メタ行 + フィールド行 + 本文）として保存する。
利用者の説明は README.md。このファイルは「変更するときに何を揃えるか」を書く。

## 構成

- `app/` … npm プロジェクト本体（`cd app` してから npm を使う）
  - `src/markdown/fields.ts` … **保存形式の正本**。本文フィールド（`- ラベル: 値` の行）の定義一覧。何も import しない
  - `src/markdown/blocks.ts` … ブロック（見出し + メタ行 + フィールド + ステップ + 本文）の解析・書き出し（Obsidian 非依存）
  - `src/markdown/edit.ts` … 追加・更新・削除・並べ替え（ブロック単位の部分置換）
  - `src/model.ts` … ビューが扱う `Task` 型
  - `src/settings.ts` / `src/modal.ts` / `src/view.ts` … 設定・編集ダイアログ・タイムライン
  - `scripts/bump.mjs` … バージョン更新（`npm run bump`）
  - `test/` … vitest。`test/fixtures/*.md` は保存形式の**実例**（README の説明と一致させる）。
    `test/obsidian-stub.ts` は obsidian モジュールの代わり（settings.ts などを読み込むため）
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
npm run bump       # バージョンを上げて manifest / versions.json / dist/ を揃える
```

## 変更の完了条件

コミットする前に、変更の種類ごとに次を揃える。CI が同じことを検証する。

### どの変更でも

- `npm test` と `npm run build` が通る
- README.md（ルート）の該当箇所を直す。README はルートの1本だけが正

### `src/` か `styles.css` を変えたとき（プラグインの動作が変わる）

1. `npm run bump` を実行する（既定は minor。`2.116.0` → `2.117.0`。修正だけなら `npm run bump -- patch`）。
   manifest 3 か所と `versions.json` の更新、ビルド、`app/dist/` へのコピーまで一度に行う
2. コミットメッセージは日本語で、末尾に `(v2.117.0)` を付ける

テスト・ドキュメント・CI だけの変更ではバージョンを上げない（dist も変わらない）。

### 保存形式（フィールド・メタ行・ブロックの構造）に触るとき

利用者のノートと、ノートを読む AI の指示書がこの形式に依存している。次を**同じコミットで**揃える。

1. **フィールドの追加は `src/markdown/fields.ts` に 1 件足す**（key / label / aliases / zone / insertAt / description / example）。
   解析（`parseBlockDocument`）・書き出し（`renderTaskBlock`）・編集（`updateTask`）・`TaskBlock` / `Task` / `TaskPatch` の型は、
   1 行の文字列の値ならこれだけで揃う。リンクや時間帯のような特別な値なら `blocks.ts` の `renderFieldLineOf` と `parseBlockDocument` に分岐を足す
2. 編集ダイアログ（`src/modal.ts`）に欄を足す。設定「タグ別フィールド」から使う欄は**ラベル**で参照する（`test/settings-schema.test.ts` が整合を検証）
3. `test/fixtures/daily-fields.md` に実例を足し、`test/blocks.test.ts` の全フィールドの読み取り・「書き出しの並び」のテストを更新する
4. README.md「保存形式」の一覧を直す
5. 既存ノートとの互換: 旧表記は `aliases` で読めるようにし、書き出しは `label` の表記に統一する（例: `期日:` → `期限:`）

メタ行（時刻・チェック・チケット・リマインド・ブロックID）の形は `blocks.ts` の `parseMetaLine` / `renderMetaLine`。

## 書き方の約束

- コメント・コミットメッセージ・UI 文言は日本語
- ノートの書き換えは**ブロック単位の部分置換**。利用者の本文や並び順を勝手に変えない
- 解析は寛容に（別表記・全角コロン・太字を読む）、書き出しは1つの形に固定する
- モデル名や AI の識別子をコミットやコードに書かない
