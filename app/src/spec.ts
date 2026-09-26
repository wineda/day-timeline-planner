/**
 * 保存形式の仕様書（Markdown）の生成。
 *
 * fields.ts の定義と blocks.ts の書き出しから、人と AI が読むための「ノートの読み方」を組み立てる。
 * 出力先は 2 つで、どちらも同じ関数から生成する（手で書いた写しを持たない）:
 *   - リポジトリの docs/format.md と README の一覧（scripts/gen-spec.mjs）
 *   - 保管庫の <フォルダ>/_spec/format.md（プラグインのコマンド「保存形式の仕様をノートに書き出す」）
 *
 * Obsidian の API に依存しない（そのままテストできる）。
 */
import {
  renderMetaLine,
  renderTaskBlock,
  type BlockOptions,
  type MetaSource,
  parseActualValue,
  parseLinkValue,
} from "./markdown/blocks";
import { FIELDS, FORMAT_VERSION, HEAD_FIELDS, RECORD_FIELDS, STATUS_KINDS, type AnyField } from "./markdown/fields";
import { ID_PREFIX } from "./markdown/id";

/** 仕様書に埋める、保管庫ごとの設定 */
export interface SpecContext {
  /** プラグインのバージョン（manifest.json） */
  pluginVersion: string;
  /** 日付ノートのフォルダ（設定「フォルダ」） */
  folder: string;
  /** ファイル名の日付形式（設定「日付形式」） */
  dateFormat: string;
  /** タスクとみなす見出しレベル（親見出しとの繰り下げを済ませた値） */
  headingLevel: number;
  /** タスクを置く親見出し（"" ならファイル直下） */
  rootHeading: string;
  /** "- [ ] " のチェックボックス形式で書き込むか（設定「チェックボックス形式で保存」） */
  useCheckbox: boolean;
  /** メタ行にもタイトルを書くか（設定「メタ行にタイトルを書く」） */
  mirrorTitle: boolean;
  /** Inbox のノート（拡張子なし） */
  inboxPath: string;
  /** プロジェクトノートのフォルダ（"" なら <フォルダ>/Projects） */
  projectsFolder: string;
  /** 日報ノート（AI などが書く）のフォルダ */
  dailyReportFolder: string;
  /** チケット管理ツールの名前（設定「チケット管理ツール」。先頭が既定） */
  trackers: string[];
  /** メンバー（設定「メンバー」）。folder はその人のノートのフォルダ（設定で変えていなければ <フォルダ>/Members/<名前>） */
  members: { name: string; folder: string }[];
  /** タスクを削除したとき <フォルダ>/Log.md に記録を残すか（設定「削除したタスクの記録を残す」） */
  deletionLog: boolean;
  /** 生成日時（"" なら書かない。リポジトリの docs は差分を安定させるため書かない） */
  generatedAt: string;
}

/** 既定の設定での仕様書（リポジトリの docs/format.md 用） */
export function defaultSpecContext(pluginVersion: string): SpecContext {
  return {
    pluginVersion,
    folder: "Timeline",
    dateFormat: "YYYY-MM-DD",
    headingLevel: 2,
    rootHeading: "",
    useCheckbox: true,
    mirrorTitle: false,
    inboxPath: "Timeline/Inbox",
    projectsFolder: "",
    dailyReportFolder: "daily",
    trackers: [],
    members: [],
    deletionLog: true,
    generatedAt: "",
  };
}

/** プロジェクトノートのフォルダ（設定が空なら <フォルダ>/Projects） */
export function projectsFolderOf(ctx: Pick<SpecContext, "folder" | "projectsFolder">): string {
  return ctx.projectsFolder.trim().replace(/\/+$/, "") || `${ctx.folder.replace(/\/+$/, "")}/Projects`;
}

/** 仕様書の実例に使う書き出し設定（既定の設定と同じ。テストと README 用） */
export const EXAMPLE_OPTIONS: BlockOptions = {
  headingLevel: 2,
  rootHeading: "",
  useCheckbox: true,
  mirrorTitle: false,
};

/** 仕様書の設定から、実例を書き出すときのブロック設定を組む */
export function exampleOptionsOf(ctx: SpecContext): BlockOptions {
  return {
    headingLevel: ctx.headingLevel,
    rootHeading: ctx.rootHeading,
    useCheckbox: ctx.useCheckbox,
    mirrorTitle: ctx.mirrorTitle,
  };
}

/**
 * 仕様書の実例タスク（全フィールド入り。持ち越しは別の実例で出す）。
 * プロジェクトのリンクはプロジェクトノートのパスそのものなので、フォルダは保管庫の設定で変わる
 */
export function exampleTaskSource(tracker = "redmine", projectsFolder = "Timeline/Projects"): MetaSource & { body: string[] } {
  const ex = (key: string) => (FIELDS.find((f) => f.key === key) as AnyField).example;
  return {
    id: `${ID_PREFIX}k3f9a2`,
    title: "誤検知の調査 #障害",
    start: 10 * 60,
    end: 11 * 60,
    done: true,
    note: "",
    reminder: 10,
    ticket: { tracker, id: "65130" },
    project: `${projectsFolder}/${parseLinkValue(ex("project")).split("/").pop()}`,
    actual: parseActualValue(ex("actual")),
    registered: ex("registered"),
    due: ex("due"),
    doneCondition: ex("doneCondition"),
    steps: [
      { text: "ログを集める", done: true, children: [] },
      { text: "再現手順を書く", done: false, children: ["    補足: 手順は Runbook にも転記"] },
    ],
    result: ex("result"),
    cause: ex("cause"),
    judgment: ex("judgment"),
    remaining: ex("remaining"),
    others: [ex("others"), "佐藤 / 影響範囲の確認"],
    answer: ex("answer"),
    status: ex("status"),
    ownerName: ex("ownerName"),
    nextAction: ex("nextAction"),
    retrospective: ex("retrospective"),
    body: ["詳細のメモ。ここは自由な Markdown で、プラグインは触らない。", "- 箇条書きも書ける"],
  };
}

/**
 * 持ち越しの実例（元のブロックと続きのブロック）。
 * 持ち越しのリンクは日付ノートのパスから作るので、フォルダは保管庫の設定で変わる
 */
export function exampleCarrySources(folder = "Timeline"): { from: MetaSource; to: MetaSource } {
  // 定義の実例（Timeline/… の形）のフォルダ部分を、この保管庫のフォルダに差し替える
  const ex = (key: string) => {
    const link = parseLinkValue((FIELDS.find((f) => f.key === key) as AnyField).example);
    return `${folder}/${link.split("/").pop()}`;
  };
  return {
    from: {
      id: `${ID_PREFIX}9b2c44`,
      title: "設計レビューの準備 #開発/設計",
      start: 10 * 60 + 30,
      end: 12 * 60,
      done: false,
      checkChar: ">",
      note: "",
      carryTo: ex("carryTo"),
      steps: [
        { text: "資料の骨子", done: true, children: [] },
        { text: "図を描く", done: false, children: [] },
      ],
    },
    to: {
      id: `${ID_PREFIX}c0ffee`,
      title: "設計レビューの準備 #開発/設計",
      start: null,
      end: null,
      done: false,
      note: "",
      carryFrom: ex("carryFrom"),
      steps: [{ text: "図を描く", done: false, children: [] }],
    },
  };
}

function zoneLabel(f: AnyField): string {
  return f.zone === "head" ? "メタ行の直下" : "ステップの後ろ";
}

function valueLabel(f: AnyField): string {
  if (f.kind === "link") return "Wikilink";
  if (f.kind === "actual") return "時刻範囲（`/` 区切りで複数）";
  if ("values" in f && f.values) return f.values.join(" / ") + (f.key === "status" ? "（中断は `中断(理由)`）" : "");
  if ("multi" in f && f.multi) return "文字列（複数行可）";
  if (f.key === "due" || f.key === "registered") return "日付（YYYY-MM-DD）";
  return "文字列";
}

/** README 用: フィールドの箇条書き（`- **ラベル** = …`） */
export function renderFieldList(): string {
  const lines: string[] = [];
  for (const f of FIELDS) {
    const alias = f.aliases.length ? `（\`${f.aliases.join("` `")}\` も可）` : "";
    const values = "values" in f && f.values ? `値は ${f.values.map((v) => `\`${v}\``).join(" / ")}。` : "";
    lines.push(`- **${f.label}** = 本文中の \`- ${f.label}: ${f.example}\` 行${alias}。${values}${f.description}`);
  }
  return lines.join("\n");
}

/**
 * フィールドの実例。リンク系（プロジェクト・持ち越し）はノートのパスなので、
 * ctx があれば保管庫のフォルダ設定に合わせた形にする
 */
export function fieldExample(f: AnyField, ctx?: Pick<SpecContext, "folder" | "projectsFolder">): string {
  if (!ctx || f.kind !== "link") return f.example;
  const name = parseLinkValue(f.example).split("/").pop();
  const dir = f.key === "project" ? projectsFolderOf(ctx) : ctx.folder.replace(/\/+$/, "");
  return `[[${dir}/${name}]]`;
}

/** 仕様書用: フィールドの表 */
export function renderFieldTable(ctx?: Pick<SpecContext, "folder" | "projectsFolder">): string {
  const rows = [
    "| ラベル | 位置 | 値 | 説明 | 実例 | 別表記 | 記録タブ |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const f of FIELDS) {
    const multi = "multi" in f && f.multi ? "（複数行可）" : "";
    rows.push(
      `| \`${f.label}\`${multi} | ${zoneLabel(f)} | ${valueLabel(f)} | ${f.description.replace(/\|/g, "\\|")} | \`${fieldExample(f, ctx)}\` | ${
        f.aliases.map((a) => `\`${a}\``).join(" ") || "—"
      } | ${f.aiReads ? "○" : "—"} |`
    );
  }
  return rows.join("\n");
}

function code(lines: string[]): string {
  return ["```markdown", ...lines, "```"].join("\n");
}

/** 仕様書の全文（Markdown） */
export function renderFormatSpec(ctx: SpecContext): string {
  const folder = ctx.folder.replace(/\/+$/, "") || "（保管庫直下）";
  const projects = projectsFolderOf(ctx);
  const heading = "#".repeat(ctx.headingLevel);
  const root = ctx.rootHeading.trim();
  const tracker = ctx.trackers[0] ?? "redmine";
  const opts = exampleOptionsOf(ctx);
  const exampleSource = exampleTaskSource(tracker, projects);
  const example = renderTaskBlock(exampleSource, opts);
  const exampleMeta = renderMetaLine(exampleSource, opts);
  const carry = exampleCarrySources(folder);

  const out: string[] = [];
  out.push("---");
  out.push(`format_version: "${FORMAT_VERSION}"`);
  out.push(`plugin_version: "${ctx.pluginVersion}"`);
  out.push("generated_by: Day Timeline Planner");
  if (ctx.generatedAt) out.push(`generated_at: ${ctx.generatedAt}`);
  out.push("---");
  out.push("");
  out.push("# タスクノートの保存形式");
  out.push("");
  out.push(
    "Day Timeline Planner（Obsidian プラグイン）がタスクを保存するときのノートの形と、その読み方。" +
      "この文書は**プラグインが生成したもの**で、手で直しても次の生成で戻る。" +
      "AI（日報・振り返り・棚卸しなど）がタスクノートを読むときは、まずこの文書の `format_version` を確認し、" +
      "指示書の想定と違えば最初に警告すること。"
  );
  out.push("");
  out.push("- `format_version` … 保存形式の版。ノートの読み書きの約束が変わったときだけ上がる");
  out.push("- `plugin_version` … この文書を書き出したプラグインの版（UI だけの変更でも上がる）");
  out.push("");

  out.push("## ノートの場所");
  out.push("");
  out.push("| 何 | 場所 | 中身 |");
  out.push("|---|---|---|");
  out.push(`| 日付ノート | \`${folder}/${ctx.dateFormat}.md\` | その日のタスク（この文書の形式） |`);
  out.push(`| Inbox | \`${ctx.inboxPath}.md\` | 日付を決めていないタスク（同じ形式。\`登録日\` 付き） |`);
  out.push(`| プロジェクトノート | \`${projects}/<名前>.md\` | 大きなタスク。日付ノートのタスクが \`プロジェクト\` 行でここへリンクする |`);
  const memberList = ctx.members.length
    ? "。メンバー: " + ctx.members.map((m) => `${m.name}（\`${m.folder}/\`）`).join("、")
    : "";
  out.push(`| メンバーの予定 | \`${folder}/Members/<名前>/${ctx.dateFormat}.md\`（メンバーごとに設定で変えられる） | 他の人の予定（同じ形式）${memberList} |`);
  // レポートのファイル名は設定の日付形式によらず常に YYYY-MM-DD（main.ts の dateKey）
  out.push(
    `| プラグインの集計 | \`${folder}/Reports/日報 YYYY-MM-DD.md\`、\`${folder}/Reports/予実レポート YYYY-MM-DD.md\` | プラグインがタスクを集計して書き出した Markdown。**AI が読む入力として最も扱いやすい**。` +
      "コマンド「日報（タスクの集計）をノートに書き出す（表示中の日）」「予実レポートを作成（表示中の週）」で書き出したときだけ存在する |"
  );
  out.push(`| 日報 | \`${ctx.dailyReportFolder}/…${ctx.dateFormat}….md\` | AI などが書いた日報。プラグインは日付ヘッダーからこれを表示する（設定「日報のフォルダ」） |`);
  if (ctx.deletionLog) {
    out.push(`| 操作ログ | \`${folder}/Log.md\` | プラグインがタスクを削除したときの記録（日時・タイトル・元のノート）。「消えたタスク」が意図した削除だったかを確かめるのに使う |`);
  }
  out.push("");

  out.push("## タスクブロックの構造");
  out.push("");
  out.push(
    `タスク1件 = 「見出し + メタ行 + フィールド行 + ステップ + 本文」。` +
      (root
        ? `ノート内の親見出し \`${root}\` の配下に、レベル ${ctx.headingLevel}（\`${heading}\`）の見出しとして並ぶ。`
        : `ノートのファイル直下（frontmatter の後ろ）に、レベル ${ctx.headingLevel}（\`${heading}\`）の見出しとして並ぶ。`)
  );
  out.push("");
  out.push(code(example));
  out.push("");
  out.push("上から順に:");
  out.push("");
  out.push(`1. **見出し行** \`${heading} タイトル #タグ\` … タイトル。タグは見出しの末尾に 1 つ（\`#親/子\` の形も）`);
  out.push("2. **メタ行** … 見出しの直下の 1 行（空行は挟んでよい）。ここが無い見出しはタスクではない");
  out.push(`3. **フィールド行（メタ行の直下）** … ${HEAD_FIELDS.map((f) => `\`${f.label}\``).join("・")}`);
  out.push("4. **ステップ** … インデント無しのチェックリスト `- [ ] …`。空行までが 1 つのまとまり。ステップの下のインデント行は補足");
  out.push(`5. **フィールド行（ステップの後ろ）** … ${RECORD_FIELDS.map((f) => `\`${f.label}\``).join("・")}`);
  out.push("6. **本文（備考）** … 残りの自由な Markdown。プラグインは触らない");
  out.push("");

  out.push("### メタ行");
  out.push("");
  out.push(code([exampleMeta]));
  out.push("");
  out.push("| 部分 | 意味 |");
  out.push("|---|---|");
  out.push(
    "| `- [ ]` / `- [x]` / `- [>]` | 未完了 / 完了 / **持ち越し済み**（翌日へ送った。完了でも未完了でもない）" +
      (ctx.useCheckbox ? "" : "。この保管庫の設定では、未完了のタスクはチェックボックス無し（`- 10:00 - 11:00 …`）で書かれ、完了すると `- [x]` になる") +
      " |"
  );
  out.push("| `10:00 - 11:00` | 予定の時刻（24 時間制）。**無ければ「未スケジュール」**（Inbox や再スケジュール待ち） |");
  if (ctx.mirrorTitle) {
    out.push("| タイトル | この保管庫の設定では、時刻の後ろにタイトルも書かれる（他プラグインとの互換用。見出しと同じ内容） |");
  }
  out.push(`| \`🎫${tracker}#65130\` | チケット。\`🎫#65130\` はツール省略（先頭のツール${ctx.trackers.length ? `: ${ctx.trackers.join(" / ")}` : ""}） |`);
  out.push("| `🔔10` / `🔔off` | リマインド（開始 10 分前 / しない）。無ければ既定 |");
  out.push(`| \`^${ID_PREFIX}xxxxxx\` | プラグインが付けるブロックID。\`[[${folder}/${ctx.dateFormat}#^${ID_PREFIX}xxxxxx]]\` で他のノートから参照できる（持ち越しのリンクもこの形） |`);
  out.push("");
  out.push("手書きで `- 09:00 - 10:00` とだけ書いてもタスクとして認識される（ID は次の保存時に付く）。");
  out.push("");

  out.push("### フィールド");
  out.push("");
  out.push(
    "本文の `- ラベル: 値` の行。1 行のフィールドは**最初の 1 行だけ**が有効で、2 つ目以降はただの本文。" +
      "読むときはリスト記号なし・`**ラベル**`・全角コロン・別表記も受け付けるが、プラグインが書くときは下のラベルに統一する。" +
      "「記録タブ」の欄は、編集画面で作業の記録として「記録」タブに集めているもの（日報・振り返りの元データ）。"
  );
  out.push("");
  out.push(renderFieldTable(ctx));
  out.push("");
  out.push(`状態の値: ${STATUS_KINDS.map((v) => `\`${v}\``).join(" / ")}。中断だけは \`中断(理由)\` のように理由を付ける。`);
  out.push("");

  out.push("### 持ち越し");
  out.push("");
  out.push("未完了のまま翌日へ送ると、元のブロックはチェックが `[>]` になって `持ち越し先` を持ち、続きのブロックが `持ち越し元` を持つ。");
  out.push("");
  out.push(code([...renderTaskBlock(carry.from, opts), "", ...renderTaskBlock(carry.to, opts)]));
  out.push("");

  out.push("## プロジェクトノートの frontmatter");
  out.push("");
  out.push(
    "プロジェクトの完了は **frontmatter の `done`** が正（Bases など本文を読めない機能からも扱えるように）。" +
      "本文先頭の `- [ ] ^id` は ID としてだけ使い、チェックの有無は完了判定に使わない。" +
      "進捗はプラグインがタスク表（`<!-- dt-project-tasks -->` の中）を更新するたびに書き直す。"
  );
  out.push("");
  out.push("| property | 内容 |");
  out.push("|---|---|");
  out.push("| `done` | 完了なら `true`（YAML の真偽値。文字列にしない）。`false` / 未設定は進行中 |");
  out.push("| `completed` | 完了にした日（`YYYY-MM-DD`）。進行中に戻すと消える |");
  out.push("| `group` | グループ名（パネルの区切り） |");
  out.push("| `tasks_total` / `tasks_done` | タスク表の件数と完了数（数値。プラグインが書く） |");
  out.push("| `last_done` | 最後に完了したタスク（`YYYY-MM-DD タスク名`。無ければキーごと無い） |");
  out.push("| `next_task` | 未完了で日付がいちばん近いタスク（`YYYY-MM-DD タスク名`。日付未定だけなら `未定 タスク名`） |");
  out.push("| `due` | 期日（`YYYY-MM-DD`）。本文の `- 期日:` 行から写す |");
  out.push("| `next` | 人が手で書く「次にやること」。プラグインは触らない |");
  out.push("");

  out.push("## 読むときの約束（AI 向け）");
  out.push("");
  out.push("- メタ行の無い見出し、コードブロック（```）の中、frontmatter は無視する");
  out.push("- 完了 = `[x]`。`[>]` は持ち越し済み（その日の実績や結果は残っていることがある）。`[ ]` で時刻が無いものは未スケジュール");
  out.push("- 「今日やった」は `結果` と `実績` で判断する。`完了条件` は予定側の記述");
  out.push("- `他者` は複数行あり得る。`相手 / 内容` で分ける");
  out.push("- `状態: 中断(理由)` の理由、`回答: 未` の質問、`期限` を過ぎた未完了は、日報で拾う候補");
  out.push("- `登録日` は Inbox に入れた日。滞留日数の計算に使う");
  out.push("- 集計が目的なら、プラグインが書き出す `Reports/日報 …` の表を読む方が確実（同じデータから生成している）");
  out.push("");

  out.push("## 手で書くときの約束");
  out.push("");
  out.push("- 新しいタスクは「見出し + メタ行」だけで足りる。ID はプラグインが次に保存するときに付ける");
  out.push("- フィールドは上の表のラベルで書く（別表記は読めるが、保存時に統一される）");
  out.push("- プラグインの書き込みはブロック単位の部分置換で、本文や並び順は勝手に変えない");
  out.push("");
  return out.join("\n") + "\n";
}
