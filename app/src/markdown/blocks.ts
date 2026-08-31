/**
 * 「1タスク = 1マークダウンブロック」形式の解析と生成。
 *
 *   ## 朝会
 *   - [x] 09:00 - 10:00 ^dtp-k3f9a2
 *
 *   議題: 進捗確認
 *
 * 見出し行がタイトル、その直下の1行（メタ行）が時刻・完了状態・ブロックID、
 * それ以降が自由に書ける本文。メタ行が無い見出しはタスクではないので触らない。
 *
 * このファイルは Obsidian の API に依存しない（そのままテストできる）。
 */
import { minutesToHHMM } from "../util";
import { extractBlockId, isOwnId, stripBlockId } from "./id";

export interface BlockOptions {
  /** タスクとみなす見出しレベル（1〜6） */
  headingLevel: number;
  /** タスクを置く親見出し（"" ならファイル直下） */
  rootHeading: string;
  /** "- [ ] " のチェックボックス形式で書き込むか */
  useCheckbox: boolean;
  /** メタ行にもタイトルを書くか（他プラグインとの互換用） */
  mirrorTitle: boolean;
  /**
   * タスクとみなさない見出し（テキストで比較）。
   * 旧形式の「タイムスケジュール」セクションが1つのタスクに見えてしまうのを防ぐ。
   * セクションの中身ごと読み飛ばす。
   */
  excludeHeadings?: string[];
}

/** ノート内の1タスク */
export interface TaskBlock {
  id: string | null;
  title: string;
  /** 実際の見出しレベル（設定値ではなくノート上の値） */
  level: number;
  /** 0:00 からの分。null なら未スケジュール */
  start: number | null;
  end: number | null;
  done: boolean;
  /** 元のチェックボックスの中身（"/" などを保持）。チェックボックスが無ければ null */
  checkChar: string | null;
  /** メタ行の時刻の後ろにあったテキスト（ブロックID・リマインド指定を除く）。そのまま保持する */
  note: string;
  /** リマインド: 分前の数値 / "off" = しない / null = 既定 */
  reminder: ReminderSetting;
  /** チケット（🎫redmine#65130）。無ければ null */
  ticket: TicketRef | null;
  /** 完了条件（本文中の「- 完了条件: …」行）。無ければ "" */
  doneCondition: string;
  /** 完了条件の行番号（無ければ null） */
  doneConditionLine: number | null;
  /** ふりかえり（本文中の「- ふりかえり: …」行）。無ければ "" */
  retrospective: string;
  /** ふりかえりの行番号（無ければ null） */
  retrospectiveLine: number | null;
  /** 結果 = 何がどこまで終わったか（本文中の「- 結果: …」行）。無ければ "" */
  result: string;
  /** 結果の行番号（無ければ null） */
  resultLine: number | null;
  /** 残 = 完了後に残った作業（本文中の「- 残: …」行）。無ければ "" */
  remaining: string;
  /** 残の行番号（無ければ null） */
  remainingLine: number | null;
  /** 登録日（本文中の「- 登録日: YYYY-MM-DD」行。Inbox の滞留日数の判定用）。無ければ "" */
  registered: string;
  /** 登録日の行番号（無ければ null） */
  registeredLine: number | null;
  /** 実績（本文中の「- 実績: …」行）。無ければ [] */
  actual: ActualRange[];
  /** 実績の行番号（無ければ null） */
  actualLine: number | null;
  /** プロジェクト（大きなタスク）ノートへのリンク先。無ければ null */
  project: string | null;
  /** プロジェクト行の行番号（無ければ null） */
  projectLine: number | null;
  /** 持ち越し先（残件を先送りしたブロックへのリンク）。無ければ null */
  carryTo: string | null;
  carryToLine: number | null;
  /** 持ち越し元（前の日のブロックへのリンク）。無ければ null */
  carryFrom: string | null;
  carryFromLine: number | null;
  /** ステップ（メタ行の直後に続くチェックリスト） */
  steps: TaskStep[];
  /** ステップの行範囲（無ければ stepsStart = null） */
  stepsStart: number | null;
  stepsEnd: number;
  /** 本文（前後の空行は落としてある。完了条件・ステップ・ふりかえりの行も含む） */
  body: string[];
  /**
   * 詳細 = メタ行・完了条件・ステップ・ふりかえりを除いた自由な本文。
   * detailsStart はその領域の先頭行（詳細が無ければブロック末尾）
   */
  details: string[];
  detailsStart: number;
  headingLine: number;
  metaLine: number;
  bodyStart: number;
  /** セクションの終端（この行は含まない） */
  endLine: number;
}

export interface BlockDocument {
  lines: string[];
  eol: string;
  /** タスクを探す範囲 */
  scanStart: number;
  scanEnd: number;
  /** 親見出しが設定されているのにノートに無い */
  rootMissing: boolean;
  /** 文書順のタスク */
  tasks: TaskBlock[];
}

/** チケットの参照（管理ツール名 + 番号） */
export interface TicketRef {
  /** 設定した管理ツールの名前（例: "redmine"）。省略時は "" */
  tracker: string;
  /** チケット番号やキー（例: "65130" / "PROJ-12"） */
  id: string;
}

/** メタ行のチケット指定（例: 🎫redmine#65130 / 🎫#65130） */
const TICKET_RE = /(?:^|\s)🎫([\p{L}\p{N}_.-]*)#(\S+)(?=\s|$)/u;

/** テキストからチケット指定を取り出し、取り除いた残りと一緒に返す */
export function extractTicket(text: string): { ticket: TicketRef | null; rest: string } {
  const m = TICKET_RE.exec(text);
  if (!m) return { ticket: null, rest: text };
  const rest = (text.slice(0, m.index) + " " + text.slice(m.index + m[0].length))
    .replace(/\s+/g, " ")
    .trim();
  return { ticket: { tracker: m[1], id: m[2] }, rest };
}

export function renderTicket(t: TicketRef | null | undefined): string {
  if (!t || !t.id.trim()) return "";
  return `🎫${t.tracker}#${t.id.trim()}`;
}

/** タスクごとのリマインド指定。数値 = その分前 / "off" = しない / null = 既定に従う */
export type ReminderSetting = number | "off" | null;

/** メタ行を組み立てるのに必要な情報 */
export interface MetaSource {
  id: string | null;
  title: string;
  start: number | null;
  end: number | null;
  done: boolean;
  /** undefined = 新規（設定に従う） / null = チェックボックス無し */
  checkChar?: string | null;
  note?: string;
  reminder?: ReminderSetting;
  ticket?: TicketRef | null;
  /** 完了条件（新規ブロックを組み立てるときだけ使う） */
  doneCondition?: string;
  /** ステップ（新規ブロックを組み立てるときだけ使う） */
  steps?: TaskStep[];
  /** ふりかえり（新規ブロックを組み立てるときだけ使う） */
  retrospective?: string;
  /** 結果（新規ブロックを組み立てるときだけ使う） */
  result?: string;
  /** 残（新規ブロックを組み立てるときだけ使う） */
  remaining?: string;
  /** 登録日（新規ブロックを組み立てるときだけ使う） */
  registered?: string;
  /** 実績（新規ブロックを組み立てるときだけ使う） */
  actual?: ActualRange[];
  /** プロジェクト（新規ブロックを組み立てるときだけ使う） */
  project?: string | null;
  /** 持ち越し先・元（新規ブロックを組み立てるときだけ使う） */
  carryTo?: string | null;
  carryFrom?: string | null;
}

/** タスクを小さく分けた1ステップ */
export interface TaskStep {
  text: string;
  done: boolean;
  /** ステップの下にぶら下がるインデントされた行。並べ替えのときも一緒に動かす */
  children: string[];
}

/** ステップ行（インデント無しのチェックボックス項目） */
const STEP_RE = /^[-*+]\s+\[(.)\]\s+(.*?)\s*$/;

export function parseStepLine(line: string): { done: boolean; text: string } | null {
  const m = STEP_RE.exec(line);
  if (!m) return null;
  return { done: /x/i.test(m[1]), text: m[2] };
}

export function renderStepLines(steps: TaskStep[]): string[] {
  const out: string[] = [];
  for (const st of steps) {
    const text = st.text.trim();
    if (!text) continue;
    out.push(`- [${st.done ? "x" : " "}] ${text}`, ...(st.children ?? []));
  }
  return out;
}

/** 完了条件の行（例: "- 完了条件: レビューが通る" / "完了条件：xxx" / "- **完了条件**: xxx"） */
const DONE_CONDITION_RE = /^\s*(?:[-*+]\s+)?(?:\*\*)?完了条件(?:\*\*)?\s*[:：]\s*(.*?)\s*$/;

/** 完了条件の行なら中身を返す（空でも ""）。違えば null */
export function parseDoneConditionLine(line: string): string | null {
  const m = DONE_CONDITION_RE.exec(line);
  return m ? m[1] : null;
}

export function renderDoneConditionLine(text: string): string {
  return "- 完了条件: " + text.trim();
}

/** ふりかえりの行（例: "- ふりかえり: 調査に時間がかかった" / "振り返り：…"） */
const RETRO_RE = /^\s*(?:[-*+]\s+)?(?:\*\*)?(?:ふりかえり|振り返り)(?:\*\*)?\s*[:：]\s*(.*?)\s*$/;

/** ふりかえりの行なら中身を返す（空でも ""）。違えば null */
export function parseRetrospectiveLine(line: string): string | null {
  const m = RETRO_RE.exec(line);
  return m ? m[1] : null;
}

export function renderRetrospectiveLine(text: string): string {
  return "- ふりかえり: " + text.trim();
}

/** 結果の行（例: "- 結果: 実装完了、テスト修正まで" / "結果：…"）。何がどこまで終わったかの記録 */
const RESULT_RE = /^\s*(?:[-*+]\s+)?(?:\*\*)?結果(?:\*\*)?\s*[:：]\s*(.*?)\s*$/;

/** 結果の行なら中身を返す（空でも ""）。違えば null */
export function parseResultLine(line: string): string | null {
  const m = RESULT_RE.exec(line);
  return m ? m[1] : null;
}

export function renderResultLine(text: string): string {
  return "- 結果: " + text.trim();
}

/** 残の行（例: "- 残: 結合環境に投入"）。完了にした後に残っている作業の記録 */
const REMAINING_RE = /^\s*(?:[-*+]\s+)?(?:\*\*)?残(?:\*\*)?\s*[:：]\s*(.*?)\s*$/;

/** 残の行なら中身を返す（空でも ""）。違えば null */
export function parseRemainingLine(line: string): string | null {
  const m = REMAINING_RE.exec(line);
  return m ? m[1] : null;
}

export function renderRemainingLine(text: string): string {
  return "- 残: " + text.trim();
}

/** 登録日の行（例: "- 登録日: 2026-08-31"）。Inbox に入れた日の記録で、滞留日数の判定に使える */
const REGISTERED_RE = /^\s*(?:[-*+]\s+)?(?:\*\*)?登録日(?:\*\*)?\s*[:：]\s*(.*?)\s*$/;

/** 登録日の行なら中身を返す（空でも ""）。違えば null */
export function parseRegisteredLine(line: string): string | null {
  const m = REGISTERED_RE.exec(line);
  return m ? m[1] : null;
}

export function renderRegisteredLine(text: string): string {
  return "- 登録日: " + text.trim();
}

/** 実績の時間帯（0:00 からの分）。予定とは別に「実際に作業した時間」を記録する */
export interface ActualRange {
  start: number;
  end: number;
}

/** 実績の行（例: "- 実績: 10:05 - 11:20 / 13:00 - 13:30"） */
const ACTUAL_RE = /^\s*(?:[-*+]\s+)?(?:\*\*)?実績(?:\*\*)?\s*[:：]\s*(.*?)\s*$/;

/**
 * 実績行なら時間帯の配列を返す（読めない区間は読み飛ばす。空でも []）。
 * 実績行でなければ null
 */
export function parseActualLine(line: string): ActualRange[] | null {
  const m = ACTUAL_RE.exec(line);
  if (!m) return null;
  const out: ActualRange[] = [];
  for (const part of m[1].split(/[/、,]+/)) {
    const r = RANGE_RE.exec(part.trim());
    if (!r) continue;
    const start = Math.min(Number(r[1]) * 60 + Number(r[2]), 1439);
    const end = Math.min(Number(r[3]) * 60 + Number(r[4]), 1440);
    if (end <= start) continue;
    out.push({ start, end });
  }
  return out;
}

export function renderActualLine(ranges: ActualRange[]): string {
  return (
    "- 実績: " + ranges.map((r) => `${minutesToHHMM(r.start)} - ${minutesToHHMM(r.end)}`).join(" / ")
  );
}

/** 実績の合計（分） */
export function actualTotal(ranges: ActualRange[]): number {
  return ranges.reduce((n, r) => n + (r.end - r.start), 0);
}

/**
 * 候補の時間帯から、others と重なる部分を取り除く（1分未満のかけらは捨てる）。
 * 完了時の実績の自動記録が、同じ日の他タスクの実績と重ならないようにするために使う
 */
export function subtractActualRanges(candidate: ActualRange[], others: ActualRange[]): ActualRange[] {
  const blocks = [...others].sort((a, b) => a.start - b.start);
  const out: ActualRange[] = [];
  for (const c of candidate) {
    let segs: ActualRange[] = [{ start: c.start, end: c.end }];
    for (const b of blocks) {
      const next: ActualRange[] = [];
      for (const s of segs) {
        if (b.end <= s.start || b.start >= s.end) {
          next.push(s);
          continue;
        }
        if (b.start > s.start) next.push({ start: s.start, end: b.start });
        if (b.end < s.end) next.push({ start: b.end, end: s.end });
      }
      segs = next;
    }
    out.push(...segs.filter((s) => s.end - s.start >= 1));
  }
  return out;
}

/** プロジェクト（大きなタスク）への参照行（例: "- プロジェクト: [[Timeline/Projects/環境構築]]"） */
const PROJECT_RE = /^\s*(?:[-*+]\s+)?(?:\*\*)?プロジェクト(?:\*\*)?\s*[:：]\s*(.*?)\s*$/;

/**
 * プロジェクト行ならリンク先（[[...]] の中身。別名は除く）を返す（空でも ""）。
 * プロジェクト行でなければ null
 */
export function parseProjectLine(line: string): string | null {
  const m = PROJECT_RE.exec(line);
  if (!m) return null;
  const v = m[1].trim();
  const link = /^\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/.exec(v);
  return link ? link[1].trim() : v;
}

export function renderProjectLine(linktext: string): string {
  return `- プロジェクト: [[${linktext.trim()}]]`;
}

/**
 * 持ち越しの参照行。
 * 残件を翌日へ持ち越したとき、元のブロックに「- 持ち越し先: [[...]]」、
 * 続きのブロックに「- 持ち越し元: [[...]]」を書いて鎖にする
 */
const CARRY_TO_RE = /^\s*(?:[-*+]\s+)?(?:\*\*)?持ち越し先(?:\*\*)?\s*[:：]\s*(.*?)\s*$/;
const CARRY_FROM_RE = /^\s*(?:[-*+]\s+)?(?:\*\*)?持ち越し元(?:\*\*)?\s*[:：]\s*(.*?)\s*$/;

function parseCarryValue(v: string): string {
  const link = /^\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/.exec(v.trim());
  return link ? link[1].trim() : v.trim();
}

/** 持ち越し先の行ならリンク先を返す（空でも ""）。違えば null */
export function parseCarryToLine(line: string): string | null {
  const m = CARRY_TO_RE.exec(line);
  return m ? parseCarryValue(m[1]) : null;
}

/** 持ち越し元の行ならリンク先を返す（空でも ""）。違えば null */
export function parseCarryFromLine(line: string): string | null {
  const m = CARRY_FROM_RE.exec(line);
  return m ? parseCarryValue(m[1]) : null;
}

export function renderCarryToLine(linktext: string): string {
  return `- 持ち越し先: [[${linktext.trim()}]]`;
}

export function renderCarryFromLine(linktext: string): string {
  return `- 持ち越し元: [[${linktext.trim()}]]`;
}

/** メタ行のリマインド指定（例: 🔔10 / 🔔off） */
const REMINDER_RE = /(?:^|\s)🔔(\d{1,3}|off)(?=\s|$)/u;

/** テキストからリマインド指定を取り出し、取り除いた残りと一緒に返す */
export function extractReminder(text: string): { reminder: ReminderSetting; rest: string } {
  const m = REMINDER_RE.exec(text);
  if (!m) return { reminder: null, rest: text };
  const reminder: ReminderSetting = m[1] === "off" ? "off" : Number(m[1]);
  const rest = (text.slice(0, m.index) + " " + text.slice(m.index + m[0].length)).replace(/\s+/g, " ").trim();
  return { reminder, rest };
}

export function renderReminder(r: ReminderSetting | undefined): string {
  if (r === null || r === undefined) return "";
  return "🔔" + (r === "off" ? "off" : String(r));
}

const HEADING_RE = /^(#{1,6})\s+(.*?)\s*$/;
const FENCE_RE = /^\s*(?:```|~~~)/;
/** リスト項目。チェックボックスは任意 */
const BULLET_RE = /^[-*+]\s+(?:\[(.)\]\s*)?(.*?)\s*$/;
/** "09:00 - 10:00" の時刻範囲。区切りは - – — ~ 〜 ～ */
const RANGE_RE = /^(\d{1,2}):(\d{2})\s*(?:-|–|—|~|〜|～)\s*(\d{1,2}):(\d{2})\s*(.*)$/;

/** 設定の見出し文字列を「レベル」と「テキスト」に分解 */
export function parseHeadingSetting(h: string, fallback = "タイムスケジュール"): {
  level: number;
  text: string;
} {
  const m = /^\s*(#{1,6})\s+(.*?)\s*$/.exec(h);
  if (m) return { level: m[1].length, text: m[2] };
  const t = h.trim();
  return { level: 2, text: t || fallback };
}

/**
 * 設定の組み合わせを実際に使える形に整える。
 * タスクの見出しレベルが親見出しと同じかそれより浅いと、タスクの見出しが
 * 親のセクションを終端させてしまうので、親より1つ深いレベルに繰り下げる。
 */
export function normalizeBlockOptions<T extends BlockOptions>(opts: T): T {
  if (!opts.rootHeading.trim()) return opts;
  const root = parseHeadingSetting(opts.rootHeading);
  if (opts.headingLevel > root.level) return opts;
  return { ...opts, headingLevel: Math.min(root.level + 1, 6) };
}

/** 前後の空行を落とす */
export function trimBlankLines(lines: string[]): string[] {
  let a = 0;
  let b = lines.length;
  while (a < b && lines[a].trim() === "") a++;
  while (b > a && lines[b - 1].trim() === "") b--;
  return lines.slice(a, b);
}

/**
 * メタ行を解析する。タスクの目印（時刻範囲、または自前のブロックID）が
 * 無い行は「ただのリスト項目」なので null を返す。
 */
export function parseMetaLine(line: string): Omit<MetaSource, "title"> & {
  done: boolean;
  note: string;
  reminder: ReminderSetting;
  ticket: TicketRef | null;
} | null {
  const m = BULLET_RE.exec(line);
  if (!m) return null;
  const checkChar = m[1] ?? null;
  let rest = m[2];

  const id = extractBlockId(rest);
  if (id !== null) rest = stripBlockId(rest);
  const rem = extractReminder(rest);
  rest = rem.rest;
  const tic = extractTicket(rest);
  rest = tic.rest;

  let start: number | null = null;
  let end: number | null = null;
  const r = RANGE_RE.exec(rest);
  if (r) {
    start = Math.min(Number(r[1]) * 60 + Number(r[2]), 1439);
    end = Math.min(Number(r[3]) * 60 + Number(r[4]), 1440);
    if (end <= start) end = Math.min(start + 30, 1440); // 不正な範囲は 30 分として扱う
    rest = r[5];
  }

  // 時刻もこのプラグインの ID も無ければ、タスクではない
  if (start === null && !isOwnId(id)) return null;

  return {
    id,
    start,
    end,
    done: /x/i.test(checkChar ?? ""),
    checkChar,
    note: rest.trim(),
    reminder: rem.reminder,
    ticket: tic.ticket,
  };
}

/** タスクを探す範囲（frontmatter の後ろ、親見出しの配下） */
function findScanRange(
  lines: string[],
  opts: BlockOptions
): { scanStart: number; scanEnd: number; rootMissing: boolean } {
  let start = 0;
  if (lines[0]?.trim() === "---") {
    for (let k = 1; k < lines.length; k++) {
      if (lines[k].trim() === "---" || lines[k].trim() === "...") {
        start = k + 1;
        break;
      }
    }
  }
  if (!opts.rootHeading.trim()) {
    return { scanStart: start, scanEnd: lines.length, rootMissing: false };
  }

  const { level, text } = parseHeadingSetting(opts.rootHeading);
  let fence = false;
  for (let i = start; i < lines.length; i++) {
    if (FENCE_RE.test(lines[i])) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const h = HEADING_RE.exec(lines[i]);
    if (h && h[1].length === level && h[2] === text) {
      return {
        scanStart: i + 1,
        scanEnd: sectionEnd(lines, i, level, lines.length),
        rootMissing: false,
      };
    }
  }
  // 親見出しが無い = タスクは1件も無い。書き込み時に作る
  return { scanStart: lines.length, scanEnd: lines.length, rootMissing: true };
}

/** 見出しのセクションが終わる行（同レベル以上の見出しの手前 / 範囲の末尾） */
function sectionEnd(lines: string[], from: number, level: number, limit: number): number {
  let fence = false;
  for (let j = from + 1; j < limit; j++) {
    if (FENCE_RE.test(lines[j])) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const h = HEADING_RE.exec(lines[j]);
    if (h && h[1].length <= level) return j;
  }
  return limit;
}

/** ノート全文を解析してタスクブロックを取り出す */
export function parseBlockDocument(content: string, opts: BlockOptions): BlockDocument {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  const { scanStart, scanEnd, rootMissing } = findScanRange(lines, opts);
  const tasks: TaskBlock[] = [];

  const excluded = new Set(opts.excludeHeadings ?? []);
  let fence = false;
  for (let i = scanStart; i < scanEnd; i++) {
    if (FENCE_RE.test(lines[i])) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const h = HEADING_RE.exec(lines[i]);
    if (!h) continue;
    if (excluded.has(h[2])) {
      // 除外セクションは中身ごと読み飛ばす
      i = sectionEnd(lines, i, h[1].length, scanEnd) - 1;
      continue;
    }
    if (h[1].length !== opts.headingLevel) continue;

    const level = h[1].length;
    const end = sectionEnd(lines, i, level, scanEnd);

    // 見出しの直下（空行は読み飛ばす）にメタ行があればタスク
    let mi = i + 1;
    while (mi < end && lines[mi].trim() === "") mi++;
    const meta = mi < end ? parseMetaLine(lines[mi]) : null;
    if (!meta) continue;

    // 本文の中の「完了条件」「ふりかえり」「結果」「残」「登録日」「実績」「プロジェクト」行（コードブロック内は除く）
    let doneCondition = "";
    let doneConditionLine: number | null = null;
    let retrospective = "";
    let retrospectiveLine: number | null = null;
    let result = "";
    let resultLine: number | null = null;
    let remaining = "";
    let remainingLine: number | null = null;
    let registered = "";
    let registeredLine: number | null = null;
    let actual: ActualRange[] = [];
    let actualLine: number | null = null;
    let project: string | null = null;
    let projectLine: number | null = null;
    let carryTo: string | null = null;
    let carryToLine: number | null = null;
    let carryFrom: string | null = null;
    let carryFromLine: number | null = null;
    let bodyFence = false;
    for (let k = mi + 1; k < end; k++) {
      if (FENCE_RE.test(lines[k])) {
        bodyFence = !bodyFence;
        continue;
      }
      if (bodyFence) continue;
      if (doneConditionLine === null) {
        const dc = parseDoneConditionLine(lines[k]);
        if (dc !== null) {
          doneCondition = dc;
          doneConditionLine = k;
          continue;
        }
      }
      if (actualLine === null) {
        const ac = parseActualLine(lines[k]);
        if (ac !== null) {
          actual = ac;
          actualLine = k;
          continue;
        }
      }
      if (projectLine === null) {
        const pj = parseProjectLine(lines[k]);
        if (pj !== null) {
          project = pj || null;
          projectLine = k;
          continue;
        }
      }
      if (carryToLine === null) {
        const ct = parseCarryToLine(lines[k]);
        if (ct !== null) {
          carryTo = ct || null;
          carryToLine = k;
          continue;
        }
      }
      if (carryFromLine === null) {
        const cf = parseCarryFromLine(lines[k]);
        if (cf !== null) {
          carryFrom = cf || null;
          carryFromLine = k;
          continue;
        }
      }
      if (resultLine === null) {
        const rs = parseResultLine(lines[k]);
        if (rs !== null) {
          result = rs;
          resultLine = k;
          continue;
        }
      }
      if (remainingLine === null) {
        const rm = parseRemainingLine(lines[k]);
        if (rm !== null) {
          remaining = rm;
          remainingLine = k;
          continue;
        }
      }
      if (registeredLine === null) {
        const rg = parseRegisteredLine(lines[k]);
        if (rg !== null) {
          registered = rg;
          registeredLine = k;
          continue;
        }
      }
      if (retrospectiveLine === null) {
        const rt = parseRetrospectiveLine(lines[k]);
        if (rt !== null) {
          retrospective = rt;
          retrospectiveLine = k;
        }
      }
      if (
        doneConditionLine !== null &&
        retrospectiveLine !== null &&
        resultLine !== null &&
        remainingLine !== null &&
        registeredLine !== null &&
        actualLine !== null &&
        projectLine !== null &&
        carryToLine !== null &&
        carryFromLine !== null
      )
        break;
    }

    // ステップ: メタ行（と完了条件・実績行）の直後に続くチェックリスト。空行が来るまで
    const steps: TaskStep[] = [];
    let stepsStart: number | null = null;
    let stepsEnd = mi + 1;
    {
      let k = mi + 1;
      while (
        k < end &&
        (lines[k].trim() === "" ||
          k === doneConditionLine ||
          k === retrospectiveLine ||
          k === resultLine ||
          k === remainingLine ||
          k === registeredLine ||
          k === actualLine ||
          k === projectLine ||
          k === carryToLine ||
          k === carryFromLine)
      )
        k++;
      if (k < end && !FENCE_RE.test(lines[k]) && parseStepLine(lines[k])) {
        stepsStart = k;
        while (k < end) {
          if (
            k === doneConditionLine ||
            k === retrospectiveLine ||
            k === resultLine ||
            k === remainingLine ||
            k === registeredLine ||
            k === actualLine ||
            k === projectLine ||
            k === carryToLine ||
            k === carryFromLine
          )
            break;
          const st = parseStepLine(lines[k]);
          if (st) {
            steps.push({ text: st.text, done: st.done, children: [] });
          } else if (/^\s+\S/.test(lines[k]) && steps.length) {
            steps[steps.length - 1].children.push(lines[k]);
          } else {
            break;
          }
          k++;
        }
        stepsEnd = k;
      }
    }

    // 詳細の領域: メタ行直下の「完了条件・ステップ・ふりかえり・結果・残・登録日・空行」のかたまりの後ろから、ブロック末尾まで
    let detailsStart = mi + 1;
    while (detailsStart < end) {
      const k = detailsStart;
      if (
        k === doneConditionLine ||
        k === retrospectiveLine ||
        k === resultLine ||
        k === remainingLine ||
        k === registeredLine ||
        k === actualLine ||
        k === projectLine ||
        k === carryToLine ||
        k === carryFromLine ||
        (stepsStart !== null && k >= stepsStart && k < stepsEnd) ||
        lines[k].trim() === ""
      ) {
        detailsStart++;
        continue;
      }
      break;
    }

    tasks.push({
      id: meta.id,
      title: h[2],
      level,
      start: meta.start,
      end: meta.end,
      done: meta.done,
      checkChar: meta.checkChar ?? null,
      note: meta.note,
      reminder: meta.reminder,
      ticket: meta.ticket,
      doneCondition,
      doneConditionLine,
      retrospective,
      retrospectiveLine,
      result,
      resultLine,
      remaining,
      remainingLine,
      registered,
      registeredLine,
      actual,
      actualLine,
      project,
      projectLine,
      carryTo,
      carryToLine,
      carryFrom,
      carryFromLine,
      steps,
      stepsStart,
      stepsEnd,
      body: trimBlankLines(lines.slice(mi + 1, end)),
      details: trimBlankLines(lines.slice(detailsStart, end)),
      detailsStart,
      headingLine: i,
      metaLine: mi,
      bodyStart: mi + 1,
      endLine: end,
    });
  }

  return { lines, eol, scanStart, scanEnd, rootMissing, tasks };
}

/** メタ行を組み立てる */
export function renderMetaLine(t: MetaSource, opts: BlockOptions): string {
  // チェックボックスの中身: 元の記号（"/" など）はなるべく保持し、完了状態と同期させる
  let box: string | null;
  if (t.checkChar === undefined) box = opts.useCheckbox || t.done ? " " : null;
  else if (t.checkChar === null) box = t.done ? "x" : null;
  else box = t.checkChar;
  if (box !== null) {
    if (t.done && !/x/i.test(box)) box = "x";
    if (!t.done && /x/i.test(box)) box = " ";
  }

  const parts: string[] = [];
  if (t.start !== null && t.end !== null) {
    parts.push(`${minutesToHHMM(t.start)} - ${minutesToHHMM(t.end)}`);
  }
  const note = opts.mirrorTitle ? t.title.trim() : (t.note ?? "").trim();
  if (note) parts.push(note);
  const tk = renderTicket(t.ticket);
  if (tk) parts.push(tk);
  const rem = renderReminder(t.reminder);
  if (rem) parts.push(rem);
  if (t.id) parts.push("^" + t.id);

  const prefix = box === null ? "- " : `- [${box}] `;
  return (prefix + parts.join(" ")).replace(/\s+$/, "");
}

/** 見出し行を組み立てる */
export function renderHeadingLine(title: string, level: number): string {
  return "#".repeat(level) + " " + (title.trim() || "(無題)");
}

/** タスク1件をマークダウンの行に */
export function renderTaskBlock(
  t: MetaSource & { body?: string[] },
  opts: BlockOptions,
  level = opts.headingLevel
): string[] {
  const out = [renderHeadingLine(t.title, level), renderMetaLine(t, opts)];
  if (t.project) out.push(renderProjectLine(t.project));
  if (t.actual?.length) out.push(renderActualLine(t.actual));
  if (t.carryFrom) out.push(renderCarryFromLine(t.carryFrom));
  if (t.carryTo) out.push(renderCarryToLine(t.carryTo));
  if (t.registered && t.registered.trim()) out.push(renderRegisteredLine(t.registered));
  if (t.doneCondition && t.doneCondition.trim()) out.push(renderDoneConditionLine(t.doneCondition));
  if (t.steps?.length) out.push(...renderStepLines(t.steps));
  if (t.result && t.result.trim()) out.push(renderResultLine(t.result));
  if (t.remaining && t.remaining.trim()) out.push(renderRemainingLine(t.remaining));
  if (t.retrospective && t.retrospective.trim()) out.push(renderRetrospectiveLine(t.retrospective));
  const body = trimBlankLines(t.body ?? []);
  if (body.length) out.push("", ...body);
  return out;
}

/** タイムラインに出す短い本文プレビュー */
export function bodyPreview(body: string[], max = 60): string {
  for (const raw of body) {
    if (parseDoneConditionLine(raw) !== null) continue; // 完了条件は別に出す
    if (parseActualLine(raw) !== null) continue; // 実績はバーとして出す
    if (parseProjectLine(raw) !== null) continue; // プロジェクトはバッジとして出す
    if (parseCarryToLine(raw) !== null || parseCarryFromLine(raw) !== null) continue; // 持ち越しもバッジ
    if (parseRegisteredLine(raw) !== null) continue; // 登録日はただのメタ情報
    const line = raw
      .replace(/^\s*[-*+]\s+(?:\[.\]\s*)?/, "") // リスト記号とチェックボックス
      .replace(/^\s*>\s?/, "") // 引用
      .replace(/^\s*#{1,6}\s+/, "") // 見出し
      .trim();
    if (!line) continue;
    return line.length > max ? line.slice(0, max) + "…" : line;
  }
  return "";
}
