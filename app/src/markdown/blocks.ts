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
 * 本文の「- ラベル: 値」の行（フィールド）の定義は fields.ts にある。
 * このファイルは Obsidian の API に依存しない（そのままテストできる）。
 */
import { minutesToHHMM } from "../util";
import { extractBlockId, isOwnId, stripBlockId } from "./id";
import {
  FIELDS,
  HEAD_FIELDS,
  RECORD_FIELDS,
  STATUS_KINDS,
  TEXT_FIELDS,
  emptyTextFields,
  matchFieldLine,
  renderFieldLine,
  type AnyField,
  type FieldKey,
  type TextFieldLines,
  type TextFieldValues,
} from "./fields";

export { STATUS_KINDS };

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

/**
 * ノート内の1タスク。
 * 1行・文字列のフィールド（完了条件・結果・期限 …）は fields.ts の定義から
 * `key`（値。無ければ ""）と `keyLine`（行番号。無ければ null）のプロパティが生える
 */
export interface TaskBlock extends TextFieldValues, TextFieldLines {
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
  /** 他者 = ボールが相手にあるもの（「- 他者: 相手 / 内容」行）。唯一の複数行フィールド */
  others: string[];
  /** 他者の行番号（文書順。無ければ []） */
  othersLines: number[];
  /** 実績（「- 実績: …」行）。無ければ [] */
  actual: ActualRange[];
  actualLine: number | null;
  /** プロジェクト（大きなタスク）ノートへのリンク先。無ければ null */
  project: string | null;
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
  /** 本文（前後の空行は落としてある。フィールド行・ステップの行も含む） */
  body: string[];
  /**
   * 詳細 = メタ行・フィールド行・ステップを除いた自由な本文。
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

/**
 * メタ行（とブロック全体）を組み立てるのに必要な情報。
 * フィールドの値（完了条件・結果 …）は新規ブロックを組み立てるときだけ使う
 */
export interface MetaSource extends Partial<TextFieldValues> {
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
  /** ステップ（新規ブロックを組み立てるときだけ使う） */
  steps?: TaskStep[];
  /** 他者（1件 = 1行） */
  others?: string[];
  actual?: ActualRange[];
  project?: string | null;
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

// ---------- フィールドの値の読み書き（ラベルと行の形は fields.ts） ----------

/** 他者の1件（「相手 / 内容」）を相手と内容に分ける。区切りが無ければ全体を内容として扱う */
export function splitOtherEntry(value: string): { who: string; what: string } {
  const v = value.trim();
  const m = /^(.*?)\s+\/\s+(.*)$/.exec(v);
  if (m) return { who: m[1].trim(), what: m[2].trim() };
  return { who: "", what: v };
}

/** 相手と内容から他者の1件を組み立てる（片方だけならその値。両方空なら ""） */
export function joinOtherEntry(who: string, what: string): string {
  const a = who.trim();
  const b = what.trim();
  if (a && b) return `${a} / ${b}`;
  return a || b;
}

/** 状態の値を「種類」と「中断理由」に分ける（「中断(理由)」以外は種類 = 値そのもの） */
export function parseStatusValue(value: string): { kind: string; reason: string } {
  const v = value.trim();
  const m = /^中断\s*[(（](.*)[)）]\s*$/.exec(v);
  if (m) return { kind: "中断", reason: m[1].trim() };
  return { kind: v, reason: "" };
}

/** 種類と中断理由から状態の値を組み立てる（種類が空なら ""） */
export function buildStatusValue(kind: string, reason: string): string {
  const k = kind.trim();
  if (!k) return "";
  const r = reason.trim();
  return k === "中断" && r ? `中断(${r})` : k;
}

/** 状態の値から中断理由を取り出す（「中断(理由)」形式でなければ値をそのまま返す） */
export function statusReason(value: string): string {
  const m = /^中断\s*[（(](.*)[）)]\s*$/.exec(value.trim());
  return m ? m[1].trim() : value.trim();
}

/** 中断理由から状態の値を組み立てる（既に「中断(…)」形式ならそのまま。空なら ""） */
export function renderStatusValue(reason: string): string {
  const t = reason.trim();
  if (!t) return "";
  return /^中断\s*[（(]/.test(t) ? t : `中断(${t})`;
}

/** 実績の時間帯（0:00 からの分）。予定とは別に「実際に作業した時間」を記録する */
export interface ActualRange {
  start: number;
  end: number;
}

/** 実績の値（"10:05 - 11:20 / 13:00 - 13:30"）を時間帯の配列に。読めない区間は読み飛ばす */
export function parseActualValue(value: string): ActualRange[] {
  const out: ActualRange[] = [];
  for (const part of value.split(/[/、,]+/)) {
    const r = RANGE_RE.exec(part.trim());
    if (!r) continue;
    const start = Math.min(Number(r[1]) * 60 + Number(r[2]), 1439);
    const end = Math.min(Number(r[3]) * 60 + Number(r[4]), 1440);
    if (end <= start) continue;
    out.push({ start, end });
  }
  return out;
}

export function renderActualValue(ranges: ActualRange[]): string {
  return ranges.map((r) => `${minutesToHHMM(r.start)} - ${minutesToHHMM(r.end)}`).join(" / ");
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

/** リンクの値（"[[Timeline/Projects/環境構築|別名]]"）からリンク先を取り出す。Wikilink でなければそのまま */
export function parseLinkValue(value: string): string {
  const v = value.trim();
  const link = /^\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/.exec(v);
  return link ? link[1].trim() : v;
}

export function renderLinkValue(linktext: string): string {
  return `[[${linktext.trim()}]]`;
}

/** 「- ラベル: 値」の行（フィールドの種類に応じて値を整形する） */
export function renderFieldLineOf(key: FieldKey, value: string | string[] | ActualRange[] | null | undefined): string[] {
  const def = FIELDS.find((f) => f.key === key) as AnyField;
  if (value === null || value === undefined) return [];
  if (def.kind === "actual") {
    const ranges = value as ActualRange[];
    return ranges.length ? [renderFieldLine(key, renderActualValue(ranges))] : [];
  }
  if (def.kind === "link") {
    const link = (value as string).trim();
    return link ? [renderFieldLine(key, renderLinkValue(link))] : [];
  }
  if ("multi" in def && def.multi) {
    return (value as string[]).filter((v) => v.trim()).map((v) => renderFieldLine(key, v));
  }
  const text = (value as string).trim();
  return text ? [renderFieldLine(key, text)] : [];
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

    // 本文の中のフィールド行（コードブロック内は除く）。
    // 1行のフィールドは最初の1行だけを採用し、2つ目以降はただの本文として扱う。他者だけは全行を拾う
    const text = emptyTextFields() as TextFieldValues & TextFieldLines;
    for (const f of TEXT_FIELDS) (text as Record<string, unknown>)[`${f.key}Line`] = null;
    const others: string[] = [];
    const othersLines: number[] = [];
    let actual: ActualRange[] = [];
    let actualLine: number | null = null;
    const links: Record<string, string | null> = { project: null, carryTo: null, carryFrom: null };
    const linkLines: Record<string, number | null> = { project: null, carryTo: null, carryFrom: null };
    const fieldLines = new Set<number>();
    let bodyFence = false;
    for (let k = mi + 1; k < end; k++) {
      if (FENCE_RE.test(lines[k])) {
        bodyFence = !bodyFence;
        continue;
      }
      if (bodyFence) continue;
      const m = matchFieldLine(lines[k]);
      if (!m) continue;
      const { def, value } = m;
      if ("multi" in def && def.multi) {
        others.push(value);
        othersLines.push(k);
        fieldLines.add(k);
        continue;
      }
      if (def.kind === "actual") {
        if (actualLine !== null) continue;
        actual = parseActualValue(value);
        actualLine = k;
        fieldLines.add(k);
        continue;
      }
      if (def.kind === "link") {
        if (linkLines[def.key] !== null) continue;
        links[def.key] = parseLinkValue(value) || null;
        linkLines[def.key] = k;
        fieldLines.add(k);
        continue;
      }
      const lineKey = `${def.key}Line`;
      if ((text as Record<string, unknown>)[lineKey] !== null) continue;
      (text as Record<string, unknown>)[def.key] = value;
      (text as Record<string, unknown>)[lineKey] = k;
      fieldLines.add(k);
    }

    // 特別なフィールド行か（ステップと詳細の領域を決めるときに読み飛ばす）
    const isFieldLine = (k: number) => fieldLines.has(k);

    // ステップ: メタ行（と完了条件・実績などのフィールド行）の直後に続くチェックリスト。空行が来るまで
    const steps: TaskStep[] = [];
    let stepsStart: number | null = null;
    let stepsEnd = mi + 1;
    {
      let k = mi + 1;
      while (k < end && (lines[k].trim() === "" || isFieldLine(k))) k++;
      if (k < end && !FENCE_RE.test(lines[k]) && parseStepLine(lines[k])) {
        stepsStart = k;
        while (k < end) {
          if (isFieldLine(k)) break;
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

    // 詳細の領域: メタ行直下の「フィールド行・ステップ・空行」のかたまりの後ろから、ブロック末尾まで
    let detailsStart = mi + 1;
    while (detailsStart < end) {
      const k = detailsStart;
      if (
        isFieldLine(k) ||
        (stepsStart !== null && k >= stepsStart && k < stepsEnd) ||
        lines[k].trim() === ""
      ) {
        detailsStart++;
        continue;
      }
      break;
    }

    tasks.push({
      ...text,
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
      others,
      othersLines,
      actual,
      actualLine,
      project: links.project,
      projectLine: linkLines.project,
      carryTo: links.carryTo,
      carryToLine: linkLines.carryTo,
      carryFrom: links.carryFrom,
      carryFromLine: linkLines.carryFrom,
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

/** フィールドの値を MetaSource から取り出す */
function fieldValueOf(t: MetaSource, key: FieldKey): string | string[] | ActualRange[] | null | undefined {
  return (t as unknown as Record<string, string | string[] | ActualRange[] | null | undefined>)[key];
}

/**
 * タスク1件をマークダウンの行に。
 * 見出し → メタ行 → head 領域のフィールド → ステップ → record 領域のフィールド → 本文、の順（fields.ts の並び）
 */
export function renderTaskBlock(
  t: MetaSource & { body?: string[] },
  opts: BlockOptions,
  level = opts.headingLevel
): string[] {
  const out = [renderHeadingLine(t.title, level), renderMetaLine(t, opts)];
  for (const f of HEAD_FIELDS) out.push(...renderFieldLineOf(f.key, fieldValueOf(t, f.key)));
  if (t.steps?.length) out.push(...renderStepLines(t.steps));
  for (const f of RECORD_FIELDS) out.push(...renderFieldLineOf(f.key, fieldValueOf(t, f.key)));
  const body = trimBlankLines(t.body ?? []);
  if (body.length) out.push("", ...body);
  return out;
}

/** タイムラインに出す短い本文プレビュー */
export function bodyPreview(body: string[], max = 60): string {
  for (const raw of body) {
    // プレビューに出さないフィールド（完了条件・実績・プロジェクト・持ち越し・登録日）は別の形で出す
    const m = matchFieldLine(raw);
    if (m && !m.def.preview) continue;
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
