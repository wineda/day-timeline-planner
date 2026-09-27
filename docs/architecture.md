# プラグインの構成図

Day Timeline Planner（`app/src/`）の構成を図で示す。各ファイルの役割の一覧は README の「ソースからビルドする」、
変更するときの約束は `CLAUDE.md` にある。この文書は「どこに何があり、何が何を使うか」を一目で掴むためのもので、
図の根拠は各ファイルの `import`。ファイルを足したり依存の向きを変えたときは、この文書も直す。

図は Mermaid で書いてある（GitHub と Obsidian がそのまま描画する）。

## 1. 全体像

Obsidian の上に、入口（`main.ts`）・画面・ノートの読み書き・Obsidian に依存しない処理の 4 段が乗る。
下の段ほど Obsidian から遠く、`markdown/` と `model.ts` などは Obsidian 無しでそのままテストできる。

```mermaid
flowchart TB
  User(["利用者"])

  subgraph plugin["Day Timeline Planner（app/src）"]
    direction TB
    Main["main.ts — DayTimelinePlugin<br/>ビュー・コマンド・設定タブ・リボンを登録し、ストアを生成して持つ"]

    subgraph ui["画面（Obsidian の ItemView / Modal / PluginSettingTab）"]
      View["view.ts + view-*.ts<br/>タイムラインビュー"]
      RecView["recurring-view.ts<br/>定期タスクの管理画面"]
      Modal["modal.ts<br/>追加・編集などのダイアログ"]
      SettingsTab["settings.ts<br/>設定の型と設定画面"]
    end

    subgraph domain["ノートの読み書き（Obsidian の Vault を使う）"]
      Store["store.ts<br/>BlockTaskStore / InboxStore / MemberStore"]
      Project["project.ts<br/>ProjectStore"]
      Recurring["recurring.ts<br/>定期タスクをその日のノートへ反映"]
      Notify["notify.ts<br/>ReminderService（開始 N 分前の通知）"]
    end

    subgraph pure["Obsidian に依存しない処理（vitest でそのままテストできる）"]
      MD["markdown/<br/>保存形式の解析・書き出し・部分置換"]
      Model["model.ts<br/>Task 型"]
      Report["report.ts<br/>日報・予実レポート"]
      Spec["spec.ts<br/>保存形式の仕様書の生成"]
      Layout["layout.ts<br/>重なったタスクの横並び"]
    end
  end

  subgraph obs["Obsidian の保管庫"]
    Notes[("ノート<br/>日付ノート・Inbox・メンバー・プロジェクト")]
    DataJson[("data.json<br/>設定・定期タスクのルールと帳簿")]
  end

  User --> ui
  Main -->|登録| ui
  Main -->|生成して持つ| domain
  ui -->|plugin.store などを通して呼ぶ| domain
  ui -->|Task 型・重なりの計算| pure
  domain -->|解析・書き出し| pure
  domain <-->|read / modify| Notes
  Main <-->|loadData / saveData| DataJson
```

## 2. モジュール間の依存（import の向き）

矢印は「使う → 使われる」。図を読めるように、次の矢印は省いてある（正確な一覧はすぐ下の表）。

- `util.ts` / `icons.ts` / `dropdown.ts`（どこからでも使う小道具）への矢印
- `settings.ts`（設定の型）・`model.ts`（Task 型）・`markdown/`（ブロックの解析）への矢印のうち、型や解析だけを借りているもの。
  `markdown/` への矢印は、保存形式を直接読み書きするものだけ残した

`view` / `recurring-view` / `settings` / `recurring` / `notify` は `main.ts` を `import type` で参照している（`plugin` の型を受け取るため）。
型だけの参照で実行時の循環は無いので、図には描かず表に「main（型）」と書いた。

```mermaid
flowchart TB
  main["main.ts"]

  subgraph ui["画面"]
    view["view.ts<br/>+ view-sidebar / view-pointer<br/>/ view-actions / view-shared"]
    recview["recurring-view.ts"]
    modal["modal.ts"]
    settings["settings.ts"]
  end

  subgraph domain["ノートの読み書き"]
    store["store.ts"]
    project["project.ts"]
    recurring["recurring.ts"]
    notify["notify.ts"]
  end

  subgraph pure["Obsidian 非依存"]
    model["model.ts"]
    markdown["markdown/"]
    report["report.ts"]
    spec["spec.ts"]
    layout["layout.ts"]
  end

  main --> view & recview & modal & settings
  main --> store & project & recurring & notify
  main --> report & spec

  view --> modal & layout
  view --> store & project & recurring
  recview --> modal & recurring
  modal --> project
  settings --> notify & project & recurring
  recurring --> modal & project

  store --> markdown
  project --> markdown
  spec --> markdown
  model --> markdown
  report --> model
```

読み方のポイント:

- **`main.ts` だけが全部を知っている。** ビュー・ダイアログ・ストアはお互いを直接 new せず、`plugin.store` / `plugin.projects` のように本体経由で辿る
- **`markdown/` と `model.ts` は下向きにしか依存しない。** 保存形式の変更はここで完結し、上の層は `Task` 型を通して結果を受け取る
- **`settings.ts` は型と既定値の置き場でもある。** ストアやプロジェクトが `settings` を参照するのは、フォルダ名や日付形式など設定値を読むため

ファイルごとの import の一覧（`obsidian` / `util` / `icons` / `dropdown` は除く。「型」は `import type` だけ）:

| ファイル | 使うもの |
| --- | --- |
| `main.ts` | view, recurring-view, modal, settings, store, project, recurring, notify, report, spec, model, markdown/blocks, markdown/id |
| `view.ts` | view-sidebar, view-pointer, view-actions, view-shared, layout, store, project, recurring, settings, model, main（型） |
| `view-sidebar.ts` | view-shared, modal, store, project, settings, model, markdown/blocks, view（型） |
| `view-pointer.ts` | view-shared, settings, model, view（型） |
| `view-actions.ts` | view-shared, modal, store, project, recurring, model, markdown/blocks, markdown/id, view（型） |
| `view-shared.ts` | settings, model, markdown/blocks |
| `recurring-view.ts` | modal, recurring, settings, main（型） |
| `modal.ts` | project, settings, model, markdown/blocks |
| `settings.ts` | notify, project, recurring, main（型） |
| `store.ts` | settings, model, markdown/blocks, markdown/edit, markdown/fields, markdown/legacy, markdown/migrate |
| `project.ts` | settings, model, markdown/blocks, markdown/id |
| `recurring.ts` | modal, project, settings, model, markdown/blocks, markdown/id, main（型） |
| `notify.ts` | model, main（型） |
| `report.ts` | model |
| `spec.ts` | markdown/blocks, markdown/fields, markdown/id |
| `model.ts` | markdown/blocks, markdown/fields |
| `layout.ts` / `util.ts` / `markdown/fields.ts` / `markdown/id.ts` | （何も import しない） |
| `markdown/` の残り | 図 3 |

## 3. 保存形式層（markdown/）

`fields.ts` が正本。ブロック（見出し + メタ行 + フィールド行 + 本文）の解析と書き出しは `blocks.ts`、
ノートの書き換えは `edit.ts` が「全文を解析し直す → ブロック ID で対象を見つける → その行範囲だけ差し替える」手順で行う。
`legacy.ts` / `migrate.ts` は 1.x のリスト形式を変換するためだけに残っている。

```mermaid
flowchart BT
  fields["fields.ts<br/>フィールド定義（保存形式の正本）<br/>何も import しない"]
  id["id.ts<br/>ブロック ID ^dtp-xxxx の生成・抽出"]
  blocks["blocks.ts<br/>parseBlockDocument（解析）<br/>renderTaskBlock（書き出し）"]
  edit["edit.ts<br/>insertTask / updateTask / removeTask / sortTasksByTime<br/>ブロック単位の部分置換"]
  legacy["legacy.ts<br/>旧リスト形式（1.x）の読み取り"]
  migrate["migrate.ts<br/>旧形式 → ブロック形式"]

  blocks --> fields & id
  edit --> blocks & fields & id
  legacy --> blocks
  migrate --> blocks & edit & id & legacy

  store["store.ts（上の層）"] --> blocks & edit & fields & legacy & migrate
  model["model.ts"] --> blocks & fields
  spec["spec.ts"] --> blocks & fields & id
```

## 4. タイムラインビューの合成（ミックスイン）

`view.ts` の `DayTimelineView` は 1 つのクラスだが、責務ごとに 3 つのファイルへ分け、末尾で `applyMixins` により合成している。
各ミックスインの中では `this` がビュー自身。ビューのファイル同士は互いに import せず、共有する型・定数は `view-shared.ts` に置く。

```mermaid
flowchart LR
  shared["view-shared.ts<br/>共有する型・定数・小さなヘルパー"]
  sidebar["view-sidebar.ts — SidebarMixin<br/>左サイドバー: Inbox・時刻なしの一覧、<br/>プロジェクトのツリー、本日のサマリー"]
  pointer["view-pointer.ts — PointerMixin<br/>ドラッグ・長押し・横スワイプ・<br/>ホイール / ピンチのズーム・空き時間からの作成"]
  actions["view-actions.ts — ActionsMixin<br/>追加・編集・完了・削除・移動・持ち越し・<br/>Inbox との往復・右クリックメニュー"]
  view["view.ts — DayTimelineView extends ItemView<br/>グリッド・ヘッダー・日の読み込み・<br/>バーの描画・現在線・エディタ連動"]

  sidebar -->|applyMixins| view
  pointer -->|applyMixins| view
  actions -->|applyMixins| view
  view --> shared
  sidebar --> shared
  pointer --> shared
  actions --> shared
```

## 5. タスクを書き換えるときの流れ

ノートへの書き込みはビューでは `view-actions.ts` を通り、ストアが `edit.ts` でブロック単位に差し替える。
ビューは行番号を覚えず、Vault の `modify` イベントを受けて読み直すので、利用者がノートを直接編集していても壊れない。

```mermaid
sequenceDiagram
  actor U as 利用者
  participant V as DayTimelineView<br/>(view-actions.ts)
  participant M as TaskModal<br/>(modal.ts)
  participant S as BlockTaskStore<br/>(store.ts)
  participant E as edit.ts / blocks.ts
  participant N as 日付ノート（Vault）

  U->>V: バーを開く（編集）
  V->>M: ダイアログを開く
  M-->>V: TaskDraft（入力結果）
  V->>S: update(date, task, draft)
  S->>N: vault.read()
  N-->>S: ノート全文
  S->>E: parseBlockDocument → ブロック ID で対象を特定<br/>→ updateTask でその行範囲だけ差し替え
  E-->>S: 新しい全文
  S->>N: vault.modify()
  N-->>V: modify イベント
  V->>S: load(date)
  S-->>V: DayTasks（Task の一覧）
  V->>V: 再描画（layout.ts で重なりを横に並べる）
```

定期タスクは、ビューがその日を表示するときに `recurring.ts` の `applyRecurring` を呼び、
まだ入っていない発生日のタスクを同じストア経由でノートに書く。反映の帳簿（どの日に入れたか・取り消し・個別調整）は
ノートではなく設定（`data.json`）側に持つ。

## 6. データの置き場

| 持ち主 | 置き場（既定） | 中身 |
| --- | --- | --- |
| `BlockTaskStore`（store.ts） | `Timeline/YYYY-MM-DD.md`（フォルダ・日付形式は設定） | その日のタスクブロック |
| `InboxStore`（store.ts） | `Timeline/Inbox.md` | 日付を決めていないタスク |
| `MemberStore`（store.ts） | `Timeline/Members/<名前>/YYYY-MM-DD.md`（メンバーごとに変更可） | 他の人の予定 |
| `ProjectStore`（project.ts） | `Timeline/Projects/`（設定で変更可） | プロジェクトノート（1 プロジェクト = 1 ノート） |
| 削除ログ（store.ts） | `Timeline/Log.md` | 削除したタスクの記録 |
| `DayTimelinePlugin`（main.ts） | `.obsidian/plugins/<プラグイン>/data.json` | 設定、メンバー、定期タスクのルールと発生日ごとの帳簿 |
| 仕様書の書き出し（spec.ts） | `Timeline/_spec/format.md` | 保管庫の設定を埋めた保存形式の仕様（AI 向け） |

## 7. ビルド・生成物・リリース

ソースからは 2 系統の生成物ができる。プラグイン本体（`main.js` → `dist/`）と、保存形式の仕様書（`docs/format.md` と README の一覧）。
どちらも CI が「ソースと一致しているか」を検証する。

```mermaid
flowchart LR
  subgraph src["app/src と styles.css"]
    ts["*.ts（入口は main.ts）"]
    css["styles.css"]
    fields["markdown/fields.ts"]
    spec["spec.ts"]
  end

  subgraph build["プラグイン本体"]
    tsc["npm run build<br/>tsc で型検査 → esbuild で束ねる"]
    mainjs["app/main.js"]
    bump["npm run bump<br/>scripts/bump.mjs"]
    manifest["app/manifest.json<br/>manifest.json（ルート）<br/>versions.json"]
    dist["app/dist/<br/>main.js / manifest.json / styles.css<br/>（コミットする）"]
  end

  subgraph docs["保存形式の仕様書"]
    genspec["npm run gen:spec<br/>scripts/gen-spec.mjs"]
    format["docs/format.md"]
    readme["README.md のフィールド一覧"]
    cmd["コマンド<br/>「保存形式の仕様をノートに書き出す」"]
    vaultspec["保管庫の _spec/format.md"]
  end

  subgraph release["配布"]
    rel["release.yml<br/>master への push で起動"]
    gh["GitHub Release<br/>dist の 3 ファイルを添付"]
    brat["BRAT → 各端末の Obsidian"]
  end

  ts --> tsc --> mainjs --> bump
  css --> bump
  bump --> manifest
  bump --> dist
  dist --> rel
  manifest --> rel
  rel --> gh --> brat

  fields --> spec
  spec --> genspec
  genspec --> format
  genspec --> readme
  spec --> cmd --> vaultspec

  ci["ci.yml（全ブランチ）<br/>npm test / typecheck / build<br/>gen:spec --check / dist の一致"]
  ci -.->|検証| dist
  ci -.->|検証| format
  ci -.->|検証| readme
```

## 8. テストの対応

`app/test/` は vitest。`obsidian-stub.ts` が `obsidian` モジュールの代わりになり、`fake-vault.ts` が Vault を模す。
`fixtures/*.md` は保存形式の実例で、README の説明と一致させる。

| テスト | 対象 |
| --- | --- |
| `blocks.test.ts` / `fields.test.ts` | `markdown/blocks` `markdown/fields`（解析と書き出しの往復、全フィールドの読み取り） |
| `edit.test.ts` | `markdown/edit`（ブロック単位の部分置換） |
| `migrate.test.ts` | `markdown/migrate`（旧形式からの変換） |
| `spec.test.ts` | `spec`（仕様書が全フィールドを含むこと） |
| `store.test.ts` / `project.test.ts` | `store` `project`（fake-vault 上での読み書き） |
| `recurring.test.ts` | `recurring`（発生日の反映・取り消し・個別調整） |
| `settings.test.ts` | `settings`（設定の版の移行） |
| `view-mixins.test.ts` / `view-shared.test.ts` | `view` の合成、`view-shared` のヘルパー |
