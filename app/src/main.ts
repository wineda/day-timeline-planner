import { Editor, MarkdownView, Notice, Plugin, TFile, WorkspaceLeaf, normalizePath } from "obsidian";
import {
  DEFAULT_SETTINGS,
  DayTimelineSettingTab,
  DayTimelineSettings,
  migrateSettings,
  ticketUrl,
} from "./settings";
import { BlockTaskStore, INBOX_DATE, InboxStore, ListTaskStore, MemberStore, migrateNote } from "./store";
import { RecurringModal } from "./recurring";
import { RecurringManagerView, VIEW_TYPE_RECURRING } from "./recurring-view";
import { ProjectCreateModal, TaskModal } from "./modal";
import { ReminderService, TimerModal, TimerService, requestNotificationPermission } from "./notify";
import type { Task, TaskSource } from "./model";
import { parseMetaLine, renderMetaLine } from "./markdown/blocks";
import { addDays, dateKey, minutesToHHMM, nowMinutes, startOfDay, startOfWeek, stripTags } from "./util";
import { buildWeeklyReport, type ReportDay } from "./report";
import {
  ProjectStore,
  buildTaskListSection,
  knownGroupNames,
  projectDisplayName,
  summarize,
  upsertTaskListSection,
  type ProjectChild,
  type ProjectSummary,
} from "./project";
import { newBlockId } from "./markdown/id";
import { DayTimelineView, VIEW_TYPE_DAY_TIMELINE } from "./view";

export default class DayTimelinePlugin extends Plugin {
  settings: DayTimelineSettings = { ...DEFAULT_SETTINGS };
  store!: TaskSource;
  /** Inbox（ブロック形式のときだけ。旧リスト形式では null） */
  inbox: InboxStore | null = null;
  /** プロジェクト（大きなタスク）。ブロック形式のときだけ */
  projects: ProjectStore | null = null;
  /** メンバー ID → その人の予定のストア（ブロック形式のときだけ） */
  memberStores = new Map<string, MemberStore>();
  timer!: TimerService;
  reminders!: ReminderService;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.createStore();
    this.timer = new TimerService(this);
    this.reminders = new ReminderService(this);
    this.timer.attachStatusBar(this.addStatusBarItem());
    this.reminders.start();
    if (this.settings.notifyStyle !== "banner") requestNotificationPermission();

    this.registerView(VIEW_TYPE_DAY_TIMELINE, (leaf) => new DayTimelineView(leaf, this));
    this.registerView(VIEW_TYPE_RECURRING, (leaf) => new RecurringManagerView(leaf, this));

    this.addRibbonIcon("calendar-clock", "タイムスケジュールを開く", () => {
      void this.activateView();
    });

    this.addCommand({
      id: "open-timeline",
      name: "タイムスケジュールを開く",
      callback: () => void this.activateView(),
    });

    this.addCommand({
      id: "open-today-note",
      name: "今日のスケジュールノートを開く",
      callback: async () => {
        const file = await this.store.ensureFile(new Date());
        await this.app.workspace.getLeaf("tab").openFile(file);
      },
    });

    // タイムラインが開いているときだけ使える日付移動コマンド
    const viewCommand = (id: string, name: string, fn: (v: DayTimelineView) => void) =>
      this.addCommand({
        id,
        name,
        checkCallback: (checking) => {
          const view = this.getTimelineView();
          if (!view) return false;
          if (!checking) fn(view);
          return true;
        },
      });
    viewCommand("timeline-prev-day", "タイムスケジュール: 前へ（前の日 / 前の週）", (v) => v.goToPrev());
    viewCommand("timeline-next-day", "タイムスケジュール: 次へ（次の日 / 次の週）", (v) => v.goToNext());
    viewCommand("timeline-today", "タイムスケジュール: 今日へ", (v) => v.goToToday());
    viewCommand("timeline-toggle-mode", "タイムスケジュール: 日表示 / 週表示を切り替える", (v) =>
      v.toggleViewMode()
    );
    viewCommand(
      "timeline-projects-toggle-expand",
      "タイムスケジュール: プロジェクトのツリーをすべて展開 / 閉じる",
      (v) => v.toggleAllProjects()
    );
    viewCommand(
      "timeline-projects-toggle-flat",
      "タイムスケジュール: プロジェクト一覧のフラット表示（グループの見出しなし）を切り替える",
      (v) => v.toggleProjectsFlatList()
    );
    viewCommand(
      "timeline-toggle-pane",
      "タイムスケジュール: タイムライン / パネルを切り替える（狭い画面）",
      (v) => v.toggleNarrowPane()
    );

    // 旧形式 → タスクブロックへの変換（開いているノート）
    this.addCommand({
      id: "migrate-note",
      name: "このノートの予定をタスクブロックに変換",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md" || this.settings.storageFormat !== "block")
          return false;
        if (!checking) void this.migrateFile(file);
        return true;
      },
    });

    // タスクを時刻順に並べ替える（タイムラインで表示中の日）
    this.addCommand({
      id: "sort-by-time",
      name: "タイムスケジュール: タスクを時刻順に並べ替える",
      checkCallback: (checking) => {
        const view = this.getTimelineView();
        const store = this.blockStore();
        if (!view || !store) return false;
        if (!checking) {
          void store.sortByTime(view.getDate()).then((changed) => {
            if (!changed) new Notice("並べ替えるタスクがありません");
          });
        }
        return true;
      },
    });

    // カーソルがある見出しをタスクにする
    this.addCommand({
      id: "make-heading-task",
      name: "カーソル位置の見出しをタスクにする",
      editorCheckCallback: (checking, editor, view) => {
        if (this.settings.storageFormat !== "block") return false;
        if (!(view instanceof MarkdownView)) return false;
        const pos = this.findHeadingForCursor(editor);
        if (pos === null) return false;
        if (!checking) this.insertMetaLine(editor, pos);
        return true;
      },
    });

    // Inbox
    this.addCommand({
      id: "inbox-add",
      name: "Inbox にタスクを追加（日付を決めずに登録）",
      checkCallback: (checking) => {
        if (!this.inbox) return false;
        if (!checking) this.openInboxAddModal();
        return true;
      },
    });
    this.addCommand({
      id: "inbox-open-note",
      name: "Inbox のノートを開く",
      checkCallback: (checking) => {
        const inbox = this.inbox;
        if (!inbox) return false;
        if (!checking) {
          void inbox.ensureFile(INBOX_DATE).then((f) => this.app.workspace.getLeaf("tab").openFile(f));
        }
        return true;
      },
    });

    // 定期タスク
    this.addCommand({
      id: "recurring-manage",
      name: "定期タスクを管理",
      callback: () => void this.activateRecurringView(),
    });
    this.addCommand({
      id: "recurring-add",
      name: "定期タスクを追加",
      callback: () => {
        new RecurringModal(this.app, {
          tagChoices: this.settings.tagColors,
          projects: this.projects?.list(),
          onSubmit: async (rule) => {
            this.settings.recurring.push(rule);
            await this.saveSettings();
            new Notice(`定期タスク「${rule.title}」を追加しました`);
          },
        }).open();
      },
    });

    // タイマー
    this.addCommand({
      id: "timer",
      name: "タイマーを開始 / 操作",
      callback: () => this.openTimerModal(),
    });
    for (const m of [5, 10, 15, 25, 30, 60]) {
      this.addCommand({
        id: `timer-${m}`,
        name: `タイマー: ${m}分`,
        callback: () => this.timer.start(m),
      });
    }

    // プロジェクト
    this.addCommand({
      id: "project-create",
      name: "新しいプロジェクトを作成",
      checkCallback: (checking) => {
        if (!this.projects) return false;
        if (!checking) this.openNewProjectModal();
        return true;
      },
    });
    this.addCommand({
      id: "projects-update-notes",
      name: "プロジェクトノートのタスク一覧を更新（すべて）",
      checkCallback: (checking) => {
        if (!this.projects) return false;
        if (!checking) void this.updateAllProjectNotes();
        return true;
      },
    });

    // 予実レポート
    this.addCommand({
      id: "pa-report-week",
      name: "予実レポートを作成（表示中の週）",
      checkCallback: (checking) => {
        if (!this.blockStore()) return false;
        if (!checking) void this.createWeeklyReport();
        return true;
      },
    });

    this.addSettingTab(new DayTimelineSettingTab(this.app, this));
  }

  /**
   * 表示中の日を含む週の予実レポートを Markdown で書き出して開く。
   * 出力先: <フォルダ>/Reports/予実レポート YYYY-MM-DD.md（週の初めの日付。既にあれば上書き）
   */
  async createWeeklyReport(): Promise<void> {
    const store = this.blockStore();
    if (!store) return;
    try {
      const base = this.getTimelineView()?.getDate() ?? startOfDay(new Date());
      const start = startOfWeek(startOfDay(base), this.settings.weekStart);
      const days: ReportDay[] = [];
      for (let i = 0; i < 7; i++) {
        const date = addDays(start, i);
        days.push({ date, tasks: (await store.load(date)).tasks });
      }
      const content = buildWeeklyReport(days, {
        ticketUrlOf: (tracker, id) => ticketUrl(this.settings.trackers, tracker, id),
      });

      const dir = normalizePath((this.settings.folder ? this.settings.folder + "/" : "") + "Reports");
      let cur = "";
      for (const part of dir.split("/")) {
        cur = cur ? `${cur}/${part}` : part;
        if (!this.app.vault.getAbstractFileByPath(cur)) {
          try {
            await this.app.vault.createFolder(cur);
          } catch (_e) {
            // 既にある場合など
          }
        }
      }
      const path = normalizePath(`${dir}/予実レポート ${dateKey(start)}.md`);
      const existing = this.app.vault.getAbstractFileByPath(path);
      let file: TFile;
      if (existing instanceof TFile) {
        await this.app.vault.process(existing, () => content);
        file = existing;
      } else {
        file = await this.app.vault.create(path, content);
      }
      await this.app.workspace.getLeaf("tab").openFile(file);
      new Notice(`予実レポートを作成しました: ${path}`);
    } catch (e) {
      console.error(e);
      new Notice("予実レポートを作成できませんでした: " + String(e));
    }
  }

  openTimerModal(): void {
    new TimerModal(this.app, this.timer).open();
  }

  /** Inbox にタスクを追加するダイアログ */
  openInboxAddModal(): void {
    const inbox = this.inbox;
    if (!inbox) {
      new Notice("Inbox はタスクブロック形式のときだけ使えます");
      return;
    }
    new TaskModal(this.app, {
      mode: "create",
      initial: { title: "", start: null, end: null, done: false },
      snapMinutes: this.settings.snapMinutes,
      allowUnscheduled: true,
      dateLabel: "Inbox",
      tagChoices: this.settings.tagColors,
      showDoneCondition: true,
      trackers: this.settings.trackers,
      projects: this.projects?.list(),
      onCreateProject: (name) => (this.projects ? this.projects.create(name) : Promise.resolve(null)),
      onOpenProject: (link) => this.openProject(link),
      onSubmit: async (data) => {
        try {
          await inbox.create(INBOX_DATE, { ...data, start: null, end: null });
          new Notice("Inbox に追加しました");
        } catch (e) {
          console.error(e);
          new Notice("Inbox に追加できませんでした: " + String(e));
        }
        for (const v of this.timelineViews()) v.reloadInbox();
      },
    }).open();
  }

  /**
   * 新しいプロジェクトを作るダイアログ（パネルの＋ボタン・コマンドから）。
   * テンプレート（設定「プロジェクトのテンプレート」）があればそこから作り、ノートを開く
   */
  openNewProjectModal(initialGroup?: string | null): void {
    const projects = this.projects;
    if (!projects) {
      new Notice("プロジェクトはタスクブロック形式のときだけ使えます");
      return;
    }
    const tplPath = projects.templatePath();
    const hasTemplate = !!tplPath && !!this.app.vault.getAbstractFileByPath(tplPath);
    new ProjectCreateModal(this.app, {
      groups: knownGroupNames(projects.list(), this.settings.projectGroups.map((g) => g.name)),
      initialGroup,
      templatePath: hasTemplate ? tplPath : null,
      onSubmit: async (name, group) => {
        const link = await projects.create(name, group);
        if (!link) {
          new Notice("プロジェクトを作成できませんでした");
          return;
        }
        new Notice(`プロジェクト「${projectDisplayName(link)}」を作成しました`);
        for (const v of this.timelineViews()) void v.reloadInbox();
        await this.openProject(link);
      },
    }).open();
  }

  /** 開いているタイムラインビューすべて */
  timelineViews(): DayTimelineView[] {
    return this.app.workspace
      .getLeavesOfType(VIEW_TYPE_DAY_TIMELINE)
      .map((l) => l.view)
      .filter((v): v is DayTimelineView => v instanceof DayTimelineView);
  }

  /** 設定に合わせて読み書きの実装を作り直す */
  createStore(): void {
    this.store =
      this.settings.storageFormat === "list"
        ? new ListTaskStore(this.app, () => this.settings)
        : new BlockTaskStore(this.app, () => this.settings);
    this.inbox =
      this.settings.storageFormat === "list" ? null : new InboxStore(this.app, () => this.settings);
    this.projects =
      this.settings.storageFormat === "list" ? null : new ProjectStore(this.app, () => this.settings);
    this.memberStores = new Map();
    if (this.settings.storageFormat !== "list") {
      for (const m of this.settings.members) {
        const id = m.id;
        this.memberStores.set(
          id,
          new MemberStore(this.app, () => this.settings, () => this.settings.members.find((x) => x.id === id) ?? m)
        );
      }
    }
  }

  /** タスクの持ち主に応じたストア（自分 / メンバー） */
  storeFor(owner: string | null | undefined): TaskSource {
    if (!owner) return this.store;
    return this.memberStores.get(owner) ?? this.store;
  }

  /** ブロック形式の持ち主別ストア（旧形式なら null） */
  blockStoreFor(owner: string | null | undefined): BlockTaskStore | null {
    const st = this.storeFor(owner);
    return st instanceof BlockTaskStore ? st : null;
  }

  memberOf(owner: string | null | undefined) {
    return owner ? this.settings.members.find((m) => m.id === owner) ?? null : null;
  }

  /** ブロック形式のときだけ使える機能のための型付きアクセス */
  blockStore(): BlockTaskStore | null {
    return this.store instanceof BlockTaskStore ? this.store : null;
  }

  /** 開いているタイムラインビュー（無ければ null） */
  getTimelineView(): DayTimelineView | null {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_DAY_TIMELINE)[0];
    const view = leaf?.view;
    return view instanceof DayTimelineView ? view : null;
  }

  /** その日のノートを旧形式から変換する（ビューのバナーから呼ばれる） */
  async migrateNoteFor(date: Date): Promise<void> {
    const file = this.store.getFile(date);
    if (!file) return;
    await this.migrateFile(file);
  }

  private async migrateFile(file: TFile): Promise<void> {
    try {
      const count = await migrateNote(this.app, file, this.settings);
      new Notice(
        count > 0 ? `${count} 件の予定をタスクブロックに変換しました` : "変換する予定がありません"
      );
    } catch (e) {
      console.error(e);
      new Notice("変換できませんでした: " + String(e));
    }
  }

  /** カーソル行から上に向かって、タスクにできる見出しを探す */
  private findHeadingForCursor(editor: Editor): number | null {
    const level = this.settings.taskHeadingLevel;
    const re = new RegExp(`^#{${level}}\\s+\\S`);
    for (let l = editor.getCursor().line; l >= 0; l--) {
      const text = editor.getLine(l);
      if (re.test(text)) return l;
      // より上位の見出しに出会ったら、その外にいる
      const m = /^(#{1,6})\s/.exec(text);
      if (m && m[1].length < level) return null;
    }
    return null;
  }

  /** 見出しの直下にメタ行を入れてタスクにする */
  private insertMetaLine(editor: Editor, headingLine: number): void {
    const hasNext = headingLine + 1 < editor.lineCount();
    const next = hasNext ? editor.getLine(headingLine + 1) : "";
    if (parseMetaLine(next)) {
      new Notice("この見出しはすでにタスクです");
      return;
    }
    const s = this.settings;
    const meta = renderMetaLine(
      { id: newBlockId(), title: "", start: null, end: null, done: false, note: "" },
      {
        headingLevel: s.taskHeadingLevel,
        rootHeading: s.taskRootHeading,
        useCheckbox: s.useCheckbox,
        mirrorTitle: false,
      }
    );
    if (hasNext) {
      editor.replaceRange(meta + "\n", { line: headingLine + 1, ch: 0 });
    } else {
      const ch = editor.getLine(headingLine).length;
      editor.replaceRange("\n" + meta, { line: headingLine, ch });
    }
    new Notice("タスクにしました（時刻はタイムラインから設定できます）");
  }

  onunload(): void {
    // ビューは Obsidian 側で復元できるよう、ここでは detach しない
    document.body.querySelector(".dt-alert-host")?.remove();
  }

  /** タイムラインビューを開く（既にあればそれを前面に） */
  async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_DAY_TIMELINE)[0] ?? null;
    if (!leaf) {
      const loc = this.settings.viewLocation;
      leaf =
        loc === "right"
          ? workspace.getRightLeaf(false)
          : loc === "left"
            ? workspace.getLeftLeaf(false)
            : workspace.getLeaf("tab");
      if (!leaf) {
        new Notice("タイムスケジュールのビューを開けませんでした");
        return;
      }
      await leaf.setViewState({ type: VIEW_TYPE_DAY_TIMELINE, active: true });
    }
    void workspace.revealLeaf(leaf);
  }

  /** 定期タスクの管理画面を開く（既にあればそれを前面に） */
  async activateRecurringView(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_RECURRING)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE_RECURRING, active: true });
    }
    void workspace.revealLeaf(leaf);
  }

  async loadSettings(): Promise<void> {
    const loaded = (await this.loadData()) as Partial<DayTimelineSettings> | null;
    const before = loaded?.settingsVersion ?? 0;
    this.settings = migrateSettings(loaded ?? {});
    // 旧版から移行したときは、移行後の値を書き戻しておく
    if (loaded && before !== this.settings.settingsVersion) await this.saveData(this.settings);
  }

  /** 設定を保存するだけ（ビューは作り直さない）。ビュー側の表示切替などに使う */
  async persistSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  // ---------- プロジェクト（大きなタスク） ----------

  /**
   * ノートのパスがどのストアの日付ノート（または Inbox）かを判定する。
   * プロジェクトの子タスク集めに使う
   */
  private resolveTaskNote(
    path: string
  ): { store: BlockTaskStore; date: Date; owner: string | null; inbox: boolean } | null {
    const inbox = this.inbox;
    if (inbox && path === inbox.pathFor(INBOX_DATE)) {
      return { store: inbox, date: INBOX_DATE, owner: null, inbox: true };
    }
    // メンバーのフォルダの方が深いので先に判定する
    for (const [id, st] of this.memberStores) {
      const d = st.dateFromPath(path);
      if (d) return { store: st, date: d, owner: id, inbox: false };
    }
    const main = this.blockStore();
    if (main) {
      const d = main.dateFromPath(path);
      if (d) return { store: main, date: d, owner: null, inbox: false };
    }
    return null;
  }

  /**
   * 各プロジェクトに結びついた子タスクを集める。
   * Obsidian のリンク索引（resolvedLinks）でプロジェクトノートにリンクしている
   * ノートだけを調べるので、保管庫全体は走査しない
   */
  async projectSummaries(): Promise<ProjectSummary[]> {
    const projects = this.projects;
    if (!projects || !this.blockStore()) return [];
    const refs = projects.list();
    if (!refs.length) return [];
    const byPath = new Map(refs.map((r) => [r.linktext + ".md", r]));
    const children = new Map<string, ProjectChild[]>();
    for (const key of byPath.keys()) children.set(key, []);

    const links = this.app.metadataCache.resolvedLinks;
    for (const [sourcePath, targets] of Object.entries(links)) {
      if (!Object.keys(targets).some((t) => byPath.has(t))) continue;
      const src = this.resolveTaskNote(sourcePath);
      if (!src) continue;
      let tasks;
      try {
        tasks = (await src.store.load(src.date)).tasks;
      } catch (e) {
        console.error(e);
        continue;
      }
      for (const task of tasks) {
        if (!task.project) continue;
        // 短い書き方（[[環境構築]] など）も Obsidian のリンク解決に合わせる
        const dest = this.app.metadataCache.getFirstLinkpathDest(task.project, sourcePath);
        const key = dest?.path ?? task.project + ".md";
        const bucket = children.get(key);
        if (!bucket) continue;
        bucket.push({
          date: src.inbox ? null : src.date,
          path: sourcePath,
          task,
          owner: src.owner,
        });
      }
    }
    const sums = refs.map((r) => summarize(r, children.get(r.linktext + ".md") ?? []));
    // プロジェクト自身の完了と期日・チケット・ドキュメントはノートを読んで判定する
    // （書き込み直後のキャッシュ遅れを避ける）
    await Promise.all(
      sums.map(async (s) => {
        try {
          const st = await projects.selfState(s.ref.linktext);
          s.done = st?.done === true;
          s.fields = st?.fields;
        } catch (e) {
          console.error(e);
        }
      })
    );
    return sums;
  }

  /** 1つのプロジェクトの子タスクを集める */
  async collectProjectChildren(linktext: string): Promise<ProjectChild[]> {
    const all = await this.projectSummaries();
    return all.find((s) => s.ref.linktext === linktext)?.children ?? [];
  }

  /** プロジェクトノートの「タスク」セクション（自動更新）を書き換える */
  async updateProjectNote(linktext: string): Promise<boolean> {
    const file = this.app.vault.getAbstractFileByPath(linktext + ".md");
    if (!(file instanceof TFile)) return false;
    const children = await this.collectProjectChildren(linktext);
    const section = buildTaskListSection(children);
    await this.app.vault.process(file, (c) => upsertTaskListSection(c, section));
    return true;
  }

  /** プロジェクトノートを（タスク一覧を最新にしてから）開く */
  async openProject(linktext: string): Promise<void> {
    const projects = this.projects;
    if (!projects) return;
    try {
      await this.updateProjectNote(linktext);
    } catch (e) {
      console.error(e); // 一覧の更新に失敗しても開くのは続ける
    }
    await projects.open(linktext);
  }

  /** すべてのプロジェクトノートのタスク一覧を更新する */
  async updateAllProjectNotes(): Promise<void> {
    const projects = this.projects;
    if (!projects) return;
    const summaries = await this.projectSummaries();
    let n = 0;
    for (const s of summaries) {
      const file = this.app.vault.getAbstractFileByPath(s.ref.linktext + ".md");
      if (!(file instanceof TFile)) continue;
      const section = buildTaskListSection(s.children);
      await this.app.vault.process(file, (c) => upsertTaskListSection(c, section));
      n++;
    }
    new Notice(`${n} 件のプロジェクトノートのタスク一覧を更新しました`);
  }

  // ---------- 実績の計測（ストップウォッチ） ----------

  /** タスクの実績の計測を開始する。別のタスクを計測中なら、それを記録してから始める */
  async startTaskTracking(date: Date, task: Task): Promise<void> {
    const store = this.blockStoreFor(task.owner);
    if (!store) {
      new Notice("実績の計測はタスクブロック形式のときだけ使えます");
      return;
    }
    if (this.settings.tracking) await this.stopTaskTracking(true);
    // ブロックID が無いタスクにはこのタイミングで付ける（計測中に編集されても追えるように）
    const link = await store.linkTo(date, task);
    const blockId = link?.split("#^")[1];
    if (!blockId) {
      new Notice("計測を開始できませんでした（タスクが見つかりません）");
      return;
    }
    this.settings.tracking = {
      date: dateKey(date),
      owner: task.owner ?? null,
      blockId,
      title: stripTags(task.title) || "(無題)",
      startMin: nowMinutes(),
    };
    await this.persistSettings();
    new Notice(`計測開始: ${this.settings.tracking.title}`);
    for (const v of this.timelineViews()) v.renderTracking();
  }

  /** 計測を終える。record = true なら経過時間をタスクの実績に追記する */
  async stopTaskTracking(record: boolean): Promise<void> {
    const tr = this.settings.tracking;
    if (!tr) return;
    this.settings.tracking = null;
    await this.persistSettings();
    for (const v of this.timelineViews()) v.renderTracking();
    if (!record) {
      new Notice("計測をやめました（実績には記録していません）");
      return;
    }
    try {
      const store = this.blockStoreFor(tr.owner);
      if (!store) return;
      const [y, m, d] = tr.date.split("-").map(Number);
      const date = new Date(y, (m ?? 1) - 1, d ?? 1);
      // 日をまたいだ場合は、開始した日の終わり（24:00）までを実績にする
      const sameDay = dateKey(new Date()) === tr.date;
      let start = tr.startMin;
      let end = sameDay ? nowMinutes() : 1440;
      if (end <= start) end = Math.min(start + 1, 1440);
      if (end <= start) start = end - 1;
      const day = await store.load(date);
      const task = day.tasks.find((t) => t.blockId === tr.blockId);
      if (!task) {
        new Notice("計測していたタスクが見つからず、実績を記録できませんでした");
        return;
      }
      const ok = await store.update(date, task, {
        title: task.title,
        start: task.start,
        end: task.end,
        done: task.done,
        actual: [...task.actual, { start, end }],
      });
      if (ok) {
        new Notice(`実績 ${minutesToHHMM(start)} - ${minutesToHHMM(end)} を記録しました: ${tr.title}`);
      } else {
        new Notice("実績を記録できませんでした。ノートが変更された可能性があります。");
      }
    } catch (e) {
      console.error(e);
      new Notice("実績を記録できませんでした: " + String(e));
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.createStore();
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_DAY_TIMELINE)) {
      const view = leaf.view;
      if (view instanceof DayTimelineView) view.rebuild();
    }
  }
}
