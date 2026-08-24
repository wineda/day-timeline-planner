import { Editor, MarkdownView, Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import {
  DEFAULT_SETTINGS,
  DayTimelineSettingTab,
  DayTimelineSettings,
  migrateSettings,
} from "./settings";
import { BlockTaskStore, INBOX_DATE, InboxStore, ListTaskStore, MemberStore, migrateNote } from "./store";
import { RecurringListModal, RecurringModal } from "./recurring";
import { TaskModal } from "./modal";
import { ReminderService, TimerModal, TimerService, requestNotificationPermission } from "./notify";
import type { TaskSource } from "./model";
import { parseMetaLine, renderMetaLine } from "./markdown/blocks";
import { newBlockId } from "./markdown/id";
import { DayTimelineView, VIEW_TYPE_DAY_TIMELINE } from "./view";

export default class DayTimelinePlugin extends Plugin {
  settings: DayTimelineSettings = { ...DEFAULT_SETTINGS };
  store!: TaskSource;
  /** Inbox（ブロック形式のときだけ。旧リスト形式では null） */
  inbox: InboxStore | null = null;
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
      callback: () => new RecurringListModal(this).open(),
    });
    this.addCommand({
      id: "recurring-add",
      name: "定期タスクを追加",
      callback: () => {
        new RecurringModal(this.app, {
          tagChoices: this.settings.tagColors,
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

    this.addSettingTab(new DayTimelineSettingTab(this.app, this));
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

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.createStore();
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_DAY_TIMELINE)) {
      const view = leaf.view;
      if (view instanceof DayTimelineView) view.rebuild();
    }
  }
}
