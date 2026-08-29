/**
 * プロジェクト（大きなタスク）= 1つのノート。
 * 日々のタスクブロックが「- プロジェクト: [[...]]」行でここへリンクし、
 * メモや工程（ステップ）の置き場を1箇所にまとめる。
 */
import { App, Notice, TFile, TFolder, normalizePath } from "obsidian";
import type { DayTimelineSettings } from "./settings";
import type { Task } from "./model";
import { newBlockId } from "./markdown/id";
import { stripTags } from "./util";
import { normalizeBlockOptions, parseBlockDocument, type BlockOptions, type TaskBlock } from "./markdown/blocks";
import { updateTask } from "./markdown/edit";

export interface ProjectRef {
  /** リンクに書く文字列（フォルダ付き・拡張子なし） */
  linktext: string;
  /** 表示名（ファイル名） */
  name: string;
  /** ノート自身の完了チェックが付いているか（選択肢の絞り込み用。書き込み直後は少し遅れることがある） */
  done?: boolean;
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
}

export function summarize(ref: ProjectRef, children: ProjectChild[]): ProjectSummary {
  let planMin = 0;
  let actMin = 0;
  let doneCount = 0;
  for (const c of children) {
    if (c.task.start !== null && c.task.end !== null) planMin += c.task.end - c.task.start;
    actMin += c.task.actual.reduce((n, r) => n + (r.end - r.start), 0);
    if (c.task.done) doneCount++;
  }
  return { ref, children, planMin, actMin, doneCount };
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
        `| ${t.done ? "✅" : t.forwarded ? "▶" : "⬜"} | ${dateLabel} | ${titleCell} | ${hmm(plan)} | ${hmm(act)} |`
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

  /** プロジェクトの一覧（フォルダ内の .md ファイル）。名前順 */
  list(): ProjectRef[] {
    const folder = this.app.vault.getAbstractFileByPath(this.folder());
    if (!(folder instanceof TFolder)) return [];
    const out: ProjectRef[] = [];
    for (const f of folder.children) {
      if (f instanceof TFile && f.extension === "md") {
        out.push({ linktext: f.path.replace(/\.md$/, ""), name: f.basename, done: this.isDoneCached(f) });
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
    return typeof first.task === "string" && first.task.toLowerCase() === "x";
  }

  /**
   * 名前からプロジェクトノートを作る（既にあればそのまま使う）。
   * タスクブロックと同じ文法（見出し + メタ行）で作るので、後から集計にも使える。
   * 作れなければ null
   */
  async create(name: string): Promise<string | null> {
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
      const content = `# ${safe}\n- [ ] ^${newBlockId()}\n\n`;
      try {
        await this.app.vault.create(path, content);
      } catch (e) {
        if (!this.app.vault.getAbstractFileByPath(path)) {
          console.error(e);
          return null;
        }
      }
    }
    return path.replace(/\.md$/, "");
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

  /** プロジェクト自身の完了状態（メタ行が無ければ null） */
  async isDone(linktext: string): Promise<boolean | null> {
    const file = this.app.vault.getAbstractFileByPath(linktext + ".md");
    if (!(file instanceof TFile)) return null;
    const content = await this.app.vault.cachedRead(file);
    return this.findSelf(content)?.block.done ?? null;
  }

  /** プロジェクト自身のメタ行の完了を切り替える */
  async setDone(linktext: string, done: boolean): Promise<boolean> {
    const file = this.app.vault.getAbstractFileByPath(linktext + ".md");
    if (!(file instanceof TFile)) return false;
    let ok = false;
    await this.app.vault.process(file, (content) => {
      const self = this.findSelf(content);
      if (!self) return content;
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
