/**
 * プロジェクト（大きなタスク）= 1つのノート。
 * 日々のタスクブロックが「- プロジェクト: [[...]]」行でここへリンクし、
 * メモや工程（ステップ）の置き場を1箇所にまとめる。
 */
import { App, Notice, TFile, TFolder, getIcon, moment, normalizePath, setIcon } from "obsidian";
import type { DayTimelineSettings } from "./settings";
import type { Task } from "./model";
import { newBlockId } from "./markdown/id";
import { dateKey, stripTags } from "./util";
import {
  normalizeBlockOptions,
  parseBlockDocument,
  type BlockOptions,
  type TaskBlock,
  type TicketRef,
} from "./markdown/blocks";

export interface ProjectRef {
  /** リンクに書く文字列（フォルダ付き・拡張子なし） */
  linktext: string;
  /** 表示名（ファイル名） */
  name: string;
  /** ノート自身が完了か（frontmatter の `done: true`。選択肢の絞り込み用。書き込み直後は少し遅れることがある） */
  done?: boolean;
  /** グループ名（frontmatter の group。無ければ null） */
  group?: string | null;
}

// ---------- プロジェクト自身の項目（期日・チケット・ドキュメント） ----------
// 子タスクと同じ「- ラベル: 値」の行で、プロジェクトノート自身にも持たせられる。
// テンプレートに空の行（「- 期日: 」など）を入れておけば、あとから書き足すだけでよい

/** ドキュメント行の1項目（プロジェクトに結びつけた資料へのリンク） */
export interface ProjectDoc {
  /** 開く先（Wikilink のリンク先、または URL） */
  target: string;
  /** 表示名（別名があればそれ、無ければファイル名 / URL） */
  label: string;
  /** http(s) の外部リンクか（ブラウザで開く） */
  external: boolean;
}

/** プロジェクトノート自身が持つ項目 */
export interface ProjectFields {
  /** 期日（書かれたままの文字列。無ければ ""） */
  due: string;
  /** 期日を日付として読めたもの（読めなければ null） */
  dueDate: Date | null;
  /** チケット（「- チケット: redmine#65130」行）。無ければ null */
  ticket: TicketRef | null;
  /** ドキュメント（「- ドキュメント: [[設計書]] …」行。複数行・複数リンク可） */
  docs: ProjectDoc[];
}

const DUE_RE = /^\s*(?:[-*+]\s+)?(?:\*\*)?期日(?:\*\*)?\s*[:：]\s*(.*?)\s*$/;
const TICKET_LINE_RE = /^\s*(?:[-*+]\s+)?(?:\*\*)?チケット(?:\*\*)?\s*[:：]\s*(.*?)\s*$/;
const DOC_LINE_RE = /^\s*(?:[-*+]\s+)?(?:\*\*)?(?:ドキュメント|資料)(?:\*\*)?\s*[:：]\s*(.*?)\s*$/;

/** 期日の行なら中身を返す（空でも ""）。違えば null */
export function parseDueLine(line: string): string | null {
  const m = DUE_RE.exec(line);
  return m ? m[1] : null;
}

/** 期日の値として受け付ける書き方 */
const DUE_FORMATS = [
  "YYYY-MM-DD",
  "YYYY-M-D",
  "YYYY/M/D",
  "YYYY.M.D",
  "YYYY年M月D日",
  "M/D",
  "M月D日",
];

/** 期日の値を日付にする（[[2026-09-15]] のようなリンクも可）。読めなければ null */
export function parseDueDate(v: string): Date | null {
  let t = v.trim();
  const link = /^\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/.exec(t);
  if (link) t = (link[1].split("/").pop() ?? link[1]).trim();
  const m = moment(t, DUE_FORMATS, true);
  return m.isValid() ? m.startOf("day").toDate() : null;
}

/** チケットの行なら中身を返す（空でも ""）。違えば null */
export function parseTicketLine(line: string): string | null {
  const m = TICKET_LINE_RE.exec(line);
  return m ? m[1] : null;
}

/** チケットの値（"redmine#65130" / "#65130" / "65130" / "🎫redmine#65130"）を読む */
export function parseTicketValue(v: string): TicketRef | null {
  const t = v.replace(/^🎫/, "").trim();
  if (!t) return null;
  const m = /^([\p{L}\p{N}_.-]*)#(\S+)$/u.exec(t);
  if (m) return { tracker: m[1], id: m[2] };
  if (/^[\p{L}\p{N}_.-]+$/u.test(t)) return { tracker: "", id: t };
  return null;
}

/** ドキュメントの行なら中身を返す（空でも ""）。違えば null */
export function parseDocLine(line: string): string | null {
  const m = DOC_LINE_RE.exec(line);
  return m ? m[1] : null;
}

/** リンク先文字列からドキュメントの表示名（#見出しを除いたファイル名）を作る */
function docLabel(target: string): string {
  const path = target.split("#")[0] || target;
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.md$/, "") || target;
}

/** ドキュメントの値から [[Wikilink]]・[名前](URL)・裸の URL を拾う。どれも無ければ値ごと1件にする */
export function parseDocValue(v: string): ProjectDoc[] {
  const out: ProjectDoc[] = [];
  let rest = v;
  rest = rest.replace(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_a, target: string, alias?: string) => {
    const t = target.trim();
    if (t) out.push({ target: t, label: (alias ?? "").trim() || docLabel(t), external: false });
    return " ";
  });
  rest = rest.replace(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, (_a, label: string, url: string) => {
    out.push({ target: url, label: label.trim() || url, external: true });
    return " ";
  });
  rest = rest.replace(/https?:\/\/\S+/g, (url) => {
    out.push({ target: url, label: url, external: true });
    return " ";
  });
  // リンクを1つも拾えなかったときだけ、値そのものを1件として扱う（パスの / は触らない）
  if (!out.length) {
    const leftover = rest.replace(/\s+/g, " ").trim();
    if (leftover) out.push({ target: leftover, label: docLabel(leftover), external: false });
  }
  return out;
}

const FENCE_RE = /^\s*(?:```|~~~)/;

/**
 * プロジェクトノートから期日・チケット・ドキュメントを読む。
 * frontmatter とコードブロックの外なら、ノートのどこに書いてもよい
 * （期日・チケットは最初の行、ドキュメントは全行分を集める）
 */
export function extractProjectFields(content: string): ProjectFields {
  const lines = content.split(/\r?\n/);
  let start = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, i) => i > 0 && (l.trim() === "---" || l.trim() === "..."));
    if (end > 0) start = end + 1;
  }
  let due = "";
  let dueDate: Date | null = null;
  let ticket: TicketRef | null = null;
  const docs: ProjectDoc[] = [];
  let fence = false;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE_RE.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    if (!due) {
      const d = parseDueLine(line);
      if (d !== null) {
        due = d;
        dueDate = d ? parseDueDate(d) : null;
        continue;
      }
    }
    if (!ticket) {
      const t = parseTicketLine(line);
      if (t !== null) {
        ticket = parseTicketValue(t);
        continue;
      }
    }
    const dv = parseDocLine(line);
    if (dv !== null) docs.push(...parseDocValue(dv));
  }
  return { due, dueDate, ticket, docs };
}

/** プロジェクトノートの frontmatter でグループ名を持つキー */
const GROUP_KEY = "group";

// ---------- frontmatter（完了・完了日・進捗） ----------
// プロジェクトの完了は frontmatter の `done`（真偽値）が正。Obsidian の Bases など、本文を読めない
// 機能からも完了を扱えるようにするため。本文先頭のメタ行（`- [ ] ^id`）は ID としてだけ使い、
// チェックの有無は見ない（双方向の同期はしない。目印は 1 つだけ）

/** 完了（true / false） */
export const DONE_KEY = "done";
/** 完了にした日（YYYY-MM-DD）。未完了に戻すと消える */
export const COMPLETED_KEY = "completed";
/** 移行前に使われていた「状態」のキー（`status: done`）。移行コマンドが `done` に置き換えて削除する */
export const STATUS_KEY = "status";
/** 期日（YYYY-MM-DD）。本文の「- 期日:」行から写す */
export const DUE_KEY = "due";
/** タスク表の進捗（タスク表を更新するたびに書く） */
export const PROGRESS_KEYS = {
  total: "tasks_total",
  done: "tasks_done",
  lastDone: "last_done",
  nextTask: "next_task",
} as const;

/** frontmatter の値が「完了」か（YAML の真偽値 true だけを完了とみなす。文字列 "true" は不可） */
export function isDoneValue(v: unknown): boolean {
  return v === true;
}

/** frontmatter の `status` が「完了」を表すか（移行用。`done` / `完了` を受け付ける） */
export function isStatusDone(v: unknown): boolean {
  if (typeof v !== "string") return false;
  const t = v.trim().toLowerCase();
  return t === "done" || t === "完了";
}

/** ノート先頭の frontmatter ブロックの行範囲（開始行と終了行）。無ければ null */
function frontmatterRange(lines: string[]): { open: number; close: number } | null {
  if (lines[0]?.trim() !== "---") return null;
  const close = lines.findIndex((l, i) => i > 0 && (l.trim() === "---" || l.trim() === "..."));
  return close > 0 ? { open: 0, close } : null;
}

/**
 * ノートの内容から frontmatter の 1 行の値（`key: 値` の値の部分）を読む（純関数）。
 * キーが無ければ null。入れ子や複数行の値は扱わない（このプラグインが書くキーは 1 行だけ）
 */
export function frontmatterValueOf(content: string, key: string): string | null {
  const lines = content.split(/\r?\n/);
  const range = frontmatterRange(lines);
  if (!range) return null;
  const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*(.*?)\\s*$`);
  for (let i = 1; i < range.close; i++) {
    const m = re.exec(lines[i]);
    if (m) return m[1];
  }
  return null;
}

/**
 * ノートの内容から frontmatter の `done` を読む（純関数）。
 * `done: true` なら true、それ以外（false・未設定・frontmatter なし）は false。
 * メタデータキャッシュの更新を待たずに、書き込み直後のノートでも同じ判定ができるようにするためのもの
 */
export function readFrontmatterDone(content: string): boolean {
  return frontmatterValueOf(content, DONE_KEY)?.toLowerCase() === "true";
}

/**
 * 新しいプロジェクトノートの内容に `done: false` を入れる（純関数）。
 * frontmatter があれば `done` が無いときだけ末尾に足し、無ければ先頭に frontmatter を作る
 */
export function ensureFrontmatterDone(content: string): string {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  const range = frontmatterRange(lines);
  if (!range) return `---${eol}${DONE_KEY}: false${eol}---${eol}` + content;
  for (let i = 1; i < range.close; i++) if (/^done\s*:/.test(lines[i])) return content;
  lines.splice(range.close, 0, `${DONE_KEY}: false`);
  return lines.join(eol);
}

/** タスク表の進捗（frontmatter に書く値）。last_done / next_task は無ければ null（キーを削除する） */
export interface ProjectProgress {
  /** 表にあるタスク数 */
  total: number;
  /** 完了（✅。持ち越し先で完了した ✅▶ も含む）のタスク数 */
  done: number;
  /** 最後に完了したタスク（`YYYY-MM-DD タスク名`）。日付ありの完了タスクが無ければ null */
  lastDone: string | null;
  /** 次にやる未完了のタスク（`YYYY-MM-DD タスク名`。日付未定だけなら `未定 タスク名`）。無ければ null */
  nextTask: string | null;
}

/** タスク名をリンク記法（[[パス|別名]]・[名前](URL)）とタグを外した表示名だけにする */
export function plainTaskTitle(title: string): string {
  const t = stripTags(title)
    .replace(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_a, target: string, alias?: string) => {
      const a = (alias ?? "").trim();
      if (a) return a;
      const base = target.split("#")[0].split("/").pop() ?? target;
      return base.replace(/\.md$/, "").trim() || target;
    })
    .replace(/\[([^\]]*)\]\((?:https?:\/\/)?[^)\s]*\)/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
  return t || "(無題)";
}

/**
 * 子タスクからタスク表の進捗を集計する（純関数。タスク表と同じ子タスクを渡す）。
 * - 完了数はタスク表で ✅ になる行（自身が完了、または持ち越し先で完了）
 * - 最後に完了したタスク = 自身が完了で日付ありのうち、日付（同日なら開始時刻）がいちばん遅いもの
 * - 次のタスク = 未完了（持ち越し済み [>] は閉じた記録なので除く）のうち日付がいちばん早いもの。
 *   日付ありを優先し、日付未定しか無ければ `未定 タスク名`
 */
export function buildProgress(children: ProjectChild[]): ProjectProgress {
  markSettledByCarry(children);
  const rows = sortChildren(children);
  const done = rows.filter((c) => isChildSettled(c)).length;
  const label = (c: ProjectChild) => `${c.date ? dateKey(c.date) : "未定"} ${plainTaskTitle(c.task.title)}`;
  const finished = rows.filter((c) => c.task.done && c.date);
  const lastDone = finished.length ? label(finished[finished.length - 1]) : null;
  const next = rows.find((c) => !c.task.done && !c.task.forwarded);
  return { total: rows.length, done, lastDone, nextTask: next ? label(next) : null };
}

/** frontmatter のグループ値を正規化。trim して空なら null（配列は先頭、数値は文字列として扱う） */
function normalizeGroup(v: unknown): string | null {
  if (Array.isArray(v)) v = v[0];
  if (typeof v === "number") v = String(v);
  if (typeof v !== "string") return null;
  const g = v.trim();
  return g || null;
}

/** プロジェクトに結びついた子タスク */
export interface ProjectChild {
  /** 子タスクの日付（Inbox のタスクは null） */
  date: Date | null;
  /** 子タスクがあるノートのパス */
  path: string;
  task: Task;
  /** 誰の予定か（null = 自分） */
  owner: string | null;
  /**
   * 持ち越し済み [>] で、持ち越し先（鎖の末端）が完了しているか。
   * 引き継いだ先で終わった仕事なので、一覧では完了として見せる（summarize が付ける）
   */
  settledByCarry?: boolean;
}

/** 子タスクが「片付いた」か: 自身が完了、または持ち越し先で完了している */
export function isChildSettled(c: ProjectChild): boolean {
  return c.task.done || c.settledByCarry === true;
}

/** "path#^id" 形式のリンクを「.md 抜きのパス」と「ブロックID」に分ける。ID が無ければ null */
function splitBlockLink(link: string): { path: string; id: string } | null {
  const i = link.indexOf("#^");
  if (i < 0) return null;
  const path = link.slice(0, i).trim().replace(/\.md$/, "");
  const id = link.slice(i + 2).trim();
  return path && id ? { path, id } : null;
}

/**
 * 持ち越し済み [>] の子タスクについて、持ち越し先の鎖をたどって末端が完了していれば
 * settledByCarry を立てる。続きのブロックはプロジェクトを引き継ぐので同じ children の中にある。
 * リンクは手書きの短い形（[[2026-09-03#^id]]）も読めるよう、フルパスで見つからなければ末尾の名前で照合する
 */
export function markSettledByCarry(children: ProjectChild[]): void {
  const byFull = new Map<string, ProjectChild>();
  const byBase = new Map<string, ProjectChild>();
  for (const c of children) {
    const id = c.task.blockId;
    if (!id) continue;
    const path = c.path.replace(/\.md$/, "");
    byFull.set(`${path}#^${id}`, c);
    const base = path.split("/").pop() ?? path;
    if (!byBase.has(`${base}#^${id}`)) byBase.set(`${base}#^${id}`, c);
  }
  const follow = (link: string): ProjectChild | null => {
    const parts = splitBlockLink(link);
    if (!parts) return null;
    const full = byFull.get(`${parts.path}#^${parts.id}`);
    if (full) return full;
    const base = parts.path.split("/").pop() ?? parts.path;
    return byBase.get(`${base}#^${parts.id}`) ?? null;
  };
  for (const c of children) {
    c.settledByCarry = false;
    if (!c.task.forwarded || !c.task.carryTo) continue;
    // 鎖をたどる（当日内 → 翌日 → … と続くこともある）。輪になっていたら打ち切る
    const seen = new Set<ProjectChild>([c]);
    let cur: ProjectChild | null = follow(c.task.carryTo);
    while (cur && !seen.has(cur)) {
      if (cur.task.done) {
        c.settledByCarry = true;
        break;
      }
      if (!cur.task.forwarded || !cur.task.carryTo) break;
      seen.add(cur);
      cur = follow(cur.task.carryTo);
    }
  }
}

/** プロジェクトの集計（パネルとノート内一覧に使う） */
export interface ProjectSummary {
  ref: ProjectRef;
  children: ProjectChild[];
  planMin: number;
  actMin: number;
  doneCount: number;
  /** プロジェクト自身（frontmatter の `done`）が完了か。完了済はパネルに出さない */
  done?: boolean;
  /** プロジェクト自身の期日・チケット・ドキュメント（ノートから読む） */
  fields?: ProjectFields;
}

export function summarize(ref: ProjectRef, children: ProjectChild[]): ProjectSummary {
  markSettledByCarry(children);
  let planMin = 0;
  let actMin = 0;
  let doneCount = 0;
  for (const c of children) {
    if (c.task.start !== null && c.task.end !== null) planMin += c.task.end - c.task.start;
    actMin += c.task.actual.reduce((n, r) => n + (r.end - r.start), 0);
    // 持ち越し先で完了した [>] も「片付いた」として数える（引き継いだ先で終わった仕事）
    if (isChildSettled(c)) doneCount++;
  }
  return { ref, children, planMin, actMin, doneCount };
}

/** グループごとにまとめたプロジェクト（パネルのツリー用） */
export interface ProjectGroup {
  /** グループ名（null = 未分類） */
  name: string | null;
  items: ProjectSummary[];
}

/**
 * プロジェクトをグループごとにまとめる。グループの並びは order（設定の表示順）が先、
 * 載っていないものは名前順、グループなし（未分類）は常に末尾。
 * 各グループ内は受け取った順（list() の名前順）のまま
 */
export function groupProjects(sums: ProjectSummary[], order: string[]): ProjectGroup[] {
  const buckets = new Map<string | null, ProjectSummary[]>();
  for (const s of sums) {
    const g = s.ref.group ?? null;
    const b = buckets.get(g);
    if (b) b.push(s);
    else buckets.set(g, [s]);
  }
  const pos = new Map(order.map((n, i) => [n.trim(), i] as const));
  const names = [...buckets.keys()].filter((n): n is string => n !== null);
  names.sort((a, b) => {
    const pa = pos.get(a);
    const pb = pos.get(b);
    if (pa !== undefined || pb !== undefined) {
      if (pa === undefined) return 1;
      if (pb === undefined) return -1;
      return pa - pb;
    }
    return a.localeCompare(b, "ja");
  });
  const out: ProjectGroup[] = names.map((n) => ({ name: n, items: buckets.get(n)! }));
  const rest = buckets.get(null);
  if (rest) out.push({ name: null, items: rest });
  return out;
}

/**
 * グループ名の候補（付け替えメニュー用）: 設定の並び順のもの（未使用でも出す）＋ 使用中のもの。
 * 並びは groupProjects と同じ約束
 */
export function knownGroupNames(refs: { group?: string | null }[], order: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of order) {
    const g = raw.trim();
    if (g && !seen.has(g)) {
      seen.add(g);
      out.push(g);
    }
  }
  const used: string[] = [];
  for (const r of refs) {
    const g = r.group ?? null;
    if (g && !seen.has(g)) {
      seen.add(g);
      used.push(g);
    }
  }
  used.sort((a, b) => a.localeCompare(b, "ja"));
  return [...out, ...used];
}

/**
 * グループのアイコンを el に描画する。Lucide のアイコン名（briefcase など）ならそのアイコン、
 * それ以外（絵文字など）はそのままテキストとして出す
 */
export function renderGroupIcon(el: HTMLElement, icon: string): void {
  if (getIcon(icon)) setIcon(el, icon);
  else el.setText(icon);
}

/** 子タスクを日付順（Inbox は末尾）→ 開始時刻順に並べる */
export function sortChildren(children: ProjectChild[]): ProjectChild[] {
  return [...children].sort((a, b) => {
    if (!a.date && !b.date) return 0;
    if (!a.date) return 1;
    if (!b.date) return -1;
    const d = a.date.getTime() - b.date.getTime();
    if (d) return d;
    return (a.task.start ?? 1441) - (b.task.start ?? 1441);
  });
}

// ---------- プロジェクトノート内の「タスク」一覧（自動更新セクション） ----------

const SECTION_START = "<!-- dt-project-tasks:start -->";
const SECTION_END = "<!-- dt-project-tasks:end -->";

/** 分を "6:30" のような時:分表示に。0 は "–" */
function hmm(min: number): string {
  if (!min) return "–";
  return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}`;
}

function cell(text: string): string {
  return text.replace(/\|/g, "／").replace(/\r?\n/g, " ");
}

const WEEKDAY_JA = ["日", "月", "火", "水", "木", "金", "土"];

/** プロジェクトノートへ書き込む「タスク」セクションの行（マーカー含む） */
export function buildTaskListSection(children: ProjectChild[]): string[] {
  markSettledByCarry(children);
  const rows = sortChildren(children);
  const lines = [SECTION_START, "## タスク", ""];
  if (!rows.length) {
    lines.push("（このプロジェクトに結びついたタスクはまだありません）");
  } else {
    lines.push("| 完了 | 日付 | タスク | 予定 | 実績 |", "| :-: | --- | --- | ---: | ---: |");
    let planTotal = 0;
    let actTotal = 0;
    for (const c of rows) {
      const t = c.task;
      const plan = t.start !== null && t.end !== null ? t.end - t.start : 0;
      const act = t.actual.reduce((n, r) => n + (r.end - r.start), 0);
      planTotal += plan;
      actTotal += act;
      const dateLabel = c.date
        ? `${c.date.getMonth() + 1}/${c.date.getDate()} (${WEEKDAY_JA[c.date.getDay()]})`
        : "Inbox";
      const title = cell(stripTags(t.title) || "(無題)");
      const linkBase = c.path.replace(/\.md$/, "");
      const titleCell = t.blockId ? `[[${linkBase}#^${t.blockId}\\|${title}]]` : title;
      lines.push(
        // 持ち越し先で完了した [>] は ✅▶（完了扱いだが続きへ引き継いだ記録だと分かるように）
        `| ${t.done ? "✅" : c.settledByCarry ? "✅▶" : t.forwarded ? "▶" : "⬜"} | ${dateLabel} | ${titleCell} | ${hmm(plan)} | ${hmm(act)} |`
      );
    }
    lines.push(`| | | **合計（${rows.length}件）** | **${hmm(planTotal)}** | **${hmm(actTotal)}** |`);
  }
  lines.push(SECTION_END);
  return lines;
}

/**
 * プロジェクトノートの自動更新セクションを差し替える。
 * マーカーが無ければ末尾に追加する
 */
export function upsertTaskListSection(content: string, section: string[]): string {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === SECTION_START);
  const end = start >= 0 ? lines.findIndex((l, i) => i > start && l.trim() === SECTION_END) : -1;
  if (start >= 0 && end > start) {
    lines.splice(start, end - start + 1, ...section);
  } else {
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    if (lines.length) lines.push("");
    lines.push(...section);
  }
  return lines.join(eol).replace(/(\r?\n)*$/, "") + eol;
}

/** リンク先文字列から表示名（ファイル名部分）を取り出す */
export function projectDisplayName(linktext: string): string {
  const base = linktext.split("/").pop() ?? linktext;
  return base.replace(/\.md$/, "");
}

/**
 * メタ行（`- [ ] ^id`）の無い手作りのプロジェクトノートに meta 行を差し込む（純関数）。
 * 先頭の見出し（# / ##）の直後に入れる。見出しより前に本文があるか見出しが無ければ、
 * フロントマターの直後に「# 名前」ごと足す
 */
export function insertSelfMeta(content: string, name: string, meta: string): string {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  // フロントマター（--- ... ---)は飛ばす
  let start = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
    if (end > 0) start = end + 1;
  }
  for (let i = start; i < lines.length; i++) {
    if (/^#{1,2}\s/.test(lines[i])) {
      lines.splice(i + 1, 0, meta);
      return lines.join(eol);
    }
    if (lines[i].trim() !== "") break;
  }
  lines.splice(start, 0, `# ${name}`, meta);
  return lines.join(eol);
}

/** frontmatter を飛ばした本文の最初の行番号 */
function bodyStart(lines: string[]): number {
  if (lines[0]?.trim() !== "---") return 0;
  const end = lines.findIndex((l, i) => i > 0 && (l.trim() === "---" || l.trim() === "..."));
  return end > 0 ? end + 1 : 0;
}

/**
 * 「テンプレートを作成」で書き出すサンプル。
 * {{name}} はプロジェクト名に置き換わる。メタ行（ID）と frontmatter の done: false は作成時に自動で入る
 */
export const PROJECT_TEMPLATE_SAMPLE = `# {{name}}
- 期日:
- チケット:
- ドキュメント:

## メモ

`;

export class ProjectStore {
  constructor(
    private app: App,
    private getSettings: () => DayTimelineSettings
  ) {}

  /** プロジェクトノートを置くフォルダ（既定: <フォルダ>/Projects） */
  folder(): string {
    const s = this.getSettings();
    const custom = s.projectsFolder.trim();
    if (custom) return normalizePath(custom);
    return normalizePath((s.folder ? s.folder + "/" : "") + "Projects");
  }

  /** 設定「プロジェクトのテンプレート」のパス（.md 付き）。未設定なら null */
  templatePath(): string | null {
    const raw = this.getSettings().projectTemplatePath.trim();
    if (!raw) return null;
    let p = normalizePath(raw);
    if (!p.endsWith(".md")) p += ".md";
    return p;
  }

  /** プロジェクトの一覧（フォルダ内の .md ファイル）。名前順。テンプレート自身は除く */
  list(): ProjectRef[] {
    const folder = this.app.vault.getAbstractFileByPath(this.folder());
    if (!(folder instanceof TFolder)) return [];
    const tpl = this.templatePath();
    const out: ProjectRef[] = [];
    for (const f of folder.children) {
      if (f instanceof TFile && f.extension === "md" && f.path !== tpl) {
        out.push({
          linktext: f.path.replace(/\.md$/, ""),
          name: f.basename,
          done: this.isDoneCached(f),
          group: normalizeGroup(this.frontmatterOf(f)[GROUP_KEY]),
        });
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, "ja"));
  }

  /** メタデータキャッシュにある frontmatter（無ければ空のオブジェクト） */
  private frontmatterOf(file: TFile): Record<string, unknown> {
    return (this.app.metadataCache.getFileCache(file)?.frontmatter ?? {}) as Record<string, unknown>;
  }

  /**
   * frontmatter の `done: true` が付いているかをメタデータキャッシュから読む。
   * list() を同期のままにするための近道で、書き込み直後の判定は selfState()（ノートを読む）が行う
   */
  private isDoneCached(file: TFile): boolean {
    return isDoneValue(this.frontmatterOf(file)[DONE_KEY]);
  }

  /**
   * ノート先頭のチェック（メタ行 `- [x] ^id`）が付いているか（移行コマンド用。完了判定にはもう使わない）。
   * ブロックID（^id）付きのチェック行だけをメタ行とみなす（手書きのチェックリストと区別する）
   */
  private legacyCheckDone(content: string): boolean {
    return this.findSelf(content)?.block.done === true;
  }

  /**
   * 名前からプロジェクトノートを作る（既にあればそのまま使う）。
   * 設定「プロジェクトのテンプレート」があればその内容から、無ければ最小の雛形で作る。
   * どちらもタスクブロックと同じ文法（見出し + メタ行）になるので、後から集計にも使える。
   * group を渡すとそのグループに入れる。作れなければ null
   */
  async create(name: string, group?: string | null): Promise<string | null> {
    const safe = name
      .trim()
      .replace(/[\\/:*?"<>|#^[\]]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!safe) return null;
    const dir = this.folder();
    await this.ensureFolder(dir);
    const path = normalizePath(`${dir}/${safe}.md`);
    if (!this.app.vault.getAbstractFileByPath(path)) {
      const content = await this.initialContent(safe, group?.trim() || null);
      try {
        await this.app.vault.create(path, content);
      } catch (e) {
        if (!this.app.vault.getAbstractFileByPath(path)) {
          console.error(e);
          return null;
        }
      }
    }
    const link = path.replace(/\.md$/, "");
    if (group?.trim()) await this.setGroup(link, group);
    return link;
  }

  /**
   * 新しいプロジェクトノートの中身。テンプレートのプレースホルダー
   * （{{name}} / {{title}}・{{date}}・{{time}}・{{group}}）を置き換え、
   * メタ行（`- [ ] ^id` = プロジェクトの ID）が無ければ見出しの直下に書き足し、frontmatter に `done: false` を入れる
   */
  private async initialContent(name: string, group: string | null): Promise<string> {
    let content = "";
    const tplPath = this.templatePath();
    if (tplPath) {
      const tf = this.app.vault.getAbstractFileByPath(tplPath);
      if (tf instanceof TFile) content = await this.app.vault.read(tf);
      else new Notice(`プロジェクトのテンプレート「${tplPath}」が見つからないため、既定の雛形で作成します`);
    }
    if (!content.trim()) content = `# ${name}\n\n`;
    content = content
      .replace(/\{\{\s*(?:name|title)\s*\}\}/gi, name)
      .replace(/\{\{\s*date\s*(?::\s*([^}]+?)\s*)?\}\}/gi, (_a, fmt: string | undefined) =>
        moment().format(fmt || "YYYY-MM-DD")
      )
      .replace(/\{\{\s*time\s*(?::\s*([^}]+?)\s*)?\}\}/gi, (_a, fmt: string | undefined) =>
        moment().format(fmt || "HH:mm")
      )
      .replace(/\{\{\s*group\s*\}\}/gi, group ?? "");
    if (!this.findSelf(content)) content = insertSelfMeta(content, name, `- [ ] ^${newBlockId()}`);
    // 完了の正は frontmatter の done。テンプレートに無ければ `done: false` を入れておく（group と同じ場所）
    content = ensureFrontmatterDone(content);
    if (!content.endsWith("\n")) content += "\n";
    return content;
  }

  /**
   * テンプレートファイルが無ければサンプルを作って返す（設定画面のボタンから）。
   * パスが未設定なら null
   */
  async ensureTemplate(): Promise<TFile | null> {
    const path = this.templatePath();
    if (!path) return null;
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) return existing;
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    await this.ensureFolder(dir);
    try {
      return await this.app.vault.create(path, PROJECT_TEMPLATE_SAMPLE);
    } catch (e) {
      const raced = this.app.vault.getAbstractFileByPath(path);
      if (raced instanceof TFile) return raced;
      console.error(e);
      return null;
    }
  }

  /** プロジェクトノート自身のタスクブロック（見出し + メタ行）を探す */
  private findSelf(content: string): { block: TaskBlock; opts: BlockOptions } | null {
    // スケルトンは「# 名前」だが、手書きのノートで見出しレベルが違う場合にも備える
    for (const level of [1, 2]) {
      const opts = normalizeBlockOptions({
        headingLevel: level,
        rootHeading: "",
        useCheckbox: true,
        mirrorTitle: false,
      });
      const doc = parseBlockDocument(content, opts);
      if (doc.tasks.length) return { block: doc.tasks[0], opts };
    }
    return null;
  }

  /** リンク先のノートを探す（フルパスでなければ Obsidian のリンク解決に任せる） */
  private resolveFile(linktext: string): TFile | null {
    const byPath = this.app.vault.getAbstractFileByPath(linktext + ".md");
    if (byPath instanceof TFile) return byPath;
    return this.app.metadataCache.getFirstLinkpathDest(linktext, "");
  }

  /** プロジェクト自身が完了か（frontmatter の `done: true`）。ノートが見つからなければ null */
  async isDone(linktext: string): Promise<boolean | null> {
    const file = this.resolveFile(linktext);
    if (!(file instanceof TFile)) return null;
    const content = await this.app.vault.cachedRead(file);
    return readFrontmatterDone(content);
  }

  /**
   * プロジェクト自身の状態（完了 + 期日・チケット・ドキュメント）を1回の読み込みで取る。
   * 完了はノートの内容から読む（書き込み直後のメタデータキャッシュの遅れを避ける）
   */
  async selfState(linktext: string): Promise<{ done: boolean; fields: ProjectFields } | null> {
    const file = this.resolveFile(linktext);
    if (!(file instanceof TFile)) return null;
    const content = await this.app.vault.cachedRead(file);
    return {
      done: readFrontmatterDone(content),
      fields: extractProjectFields(content),
    };
  }

  /**
   * プロジェクトの完了を frontmatter に書く。完了なら `done: true` と `completed: YYYY-MM-DD`（今日）、
   * 未完了に戻すなら `done: false` にして `completed` を消す。本文（メタ行の ^id を含む）には触らず、
   * 他の property もそのまま。既に同じ値ならノートを書き換えない
   */
  async setDone(linktext: string, done: boolean): Promise<boolean> {
    const file = this.resolveFile(linktext);
    if (!(file instanceof TFile)) return false;
    const today = dateKey(new Date());
    const same = (fm: Record<string, unknown>) =>
      done
        ? isDoneValue(fm[DONE_KEY]) && typeof fm[COMPLETED_KEY] === "string" && !!fm[COMPLETED_KEY]
        : fm[DONE_KEY] === false && fm[COMPLETED_KEY] === undefined;
    if (same(this.frontmatterOf(file)) && readFrontmatterDone(await this.app.vault.cachedRead(file)) === done) {
      return true;
    }
    return this.processFrontMatter(file, (fm) => {
      if (same(fm)) return;
      fm[DONE_KEY] = done;
      if (done) fm[COMPLETED_KEY] = today;
      else delete fm[COMPLETED_KEY];
    });
  }

  /** 開いているノートなどがプロジェクトノート（プロジェクトのフォルダ直下の .md。テンプレート以外）か */
  isProjectFile(file: TFile | null | undefined): file is TFile {
    if (!(file instanceof TFile) || file.extension !== "md") return false;
    if (file.path === this.templatePath()) return false;
    return file.parent?.path === this.folder();
  }

  /**
   * 「プロジェクトの完了状態を frontmatter に移す」: フォルダ直下の全プロジェクトノートを走査し、
   * `done` が無いノートには 先頭チェックが `[x]` か `status: done` なら `done: true`、それ以外は `done: false` を書く。
   * `status` キーは（`done` に置き換わるので）削除する。group と ^id は変えない
   */
  async migrateDoneToFrontmatter(): Promise<{ done: number; notDone: number; unchanged: number; statusRemoved: number }> {
    const result = { done: 0, notDone: 0, unchanged: 0, statusRemoved: 0 };
    for (const ref of this.list()) {
      const file = this.resolveFile(ref.linktext);
      if (!(file instanceof TFile)) continue;
      const cached = this.frontmatterOf(file);
      const content = await this.app.vault.cachedRead(file);
      // キャッシュが古いことがあるので、ノートの内容でも `done` の有無を確かめる
      const hasDone = DONE_KEY in cached || frontmatterValueOf(content, DONE_KEY) !== null;
      const hasStatus = STATUS_KEY in cached || frontmatterValueOf(content, STATUS_KEY) !== null;
      if (hasDone && !hasStatus) {
        result.unchanged++;
        continue;
      }
      const value = hasDone
        ? null
        : this.legacyCheckDone(content) ||
          isStatusDone(cached[STATUS_KEY] ?? frontmatterValueOf(content, STATUS_KEY) ?? undefined);
      const ok = await this.processFrontMatter(file, (fm) => {
        if (value !== null && fm[DONE_KEY] === undefined) fm[DONE_KEY] = value;
        delete fm[STATUS_KEY];
      });
      if (!ok) continue;
      if (hasStatus) result.statusRemoved++;
      if (value === null) result.unchanged++;
      else if (value) result.done++;
      else result.notDone++;
    }
    return result;
  }

  /**
   * タスク表の進捗（tasks_total / tasks_done / last_done / next_task）と、本文の期日（due）を frontmatter に書く。
   * タスク表（dt-project-tasks）を更新するタイミングで呼ぶ。値が同じならノートを書き換えない。
   * `next`（人が手で書く「次にやること」）など他の property には触らない
   */
  async writeProgress(linktext: string, progress: ProjectProgress, fields?: ProjectFields): Promise<boolean> {
    const file = this.resolveFile(linktext);
    if (!(file instanceof TFile)) return false;
    const due = fields?.dueDate ? dateKey(fields.dueDate) : undefined;
    const apply = (fm: Record<string, unknown>): boolean => {
      let changed = false;
      const set = (key: string, v: string | number | undefined) => {
        if (v === undefined) {
          if (key in fm) {
            delete fm[key];
            changed = true;
          }
        } else if (fm[key] !== v) {
          fm[key] = v;
          changed = true;
        }
      };
      set(PROGRESS_KEYS.total, progress.total);
      set(PROGRESS_KEYS.done, progress.done);
      set(PROGRESS_KEYS.lastDone, progress.lastDone ?? undefined);
      set(PROGRESS_KEYS.nextTask, progress.nextTask ?? undefined);
      // 期日は本文にあるときだけ写す（無いときは手書きの値を消さない）
      if (due !== undefined) set(DUE_KEY, due);
      return changed;
    };
    // キャッシュの値と同じなら書かない（キャッシュが古いときは書いてしまうが害はない）
    if (!apply({ ...this.frontmatterOf(file) })) return true;
    return this.processFrontMatter(file, (fm) => void apply(fm));
  }

  /** processFrontMatter の薄い包み（失敗はログに出して false） */
  private async processFrontMatter(file: TFile, fn: (fm: Record<string, unknown>) => void): Promise<boolean> {
    try {
      await this.app.fileManager.processFrontMatter(file, fn);
      return true;
    } catch (e) {
      console.error(e);
      return false;
    }
  }

  /** プロジェクトのグループを付け替える（frontmatter の group を書き換える。null で外す） */
  async setGroup(linktext: string, group: string | null): Promise<boolean> {
    const file = this.resolveFile(linktext);
    if (!(file instanceof TFile)) return false;
    const g = group?.trim() || null;
    return this.processFrontMatter(file, (fm) => {
      if (g) fm[GROUP_KEY] = g;
      else delete fm[GROUP_KEY];
    });
  }

  /** プロジェクトノートを開く */
  async open(linktext: string): Promise<void> {
    try {
      await this.app.workspace.openLinkText(linktext, "", false);
    } catch (e) {
      console.error(e);
      new Notice("プロジェクトノートを開けませんでした: " + String(e));
    }
  }

  private async ensureFolder(dir: string): Promise<void> {
    if (!dir) return;
    const parts = normalizePath(dir).split("/");
    let cur = "";
    for (const p of parts) {
      cur = cur ? `${cur}/${p}` : p;
      if (!this.app.vault.getAbstractFileByPath(cur)) {
        try {
          await this.app.vault.createFolder(cur);
        } catch (_e) {
          // 既に存在する場合など
        }
      }
    }
  }
}
