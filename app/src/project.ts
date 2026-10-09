/**
 * プロジェクト（大きなタスク）= 1つのノート。
 * 日々のタスクブロックが「- プロジェクト: [[...]]」行でここへリンクし、
 * メモや工程（ステップ）の置き場を1箇所にまとめる。
 */
import { App, Notice, TFile, TFolder, getIcon, moment, normalizePath, setIcon } from "obsidian";
import type { DayTimelineSettings } from "./settings";
import type { Task } from "./model";
import { dateKey, stripTags } from "./util";
import type { TicketRef } from "./markdown/blocks";

export interface ProjectRef {
  /** リンクに書く文字列（フォルダ付き・拡張子なし） */
  linktext: string;
  /** 表示名（ファイル名） */
  name: string;
  /** ノート自身が完了か（frontmatter の `status: 完了`。選択肢の絞り込み用。書き込み直後は少し遅れることがある） */
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

// ---------- frontmatter（状態・進捗） ----------
// プロジェクトの状態は frontmatter の `status`（文字列。Bases のカンバンの列名と同じ）が正。
// 書くのは人（Bases / Task Manager Bases View）で、プラグインは読むだけ。
// 完了 = `status: 完了`。それ以外の値や未設定は進行中として扱う（着手 / 未着手 の区別はしない）

/** 状態のキー。人が書く */
export const STATUS_KEY = "status";
/** 完了を表す `status` の値 */
export const STATUS_DONE = "完了";
/** タスク表の進捗（タスク表を更新するたびに書く）。プラグインがプロジェクトノートに書くのはこれだけ */
export const PROGRESS_KEYS = {
  total: "tasks_total",
  done: "tasks_done",
  lastDone: "last_done",
  nextTask: "next_task",
} as const;

/**
 * frontmatter の値を比較用の文字列にする（純関数）。前後の空白と、囲んでいる引用符（`"完了"`）を除く。
 * 配列なら先頭、文字列でなければ null。空も null
 */
export function normalizeStatus(v: unknown): string | null {
  if (Array.isArray(v)) v = v[0];
  if (typeof v !== "string") return null;
  let t = v.trim();
  const quoted = /^(["'])(.*)\1$/.exec(t);
  if (quoted) t = quoted[2].trim();
  return t || null;
}

/** frontmatter の `status` の値が「完了」か（空白と引用符を除いて比べる。別の値・未設定は進行中） */
export function isStatusDone(v: unknown): boolean {
  return normalizeStatus(v) === STATUS_DONE;
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
 * ノートの内容から frontmatter の `status` が「完了」かを読む（純関数）。
 * `status: 完了` なら true、それ以外（別の値・未設定・frontmatter なし）は false。
 * メタデータキャッシュの更新を待たずに、書き込み直後のノートでも同じ判定ができるようにするためのもの
 */
export function readFrontmatterDone(content: string): boolean {
  return isStatusDone(frontmatterValueOf(content, STATUS_KEY));
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
  /** プロジェクト自身（frontmatter の `status: 完了`）が完了か。完了済はパネルに出さない */
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
 * プロジェクトノートの読み取りと、タスク表の進捗の書き込み。
 * ノートの状態（完了・期間・所属）は人が Bases などで書くもので、ここでは読むだけ。
 * プロジェクトノートに書くのはタスク表の進捗（tasks_total など）だけ
 */
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

  /** プロジェクトの一覧（フォルダ直下の .md ファイル）。名前順 */
  list(): ProjectRef[] {
    const folder = this.app.vault.getAbstractFileByPath(this.folder());
    if (!(folder instanceof TFolder)) return [];
    const out: ProjectRef[] = [];
    for (const f of folder.children) {
      if (f instanceof TFile && f.extension === "md") {
        out.push({
          linktext: f.path.replace(/\.md$/, ""),
          name: f.basename,
          done: isStatusDone(this.frontmatterOf(f)[STATUS_KEY]),
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

  /** リンク先のノートを探す（フルパスでなければ Obsidian のリンク解決に任せる） */
  private resolveFile(linktext: string): TFile | null {
    const byPath = this.app.vault.getAbstractFileByPath(linktext + ".md");
    if (byPath instanceof TFile) return byPath;
    return this.app.metadataCache.getFirstLinkpathDest(linktext, "");
  }

  /**
   * プロジェクト自身の状態（完了 + 期日・チケット・ドキュメント）を1回の読み込みで取る。
   * 完了はノートの内容から読む（書き込み直後のメタデータキャッシュの遅れを避ける）
   */
  async selfState(linktext: string): Promise<{ done: boolean; fields: ProjectFields } | null> {
    const file = this.resolveFile(linktext);
    if (!(file instanceof TFile)) return null;
    const content = await this.app.vault.cachedRead(file);
    return { done: readFrontmatterDone(content), fields: extractProjectFields(content) };
  }

  /** 開いているノートなどがプロジェクトノート（プロジェクトのフォルダ直下の .md）か */
  isProjectFile(file: TFile | null | undefined): file is TFile {
    if (!(file instanceof TFile) || file.extension !== "md") return false;
    return file.parent?.path === this.folder();
  }

  /**
   * タスク表の進捗（tasks_total / tasks_done / last_done / next_task）を frontmatter に書く。
   * タスク表（dt-project-tasks）を更新するタイミングで呼ぶ。値が同じならノートを書き換えない。
   * 状態（status・start・due・group）や `next`（人が手で書く「次にやること」）など他の property には触らない
   */
  async writeProgress(linktext: string, progress: ProjectProgress): Promise<boolean> {
    const file = this.resolveFile(linktext);
    if (!(file instanceof TFile)) return false;
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
      return changed;
    };
    // キャッシュの値と同じなら書かない（キャッシュが古いときは書いてしまうが害はない）
    if (!apply({ ...this.frontmatterOf(file) })) return true;
    try {
      await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => void apply(fm));
      return true;
    } catch (e) {
      console.error(e);
      return false;
    }
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
}
