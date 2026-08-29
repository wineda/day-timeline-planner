import { App, TFile, normalizePath, moment } from "obsidian";
import { memberFolder, type DayTimelineSettings, type Member } from "./settings";
import type { DayTasks, Task, TaskDraft, TaskSource } from "./model";
import {
  TaskBlock,
  bodyPreview,
  normalizeBlockOptions,
  parseBlockDocument,
  parseHeadingSetting,
} from "./markdown/blocks";
import {
  InsertOptions,
  TaskRef,
  ensureTaskId,
  insertBlockLines,
  insertTask,
  locateTask,
  removeTask,
  sortTasksByTime,
  updateTask,
} from "./markdown/edit";
import {
  ListEvent,
  eventSignature,
  parseListNote,
  serializeListNote,
} from "./markdown/legacy";
import { migrateListToBlocks } from "./markdown/migrate";
import { extractTags, startOfDay } from "./util";

/** 日付 → ノートの対応と、ノートの作成。保存形式によらず共通 */
abstract class NoteStore implements TaskSource {
  abstract readonly supportsUnscheduled: boolean;
  abstract readonly supportsBody: boolean;
  /** このストアが扱う人（null = 自分）。読み込んだタスクに刻印する */
  readonly ownerId: string | null = null;

  constructor(
    protected app: App,
    protected getSettings: () => DayTimelineSettings
  ) {}

  /** ノートを置くフォルダ（メンバー用は上書きする） */
  protected folder(): string {
    return this.getSettings().folder;
  }

  /** その日のノートのパス */
  pathFor(date: Date): string {
    const s = this.getSettings();
    const name = moment(date).format(s.dateFormat);
    const folder = this.folder();
    return normalizePath((folder ? folder + "/" : "") + name + ".md");
  }

  getFile(date: Date): TFile | null {
    const f = this.app.vault.getAbstractFileByPath(this.pathFor(date));
    return f instanceof TFile ? f : null;
  }

  /** ノートのパスがこのストアの日付ノートなら、その日付を返す（違えば null） */
  dateFromPath(path: string): Date | null {
    const folder = normalizePath(this.folder() || "");
    const prefix = folder && folder !== "/" ? folder + "/" : "";
    const p = normalizePath(path);
    if (prefix && !p.startsWith(prefix)) return null;
    const rest = p.slice(prefix.length);
    if (!rest.toLowerCase().endsWith(".md")) return null;
    const name = rest.slice(0, -3);
    const m = moment(name, this.getSettings().dateFormat, true);
    return m.isValid() ? startOfDay(m.toDate()) : null;
  }

  abstract load(date: Date): Promise<DayTasks>;
  abstract create(date: Date, draft: TaskDraft): Promise<boolean>;
  abstract update(date: Date, task: Task, draft: TaskDraft): Promise<boolean>;
  abstract remove(date: Date, task: Task): Promise<boolean>;
  abstract moveToDate(from: Date, task: Task, to: Date): Promise<boolean | null>;
  abstract linkTo(date: Date, task: Task): Promise<string | null>;

  /** 新規ノートの中身を形式ごとに整える（既定はテンプレートのまま） */
  protected initialSkeleton(content: string): string {
    return content;
  }

  /** ノートが無ければ（テンプレート付きで）作成して返す */
  async ensureFile(date: Date): Promise<TFile> {
    const existing = this.getFile(date);
    if (existing) return existing;
    const path = this.pathFor(date);
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    await this.ensureFolder(dir);

    const content = this.initialSkeleton(await this.initialContent(date));
    // 直前に他の処理で作られている可能性もあるので再確認
    const again = this.getFile(date);
    if (again) return again;
    try {
      return await this.app.vault.create(path, content);
    } catch (e) {
      const raced = this.getFile(date);
      if (raced) return raced;
      throw e;
    }
  }

  /** ファイルを読み直してから変更を適用する（外部編集との競合を減らす） */
  protected async process(date: Date, fn: (content: string) => string | null): Promise<boolean> {
    const file = await this.ensureFile(date);
    let ok = true;
    await this.app.vault.process(file, (content) => {
      const next = fn(content);
      if (next === null) {
        ok = false;
        return content;
      }
      return next;
    });
    return ok;
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

  private async initialContent(date: Date): Promise<string> {
    const s = this.getSettings();
    if (!s.templatePath) return "";
    let path = normalizePath(s.templatePath);
    if (!path.endsWith(".md")) path += ".md";
    const tf = this.app.vault.getAbstractFileByPath(path);
    if (!(tf instanceof TFile)) return "";
    const tpl = await this.app.vault.read(tf);
    const m = moment(date);
    return tpl
      .replace(/\{\{\s*date\s*(?::\s*([^}]+?)\s*)?\}\}/gi, (_all, fmt: string | undefined) =>
        m.format(fmt || s.dateFormat)
      )
      .replace(/\{\{\s*title\s*\}\}/gi, m.format(s.dateFormat))
      .replace(/\{\{\s*time\s*(?::\s*([^}]+?)\s*)?\}\}/gi, (_all, fmt: string | undefined) =>
        moment().format(fmt || "HH:mm")
      );
  }
}

// ---------------------------------------------------------------------------
// 新形式: 1タスク = 1ブロック（見出し + メタ行 + 本文）
// ---------------------------------------------------------------------------

export class BlockTaskStore extends NoteStore {
  readonly supportsUnscheduled = true;
  readonly supportsBody = true;

  private options(): InsertOptions {
    const s = this.getSettings();
    const legacyText = parseHeadingSetting(s.heading).text;
    const rootText = s.taskRootHeading.trim()
      ? parseHeadingSetting(s.taskRootHeading).text
      : null;
    return normalizeBlockOptions({
      headingLevel: s.taskHeadingLevel,
      rootHeading: s.taskRootHeading,
      useCheckbox: s.useCheckbox,
      mirrorTitle: s.mirrorTitleInMeta,
      insertPosition: s.insertPosition,
      // 旧形式のセクションを親見出しとして使っていない限り、タスクとは見なさない
      excludeHeadings: rootText === legacyText ? [] : [legacyText],
    });
  }

  /** 変換すべき旧形式の予定が残っているか（移行の案内に使う） */
  async countLegacyEvents(date: Date): Promise<number> {
    const file = this.getFile(date);
    if (!file) return 0;
    const content = await this.app.vault.cachedRead(file);
    return parseListNote(content, this.getSettings().heading).events.length;
  }

  async load(date: Date): Promise<DayTasks> {
    const path = this.pathFor(date);
    const file = this.getFile(date);
    if (!file) return { path, exists: false, tasks: [] };
    const content = await this.app.vault.cachedRead(file);
    const doc = parseBlockDocument(content, this.options());
    return { path, exists: true, tasks: doc.tasks.map((t) => this.toTask(t)) };
  }

  protected toTask(t: TaskBlock): Task {
    return {
      key: t.id ?? `block:${t.title}|${t.start}|${t.end}`,
      title: t.title,
      start: t.start,
      end: t.end,
      done: t.done,
      preview: bodyPreview(t.body),
      blockId: t.id,
      tags: extractTags([t.title, t.note, ...t.body].join("\n")),
      reminder: t.reminder,
      doneCondition: t.doneCondition,
      steps: t.steps,
      retrospective: t.retrospective,
      actual: t.actual,
      project: t.project,
      forwarded: !t.done && t.checkChar === ">",
      carryTo: t.carryTo,
      carryFrom: t.carryFrom,
      details: t.details.join("\n"),
      ticket: t.ticket,
      owner: this.ownerId,
      ref: { kind: "block", id: t.id, title: t.title, start: t.start, end: t.end },
    };
  }

  private refOf(task: Task): TaskRef {
    if (task.ref.kind !== "block") throw new Error("block store got a list task");
    return task.ref;
  }

  async create(date: Date, draft: TaskDraft): Promise<boolean> {
    return this.process(date, (c) => insertTask(c, draft, this.options()));
  }

  /** ブロックID を指定してタスクを作る（定期タスクが後から追跡できるように） */
  async createWithId(date: Date, draft: TaskDraft, id: string): Promise<boolean> {
    return this.process(date, (c) => insertTask(c, { ...draft, id }, this.options()));
  }

  /**
   * ブロックID でタスクを見つけて書き換える（定期タスクのルール編集の反映に使う）。
   * ノートが無ければ作らずに false。
   */
  async updateByBlockId(
    date: Date,
    blockId: string,
    patch: {
      title?: string;
      start?: number | null;
      end?: number | null;
      project?: string | null;
      details?: string;
    }
  ): Promise<boolean> {
    if (!this.getFile(date)) return false;
    return this.process(date, (c) =>
      updateTask(c, { id: blockId, title: "", start: null, end: null }, patch, this.options())
    );
  }

  async update(date: Date, task: Task, draft: TaskDraft): Promise<boolean> {
    return this.process(date, (c) => updateTask(c, this.refOf(task), draft, this.options()));
  }

  async remove(date: Date, task: Task): Promise<boolean> {
    return this.process(date, (c) => {
      const r = removeTask(c, this.refOf(task), this.options());
      return r ? r.content : null;
    });
  }

  /** ブロックごと別の日のノートへ移す */
  async moveToDate(from: Date, task: Task, to: Date): Promise<boolean | null> {
    const opts = this.options();
    let block: string[] | null = null;
    const removed = await this.process(from, (c) => {
      const r = removeTask(c, this.refOf(task), opts);
      if (!r) return null;
      block = r.block;
      return r.content;
    });
    if (!removed || !block) return false;
    return this.process(to, (c) => insertBlockLines(c, block as string[], task.start, opts));
  }

  /**
   * ブロックをノートから取り出す（別のノート/ストアへ移すために使う）。
   * 見つからなければ null。
   */
  async takeBlock(date: Date, task: Task): Promise<string[] | null> {
    let block: string[] | null = null;
    const ok = await this.process(date, (c) => {
      const r = removeTask(c, this.refOf(task), this.options());
      if (!r) return null;
      block = r.block;
      return r.content;
    });
    return ok ? block : null;
  }

  /** 取り出したブロックをそのまま差し込む */
  async putBlock(date: Date, block: string[], start: number | null): Promise<boolean> {
    return this.process(date, (c) => insertBlockLines(c, block, start, this.options()));
  }

  /** "path#^id" 形式のリンク。ID が無ければこのタイミングで付ける */
  async linkTo(date: Date, task: Task): Promise<string | null> {
    const path = this.pathFor(date);
    if (task.blockId) return `${path}#^${task.blockId}`;
    let id: string | null = null;
    const ok = await this.process(date, (c) => {
      const r = ensureTaskId(c, this.refOf(task), this.options());
      if (!r) return null;
      id = r.id;
      return r.content;
    });
    return ok && id ? `${path}#^${id}` : null;
  }

  /** タスクを時刻順に並べ替える（明示的なコマンドから呼ぶ） */
  async sortByTime(date: Date): Promise<boolean> {
    return this.process(date, (c) => sortTasksByTime(c, this.options()));
  }

  /** ノート内の位置（見出し行）を返す。エディタからのハイライトに使う */
  async taskAtLine(date: Date, line: number): Promise<Task | null> {
    const file = this.getFile(date);
    if (!file) return null;
    const content = await this.app.vault.cachedRead(file);
    const doc = parseBlockDocument(content, this.options());
    const hit = doc.tasks.find((t) => line >= t.headingLine && line < t.endLine);
    return hit ? this.toTask(hit) : null;
  }

  /** 本文があるか（削除の確認に使う） */
  async hasBody(date: Date, task: Task): Promise<boolean> {
    const file = this.getFile(date);
    if (!file) return false;
    const content = await this.app.vault.cachedRead(file);
    const doc = parseBlockDocument(content, this.options());
    const t = locateTask(doc, this.refOf(task));
    return !!t && t.body.length > 0;
  }
}

/**
 * Inbox: 日付を決めていないタスクの置き場。1つの固定ノートに、日付のノートと同じ
 * ブロック形式で保存する。日付の引数は無視される（API を合わせるためだけにある）。
 */
export class InboxStore extends BlockTaskStore {
  pathFor(_date: Date): string {
    const s = this.getSettings();
    let p = s.inboxPath.trim() || "Timeline/Inbox";
    if (!p.toLowerCase().endsWith(".md")) p += ".md";
    return normalizePath(p);
  }
}

/** 他の人の予定（メンバーごとのフォルダに、自分と同じ形式で保存する） */
export class MemberStore extends BlockTaskStore {
  readonly ownerId: string;

  constructor(
    app: App,
    getSettings: () => DayTimelineSettings,
    private getMember: () => Member
  ) {
    super(app, getSettings);
    this.ownerId = getMember().id;
  }

  protected folder(): string {
    return memberFolder(this.getSettings(), this.getMember());
  }
}

/** Inbox 用のダミー日付（pathFor では使われない） */
export const INBOX_DATE = new Date(2000, 0, 1);

// ---------------------------------------------------------------------------
// 旧形式: 見出しの下のリスト（1.x 互換）
// ---------------------------------------------------------------------------

export class ListTaskStore extends NoteStore {
  readonly supportsUnscheduled = false;
  readonly supportsBody = false;

  protected initialSkeleton(content: string): string {
    const s = this.getSettings();
    if (parseListNote(content, s.heading).section) return content;
    const { level, text } = parseHeadingSetting(s.heading);
    const headingLine = "#".repeat(level) + " " + text;
    const trimmed = content.replace(/\s+$/, "");
    return (trimmed ? trimmed + "\n\n" : "") + headingLine + "\n";
  }

  async load(date: Date): Promise<DayTasks> {
    const path = this.pathFor(date);
    const file = this.getFile(date);
    if (!file) return { path, exists: false, tasks: [] };
    const content = await this.app.vault.cachedRead(file);
    const parsed = parseListNote(content, this.getSettings().heading);
    return { path, exists: true, tasks: parsed.events.map((e) => this.toTask(e)) };
  }

  private toTask(e: ListEvent): Task {
    return {
      key: `list:${eventSignature(e)}`,
      title: e.title,
      start: e.start,
      end: e.end,
      done: e.done,
      preview: "",
      blockId: null,
      tags: extractTags([e.title, ...e.children].join("\n")),
      reminder: null,
      doneCondition: "",
      steps: [],
      retrospective: "",
      actual: [],
      project: null,
      forwarded: false,
      carryTo: null,
      carryFrom: null,
      details: "",
      ticket: null,
      owner: null,
      ref: { kind: "list", event: e },
    };
  }

  private eventOf(task: Task): ListEvent {
    if (task.ref.kind !== "list") throw new Error("list store got a block task");
    return task.ref.event;
  }

  private draftToEvent(draft: TaskDraft, base?: ListEvent): ListEvent | null {
    if (draft.start === null || draft.end === null) return null; // 旧形式は時刻必須
    return {
      start: draft.start,
      end: draft.end,
      title: draft.title,
      done: draft.done,
      children: base?.children ?? [],
      checkChar: base?.checkChar,
    };
  }

  private mutate(date: Date, fn: (events: ListEvent[]) => ListEvent[] | null): Promise<boolean> {
    const s = this.getSettings();
    return this.process(date, (content) => {
      const parsed = parseListNote(content, s.heading);
      const next = fn(parsed.events);
      if (next === null) return null;
      return serializeListNote(parsed, next, s.heading, s.useCheckbox);
    });
  }

  private findIndex(events: ListEvent[], target: ListEvent): number {
    const sig = eventSignature(target);
    return events.findIndex((e) => eventSignature(e) === sig);
  }

  async create(date: Date, draft: TaskDraft): Promise<boolean> {
    const ev = this.draftToEvent(draft);
    if (!ev) return false;
    return this.mutate(date, (events) => [...events, ev]);
  }

  async update(date: Date, task: Task, draft: TaskDraft): Promise<boolean> {
    const original = this.eventOf(task);
    return this.mutate(date, (events) => {
      const idx = this.findIndex(events, original);
      if (idx < 0) return null;
      const ev = this.draftToEvent(draft, events[idx]);
      if (!ev) return null;
      const next = [...events];
      next[idx] = ev;
      return next;
    });
  }

  async remove(date: Date, task: Task): Promise<boolean> {
    const original = this.eventOf(task);
    return this.mutate(date, (events) => {
      const idx = this.findIndex(events, original);
      if (idx < 0) return null;
      const next = [...events];
      next.splice(idx, 1);
      return next;
    });
  }

  async moveToDate(from: Date, task: Task, to: Date): Promise<boolean | null> {
    const original = this.eventOf(task);
    let carried: ListEvent | null = null;
    const removed = await this.mutate(from, (events) => {
      const idx = this.findIndex(events, original);
      if (idx < 0) return null;
      carried = events[idx];
      const next = [...events];
      next.splice(idx, 1);
      return next;
    });
    if (!removed || !carried) return false;
    const ev = carried as ListEvent;
    return this.mutate(to, (events) => [...events, ev]);
  }

  async linkTo(_date: Date, _task: Task): Promise<string | null> {
    return null; // 旧形式にブロックID は無い
  }
}

// ---------------------------------------------------------------------------
// 移行
// ---------------------------------------------------------------------------

/** その日のノートを旧形式 → ブロック形式に変換する。変換した件数を返す */
export async function migrateNote(
  app: App,
  file: TFile,
  settings: DayTimelineSettings
): Promise<number> {
  let count = 0;
  await app.vault.process(file, (content) => {
    const r = migrateListToBlocks(content, normalizeBlockOptions({
      legacyHeading: settings.heading,
      headingLevel: settings.taskHeadingLevel,
      rootHeading: settings.taskRootHeading,
      useCheckbox: settings.useCheckbox,
      mirrorTitle: settings.mirrorTitleInMeta,
      insertPosition: settings.insertPosition,
    }));
    if (!r) return content;
    count = r.count;
    return r.content;
  });
  return count;
}
