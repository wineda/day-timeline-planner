import {
  ItemView,
  MarkdownView,
  Menu,
  Notice,
  Scope,
  TAbstractFile,
  WorkspaceLeaf,
  debounce,
  getIcon,
  moment,
  setIcon,
} from "obsidian";
import type DayTimelinePlugin from "./main";
import { ScheduledTask, Task, TaskDraft, TaskSource, isScheduled } from "./model";
import { ConfirmModal, PromptModal, RetrospectiveModal, TaskModal, formatActualRanges } from "./modal";
import type { ActualRange } from "./markdown/blocks";
import {
  groupProjects,
  knownGroupNames,
  projectDisplayName,
  renderGroupIcon,
  type ProjectDoc,
  type ProjectSummary,
} from "./project";
import { newBlockId } from "./markdown/id";
import { layoutEvents, type LayoutInfo } from "./layout";
import {
  colorForTags,
  ticketUrl,
  type Member,
  type PlanActualMode,
  type SidebarTab,
  type ViewMode,
} from "./settings";
import { applyRecurring, instanceOf, noteRecurringDeletion, RecurringModal } from "./recurring";
import { INBOX_DATE } from "./store";
import { formatSeconds } from "./notify";
import {
  addDays,
  clamp,
  contrastTextColor,
  dateKey,
  formatDuration,
  isSameDay,
  isToday,
  minutesToHHMM,
  nowMinutes,
  startOfDay,
  startOfWeek,
  stripTags,
} from "./util";

export const VIEW_TYPE_DAY_TIMELINE = "day-timeline-planner-view";

interface DragHandlers {
  onMove?: (dy: number, ev: PointerEvent) => void;
  onEnd: (moved: boolean, ev: PointerEvent) => void;
  onCancel?: () => void;
}

/** 1日分の列 */
interface DayColumn {
  date: Date;
  key: string;
  headerEl: HTMLElement;
  canvasEl: HTMLElement;
  eventsEl: HTMLElement;
  nowEl: HTMLElement | null;
}

/** 1日分の読み込み結果 */
interface DayData {
  tasks: Task[];
  exists: boolean;
  legacyCount: number;
}

const WEEKDAY_JA = ["日", "月", "火", "水", "木", "金", "土"];

/** 再スケジュール欄のために、過去何日ぶんのノートから時刻なしタスクを拾うか */
const RESCHEDULE_LOOKBACK_DAYS = 30;

/** ビューの幅（px）がこれ未満なら「狭い画面」（スマホなど）。
 * サイドバーとタイムラインを並べると共倒れになるので、片方だけを全面に出して切り替える */
const NARROW_VIEW_WIDTH = 500;

/** 狭い画面で全面に出す面 */
type NarrowPane = "timeline" | "panel";

export class DayTimelineView extends ItemView {
  private plugin: DayTimelinePlugin;
  /** 基準日。日表示ではこの日、週表示ではこの日を含む週を表示する */
  private date: Date = startOfDay(new Date());
  private mode: ViewMode;
  private columns: DayColumn[] = [];
  private data = new Map<string, DayData>();

  private dateLabelEl!: HTMLElement;
  private dateInputEl!: HTMLInputElement;
  private timerEl!: HTMLElement;
  private trackingEl!: HTMLElement;
  private modeBtns = new Map<ViewMode, HTMLElement>();
  /** 表示範囲（3日・週）の予実合計 */
  private rangeTotalEl!: HTMLElement;
  /** 実際に使う 1時間あたりの高さ（px）。ズーム指定があるとビューの高さから決まる */
  private hourHeightPx = 60;
  /** 月表示のマス（日付キー → 要素） */
  private monthCells = new Map<string, { date: Date; el: HTMLElement; listEl: HTMLElement }>();
  private bannerEl!: HTMLElement;
  private inboxEl!: HTMLElement;
  private inboxTasks: Task[] = [];
  /** 表示範囲の外（過去）に取り残された時刻なしタスク（再スケジュール欄用のキャッシュ） */
  private pastUnscheduled: { date: Date; tasks: Task[] }[] = [];
  /** プロジェクトの集計（パネル用のキャッシュ） */
  private projectData: ProjectSummary[] = [];
  /** パネルで展開中のプロジェクト */
  private expandedProjects = new Set<string>();
  /** パネルで畳んでいるプロジェクトグループ（"" = 未分類） */
  private collapsedGroups = new Set<string>();
  private scrollEl!: HTMLElement;
  private headersEl!: HTMLElement;
  private labelsEl!: HTMLElement;
  private daysEl!: HTMLElement;
  /** 幅が狭い（スマホなど）とき true。タイムラインとパネルを切り替えて片方だけ表示する */
  private isNarrow = false;
  /** 狭い画面で表示中の面 */
  private narrowPane: NarrowPane = "timeline";
  private paneEl!: HTMLElement;
  private paneBtns = new Map<NarrowPane, HTMLElement>();
  /** "日付キー|タスクの key" → タイムライン上の要素（エディタ連動のハイライトに使う） */
  private taskEls = new Map<string, HTMLElement>();
  private activeTaskKey: string | null = null;

  /** ドラッグ操作中は再描画しない */
  private interacting = false;
  private pendingReload = false;
  private shouldScroll = true;
  private reloadDebounced: () => void;
  private syncCursorDebounced: () => void;

  constructor(leaf: WorkspaceLeaf, plugin: DayTimelinePlugin) {
    super(leaf);
    this.plugin = plugin;
    this.mode = plugin.settings.viewMode;
    this.reloadDebounced = debounce(() => void this.reload(), 250, true);
    this.syncCursorDebounced = debounce(() => void this.syncCursorHighlight(), 150, true);

    // ビューにフォーカスがあるとき: ← → で前後へ
    this.scope = new Scope(this.app.scope);
    this.scope.register([], "ArrowLeft", () => {
      this.goToPrev();
      return false;
    });
    this.scope.register([], "ArrowRight", () => {
      this.goToNext();
      return false;
    });
  }

  getViewType(): string {
    return VIEW_TYPE_DAY_TIMELINE;
  }

  getDisplayText(): string {
    return "タイムスケジュール";
  }

  getIcon(): string {
    return "calendar-clock";
  }

  /** 表示中の基準日（コマンドから使う） */
  getDate(): Date {
    return this.date;
  }

  getMode(): ViewMode {
    return this.mode;
  }

  async onOpen(): Promise<void> {
    this.buildSkeleton();
    this.buildGrid();
    this.updateNarrow();

    const onFile = (f: TAbstractFile) => this.onVaultChange(f.path);
    this.registerEvent(this.app.vault.on("modify", onFile));
    // 保管庫の読み込み中は既存の全ファイルにも create が発火するので、復元後に登録する
    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(this.app.vault.on("create", onFile));
    });
    this.registerEvent(this.app.vault.on("delete", onFile));
    this.registerEvent(
      this.app.vault.on("rename", (f, oldPath) => {
        this.onVaultChange(f.path);
        this.onVaultChange(oldPath);
      })
    );
    this.registerInterval(
      window.setInterval(() => {
        this.updateNowLine();
        this.renderTracking();
      }, 30_000)
    );
    // エディタのカーソル位置に合わせて、対応するタスクをハイライト
    this.registerDomEvent(document, "selectionchange", () => this.syncCursorDebounced());

    // Obsidian の起動時（レイアウト復元中）に開かれたときは、保管庫の索引や
    // リンク索引（resolvedLinks）がまだできておらず、そのまま読むと再スケジュール欄や
    // プロジェクト配下のタスクが空のまま描画されてしまう。初回の読み込みは復元後に行い、
    // リンク索引の初回構築が終わったタイミングでももう一度読み直す
    if (!this.app.workspace.layoutReady) {
      this.renderHeader();
      const ref = this.app.metadataCache.on("resolved", () => {
        this.app.metadataCache.offref(ref);
        this.reloadDebounced();
      });
      this.registerEvent(ref);
      this.app.workspace.onLayoutReady(() => void this.reload());
      return;
    }
    await this.reload();
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  onResize(): void {
    this.updateNarrow();
    // パネルを全面表示中はタイムラインが隠れていて高さを測れない（タイムラインへ戻すときに測り直す）
    if (this.isNarrow && this.narrowPane === "panel") return;
    this.remeasureTimeline();
  }

  /** タイムラインの高さの変化に追従する（ビューのリサイズ・隠れていたタイムラインの再表示時） */
  private remeasureTimeline(): void {
    // ズーム指定（4h/8h/12h）はビューの高さから縮尺を決めるので、高さが変わったら作り直す
    if (this.mode !== "month" && this.plugin.settings.zoomHours && this.scrollEl) {
      const h = this.computeHourHeight();
      if (Math.abs(h - this.hourHeightPx) > 0.5) this.rebuildTimeline();
    }
    if (this.shouldScroll) this.scrollToInitial();
  }

  // ---------- 狭い画面（スマホなど）: タイムライン ⇄ パネルの切り替え ----------

  /** ビューの幅から「狭い画面」かを判定し、変わっていたら表示へ反映する */
  private updateNarrow(): void {
    const w = this.contentEl.clientWidth;
    if (!w) return; // 非表示中などで測れないときは現状維持
    const narrow = w < NARROW_VIEW_WIDTH;
    if (narrow === this.isNarrow) return;
    this.isNarrow = narrow;
    this.applyNarrowClasses();
    this.renderInbox(); // 畳み・幅指定・リサイズハンドルの扱いが変わるので描き直す
  }

  /** is-narrow と表示中の面のクラス、切替ボタンの状態を反映する */
  private applyNarrowClasses(): void {
    this.contentEl.toggleClass("is-narrow", this.isNarrow);
    this.contentEl.toggleClass("is-pane-timeline", this.isNarrow && this.narrowPane === "timeline");
    this.contentEl.toggleClass("is-pane-panel", this.isNarrow && this.narrowPane === "panel");
    for (const [p, b] of this.paneBtns) b.toggleClass("is-active", p === this.narrowPane);
  }

  /** 狭い画面で全面に出す面を切り替える */
  setNarrowPane(pane: NarrowPane): void {
    if (this.narrowPane === pane) return;
    this.narrowPane = pane;
    this.applyNarrowClasses();
    this.renderInbox();
    // 隠れている間はタイムラインの高さを測れないので、出したときに測り直す
    if (pane === "timeline") this.remeasureTimeline();
  }

  /** タイムライン ⇄ パネルを切り替える（コマンド用）。広い画面では並んで表示中なので案内だけ出す */
  toggleNarrowPane(): void {
    if (!this.isNarrow) {
      new Notice("タイムラインとパネルは並んで表示されています（画面が狭いときに切り替えられます）");
      return;
    }
    this.setNarrowPane(this.narrowPane === "panel" ? "timeline" : "panel");
  }

  /** 設定変更時などに、グリッドから作り直す */
  rebuild(): void {
    if (!this.scrollEl) return;
    this.mode = this.plugin.settings.viewMode; // 設定画面で「既定の表示」を変えたときも追従する
    this.buildGrid();
    this.shouldScroll = true;
    void this.reload();
  }

  goToPrev(): void {
    this.setDate(this.shift(-1));
  }

  goToNext(): void {
    this.setDate(this.shift(1));
  }

  /** 表示モードに応じた「1つ前 / 後」の基準日 */
  private shift(dir: 1 | -1): Date {
    switch (this.mode) {
      case "day":
        return addDays(this.date, dir);
      case "3day":
        return addDays(this.date, 3 * dir);
      case "week":
        return addDays(this.date, 7 * dir);
      case "month": {
        const d = new Date(this.date.getFullYear(), this.date.getMonth() + dir, 1);
        const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
        return new Date(d.getFullYear(), d.getMonth(), Math.min(this.date.getDate(), last));
      }
    }
  }

  /** @deprecated goToPrev を使う */
  goToPrevDay(): void {
    this.goToPrev();
  }

  /** @deprecated goToNext を使う */
  goToNextDay(): void {
    this.goToNext();
  }

  goToToday(): void {
    this.setDate(startOfDay(new Date()));
  }

  /** 指定した日を表示する */
  showDate(d: Date): void {
    this.setDate(d);
  }

  setViewMode(mode: ViewMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.plugin.settings.viewMode = mode;
    void this.plugin.persistSettings();
    this.buildGrid();
    this.shouldScroll = true;
    void this.reload();
  }

  /** 日 → 3日 → 週 → 月 → 日 … と切り替える */
  toggleViewMode(): void {
    const order: ViewMode[] = ["day", "3day", "week", "month"];
    this.setViewMode(order[(order.indexOf(this.mode) + 1) % order.length]);
  }

  // ---------- 表示している日 ----------

  /** 表示中の日付（日: 1日 / 3日: 基準日から3日 / 週: 7日 / 月: カレンダーの 6 週分） */
  private visibleDays(): Date[] {
    const ws = this.plugin.settings.weekStart;
    switch (this.mode) {
      case "day":
        return [this.date];
      case "3day":
        return [0, 1, 2].map((i) => addDays(this.date, i));
      case "week": {
        const first = startOfWeek(this.date, ws);
        return Array.from({ length: 7 }, (_v, i) => addDays(first, i));
      }
      case "month": {
        const first = startOfWeek(new Date(this.date.getFullYear(), this.date.getMonth(), 1), ws);
        return Array.from({ length: 42 }, (_v, i) => addDays(first, i));
      }
    }
  }

  /** タイムライン（時間軸）を出すモードか */
  private isTimeline(): boolean {
    return this.mode !== "month";
  }

  /** 表示ONのメンバー（ブロック形式のときだけ） */
  private visibleMembers(): Member[] {
    if (!this.plugin.blockStore()) return [];
    return this.plugin.settings.members.filter((m) => m.visible && this.plugin.memberStores.has(m.id));
  }

  /** タスクの色: メンバーの予定はメンバー色、自分の予定はタグ色 */
  private taskColor(task: Task): string | null {
    if (task.owner) return this.plugin.memberOf(task.owner)?.color ?? null;
    return colorForTags(task.tags, this.plugin.settings.tagColors);
  }

  /** タスクの持ち主の名前（自分なら null） */
  private ownerName(task: Task): string | null {
    return task.owner ? (this.plugin.memberOf(task.owner)?.name ?? "?") : null;
  }

  /** タスクの持ち主に応じたストア */
  private storeOf(task: Task) {
    return this.plugin.storeFor(task.owner);
  }

  private columnFor(date: Date): DayColumn | null {
    const k = dateKey(date);
    return this.columns.find((c) => c.key === k) ?? null;
  }

  private dataFor(date: Date): DayData {
    return this.data.get(dateKey(date)) ?? { tasks: [], exists: false, legacyCount: 0 };
  }

  // ---------- 構築 ----------

  private buildSkeleton(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("dt-view");

    this.bannerEl = root.createDiv("dt-banner");
    // 左に Inbox のサイドバー、右にタイムライン
    const body = root.createDiv("dt-body");
    this.inboxEl = body.createDiv("dt-inbox");
    const main = body.createDiv("dt-main");

    // ツールバーはタイムラインの直上に1行だけ。よく使うもの（日付移動・モード切替・追加）を
    // 常時表示し、ズーム・予実・メンバーは「表示」メニュー、それ以外は ⋮ メニューにまとめる
    const bar = main.createDiv("dt-toolbar");

    // 狭い画面（スマホなど）だけに出す、タイムライン ⇄ パネル（Inbox・プロジェクト）の切替
    this.paneEl = bar.createDiv("dt-mode dt-pane");
    const panes: [NarrowPane, string, string][] = [
      ["timeline", "calendar-clock", "タイムラインを表示"],
      ["panel", "list-tree", "パネル（Inbox・プロジェクト・再スケジュール）を表示"],
    ];
    for (const [pane, icon, tip] of panes) {
      const b = this.paneEl.createEl("button", {
        cls: "dt-mode-btn dt-pane-btn",
        attr: { "aria-label": tip },
      });
      setIcon(b, icon);
      b.onclick = () => this.setNarrowPane(pane);
      this.paneBtns.set(pane, b);
    }

    const nav = bar.createDiv("dt-nav");
    this.iconButton(nav, "chevron-left", "前へ", () => this.goToPrev());
    const todayBtn = nav.createEl("button", { text: "今日", cls: "dt-today-btn" });
    todayBtn.onclick = () => this.goToToday();
    this.iconButton(nav, "chevron-right", "次へ", () => this.goToNext());

    const dateWrap = bar.createDiv("dt-date");
    this.dateLabelEl = dateWrap.createEl("button", {
      cls: "dt-date-label",
      attr: { "aria-label": "日付を選ぶ" },
    });
    this.dateInputEl = dateWrap.createEl("input", { type: "date", cls: "dt-date-input" });
    this.dateLabelEl.onclick = () => this.openDatePicker();
    this.dateInputEl.onchange = () => {
      const v = this.dateInputEl.value;
      if (!v) return;
      const [y, m, d] = v.split("-").map(Number);
      if (y && m && d) this.setDate(new Date(y, m - 1, d));
    };

    // 表示範囲（3日・週）の予実合計。表示中の範囲の情報なので日付ラベルの隣に置く
    this.rangeTotalEl = bar.createDiv("dt-range-total");

    bar.createDiv("dt-toolbar-spacer");

    // 実績を計測中のタスク（クリックで終了して実績に記録）
    this.trackingEl = bar.createEl("button", { cls: "dt-tracking-chip", attr: { "aria-label": "実績の計測" } });
    this.trackingEl.onclick = () => void this.plugin.stopTaskTracking(true);
    this.trackingEl.addEventListener("contextmenu", (e: MouseEvent) => {
      e.preventDefault();
      const menu = new Menu();
      menu.addItem((i) =>
        i.setTitle("計測を終了して実績に記録").setIcon("square").onClick(() => void this.plugin.stopTaskTracking(true))
      );
      menu.addItem((i) =>
        i.setTitle("記録せずにやめる").setIcon("x").onClick(() => void this.plugin.stopTaskTracking(false))
      );
      menu.showAtMouseEvent(e);
    });
    this.renderTracking();
    // タイマーは動作中だけチップを出す（開始は ⋮ メニューの「タイマー…」から）
    this.timerEl = bar.createEl("button", { cls: "dt-timer-chip", attr: { "aria-label": "タイマー" } });
    this.timerEl.onclick = () => this.plugin.openTimerModal();
    this.renderTimer();
    this.register(this.plugin.timer.onChange(() => this.renderTimer()));

    const modeWrap = bar.createDiv("dt-mode");
    const modes: [ViewMode, string][] = [
      ["day", "日"],
      ["3day", "3日"],
      ["week", "週"],
      ["month", "月"],
    ];
    for (const [mode, label] of modes) {
      const b = modeWrap.createEl("button", { text: label, cls: "dt-mode-btn" });
      b.onclick = () => this.setViewMode(mode);
      this.modeBtns.set(mode, b);
    }

    // ズーム・予実・メンバーの表示切替をまとめた「表示」メニュー
    const viewBtn = bar.createEl("button", {
      cls: "dt-view-menu-btn",
      attr: { "aria-label": "表示オプション（ズーム・予定と実績・メンバー）" },
    });
    viewBtn.createSpan({ text: "表示" });
    const caret = viewBtn.createSpan("dt-menu-caret");
    setIcon(caret, "chevron-down");
    viewBtn.onclick = () => {
      const menu = new Menu();
      this.buildViewMenu(menu);
      const r = viewBtn.getBoundingClientRect();
      menu.showAtPosition({ x: r.left, y: r.bottom + 4 });
    };

    this.iconButton(bar, "plus", "タスクを追加", () => this.openCreateModal(this.date));
    this.menuButton(bar, "その他（ノート・タイマー・定期タスク）", (menu) =>
      this.buildMoreMenu(menu)
    );

    this.scrollEl = main.createDiv("dt-scroll");
  }

  /** ツールバーの「表示」メニュー: ズーム・予定/実績・メンバーの表示切替 */
  private buildViewMenu(menu: Menu): void {
    const s = this.plugin.settings;
    let empty = true;
    if (this.isTimeline()) {
      empty = false;
      // 一度に表示する時間の幅（30分単位で作業する日は 4時間 に寄せる、など）
      menu.addItem((i) => i.setTitle("一度に表示する時間").setDisabled(true));
      const zooms: [number, string][] = [
        [4, "4時間（細かい作業向け）"],
        [8, "8時間"],
        [12, "12時間"],
        [0, "標準（設定の「1時間あたりの高さ」）"],
      ];
      for (const [hours, label] of zooms) {
        menu.addItem((i) =>
          i.setTitle(label).setChecked(s.zoomHours === hours).onClick(() => this.setZoom(hours))
        );
      }
      // 予定 / 予実 / 実績 の切替（ブロック形式のみ）
      if (this.plugin.blockStore()) {
        menu.addSeparator();
        menu.addItem((i) => i.setTitle("予定と実績").setDisabled(true));
        const paModes: [PlanActualMode, string][] = [
          ["plan", "予定だけを表示"],
          ["both", "予実（左に予定、右に実績）"],
          ["actual", "実績だけを表示"],
        ];
        for (const [m, label] of paModes) {
          menu.addItem((i) =>
            i.setTitle(label).setChecked(s.paMode === m).onClick(() => this.setPaMode(m))
          );
        }
      }
    }
    // メンバー（他の人の予定）の表示切替
    if (this.plugin.blockStore() && s.members.length > 0) {
      if (!empty) menu.addSeparator();
      empty = false;
      menu.addItem((i) => i.setTitle("メンバーの予定").setDisabled(true));
      for (const m of s.members) {
        menu.addItem((i) =>
          i
            .setTitle(m.name || "(名前未設定)")
            .setChecked(m.visible)
            .onClick(() => {
              m.visible = !m.visible;
              void this.plugin.persistSettings();
              void this.reload();
            })
        );
      }
      if (s.members.length > 1) {
        const all = s.members.every((m) => m.visible);
        menu.addItem((i) =>
          i.setTitle(all ? "自分だけにする" : "全員を表示").onClick(() => {
            for (const m of s.members) m.visible = !all;
            void this.plugin.persistSettings();
            void this.reload();
          })
        );
      }
    }
    if (empty) {
      menu.addItem((i) => i.setTitle("月表示では表示オプションはありません").setDisabled(true));
    }
  }

  /** ツールバーの ⋮ メニュー: ノート・タイマー・定期タスク */
  private buildMoreMenu(menu: Menu): void {
    const m = moment(this.date);
    const exists = this.dataFor(this.date).exists;
    menu.addItem((i) =>
      i
        .setTitle(`${exists ? "ノートを開く" : "ノートを作成して開く"}（${m.format("M月D日")}）`)
        .setIcon("file-text")
        .onClick(() => void this.openNote(this.date))
    );
    menu.addItem((i) =>
      i.setTitle("タイマー…").setIcon("timer").onClick(() => this.plugin.openTimerModal())
    );
    menu.addItem((i) =>
      i.setTitle("定期タスクを管理").setIcon("repeat").onClick(() => void this.plugin.activateRecurringView())
    );
  }

  /** アイコンボタン（クリック / Enter / Space で動作） */
  private iconButton(
    parent: HTMLElement,
    icon: string,
    label: string,
    onClick: () => void
  ): HTMLElement {
    const btn = parent.createDiv({
      cls: "clickable-icon dt-icon-btn",
      attr: { "aria-label": label, role: "button", tabindex: "0" },
    });
    setIcon(btn, icon);
    btn.addEventListener("click", onClick);
    btn.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onClick();
      }
    });
    return btn;
  }

  /**
   * ケバブメニューのボタン（⋮）。アイコンをいくつも並べる代わりに、
   * まとめて1つのメニューから選べるようにする。
   * クリックはその場所に、キーボード（Enter / Space）ではボタンの真下にメニューを出す
   */
  private menuButton(
    parent: HTMLElement,
    label: string,
    build: (menu: Menu) => void
  ): HTMLElement {
    const btn = parent.createDiv({
      cls: "clickable-icon dt-icon-btn dt-kebab-btn",
      attr: { "aria-label": label, role: "button", tabindex: "0" },
    });
    setIcon(btn, "more-vertical");
    const open = (e: MouseEvent | null) => {
      const menu = new Menu();
      build(menu);
      if (e) menu.showAtMouseEvent(e);
      else {
        const r = btn.getBoundingClientRect();
        menu.showAtPosition({ x: r.left, y: r.bottom });
      }
    };
    btn.addEventListener("click", (e: MouseEvent) => open(e));
    btn.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open(null);
      }
    });
    return btn;
  }

  /** 表示中の日付に合わせて、時間軸と日ごとの列（月表示ならカレンダーのマス）を作る */
  private buildGrid(): void {
    const s = this.plugin.settings;
    this.hourHeightPx = this.computeHourHeight(); // scrollEl を空にする前（レイアウトが生きているうち）に測る
    this.scrollEl.empty();
    this.columns = [];
    this.monthCells.clear();
    this.taskEls.clear();

    this.contentEl.toggleClass("is-week", this.mode === "week");
    this.contentEl.toggleClass("is-3day", this.mode === "3day");
    this.contentEl.toggleClass("is-day", this.mode === "day");
    this.contentEl.toggleClass("is-month", this.mode === "month");
    this.contentEl.toggleClass("is-multi-day", this.mode === "week" || this.mode === "3day");

    if (this.mode === "month") {
      this.buildMonthGrid();
      return;
    }

    // 曜日・日付のヘッダー（スクロールしても上に残る）
    this.headersEl = this.scrollEl.createDiv("dt-day-headers");
    this.headersEl.createDiv("dt-day-headers-spacer");
    const headerCells = this.headersEl.createDiv("dt-day-headers-cells");

    const grid = this.scrollEl.createDiv("dt-grid");
    this.labelsEl = grid.createDiv("dt-labels");
    this.daysEl = grid.createDiv("dt-days");

    const height = (s.endHour - s.startHour) * this.hourHeightPx;
    this.labelsEl.style.height = height + "px";

    for (let h = s.startHour; h <= s.endHour; h++) {
      const top = (h - s.startHour) * this.hourHeightPx;
      const label = this.labelsEl.createDiv({ cls: "dt-hour-label", text: `${h}:00` });
      label.style.top = top + "px";
    }

    for (const date of this.visibleDays()) {
      const headerEl = headerCells.createDiv("dt-day-header");
      const canvasEl = this.daysEl.createDiv("dt-canvas");
      canvasEl.style.height = height + "px";
      canvasEl.setAttr("data-date", dateKey(date));

      for (let h = s.startHour; h <= s.endHour; h++) {
        const top = (h - s.startHour) * this.hourHeightPx;
        const line = canvasEl.createDiv("dt-hour-line");
        line.style.top = top + "px";
        if (h < s.endHour) {
          const half = canvasEl.createDiv("dt-half-line");
          half.style.top = top + this.hourHeightPx / 2 + "px";
        }
      }
      const eventsEl = canvasEl.createDiv("dt-events");
      const col: DayColumn = { date, key: dateKey(date), headerEl, canvasEl, eventsEl, nowEl: null };
      canvasEl.addEventListener("pointerdown", (e) => this.onCanvasPointerDown(e, col));
      this.columns.push(col);
    }
    this.renderDayHeaders();
  }

  /** 月表示のカレンダー（曜日ヘッダー + 6 週 × 7 日のマス） */
  private buildMonthGrid(): void {
    const ws = this.plugin.settings.weekStart;
    const wrap = this.scrollEl.createDiv("dt-month");
    const head = wrap.createDiv("dt-month-weekdays");
    for (let i = 0; i < 7; i++) {
      const dow = (ws + i) % 7;
      const c = head.createDiv({ cls: "dt-month-weekday", text: WEEKDAY_JA[dow] });
      c.toggleClass("is-sunday", dow === 0);
      c.toggleClass("is-saturday", dow === 6);
    }
    const grid = wrap.createDiv("dt-month-grid");
    for (const date of this.visibleDays()) {
      const cell = grid.createDiv("dt-month-cell");
      const dow = date.getDay();
      cell.toggleClass("is-today", isToday(date));
      cell.toggleClass("is-sunday", dow === 0);
      cell.toggleClass("is-saturday", dow === 6);
      cell.toggleClass("is-other-month", date.getMonth() !== this.date.getMonth());
      const top = cell.createDiv("dt-month-cell-head");
      const num = top.createEl("button", {
        cls: "dt-month-daynum",
        text: date.getDate() === 1 ? `${date.getMonth() + 1}/1` : String(date.getDate()),
        attr: { "aria-label": `${moment(date).format("M月D日 (ddd)")} を日表示で開く` },
      });
      num.onclick = (e) => {
        e.stopPropagation();
        this.date = startOfDay(date);
        this.setViewMode("day");
      };
      const add = this.iconButton(top, "plus", "タスクを追加", () => this.openCreateModal(date));
      add.addClass("dt-month-add");
      const listEl = cell.createDiv("dt-month-list");
      // 空きをクリック → その日にタスクを追加
      cell.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest(".dt-month-item, .dt-month-daynum, .dt-month-add")) return;
        this.openCreateModal(date);
      });
      this.monthCells.set(dateKey(date), { date, el: cell, listEl });
    }
  }

  private renderDayHeaders(): void {
    for (const col of this.columns) {
      const el = col.headerEl;
      el.empty();
      const dow = col.date.getDay();
      el.toggleClass("is-today", isToday(col.date));
      el.toggleClass("is-sunday", dow === 0);
      el.toggleClass("is-saturday", dow === 6);
      el.toggleClass("is-other-month", col.date.getMonth() !== this.date.getMonth());
      el.createSpan({ cls: "dt-day-header-dow", text: WEEKDAY_JA[dow] });
      el.createSpan({ cls: "dt-day-header-num", text: String(col.date.getDate()) });
      el.setAttr("aria-label", `${moment(col.date).format("M月D日 (ddd)")} を日表示で開く`);
      el.onclick = () => {
        this.date = startOfDay(col.date);
        this.setViewMode("day");
      };
    }
  }

  // ---------- データ ----------

  private onVaultChange(path: string): void {
    const inbox = this.plugin.inbox;
    if (inbox && path === inbox.pathFor(INBOX_DATE)) {
      this.reloadDebounced();
      return;
    }
    // プロジェクトノートの変更もパネルに反映する（グループ・完了チェックの手書き編集など）
    const projects = this.plugin.projects;
    if (projects && this.plugin.settings.showProjects && path.startsWith(projects.folder() + "/")) {
      this.reloadDebounced();
      return;
    }
    const stores = [this.plugin.store, ...this.visibleMembers().map((m) => this.plugin.memberStores.get(m.id)!)];
    for (const d of this.visibleDays()) {
      for (const st of stores) {
        if (path === st.pathFor(d)) {
          this.reloadDebounced();
          return;
        }
      }
    }
    // 表示範囲の外でも、再スケジュール欄が見ている過去のノートなら読み直す
    const blockStore = this.plugin.blockStore();
    if (blockStore && this.plugin.settings.showUnscheduledTray) {
      const d = blockStore.dateFromPath(path);
      if (d) {
        const today = startOfDay(new Date());
        if (d <= today && d >= addDays(today, -RESCHEDULE_LOOKBACK_DAYS)) this.reloadDebounced();
      }
    }
  }

  private async reload(): Promise<void> {
    if (this.interacting) {
      this.pendingReload = true;
      return;
    }
    this.updateNarrow(); // 開いた直後などで onResize より先に来たときのための再判定
    const s = this.plugin.settings;
    const store = this.plugin.store;
    const blockStore = this.plugin.blockStore();
    const days = this.visibleDays();
    // 月表示では 6 週分のノートを先に作らないよう、定期タスクの自動反映はしない（薄く表示だけする）
    if (this.isTimeline()) {
      try {
        await applyRecurring(this.plugin, days);
      } catch (e) {
        console.error(e);
      }
    }
    // プロジェクトの集計（パネル用）。Inbox の表示判定にも使うので先に読む
    if (this.plugin.projects && s.showProjects) {
      try {
        this.projectData = await this.plugin.projectSummaries();
      } catch (e) {
        console.error(e);
      }
    } else {
      this.projectData = [];
    }
    const inbox = this.plugin.inbox;
    this.inboxTasks =
      inbox && s.showInbox ? this.inboxVisible((await inbox.load(INBOX_DATE)).tasks) : [];
    const memberStores = this.visibleMembers().map((m) => this.plugin.memberStores.get(m.id)!);
    const loaded = await Promise.all(
      days.map(async (d): Promise<[string, DayData]> => {
        const day = await store.load(d);
        const legacyCount =
          s.storageFormat === "block" && day.exists && blockStore
            ? await blockStore.countLegacyEvents(d)
            : 0;
        const tasks = [...day.tasks];
        for (const ms of memberStores) {
          try {
            tasks.push(...(await ms.load(d)).tasks);
          } catch (e) {
            console.error(e);
          }
        }
        return [dateKey(d), { tasks, exists: day.exists, legacyCount }];
      })
    );
    this.data = new Map(loaded);
    try {
      this.pastUnscheduled = await this.loadPastUnscheduled();
    } catch (e) {
      console.error(e);
      this.pastUnscheduled = [];
    }
    this.renderHeader();
    this.renderBanner();
    this.renderInbox();
    this.renderEvents();
    if (this.shouldScroll) this.scrollToInitial();
  }

  private setDate(d: Date): void {
    const next = startOfDay(d);
    let sameRange: boolean;
    switch (this.mode) {
      case "week":
        sameRange = isSameDay(
          startOfWeek(next, this.plugin.settings.weekStart),
          startOfWeek(this.date, this.plugin.settings.weekStart)
        );
        break;
      case "month":
        sameRange =
          next.getFullYear() === this.date.getFullYear() && next.getMonth() === this.date.getMonth();
        break;
      default:
        sameRange = isSameDay(next, this.date);
    }
    this.date = next;
    if (sameRange) {
      // 同じ範囲内の移動（週表示で日付ピッカーから選んだときなど）は列を作り直さない
      this.renderDayHeaders();
      this.renderDayTotals();
      this.renderHeader();
      return;
    }
    this.buildGrid();
    this.shouldScroll = true;
    void this.reload();
  }

  // ---------- 描画 ----------

  private renderHeader(): void {
    const m = moment(this.date);
    if (this.mode === "day") {
      this.dateLabelEl.setText(m.format("YYYY年M月D日 (ddd)"));
      this.dateLabelEl.toggleClass("is-today", isToday(this.date));
    } else if (this.mode === "month") {
      const now = new Date();
      this.dateLabelEl.setText(m.format("YYYY年M月"));
      this.dateLabelEl.toggleClass(
        "is-today",
        now.getFullYear() === this.date.getFullYear() && now.getMonth() === this.date.getMonth()
      );
    } else {
      const days = this.visibleDays();
      const a = moment(days[0]);
      const b = moment(days[days.length - 1]);
      const endFmt =
        a.year() !== b.year() ? "YYYY年M月D日" : a.month() !== b.month() ? "M月D日" : "D日";
      this.dateLabelEl.setText(`${a.format("YYYY年M月D日")} 〜 ${b.format(endFmt)}`);
      this.dateLabelEl.toggleClass(
        "is-today",
        days.some((d) => isToday(d))
      );
    }
    this.dateInputEl.value = m.format("YYYY-MM-DD");
    for (const [mode, b] of this.modeBtns) b.toggleClass("is-active", mode === this.mode);
    this.renderTracking();
  }

  /** ツールバーの「実績を計測中」チップ（main の startTaskTracking からも呼ばれる） */
  renderTracking(): void {
    if (!this.trackingEl) return;
    const tr = this.plugin.settings.tracking;
    this.trackingEl.toggleClass("is-visible", !!tr);
    if (!tr) return;
    const sameDay = dateKey(new Date()) === tr.date;
    const elapsed = Math.max(sameDay ? nowMinutes() - tr.startMin : 1440 - tr.startMin, 0);
    this.trackingEl.setText(`⏺ ${formatDuration(elapsed)} ${tr.title}`);
    this.trackingEl.setAttr(
      "aria-label",
      `実績を計測中: ${tr.title}\nクリックで終了して実績に記録（右クリックでメニュー）`
    );
  }

  /** ツールバーのタイマー表示（動作中だけ。開始は ⋮ メニューから） */
  private renderTimer(): void {
    if (!this.timerEl) return;
    const timer = this.plugin.timer;
    const st = timer.getState();
    if (st.endAt !== null) {
      this.timerEl.setText(`⏱ ${formatSeconds(timer.remainingSeconds())}${st.label ? ` ${st.label}` : ""}`);
      this.timerEl.toggleClass("is-visible", true);
      this.timerEl.toggleClass("is-finished", false);
    } else if (st.finished) {
      this.timerEl.setText(`⏱ 終了${st.label ? ` ${st.label}` : ""}`);
      this.timerEl.toggleClass("is-visible", true);
      this.timerEl.toggleClass("is-finished", true);
      this.timerEl.onclick = () => timer.dismiss();
      return;
    } else {
      this.timerEl.toggleClass("is-visible", false);
    }
    this.timerEl.onclick = () => this.plugin.openTimerModal();
  }

  /** 旧形式の予定が残っているときの変換案内 */
  private renderBanner(): void {
    this.bannerEl.empty();
    const pending = this.visibleDays()
      .map((date) => ({ date }))
      .filter((c) => this.dataFor(c.date).legacyCount > 0);
    const total = pending.reduce((n, c) => n + this.dataFor(c.date).legacyCount, 0);
    this.bannerEl.toggleClass("is-visible", total > 0);
    if (total === 0) return;
    this.bannerEl.createSpan({
      text:
        pending.length === 1
          ? `旧形式の予定が ${total} 件あります。タスクブロックに変換できます。`
          : `旧形式の予定が ${pending.length} 日分・${total} 件あります。タスクブロックに変換できます。`,
    });
    const btn = this.bannerEl.createEl("button", { text: "変換", cls: "mod-cta" });
    btn.onclick = async () => {
      for (const c of pending) await this.plugin.migrateNoteFor(c.date);
      await this.reload();
    };
  }

  /** Inbox パネルに出すタスク: 未完了のもののうち、プロジェクト付きでないもの
   *（プロジェクト付きはプロジェクトパネル側に出る。完了してもノートには残る）。
   * ただし、そのプロジェクトがパネルに出ていない（完了済み・ノートが見つからない・
   * パネル非表示）タスクは、どこにも表示されず行方不明になるので Inbox 側に出す */
  private inboxVisible(tasks: Task[]): Task[] {
    return tasks.filter((t) => !t.done && (!t.project || !this.projectPanelShows(t.project)));
  }

  /** そのプロジェクトリンクが、プロジェクトパネルに進行中の行として出ているか */
  private projectPanelShows(linktext: string): boolean {
    if (!this.plugin.projects || !this.plugin.settings.showProjects) return false;
    const src = this.plugin.inbox?.pathFor(INBOX_DATE) ?? "";
    // プロジェクトの集計（projectSummaries）と同じ方法でリンク先を解決して照合する
    const dest = this.app.metadataCache.getFirstLinkpathDest(linktext, src);
    const key = dest?.path ?? linktext + ".md";
    return this.projectData.some((s) => !s.done && s.ref.linktext + ".md" === key);
  }

  /** Inbox だけ読み直す（コマンドから追加したときなど） */
  async reloadInbox(): Promise<void> {
    const inbox = this.plugin.inbox;
    if (!inbox || !this.inboxEl) return;
    this.inboxTasks = this.plugin.settings.showInbox
      ? this.inboxVisible((await inbox.load(INBOX_DATE)).tasks)
      : [];
    this.renderInbox();
  }

  /** 左サイドバー（Inbox・プロジェクト・再スケジュール）のパネル。タブで1つずつ表示する */
  private renderInbox(): void {
    const s = this.plugin.settings;
    const inbox = this.plugin.inbox;
    this.inboxEl.empty();
    const showInbox = !!inbox && s.showInbox;
    const showProjects = !!this.plugin.projects && s.showProjects;
    const reschedule = this.rescheduleGroups();
    const showReschedule = reschedule.length > 0;
    const visible = showInbox || showProjects || showReschedule;
    this.inboxEl.toggleClass("is-visible", visible);
    // 狭い画面の切替ボタンは、パネルに出すものがあるときだけ出す
    this.paneEl.toggleClass("is-available", visible);
    if (!visible && this.narrowPane === "panel") {
      // パネルに出すものが無くなったら、真っ白にならないようタイムラインへ戻す
      this.narrowPane = "timeline";
      this.applyNarrowClasses();
    }
    if (!visible) return;

    // 縦に全部並べると長くなるので、タブで1つだけ表示する。
    // 再スケジュールのタブは、今までの欄と同じくタスクがあるときだけ出る
    const activeProjects = this.projectData.filter((x) => !x.done);
    const tabs: { id: SidebarTab; label: string; count: number }[] = [];
    if (showInbox) tabs.push({ id: "inbox", label: "Inbox", count: this.inboxTasks.length });
    if (showProjects)
      tabs.push({ id: "projects", label: "プロジェクト", count: activeProjects.length });
    if (showReschedule)
      tabs.push({
        id: "reschedule",
        label: "再スケジュール",
        count: reschedule.reduce((n, g) => n + g.tasks.length, 0),
      });
    // 選んでいたタブが出ていないとき（再スケジュールが空になった等）は先頭のタブへ。
    // 設定は書き換えないので、また出てきたら選んでいたタブに戻る
    const active = tabs.find((t) => t.id === s.sidebarTab) ?? tabs[0];

    // 狭い画面でパネルを全面表示しているときは、畳まず幅も固定しない
    const narrowPanel = this.isNarrow && this.narrowPane === "panel";
    const collapsed = s.inboxCollapsed && !narrowPanel;
    this.inboxEl.toggleClass("is-collapsed", collapsed);
    this.applySidebarWidth(collapsed || narrowPanel ? null : s.sidebarWidth);
    if (!collapsed && !narrowPanel) this.attachSidebarResize();

    const doToggle = () => {
      s.inboxCollapsed = !s.inboxCollapsed;
      void this.plugin.persistSettings();
      this.renderInbox();
    };
    const head = this.inboxEl.createDiv("dt-inbox-head");
    if (narrowPanel) {
      // パネルを全面表示中はツールバー（タイムライン⇄パネルの切替ごと）が隠れているので、
      // タイムラインへ戻るボタンをここに出す
      const back = this.iconButton(head, "calendar-clock", "タイムラインを表示", () =>
        this.setNarrowPane("timeline")
      );
      back.addClass("dt-inbox-toggle");
    } else {
      const toggle = this.iconButton(
        head,
        collapsed ? "panel-left-open" : "panel-left-close",
        collapsed ? "パネルを開く" : "パネルを畳む",
        doToggle
      );
      toggle.addClass("dt-inbox-toggle");
    }
    const label = head.createSpan({ cls: "dt-inbox-label", text: active.label });
    if (!narrowPanel) label.onclick = doToggle;
    head.createSpan({ cls: "dt-inbox-count", text: String(active.count) });
    // 表示中のタブの操作ボタンだけをヘッダーに出す
    if (active.id === "inbox") {
      const addBtn = this.iconButton(head, "plus", "Inbox にタスクを追加", () =>
        this.plugin.openInboxAddModal()
      );
      addBtn.addClass("dt-inbox-add");
      const openBtn = this.iconButton(head, "file-text", "Inbox のノートを開く", () =>
        void inbox
          ?.ensureFile(INBOX_DATE)
          .then((f) => this.app.workspace.getLeaf("tab").openFile(f))
      );
      openBtn.addClass("dt-inbox-open");
    } else if (active.id === "projects") {
      const kebab = this.menuButton(head, "プロジェクトのメニュー", (menu) =>
        this.buildProjectsMenu(menu, activeProjects)
      );
      kebab.addClass("dt-inbox-open");
    } else {
      const addBtn = this.iconButton(head, "plus", "時刻を決めていないタスクを追加", () =>
        this.openCreateModal(this.date, null, null)
      );
      addBtn.addClass("dt-reschedule-add", "dt-inbox-open");
    }
    if (collapsed) return;

    // タブの切り替え（2つ以上あるときだけ。1つならヘッダーのラベルで足りる）
    if (tabs.length > 1) {
      const bar = this.inboxEl.createDiv("dt-panel-tabs");
      const today = startOfDay(new Date());
      for (const tab of tabs) {
        const el = bar.createDiv({ cls: "dt-panel-tab", text: tab.label });
        el.toggleClass("is-active", tab.id === active.id);
        const tips = [`${tab.label}: ${tab.count} 件`];
        // 過去の取り残しは、別のタブを見ていても気付けるよう赤い点を出す
        if (tab.id === "reschedule" && reschedule.some((g) => g.date < today)) {
          el.addClass("has-overdue");
          tips.push("過去に取り残された時刻なしタスクがあります");
        }
        el.setAttr("aria-label", tips.join("\n"));
        el.addEventListener("click", () => {
          if (s.sidebarTab === tab.id) return;
          s.sidebarTab = tab.id;
          void this.plugin.persistSettings();
          this.renderInbox();
        });
      }
    }

    if (active.id === "inbox") this.renderInboxList();
    else if (active.id === "projects") this.renderProjects(activeProjects);
    else this.renderReschedule(reschedule);
  }

  /** Inbox タブの中身（日付を決めていないタスクの一覧） */
  private renderInboxList(): void {
    const s = this.plugin.settings;
    const list = this.inboxEl.createDiv("dt-inbox-list");
    if (this.inboxTasks.length === 0) {
      list.createSpan({
        cls: "dt-tray-empty",
        text: "日付を決めずに登録したタスクがここに並びます。タイムラインへドラッグで予定に。",
      });
    }
    for (const t of this.inboxTasks) {
      const chip = list.createDiv("dt-tray-chip dt-inbox-chip");
      chip.toggleClass("is-done", t.done);
      const color = colorForTags(t.tags, s.tagColors);
      if (color) {
        const dot = chip.createSpan("dt-tray-color");
        dot.style.background = color;
      }
      const box = chip.createDiv("dt-tray-check");
      setIcon(box, t.done ? "check-circle-2" : "circle");
      box.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.commitInboxUpdate(t, { ...this.draftOf(t), done: !t.done });
      });
      chip.createSpan({ cls: "dt-tray-title", text: this.displayTitle(t) });
      if (t.project) {
        // プロジェクトがパネルに出ていない（完了済み・見つからない）ため Inbox に出ているタスク
        const link = t.project;
        const badge = chip.createSpan({ cls: "dt-inbox-project", text: projectDisplayName(link) });
        badge.setAttr(
          "aria-label",
          `プロジェクト: ${projectDisplayName(link)}\n` +
            "このプロジェクトはパネルに出ていない（完了済み・ノートが見つからない）ため、タスクを Inbox に表示しています。クリックでノートを開く"
        );
        badge.addEventListener("pointerdown", (ev) => ev.stopPropagation());
        badge.addEventListener("click", (ev) => {
          ev.stopPropagation();
          void this.plugin.openProject(link);
        });
      }
      chip.setAttr("aria-label", [t.title, t.doneCondition ? `完了条件: ${t.doneCondition}` : "", t.preview].filter(Boolean).join("\n"));
      this.attachInboxInteractions(chip, t);
    }
  }

  /** サイドバーの幅を反映する（null なら CSS の既定 = 畳んだ状態に任せる） */
  private applySidebarWidth(width: number | null): void {
    if (width === null) {
      this.inboxEl.style.width = "";
      this.inboxEl.style.flexBasis = "";
      return;
    }
    const w = clamp(width, 160, 480);
    this.inboxEl.style.width = w + "px";
    this.inboxEl.style.flexBasis = w + "px";
  }

  /** サイドバーの右端をドラッグして幅を変えるハンドル */
  private attachSidebarResize(): void {
    const grip = this.inboxEl.createDiv({
      cls: "dt-sidebar-resize",
      attr: { "aria-label": "ドラッグで幅を変更" },
    });
    grip.addEventListener("pointerdown", (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const startW = this.inboxEl.getBoundingClientRect().width;
      const startX = e.clientX;
      let w = startW;
      this.startDrag(grip, e, {
        onMove: (_dy, ev) => {
          w = clamp(startW + (ev.clientX - startX), 160, 480);
          this.applySidebarWidth(w);
        },
        onEnd: (moved) => {
          if (!moved) return;
          this.plugin.settings.sidebarWidth = Math.round(w);
          void this.plugin.persistSettings();
        },
        onCancel: () => this.applySidebarWidth(this.plugin.settings.sidebarWidth),
      });
    });
  }

  /** 進行中のプロジェクトがすべて展開されているか */
  private areAllProjectsExpanded(): boolean {
    const active = this.projectData.filter((s) => !s.done);
    return active.length > 0 && active.every((s) => this.expandedProjects.has(s.ref.linktext));
  }

  /** プロジェクトのツリーをまとめて展開 / 閉じる（パネルのボタン・コマンドから） */
  setAllProjectsExpanded(expand: boolean): void {
    if (expand) {
      for (const s of this.projectData) {
        if (!s.done) this.expandedProjects.add(s.ref.linktext);
      }
      // 畳んだグループの中のプロジェクトも見えるように、グループも開く
      this.collapsedGroups.clear();
    } else {
      this.expandedProjects.clear();
    }
    this.renderInbox();
  }

  /** すべて展開 ⇄ すべて閉じるを切り替える（コマンド用） */
  toggleAllProjects(): void {
    this.setAllProjectsExpanded(!this.areAllProjectsExpanded());
  }

  /** プロジェクト一覧をグループごとのツリー ⇄ 階層なしのフラットな一覧で切り替える（パネルのボタン・コマンドから） */
  toggleProjectsFlatList(): void {
    this.plugin.settings.projectsFlatList = !this.plugin.settings.projectsFlatList;
    void this.plugin.persistSettings();
    this.renderInbox();
  }

  /** プロジェクトのパネルのヘッダー（⋮）から開くメニュー。active は進行中のプロジェクト */
  private buildProjectsMenu(menu: Menu, active: ProjectSummary[]): void {
    menu.addItem((i) =>
      i
        .setTitle("新しいプロジェクトを作成…")
        .setIcon("plus")
        .onClick(() => this.plugin.openNewProjectModal())
    );
    if (active.length) {
      menu.addSeparator();
      const allExpanded = this.areAllProjectsExpanded();
      menu.addItem((i) =>
        i
          .setTitle(allExpanded ? "すべてのプロジェクトを閉じる" : "すべてのプロジェクトを展開")
          .setIcon(allExpanded ? "chevrons-down-up" : "chevrons-up-down")
          .onClick(() => this.setAllProjectsExpanded(!allExpanded))
      );
      // グループ分けしているときだけ: ツリー ⇄ フラットな一覧の切り替え
      if (active.some((s) => s.ref.group)) {
        const flat = this.plugin.settings.projectsFlatList;
        menu.addItem((i) =>
          i
            .setTitle(
              flat
                ? "グループごとのツリーで表示"
                : "グループの見出しを出さずフラットに一覧"
            )
            .setIcon(flat ? "list-tree" : "list")
            .onClick(() => this.toggleProjectsFlatList())
        );
      }
      const hideDone = this.plugin.settings.projectsHideDone;
      menu.addItem((i) =>
        i
          .setTitle(
            hideDone ? "完了済みの子タスクを表示する" : "完了済みの子タスクを隠す（持ち越し済みも）"
          )
          .setIcon(hideDone ? "eye-off" : "eye")
          .onClick(() => {
            this.plugin.settings.projectsHideDone = !hideDone;
            void this.plugin.persistSettings();
            this.renderInbox();
          })
      );
    }
    menu.addSeparator();
    menu.addItem((i) =>
      i
        .setTitle("全プロジェクトノートのタスク一覧を更新")
        .setIcon("file-text")
        .onClick(() => void this.plugin.updateAllProjectNotes())
    );
  }

  /** プロジェクトのタブの中身（一覧・進捗・予実合計・子タスク）。完了済のプロジェクトは出さない。
   * ⋮（ケバブ）メニューはパネルのヘッダー側に出る */
  private renderProjects(active: ProjectSummary[]): void {
    const hiddenDone = this.projectData.length - active.length;
    const wrap = this.inboxEl.createDiv("dt-projects");
    const list = wrap.createDiv("dt-projects-list");
    if (!active.length) {
      list.createSpan({
        cls: "dt-tray-empty",
        text: hiddenDone
          ? `進行中のプロジェクトはありません（完了済 ${hiddenDone} 件は非表示）。`
          : "上の ⋮ メニューの「新しいプロジェクトを作成」、またはタスクの編集ダイアログの「プロジェクト」欄から作成すると、ここに一覧されます。",
      });
      return;
    }
    const groups = groupProjects(
      active,
      this.plugin.settings.projectGroups.map((x) => x.name)
    );
    const hasGroups = groups.some((g) => g.name !== null);
    // どのプロジェクトにもグループが無ければ今までどおりのフラットな一覧。
    // 「フラットな一覧で表示」がオンのときも見出しを出さず、グループ順に並べたまま平らにする
    if (!hasGroups || this.plugin.settings.projectsFlatList) {
      for (const g of groups) {
        for (const sum of g.items) this.renderProjectRow(list, sum);
      }
      return;
    }
    const groupIcons = this.groupIconMap();
    for (const g of groups) {
      const groupKey = g.name ?? "";
      const collapsed = this.collapsedGroups.has(groupKey);
      const groupHead = list.createDiv("dt-project-group");
      const groupChev = groupHead.createDiv("dt-project-chevron");
      setIcon(groupChev, collapsed ? "chevron-right" : "chevron-down");
      // グループごとの指定があればそれ、無ければ既定のアイコン（未分類は常に既定）
      const custom = g.name !== null ? groupIcons.get(g.name) : undefined;
      const icon = custom ?? this.plugin.settings.defaultGroupIcon.trim();
      if (icon) {
        const iconEl = groupHead.createSpan("dt-project-group-icon");
        renderGroupIcon(iconEl, icon);
      }
      groupHead.createSpan({ cls: "dt-project-group-name", text: g.name ?? "未分類" });
      groupHead.createSpan({ cls: "dt-project-group-count", text: String(g.items.length) });
      groupHead.setAttr(
        "aria-label",
        `${g.name ?? "未分類"}: プロジェクト ${g.items.length} 件\nクリックでグループを開閉`
      );
      groupHead.addEventListener("click", () => {
        if (collapsed) this.collapsedGroups.delete(groupKey);
        else this.collapsedGroups.add(groupKey);
        this.renderInbox();
      });
      if (collapsed) continue;
      const itemsEl = list.createDiv("dt-project-group-items");
      for (const sum of g.items) this.renderProjectRow(itemsEl, sum);
    }
  }

  /** プロジェクト1件分（行 + 展開時の子タスク一覧）をパネルへ描画する */
  private renderProjectRow(container: HTMLElement, sum: ProjectSummary): void {
    const key = sum.ref.linktext;
    const expanded = this.expandedProjects.has(key);

    const row = container.createDiv("dt-project-row");
    const chev = row.createDiv("dt-project-chevron");
    setIcon(chev, expanded ? "chevron-down" : "chevron-right");
    // グループ見出しと見分けるためのアイコン（設定「プロジェクトのアイコン」。空欄なら出さない）
    const projectIcon = this.plugin.settings.defaultProjectIcon.trim();
    if (projectIcon) {
      const iconEl = row.createSpan("dt-project-icon");
      renderGroupIcon(iconEl, projectIcon);
    }
    const name = row.createSpan({ cls: "dt-project-name", text: sum.ref.name });
    const total = sum.children.length;
    // プロジェクト自身の期日・チケット（ノートの「- 期日: 」「- チケット: 」行）
    const fields = sum.fields;
    if (fields?.due) {
      const dueLabel = fields.dueDate
        ? moment(fields.dueDate).format(
            moment(fields.dueDate).year() === moment().year() ? "M/D" : "YYYY/M/D"
          )
        : fields.due;
      const dueEl = row.createSpan({ cls: "dt-project-due", text: `期日 ${dueLabel}` });
      if (fields.dueDate && fields.dueDate.getTime() < startOfDay(new Date()).getTime())
        dueEl.addClass("is-overdue");
    }
    if (fields?.ticket) {
      const t = fields.ticket;
      const badge = row.createSpan({ cls: "dt-project-ticket", text: `#${t.id}` });
      const url = ticketUrl(this.plugin.settings.trackers, t.tracker, t.id);
      badge.setAttr("aria-label", `${t.tracker || "チケット"} #${t.id}` + (url ? `\n${url}` : ""));
      if (url) {
        badge.addClass("is-linked");
        badge.addEventListener("pointerdown", (ev) => ev.stopPropagation());
        badge.addEventListener("click", (ev) => {
          ev.stopPropagation();
          window.open(url);
        });
      }
    }
    const stats = row.createSpan({ cls: "dt-project-stats" });
    stats.setText(
      total
        ? `${sum.doneCount}/${total}・予${hmm(sum.planMin)}・実${hmm(sum.actMin)}`
        : "タスクなし"
    );
    // 行のホバー時のツールチップは情報量が多すぎたため、いったん出さない
    const openBtn = this.iconButton(row, "arrow-up-right", "プロジェクトノートを開く", () =>
      void this.plugin.openProject(key)
    );
    openBtn.addClass("dt-project-open");
    const addBtn = this.iconButton(
      row,
      "plus",
      "このプロジェクトのタスクを追加（時刻を入れなければ日付未定で登録）",
      () => this.openProjectCreateModal(key)
    );
    addBtn.addClass("dt-project-add");
    const doneBtn = this.iconButton(row, "check-circle-2", "プロジェクトを完了にする（パネルから消えます）", () => {
      const projects = this.plugin.projects;
      if (!projects) return;
      const run = async () => {
        const ok = await projects.setDone(key, true);
        if (!ok) {
          new Notice("プロジェクトを完了にできませんでした（ノートが開けるか確認してください）");
          return;
        }
        sum.done = true; // すぐパネルから消す（次の再読み込みでも isDone が同じ判定を返す）
        new Notice(`プロジェクト「${sum.ref.name}」を完了にしました。ノート先頭のチェックを外すと戻せます`);
        this.renderInbox();
      };
      const open = sum.children.filter((c) => !c.task.done && !c.task.forwarded).length;
      if (open) {
        new ConfirmModal(
          this.app,
          `「${sum.ref.name}」には未完了のタスクが ${open} 件あります。プロジェクトを完了にしますか？（タスクはそのまま残ります）`,
          "完了にする",
          run
        ).open();
      } else {
        void run();
      }
    });
    doneBtn.addClass("dt-project-done-btn");

    const toggleExpand = () => {
      if (this.expandedProjects.has(key)) this.expandedProjects.delete(key);
      else this.expandedProjects.add(key);
      this.renderInbox();
    };
    chev.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleExpand();
    });
    this.attachProjectDrag(row, sum, toggleExpand);
    row.addEventListener("contextmenu", (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      this.showProjectMenu(sum, e);
    });

    if (!expanded) return;
    const childrenEl = container.createDiv("dt-project-children");
    // プロジェクトのドキュメント（ノートの「- ドキュメント: [[...]]」行）を子タスクの上に並べる
    if (fields?.docs.length) {
      const docsEl = childrenEl.createDiv("dt-project-docs");
      for (const doc of fields.docs) {
        const chip = docsEl.createDiv("dt-project-doc");
        const iconEl = chip.createSpan("dt-project-doc-icon");
        setIcon(iconEl, doc.external ? "external-link" : "file-text");
        chip.createSpan({ cls: "dt-project-doc-label", text: doc.label });
        chip.setAttr("aria-label", `ドキュメント: ${doc.target}\nクリックで開く`);
        chip.addEventListener("click", (e) => {
          e.stopPropagation();
          this.openProjectDoc(sum, doc);
        });
      }
    }
    // 「完了済みを隠す」がオンなら、完了・持ち越し済み [>]（＝片付いた記録）を出さない
    const shown = this.plugin.settings.projectsHideDone
      ? sum.children.filter((c) => !c.task.done && !c.task.forwarded)
      : sum.children;
    if (!sum.children.length) {
      childrenEl.createSpan({ cls: "dt-tray-empty", text: "結びついたタスクはまだありません" });
    } else if (!shown.length) {
      childrenEl.createSpan({
        cls: "dt-tray-empty",
        text: `完了済み ${sum.children.length} 件を非表示`,
      });
    }
    for (const child of shown) {
      const t = child.task;
      const item = childrenEl.createDiv("dt-project-child");
      item.toggleClass("is-done", t.done);
      const box = item.createDiv("dt-tray-check");
      setIcon(box, t.done ? "check-circle-2" : "circle");
      box.addEventListener("click", (e) => {
        e.stopPropagation();
        if (child.date === null) void this.commitInboxUpdate(t, { ...this.draftOf(t), done: !t.done });
        else void this.commitUpdate(child.date, t, { ...this.draftOf(t), done: !t.done });
      });
      const dateEl = item.createSpan({
        cls: "dt-project-child-date",
        text: child.date ? `${child.date.getMonth() + 1}/${child.date.getDate()}` : "未定",
      });
      // 日時が決まっていないものは破線のバッジで見分ける（日付ごと未定はアクセント色）
      const scheduled = t.start !== null && t.end !== null;
      if (child.date === null) dateEl.addClass("is-undated");
      else if (!scheduled) dateEl.addClass("is-unscheduled");
      item.createSpan({ cls: "dt-tray-title", text: this.displayTitle(t) });
      const plan = t.start !== null && t.end !== null ? t.end - t.start : 0;
      const act = t.actual.reduce((n, r) => n + (r.end - r.start), 0);
      if (plan || act) {
        item.createSpan({
          cls: "dt-project-child-times",
          text: `${plan ? hmm(plan) : "–"}/${act ? hmm(act) : "–"}`,
        });
      }
      item.setAttr(
        "aria-label",
        `${t.title || "(無題)"}\n` +
          (child.date
            ? moment(child.date).format("M月D日 (ddd)") +
              (scheduled ? ` ${minutesToHHMM(t.start!)} - ${minutesToHHMM(t.end!)}` : "（時刻は未定）")
            : "日付は未定") +
          (child.date
            ? "\nクリックでその日へ移動、タイムラインへドラッグで時刻を割り当て、右クリックでメニュー"
            : "\nクリックで編集、タイムラインへドラッグで日時を割り当て、右クリックでメニュー")
      );
      if (child.date === null) {
        // 日付未定: タイムラインへドラッグで日時を割り当て、クリックで編集できるようにする
        this.attachChipDrag(
          item,
          ".dt-tray-check",
          () => this.displayTitle(t),
          (date, start, end) =>
            void this.commitInboxToDay(t, date, { ...this.draftOf(t), start, end }),
          () => this.openInboxEditModal(t)
        );
        item.addEventListener("contextmenu", (e: MouseEvent) => {
          e.preventDefault();
          e.stopPropagation();
          this.showInboxTaskMenu(t, e);
        });
      } else {
        const childDate = child.date;
        this.attachChipDrag(
          item,
          ".dt-tray-check",
          () => this.displayTitle(t),
          (date, start, end) => {
            const draft = { ...this.draftOf(t), start, end };
            if (isSameDay(date, childDate)) void this.commitUpdate(childDate, t, draft);
            else void this.commitMove(childDate, t, date, draft);
          },
          () => {
            this.setDate(childDate);
            // 狭い画面では移動した先が見えるよう、タイムラインへ切り替える
            if (this.isNarrow) this.setNarrowPane("timeline");
          }
        );
        item.addEventListener("contextmenu", (e: MouseEvent) => {
          e.preventDefault();
          e.stopPropagation();
          this.showTaskMenu(childDate, t, e);
        });
      }
    }
  }

  /** 設定にあるグループのアイコン（グループ名 → アイコン。未設定・空は含めない） */
  private groupIconMap(): Map<string, string> {
    const out = new Map<string, string>();
    for (const g of this.plugin.settings.projectGroups) {
      const name = g.name.trim();
      const icon = g.icon.trim();
      if (name && icon && !out.has(name)) out.set(name, icon);
    }
    return out;
  }

  /** プロジェクトのドキュメントを開く（Wikilink はノート・外部 URL はブラウザ） */
  private openProjectDoc(sum: ProjectSummary, doc: ProjectDoc): void {
    if (doc.external) {
      window.open(doc.target);
      return;
    }
    void this.app.workspace.openLinkText(doc.target, sum.ref.linktext + ".md", false).catch((e) => {
      console.error(e);
      new Notice("ドキュメントを開けませんでした: " + String(e));
    });
  }

  /** プロジェクト行の右クリックメニュー（チケット・ドキュメント・グループの付け替え） */
  private showProjectMenu(sum: ProjectSummary, e: MouseEvent): void {
    if (!this.plugin.projects) return;
    const menu = new Menu();
    // プロジェクト自身のチケット・ドキュメント
    const fields = sum.fields;
    let hasExtras = false;
    if (fields?.ticket) {
      const t = fields.ticket;
      const url = ticketUrl(this.plugin.settings.trackers, t.tracker, t.id);
      if (url) {
        menu.addItem((i) =>
          i.setTitle(`チケット #${t.id} を開く`).setIcon("ticket").onClick(() => window.open(url))
        );
        hasExtras = true;
      }
    }
    for (const doc of fields?.docs ?? []) {
      menu.addItem((i) =>
        i
          .setTitle(`ドキュメント「${doc.label}」を開く`)
          .setIcon(doc.external ? "external-link" : "file-text")
          .onClick(() => this.openProjectDoc(sum, doc))
      );
      hasExtras = true;
    }
    if (hasExtras) menu.addSeparator();
    const current = sum.ref.group ?? null;
    // 完了済みプロジェクトだけが使っているグループへも移せるよう、候補は全プロジェクトから集める
    const names = knownGroupNames(
      this.projectData.map((s) => s.ref),
      this.plugin.settings.projectGroups.map((x) => x.name)
    );
    const groupIcons = this.groupIconMap();
    for (const groupName of names) {
      menu.addItem((i) => {
        // アイコンが Lucide 名ならメニューのアイコン欄に、絵文字などはタイトルの頭に出す
        // （現在のグループは ✓ を優先）
        const icon = groupIcons.get(groupName);
        const asText = icon && !getIcon(icon) ? icon + " " : "";
        i.setTitle(`グループ: ${asText}${groupName}`).onClick(() => void this.setProjectGroup(sum, groupName));
        if (groupName === current) i.setIcon("check");
        else if (icon && !asText) i.setIcon(icon);
      });
    }
    if (names.length) menu.addSeparator();
    menu.addItem((i) =>
      i
        .setTitle("新しいグループへ…")
        .setIcon("folder-plus")
        .onClick(() =>
          new PromptModal(this.app, {
            title: `「${sum.ref.name}」のグループ`,
            placeholder: "グループ名（例: 仕事）",
            cta: "移動",
            onSubmit: (groupName) => void this.setProjectGroup(sum, groupName),
          }).open()
        )
    );
    if (current) {
      menu.addItem((i) =>
        i.setTitle("グループを外す").setIcon("x").onClick(() => void this.setProjectGroup(sum, null))
      );
    }
    menu.showAtMouseEvent(e);
  }

  /** プロジェクトのグループを付け替えて、パネルへ即反映する */
  private async setProjectGroup(sum: ProjectSummary, group: string | null): Promise<void> {
    const projects = this.plugin.projects;
    if (!projects) return;
    const g = group?.trim() || null;
    if (g === (sum.ref.group ?? null)) return;
    const ok = await projects.setGroup(sum.ref.linktext, g);
    if (!ok) {
      new Notice("グループを変更できませんでした（ノートが開けるか確認してください）");
      return;
    }
    sum.ref.group = g; // メタデータキャッシュの反映を待たずに表示へ
    this.renderInbox();
  }

  /**
   * サイドバーのチップをタイムラインへドラッグする共通処理。
   * ドラッグ中はゴーストを出し、グリッドに落とすと onDrop(日, 開始, 終了)、
   * 動かさずに離すと onClick を呼ぶ
   */
  private attachChipDrag(
    chip: HTMLElement,
    ignoreSelector: string,
    ghostLabel: () => string,
    onDrop: (date: Date, start: number, end: number) => void,
    onClick: () => void
  ): void {
    chip.addEventListener("pointerdown", (e: PointerEvent) => {
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest(ignoreSelector)) return;
      e.preventDefault();

      const s = this.plugin.settings;
      const dayStart = s.startHour * 60;
      const dayEnd = s.endHour * 60;
      let ghost: HTMLElement | null = null;
      let dropStart: number | null = null;
      let dropCol: DayColumn | null = null;
      const duration = s.defaultDurationMinutes;

      this.startDrag(chip, e, {
        onMove: (_dy, ev) => {
          chip.addClass("is-dragging");
          const over = this.overGrid(ev) ? this.columnAtX(ev.clientX) : null;
          if (!over) {
            dropStart = null;
            dropCol = null;
            ghost?.remove();
            ghost = null;
            return;
          }
          if (over !== dropCol) {
            ghost?.remove();
            ghost = null;
            dropCol = over;
          }
          dropStart = clamp(
            this.snapFloor(this.clientYToMinutes(ev.clientY)),
            dayStart,
            Math.max(dayStart, dayEnd - duration)
          );
          if (!ghost) ghost = over.eventsEl.createDiv("dt-ghost");
          ghost.style.top = this.minutesToPx(dropStart) + "px";
          ghost.style.height =
            Math.max(this.minutesToPx(dropStart + duration) - this.minutesToPx(dropStart) - 2, 4) + "px";
          ghost.setText(
            `${minutesToHHMM(dropStart)} - ${minutesToHHMM(dropStart + duration)}  ${ghostLabel()}`
          );
        },
        onEnd: (moved) => {
          chip.removeClass("is-dragging");
          ghost?.remove();
          if (!moved) {
            onClick();
            return;
          }
          if (dropStart !== null && dropCol) {
            onDrop(dropCol.date, dropStart, Math.min(dropStart + duration, dayEnd));
          }
        },
        onCancel: () => {
          chip.removeClass("is-dragging");
          ghost?.remove();
        },
      });
    });
  }

  /** プロジェクト行: クリックで展開、タイムラインへドラッグで子タスクを作成 */
  private attachProjectDrag(row: HTMLElement, sum: ProjectSummary, onClick: () => void): void {
    this.attachChipDrag(
      row,
      ".dt-icon-btn, .dt-project-chevron",
      () => `${sum.ref.name} の新しいタスク`,
      (date, start, end) =>
        this.openCreateModal(date, start, end, undefined, { project: sum.ref.linktext }),
      onClick
    );
  }

  /** 未スケジュールのタスクのトレイ */
  /** 再スケジュール欄に出すタスク: 表示中の日の時刻を決めていないタスクに加えて、
   * 表示範囲の外（過去 RESCHEDULE_LOOKBACK_DAYS 日以内）に取り残された時刻なしタスク。
   * 週をまたいでも取り残しが消えないようにする。いずれも日付順。
   * 月表示では時刻なしのタスクもマスの中に出すので欄は使わない */
  private rescheduleGroups(): { date: Date; tasks: Task[] }[] {
    const s = this.plugin.settings;
    if (!this.isTimeline() || !s.showUnscheduledTray || !this.plugin.store.supportsUnscheduled) return [];
    const visible = this.columns
      .map((c) => ({ date: c.date, tasks: this.dataFor(c.date).tasks.filter((t) => !isScheduled(t)) }))
      .filter((g) => g.tasks.length > 0);
    // 過去の取り残しを先頭に（古い日付から）。表示中の日は visible 側にだけ出る
    return [...this.pastUnscheduled, ...visible];
  }

  /**
   * 表示範囲の外に取り残された時刻なしタスクを読む（再スケジュール欄用）。
   * 今日から過去 RESCHEDULE_LOOKBACK_DAYS 日のノートを見る。表示中の日は通常の
   * 読み込みが拾うので除外。完了・持ち越し済み [>] は「片付いた」ものなので出さない
   */
  private async loadPastUnscheduled(): Promise<{ date: Date; tasks: Task[] }[]> {
    const s = this.plugin.settings;
    const store = this.plugin.blockStore();
    if (!store || !this.isTimeline() || !s.showUnscheduledTray) return [];
    const visible = new Set(this.visibleDays().map(dateKey));
    const today = startOfDay(new Date());
    const out: { date: Date; tasks: Task[] }[] = [];
    for (let i = RESCHEDULE_LOOKBACK_DAYS; i >= 0; i--) {
      const date = addDays(today, -i);
      if (visible.has(dateKey(date))) continue;
      if (!store.getFile(date)) continue; // ノートの無い日は読まない
      try {
        const tasks = (await store.load(date)).tasks.filter(
          (t) => !isScheduled(t) && !t.done && !t.forwarded
        );
        if (tasks.length) out.push({ date, tasks });
      } catch (e) {
        console.error(e);
      }
    }
    return out;
  }

  /** 再スケジュールのタブの中身: 時刻を決めていないタスクを日付順に縦に一覧。
   * 旧・タイムライン上部の「未スケジュール」トレイの置き換え。＋ボタンはパネルのヘッダー側に出る */
  private renderReschedule(groups: { date: Date; tasks: Task[] }[]): void {
    const wrap = this.inboxEl.createDiv("dt-reschedule");
    const list = wrap.createDiv("dt-reschedule-list");
    const today = startOfDay(new Date());
    for (const g of groups) {
      for (const t of g.tasks) {
        const item = list.createDiv("dt-tray-chip dt-reschedule-item");
        item.toggleClass("is-done", t.done);
        const color = this.taskColor(t);
        if (color) {
          const dot = item.createSpan("dt-tray-color");
          dot.style.background = color;
        }
        const box = item.createDiv("dt-tray-check");
        setIcon(box, t.done ? "check-circle-2" : "circle");
        box.addEventListener("click", (e) => {
          e.stopPropagation();
          void this.commitUpdate(g.date, t, { ...this.draftOf(t), done: !t.done });
        });
        const dateEl = item.createSpan({
          cls: "dt-project-child-date is-unscheduled",
          text: `${g.date.getMonth() + 1}/${g.date.getDate()}`,
        });
        // 過去の取り残しは赤系で目立たせる
        if (g.date < today) dateEl.addClass("is-overdue");
        const owner = this.ownerName(t);
        if (owner) item.createSpan({ cls: "dt-owner-label", text: owner });
        item.createSpan({ cls: "dt-tray-title", text: this.displayTitle(t) });
        item.setAttr(
          "aria-label",
          [
            t.title || "(無題)",
            `${moment(g.date).format("M月D日 (ddd)")}（時刻は未定）`,
            t.doneCondition ? `完了条件: ${t.doneCondition}` : "",
            t.preview,
            "タイムラインへドラッグで時刻を割り当て。クリックで編集、右クリックでメニュー",
          ]
            .filter(Boolean)
            .join("\n")
        );
        this.attachTrayInteractions(item, g.date, t);
      }
    }
  }

  private renderEvents(): void {
    if (this.mode === "month") {
      this.renderMonth();
      this.renderDayTotals(); // 範囲合計の表示を消す
      return;
    }
    const s = this.plugin.settings;
    const dayStart = s.startHour * 60;
    const dayEnd = s.endHour * 60;
    const pa = this.paMode();
    this.taskEls.clear();

    let anyBar = false;
    for (const col of this.columns) {
      col.eventsEl.empty();
      const tasks = this.dataFor(col.date).tasks;

      if (pa !== "actual") {
        const visible = tasks.filter(isScheduled).filter((t) => t.end > dayStart && t.start < dayEnd);
        const layout = layoutEvents(visible);
        const lane = pa === "both" ? { left: 0, width: 0.5 } : { left: 0, width: 1 };
        for (const task of visible) {
          this.renderPlanBar(col, task, layout.get(task) ?? { col: 0, cols: 1 }, lane, pa === "both");
          anyBar = true;
        }
      }
      if (pa !== "plan") {
        // 実績は区間ごとに1本のバーにする（idx = タスク内の何番目の区間か。ドラッグ修正に使う）
        const items = tasks.flatMap((t) =>
          t.actual
            .map((r, idx) => ({ start: r.start, end: r.end, task: t, idx }))
            .filter((it) => it.end > dayStart && it.start < dayEnd)
        );
        const layout = layoutEvents(items);
        const lane = pa === "both" ? { left: 0.5, width: 0.5 } : { left: 0, width: 1 };
        for (const item of items) {
          this.renderActualBar(col, item, layout.get(item) ?? { col: 0, cols: 1 }, lane);
          anyBar = true;
        }
      }
    }

    if (!anyBar && this.columns.length) {
      this.columns[0].eventsEl.createDiv({
        cls: "dt-empty-hint",
        text:
          pa === "actual"
            ? "実績はまだありません。タスクの編集ダイアログの「実績」欄で記録できます"
            : this.mode === "day"
              ? "空いている時間をクリック、またはドラッグしてタスクを追加"
              : "空いている時間をクリック / ドラッグしてタスクを追加",
      });
    }
    this.updateNowLine();
    this.renderDayTotals();
  }

  /** レーン内の水平位置。lane の left / width は列の幅に対する 0〜1 の割合 */
  private barGeometry(info: LayoutInfo, lane: { left: number; width: number }): { left: string; width: string } {
    return {
      left: `calc(${(lane.left + (info.col / info.cols) * lane.width) * 100}% + 2px)`,
      width: `calc(${(lane.width / info.cols) * 100}% - 4px)`,
    };
  }

  /** 予定のバー。paired = 予実モード（実績と並べるため輪郭だけの見た目にする） */
  private renderPlanBar(
    col: DayColumn,
    task: ScheduledTask,
    info: LayoutInfo,
    lane: { left: number; width: number },
    paired: boolean
  ): void {
    const s = this.plugin.settings;
    const dayStart = s.startHour * 60;
    const dayEnd = s.endHour * 60;
    const top = this.minutesToPx(clamp(task.start, dayStart, dayEnd));
    const bottom = this.minutesToPx(clamp(task.end, dayStart, dayEnd));
    const h = bottom - top;

    const el = col.eventsEl.createDiv("dt-event");
    el.style.top = top + "px";
    el.style.height = Math.max(h - 2, 4) + "px";
    const geo = this.barGeometry(info, lane);
    el.style.left = geo.left;
    el.style.width = geo.width;
    el.toggleClass("is-plan", paired);
    el.toggleClass("is-done", task.done);
    el.toggleClass("is-forwarded", task.forwarded);
    el.toggleClass("is-short", h < 34);
    el.toggleClass("is-tiny", h < 18);
    const elKey = `${col.key}|${task.key}`;
    el.toggleClass("is-active-in-note", elKey === this.activeTaskKey);
    this.applyTagColor(el, task);
    el.setAttr(
      "aria-label",
      (this.ownerName(task) ? `${this.ownerName(task)}の予定\n` : "") +
        `${minutesToHHMM(task.start)} - ${minutesToHHMM(task.end)}  ${task.title || "(無題)"}` +
        (task.forwarded ? "\n持ち越し済み（このブロックは当日の記録）" : "") +
        (task.ticket ? `\n${task.ticket.tracker || "チケット"} #${task.ticket.id}` : "") +
        (task.doneCondition ? `\n完了条件: ${task.doneCondition}` : "") +
        (task.preview ? `\n${task.preview}` : "")
    );
    this.taskEls.set(elKey, el);

    // タイトル → 時刻の順。本文や完了条件は文字として出さない（ツールチップで見られる）
    const titleEl = el.createDiv("dt-event-title");
    const ownerName = this.ownerName(task);
    if (ownerName) {
      el.addClass("is-member");
      titleEl.createSpan({ cls: "dt-owner-label", text: ownerName });
    }
    if (task.forwarded) titleEl.createSpan({ cls: "dt-forward-mark", text: "▶ " });
    titleEl.appendText(this.displayTitle(task));
    const timeEl = el.createDiv({
      cls: "dt-event-time",
      text: `${minutesToHHMM(task.start)} - ${minutesToHHMM(task.end)}`,
    });
    if (task.ticket) {
      const badge = el.createDiv({ cls: "dt-event-ticket", text: `#${task.ticket.id}` });
      const url = this.ticketUrlOf(task);
      badge.setAttr(
        "aria-label",
        `${task.ticket.tracker || "チケット"} #${task.ticket.id}` + (url ? `\n${url}` : "")
      );
      if (url) {
        badge.addClass("is-linked");
        badge.addEventListener("pointerdown", (ev) => ev.stopPropagation());
        badge.addEventListener("click", (ev) => {
          ev.stopPropagation();
          window.open(url);
        });
      }
    }
    if (task.project) {
      const link = task.project;
      const badge = el.createDiv({ cls: "dt-event-project", text: projectDisplayName(link) });
      badge.setAttr("aria-label", `プロジェクト: ${projectDisplayName(link)}\nクリックでノートを開く`);
      badge.addEventListener("pointerdown", (ev) => ev.stopPropagation());
      badge.addEventListener("click", (ev) => {
        ev.stopPropagation();
        void this.plugin.openProject(link);
      });
    }
    if (task.carryFrom) this.carryBadge(el, "◀ 前日から", task.carryFrom, "持ち越し元のブロックを開く");
    if (task.carryTo) this.carryBadge(el, "▶ 持ち越し先", task.carryTo, "持ち越し先のブロックを開く");
    const handle = el.createDiv("dt-event-resize");

    this.attachEventInteractions(el, timeEl, handle, col, task);
    this.attachHoverPreview(el, col.date, task);
  }

  /** 実績のバー（1区間 = 1本）。クリックで編集、ドラッグで移動、下端で終了時刻を変更 */
  private renderActualBar(
    col: DayColumn,
    item: { start: number; end: number; task: Task; idx: number },
    info: LayoutInfo,
    lane: { left: number; width: number }
  ): void {
    const s = this.plugin.settings;
    const dayStart = s.startHour * 60;
    const dayEnd = s.endHour * 60;
    const task = item.task;
    const top = this.minutesToPx(clamp(item.start, dayStart, dayEnd));
    const bottom = this.minutesToPx(clamp(item.end, dayStart, dayEnd));
    const h = bottom - top;

    const el = col.eventsEl.createDiv("dt-event dt-event-actual");
    el.style.top = top + "px";
    el.style.height = Math.max(h - 2, 4) + "px";
    const geo = this.barGeometry(info, lane);
    el.style.left = geo.left;
    el.style.width = geo.width;
    el.toggleClass("is-short", h < 34);
    el.toggleClass("is-tiny", h < 18);
    this.applyTagColor(el, task);
    el.setAttr(
      "aria-label",
      `実績 ${minutesToHHMM(item.start)} - ${minutesToHHMM(item.end)}  ${task.title || "(無題)"}` +
        (task.start !== null && task.end !== null
          ? `\n予定 ${minutesToHHMM(task.start)} - ${minutesToHHMM(task.end)}`
          : "\n予定なし（未スケジュール）")
    );
    const elKey = `${col.key}|${task.key}`;
    if (!this.taskEls.has(elKey)) {
      el.toggleClass("is-active-in-note", elKey === this.activeTaskKey);
      this.taskEls.set(elKey, el);
    }

    const titleEl = el.createDiv("dt-event-title");
    const ownerName = this.ownerName(task);
    if (ownerName) titleEl.createSpan({ cls: "dt-owner-label", text: ownerName });
    titleEl.appendText(this.displayTitle(task));
    const timeEl = el.createDiv({
      cls: "dt-event-time",
      text: `${minutesToHHMM(item.start)} - ${minutesToHHMM(item.end)}`,
    });
    const handle = el.createDiv("dt-event-resize");

    // この区間だけを差し替えた実績で保存する
    const commitRanges = (start: number, end: number) => {
      const ranges = task.actual.map((r, i) => (i === item.idx ? { start, end } : r));
      void this.commitUpdate(col.date, task, { ...this.draftOf(task), actual: ranges });
    };

    // 本体: クリックで編集、ドラッグで区間ごと移動
    el.addEventListener("pointerdown", (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      const toNote = e.ctrlKey || e.metaKey;
      const dur = item.end - item.start;
      let newStart = item.start;
      this.startDrag(el, e, {
        onMove: (dy) => {
          newStart = clamp(
            this.snapRound(item.start + this.pxToMinutes(dy)),
            dayStart,
            Math.max(dayStart, dayEnd - dur)
          );
          el.addClass("is-dragging");
          el.style.top = this.minutesToPx(newStart) + "px";
          timeEl.setText(`${minutesToHHMM(newStart)} - ${minutesToHHMM(newStart + dur)}`);
        },
        onEnd: (moved) => {
          el.removeClass("is-dragging");
          if (!moved) {
            if (toNote) void this.openTaskInNote(col.date, task);
            else this.openEditModal(col.date, task);
            return;
          }
          if (newStart === item.start) {
            this.renderEvents();
            return;
          }
          commitRanges(newStart, newStart + dur);
        },
        onCancel: () => this.renderEvents(),
      });
    });

    // 下端のハンドル: ドラッグで終了時刻を変更
    handle.addEventListener("pointerdown", (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      let newEnd = item.end;
      this.startDrag(handle, e, {
        onMove: (dy) => {
          newEnd = clamp(
            this.snapRound(item.end + this.pxToMinutes(dy)),
            item.start + s.snapMinutes,
            dayEnd
          );
          el.addClass("is-dragging");
          el.style.height = Math.max(this.minutesToPx(newEnd) - this.minutesToPx(item.start) - 2, 4) + "px";
          timeEl.setText(`${minutesToHHMM(item.start)} - ${minutesToHHMM(newEnd)}`);
        },
        onEnd: (moved) => {
          el.removeClass("is-dragging");
          if (!moved || newEnd === item.end) {
            this.renderEvents();
            return;
          }
          commitRanges(item.start, newEnd);
        },
        onCancel: () => this.renderEvents(),
      });
    });

    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.showTaskMenu(col.date, task, e);
    });
    this.attachHoverPreview(el, col.date, task);
  }

  /** 持ち越し元・先へのリンクバッジ */
  private carryBadge(el: HTMLElement, label: string, linktext: string, tip: string): void {
    const badge = el.createDiv({ cls: "dt-event-carry", text: label });
    badge.setAttr("aria-label", `${tip}\n${linktext}`);
    badge.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    badge.addEventListener("click", (ev) => {
      ev.stopPropagation();
      void this.app.workspace.openLinkText(linktext, "", false).catch((e) => {
        console.error(e);
        new Notice("リンク先を開けませんでした: " + String(e));
      });
    });
  }

  /** 各日の予定・実績の合計を日付ヘッダーに、表示範囲の合計をヘッダー（3日・週）に出す */
  private renderDayTotals(): void {
    const show = this.mode !== "month" && !!this.plugin.blockStore();
    let rangePlan = 0;
    let rangeAct = 0;
    if (show) {
      for (const col of this.columns) {
        let el = col.headerEl.querySelector<HTMLElement>(".dt-day-total");
        const tasks = this.dataFor(col.date).tasks.filter((t) => !t.owner);
        const plan = tasks.reduce((n, t) => n + (isScheduled(t) ? t.end - t.start : 0), 0);
        const act = tasks.reduce((n, t) => n + t.actual.reduce((m, r) => m + (r.end - r.start), 0), 0);
        rangePlan += plan;
        rangeAct += act;
        if (!plan && !act) {
          el?.remove();
          continue;
        }
        if (!el) el = col.headerEl.createDiv("dt-day-total");
        el.empty();
        el.createSpan({ text: `予 ${hmm(plan)}` });
        el.createSpan({ text: `実 ${hmm(act)}` });
        if (plan && act) {
          const diff = act - plan;
          const d = el.createSpan({
            cls: "dt-day-total-diff",
            text: `(${diff >= 0 ? "+" : "-"}${hmm(Math.abs(diff))})`,
          });
          d.toggleClass("is-over", diff > 0);
        }
      }
    }
    // 週・3日表示のヘッダーに範囲合計
    if (this.rangeTotalEl) {
      let text = "";
      if (show && (this.mode === "week" || this.mode === "3day") && (rangePlan || rangeAct)) {
        const diff = rangeAct - rangePlan;
        text =
          `${this.mode === "week" ? "週" : "計"}: 予 ${hmm(rangePlan)}・実 ${hmm(rangeAct)}` +
          (rangePlan && rangeAct ? `（${diff >= 0 ? "+" : "-"}${hmm(Math.abs(diff))}）` : "");
      }
      this.rangeTotalEl.setText(text);
      this.rangeTotalEl.toggleClass("is-visible", !!text);
    }
  }

  /** 月表示: 各マスにその日のタスクを並べる */
  private renderMonth(): void {
    const s = this.plugin.settings;
    this.taskEls.clear();
    const today = startOfDay(new Date());
    const rules = s.recurring.filter((r) => r.enabled && r.title.trim() && r.weekdays.length);

    for (const [key, cell] of this.monthCells) {
      cell.listEl.empty();
      const tasks = [...this.dataFor(cell.date).tasks].sort((a, b) => {
        if (a.start === null && b.start === null) return 0;
        if (a.start === null) return 1;
        if (b.start === null) return -1;
        return a.start - b.start;
      });
      for (const task of tasks) {
        const item = cell.listEl.createDiv("dt-month-item");
        item.toggleClass("is-done", task.done);
        item.toggleClass("is-forwarded", task.forwarded);
        item.toggleClass("is-unscheduled", !isScheduled(task));
        if (task.owner) {
          item.addClass("is-member");
          const mc = this.plugin.memberOf(task.owner)?.color;
          if (mc) item.style.setProperty("--dt-member-color", mc);
        } else {
          const color = this.taskColor(task);
          if (color) {
            item.addClass("has-tag-color");
            item.style.setProperty("--dt-event-bg", color);
            const fg = contrastTextColor(color);
            if (fg) item.style.setProperty("--dt-event-fg", fg);
          }
        }
        {
          const owner = this.ownerName(task);
          if (owner) item.createSpan({ cls: "dt-owner-label", text: owner });
        }
        if (isScheduled(task)) {
          item.createSpan({ cls: "dt-month-item-time", text: minutesToHHMM(task.start) });
        }
        item.createSpan({ cls: "dt-month-item-title", text: this.displayTitle(task) });
        if (task.ticket) item.createSpan({ cls: "dt-month-item-ticket", text: `#${task.ticket.id}` });
        item.setAttr(
          "aria-label",
          (isScheduled(task) ? `${minutesToHHMM(task.start)} - ${minutesToHHMM(task.end)}  ` : "") +
            (task.title || "(無題)") +
            (task.preview ? `\n${task.preview}` : "")
        );
        const elKey = `${key}|${task.key}`;
        item.toggleClass("is-active-in-note", elKey === this.activeTaskKey);
        this.taskEls.set(elKey, item);
        item.addEventListener("click", (e) => {
          e.stopPropagation();
          if (e.ctrlKey || e.metaKey) void this.openTaskInNote(cell.date, task);
          else this.openEditModal(cell.date, task);
        });
        item.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.showTaskMenu(cell.date, task, e);
        });
        this.attachHoverPreview(item, cell.date, task);
      }
      // まだノートに入れていない将来の定期タスクは薄く表示。取り消した回は打ち消し線で出す
      if (cell.date >= today && s.autoApplyRecurring) {
        const applied = new Set(s.recurringApplied[key] ?? []);
        for (const r of rules) {
          if (!r.weekdays.includes(cell.date.getDay())) continue;
          const inst = instanceOf(s, key, r.id);
          if (inst?.skipped) {
            const item = cell.listEl.createDiv("dt-month-item is-recurring-preview is-recurring-skipped");
            if (r.start !== null) item.createSpan({ cls: "dt-month-item-time", text: minutesToHHMM(r.start) });
            item.createSpan({ cls: "dt-month-item-title", text: r.title });
            item.setAttr("aria-label", "定期タスク（この日は取り消し済み。管理画面から入れ直せます）");
            continue;
          }
          if (applied.has(r.id)) continue;
          const ov = inst?.override;
          const start = ov && ov.start !== undefined ? ov.start : r.start;
          const item = cell.listEl.createDiv("dt-month-item is-recurring-preview");
          if (start !== null) item.createSpan({ cls: "dt-month-item-time", text: minutesToHHMM(start) });
          item.createSpan({ cls: "dt-month-item-title", text: r.title });
          item.setAttr("aria-label", "定期タスク（この日を開くとノートに入ります）");
        }
      }
    }
  }

  /** タグに対応する色をブロックに当てる */
  private applyTagColor(el: HTMLElement, task: Task): void {
    // 他の人の予定: 背景はグレーにして、左端の線だけその人の色にする
    if (task.owner) {
      el.addClass("is-member");
      const mc = this.plugin.memberOf(task.owner)?.color;
      if (mc) el.style.setProperty("--dt-member-color", mc);
      return;
    }
    const color = this.taskColor(task);
    if (!color) return;
    el.addClass("has-tag-color");
    el.style.setProperty("--dt-event-bg", color);
    const fg = contrastTextColor(color);
    if (fg) el.style.setProperty("--dt-event-fg", fg);
  }

  private updateNowLine(): void {
    const s = this.plugin.settings;
    const dayStart = s.startHour * 60;
    const dayEnd = s.endHour * 60;
    const m = nowMinutes();
    for (const col of this.columns) {
      const show = s.showCurrentTime && isToday(col.date) && m >= dayStart && m <= dayEnd;
      if (!show) {
        col.nowEl?.remove();
        col.nowEl = null;
        continue;
      }
      if (!col.nowEl || !col.nowEl.isConnected) {
        col.nowEl = col.canvasEl.createDiv("dt-now");
      }
      col.nowEl.style.top = this.minutesToPx(m) + "px";
    }
  }

  private scrollToInitial(): void {
    if (!this.scrollEl || this.scrollEl.clientHeight === 0) return; // まだ表示されていない
    if (this.mode === "month") {
      this.scrollEl.scrollTop = 0;
      this.shouldScroll = false;
      return;
    }
    const s = this.plugin.settings;
    const dayStart = s.startHour * 60;
    const dayEnd = s.endHour * 60;
    const hasToday = this.columns.some((c) => isToday(c.date));
    const scheduled = this.columns.flatMap((c) => this.dataFor(c.date).tasks.filter(isScheduled));
    let target = hasToday ? nowMinutes() - 60 : 8 * 60;
    if (scheduled.length && !hasToday) {
      target = Math.min(...scheduled.map((t) => t.start)) - 30;
    }
    target = clamp(target, dayStart, dayEnd);
    this.scrollEl.scrollTop = Math.max(0, this.minutesToPx(target));
    this.shouldScroll = false;
  }

  // ---------- エディタ連動 ----------

  /** アクティブなエディタのカーソルが乗っているタスクをハイライト */
  private async syncCursorHighlight(): Promise<void> {
    const store = this.plugin.blockStore();
    if (!store) return;
    let key: string | null = null;
    const md = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (md?.file) {
      const path = md.file.path;
      const day = this.visibleDays().find((d) => store.pathFor(d) === path);
      if (day) {
        const line = md.editor.getCursor().line;
        const task = await store.taskAtLine(day, line);
        key = task ? `${dateKey(day)}|${task.key}` : null;
      }
    }
    if (key === this.activeTaskKey) return;
    this.activeTaskKey = key;
    for (const [k, el] of this.taskEls) el.toggleClass("is-active-in-note", k === key);
  }

  /** Ctrl/Cmd + ホバーでノートの該当ブロックをプレビュー */
  private attachHoverPreview(el: HTMLElement, date: Date, task: Task): void {
    if (!task.blockId) return;
    const linktext = `${this.storeOf(task).pathFor(date)}#^${task.blockId}`;
    el.addEventListener("mouseover", (e: MouseEvent) => {
      this.app.workspace.trigger("hover-link", {
        event: e,
        source: VIEW_TYPE_DAY_TIMELINE,
        hoverParent: this,
        targetEl: el,
        linktext,
      });
    });
  }

  /** ノートの該当ブロックを開く（ID が無ければ付けてから開く） */
  private async openTaskInNote(date: Date, task: Task): Promise<void> {
    try {
      const link = await this.storeOf(task).linkTo(date, task);
      if (link) {
        await this.app.workspace.openLinkText(link, "", false);
      } else if (task.owner) {
        const file = await this.storeOf(task).ensureFile(date);
        await this.app.workspace.getLeaf("tab").openFile(file);
      } else {
        await this.openNote(date);
      }
    } catch (e) {
      console.error(e);
      new Notice("ノートを開けませんでした: " + String(e));
    }
  }

  // ---------- 座標変換 ----------

  private minutesToPx(min: number): number {
    const s = this.plugin.settings;
    return ((min - s.startHour * 60) / 60) * this.hourHeightPx;
  }

  private pxToMinutes(px: number): number {
    return (px / this.hourHeightPx) * 60;
  }

  /** 1時間あたりの高さ。ズーム指定があればビューの高さから逆算する */
  private computeHourHeight(): number {
    const s = this.plugin.settings;
    if (!s.zoomHours) return s.hourHeight;
    const headerH = this.headersEl?.isConnected ? this.headersEl.offsetHeight : 30;
    const avail = (this.scrollEl?.clientHeight ?? 0) - headerH;
    if (avail < 100) return s.hourHeight; // まだレイアウトされていない
    return Math.max(avail / s.zoomHours, 24);
  }

  /** 縮尺が変わったときに、いま見えている時刻を保ったままグリッドを作り直す */
  private rebuildTimeline(): void {
    if (this.mode === "month" || !this.scrollEl) return;
    const s = this.plugin.settings;
    const anchor = s.startHour * 60 + this.pxToMinutes(this.scrollEl.scrollTop);
    this.buildGrid();
    this.renderEvents();
    if (!this.shouldScroll) this.scrollEl.scrollTop = Math.max(0, this.minutesToPx(anchor));
  }

  private setZoom(hours: number): void {
    const s = this.plugin.settings;
    if (s.zoomHours === hours) return;
    s.zoomHours = hours;
    void this.plugin.persistSettings();
    this.renderHeader();
    this.rebuildTimeline();
  }

  private setPaMode(mode: PlanActualMode): void {
    const s = this.plugin.settings;
    if (s.paMode === mode) return;
    s.paMode = mode;
    void this.plugin.persistSettings();
    this.renderHeader();
    if (this.mode === "month") return;
    this.renderEvents();
  }

  /** 予実の表示モード（旧リスト形式では予定のみ） */
  private paMode(): PlanActualMode {
    return this.plugin.blockStore() ? this.plugin.settings.paMode : "plan";
  }

  private clientYToMinutes(clientY: number): number {
    const s = this.plugin.settings;
    const rect = this.daysEl.getBoundingClientRect();
    const min = s.startHour * 60 + this.pxToMinutes(clientY - rect.top);
    return clamp(min, s.startHour * 60, s.endHour * 60);
  }

  /** ポインタの X 座標から、どの日の列の上にいるかを返す（列の外なら一番近い列） */
  private columnAtX(clientX: number): DayColumn | null {
    if (!this.columns.length) return null;
    let best: DayColumn | null = null;
    let bestDist = Infinity;
    for (const col of this.columns) {
      const r = col.canvasEl.getBoundingClientRect();
      if (clientX >= r.left && clientX <= r.right) return col;
      const d = clientX < r.left ? r.left - clientX : clientX - r.right;
      if (d < bestDist) {
        bestDist = d;
        best = col;
      }
    }
    return best;
  }

  private overGrid(ev: PointerEvent): boolean {
    const r = this.daysEl.getBoundingClientRect();
    return ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
  }

  private snapFloor(min: number): number {
    const snap = this.plugin.settings.snapMinutes;
    return Math.floor(min / snap) * snap;
  }

  private snapRound(min: number): number {
    const snap = this.plugin.settings.snapMinutes;
    return Math.round(min / snap) * snap;
  }

  // ---------- 操作 ----------

  /** マウス／タッチのドラッグをまとめて扱う */
  private startDrag(target: HTMLElement, e: PointerEvent, h: DragHandlers): void {
    const startY = e.clientY;
    const pointerId = e.pointerId;
    let moved = false;
    this.interacting = true;

    const detach = () => {
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onCancel);
      try {
        target.releasePointerCapture(pointerId);
      } catch (_e) {
        /* すでに解放済み */
      }
    };
    const done = () => {
      this.interacting = false;
      if (this.pendingReload) {
        this.pendingReload = false;
        void this.reload();
      }
    };
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const dy = ev.clientY - startY;
      if (!moved && Math.abs(dy) < 3 && Math.abs(ev.clientX - e.clientX) < 3) return;
      moved = true;
      h.onMove?.(dy, ev);
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      detach();
      h.onEnd(moved, ev);
      done();
    };
    const onCancel = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      detach();
      h.onCancel?.();
      done();
    };

    try {
      target.setPointerCapture(pointerId);
    } catch (_e) {
      /* 非対応環境 */
    }
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onCancel);
  }

  /** 空き時間のクリック／ドラッグ → タスクを作成 */
  private onCanvasPointerDown(e: PointerEvent, col: DayColumn): void {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest(".dt-event")) return;

    const s = this.plugin.settings;
    const dayStart = s.startHour * 60;
    const dayEnd = s.endHour * 60;
    const snap = s.snapMinutes;
    const anchor = clamp(this.snapFloor(this.clientYToMinutes(e.clientY)), dayStart, dayEnd - snap);
    const defaultRange = (): [number, number] => [
      anchor,
      Math.min(anchor + s.defaultDurationMinutes, dayEnd),
    ];
    let range = defaultRange();

    const ghost = col.eventsEl.createDiv("dt-ghost");
    const drawGhost = () => {
      ghost.style.top = this.minutesToPx(range[0]) + "px";
      ghost.style.height = Math.max(this.minutesToPx(range[1]) - this.minutesToPx(range[0]) - 2, 4) + "px";
      ghost.setText(`${minutesToHHMM(range[0])} - ${minutesToHHMM(range[1])}`);
    };
    drawGhost();

    this.startDrag(col.canvasEl, e, {
      onMove: (_dy, ev) => {
        const cur = clamp(this.snapFloor(this.clientYToMinutes(ev.clientY)), dayStart, dayEnd - snap);
        if (cur === anchor) range = defaultRange();
        else if (cur > anchor) range = [anchor, cur + snap];
        else range = [cur, anchor + snap];
        drawGhost();
      },
      onEnd: (moved) => {
        if (!moved) range = defaultRange();
        this.openCreateModal(col.date, range[0], range[1], () => ghost.remove());
      },
      onCancel: () => ghost.remove(),
    });
  }

  private attachEventInteractions(
    el: HTMLElement,
    timeEl: HTMLElement,
    handle: HTMLElement,
    col: DayColumn,
    task: ScheduledTask
  ): void {
    const s = this.plugin.settings;
    const dayStart = s.startHour * 60;
    const dayEnd = s.endHour * 60;

    // 本体: クリックで編集（Ctrl/Cmd+クリックでノートへ）、ドラッグで移動（週表示では別の日へも）
    el.addEventListener("pointerdown", (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      const toNote = e.ctrlKey || e.metaKey;
      const dur = task.end - task.start;
      let newStart = task.start;
      let targetCol: DayColumn = col;
      this.startDrag(el, e, {
        onMove: (dy, ev) => {
          newStart = clamp(
            this.snapRound(task.start + this.pxToMinutes(dy)),
            dayStart,
            Math.max(dayStart, dayEnd - dur)
          );
          el.addClass("is-dragging");
          el.style.top = this.minutesToPx(newStart) + "px";
          timeEl.setText(`${minutesToHHMM(newStart)} - ${minutesToHHMM(newStart + dur)}`);
          if (this.columns.length > 1) {
            const over = this.columnAtX(ev.clientX) ?? col;
            if (over !== targetCol) {
              targetCol = over;
              // 要素は元の列に置いたまま、横にずらして別の日の列の上に見せる
              // （DOM を移すとポインタキャプチャが外れる環境があるため）
              const dx =
                targetCol.canvasEl.getBoundingClientRect().left -
                col.canvasEl.getBoundingClientRect().left;
              el.style.transform = dx ? `translateX(${dx}px)` : "";
              el.toggleClass("is-moving-day", targetCol !== col);
            }
          }
        },
        onEnd: (moved) => {
          el.removeClass("is-dragging");
          if (!moved) {
            if (toNote) void this.openTaskInNote(col.date, task);
            else this.openEditModal(col.date, task);
            return;
          }
          const draft = { ...this.draftOf(task), start: newStart, end: newStart + dur };
          if (targetCol !== col) {
            void this.commitMove(col.date, task, targetCol.date, draft);
          } else if (newStart !== task.start) {
            void this.commitUpdate(col.date, task, draft);
          } else {
            this.renderEvents();
          }
        },
        onCancel: () => this.renderEvents(),
      });
    });

    // 下端のハンドル: ドラッグで終了時刻を変更
    handle.addEventListener("pointerdown", (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      let newEnd = task.end;
      this.startDrag(handle, e, {
        onMove: (dy) => {
          newEnd = clamp(this.snapRound(task.end + this.pxToMinutes(dy)), task.start + s.snapMinutes, dayEnd);
          el.addClass("is-dragging");
          el.style.height = Math.max(this.minutesToPx(newEnd) - this.minutesToPx(task.start) - 2, 4) + "px";
          timeEl.setText(`${minutesToHHMM(task.start)} - ${minutesToHHMM(newEnd)}`);
        },
        onEnd: (moved) => {
          el.removeClass("is-dragging");
          if (moved && newEnd !== task.end) {
            void this.commitUpdate(col.date, task, { ...this.draftOf(task), end: newEnd });
          } else {
            this.renderEvents();
          }
        },
        onCancel: () => this.renderEvents(),
      });
    });

    // 右クリックメニュー
    el.addEventListener("contextmenu", (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      this.showTaskMenu(col.date, task, e);
    });
  }

  /** トレイのチップ: クリックで編集、タイムラインへドラッグで時刻を割り当て */
  private attachTrayInteractions(chip: HTMLElement, date: Date, task: Task): void {
    this.attachChipDrag(
      chip,
      ".dt-tray-check",
      () => this.displayTitle(task),
      (dropDate, start, end) => {
        const draft = { ...this.draftOf(task), start, end };
        if (isSameDay(dropDate, date)) void this.commitUpdate(date, task, draft);
        else void this.commitMove(date, task, dropDate, draft);
      },
      () => this.openEditModal(date, task)
    );

    chip.addEventListener("contextmenu", (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      this.showTaskMenu(date, task, e);
    });
  }

  /** Inbox のチップ: クリックで編集、タイムラインへドラッグでその日に移して時刻を割り当て */
  private attachInboxInteractions(chip: HTMLElement, task: Task): void {
    this.attachChipDrag(
      chip,
      ".dt-tray-check",
      () => this.displayTitle(task),
      (date, start, end) =>
        void this.commitInboxToDay(task, date, { ...this.draftOf(task), start, end }),
      () => this.openInboxEditModal(task)
    );

    chip.addEventListener("contextmenu", (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      this.showInboxTaskMenu(task, e);
    });
  }

  /** 日付未定（Inbox のノートにある）タスクの右クリックメニュー（Inbox・プロジェクトパネル共通） */
  private showInboxTaskMenu(task: Task, e: MouseEvent): void {
    const menu = new Menu();
    menu.addItem((i) => i.setTitle("編集").setIcon("pencil").onClick(() => this.openInboxEditModal(task)));
    menu.addItem((i) =>
      i
        .setTitle(task.done ? "未完了に戻す" : "完了にする")
        .setIcon("check")
        .onClick(() => void this.commitInboxUpdate(task, { ...this.draftOf(task), done: !task.done }))
    );
    menu.addItem((i) =>
      i
        .setTitle("今日へ送る（未スケジュール）")
        .setIcon("calendar")
        .onClick(() => void this.commitInboxToDay(task, startOfDay(new Date())))
    );
    if (this.mode === "day" && !isToday(this.date)) {
      menu.addItem((i) =>
        i
          .setTitle(`${moment(this.date).format("M月D日")} へ送る（未スケジュール）`)
          .setIcon("calendar")
          .onClick(() => void this.commitInboxToDay(task, this.date))
      );
    }
    menu.addItem((i) =>
      i.setTitle("ノートで開く").setIcon("file-text").onClick(() => void this.openInboxTaskInNote(task))
    );
    menu.addSeparator();
    menu.addItem((i) =>
      i.setTitle("削除").setIcon("trash").onClick(() => void this.commitInboxDelete(task))
    );
    menu.showAtMouseEvent(e);
  }

  /** タスクの右クリックメニュー（タイムライン・トレイ共通） */
  private showTaskMenu(date: Date, task: Task, e: MouseEvent): void {
    const menu = new Menu();
    menu.addItem((i) =>
      i.setTitle("編集").setIcon("pencil").onClick(() => this.openEditModal(date, task))
    );
    menu.addItem((i) =>
      i
        .setTitle(task.done ? "未完了に戻す" : "完了にする")
        .setIcon("check")
        .onClick(() => void this.commitUpdate(date, task, { ...this.draftOf(task), done: !task.done }))
    );
    if (this.plugin.blockStoreFor(task.owner)) {
      const tr = this.plugin.settings.tracking;
      const isTracking =
        !!tr && !!task.blockId && tr.blockId === task.blockId && (tr.owner ?? null) === (task.owner ?? null);
      menu.addItem((i) =>
        isTracking
          ? i
              .setTitle("計測を終了して実績に記録")
              .setIcon("square")
              .onClick(() => void this.plugin.stopTaskTracking(true))
          : i
              .setTitle("実績の計測を開始")
              .setIcon("play")
              .onClick(() => void this.plugin.startTaskTracking(date, task))
      );
    }
    menu.addItem((i) =>
      i.setTitle("ノートで開く").setIcon("file-text").onClick(() => void this.openTaskInNote(date, task))
    );
    if (task.project && this.plugin.projects) {
      const link = task.project;
      menu.addItem((i) =>
        i
          .setTitle(`プロジェクト「${projectDisplayName(link)}」を開く`)
          .setIcon("arrow-up-right")
          .onClick(() => void this.plugin.openProject(link))
      );
    }
    {
      const url = this.ticketUrlOf(task);
      if (url && task.ticket) {
        menu.addItem((i) =>
          i
            .setTitle(`チケット #${task.ticket?.id} を開く`)
            .setIcon("external-link")
            .onClick(() => window.open(url))
        );
      }
    }
    if (this.storeOf(task).supportsUnscheduled && isScheduled(task)) {
      menu.addItem((i) =>
        i
          .setTitle("時刻を外す（未スケジュールへ）")
          .setIcon("timer-off")
          .onClick(() => void this.commitUpdate(date, task, { ...this.draftOf(task), start: null, end: null }))
      );
    }
    if (this.plugin.blockStoreFor(task.owner) && !task.done && !task.forwarded) {
      menu.addItem((i) =>
        i
          .setTitle("翌日へ持ち越す（記録を残す）")
          .setIcon("corner-down-right")
          .onClick(() => void this.commitCarryOver(date, task, "next-day"))
      );
      if (!task.owner && this.plugin.inbox) {
        menu.addItem((i) =>
          i
            .setTitle("Inbox へ持ち越す（記録を残す）")
            .setIcon("inbox")
            .onClick(() => void this.commitCarryOver(date, task, "inbox"))
        );
      }
    }
    menu.addItem((i) =>
      i
        .setTitle("前日へ送る")
        .setIcon("arrow-left")
        .onClick(() => void this.commitMove(date, task, addDays(date, -1)))
    );
    menu.addItem((i) =>
      i
        .setTitle("翌日へ送る")
        .setIcon("arrow-right")
        .onClick(() => void this.commitMove(date, task, addDays(date, 1)))
    );
    if (this.plugin.blockStore() && this.plugin.settings.members.length) {
      const targets: { id: string | null; name: string }[] = [
        { id: null, name: "自分" },
        ...this.plugin.settings.members.map((m) => ({ id: m.id, name: m.name || "?" })),
      ].filter((o) => (o.id ?? null) !== (task.owner ?? null));
      for (const o of targets) {
        menu.addItem((i) =>
          i
            .setTitle(`${o.name}の予定にする`)
            .setIcon("user")
            .onClick(() => void this.commitChangeOwner(date, task, { ...this.draftOf(task), owner: o.id }))
        );
      }
    }
    if (this.plugin.inbox && !task.owner) {
      menu.addItem((i) =>
        i
          .setTitle("Inbox へ戻す（日付を外す）")
          .setIcon("inbox")
          .onClick(() => void this.commitDayToInbox(date, task))
      );
    }
    menu.addSeparator();
    menu.addItem((i) =>
      i
        .setTitle("定期タスクとして登録…")
        .setIcon("repeat")
        .onClick(() => {
          new RecurringModal(this.app, {
            preset: {
              title: task.title,
              start: task.start,
              end: task.end,
              weekday: date.getDay(),
              project: task.project,
            },
            tagChoices: this.plugin.settings.tagColors,
            projects: this.plugin.projects?.list(),
            onSubmit: async (rule) => {
              this.plugin.settings.recurring.push(rule);
              await this.plugin.saveSettings();
              new Notice(`定期タスク「${rule.title}」を登録しました`);
            },
          }).open();
        })
    );
    menu.addSeparator();
    menu.addItem((i) =>
      i.setTitle("削除").setIcon("trash").onClick(() => void this.commitDelete(date, task))
    );
    menu.showAtMouseEvent(e);
  }

  // ---------- モーダル ----------

  private openCreateModal(
    date: Date,
    start?: number | null,
    end?: number | null,
    onClose?: () => void,
    preset?: Partial<TaskDraft>
  ): void {
    const s = this.plugin.settings;
    const dayStart = s.startHour * 60;
    const dayEnd = s.endHour * 60;
    if (start === undefined) {
      const base = isToday(date) ? Math.ceil(nowMinutes() / s.snapMinutes) * s.snapMinutes : 9 * 60;
      start = clamp(base, dayStart, Math.max(dayStart, dayEnd - s.snapMinutes));
    }
    if (start !== null) {
      if (end === undefined || end === null) end = Math.min(start + s.defaultDurationMinutes, dayEnd);
      if (end <= start) end = Math.min(start + s.snapMinutes, 1440);
    } else {
      end = null;
    }

    new TaskModal(this.app, {
      mode: "create",
      initial: { ...preset, title: preset?.title ?? "", start, end, done: false },
      snapMinutes: s.snapMinutes,
      allowUnscheduled: this.plugin.store.supportsUnscheduled,
      dateField: { value: dateKey(date) },
      tagChoices: s.tagColors,
      reminderDefault: this.plugin.blockStore() ? s.reminderDefaultMinutes : undefined,
      showDoneCondition: !!this.plugin.blockStore(),
      trackers: s.trackers,
      owners: this.ownerChoices(),
      initialOwner: null,
      ...this.projectOptions(),
      onSubmit: (data, dateSel) => this.commitCreate(dateSel ?? date, data),
      onClose,
    }).open();
  }

  /**
   * プロジェクトパネルの「＋」からのタスク追加。日付はまだ決めない前提で、
   * 時刻を空のまま保存すると日付未定（実体は Inbox のノート。パネルには「未定」と表示）、
   * 時刻を入れると表示中の日へ登録する
   */
  private openProjectCreateModal(project: string): void {
    const inbox = this.plugin.inbox;
    if (!inbox) {
      // Inbox の無い形式ではプロジェクトパネル自体が出ないはずだが、念のため従来どおり
      this.openCreateModal(this.date, undefined, undefined, undefined, { project });
      return;
    }
    const s = this.plugin.settings;
    const dayLabel = moment(this.date).format("M月D日");
    new TaskModal(this.app, {
      mode: "create",
      initial: { title: "", start: null, end: null, done: false, project },
      snapMinutes: s.snapMinutes,
      allowUnscheduled: true,
      dateLabel: "日付未定",
      dateField: {
        value: null,
        allowEmpty: true,
        hint: "空のままなら日付を決めずに登録します",
      },
      unscheduledHint: `時刻なし — 日付を決めずに登録します（プロジェクトパネルに「未定」として並びます。時刻を入れると ${dayLabel} に登録）`,
      tagChoices: s.tagColors,
      showDoneCondition: true,
      trackers: s.trackers,
      ...this.projectOptions(),
      onSubmit: async (data, dateSel) => {
        // 日付を選んだらその日へ。選ばずに時刻だけ入れたら、これまでどおり表示中の日へ
        const to = dateSel ?? (data.start !== null && data.end !== null ? this.date : null);
        if (to) {
          await this.commitCreate(to, data);
          return;
        }
        try {
          await inbox.create(INBOX_DATE, { ...data, start: null, end: null });
          new Notice("日付未定で登録しました（プロジェクトパネルに表示されます）");
        } catch (e) {
          console.error(e);
          new Notice("登録できませんでした: " + String(e));
        }
        await this.reload();
      },
    }).open();
  }

  private openEditModal(date: Date, task: Task): void {
    // 自動保存のたびに参照を最新へ差し替える（タイトルや時刻が変わると照合できなくなるため）
    let current = task;
    const wasDone = task.done;
    const serially = serialQueue();
    // 日付を空にして「日付未定（Inbox）」へ戻せるのは、自分のタスクで Inbox があるときだけ
    const allowClearDate = !!this.plugin.inbox && !task.owner;
    new TaskModal(this.app, {
      mode: "edit",
      initial: this.draftOf(task),
      snapMinutes: this.plugin.settings.snapMinutes,
      allowUnscheduled: this.plugin.store.supportsUnscheduled,
      dateField: {
        value: dateKey(date),
        allowEmpty: allowClearDate,
        hint: allowClearDate ? "空にすると日付未定（Inbox）へ移します" : undefined,
      },
      tagChoices: this.plugin.settings.tagColors,
      reminderDefault: this.plugin.blockStore() ? this.plugin.settings.reminderDefaultMinutes : undefined,
      showDoneCondition: !!this.plugin.blockStore(),
      showActual: !!this.plugin.blockStore(),
      trackers: this.plugin.settings.trackers,
      owners: this.ownerChoices(),
      initialOwner: task.owner ?? null,
      ...this.projectOptions(),
      onAutoSave: async (data) => {
        // 持ち主・日付の変更はノートをまたぐ移動になるので、閉じるとき（onSubmit）にまとめて反映する
        const next = await serially(() => this.commitAutoSave(date, current, data));
        if (next) current = next;
        return next !== null;
      },
      onSubmit: (data, dateSel) =>
        serially(() => this.commitEditSubmit(date, current, data, dateSel, wasDone)),
      onDelete: () => serially(() => this.commitDelete(date, current)),
      onOpenNote: () => serially(() => this.openTaskInNote(date, current)),
    }).open();
  }

  /**
   * 編集ダイアログを閉じたときの反映。日付欄が変わっていれば別の日のノートへ移す
   * （空にしたときは Inbox の「日付未定」へ）
   */
  private async commitEditSubmit(
    date: Date,
    task: Task,
    data: TaskDraft,
    dateSel: Date | null | undefined,
    wasDone: boolean
  ): Promise<void> {
    // 日付が変わっていない（または欄が無い）: これまでどおり
    if (dateSel === undefined || (dateSel !== null && isSameDay(dateSel, date))) {
      return this.commitUpdate(date, task, data, wasDone);
    }
    // 持ち主の変更と同時はノートをまたぐ移動が重なるため、持ち主の変更を優先する
    if (data.owner !== undefined && (data.owner ?? null) !== (task.owner ?? null)) {
      new Notice("持ち主と日付は同時に変えられないため、日付は変更していません");
      return this.commitUpdate(date, task, data, wasDone);
    }
    if (dateSel === null) return this.commitDayToInbox(date, task, data);
    return this.commitMove(date, task, dateSel, data);
  }

  /** 編集ダイアログの「誰の予定か」の選択肢（メンバーが居ないときは undefined = 欄を出さない） */
  private ownerChoices(): { id: string | null; name: string; color: string }[] | undefined {
    if (!this.plugin.blockStore() || !this.plugin.settings.members.length) return undefined;
    return [
      { id: null, name: "自分", color: "" },
      ...this.plugin.settings.members.map((m) => ({ id: m.id, name: m.name || "?", color: m.color })),
    ];
  }

  private draftOf(task: Task): TaskDraft {
    return {
      title: task.title,
      start: task.start,
      end: task.end,
      done: task.done,
      reminder: task.reminder,
      doneCondition: task.doneCondition,
      steps: task.steps,
      retrospective: task.retrospective,
      actual: task.actual,
      project: task.project,
      details: task.details,
      ticket: task.ticket,
    };
  }

  /** 編集・追加ダイアログに渡すプロジェクトまわりの共通オプション */
  private projectOptions() {
    const projects = this.plugin.projects;
    if (!projects) return {};
    return {
      projects: projects.list(),
      onCreateProject: (name: string) => projects.create(name),
      onOpenProject: (link: string) => this.plugin.openProject(link),
    };
  }

  /** チケットの URL（設定に無ければ null） */
  private ticketUrlOf(task: Task): string | null {
    if (!task.ticket) return null;
    return ticketUrl(this.plugin.settings.trackers, task.ticket.tracker, task.ticket.id);
  }

  /** タイムライン上に出すタイトル（タグは色で分かるので文字としては出さない） */
  private displayTitle(task: Task): string {
    return stripTags(task.title) || "(無題)";
  }

  // ---------- 保存 ----------

  private async commitCreate(date: Date, data: TaskDraft): Promise<void> {
    try {
      await this.plugin.storeFor(data.owner).create(date, data);
    } catch (e) {
      console.error(e);
      new Notice("タスクを保存できませんでした: " + String(e));
    }
    await this.reload();
  }

  private async commitUpdate(date: Date, task: Task, data: TaskDraft, wasDone = task.done): Promise<void> {
    // 持ち主が変わった場合は、別のノートへブロックごと移す
    if (data.owner !== undefined && (data.owner ?? null) !== (task.owner ?? null)) {
      await this.commitChangeOwner(date, task, data);
      return;
    }
    // 未完了 → 完了で実績が空なら、自動で実績を入れる
    const auto = this.autoActual(date, task, data, wasDone);
    if (auto) data = { ...data, actual: auto };
    let updated = false;
    try {
      const ok = await this.storeOf(task).update(date, task, data);
      if (!ok) new Notice("タスクが見つかりませんでした。ノートが変更された可能性があります。");
      updated = !!ok;
    } catch (e) {
      console.error(e);
      new Notice("タスクを保存できませんでした: " + String(e));
    }
    await this.reload();
    if (updated) {
      const prompted = this.maybePromptRetrospective(date, task, data, wasDone);
      // ふりかえりのポップアップが出ないときは、自動記録したことだけ知らせる
      if (auto && !prompted) {
        new Notice(`実績 ${formatActualRanges(auto)} を記録しました（編集ダイアログで直せます）`);
      }
      // 「未完了 → 完了」でプロジェクトの子が全部完了したら、プロジェクトの完了を提案
      if (data.done && !wasDone) {
        void this.maybeSuggestProjectDone(data.project !== undefined ? data.project : task.project);
      }
    }
  }

  /** プロジェクトの子タスクがすべて完了したら、プロジェクト自身の完了を提案する */
  private async maybeSuggestProjectDone(link: string | null | undefined): Promise<void> {
    const projects = this.plugin.projects;
    if (!link || !projects) return;
    try {
      const children = await this.plugin.collectProjectChildren(link);
      // 持ち越し済み [>] のブロックは「閉じた記録」なので、完了扱いで数える
      if (!children.length || !children.every((c) => c.task.done || c.task.forwarded)) return;
      // メタ行なし（null）は「未完了」とみなす（setDone がメタ行を書き足してくれる）
      if ((await projects.isDone(link)) === true) return; // 既に完了
      new ConfirmModal(
        this.app,
        `プロジェクト「${projectDisplayName(link)}」のタスクがすべて完了しました。プロジェクトも完了にしますか？`,
        "完了にする",
        async () => {
          const ok = await projects.setDone(link, true);
          if (ok) {
            await this.plugin.updateProjectNote(link);
            new Notice(`プロジェクト「${projectDisplayName(link)}」を完了にしました`);
          } else {
            new Notice("プロジェクトノートを更新できませんでした");
          }
        }
      ).open();
    } catch (e) {
      console.error(e);
    }
  }

  /**
   * 完了にしたときの実績の自動記録（設定でオフ可）。
   * 今日のタスクを作業の前後で完了にしたときは「予定の開始 〜 今」、
   * それ以外（後からまとめてチェックした・別の日のタスク）は「予定どおり」として記録する。
   */
  private autoActual(date: Date, task: Task, data: TaskDraft, wasDone: boolean): ActualRange[] | null {
    const s = this.plugin.settings;
    if (!s.autoRecordActual || !this.plugin.blockStore()) return null;
    if (!data.done || wasDone) return null;
    const existing = data.actual !== undefined ? data.actual : task.actual;
    if (existing.length) return null;
    const start = data.start ?? task.start;
    const end = data.end ?? task.end;
    if (start === null || end === null) return null;
    if (isToday(date)) {
      const now = nowMinutes();
      if (now > start && now <= end + 60) return [{ start, end: Math.min(now, 1440) }];
    }
    return [{ start, end }];
  }

  /**
   * 編集ダイアログからの自動保存。持ち主の変更は反映しない（閉じるときに行う）。
   * 成功したら保存後のタスク参照を返し、失敗（見つからない・書き込みエラー）なら null。
   */
  private async commitAutoSave(date: Date, task: Task, data: TaskDraft): Promise<Task | null> {
    const store = this.storeOf(task);
    try {
      if (!(await store.update(date, task, data))) return null;
    } catch (e) {
      console.error(e);
      return null;
    }
    await this.reload();
    return (await this.relocateTask(store, date, task, data)) ?? task;
  }

  /** 保存で ID が付いたり内容が変わったりしたあと、同じタスクを探し直す */
  private async relocateTask(
    store: TaskSource,
    date: Date,
    task: Task,
    draft: TaskDraft
  ): Promise<Task | null> {
    try {
      const day = await store.load(date);
      if (task.blockId) return day.tasks.find((t) => t.blockId === task.blockId) ?? null;
      // ID の無いタスク（旧形式・手書きのブロック）は保存した内容で照合する
      return (
        day.tasks.find(
          (t) =>
            t.title === draft.title && t.start === draft.start && t.end === draft.end && t.done === draft.done
        ) ?? null
      );
    } catch (e) {
      console.error(e);
      return null;
    }
  }

  /**
   * 15分以上のタスクを完了にしたとき、ふりかえりが空なら入力を促す。
   * 実績の確認・修正欄も一緒に出す。ポップアップを出したら true
   */
  private maybePromptRetrospective(date: Date, task: Task, data: TaskDraft, wasDone = task.done): boolean {
    if (!this.plugin.blockStore()) return false; // ブロック形式のみ
    if (!data.done || wasDone) return false; // 「未完了 → 完了」のときだけ
    const start = data.start ?? task.start;
    const end = data.end ?? task.end;
    if (start === null || end === null || end - start < 15) return false;
    const retro = data.retrospective !== undefined ? data.retrospective : task.retrospective;
    if (retro && retro.trim()) return false;
    const recorded = data.actual !== undefined ? data.actual : task.actual;
    new RetrospectiveModal(this.app, {
      taskTitle: stripTags(data.title || task.title),
      durationLabel: formatDuration(end - start),
      actual: recorded,
      onSave: async (text, actual) => {
        try {
          const patch: TaskDraft = { ...data };
          if (text) patch.retrospective = text;
          if (actual !== undefined) patch.actual = actual;
          const ok = await this.storeOf(task).update(date, task, patch);
          if (!ok) new Notice("ふりかえりを保存できませんでした。ノートが変更された可能性があります。");
        } catch (e) {
          console.error(e);
          new Notice("ふりかえりを保存できませんでした: " + String(e));
        }
        await this.reload();
      },
    }).open();
    return true;
  }

  private async commitDelete(date: Date, task: Task): Promise<void> {
    const doDelete = async () => {
      try {
        const ok = await this.storeOf(task).remove(date, task);
        if (!ok) new Notice("タスクが見つかりませんでした。ノートが変更された可能性があります。");
        // 定期タスクの回だったら「その日は取り消した」として記録する（勝手に復活しない・管理画面で区別できる）
        else await noteRecurringDeletion(this.plugin, date, task);
      } catch (e) {
        console.error(e);
        new Notice("タスクを削除できませんでした: " + String(e));
      }
      await this.reload();
    };

    // 本文があるブロックはノートの中身ごと消えるので確認する
    const s = this.plugin.settings;
    const blockStore = this.plugin.blockStoreFor(task.owner);
    if (s.confirmBodyDelete && blockStore && (await blockStore.hasBody(date, task))) {
      new ConfirmModal(
        this.app,
        `「${task.title || "(無題)"}」には本文があります。ブロックごと削除しますか？`,
        "削除",
        doDelete
      ).open();
      return;
    }
    await doDelete();
  }

  /**
   * 別の日へ移す。draft を渡すと移動後にその内容（時刻など）で更新する
   * （週表示で別の日の列へドラッグしたときに使う）。
   */
  private async commitMove(from: Date, task: Task, to: Date, draft?: TaskDraft): Promise<void> {
    try {
      const ok = await this.storeOf(task).moveToDate(from, task, to);
      if (ok === false) {
        new Notice("タスクが見つかりませんでした。ノートが変更された可能性があります。");
      } else if (ok === null) {
        new Notice("この形式では日をまたぐ移動に対応していません");
      } else {
        if (draft) {
          const updated = await this.storeOf(task).update(to, task, draft);
          if (!updated) new Notice("移動しましたが、時刻を更新できませんでした");
        }
        new Notice(`${moment(to).format("M月D日")} へ移動しました`);
      }
    } catch (e) {
      console.error(e);
      new Notice("タスクを移動できませんでした: " + String(e));
    }
    await this.reload();
  }

  /**
   * 残件の持ち越し: タスクは動かさず、今日のブロックを [>] で閉じて
   * 続きのブロックを翌日（または Inbox）に作る。実績・本文は今日の記録として残る
   */
  private async commitCarryOver(date: Date, task: Task, dest: "next-day" | "inbox"): Promise<void> {
    const store = this.plugin.blockStoreFor(task.owner);
    const inbox = this.plugin.inbox;
    if (!store || (dest === "inbox" && (!inbox || task.owner))) {
      new Notice("持ち越しはタスクブロック形式のときだけ使えます");
      return;
    }
    if (task.done) {
      new Notice("完了したタスクは持ち越せません");
      return;
    }
    try {
      // 元ブロックに ID を付けて、リンクで鎖にできるようにする
      const link = await store.linkTo(date, task);
      const fromId = link?.split("#^")[1];
      if (!fromId) {
        new Notice("持ち越し元のタスクが見つかりませんでした。ノートが変更された可能性があります。");
        await this.reload();
        return;
      }
      const fromLink = `${store.pathFor(date).replace(/\.md$/, "")}#^${fromId}`;

      // 続きのブロック: 残ステップ・完了条件・プロジェクト等を引き継ぎ、未スケジュールで作る
      const remaining = task.steps
        .filter((st) => !st.done)
        .map((st) => ({ ...st, children: [...(st.children ?? [])] }));
      const newId = newBlockId();
      const toStore = dest === "inbox" ? inbox! : store;
      const toDate = dest === "inbox" ? INBOX_DATE : addDays(date, 1);
      const toLink = `${toStore.pathFor(toDate).replace(/\.md$/, "")}#^${newId}`;
      await toStore.createWithId(toDate, {
        title: task.title,
        start: null,
        end: null,
        done: false,
        reminder: task.reminder,
        doneCondition: task.doneCondition || undefined,
        steps: remaining,
        ticket: task.ticket ?? undefined,
        project: task.project ?? undefined,
        carryFrom: fromLink,
      }, newId);

      // 元ブロックを閉じる: [>] + 持ち越し先リンク（実績・ステップ・本文はそのまま）
      const ok = await store.update(date, { ...task, blockId: fromId, ref: { kind: "block", id: fromId, title: task.title, start: task.start, end: task.end } }, {
        title: task.title,
        start: task.start,
        end: task.end,
        done: false,
        forward: true,
        carryTo: toLink,
      });
      if (!ok) new Notice("持ち越し先は作りましたが、元のタスクを閉じられませんでした");
      else {
        new Notice(
          dest === "inbox"
            ? `「${stripTags(task.title) || "(無題)"}」を Inbox へ持ち越しました` +
              (remaining.length ? `（残ステップ ${remaining.length} 件）` : "")
            : `「${stripTags(task.title) || "(無題)"}」を翌日へ持ち越しました` +
              (remaining.length ? `（残ステップ ${remaining.length} 件）` : "") +
              "。明日の未スケジュールのトレイに入ります"
        );
      }
    } catch (e) {
      console.error(e);
      new Notice("持ち越せませんでした: " + String(e));
    }
    await this.reload();
    await this.reloadInbox();
  }

  /** タスクの持ち主を変える（別のフォルダのノートへブロックごと移す） */
  private async commitChangeOwner(date: Date, task: Task, data: TaskDraft): Promise<void> {
    const from = this.plugin.blockStoreFor(task.owner);
    const to = this.plugin.blockStoreFor(data.owner);
    if (!from || !to || from === to) return;
    try {
      const block = await from.takeBlock(date, task);
      if (!block) {
        new Notice("タスクが見つかりませんでした。ノートが変更された可能性があります。");
      } else {
        await to.putBlock(date, block, data.start ?? task.start);
        const ok = await to.update(date, task, { ...data, owner: undefined });
        if (!ok) new Notice("移しましたが、内容を更新できませんでした");
        const name = this.plugin.memberOf(data.owner)?.name ?? "自分";
        new Notice(`${name}の予定にしました`);
      }
    } catch (e) {
      console.error(e);
      new Notice("タスクを移せませんでした: " + String(e));
    }
    await this.reload();
  }

  // ---------- Inbox ----------

  private openInboxEditModal(task: Task): void {
    const inbox = this.plugin.inbox;
    if (!inbox) return;
    let current = task;
    const serially = serialQueue();
    new TaskModal(this.app, {
      mode: "edit",
      initial: this.draftOf(task),
      snapMinutes: this.plugin.settings.snapMinutes,
      allowUnscheduled: true,
      dateLabel: "Inbox",
      dateField: {
        value: null,
        allowEmpty: true,
        hint: "日付未定。日付を入れると、その日のノートへ移します",
      },
      tagChoices: this.plugin.settings.tagColors,
      showDoneCondition: true,
      showActual: true,
      trackers: this.plugin.settings.trackers,
      ...this.projectOptions(),
      onAutoSave: async (data) => {
        // 自動保存では Inbox に留める。「日付・時刻を入れたら移す」のは閉じるときに行う
        const next = await serially(() => this.commitInboxAutoSave(current, data));
        if (next) current = next;
        return next !== null;
      },
      onSubmit: (data, dateSel) =>
        serially(() => {
          // 日付を選んだらその日へ（時刻なしなら未スケジュールのまま）
          if (dateSel) return this.commitInboxToDay(current, dateSel, data);
          // 日付を選ばずに時刻を入れたら「今日」に移す（従来どおり）
          if (data.start !== null && data.end !== null) {
            return this.commitInboxToDay(current, startOfDay(new Date()), data);
          }
          return this.commitInboxUpdate(current, data);
        }),
      onDelete: () => serially(() => this.commitInboxDelete(current)),
      onOpenNote: () => serially(() => this.openInboxTaskInNote(current)),
    }).open();
  }

  /** Inbox の編集ダイアログからの自動保存（時刻は付けずに保存する） */
  private async commitInboxAutoSave(task: Task, data: TaskDraft): Promise<Task | null> {
    const inbox = this.plugin.inbox;
    if (!inbox) return null;
    const draft = { ...data, start: null, end: null };
    try {
      if (!(await inbox.update(INBOX_DATE, task, draft))) return null;
    } catch (e) {
      console.error(e);
      return null;
    }
    await this.reloadInbox();
    return (await this.relocateTask(inbox, INBOX_DATE, task, draft)) ?? task;
  }

  private async openInboxTaskInNote(task: Task): Promise<void> {
    const inbox = this.plugin.inbox;
    if (!inbox) return;
    try {
      const link = await inbox.linkTo(INBOX_DATE, task);
      if (link) await this.app.workspace.openLinkText(link, "", false);
      else await this.app.workspace.getLeaf("tab").openFile(await inbox.ensureFile(INBOX_DATE));
    } catch (e) {
      console.error(e);
      new Notice("ノートを開けませんでした: " + String(e));
    }
  }

  private async commitInboxUpdate(task: Task, data: TaskDraft): Promise<void> {
    const inbox = this.plugin.inbox;
    if (!inbox) return;
    try {
      const ok = await inbox.update(INBOX_DATE, task, { ...data, start: null, end: null });
      if (!ok) new Notice("タスクが見つかりませんでした。Inbox が変更された可能性があります。");
    } catch (e) {
      console.error(e);
      new Notice("タスクを保存できませんでした: " + String(e));
    }
    await this.reload();
  }

  private async commitInboxDelete(task: Task): Promise<void> {
    const inbox = this.plugin.inbox;
    if (!inbox) return;
    const doDelete = async () => {
      try {
        const ok = await inbox.remove(INBOX_DATE, task);
        if (!ok) new Notice("タスクが見つかりませんでした。Inbox が変更された可能性があります。");
      } catch (e) {
        console.error(e);
        new Notice("タスクを削除できませんでした: " + String(e));
      }
      await this.reload();
    };
    if (this.plugin.settings.confirmBodyDelete && (await inbox.hasBody(INBOX_DATE, task))) {
      new ConfirmModal(
        this.app,
        `「${task.title || "(無題)"}」には本文があります。ブロックごと削除しますか？`,
        "削除",
        doDelete
      ).open();
      return;
    }
    await doDelete();
  }

  /** Inbox のタスクをその日のノートへ移す。draft があれば移動後にその内容で更新 */
  private async commitInboxToDay(task: Task, to: Date, draft?: TaskDraft): Promise<void> {
    const inbox = this.plugin.inbox;
    const day = this.plugin.blockStore();
    if (!inbox || !day) return;
    try {
      const block = await inbox.takeBlock(INBOX_DATE, task);
      if (!block) {
        new Notice("タスクが見つかりませんでした。Inbox が変更された可能性があります。");
      } else {
        await day.putBlock(to, block, draft?.start ?? null);
        if (draft) {
          const ok = await day.update(to, task, draft);
          if (!ok) new Notice("移動しましたが、時刻を更新できませんでした");
        }
        new Notice(`${moment(to).format("M月D日")} へ移動しました`);
      }
    } catch (e) {
      console.error(e);
      new Notice("タスクを移動できませんでした: " + String(e));
    }
    await this.reload();
  }

  /** その日のタスクを Inbox へ戻す（時刻も外す）。draft があれば移動後にその内容で更新 */
  private async commitDayToInbox(from: Date, task: Task, draft?: TaskDraft): Promise<void> {
    const inbox = this.plugin.inbox;
    const day = this.plugin.blockStore();
    if (!inbox || !day) return;
    try {
      const block = await day.takeBlock(from, task);
      if (!block) {
        new Notice("タスクが見つかりませんでした。ノートが変更された可能性があります。");
      } else {
        await inbox.putBlock(INBOX_DATE, block, null);
        if (draft || task.start !== null) {
          await inbox.update(INBOX_DATE, task, {
            ...(draft ?? this.draftOf(task)),
            start: null,
            end: null,
          });
        }
        new Notice("Inbox へ戻しました（日付未定）");
      }
    } catch (e) {
      console.error(e);
      new Notice("タスクを移動できませんでした: " + String(e));
    }
    await this.reload();
  }

  // ---------- その他 ----------

  private openDatePicker(): void {
    const input = this.dateInputEl as HTMLInputElement & { showPicker?: () => void };
    try {
      if (typeof input.showPicker === "function") input.showPicker();
      else input.focus();
    } catch (_e) {
      input.focus();
    }
  }

  private async openNote(date: Date): Promise<void> {
    try {
      const file = await this.plugin.store.ensureFile(date);
      await this.app.workspace.getLeaf("tab").openFile(file);
    } catch (e) {
      console.error(e);
      new Notice("ノートを開けませんでした: " + String(e));
    }
  }
}

/** 分を "6:30" のような時:分表示に（日ヘッダーの予実合計用） */
function hmm(min: number): string {
  return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}`;
}

/**
 * 非同期処理を1つずつ順番に実行するキュー。
 * 編集ダイアログの自動保存と、閉じる・削除などの操作が同じノートに重ならないようにする
 */
function serialQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => T | Promise<T>): Promise<T> => {
    const run = tail.then(fn);
    tail = run.catch(() => undefined);
    return run;
  };
}
