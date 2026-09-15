/**
 * 本文フィールド（「- ラベル: 値」の行）の定義。**保存形式の正本**。
 *
 * フィールドを足すときはここに1件足す。解析（parseBlockDocument）・書き出し（renderTaskBlock）・
 * 編集（updateTask の行の差し替え位置）・README / AI 向け仕様の生成は、すべてこの配列を見る。
 * 編集ダイアログ（modal.ts）の欄だけは UI なので、必要なら個別に足す。
 *
 * このファイルは何も import しない（Obsidian にもパーサにも依存しない）。
 */

/** 値の種類。text 以外は専用の読み書きを持つ */
export type FieldKind = "text" | "link" | "actual";

/** updateTask で「まだ無い行」を足す位置 */
export type FieldInsertAt =
  /** メタ行の直下 */
  | "metaTop"
  /** メタ行の直下。プロジェクト行がそこにあればその下 */
  | "afterProject"
  /** メタ行直下に並ぶ head 領域の行をすべて飛ばした位置 */
  | "afterMeta"
  /** ステップ（と完了条件）の後ろ */
  | "afterSteps";

export interface FieldDef {
  /** TaskBlock / Task / TaskPatch のプロパティ名。行番号は `${key}Line` */
  key: string;
  /** ノートに書くラベル。書き出しはこの表記に統一する */
  label: string;
  /** 読むときだけ許す別表記（例: 「期日」→ 期限、「振り返り」→ ふりかえり） */
  aliases: readonly string[];
  /** ラベルの大文字小文字を区別しない（Owner / owner） */
  ignoreCase?: boolean;
  kind: FieldKind;
  /** 1タスクに何行でも書けるか（他者だけ）。値は string[] */
  multi?: boolean;
  /**
   * 行の置き場。head = メタ行の直下に並ぶ行（予定に付随する情報）、
   * record = ステップの後ろに並ぶ行（作業の記録）。書き出しはこの配列の順
   */
  zone: "head" | "record";
  insertAt: FieldInsertAt;
  /** タイムラインの本文プレビューに出すか（false のものは別の形 — バー・バッジなど — で出す） */
  preview: boolean;
  /** AI（日報・振り返り）が読む欄か。編集画面では「記録」タブ */
  aiReads: boolean;
  /** 説明（README と AI 向け仕様に出す） */
  description: string;
  /** 値の実例（README と AI 向け仕様に出す） */
  example: string;
  /** 決まった値を取るとき、その一覧（README と AI 向け仕様に出す） */
  values?: readonly string[];
}

/** 状態の値の種類。中断だけは「中断(理由)」のように理由を付けられる */
export const STATUS_KINDS = ["未着手", "進行中", "中断", "回答待ち", "期限未定"] as const;

export const FIELDS = [
  // ---------- head: メタ行の直下に並ぶ、予定に付随する情報 ----------
  {
    key: "project",
    label: "プロジェクト",
    aliases: [],
    kind: "link",
    zone: "head",
    insertAt: "metaTop",
    preview: false,
    aiReads: false,
    description:
      "大きなタスク（プロジェクトノート）への参照。編集画面の「プロジェクト」欄と相互に反映。手書きの `[[リンク|別名]]` も読める（ダイアログで変えない限り保持）",
    example: "[[Timeline/Projects/環境構築]]",
  },
  {
    key: "actual",
    label: "実績",
    aliases: [],
    kind: "actual",
    zone: "head",
    insertAt: "afterProject",
    preview: false,
    aiReads: false,
    description:
      "実際に作業した時間。`/` で区切って複数区間を書ける。予定（メタ行）とは独立しているので予実の比較ができる。編集画面の「実績」欄と相互に反映され、空にすると行ごと消える",
    example: "09:15 - 09:45 / 13:00 - 13:30",
  },
  {
    key: "carryFrom",
    label: "持ち越し元",
    aliases: [],
    kind: "link",
    zone: "head",
    insertAt: "afterMeta",
    preview: false,
    aiReads: false,
    description: "前の日から持ち越されたタスクの、元のブロックへのリンク（プラグインが書く）",
    example: "[[2026-08-18#^dtp-k3f9a2]]",
  },
  {
    key: "carryTo",
    label: "持ち越し先",
    aliases: [],
    kind: "link",
    zone: "head",
    insertAt: "afterMeta",
    preview: false,
    aiReads: false,
    description:
      "残件を翌日へ持ち越したとき、続きのブロックへのリンク（プラグインが書く）。持ち越したタスクはチェックが `[>]` になる",
    example: "[[2026-08-19#^dtp-9b2c44]]",
  },
  {
    key: "registered",
    label: "登録日",
    aliases: [],
    kind: "text",
    zone: "head",
    insertAt: "afterMeta",
    preview: false,
    aiReads: false,
    description: "Inbox に入れた日（自動で記録）。どれだけ滞留しているかを後から判定できる",
    example: "2026-08-10",
  },
  {
    key: "due",
    label: "期限",
    aliases: ["期日"],
    kind: "text",
    zone: "head",
    insertAt: "afterMeta",
    preview: true,
    aiReads: true,
    description: "期限（YYYY-MM-DD）。旧表記の「期日」も読める（保存すると「期限」に統一）",
    example: "2026-08-20",
  },
  {
    key: "doneCondition",
    label: "完了条件",
    aliases: [],
    kind: "text",
    zone: "head",
    insertAt: "afterMeta",
    preview: false,
    aiReads: true,
    description:
      "何ができたら終わりか。編集画面の「完了条件」欄と相互に反映され、空にすると行ごと消える。無いときにダイアログで入力するとメタ行の直下に追加される",
    example: "今日の担当が決まっている",
  },
  // ---------- record: ステップの後ろに並ぶ、作業の記録 ----------
  {
    key: "result",
    label: "結果",
    aliases: [],
    kind: "text",
    zone: "record",
    insertAt: "afterSteps",
    preview: true,
    aiReads: true,
    description:
      "何がどこまで終わったかの記録。完了時のポップアップと編集画面の「結果」欄に相互に反映。日報・週報の元データになる",
    example: "GenericRFI_BODY の誤検知と特定",
  },
  {
    key: "cause",
    label: "原因",
    aliases: [],
    kind: "text",
    zone: "record",
    insertAt: "afterSteps",
    preview: true,
    aiReads: true,
    description: "障害・バグ系の記録: 何が原因だったか",
    example: "署名のパターンが URL エンコード済みの本文に一致",
  },
  {
    key: "judgment",
    label: "判断",
    aliases: [],
    kind: "text",
    zone: "record",
    insertAt: "afterSteps",
    preview: true,
    aiReads: true,
    description: "障害・バグ系の記録: その場でどう判断したか",
    example: "該当ルールを検知モードに落として様子見",
  },
  {
    key: "remaining",
    label: "残",
    aliases: [],
    kind: "text",
    zone: "record",
    insertAt: "afterSteps",
    preview: true,
    aiReads: true,
    description:
      "完了にした後に残った作業。未チェックのステップが残るタスクを完了にすると、ここへ書き込むかを確認する",
    example: "恒久対応の検討",
  },
  {
    key: "others",
    label: "他者",
    aliases: [],
    kind: "text",
    multi: true,
    zone: "record",
    insertAt: "afterSteps",
    preview: true,
    aiReads: true,
    description:
      "ボールが相手にあるものの記録。値は「相手 / 内容」。1タスクに複数行書ける（唯一の複数行フィールド）。編集画面では「相手」と「内容」の2欄で1件ずつ入力する",
    example: "田中 / ルール変更の承認",
  },
  {
    key: "answer",
    label: "回答",
    aliases: [],
    kind: "text",
    zone: "record",
    insertAt: "afterSteps",
    preview: true,
    aiReads: true,
    description: "質問への回答が付いたかの記録",
    example: "未",
    values: ["済", "未"],
  },
  {
    key: "status",
    label: "状態",
    aliases: [],
    kind: "text",
    zone: "record",
    insertAt: "afterSteps",
    preview: true,
    aiReads: true,
    description:
      "タスクの状態。編集画面では一覧から選び、中断のときだけ理由を付けて「中断(理由)」として保存する",
    example: "中断(承認待ち)",
    values: STATUS_KINDS,
  },
  {
    key: "ownerName",
    label: "Owner",
    aliases: [],
    ignoreCase: true,
    kind: "text",
    zone: "record",
    insertAt: "afterSteps",
    preview: true,
    aiReads: true,
    description:
      "タスクのオーナー（ボールを持っている人）。「誰の予定か」（どのメンバーのノートにあるか）とは別の記録。メンバー設定があれば入力候補に出る",
    example: "鈴木",
  },
  {
    key: "nextAction",
    label: "次アクション",
    aliases: [],
    kind: "text",
    zone: "record",
    insertAt: "afterSteps",
    preview: true,
    aiReads: true,
    description:
      "未完了事項の次の一手。編集画面では Owner・期限・完了条件と一緒に「未完了セット」の枠にまとまり、翌日へ持ち越すと続きのブロックに引き継がれる",
    example: "承認が下りたら本番に反映",
  },
  {
    key: "retrospective",
    label: "ふりかえり",
    aliases: ["振り返り"],
    kind: "text",
    zone: "record",
    insertAt: "afterSteps",
    preview: true,
    aiReads: true,
    description:
      "作業してみてどうだったか・次はどう改善するか。完了時のポップアップから保存するとステップの後ろに追記される",
    example: "調査に時間がかかった",
  },
] as const satisfies readonly FieldDef[];

export type AnyField = (typeof FIELDS)[number];
export type FieldKey = AnyField["key"];

/** 1行・文字列の値を持つフィールド（"" = 無し）。TaskBlock / Task / TaskPatch にそのままプロパティとして並ぶ */
export type TextFieldKey = Exclude<Extract<AnyField, { kind: "text" }>, { multi: true }>["key"];
/** 複数行のフィールド（値は string[]） */
export type MultiFieldKey = Extract<AnyField, { multi: true }>["key"];
/** Wikilink を値に持つフィールド（null = 無し） */
export type LinkFieldKey = Extract<AnyField, { kind: "link" }>["key"];

export type TextFieldValues = { [K in TextFieldKey]: string };
export type TextFieldLines = { [K in TextFieldKey as `${K}Line`]: number | null };

export const TEXT_FIELDS = FIELDS.filter(
  (f): f is Extract<AnyField, { kind: "text" }> => f.kind === "text" && !("multi" in f && f.multi)
);
export const HEAD_FIELDS = FIELDS.filter((f) => f.zone === "head");
export const RECORD_FIELDS = FIELDS.filter((f) => f.zone === "record");

export function fieldByKey(key: FieldKey): AnyField {
  const f = FIELDS.find((d) => d.key === key);
  if (!f) throw new Error(`unknown field: ${key}`);
  return f;
}

/** ダイアログの欄名（= ラベル）からフィールドを引く。無ければ null */
export function fieldByLabel(label: string): AnyField | null {
  return FIELDS.find((d) => d.label === label) ?? null;
}

/** 全フィールドが "" / null の TextFieldValues（新しい TaskBlock / Task の初期値） */
export function emptyTextFields(): TextFieldValues {
  const out: Record<string, string> = {};
  for (const f of TEXT_FIELDS) out[f.key] = "";
  return out as TextFieldValues;
}

/** src から text フィールドの値だけを写す（無いものは ""）。TaskBlock → Task の変換などに使う */
export function pickTextFields(src: Partial<TextFieldValues>): TextFieldValues {
  const out: Record<string, string> = {};
  for (const f of TEXT_FIELDS) out[f.key] = (src as Record<string, string | undefined>)[f.key] ?? "";
  return out as TextFieldValues;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * フィールド行の正規表現。
 * 「- ラベル: 値」を基本に、リスト記号なし・太字（**ラベル**）・全角コロンも読む
 */
function fieldLineRe(def: FieldDef): RegExp {
  const names = [def.label, ...def.aliases].map(escapeRe).join("|");
  return new RegExp(
    `^\\s*(?:[-*+]\\s+)?(?:\\*\\*)?(?:${names})(?:\\*\\*)?\\s*[:：]\\s*(.*?)\\s*$`,
    def.ignoreCase ? "i" : ""
  );
}

const FIELD_RES = new Map<string, RegExp>(FIELDS.map((f) => [f.key, fieldLineRe(f)]));

/** 行がどれかのフィールド行なら、その定義と（ラベルの後ろの）生の値を返す。違えば null */
export function matchFieldLine(line: string): { def: AnyField; value: string } | null {
  for (const def of FIELDS) {
    const m = (FIELD_RES.get(def.key) as RegExp).exec(line);
    if (m) return { def, value: m[1] };
  }
  return null;
}

/** 行が指定のフィールド行なら生の値を返す（空でも ""）。違えば null */
export function parseFieldLine(key: FieldKey, line: string): string | null {
  const m = (FIELD_RES.get(key) as RegExp).exec(line);
  return m ? m[1] : null;
}

/** 「- ラベル: 値」の行を組み立てる（値は書き出し用に整形済みのもの） */
export function renderFieldLine(key: FieldKey, value: string): string {
  return `- ${fieldByKey(key).label}: ${value.trim()}`;
}
