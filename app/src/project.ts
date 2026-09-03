/**
 * プロジェクト（大きなタスク）= 1つのノート。
 * 日々のタスクブロックが「- プロジェクト: [[...]]」行でここへリンクし、
 * メモや工程（ステップ）の置き場を1箇所にまとめる。
 */
import { App, Notice, TFile, TFolder, getIcon, moment, normalizePath, setIcon } from "obsidian";
import type { DayTimelineSettings } from "./settings";
import type { Task } from "./model";
import { newBlockId } from "./markdown/id";
import { parseRank, type MonsterRank } from "./bestiary";
import { stripTags } from "./util";
import {
  normalizeBlockOptions,
  parseBlockDocument,
  type BlockOptions,
  type TaskBlock,
  type TicketRef,
} from "./markdown/blocks";
import { updateTask } from "./markdown/edit";

export interface ProjectRef {
  /** リンクに書く文字列（フォルダ付き・拡張子なし） */
  linktext: string;
  /** 表示名（ファイル名） */
  name: string;
  /** ノート自身の完了チェックが付いているか（選択肢の絞り込み用。書き込み直後は少し遅れることがある） */
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
  /** ボス戦のモンスター名（「- モンスター: ドラゴン」行。無ければ ""＝名前から自動で選ぶ） */
  monster: string;
  /** ボス戦の難易度（「- 難易度: ボス」行。null＝おまかせ（予定時間から決める）） */
  difficulty: MonsterRank | null;
}

const DUE_RE = /^\s*(?:[-*+]\s+)?(?:\*\*)?期日(?:\*\*)?\s*[:：]\s*(.*?)\s*$/;
const TICKET_LINE_RE = /^\s*(?:[-*+]\s+)?(?:\*\*)?チケット(?:\*\*)?\s*[:：]\s*(.*?)\s*$/;
const MONSTER_LINE_RE = /^\s*(?:[-*+]\s+)?(?:\*\*)?モンスター(?:\*\*)?\s*[:：]\s*(.*?)\s*$/;
const DIFFICULTY_LINE_RE = /^\s*(?:[-*+]\s+)?(?:\*\*)?難易度(?:\*\*)?\s*[:：]\s*(.*?)\s*$/;
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
  let monster = "";
  let difficulty: MonsterRank | null = null;
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
    if (!monster) {
      const mv = MONSTER_LINE_RE.exec(line)?.[1];
      if (mv !== undefined) {
        monster = mv;
        continue;
      }
    }
    if (!difficulty) {
      const dv = DIFFICULTY_LINE_RE.exec(line)?.[1];
      if (dv !== undefined) {
        difficulty = parseRank(dv);
        continue;
      }
    }
    const dv = parseDocLine(line);
    if (dv !== null) docs.push(...parseDocValue(dv));
  }
  return { due, dueDate, ticket, docs, monster, difficulty };
}

/** プロジェクトノートの frontmatter でグループ名を持つキー */
const GROUP_KEY = "group";

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
  /** プロジェクト自身（ノートのメタ行）が完了か。完了済はパネルに出さない */
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
 * プロジェクトノートの「- ラベル: 値」行を書き換える（純関数）。
 * 行があれば値だけ差し替え、無ければメタ行（`- [ ] ^id`）の直後（無ければ最初の見出しの直後、それも無ければ先頭）に足す。
 * value が空で行も無ければ何もしない（テンプレートの空の行はそのまま残す）
 */
export function upsertFieldLine(content: string, label: string, value: string): string {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  const re = new RegExp(`^(\\s*(?:[-*+]\\s+)?(?:\\*\\*)?${label}(?:\\*\\*)?\\s*[:：])\\s*(.*?)\\s*$`);
  const start = bodyStart(lines);
  let fence = false;
  for (let i = start; i < lines.length; i++) {
    if (FENCE_RE.test(lines[i])) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const m = re.exec(lines[i]);
    if (m) {
      lines[i] = value ? `${m[1]} ${value}` : m[1];
      return lines.join(eol);
    }
  }
  if (!value) return content;
  const line = `- ${label}: ${value}`;
  const meta = lines.findIndex((l, i) => i >= start && /^\s*[-*+]\s+\[[ xX>]\]\s+.*\^[A-Za-z0-9-]+\s*$/.test(l));
  if (meta >= 0) {
    // メタ行に続く「- ラベル: 」の並びの末尾に足す（期日・チケットのあとに並ぶ）
    let at = meta + 1;
    while (at < lines.length && /^\s*[-*+]\s+\S+\s*[:：]/.test(lines[at])) at++;
    lines.splice(at, 0, line);
    return lines.join(eol);
  }
  const head = lines.findIndex((l, i) => i >= start && /^#{1,2}\s/.test(l));
  lines.splice(head >= 0 ? head + 1 : start, 0, line);
  return lines.join(eol);
}

/**
 * 「テンプレートを作成」で書き出すサンプル。
 * {{name}} はプロジェクト名に置き換わる。メタ行（完了チェック）は作成時に自動で入る
 */
export const PROJECT_TEMPLATE_SAMPLE = `# {{name}}
- 期日:
- チケット:
- ドキュメント:
- 難易度:
- モンスター:

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
          group: normalizeGroup(this.app.metadataCache.getFileCache(f)?.frontmatter?.[GROUP_KEY]),
        });
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, "ja"));
  }

  /**
   * ノート先頭のチェック（メタ行 `- [x] ^id`）が付いているかをメタデータキャッシュから読む。
   * list() を同期のままにするための近道で、正確な判定は isDone() / setDone() が行う
   */
  private isDoneCached(file: TFile): boolean {
    const items = this.app.metadataCache.getFileCache(file)?.listItems;
    if (!items?.length) return false;
    let first = items[0];
    for (const it of items) if (it.position.start.line < first.position.start.line) first = it;
    // ブロックID（^id）付きのチェック行だけをメタ行とみなす（手書きのチェックリストと区別する）
    return typeof first.task === "string" && first.task.toLowerCase() === "x" && !!first.id;
  }

  /**
   * 名前からプロジェクトノートを作る（既にあればそのまま使う）。
   * 設定「プロジェクトのテンプレート」があればその内容から、無ければ最小の雛形で作る。
   * どちらもタスクブロックと同じ文法（見出し + メタ行）になるので、後から集計にも使える。
   * group を渡すとそのグループに入れる。作れなければ null
   */
  async create(
    name: string,
    group?: string | null,
    difficulty?: MonsterRank | null,
    monster?: string | null
  ): Promise<string | null> {
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
    if (difficulty || monster) await this.setDifficulty(link, difficulty ?? null, monster ?? null);
    return link;
  }

  /**
   * ボス戦の難易度とモンスターを書く（「- 難易度: 」「- モンスター: 」行）。
   * null / 空は「おまかせ」で、行があれば値を空にする
   */
  async setDifficulty(linktext: string, difficulty: MonsterRank | null, monster: string | null): Promise<boolean> {
    const file = this.resolveFile(linktext);
    if (!(file instanceof TFile)) return false;
    await this.app.vault.process(file, (content) => {
      let next = upsertFieldLine(content, "難易度", difficulty ?? "");
      next = upsertFieldLine(next, "モンスター", monster?.trim() ?? "");
      return next;
    });
    return true;
  }

  /**
   * 新しいプロジェクトノートの中身。テンプレートのプレースホルダー
   * （{{name}} / {{title}}・{{date}}・{{time}}・{{group}}）を置き換え、
   * メタ行（`- [ ] ^id` = プロジェクトの完了チェック）が無ければ見出しの直下に書き足す
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

  /** プロジェクト自身の完了状態（メタ行が無ければ null） */
  async isDone(linktext: string): Promise<boolean | null> {
    const file = this.resolveFile(linktext);
    if (!(file instanceof TFile)) return null;
    const content = await this.app.vault.cachedRead(file);
    return this.findSelf(content)?.block.done ?? null;
  }

  /** プロジェクト自身の状態（完了 + 期日・チケット・ドキュメント）を1回の読み込みで取る */
  async selfState(linktext: string): Promise<{ done: boolean | null; fields: ProjectFields } | null> {
    const file = this.resolveFile(linktext);
    if (!(file instanceof TFile)) return null;
    const content = await this.app.vault.cachedRead(file);
    return {
      done: this.findSelf(content)?.block.done ?? null,
      fields: extractProjectFields(content),
    };
  }

  /** プロジェクト自身のメタ行の完了を切り替える。メタ行が無い手作りのノートには書き足す */
  async setDone(linktext: string, done: boolean): Promise<boolean> {
    const file = this.resolveFile(linktext);
    if (!(file instanceof TFile)) return false;
    let ok = false;
    await this.app.vault.process(file, (content) => {
      const self = this.findSelf(content);
      if (!self) {
        // 先にノートだけ作って結び付けた場合など。ID はここで新しく採番する
        // （プロジェクトへのリンクはノート単位なので、この ^id を参照するものは無い）
        ok = true;
        return insertSelfMeta(content, file.basename, `- [${done ? "x" : " "}] ^${newBlockId()}`);
      }
      const t = self.block;
      const next = updateTask(
        content,
        { id: t.id, title: t.title, start: t.start, end: t.end },
        { done },
        self.opts
      );
      if (next === null) return content;
      ok = true;
      return next;
    });
    return ok;
  }

  /** プロジェクトのグループを付け替える（frontmatter の group を書き換える。null で外す） */
  async setGroup(linktext: string, group: string | null): Promise<boolean> {
    const file = this.resolveFile(linktext);
    if (!(file instanceof TFile)) return false;
    const g = group?.trim() || null;
    try {
      await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
        if (g) fm[GROUP_KEY] = g;
        else delete fm[GROUP_KEY];
      });
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
