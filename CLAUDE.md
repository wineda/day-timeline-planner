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
  - `src/spec.ts` … 保存形式の仕様書（Markdown）の生成。`docs/format.md` と保管庫への書き出しの両方がこれを使う
  - `scripts/bump.mjs` … バージョン更新（`npm run bump`）
  - `scripts/gen-spec.mjs` … 仕様書の生成（`npm run gen:spec`。`--check` で最新かの検証）
  - `test/` … vitest。`test/fixtures/*.md` は保存形式の**実例**（README の説明と一致させる）。
    `test/obsidian-stub.ts` は obsidian モジュールの代わり（settings.ts などを読み込むため）。
    テストの型検査は `tsconfig.test.json`（`npm run typecheck`）
  - `dist/` … リリース成果物（`main.js` / `manifest.json` / `styles.css`）。**コミットする**
- `docs/format.md` … 生成された仕様書（手で直さない）。`docs/ai-instructions-template.md` は保管庫側の指示書の雛形
- `manifest.json`（ルート） … BRAT 用の `app/manifest.json` のコピー
- `.github/workflows/ci.yml` … テスト・ビルド・dist の一致検証（全ブランチ）
- `.github/workflows/release.yml` … master への push で GitHub Release を作る

## コマンド

```bash
cd app
npm ci
npm test           # vitest（保存形式の往復テストなど）
npm run typecheck  # src/ と test/ の型検査（build は src/ だけを検査する）
npm run build      # tsc の型チェック + esbuild → app/main.js
npm run bump       # バージョンを上げて manifest / versions.json / dist/ を揃える
npm run gen:spec   # 保存形式の仕様書（docs/format.md, README の一覧）を fields.ts から生成
```

## 変更の完了条件

コミットする前に、変更の種類ごとに次を揃える。CI が同じことを検証する。

### どの変更でも

- `npm test`、`npm run typecheck`、`npm run build` が通る
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
   （`src/spec.ts` の実例タスクにも足す。`test/spec.test.ts` が全フィールド入りであることを検証する）
4. `npm run gen:spec` を実行して `docs/format.md` と README.md の一覧を生成し直す（手で直さない。CI が最新かを検証）
5. 既存ノートとの互換: 旧表記は `aliases` で読めるようにし、書き出しは `label` の表記に統一する（例: `期日:` → `期限:`）
6. ノートの読み書きの約束が変わったなら `fields.ts` の `FORMAT_VERSION` を上げる（AI の指示書がこの番号で不一致を検知する）

メタ行（時刻・チェック・チケット・リマインド・ブロックID）の形は `blocks.ts` の `parseMetaLine` / `renderMetaLine`。
変えたときは `src/spec.ts` の「メタ行」の説明と README の「メタ行」の箇条書きも直す。

### 仕様書と AI の指示書

- `docs/format.md` … 既定の設定で生成した仕様書（`npm run gen:spec`）。人と AI が読む「ノートの読み方」の正本
- プラグインのコマンド「保存形式の仕様をノートに書き出す（AI 向け）」… 同じ生成器で、保管庫の設定を埋めて `<フォルダ>/_spec/format.md` に書き出す
- `docs/ai-instructions-template.md` … 保管庫側の AI 指示書に置く雛形。フォーマットの説明は指示書に書かず、上のノートを参照させる

## 書き方の約束

- コメント・コミットメッセージ・UI 文言は日本語
- ノートの書き換えは**ブロック単位の部分置換**。利用者の本文や並び順を勝手に変えない
- 解析は寛容に（別表記・全角コロン・太字を読む）、書き出しは1つの形に固定する
- モデル名や AI の識別子をコミットやコードに書かない
