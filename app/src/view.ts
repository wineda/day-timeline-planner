import {
  ItemView,
  MarkdownView,
  Menu,
  Notice,
  Platform,
  Scope,
  TAbstractFile,
  WorkspaceLeaf,
  debounce,
  getIcon,
  moment,
  setIcon,
} from "obsidian";
import type DayTimelinePlugin from "./main";
import { ScheduledTask, Task, isScheduled } from "./model";
import { projectDisplayName, type ProjectSummary } from "./project";
import { iconName } from "./icons";
import { DropdownMenu, type MenuLike } from "./dropdown";
import { layoutEvents, type LayoutInfo } from "./layout";
import {
  DEFAULT_SETTINGS,
  PLAN_ACTUAL_MODES,
  colorForTags,
  ticketUrl,
  type Member,
  type PlanActualMode,
  type ViewMode,
} from "./settings";
import { applyRecurring } from "./recurring";
import { INBOX_DATE } from "./store";
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
import { SidebarMixin } from "./view-sidebar";
import { PointerMixin } from "./view-pointer";
import { ActionsMixin } from "./view-actions";
import {
  NARROW_VIEW_WIDTH,
  PROJECT_HOVER_SOURCE,
  ProjectHoverParent,
  RESCHEDULE_LOOKBACK_DAYS,
  VIEW_MODES,
  WEEKDAY_JA,
  applyMixins,
  hmm,
  hoursDecimal,
  type DayColumn,
  type DayData,
  type NarrowPane,
  type TimelineRow,
} from "./view-shared";

// main.ts がホバープレビューの登録に使う
export { PROJECT_HOVER_SOURCE } from "./view-shared";

export const VIEW_TYPE_DAY_TIMELINE = "day-timeline-planner-view";

export class DayTimelineView extends ItemView {
  plugin: DayTimelinePlugin;
  /** 基準日。日表示ではこの日、週表示ではこの日を含む週を表示する */
  date: Date = startOfDay(new Date());
  /** 日付が変わったのを見つけるための「今日」。30 秒ごとの更新で見比べる */
  private todayKey: string = dateKey(startOfDay(new Date()));
  mode: ViewMode;
  columns: DayColumn[] = [];
  data = new Map<string, DayData>();

  private dateLabelEl!: HTMLElement;
  private dateInputEl!: HTMLInputElement;
  /** 「今日」ボタン。今日が画面に映っている間は隠す */
  private todayBtnEl!: HTMLElement;
  /** 「今日」ボタンのアイコン版（狭い画面）に入れる今日の日付の数字 */
  private todayNumEl!: HTMLElement;
  /** 狭い画面でモードのセグメントの代わりに出すアイコンボタン */
  private modeMenuBtnEl!: HTMLElement;
  private trackingEl!: HTMLElement;
  private modeBtns = new Map<ViewMode, HTMLElement>();
  /** 表示範囲（3日・週）の予実合計 */
  private rangeTotalEl!: HTMLElement;
  /** 実際に使う 1時間あたりの高さ（px） */
  hourHeightPx = 60;
  private bannerEl!: HTMLElement;
  inboxEl!: HTMLElement;
  inboxTasks: Task[] = [];
  /** 表示範囲の外（今日から過去 RESCHEDULE_LOOKBACK_DAYS 日以内）のノートのタスク（日付キー → その日）。
   * 「Inbox・時刻なし」の一覧の取り残しと、本日のサマリー（今日が表示範囲外のとき）に使う */
  pastDays = new Map<string, { date: Date; tasks: Task[] }>();
  /** 表示範囲の外（過去）に取り残された時刻なしタスク（「Inbox・時刻なし」の一覧用。pastDays から作る） */
  pastUnscheduled: { date: Date; tasks: Task[] }[] = [];
  /** サイドバーの下の「本日のサマリー」の器。出していないときは null */
  summaryEl: HTMLElement | null = null;
  /** プロジェクトの集計（パネル用のキャッシュ） */
  projectData: ProjectSummary[] = [];
  /** パネルで展開中のプロジェクト */
  expandedProjects = new Set<string>();
  /** パネルで畳んでいるプロジェクトグループ（"" = 未分類） */
  collapsedGroups = new Set<string>();
  scrollEl!: HTMLElement;
  /** タイムラインの段（いまは常に1段）。columns はその段の列の一覧 */
  private rows: TimelineRow[] = [];
  /** 幅が狭い（スマホなど）とき true。タイムラインとパネルを切り替えて片方だけ表示する */
  isNarrow = false;
  /** 狭い画面で表示中の面 */
  narrowPane: NarrowPane = "timeline";
  paneEl!: HTMLElement;
  /** タイムライン ⇄ パネルの切替セグメント（狭い画面だけ）。両方のアイコンを並べ、表示中の面を強調する */
  private paneTimelineBtnEl!: HTMLElement;
  private panePanelBtnEl!: HTMLElement;
  /** "日付キー|タスクの key" → タイムライン上の要素（エディタ連動・パネルからの選択のハイライトに使う） */
  private taskEls = new Map<string, HTMLElement>();
  private activeTaskKey: string | null = null;
  /**
   * パネル（プロジェクト一覧）でクリックして選んだタスク（"日付キー|タスクの key"）。
   * タイムラインの対応するブロックとパネルの行を強調する。エディタ連動（activeTaskKey）とは別に持ち、
   * カーソル移動で消えないようにする。別のタスクを選ぶか Esc で解除
   */
  selectedTaskKey: string | null = null;
  /** 選んだブロックをまだ画面内へスクロールしていない（表示範囲が変わって読み込みを待っているときなど） */
  private pendingReveal = false;
  /** プロジェクト名のプレビューの hover-link の親（ポップアップを大きく表示するためのクラス付け用） */
  private readonly projectHoverParent = new ProjectHoverParent();

  /** ドラッグ操作中は再描画しない */
  interacting = false;
  /** タッチの長押しから始まったドラッグ中（contextmenu を抑止する） */
  touchDragging = false;
  /** タッチで空き時間をタップしたときに出す「＋ 追加」チップ */
  touchChipEl: HTMLElement | null = null;
  /** 直前の pointerdown がタッチの空き時間タップだったか（canvas の click で消費する） */
  canvasTapArmed = false;
  pendingReload = false;
  private shouldScroll = true;
  private reloadDebounced: () => void;
  private syncCursorDebounced: () => void;
  /** ズーム（Ctrl+ホイール・タッチのピンチ）: フレームごとにまとめて反映するための適用待ちの倍率と位置 */
  pendingZoomFactor = 1;
  pendingZoomClientY = 0;
  pendingZoomRaf: number | null = null;
  /** タッチの2本指ピンチでズーム中（タップ・長押し・スワイプを抑止する） */
  pinchZooming = false;
  /** ホイールの1ノッチごとに設定ファイルへ書かないよう、保存はまとめて行う */
  persistZoomDebounced: () => void;

  constructor(leaf: WorkspaceLeaf, plugin: DayTimelinePlugin) {
    super(leaf);
    this.plugin = plugin;
    this.mode = this.defaultViewMode();
    this.reloadDebounced = debounce(() => void this.reload(), 250, true);
    this.syncCursorDebounced = debounce(() => void this.syncCursorHighlight(), 150, true);
    this.persistZoomDebounced = debounce(() => void this.plugin.persistSettings(), 500, true);

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
    // Esc: パネルで選んだタスクの強調を解除（選んでいなければ何もしない）
    this.scope.register([], "Escape", () => {
      if (!this.selectedTaskKey) return;
      this.clearSelectedTask();
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
        this.handleDayChange();
        this.updateNowLine();
        this.renderTracking();
      }, 30_000)
    );
    // エディタのカーソル位置に合わせて、対応するタスクをハイライト
    this.registerDomEvent(document, "selectionchange", () => this.syncCursorDebounced());

    // Obsidian の起動時（レイアウト復元中）に開かれたときは、保管庫の索引や
    // リンク索引（resolvedLinks）がまだできておらず、そのまま読むと「Inbox・時刻なし」の一覧や
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
    DropdownMenu.closeAll();
    this.contentEl.empty();
  }

  onResize(): void {
    this.updateNarrow();
    // パネルを全面表示中はタイムラインが隠れていて高さを測れない（タイムラインへ戻すときに測り直す）
    if (this.isNarrow && this.narrowPane === "panel") return;
    this.remeasureTimeline();
  }

  /** 隠れていたタイムラインが再表示されたときなどに、初期位置へのスクロールをやり直す */
  private remeasureTimeline(): void {
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
  applyNarrowClasses(): void {
    this.contentEl.toggleClass("is-narrow", this.isNarrow);
    this.contentEl.toggleClass("is-pane-timeline", this.isNarrow && this.narrowPane === "timeline");
    this.contentEl.toggleClass("is-pane-panel", this.isNarrow && this.narrowPane === "panel");
    this.renderPaneToggle();
    // 狭い画面では日付ラベルとチップの文言を短くする（renderHeader / renderTracking）
    if (this.dateLabelEl) this.renderHeader(); // 中で renderTracking も呼ばれる
    else this.renderTracking();
  }

  /** タイムラインとツリー（パネル）のアイコンを親に並べる。アクティブ表示は呼び出し側で付ける */
  buildPaneSegmentButtons(parent: HTMLElement): { timeline: HTMLElement; panel: HTMLElement } {
    const timeline = this.iconButton(parent, "calendar-clock", "タイムラインを表示", () =>
      this.setNarrowPane("timeline")
    );
    const panel = this.iconButton(
      parent,
      "list-tree",
      "パネル（Inbox・時刻なし・プロジェクト）を表示",
      () => this.setNarrowPane("panel")
    );
    return { timeline, panel };
  }

  /** 面の切替セグメントの状態。表示中の面のボタンを強調する */
  private renderPaneToggle(): void {
    if (!this.paneTimelineBtnEl || !this.panePanelBtnEl) return;
    const timeline = this.narrowPane === "timeline";
    this.paneTimelineBtnEl.toggleClass("is-active", timeline);
    this.panePanelBtnEl.toggleClass("is-active", !timeline);
    this.paneTimelineBtnEl.setAttr("aria-pressed", String(timeline));
    this.panePanelBtnEl.setAttr("aria-pressed", String(!timeline));
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

  /** 端末に応じた表示モード。スマホは画面が狭く週（7列）は使いにくいので、別に記憶する（既定は日表示） */
  private defaultViewMode(): ViewMode {
    return Platform.isPhone ? this.plugin.settings.viewModeMobile : this.plugin.settings.viewMode;
  }

  /** 設定変更時などに、グリッドから作り直す */
  rebuild(): void {
    if (!this.scrollEl) return;
    const prevMode = this.mode;
    this.mode = this.defaultViewMode(); // 設定画面で「既定の表示」を変えたときも追従する
    if (this.mode !== prevMode) this.alignThreeDayToToday();
    this.buildGrid();
    this.remeasureTimeline();
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

  /**
   * 3日表示で、今日が真ん中・右端に来ているか。
   * 今日が範囲に入らない（別の日を見に行っている）ときは false。
   */
  private threeDayNeedsToday(): boolean {
    if (this.mode !== "3day") return false;
    return [0, 1, 2].map((i) => addDays(this.date, i)).findIndex((d) => isToday(d)) > 0;
  }

  /** 3日表示の基準日（＝一番左の日）を今日にそろえる。呼び出し側でグリッドを作り直す */
  private alignThreeDayToToday(): void {
    if (this.threeDayNeedsToday()) this.date = startOfDay(new Date());
  }

  /** 日をまたいだとき: 3日表示は今日が左端に来るよう寄せ直し、そうでなければ「今日」の色を付け替える */
  private handleDayChange(): void {
    const key = dateKey(startOfDay(new Date()));
    if (key === this.todayKey) return;
    this.todayKey = key;
    if (this.threeDayNeedsToday()) {
      this.setDate(startOfDay(new Date()));
      return;
    }
    this.renderDayHeaders();
    this.renderHeader();
  }

  setViewMode(mode: ViewMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    if (Platform.isPhone) this.plugin.settings.viewModeMobile = mode;
    else this.plugin.settings.viewMode = mode;
    void this.plugin.persistSettings();
    this.alignThreeDayToToday();
    this.buildGrid();
    this.remeasureTimeline();
    this.shouldScroll = true;
    void this.reload();
  }

  /** 日 → 3日 → 週 → 日 … と切り替える */
  toggleViewMode(): void {
    const order: ViewMode[] = ["day", "3day", "week"];
    this.setViewMode(order[(order.indexOf(this.mode) + 1) % order.length]);
  }

  // ---------- 表示している日 ----------

  /** 表示中の日付（日: 1日 / 3日: 基準日から3日 / 週: 7日） */
  visibleDays(): Date[] {
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
    }
  }

  /** 表示ONのメンバー（ブロック形式のときだけ） */
  private visibleMembers(): Member[] {
    if (!this.plugin.blockStore()) return [];
    return this.plugin.settings.members.filter((m) => m.visible && this.plugin.memberStores.has(m.id));
  }

  /** タスクの色: メンバーの予定はメンバー色、自分の予定はタグ色 */
  taskColor(task: Task): string | null {
    if (task.owner) return this.plugin.memberOf(task.owner)?.color ?? null;
    return colorForTags(task.tags, this.plugin.settings.tagColors);
  }

  /** タスクの持ち主の名前（自分なら null） */
  ownerName(task: Task): string | null {
    return task.owner ? (this.plugin.memberOf(task.owner)?.name ?? "?") : null;
  }

  /** タスクの持ち主に応じたストア */
  storeOf(task: Task) {
    return this.plugin.storeFor(task.owner);
  }

  private columnFor(date: Date): DayColumn | null {
    const k = dateKey(date);
    return this.columns.find((c) => c.key === k) ?? null;
  }

  dataFor(date: Date): DayData {
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

    // ツールバーはタイムラインの直上に1行だけ（TickTick 風のシンプルなヘッダー）。
    // 左は面の切替と「9月」の月タイトル、右は操作のまとまり。狭い画面でも折り返さないよう、
    // 常時出すのは「面の切替・タイトル・今日・モード・⋮」に絞り、
    // ズーム・予実・メンバーを含む設定系はすべて ⋮ メニューにまとめる
    const bar = main.createDiv("dt-toolbar");

    // 左端: 狭い画面（スマホなど）だけに出す、タイムライン ⇄ パネル（Inbox・プロジェクト）の切替。
    // 1つのトグルだと「いまどちらか・押すとどうなるか」が分かりにくかったので、
    // 両方のアイコンを並べて表示中の面を色で強調する（枠は持たせない）。
    // パネル側のヘッダーにも同じものを同じ左端に出し、面を行き来してもアイコンの位置が
    // 動かないようにする（右側のアイコン群に混ぜると、パネル側は並ぶ操作が違うのでずれる）
    this.paneEl = bar.createDiv("dt-pane");
    const seg = this.buildPaneSegmentButtons(this.paneEl);
    this.paneTimelineBtnEl = seg.timeline;
    this.panePanelBtnEl = seg.panel;
    this.renderPaneToggle();

    // 月タイトル（クリックで日付ピッカー）。詳しい日付は下の列ヘッダーが持つので、
    // ここは大きな見出しとしてだけ使う
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

    // 日付の移動。狭い画面では矢印を出さず、横スワイプと「今日」で移動する
    const nav = bar.createDiv("dt-nav");
    this.iconButton(nav, "chevron-left", "前へ", () => this.goToPrev());
    // 「今日」は今日が画面に映っていないときだけ出す（映っている間は押す意味がない）。
    // 広い画面では文字、狭い画面では「カレンダーの枠 + 今日の日付」のアイコンで出す
    this.todayBtnEl = nav.createEl("button", {
      cls: "dt-today-btn",
      attr: { "aria-label": "今日へ移動" },
    });
    const todayIcon = this.todayBtnEl.createSpan("dt-today-icon");
    setIcon(todayIcon, iconName("calendar"));
    this.todayNumEl = todayIcon.createSpan("dt-today-num");
    this.todayBtnEl.createSpan({ cls: "dt-today-text", text: "今日" });
    this.todayBtnEl.onclick = () => this.goToToday();
    this.iconButton(nav, "chevron-right", "次へ", () => this.goToNext());

    // 表示範囲（3日・週）の予実合計。表示中の範囲の情報なので日付ラベルの隣に置く
    this.rangeTotalEl = bar.createDiv("dt-range-total");

    bar.createDiv("dt-toolbar-spacer");

    // 実績を計測中のタスク（クリックで終了して実績に記録）
    this.trackingEl = bar.createEl("button", { cls: "dt-tracking-chip", attr: { "aria-label": "実績の計測" } });
    this.trackingEl.onclick = () => void this.plugin.stopTaskTracking(true);
    this.trackingEl.addEventListener("contextmenu", (e: MouseEvent) => {
      e.preventDefault();
      this.openHeaderMenu(this.trackingEl, e, (menu) => {
        menu.addItem((i) =>
          i.setTitle("計測を終了して実績に記録").setIcon("square").onClick(() => void this.plugin.stopTaskTracking(true))
        );
        menu.addItem((i) =>
          i.setTitle("記録せずにやめる").setIcon("x").onClick(() => void this.plugin.stopTaskTracking(false))
        );
      });
    });
    this.renderTracking();

    const modeWrap = bar.createDiv("dt-mode");
    for (const [mode, label] of VIEW_MODES) {
      const b = modeWrap.createEl("button", { text: label, cls: "dt-mode-btn" });
      b.onclick = () => this.setViewMode(mode);
      this.modeBtns.set(mode, b);
    }

    // 狭い画面ではセグメント（4個ぶんの幅）が1行に収まらないので、アイコン1つの
    // メニューに畳む（TickTick 風。選択中の単位はメニュー内のチェックで分かる）。
    // どちらを出すかは CSS（.dt-view.is-narrow）で切り替える。
    // メニューはボタンの真下に出す（スマホでも画面下のシートにはしない）
    this.modeMenuBtnEl = bar.createEl("button", {
      cls: "dt-mode-menu-btn",
      attr: { "aria-label": "表示の単位を選ぶ（日・3日・週）" },
    });
    setIcon(this.modeMenuBtnEl, iconName("columns"));
    this.modeMenuBtnEl.onclick = () => {
      this.openHeaderMenu(this.modeMenuBtnEl, null, (menu) => {
        for (const [mode, , label] of VIEW_MODES) {
          menu.addItem((i) =>
            i.setTitle(label).setChecked(mode === this.mode).onClick(() => this.setViewMode(mode))
          );
        }
      });
    };

    const addBtn = this.iconButton(bar, "plus", "タスクを追加", () => this.openCreateModal(this.date));
    addBtn.addClass("dt-toolbar-add");
    this.menuButton(bar, "メニュー（表示・ノート・定期タスク）", (menu) =>
      this.buildMoreMenu(menu)
    );

    this.scrollEl = main.createDiv("dt-scroll");
    this.attachSwipeNavigation();
    this.attachWheelZoom();
    this.attachPinchZoom();

    // 狭い画面用: 右下の「＋」ボタン（Google カレンダー方式）。ツールバーの＋の代わり
    const fab = main.createEl("button", { cls: "dt-fab", attr: { "aria-label": "タスクを追加" } });
    setIcon(fab, iconName("plus"));
    fab.onclick = () => this.openCreateModal(this.date);
  }

  /**
   * ⋮ メニューの「表示」まわり: 縮尺・メンバーの表示切替。
   * 項目を1つでも足したら true（呼び出し側で区切り線を入れるかの判断に使う）
   */
  private buildViewMenu(menu: MenuLike): boolean {
    const s = this.plugin.settings;
    let empty = false;
    // 縮尺は Ctrl+ホイール / ピンチで変える。ここでは既定に戻すだけ
    menu.addItem((i) =>
      i
        .setTitle("縮尺を標準に戻す")
        .setIcon("zoom-out")
        .setDisabled(s.hourHeight === DEFAULT_SETTINGS.hourHeight)
        .onClick(() => this.resetZoom())
    );
    // タイムラインに出すバー: 予定だけ / 予定と実績 / 実績だけ
    menu.addSeparator();
    menu.addItem((i) => i.setTitle("タイムラインに出すバー").setDisabled(true));
    for (const [mode, label] of PLAN_ACTUAL_MODES) {
      menu.addItem((i) =>
        i.setTitle(label).setChecked(s.planActualMode === mode).onClick(() => this.setPlanActualMode(mode))
      );
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
    return !empty;
  }

  /** ツールバーの ⋮ メニュー: 表示オプション・ノート・定期タスク */
  private buildMoreMenu(menu: MenuLike): void {
    // メニューの入口が「表示 ▾」と ⋮ の2つに割れていると、どちらに何があるか覚えられない。
    // 1行に収めるためもあり、表示オプションはこの先頭にまとめる
    if (this.buildViewMenu(menu)) menu.addSeparator();
    const m = moment(this.date);
    const exists = this.dataFor(this.date).exists;
    menu.addItem((i) =>
      i
        .setTitle(`${exists ? "ノートを開く" : "ノートを作成して開く"}（${m.format("M月D日")}）`)
        .setIcon("file-text")
        .onClick(() => void this.openNote(this.date))
    );
    menu.addItem((i) =>
      i.setTitle("定期タスクを管理").setIcon("repeat").onClick(() => void this.plugin.activateRecurringView())
    );
  }

  /** アイコンボタン（クリック / Enter / Space で動作） */
  iconButton(
    parent: HTMLElement,
    icon: string,
    label: string,
    onClick: () => void
  ): HTMLElement {
    const btn = parent.createDiv({
      cls: "clickable-icon dt-icon-btn",
      attr: { "aria-label": label, role: "button", tabindex: "0" },
    });
    setIcon(btn, iconName(icon));
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
   * （スマホではどちらもボタンの真下のドロップダウン。openHeaderMenu を参照）
   */
  menuButton(
    parent: HTMLElement,
    label: string,
    build: (menu: MenuLike) => void
  ): HTMLElement {
    const btn = parent.createDiv({
      cls: "clickable-icon dt-icon-btn dt-kebab-btn",
      attr: { "aria-label": label, role: "button", tabindex: "0" },
    });
    setIcon(btn, iconName("more-vertical"));
    const open = (e: MouseEvent | null) => this.openHeaderMenu(btn, e, build);
    btn.addEventListener("click", (e: MouseEvent) => open(e));
    btn.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open(null);
      }
    });
    return btn;
  }

  /**
   * ヘッダー（ツールバー・パネルの見出し）のボタンから開くメニュー。
   * スマホでは Obsidian の Menu が画面下のシートとして出るため、上端のボタンを押してから
   * 指を画面の下端まで運ぶことになり、選択肢が遠かった。スマホだけはボタンの真下に付く
   * ドロップダウン（DropdownMenu）で出す。それ以外は従来どおり Obsidian の Menu を
   * クリック位置（e があるとき）かボタンの真下に出す
   */
  private openHeaderMenu(
    anchor: HTMLElement,
    e: MouseEvent | null,
    build: (menu: MenuLike) => void
  ): void {
    if (Platform.isPhone) {
      const menu = new DropdownMenu();
      build(menu);
      menu.showAtElement(anchor);
      return;
    }
    const menu = new Menu();
    build(menu);
    if (e) menu.showAtMouseEvent(e);
    else {
      const r = anchor.getBoundingClientRect();
      menu.showAtPosition({ x: r.left, y: r.bottom + 4 });
    }
  }

  /** 表示中の日付に合わせて、時間軸と日ごとの列を作る */
  private buildGrid(): void {
    const s = this.plugin.settings;
    this.hourHeightPx = s.hourHeight;
    this.scrollEl.empty();
    this.columns = [];
    this.rows = [];
    this.taskEls.clear();

    this.contentEl.toggleClass("is-week", this.mode === "week");
    this.contentEl.toggleClass("is-3day", this.mode === "3day");
    this.contentEl.toggleClass("is-day", this.mode === "day");
    this.contentEl.toggleClass("is-multi-day", this.mode === "week" || this.mode === "3day");

    const height = (s.endHour - s.startHour) * this.hourHeightPx;
    this.buildRow(this.visibleDays(), height);
    this.renderDayHeaders();
  }

  /** 1段ぶん（曜日ヘッダー + 時間軸 + 日の列）を scrollEl の末尾に作る */
  private buildRow(dates: Date[], height: number): void {
    const s = this.plugin.settings;
    const rowEl = this.scrollEl.createDiv("dt-row");

    // 曜日・日付のヘッダー（スクロールしても段の上に残る）
    const headersEl = rowEl.createDiv("dt-day-headers");
    headersEl.createDiv("dt-day-headers-spacer");
    const headerCells = headersEl.createDiv("dt-day-headers-cells");

    const grid = rowEl.createDiv("dt-grid");
    const labelsEl = grid.createDiv("dt-labels");
    const daysEl = grid.createDiv("dt-days");
    labelsEl.style.height = height + "px";

    for (let h = s.startHour; h <= s.endHour; h++) {
      const top = (h - s.startHour) * this.hourHeightPx;
      const label = labelsEl.createDiv({ cls: "dt-hour-label", text: `${h}:00` });
      label.style.top = top + "px";
    }

    const row: TimelineRow = {
      el: rowEl,
      headersEl,
      labelsEl,
      daysEl,
      columns: [],
      nowLineEl: null,
      nowLabelEl: null,
    };
    for (const date of dates) {
      const headerEl = headerCells.createDiv("dt-day-header");
      const canvasEl = daysEl.createDiv("dt-canvas");
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
      const col: DayColumn = { date, key: dateKey(date), headerEl, canvasEl, eventsEl, nowEl: null, row };
      canvasEl.addEventListener("pointerdown", (e) => this.onCanvasPointerDown(e, col));
      canvasEl.addEventListener("click", (e) => this.onCanvasClick(e, col));
      row.columns.push(col);
      this.columns.push(col);
    }
    this.rows.push(row);
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
      // 曜日と日付は1つのまとまりに（スマホでは横並びにして高さを節約する）。
      // 日付そのものをクリックするとその日の日報、ヘッダーの他の場所は今までどおり日表示へ
      const dateEl = el.createDiv("dt-day-header-date");
      dateEl.createSpan({ cls: "dt-day-header-dow", text: WEEKDAY_JA[dow] });
      dateEl.createSpan({ cls: "dt-day-header-num", text: String(col.date.getDate()) });
      const label = moment(col.date).format("M月D日 (ddd)");
      el.setAttr("aria-label", `${label} を日表示で開く`);
      el.onclick = () => {
        this.date = startOfDay(col.date);
        this.setViewMode("day");
      };
      if (this.plugin.blockStore()) {
        const date = startOfDay(col.date);
        dateEl.addClass("is-clickable");
        dateEl.setAttr("role", "button");
        dateEl.setAttr("tabindex", "0");
        dateEl.setAttr("aria-label", `${label} の日報を見る`);
        dateEl.addEventListener("click", (e) => {
          e.stopPropagation();
          void this.plugin.openDailyReport(date);
        });
        dateEl.addEventListener("keydown", (e: KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopPropagation();
            void this.plugin.openDailyReport(date);
          }
        });
      }
    }
  }

  private onVaultChange(path: string): void {
    const inbox = this.plugin.inbox;
    if (inbox && path === inbox.pathFor(INBOX_DATE)) {
      this.reloadDebounced();
      return;
    }
    // プロジェクトノートの変更もパネルに反映する（frontmatter の group・done の手書き編集や Bases からの変更など）
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
    // 表示範囲の外でも、「Inbox・時刻なし」の一覧・本日のサマリーが見ている過去のノートなら読み直す
    const blockStore = this.plugin.blockStore();
    if (blockStore && this.needsPastDays()) {
      const d = blockStore.dateFromPath(path);
      if (d) {
        const today = startOfDay(new Date());
        if (d <= today && d >= addDays(today, -RESCHEDULE_LOOKBACK_DAYS)) this.reloadDebounced();
      }
    }
  }

  async reload(): Promise<void> {
    if (this.interacting) {
      this.pendingReload = true;
      return;
    }
    this.updateNarrow(); // 開いた直後などで onResize より先に来たときのための再判定
    const s = this.plugin.settings;
    const store = this.plugin.store;
    const blockStore = this.plugin.blockStore();
    const days = this.visibleDays();
    try {
      await applyRecurring(this.plugin, days);
    } catch (e) {
      console.error(e);
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
        const legacyCount = day.exists ? await store.countLegacyEvents(d) : 0;
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
      this.pastDays = await this.loadPastDays();
    } catch (e) {
      console.error(e);
      this.pastDays = new Map();
    }
    this.pastUnscheduled = this.pastUnscheduledFrom(this.pastDays);
    this.renderHeader();
    this.renderBanner();
    this.renderInbox();
    this.renderEvents();
    if (this.shouldScroll) this.scrollToInitial();
    // パネルで選んだタスクの日へ移動してきた場合は、読み込み後にそのブロックまでスクロールする
    this.revealSelectedTask();
    this.pendingReveal = false; // 時刻の無いタスクなどブロックが描かれないときは、ここで諦める
  }

  setDate(d: Date): void {
    const next = startOfDay(d);
    let sameRange: boolean;
    switch (this.mode) {
      case "week":
        sameRange = isSameDay(
          startOfWeek(next, this.plugin.settings.weekStart),
          startOfWeek(this.date, this.plugin.settings.weekStart)
        );
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
    const days = this.visibleDays();
    const a = moment(days[0]);
    const b = moment(days[days.length - 1]);
    // タイトルは「9月」のような月の見出し（TickTick 風）。見えている日々は真下の
    // 列ヘッダー（曜日 + 日付）に出ているので、ここでは範囲を繰り返さない。
    // 年は今年以外のときだけ添える（毎回読む情報ではない）。
    // 月をまたぐ週は、基準日ではなく「見えている範囲の真ん中の日」の月を出す
    //（8/30〜9/5 の週なら「9月」。TickTick と同じ見え方になる）
    const rep = this.mode === "day" ? m : moment(days[Math.floor(days.length / 2)]);
    const thisYear = new Date().getFullYear();
    const needYear = rep.year() !== thisYear;
    const narrow = this.isNarrow;
    if (this.mode === "day") {
      // 日表示だけは列ヘッダーが1列で日付の並びが無いので、どの日かをタイトルで示す。
      // 曜日は真下の列ヘッダーに出ているので、1行に収める狭い画面では省く
      const ymd = needYear ? "YYYY年M月D日" : "M月D日";
      this.dateLabelEl.setText(m.format(narrow ? ymd : `${ymd} (ddd)`));
      this.dateLabelEl.setAttr("aria-label", `${m.format("YYYY年M月D日 (ddd)")}（日付を選ぶ）`);
    } else if (!narrow && a.month() !== b.month()) {
      // 広い画面では月をまたぐ範囲を「8月〜9月」と示す（狭い画面は真ん中の月だけで十分）
      const af = a.year() !== thisYear ? "YYYY年M月" : "M月";
      const bf = b.year() !== a.year() ? "YYYY年M月" : "M月";
      this.dateLabelEl.setText(`${a.format(af)}〜${b.format(bf)}`);
      this.dateLabelEl.setAttr(
        "aria-label",
        `${a.format("YYYY年M月D日")} 〜 ${b.format("YYYY年M月D日")}（日付を選ぶ）`
      );
    } else {
      this.dateLabelEl.setText(rep.format(needYear ? "YYYY年M月" : "M月"));
      this.dateLabelEl.setAttr(
        "aria-label",
        `${a.format("YYYY年M月D日")} 〜 ${b.format("YYYY年M月D日")}（日付を選ぶ）`
      );
    }
    // 今日が映っている間は「今日」を押す意味がないので隠し、そのぶんの幅をタイトルに回す
    const now = new Date();
    const showsToday = days.some((d) => isToday(d));
    this.todayBtnEl.toggleClass("is-hidden", showsToday);
    // 狭い画面のアイコン版「今日」には、今日の日付の数字を入れる（TickTick 風）
    this.todayNumEl.setText(String(now.getDate()));
    this.dateInputEl.value = m.format("YYYY-MM-DD");
    for (const [mode, btn] of this.modeBtns) btn.toggleClass("is-active", mode === this.mode);
    this.modeMenuBtnEl.setAttr(
      "aria-label",
      `表示の単位を選ぶ（いま: ${VIEW_MODES.find(([v]) => v === this.mode)?.[2] ?? ""}）`
    );
    this.renderTracking();
  }

  /** ツールバーの「実績を計測中」チップ（main の startTaskTracking からも呼ばれる） */
  renderTracking(): void {
    // 本日のサマリーも同じタイミング（計測の開始・終了、30 秒ごと）で描き直す。
    // 「いま / 次」のタスクと計測ボタンの状態が時刻・計測状態で変わるため
    this.renderSummary();
    if (!this.trackingEl) return;
    const tr = this.plugin.settings.tracking;
    this.trackingEl.toggleClass("is-visible", !!tr);
    if (!tr) return;
    const sameDay = dateKey(new Date()) === tr.date;
    const elapsed = Math.max(sameDay ? nowMinutes() - tr.startMin : 1440 - tr.startMin, 0);
    // 狭い画面ではツールバーが1行なので、タスク名まで出すと日付を押し出してしまう。
    // 名前は長押し（右クリック）のメニューと読み上げラベルに残す
    this.trackingEl.setText(
      this.isNarrow ? `⏺ ${formatDuration(elapsed)}` : `⏺ ${formatDuration(elapsed)} ${tr.title}`
    );
    this.trackingEl.setAttr(
      "aria-label",
      `実績を計測中: ${tr.title}\nクリックで終了して実績に記録（右クリックでメニュー）`
    );
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

  renderEvents(): void {
    const s = this.plugin.settings;
    const dayStart = s.startHour * 60;
    const dayEnd = s.endHour * 60;
    // 予定と実績の両方を出すときは予定を左のレーン、実績を右のレーンに。片方だけなら列いっぱいに
    const pa = s.planActualMode;
    const full = { left: 0, width: 1 };
    this.taskEls.clear();

    let anyBar = false;
    for (const col of this.columns) {
      col.eventsEl.empty();
      const tasks = this.dataFor(col.date).tasks;

      if (pa !== "actual") {
        const visible = tasks.filter(isScheduled).filter((t) => t.end > dayStart && t.start < dayEnd);
        const layout = layoutEvents(visible);
        const lane = pa === "both" ? { left: 0, width: 0.5 } : full;
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
        const actualLayout = layoutEvents(items);
        const lane = pa === "both" ? { left: 0.5, width: 0.5 } : full;
        for (const item of items) {
          this.renderActualBar(col, item, actualLayout.get(item) ?? { col: 0, cols: 1 }, lane);
          anyBar = true;
        }
      }
    }

    if (!anyBar && this.columns.length) {
      this.columns[0].eventsEl.createDiv({
        cls: "dt-empty-hint",
        text:
          pa === "actual"
            ? "実績はまだありません。タスクの編集ダイアログの「実績」欄で記録できます（⋮ メニューで予定の表示に戻せます）"
            : this.mode === "day"
              ? "空いている時間をクリック、またはドラッグしてタスクを追加"
              : "空いている時間をクリック / ドラッグしてタスクを追加",
      });
    }
    this.updateNowLine();
    this.renderDayTotals();
  }

  /** タイムラインに出すバー（予定 / 予定と実績 / 実績）を切り替える。⋮ メニューとコマンドから */
  setPlanActualMode(mode: PlanActualMode): void {
    const s = this.plugin.settings;
    if (s.planActualMode === mode) return;
    s.planActualMode = mode;
    void this.plugin.persistSettings();
    this.renderEvents();
    new Notice(`表示: ${PLAN_ACTUAL_MODES.find(([m]) => m === mode)?.[1] ?? mode}`);
  }

  /** 予定 → 予定と実績 → 実績 → 予定 … の順に切り替える（コマンド用） */
  cyclePlanActualMode(): void {
    const order = PLAN_ACTUAL_MODES.map(([m]) => m);
    const i = order.indexOf(this.plugin.settings.planActualMode);
    this.setPlanActualMode(order[(i + 1) % order.length]);
  }

  /** レーン内の水平位置。lane の left / width は列の幅に対する 0〜1 の割合 */
  private barGeometry(info: LayoutInfo, lane: { left: number; width: number }): { left: string; width: string } {
    return {
      left: `calc(${(lane.left + (info.col / info.cols) * lane.width) * 100}% + 2px)`,
      width: `calc(${(lane.width / info.cols) * 100}% - 4px)`,
    };
  }

  /** 重なりで分割されて幅が狭くなったレーンに is-lane-narrow を付ける。
      CSS の @container はブロック自身の幅で判定できない（コンテナは祖先を見る仕様）ので、
      列の実幅からレーン幅を計算してクラスで切り替える。列幅が測れないとき（非表示中など）は
      付けずに通常の見た目のままにする */
  private markNarrowLane(
    el: HTMLElement,
    col: DayColumn,
    info: LayoutInfo,
    lane: { left: number; width: number }
  ): void {
    const colWidth = col.eventsEl.clientWidth;
    if (colWidth <= 0) return;
    // barGeometry と同じ計算（両側 2px ずつのすき間を引いた実幅）
    const laneWidth = colWidth * (lane.width / info.cols) - 4;
    el.toggleClass("is-lane-narrow", laneWidth < 40);
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
    this.markNarrowLane(el, col, info, lane);
    el.toggleClass("is-plan", paired);
    el.toggleClass("is-done", task.done);
    el.toggleClass("is-forwarded", task.forwarded);
    el.toggleClass("is-short", h < 34);
    el.toggleClass("is-tiny", h < 18);
    this.registerTaskEl(`${col.key}|${task.key}`, el);
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
      // クリックでノートを開く。Ctrl/Cmd + クリックならポップアップでプレビュー
      badge.addEventListener("pointerdown", (ev) => ev.stopPropagation());
      badge.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (ev.ctrlKey || ev.metaKey) this.showProjectPreview(badge, link, ev);
        else void this.plugin.openProject(link);
      });
    }
    if (task.carryFrom) {
      const same = this.isSameNoteLink(col.date, task, task.carryFrom);
      this.carryBadge(el, same ? "◀ 前回から" : "◀ 前日から", task.carryFrom, same ? "当日の前回のブロック（持ち越し元）を開く" : "持ち越し元のブロックを開く");
    }
    if (task.carryTo) {
      const same = this.isSameNoteLink(col.date, task, task.carryTo);
      this.carryBadge(el, same ? "▶ 続き（当日）" : "▶ 持ち越し先", task.carryTo, same ? "当日の続きのブロック（持ち越し先）を開く" : "持ち越し先のブロックを開く");
    }
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
    this.markNarrowLane(el, col, info, lane);
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
    if (!this.taskEls.has(elKey)) this.registerTaskEl(elKey, el);

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

    // 本体: クリックで編集、ドラッグで区間ごと移動（タッチではタップ＝click で編集、
    // 長押ししてからドラッグ）
    let touchTapArmed = false;
    el.addEventListener("pointerdown", (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      touchTapArmed = false;
      if (this.isTouch(e)) {
        touchTapArmed = true;
        this.touchGate(el, e, {
          onLongPress: () => {
            touchTapArmed = false;
            el.addClass("is-lifted");
            beginMove(e, true);
          },
        });
        return;
      }
      beginMove(e, false);
    });
    el.addEventListener("click", (ce: MouseEvent) => {
      ce.stopPropagation();
      if (!touchTapArmed) return;
      touchTapArmed = false;
      if (this.touchDragging) return;
      this.openEditModal(col.date, task);
    });
    const beginMove = (e: PointerEvent, viaLongPress: boolean) => {
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
        onEnd: (moved, ev) => {
          el.removeClass("is-dragging");
          el.removeClass("is-lifted");
          if (!moved) {
            if (viaLongPress) {
              this.swallowNextClick();
              this.showTaskMenu(col.date, task, ev);
            } else this.openEditModal(col.date, task);
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
    };

    // 下端のハンドル: ドラッグで終了時刻を変更（タッチでは長押ししてからドラッグ。
    // タップは el へバブルする click が編集を開く）
    handle.addEventListener("pointerdown", (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      touchTapArmed = false;
      if (this.isTouch(e)) {
        touchTapArmed = true;
        this.touchGate(handle, e, {
          onLongPress: () => {
            touchTapArmed = false;
            el.addClass("is-lifted");
            beginResize(e);
          },
        });
        return;
      }
      beginResize(e);
    });
    const beginResize = (e: PointerEvent) => {
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
          el.removeClass("is-lifted");
          if (!moved || newEnd === item.end) {
            this.renderEvents();
            return;
          }
          commitRanges(item.start, newEnd);
        },
        onCancel: () => this.renderEvents(),
      });
    };

    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.touchDragging) return; // 長押しドラッグ中の contextmenu（Android）は無視
      this.showTaskMenu(col.date, task, e);
    });
    this.attachHoverPreview(el, col.date, task);
  }

  /**
   * 持ち越しのリンク先が、そのタスクの入っているノート自身か（＝当日内の持ち越し）。
   * リンクは "path#^id"（.md 無し）なので、パス部分をそのタスクのノートのパスと比べる
   */
  private isSameNoteLink(date: Date, task: Task, linktext: string): boolean {
    const store = this.plugin.blockStoreFor(task.owner);
    if (!store) return false;
    const own = store.pathFor(date).replace(/\.md$/, "");
    const target = linktext.split("#")[0].trim().replace(/\.md$/, "");
    return !!target && target === own;
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
    let rangePlan = 0;
    let rangeAct = 0;
    for (const row of this.rows) {
      let rowPlan = 0;
      let rowAct = 0;
      {
        for (const col of row.columns) {
          let el = col.headerEl.querySelector<HTMLElement>(".dt-day-total");
          const tasks = this.dataFor(col.date).tasks.filter((t) => !t.owner);
          const plan = tasks.reduce((n, t) => n + (isScheduled(t) ? t.end - t.start : 0), 0);
          const act = tasks.reduce((n, t) => n + t.actual.reduce((m, r) => m + (r.end - r.start), 0), 0);
          rowPlan += plan;
          rowAct += act;
          // 実績（小数1桁の時間）と予定との差異を「14.1 +1.6」の1行だけで出す。
          // 予定の時間そのものは幅を取るので出さず、マウスを乗せたときの内訳（aria-label）で
          // 分かるようにする。実績がまだ無い日（これからの日）は何も出さない
          if (!act) {
            el?.remove();
            continue;
          }
          if (!el) el = col.headerEl.createDiv("dt-day-total");
          el.empty();
          el.setAttr("aria-label", `実績 ${hmm(act)} / 予定 ${hmm(plan)}`);
          el.createSpan({ cls: "dt-day-total-act", text: hoursDecimal(act) });
          if (plan) {
            const diff = act - plan;
            const d = el.createSpan({
              cls: "dt-day-total-diff",
              text: `${diff >= 0 ? "+" : "-"}${hoursDecimal(Math.abs(diff))}`,
            });
            d.toggleClass("is-over", diff > 0);
          }
        }
      }
      rangePlan += rowPlan;
      rangeAct += rowAct;
    }
    // 週・3日表示のヘッダーに範囲合計
    if (this.rangeTotalEl) {
      let text = "";
      const multi = this.mode === "week" || this.mode === "3day";
      if (multi && (rangePlan || rangeAct)) {
        const label = this.mode === "week" ? "週" : "計";
        text = `${label}: ${this.formatRangeTotal(rangePlan, rangeAct)}`;
      }
      this.rangeTotalEl.setText(text);
      this.rangeTotalEl.toggleClass("is-visible", !!text);
    }
  }

  /** 範囲の予実合計の文言: 「予 32:00・実 33:15（+1:15）」（差異は両方あるときだけ） */
  private formatRangeTotal(plan: number, act: number): string {
    const diff = act - plan;
    return (
      `予 ${hmm(plan)}・実 ${hmm(act)}` +
      (plan && act ? `（${diff >= 0 ? "+" : "-"}${hmm(Math.abs(diff))}）` : "")
    );
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

  /**
   * 現在時刻の線（TickTick 風）。今日が表示範囲にあるときだけ、
   * - 全列をまたぐ細い線（dt-now-line）を日の列の入れ物に、
   * - 今日の列には太い線と●（dt-now）を、
   * - 左の時刻の目盛りには赤い「17:58」（dt-now-label）を出す。近くの「18:00」の目盛りは重なるので隠す
   */
  private updateNowLine(): void {
    const s = this.plugin.settings;
    const dayStart = s.startHour * 60;
    const dayEnd = s.endHour * 60;
    const m = nowMinutes();
    const inRange = s.showCurrentTime && m >= dayStart && m <= dayEnd;
    for (const col of this.columns) {
      const show = inRange && isToday(col.date);
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

    // 全列をまたぐ線と目盛りのラベルは段ごと。今日がある段にだけ出す
    const top = this.minutesToPx(m);
    for (const row of this.rows) {
      const showAll = inRange && row.daysEl.isConnected && row.columns.some((c) => isToday(c.date));
      if (!showAll) {
        row.nowLineEl?.remove();
        row.nowLineEl = null;
        row.nowLabelEl?.remove();
        row.nowLabelEl = null;
        row.labelsEl.querySelectorAll<HTMLElement>(".dt-hour-label.is-near-now").forEach((el) =>
          el.removeClass("is-near-now")
        );
        continue;
      }
      if (!row.nowLineEl || !row.nowLineEl.isConnected) {
        row.nowLineEl = row.daysEl.createDiv("dt-now-line");
      }
      row.nowLineEl.style.top = top + "px";
      if (!row.nowLabelEl || !row.nowLabelEl.isConnected) {
        row.nowLabelEl = row.labelsEl.createDiv("dt-now-label");
      }
      row.nowLabelEl.setText(minutesToHHMM(m));
      row.nowLabelEl.style.top = top + "px";
      // 現在時刻のラベルと重なる時刻の目盛り（前後 12px 以内）は隠す
      for (const el of Array.from(row.labelsEl.querySelectorAll<HTMLElement>(".dt-hour-label"))) {
        const labelTop = parseFloat(el.style.top) || 0;
        el.toggleClass("is-near-now", Math.abs(labelTop - top) < 12);
      }
    }
  }

  private scrollToInitial(): void {
    if (!this.scrollEl || this.scrollEl.clientHeight === 0) return; // まだ表示されていない
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
    const row = this.rows.find((r) => r.columns.some((c) => isToday(c.date))) ?? this.rows[0];
    this.scrollEl.scrollTop = Math.max(0, this.rowOffset(row) + this.minutesToPx(target));
    this.shouldScroll = false;
  }

  /** 段の時間軸の上端が、最初の段の上端からどれだけ下にあるか（px）。1段だけなら 0 */
  private rowOffset(row: TimelineRow | undefined): number {
    const first = this.rows[0];
    if (!row || !first || row === first) return 0;
    return row.daysEl.getBoundingClientRect().top - first.daysEl.getBoundingClientRect().top;
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

  // ---------- パネルからの選択（プロジェクト一覧のタスク → タイムラインのブロック） ----------

  /** taskEls / activeTaskKey / selectedTaskKey の鍵（"日付キー|タスクの key"） */
  taskElKey(date: Date, task: Task): string {
    return `${dateKey(date)}|${task.key}`;
  }

  /** タイムライン上のタスク要素を鍵で登録し、エディタ連動・パネルからの選択のハイライトを反映する */
  private registerTaskEl(elKey: string, el: HTMLElement): void {
    el.toggleClass("is-active-in-note", elKey === this.activeTaskKey);
    el.toggleClass("is-selected", elKey === this.selectedTaskKey);
    this.taskEls.set(elKey, el);
  }

  /**
   * パネルでクリックしたタスクを選択中にする。タイムラインの対応するブロック（描画済みのもの）と
   * パネルの行に is-selected を付け、ブロックへのスクロールを予約する（revealSelectedTask で実行）。
   * rowEl はクリックしたパネルの行（描き直さずにその場で印を付け替える）
   */
  selectTask(date: Date, task: Task, rowEl?: HTMLElement): void {
    const key = this.taskElKey(date, task);
    this.selectedTaskKey = key;
    this.pendingReveal = true;
    for (const [k, el] of this.taskEls) el.toggleClass("is-selected", k === key);
    this.inboxEl
      ?.querySelectorAll<HTMLElement>(".dt-project-child.is-selected, .dt-project-child-trow.is-selected")
      .forEach((el) => el.removeClass("is-selected"));
    rowEl?.addClass("is-selected");
  }

  /**
   * 日報など、ビューの外からその日のタスクをタイムラインで見せる。
   * その日へ移動し、対応するブロックを強調して画面内へスクロールする
   */
  revealTask(date: Date, task: Task): void {
    this.selectTask(date, task);
    this.setDate(date);
    if (this.isNarrow) this.setNarrowPane("timeline");
    this.revealSelectedTask();
  }

  /** パネルで選んだタスクの強調を解除する */
  private clearSelectedTask(): void {
    this.selectedTaskKey = null;
    this.pendingReveal = false;
    for (const el of this.taskEls.values()) el.removeClass("is-selected");
    this.inboxEl
      ?.querySelectorAll<HTMLElement>(".dt-project-child.is-selected, .dt-project-child-trow.is-selected")
      .forEach((el) => el.removeClass("is-selected"));
  }

  /**
   * 選択中のタスクのブロックが描画されていれば、タイムラインをスクロールして画面内に入れ、
   * 輪をまたたかせて目を引く。まだ描かれていなければ何もしない（reload の最後で改めて呼ばれる）
   */
  revealSelectedTask(): void {
    if (!this.pendingReveal || !this.selectedTaskKey) return;
    const el = this.taskEls.get(this.selectedTaskKey);
    if (!el) return;
    this.pendingReveal = false;
    this.scrollIntoTimeline(el);
    el.addClass("is-just-selected");
    el.addEventListener("animationend", () => el.removeClass("is-just-selected"), { once: true });
  }

  /**
   * タイムラインの要素が縦方向に見えるようスクロールする（すでに全体が見えていれば動かさない）。
   * 週・3日表示の固定ヘッダー（曜日・日付）の下に隠れないよう、その高さを上の余白に足す
   */
  private scrollIntoTimeline(el: HTMLElement): void {
    const sc = this.scrollEl;
    if (!sc || sc.clientHeight === 0) return; // まだ表示されていない
    const rect = el.getBoundingClientRect();
    const scRect = sc.getBoundingClientRect();
    const headerH = this.rows[0]?.headersEl.offsetHeight ?? 0;
    const margin = 16;
    const top = rect.top - scRect.top + sc.scrollTop; // スクロール領域の中での位置
    const bottom = top + rect.height;
    const viewTop = sc.scrollTop + headerH;
    const viewBottom = sc.scrollTop + sc.clientHeight;
    if (top >= viewTop + margin && bottom <= viewBottom - margin) return;
    const room = sc.clientHeight - headerH;
    // ブロックが見える範囲の上から 1/3 あたりに来るように（高すぎるブロックは上端を合わせる）
    const target =
      rect.height + margin * 2 >= room ? top - headerH - margin : top - headerH - (room - rect.height) / 3;
    sc.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
  }

  /**
   * プロジェクトノートをページプレビューのポップアップで表示する（Ctrl/Cmd + クリックから呼ぶ）。
   * ノートのタスク一覧やメモがその場で読める。ホバーでは出さない（名前の上を通るたびに
   * ノートが次々に出てくるのを避ける）。ポップアップはマウスが名前かポップアップの上にある間は残る。
   * 表示はコアプラグイン「ページプレビュー」が担う（クリックの MouseEvent に Ctrl/Cmd が付いているので、
   * 修飾キー付きで登録したソースの判定も通る）
   */
  showProjectPreview(targetEl: HTMLElement, linktext: string, e: MouseEvent): void {
    this.app.workspace.trigger("hover-link", {
      event: e,
      source: PROJECT_HOVER_SOURCE,
      hoverParent: this.projectHoverParent,
      targetEl,
      linktext,
    });
  }

  /**
   * パネルのプロジェクト名: Ctrl/Cmd + クリックでノートをプレビュー表示する。
   * 素のクリックは行に任せる（展開 / 閉じる）。修飾キー付きのときは行側のポインタ処理
   * （ドラッグ開始・離したときの展開）を始めないよう、pointerdown をここで止める
   */
  attachProjectNamePreview(el: HTMLElement, linktext: string): void {
    const isMod = (ev: MouseEvent) => ev.ctrlKey || ev.metaKey;
    el.addEventListener("pointerdown", (ev: PointerEvent) => {
      if (isMod(ev)) ev.stopPropagation();
    });
    el.addEventListener("click", (ev: MouseEvent) => {
      if (!isMod(ev)) return;
      ev.stopPropagation();
      this.showProjectPreview(el, linktext, ev);
    });
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
  async openTaskInNote(date: Date, task: Task): Promise<void> {
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

  minutesToPx(min: number): number {
    const s = this.plugin.settings;
    return ((min - s.startHour * 60) / 60) * this.hourHeightPx;
  }

  pxToMinutes(px: number): number {
    return (px / this.hourHeightPx) * 60;
  }

  /**
   * 縮尺が変わったときに、いま見えている時刻を保ったままグリッドを作り直す。
   * anchorClientY を渡すと、その画面位置（ポインタ位置）の時刻を動かさないように合わせる
   */
  rebuildTimeline(anchorClientY?: number): void {
    if (!this.scrollEl) return;
    const s = this.plugin.settings;
    // ポインタのある段（2週間表示）を覚えておき、作り直した後も同じ段で合わせる
    const anchorRow = anchorClientY != null ? this.rowAt(anchorClientY) : null;
    const rowIdx = anchorRow ? this.rows.indexOf(anchorRow) : 0;
    const anchor = anchorRow
      ? this.clientYToMinutes(anchorClientY!, anchorRow)
      : s.startHour * 60 + this.pxToMinutes(this.scrollEl.scrollTop);
    this.buildGrid();
    this.renderEvents();
    const rebuiltRow = this.rows[rowIdx];
    if (anchorRow && anchorClientY != null && rebuiltRow) {
      // 作り直しで scrollTop は 0 に戻っている。アンカーの時刻がポインタ位置に来る量だけずらす
      const rect = rebuiltRow.daysEl.getBoundingClientRect();
      this.scrollEl.scrollTop += rect.top + this.minutesToPx(anchor) - anchorClientY;
    } else if (!this.shouldScroll) {
      this.scrollEl.scrollTop = Math.max(0, this.minutesToPx(anchor));
    }
  }

  /** 縮尺（1時間あたりの高さ）を既定値に戻す（Ctrl+ホイール / ピンチで変えたぶんを取り消す） */
  private resetZoom(): void {
    const s = this.plugin.settings;
    if (s.hourHeight === DEFAULT_SETTINGS.hourHeight) return;
    s.hourHeight = DEFAULT_SETTINGS.hourHeight;
    void this.plugin.persistSettings();
    this.renderHeader();
    this.rebuildTimeline();
  }

  /** 画面の Y 座標を、その段の時間軸での時刻（分）にする */
  clientYToMinutes(clientY: number, row: TimelineRow): number {
    const s = this.plugin.settings;
    const rect = row.daysEl.getBoundingClientRect();
    const min = s.startHour * 60 + this.pxToMinutes(clientY - rect.top);
    return clamp(min, s.startHour * 60, s.endHour * 60);
  }

  /** ポインタの Y 座標から、どの段の上にいるかを返す（段の外なら一番近い段。1段だけならその段） */
  private rowAt(clientY: number): TimelineRow | null {
    if (!this.rows.length) return null;
    if (this.rows.length === 1) return this.rows[0];
    let best: TimelineRow | null = null;
    let bestDist = Infinity;
    for (const row of this.rows) {
      const r = row.daysEl.getBoundingClientRect();
      if (clientY >= r.top && clientY <= r.bottom) return row;
      const d = clientY < r.top ? r.top - clientY : clientY - r.bottom;
      if (d < bestDist) {
        bestDist = d;
        best = row;
      }
    }
    return best;
  }

  /**
   * ポインタの位置から、どの日の列の上にいるかを返す（列の外なら一番近い列）。
   * 2週間表示では先に Y 座標で段を選び、その段の中で X 座標から列を選ぶ
   */
  columnAt(clientX: number, clientY: number): DayColumn | null {
    const row = this.rowAt(clientY);
    if (!row) return null;
    let best: DayColumn | null = null;
    let bestDist = Infinity;
    for (const col of row.columns) {
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

  /** ポインタがどれかの段の日の列の上にあるか */
  overGrid(ev: PointerEvent): boolean {
    return this.rows.some((row) => {
      const r = row.daysEl.getBoundingClientRect();
      return ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
    });
  }

  snapFloor(min: number): number {
    const snap = this.plugin.settings.snapMinutes;
    return Math.floor(min / snap) * snap;
  }

  snapRound(min: number): number {
    const snap = this.plugin.settings.snapMinutes;
    return Math.round(min / snap) * snap;
  }

  // ---------- 操作 ----------

  /** チケットの URL（設定に無ければ null） */
  ticketUrlOf(task: Task): string | null {
    if (!task.ticket) return null;
    return ticketUrl(this.plugin.settings.trackers, task.ticket.tracker, task.ticket.id);
  }

  /** タイムライン上に出すタイトル（タグは色で分かるので文字としては出さない） */
  displayTitle(task: Task): string {
    return stripTags(task.title) || "(無題)";
  }

  // ---------- 保存 ----------

  private openDatePicker(): void {
    const input = this.dateInputEl as HTMLInputElement & { showPicker?: () => void };
    try {
      if (typeof input.showPicker === "function") input.showPicker();
      else input.focus();
    } catch (_e) {
      input.focus();
    }
  }

  async openNote(date: Date): Promise<void> {
    try {
      const file = await this.plugin.store.ensureFile(date);
      await this.app.workspace.getLeaf("tab").openFile(file);
    } catch (e) {
      console.error(e);
      new Notice("ノートを開けませんでした: " + String(e));
    }
  }
}

// 責務ごとに分けたメソッド群を 1 つのクラスに合成する（TypeScript のミックスイン）。
// 実行時のオブジェクトは 1 つのままなので、各ファイルのメソッドは this でビューの状態にそのまま触れる。
// 型の上では、この interface の宣言マージで各ミックスインのメソッドがビューのメンバーになる
export interface DayTimelineView extends SidebarMixin, PointerMixin, ActionsMixin {}
applyMixins(DayTimelineView, [SidebarMixin, PointerMixin, ActionsMixin]);
