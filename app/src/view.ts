import {
  ItemView,
  MarkdownRenderer,
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
  type HoverParent,
  type HoverPopover,
} from "obsidian";
import type DayTimelinePlugin from "./main";
import { ScheduledTask, Task, TaskDraft, TaskSource, isScheduled, stepProgress } from "./model";
import {
  ConfirmModal,
  PromptModal,
  RemainingStepsModal,
  RetrospectiveModal,
  TaskModal,
  formatActualRanges,
  type OtherActual,
  type RetroExtraField,
} from "./modal";
import { subtractActualRanges, type ActualRange, type TaskStep, type TicketRef } from "./markdown/blocks";
import {
  groupProjects,
  isChildSettled,
  knownGroupNames,
  projectDisplayName,
  renderGroupIcon,
  type ProjectChild,
  type ProjectDoc,
  type ProjectFields,
  type ProjectGroup,
  type ProjectSummary,
} from "./project";
import { newBlockId } from "./markdown/id";
import { iconName } from "./icons";
import { DropdownMenu, type MenuLike } from "./dropdown";
import { layoutEvents, type LayoutInfo } from "./layout";
import {
  colorForTags,
  normalizeFieldLabel,
  placeholderFor,
  schemaForTags,
  ticketUrl,
  MAX_HOUR_HEIGHT,
  MIN_HOUR_HEIGHT,
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
  extractTags,
} from "./util";

export const VIEW_TYPE_DAY_TIMELINE = "day-timeline-planner-view";

/** プロジェクト名のノートプレビューの hover-link ソース ID。
 * ホバーではなく Ctrl/Cmd + クリックで出す（showProjectPreview）。表示自体はコアプラグイン
 * 「ページプレビュー」に任せるため、hover-link のソースとして登録しておく */
export const PROJECT_HOVER_SOURCE = "day-timeline-planner-project";

/** プロジェクトノートのプレビューのポップアップに付けるクラス（styles.css で通常のプレビューより大きく表示する） */
const PROJECT_PREVIEW_CLASS = "dt-project-preview";

/**
 * プロジェクト名のプレビュー用の hover-link の親（HoverParent）。
 * ページプレビューはポップアップ（HoverPopover）を作るとき親の hoverPopover に代入してくるので、
 * そのタイミングでポップアップの要素にクラスを付け、CSS で通常のプレビューより大きく表示する。
 * タスクブロックのプレビュー（親はビュー自身）とは分けているので、そちらの大きさは変わらない。
 */
class ProjectHoverParent implements HoverParent {
  private popover: HoverPopover | null = null;

  get hoverPopover(): HoverPopover | null {
    return this.popover;
  }

  set hoverPopover(popover: HoverPopover | null) {
    this.popover = popover;
    if (!popover) return;
    // hoverEl はポップアップのコンストラクタ内で作られる。代入のほうが先に来ても拾えるよう、無ければ直後にもう一度試す
    const tag = () => popover.hoverEl?.addClass(PROJECT_PREVIEW_CLASS);
    if (popover.hoverEl) tag();
    else queueMicrotask(tag);
  }
}

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

/** 残件の持ち越し先: 翌日 / 当日（同じノートに続きを作る） / Inbox */
type CarryDest = "next-day" | "same-day" | "inbox";

/** ビューの幅（px）がこれ未満なら「狭い画面」（スマホなど）。
 * サイドバーとタイムラインを並べると共倒れになるので、片方だけを全面に出して切り替える */
const NARROW_VIEW_WIDTH = 500;

/** サイドバー（Inbox・プロジェクト）の幅の下限（px） */
const SIDEBAR_MIN_WIDTH = 160;
/** サイドバーの幅の上限（px）。実際の上限はビューの幅からも決まる（maxSidebarWidth） */
const SIDEBAR_MAX_WIDTH = 800;

/** プロジェクトのテーブル表示の列数（名前・期日・進捗・予定・実績） */
const PROJECT_TABLE_COLS = 6;

/** 本日のサマリーのバーをタスクごとに区切る上限。これより多いと区切り線だけになるので1本の棒にする */
const MAX_SUMMARY_SEGMENTS = 40;

/** タッチでこれ以上（px）動いたら「タップ・長押し」ではなくスクロール等とみなす */
const TOUCH_SLOP = 10;
/** タッチの長押し（ここからドラッグ）と判定するまでの時間（ms）。
 * Android が contextmenu を発火する長押し（約 500ms）より先に確定させる */
const LONG_PRESS_MS = 350;
/** 横スワイプで前後の日へ移動するのに必要な移動量（px） */
const SWIPE_MIN_X = 48;

/** Ctrl+ホイールのズーム感度。1ノッチ（deltaY=100）で約 1.16 倍になる */
const WHEEL_ZOOM_INTENSITY = 0.0015;

/** 狭い画面で全面に出す面 */
type NarrowPane = "timeline" | "panel";

/** 表示モードの並び順と、セグメント用の短いラベル・メニュー用のラベル */
const VIEW_MODES: [ViewMode, string, string][] = [
  ["day", "日", "日表示"],
  ["3day", "3日", "3日表示"],
  ["week", "週", "週表示"],
  ["month", "月", "月表示"],
];

export class DayTimelineView extends ItemView {
  private plugin: DayTimelinePlugin;
  /** 基準日。日表示ではこの日、週表示ではこの日を含む週を表示する */
  private date: Date = startOfDay(new Date());
  /** 日付が変わったのを見つけるための「今日」。30 秒ごとの更新で見比べる */
  private todayKey: string = dateKey(startOfDay(new Date()));
  private mode: ViewMode;
  private columns: DayColumn[] = [];
  private data = new Map<string, DayData>();

  private dateLabelEl!: HTMLElement;
  private dateInputEl!: HTMLInputElement;
  /** 「今日」ボタン。今日が画面に映っている間は隠す */
  private todayBtnEl!: HTMLElement;
  /** 「今日」ボタンのアイコン版（狭い画面）に入れる今日の日付の数字 */
  private todayNumEl!: HTMLElement;
  /** 狭い画面でモードのセグメントの代わりに出すアイコンボタン */
  private modeMenuBtnEl!: HTMLElement;
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
  /** 表示範囲の外（今日から過去 RESCHEDULE_LOOKBACK_DAYS 日以内）のノートのタスク（日付キー → その日）。
   * 再スケジュール欄の取り残しと、本日のサマリー（今日が表示範囲外のとき・連続達成・今週のグラフ）に使う */
  private pastDays = new Map<string, { date: Date; tasks: Task[] }>();
  /** 表示範囲の外（過去）に取り残された時刻なしタスク（再スケジュール欄用。pastDays から作る） */
  private pastUnscheduled: { date: Date; tasks: Task[] }[] = [];
  /** サイドバーの下の「本日のサマリー」の器。出していないときは null */
  private summaryEl: HTMLElement | null = null;
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
  private selectedTaskKey: string | null = null;
  /** 選んだブロックをまだ画面内へスクロールしていない（表示範囲が変わって読み込みを待っているときなど） */
  private pendingReveal = false;
  /** プロジェクト名のプレビューの hover-link の親（ポップアップを大きく表示するためのクラス付け用） */
  private readonly projectHoverParent = new ProjectHoverParent();

  /** ドラッグ操作中は再描画しない */
  private interacting = false;
  /** タッチの長押しから始まったドラッグ中（contextmenu を抑止する） */
  private touchDragging = false;
  /** タッチで空き時間をタップしたときに出す「＋ 追加」チップ */
  private touchChipEl: HTMLElement | null = null;
  /** 直前の pointerdown がタッチの空き時間タップだったか（canvas の click で消費する） */
  private canvasTapArmed = false;
  private pendingReload = false;
  private shouldScroll = true;
  private reloadDebounced: () => void;
  private syncCursorDebounced: () => void;
  /** ズーム（Ctrl+ホイール・タッチのピンチ）: フレームごとにまとめて反映するための適用待ちの倍率と位置 */
  private pendingZoomFactor = 1;
  private pendingZoomClientY = 0;
  private pendingZoomRaf: number | null = null;
  /** タッチの2本指ピンチでズーム中（タップ・長押し・スワイプを抑止する） */
  private pinchZooming = false;
  /** ホイールの1ノッチごとに設定ファイルへ書かないよう、保存はまとめて行う */
  private persistZoomDebounced: () => void;

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
    this.closeMemoPopover();
    DropdownMenu.closeAll();
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
    this.renderPaneToggle();
    // 狭い画面では日付ラベルとチップの文言を短くする（renderHeader / renderTracking / renderTimer）
    if (this.dateLabelEl) this.renderHeader(); // 中で renderTracking も呼ばれる
    else this.renderTracking();
    this.renderTimer();
  }

  /** タイムラインとツリー（パネル）のアイコンを親に並べる。アクティブ表示は呼び出し側で付ける */
  private buildPaneSegmentButtons(parent: HTMLElement): { timeline: HTMLElement; panel: HTMLElement } {
    const timeline = this.iconButton(parent, "calendar-clock", "タイムラインを表示", () =>
      this.setNarrowPane("timeline")
    );
    const panel = this.iconButton(
      parent,
      "list-tree",
      "パネル（Inbox・プロジェクト・再スケジュール）を表示",
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
    // タイマーは動作中だけチップを出す（開始は ⋮ メニューの「タイマー…」から）
    this.timerEl = bar.createEl("button", { cls: "dt-timer-chip", attr: { "aria-label": "タイマー" } });
    this.timerEl.onclick = () => this.plugin.openTimerModal();
    this.renderTimer();
    this.register(this.plugin.timer.onChange(() => this.renderTimer()));

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
      attr: { "aria-label": "表示の単位を選ぶ（日・3日・週・月）" },
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
    this.menuButton(bar, "メニュー（表示・ノート・タイマー・定期タスク）", (menu) =>
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
   * タッチの横スワイプで前後の日（3日・週・月）へ移動する（Google カレンダー方式）。
   * 縦のスクロールはブラウザに任せ（CSS の touch-action: pan-y）、横方向だけをここで拾う。
   * 以前は横スワイプが「空き時間のドラッグ」と解釈されてタスク作成ダイアログが開いてしまっていた
   */
  private attachSwipeNavigation(): void {
    this.scrollEl.addEventListener(
      "pointerdown",
      (e: PointerEvent) => {
        if (!this.isTouch(e) || !e.isPrimary) return;
        const sx = e.clientX;
        const sy = e.clientY;
        const id = e.pointerId;
        const cleanup = () => {
          document.removeEventListener("pointermove", onMove, true);
          document.removeEventListener("pointerup", onEnd, true);
          document.removeEventListener("pointercancel", onEnd, true);
        };
        const onMove = (ev: PointerEvent) => {
          if (ev.pointerId !== id) return;
          // 長押しから始まったドラッグ（タスク移動・範囲作成）中と2本指ピンチ中はスワイプしない
          if (this.interacting || this.pinchZooming) {
            cleanup();
            return;
          }
          const dx = ev.clientX - sx;
          const dy = ev.clientY - sy;
          // 縦方向が優勢ならスクロールに譲る
          if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > TOUCH_SLOP) {
            cleanup();
            return;
          }
          if (Math.abs(dx) >= SWIPE_MIN_X && Math.abs(dx) > Math.abs(dy) * 1.5) {
            cleanup();
            this.dismissTouchChip();
            if (dx < 0) this.goToNext();
            else this.goToPrev();
          }
        };
        const onEnd = (ev: PointerEvent) => {
          if (ev.pointerId !== id) return;
          cleanup();
        };
        document.addEventListener("pointermove", onMove, true);
        document.addEventListener("pointerup", onEnd, true);
        document.addEventListener("pointercancel", onEnd, true);
      },
      { capture: true }
    );

    // タイムライン内の横ジェスチャが Obsidian 本体（モバイルのサイドバー開閉）に
    // 取られてしまわないよう、横方向優勢の touchmove はここで止める
    let tsx = 0;
    let tsy = 0;
    this.scrollEl.addEventListener(
      "touchstart",
      (ev: TouchEvent) => {
        const t = ev.touches[0];
        if (!t) return;
        tsx = t.clientX;
        tsy = t.clientY;
      },
      { passive: true }
    );
    this.scrollEl.addEventListener(
      "touchmove",
      (ev: TouchEvent) => {
        const t = ev.touches[0];
        if (!t) return;
        if (Math.abs(t.clientX - tsx) > Math.abs(t.clientY - tsy)) ev.stopPropagation();
      },
      { passive: true }
    );
  }

  /**
   * Ctrl（macOS では Cmd でも可）＋ホイールで時間軸を拡大・縮小する。
   * トラックパッドのピンチも Chromium では ctrlKey 付きの wheel として届くので同じ経路になる。
   * Obsidian 本体の Ctrl+ホイール（UI 全体のズーム）に取られないよう、既定の動作と伝播を止める
   */
  private attachWheelZoom(): void {
    this.scrollEl.addEventListener(
      "wheel",
      (ev: WheelEvent) => {
        if (this.mode === "month") return; // 時間軸がないので既定の動作に任せる
        if (!ev.ctrlKey && !ev.metaKey) return;
        ev.preventDefault();
        ev.stopPropagation();
        if (this.interacting) return; // ドラッグ中に縮尺が変わると座標計算が狂う
        // deltaMode は 0=px / 1=行 / 2=ページ（Chromium は px だが念のため換算する）
        const dy = ev.deltaY * (ev.deltaMode === 1 ? 33 : ev.deltaMode === 2 ? 300 : 1);
        this.pendingZoomFactor *= Math.exp(-dy * WHEEL_ZOOM_INTENSITY);
        this.pendingZoomClientY = ev.clientY;
        this.schedulePendingZoom();
      },
      { passive: false }
    );
  }

  /**
   * タッチの2本指ピンチで時間軸を拡大・縮小する（モバイル向け。Google カレンダー方式）。
   * 指の間隔の変化を倍率にし、2本指の中間点の時刻を保ったまま縮尺を変える
   * （中間点が動けばその分だけ追従するので、ピンチしながらのスクロールも自然につながる）。
   *
   * 注意: ズームのたびにグリッドは作り直されるため、touchstart した要素はピンチの途中で
   * DOM から外れる。touch イベントは外れた後もその要素にだけ届き続け、scrollEl へは
   * バブルしなくなるので、move / end は開始時点の各タッチの target に直接付ける
   */
  private attachPinchZoom(): void {
    /** ピンチ中に move / end リスナを付けた要素（終了時に外す）。SVG（アイコン）上の
     * タッチもあり得るので HTMLElement に限らない */
    let attachedEls: GlobalEventHandlers[] = [];
    /** 直前のフレームでの2本指の間隔（px） */
    let lastDist = 0;

    const distOf = (ev: TouchEvent): number => {
      const a = ev.touches[0];
      const b = ev.touches[1];
      return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    };

    const detach = () => {
      for (const el of attachedEls) {
        el.removeEventListener("touchmove", onMove);
        el.removeEventListener("touchend", onEnd);
        el.removeEventListener("touchcancel", onEnd);
      }
      attachedEls = [];
    };

    const onMove = (ev: TouchEvent) => {
      if (!this.pinchZooming) return;
      if (ev.touches.length < 2) return;
      // ブラウザにスクロールを始めさせない（すでにスクロール中だと cancelable でないことがある）
      if (ev.cancelable) ev.preventDefault();
      ev.stopPropagation();
      const d = distOf(ev);
      if (lastDist > 0 && d > 0) {
        this.pendingZoomFactor *= d / lastDist;
        this.pendingZoomClientY = (ev.touches[0].clientY + ev.touches[1].clientY) / 2;
        this.schedulePendingZoom();
      }
      lastDist = d;
    };

    const onEnd = (ev: TouchEvent) => {
      if (!this.pinchZooming) return;
      if (ev.touches.length >= 2) {
        // 3本目以降の指が離れただけ。間隔を測り直して続ける（外れた指の分で跳ねないように）
        lastDist = distOf(ev);
        return;
      }
      this.pinchZooming = false;
      detach();
      // ピンチ後に残った指へブラウザが合成する click が、指の位置のタスクや空き時間に
      // 当たって編集・チップ表示が誤発動しないように握りつぶす
      this.swallowNextClick();
    };

    this.scrollEl.addEventListener(
      "touchstart",
      (ev: TouchEvent) => {
        if (ev.touches.length !== 2) return; // 2本目が置かれた瞬間だけ開始
        if (this.mode === "month" || this.interacting || this.pinchZooming) return;
        // ev.touches は画面全体のタッチ。1本目がパネルなどタイムラインの外にあるなら
        // ピンチにしない（パネルのスクロールを止めてしまわないように）
        for (let i = 0; i < ev.touches.length; i++) {
          const t = ev.touches[i].target;
          if (!(t instanceof Node) || !this.scrollEl.contains(t)) return;
        }
        this.pinchZooming = true;
        this.dismissTouchChip();
        this.canvasTapArmed = false;
        lastDist = distOf(ev);
        // 2本目の指でのネイティブ動作（スクロール開始・合成 click）を止める。
        // 1本目の touchstart は通常どおり通しているので、1本指のスクロールは妨げない
        if (ev.cancelable) ev.preventDefault();
        ev.stopPropagation();
        for (let i = 0; i < ev.touches.length; i++) {
          const t = ev.touches[i].target;
          const el: GlobalEventHandlers =
            t instanceof HTMLElement || t instanceof SVGElement ? t : this.scrollEl;
          if (attachedEls.includes(el)) continue;
          attachedEls.push(el);
          el.addEventListener("touchmove", onMove, { passive: false });
          el.addEventListener("touchend", onEnd);
          el.addEventListener("touchcancel", onEnd);
        }
      },
      { passive: false, capture: true }
    );
  }

  /** ためておいたズームぶんの反映を次のフレームに予約する（グリッドの作り直しは重いのでまとめる） */
  private schedulePendingZoom(): void {
    if (this.pendingZoomRaf != null) return;
    this.pendingZoomRaf = requestAnimationFrame(() => {
      this.pendingZoomRaf = null;
      this.applyPendingZoom();
    });
  }

  /** ためておいたホイール・ピンチぶんの拡大縮小を、ポインタ位置の時刻を保ったまま反映する */
  private applyPendingZoom(): void {
    const factor = this.pendingZoomFactor;
    this.pendingZoomFactor = 1;
    if (this.mode === "month" || !this.scrollEl?.isConnected) return;
    const s = this.plugin.settings;
    const next = clamp(this.hourHeightPx * factor, MIN_HOUR_HEIGHT, MAX_HOUR_HEIGHT);
    if (Math.abs(next - this.hourHeightPx) < 0.01) return; // 既に上限・下限
    // 手動ズームに入ったら「一度に表示する時間」(4h/8h/12h) は外し、「1時間の高さ」として記憶する。
    // 0.1px 単位に丸めるのは、トラックパッドの細かい delta でも値が進む（整数に丸めると止まる）ようにするため
    s.zoomHours = 0;
    s.hourHeight = Math.round(next * 10) / 10;
    this.persistZoomDebounced();
    this.rebuildTimeline(this.pendingZoomClientY);
  }

  /**
   * ⋮ メニューの「表示」まわり: ズーム・予定/実績・メンバーの表示切替。
   * 項目を1つでも足したら true（呼び出し側で区切り線を入れるかの判断に使う）
   */
  private buildViewMenu(menu: MenuLike): boolean {
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
    return !empty;
  }

  /** ツールバーの ⋮ メニュー: 表示オプション・ノート・タイマー・定期タスク */
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
  private menuButton(
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
      canvasEl.addEventListener("click", (e) => this.onCanvasClick(e, col));
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
      // 空きをクリック → その日にタスクを追加。
      // モバイルではタップでその日の日表示を開く（Google カレンダー方式。誤って作成しない）
      cell.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest(".dt-month-item, .dt-month-daynum, .dt-month-add")) return;
        if (Platform.isMobile) {
          this.date = startOfDay(date);
          this.setViewMode("day");
          return;
        }
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
      // 曜日と日付は1つのまとまりに（スマホでは横並びにして高さを節約する）
      const dateEl = el.createDiv("dt-day-header-date");
      dateEl.createSpan({ cls: "dt-day-header-dow", text: WEEKDAY_JA[dow] });
      dateEl.createSpan({ cls: "dt-day-header-num", text: String(col.date.getDate()) });
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
    // 表示範囲の外でも、再スケジュール欄・本日のサマリーが見ている過去のノートなら読み直す
    const blockStore = this.plugin.blockStore();
    if (blockStore && this.needsPastDays()) {
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
    const days = this.visibleDays();
    const a = moment(days[0]);
    const b = moment(days[days.length - 1]);
    // タイトルは「9月」のような月の見出し（TickTick 風）。見えている日々は真下の
    // 列ヘッダー（曜日 + 日付）に出ているので、ここでは範囲を繰り返さない。
    // 年は今年以外のときだけ添える（毎回読む情報ではない）。
    // 月をまたぐ週は、基準日ではなく「見えている範囲の真ん中の日」の月を出す
    //（8/30〜9/5 の週なら「9月」。TickTick と同じ見え方になる）
    const rep =
      this.mode === "month" || this.mode === "day" ? m : moment(days[Math.floor(days.length / 2)]);
    const thisYear = new Date().getFullYear();
    const needYear = rep.year() !== thisYear;
    const narrow = this.isNarrow;
    if (this.mode === "day") {
      // 日表示だけは列ヘッダーが1列で日付の並びが無いので、どの日かをタイトルで示す。
      // 曜日は真下の列ヘッダーに出ているので、1行に収める狭い画面では省く
      const ymd = needYear ? "YYYY年M月D日" : "M月D日";
      this.dateLabelEl.setText(m.format(narrow ? ymd : `${ymd} (ddd)`));
      this.dateLabelEl.setAttr("aria-label", `${m.format("YYYY年M月D日 (ddd)")}（日付を選ぶ）`);
    } else if (!narrow && this.mode !== "month" && a.month() !== b.month()) {
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
        this.mode === "month"
          ? `${m.format("YYYY年M月")}（日付を選ぶ）`
          : `${a.format("YYYY年M月D日")} 〜 ${b.format("YYYY年M月D日")}（日付を選ぶ）`
      );
    }
    // 今日が映っている間は「今日」を押す意味がないので隠し、そのぶんの幅をタイトルに回す。
    // 月表示は前後の月のマスにも今日が入りうるので、月そのものが今月かで見る
    const now = new Date();
    const showsToday =
      this.mode === "month"
        ? now.getFullYear() === this.date.getFullYear() && now.getMonth() === this.date.getMonth()
        : days.some((d) => isToday(d));
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

  /** ツールバーのタイマー表示（動作中だけ。開始は ⋮ メニューから） */
  private renderTimer(): void {
    if (!this.timerEl) return;
    const timer = this.plugin.timer;
    const st = timer.getState();
    if (st.endAt !== null) {
      const label = st.label && !this.isNarrow ? ` ${st.label}` : "";
      this.timerEl.setText(`⏱ ${formatSeconds(timer.remainingSeconds())}${label}`);
      this.timerEl.toggleClass("is-visible", true);
      this.timerEl.toggleClass("is-finished", false);
    } else if (st.finished) {
      this.timerEl.setText(`⏱ 終了${st.label && !this.isNarrow ? ` ${st.label}` : ""}`);
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
    // 本日のサマリーはタブの下に常に出す（タブが1つも無くても、これだけでパネルを出す）
    const showSummary = s.showTodaySummary && !!this.plugin.blockStore();
    const visible = showInbox || showProjects || showReschedule || showSummary;
    this.summaryEl = null;
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
    // 設定は書き換えないので、また出てきたら選んでいたタブに戻る。
    // タブが1つも無い（Inbox・プロジェクトを切っていて取り残しも無い）ときは null で、サマリーだけを出す
    const active = tabs.find((t) => t.id === s.sidebarTab) ?? tabs[0] ?? null;

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
      // 同じ切替セグメントをツールバーと同じ左端に出す（パネル側がアクティブ）。
      // 位置・大きさをそろえておくと、面を行き来しても指を動かさずに押せる
      const seg = head.createDiv("dt-pane");
      seg.addClass("is-available", "dt-inbox-toggle");
      const btns = this.buildPaneSegmentButtons(seg);
      btns.panel.addClass("is-active");
      btns.timeline.setAttr("aria-pressed", "false");
      btns.panel.setAttr("aria-pressed", "true");
    } else {
      const toggle = this.iconButton(
        head,
        collapsed ? "panel-left-open" : "panel-left-close",
        collapsed ? "パネルを開く" : "パネルを畳む",
        doToggle
      );
      toggle.addClass("dt-inbox-toggle");
    }
    const label = head.createSpan({ cls: "dt-inbox-label", text: active?.label ?? "本日のサマリー" });
    if (!narrowPanel) label.onclick = doToggle;
    if (active) head.createSpan({ cls: "dt-inbox-count", text: String(active.count) });
    // 狭い画面ではツールバーと同じ「左に切替と見出し、右に操作」の並びにそろえる
    if (narrowPanel) head.createDiv("dt-inbox-spacer");
    // 表示中のタブの操作ボタンだけをヘッダーに出す
    if (!active) {
      // サマリーだけのとき: 今日のノートを開くボタン
      const openBtn = this.iconButton(head, "file-text", "今日のノートを開く", () =>
        void this.openNote(startOfDay(new Date()))
      );
      openBtn.addClass("dt-inbox-open");
    } else if (active.id === "inbox") {
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
      const table = s.projectsViewStyle === "table";
      const styleBtn = this.iconButton(
        head,
        table ? "list-tree" : "table",
        table
          ? "ツリー表示に切り替え"
          : "テーブル表示に切り替え（期日・進捗・予定・実績を列で見る）",
        () => this.toggleProjectsViewStyle()
      );
      styleBtn.addClass("dt-inbox-open");
      const kebab = this.menuButton(head, "プロジェクトのメニュー", (menu) =>
        this.buildProjectsMenu(menu, activeProjects)
      );
      kebab.addClass("dt-inbox-add");
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
        el.toggleClass("is-active", tab.id === active?.id);
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

    if (!active) {
      /* サマリーだけ */
    } else if (active.id === "inbox") this.renderInboxList();
    else if (active.id === "projects") this.renderProjects(activeProjects);
    else this.renderReschedule(reschedule);

    // タブの中身の下に「本日のサマリー」。どのタブを見ていても今日の進み具合が見えるよう、タブの外に置く
    if (showSummary) {
      this.summaryEl = this.inboxEl.createDiv("dt-summary");
      this.renderSummary();
    }
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
      setIcon(box, iconName(t.done ? "check-square" : "square"));
      box.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.commitInboxUpdate(t, { ...this.draftOf(t), done: !t.done });
      });
      chip.createSpan({ cls: "dt-tray-title", text: this.displayTitle(t) });
      if (t.project) {
        // プロジェクトがパネルに出ていない（完了済み・見つからない）ため Inbox に出ているタスク
        const link = t.project;
        const badge = chip.createSpan({ cls: "dt-inbox-project", text: projectDisplayName(link) });
        // クリックでノートを開く。Ctrl/Cmd + クリックならポップアップでプレビュー
        badge.addEventListener("pointerdown", (ev) => ev.stopPropagation());
        badge.addEventListener("click", (ev) => {
          ev.stopPropagation();
          if (ev.ctrlKey || ev.metaKey) this.showProjectPreview(badge, link, ev);
          else void this.plugin.openProject(link);
        });
      }
      chip.setAttr("aria-label", [t.title, t.doneCondition ? `完了条件: ${t.doneCondition}` : "", t.preview].filter(Boolean).join("\n"));
      this.attachInboxInteractions(chip, t);
    }
  }

  /**
   * サイドバーの幅の上限。タイムラインが潰れないようビュー幅の6割までとしつつ、
   * デスクトップなど広い画面では最大 800px まで広げられる（狭い画面でも従来の 480px は保証）
   */
  private maxSidebarWidth(): number {
    const w = this.contentEl.clientWidth;
    if (!w) return SIDEBAR_MAX_WIDTH;
    return clamp(Math.round(w * 0.6), 480, SIDEBAR_MAX_WIDTH);
  }

  /** サイドバーの幅を反映する（null なら CSS の既定 = 畳んだ状態に任せる） */
  private applySidebarWidth(width: number | null): void {
    if (width === null) {
      this.inboxEl.style.width = "";
      this.inboxEl.style.flexBasis = "";
      return;
    }
    const w = clamp(width, SIDEBAR_MIN_WIDTH, this.maxSidebarWidth());
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
      const maxW = this.maxSidebarWidth();
      let w = startW;
      this.startDrag(grip, e, {
        onMove: (_dy, ev) => {
          w = clamp(startW + (ev.clientX - startX), SIDEBAR_MIN_WIDTH, maxW);
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

  /** プロジェクト一覧をツリー表示 ⇄ テーブル表示で切り替える（パネルのボタン・メニュー・コマンドから） */
  toggleProjectsViewStyle(): void {
    const s = this.plugin.settings;
    s.projectsViewStyle = s.projectsViewStyle === "table" ? "tree" : "table";
    void this.plugin.persistSettings();
    this.renderInbox();
  }

  /** プロジェクトのパネルのヘッダー（⋮）から開くメニュー。active は進行中のプロジェクト */
  private buildProjectsMenu(menu: MenuLike, active: ProjectSummary[]): void {
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
      const tableStyle = this.plugin.settings.projectsViewStyle === "table";
      menu.addItem((i) =>
        i
          .setTitle(tableStyle ? "ツリーで表示" : "テーブルで表示（期日・進捗・予実を列で）")
          .setIcon(tableStyle ? "list-tree" : "table")
          .onClick(() => this.toggleProjectsViewStyle())
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
    // どのプロジェクトにもグループが無ければ見出しなしの一覧。
    // 「フラットな一覧で表示」がオンのときも見出しを出さず、グループ順に並べたまま平らにする
    const showGroupHeads =
      groups.some((g) => g.name !== null) && !this.plugin.settings.projectsFlatList;
    if (this.plugin.settings.projectsViewStyle === "table") {
      this.renderProjectsTable(list, groups, showGroupHeads);
      return;
    }
    if (!showGroupHeads) {
      for (const g of groups) {
        for (const sum of g.items) this.renderProjectRow(list, sum);
      }
      return;
    }
    const groupIcons = this.groupIconMap();
    for (const g of groups) {
      if (this.renderProjectGroupHead(list, g, groupIcons)) continue;
      const itemsEl = list.createDiv("dt-project-group-items");
      for (const sum of g.items) this.renderProjectRow(itemsEl, sum);
    }
  }

  /** グループの見出し行（ツリー・テーブル共通）。開閉のクリックを設定し、畳まれているかを返す */
  private renderProjectGroupHead(
    parent: HTMLElement,
    g: ProjectGroup,
    groupIcons: Map<string, string>
  ): boolean {
    const groupKey = g.name ?? "";
    const collapsed = this.collapsedGroups.has(groupKey);
    const groupHead = parent.createDiv("dt-project-group");
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
    return collapsed;
  }

  /**
   * プロジェクトのテーブル表示: 期日・進捗・予定・実績を列に並べ、広いサイドバーで見比べられる。
   * 行の操作（クリックで展開・タイムラインへドラッグで子タスク作成・右クリックメニュー）はツリーと同じ。
   * 列が収まらない幅では横にスクロールできる
   */
  private renderProjectsTable(
    list: HTMLElement,
    groups: ProjectGroup[],
    showGroupHeads: boolean
  ): void {
    list.addClass("is-table");
    const table = list.createEl("table", { cls: "dt-projects-table" });
    const headRow = table.createEl("thead").createEl("tr");
    headRow.createEl("th", { text: "プロジェクト", cls: "dt-ptc-name" });
    headRow.createEl("th", { text: "タグ", cls: "dt-ptc-tag" });
    headRow.createEl("th", { text: "期日", cls: "dt-ptc-due" });
    headRow.createEl("th", { text: "進捗", cls: "dt-ptc-num dt-ptc-progress" });
    headRow.createEl("th", { text: "予定", cls: "dt-ptc-num" });
    headRow.createEl("th", { text: "実績", cls: "dt-ptc-num" });
    const body = table.createEl("tbody");
    const groupIcons = this.groupIconMap();
    for (const g of groups) {
      if (showGroupHeads) {
        const tr = body.createEl("tr", { cls: "dt-project-group-trow" });
        const td = tr.createEl("td", { attr: { colspan: String(PROJECT_TABLE_COLS) } });
        if (this.renderProjectGroupHead(td, g, groupIcons)) continue;
      }
      for (const sum of g.items) this.renderProjectTableRow(body, sum);
    }
  }

  /** テーブル表示のプロジェクト1件分（行 + 展開時の子タスク行） */
  private renderProjectTableRow(body: HTMLElement, sum: ProjectSummary): void {
    const expanded = this.expandedProjects.has(sum.ref.linktext);
    const tr = body.createEl("tr", { cls: "dt-project-trow" });
    tr.toggleClass("is-expanded", expanded);
    const nameTd = tr.createEl("td", { cls: "dt-ptc-name" });
    const nameWrap = nameTd.createDiv("dt-ptc-name-wrap");
    const chev = nameWrap.createDiv("dt-project-chevron");
    setIcon(chev, expanded ? "chevron-down" : "chevron-right");
    const nameEl = nameWrap.createSpan({ cls: "dt-project-name", text: sum.ref.name });
    // 名前を Ctrl/Cmd + クリックするとプロジェクトノートをプレビュー表示
    this.attachProjectNamePreview(nameEl, sum.ref.linktext);
    const fields = sum.fields;
    if (fields?.ticket) this.renderProjectTicketBadge(nameWrap, fields.ticket);
    tr.createEl("td", { cls: "dt-ptc-tag" }); // タグの列はタスクの行だけ
    const dueTd = tr.createEl("td", { cls: "dt-ptc-due" });
    if (fields?.due) {
      const dueEl = dueTd.createSpan({ cls: "dt-project-due", text: this.projectDueLabel(fields) });
      if (this.projectDueIsOverdue(fields)) dueEl.addClass("is-overdue");
    }
    // 進捗の列はタスクの行だけに出す（プロジェクトの件数は行が見づらくなるため出さない。
    // 件数はツリー表示・プロジェクトノートのタスク一覧で見られる）
    tr.createEl("td", { cls: "dt-ptc-num dt-ptc-progress" });
    tr.createEl("td", { cls: "dt-ptc-num", text: hmm(sum.planMin) });
    tr.createEl("td", { cls: "dt-ptc-num", text: hmm(sum.actMin) });
    // 操作（ノートを開く・タスクを追加・完了にする）は行のアイコンではなく右クリックメニューから
    this.attachProjectRowBehavior(tr, chev, sum);

    if (!expanded) return;
    const detailCell = (): HTMLElement =>
      body
        .createEl("tr", { cls: "dt-project-detail-trow" })
        .createEl("td", { attr: { colspan: String(PROJECT_TABLE_COLS) } });
    if (fields?.docs.length) this.renderProjectDocs(detailCell(), sum, fields.docs);
    const shown = this.visibleProjectChildren(sum);
    if (!sum.children.length) {
      detailCell().createSpan({ cls: "dt-tray-empty", text: "結びついたタスクはまだありません" });
    } else if (!shown.length) {
      detailCell().createSpan({
        cls: "dt-tray-empty",
        text: `完了済み ${sum.children.length} 件を非表示`,
      });
    }
    for (const child of shown) this.renderProjectChildTableRow(body, child);
  }

  /** テーブル表示の子タスク1行（日付・予定・実績を親と同じ列に揃える） */
  private renderProjectChildTableRow(body: HTMLElement, child: ProjectChild): void {
    const t = child.task;
    const tr = body.createEl("tr", { cls: "dt-project-child-trow" });
    // 持ち越し先で完了した [>] も完了として見せる（引き継いだ先で終わった仕事）
    tr.toggleClass("is-done", isChildSettled(child));
    const wrap = tr.createEl("td", { cls: "dt-ptc-name" }).createDiv("dt-ptc-child");
    this.renderChildCheckbox(wrap, child);
    wrap.createSpan({ cls: "dt-tray-title", text: this.displayTitle(t) });
    this.renderChildTagBadge(tr.createEl("td", { cls: "dt-ptc-tag" }), t);
    // 期日の列: タスクは「本日（青）」「未定（オレンジ）」の印だけ。日付そのものは行のツールチップで
    this.renderChildDateDot(tr.createEl("td", { cls: "dt-ptc-due" }), child);
    // 進捗の列: ステップが記録されたタスクだけ、消化率をバーと % で見せる（無ければ空のまま）
    this.renderStepProgressBar(tr.createEl("td", { cls: "dt-ptc-num dt-ptc-progress" }), t);
    const plan = t.start !== null && t.end !== null ? t.end - t.start : 0;
    const act = t.actual.reduce((n, r) => n + (r.end - r.start), 0);
    tr.createEl("td", { cls: "dt-ptc-num", text: hmm(plan) });
    tr.createEl("td", { cls: "dt-ptc-num", text: hmm(act) });
    this.attachProjectChildBehavior(tr, child);
  }

  /** プロジェクト1件分（行 + 展開時の子タスク一覧）をツリー表示のパネルへ描画する */
  private renderProjectRow(container: HTMLElement, sum: ProjectSummary): void {
    const expanded = this.expandedProjects.has(sum.ref.linktext);

    const row = container.createDiv("dt-project-row");
    const chev = row.createDiv("dt-project-chevron");
    setIcon(chev, expanded ? "chevron-down" : "chevron-right");
    const nameEl = row.createSpan({ cls: "dt-project-name", text: sum.ref.name });
    // 名前を Ctrl/Cmd + クリックするとプロジェクトノートをプレビュー表示
    this.attachProjectNamePreview(nameEl, sum.ref.linktext);
    const total = sum.children.length;
    // プロジェクト自身の期日・チケット（ノートの「- 期日: 」「- チケット: 」行）
    const fields = sum.fields;
    if (fields?.due) {
      const dueEl = row.createSpan({
        cls: "dt-project-due",
        text: `期日 ${this.projectDueLabel(fields)}`,
      });
      if (this.projectDueIsOverdue(fields)) dueEl.addClass("is-overdue");
    }
    if (fields?.ticket) this.renderProjectTicketBadge(row, fields.ticket);
    const stats = row.createSpan({ cls: "dt-project-stats" });
    // 予実の合計は行が見づらくなるため出さない（テーブル表示・プロジェクトノートのタスク一覧・予実レポートで見られる）
    stats.setText(total ? `${sum.doneCount}/${total}` : "タスクなし");
    if (total) stats.setAttr("aria-label", `予 ${hmm(sum.planMin)}・実 ${hmm(sum.actMin)}`);
    // 行のホバー時のツールチップは情報量が多すぎたため、いったん出さない
    // 操作（ノートを開く・タスクを追加・完了にする）は行のアイコンではなく右クリックメニューから
    this.attachProjectRowBehavior(row, chev, sum);

    if (!expanded) return;
    const childrenEl = container.createDiv("dt-project-children");
    // プロジェクトのドキュメント（ノートの「- ドキュメント: [[...]]」行）を子タスクの上に並べる
    if (fields?.docs.length) this.renderProjectDocs(childrenEl, sum, fields.docs);
    const shown = this.visibleProjectChildren(sum);
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
      // 持ち越し先で完了した [>] も完了として見せる（引き継いだ先で終わった仕事）
      item.toggleClass("is-done", isChildSettled(child));
      this.renderChildCheckbox(item, child);
      this.renderChildDateBadge(item, child);
      item.createSpan({ cls: "dt-tray-title", text: this.displayTitle(t) });
      this.renderChildTagBadge(item, t);
      // 予定・実績の時間は行には出さない（ツリーが見づらくなるため）。ツールチップとテーブル表示で見られる
      this.attachProjectChildBehavior(item, child);
    }
  }

  /**
   * 子タスクのタグのバッジ（設定「タグの色」に登録されたタグだけ。サブタグがあればそちら）。
   * タイムラインの色と同じ色の枠と左の帯で、どの種類の作業かがパネルでも分かる
   */
  private renderChildTagBadge(parent: HTMLElement, t: Task): void {
    const rules = this.plugin.settings.tagColors;
    const known = t.tags.filter((tag) => colorForTags([tag], rules));
    if (!known.length) return;
    // 最も深いタグ（#管理/質問 が付いていれば #管理 より優先）
    const tag = known.reduce((a, b) => (b.split("/").length > a.split("/").length ? b : a));
    const color = colorForTags([tag], rules) ?? "";
    const badge = parent.createSpan({ cls: "dt-project-child-tag", text: "#" + tag, attr: { title: "#" + tag } });
    badge.style.setProperty("--dt-chip-color", color);
  }

  /**
   * テーブル表示の「進捗」セル: タスクのステップの消化率をバーと % で出す。
   * ステップが記録されていないタスクは空のまま（件数は出さない）
   */
  private renderStepProgressBar(td: HTMLElement, t: Task): void {
    const sp = stepProgress(t);
    if (!sp) return;
    const pct = Math.round(sp.ratio * 100);
    const wrap = td.createDiv("dt-progress");
    wrap.toggleClass("is-complete", sp.done >= sp.total);
    const bar = wrap.createDiv("dt-progress-bar");
    bar.createDiv("dt-progress-fill").style.width = `${pct}%`;
    wrap.createSpan({ cls: "dt-progress-text", text: `${pct}%` });
    td.setAttr("aria-label", `ステップ ${sp.done}/${sp.total} 完了（${pct}%）`);
  }

  /** プロジェクトの期日の表示文字列（日付として読めれば M/D、年が違えば YYYY/M/D、読めなければ書かれたまま） */
  private projectDueLabel(fields: ProjectFields): string {
    return fields.dueDate
      ? moment(fields.dueDate).format(
          moment(fields.dueDate).year() === moment().year() ? "M/D" : "YYYY/M/D"
        )
      : fields.due;
  }

  /** プロジェクトの期日が過ぎているか */
  private projectDueIsOverdue(fields: ProjectFields): boolean {
    return !!fields.dueDate && fields.dueDate.getTime() < startOfDay(new Date()).getTime();
  }

  /** プロジェクトのチケットバッジ（クリックでブラウザで開く） */
  private renderProjectTicketBadge(parent: HTMLElement, t: TicketRef): void {
    const badge = parent.createSpan({ cls: "dt-project-ticket", text: `#${t.id}` });
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

  /** プロジェクトを完了にする（右クリックメニューから。未完了のタスクが残っていれば確認する）。パネルから消える */
  private completeProject(sum: ProjectSummary): void {
    const projects = this.plugin.projects;
    if (!projects) return;
    const key = sum.ref.linktext;
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
  }

  /** プロジェクト行のふるまい（クリックで展開・ドラッグで子タスク作成・右クリックメニュー）。ツリー・テーブル共通 */
  private attachProjectRowBehavior(row: HTMLElement, chev: HTMLElement, sum: ProjectSummary): void {
    const key = sum.ref.linktext;
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
      if (this.touchDragging) return;
      this.showProjectMenu(sum, e);
    });
  }

  /** プロジェクトのドキュメントのチップを並べる。ツリー・テーブル共通 */
  private renderProjectDocs(parent: HTMLElement, sum: ProjectSummary, docs: ProjectDoc[]): void {
    const docsEl = parent.createDiv("dt-project-docs");
    for (const doc of docs) {
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

  /** 展開時に見せる子タスク。「完了済みを隠す」がオンなら、完了・持ち越し済み [>]（＝片付いた記録）を出さない */
  private visibleProjectChildren(sum: ProjectSummary): ProjectChild[] {
    return this.plugin.settings.projectsHideDone
      ? sum.children.filter((c) => !c.task.done && !c.task.forwarded)
      : sum.children;
  }

  /** 子タスクの完了チェックボックス。ツリー・テーブル共通 */
  private renderChildCheckbox(parent: HTMLElement, child: ProjectChild): void {
    const t = child.task;
    const box = parent.createDiv("dt-tray-check");
    if (child.settledByCarry) {
      // 持ち越し先で完了した [>]: チェック済みに見せるが、このブロック自体は「引き継いだ記録」なので
      // ここからは切り替えない（外すなら持ち越し先のほうを未完了に戻す）
      setIcon(box, iconName("check-square"));
      box.addClass("is-settled-by-carry");
      box.setAttr("aria-label", "持ち越し先で完了しています（このブロックは引き継ぎ前の記録）");
      box.addEventListener("click", (e) => {
        e.stopPropagation();
        new Notice("持ち越し先のタスクで完了しています。戻すときは持ち越し先のほうを未完了にしてください");
      });
      return;
    }
    setIcon(box, iconName(t.done ? "check-square" : "square"));
    box.addEventListener("click", (e) => {
      e.stopPropagation();
      if (child.date === null) void this.commitInboxUpdate(t, { ...this.draftOf(t), done: !t.done });
      else void this.commitUpdate(child.date, t, { ...this.draftOf(t), done: !t.done });
    });
  }

  /**
   * 子タスクの日付バッジ。今日のタスクは「本日」、日付未定は「未定」のバッジにする。
   * 日時が決まっていないものは枠付きのバッジで見分ける（日付ごと未定はアクセント色・時刻未定はオレンジ）
   */
  private renderChildDateBadge(parent: HTMLElement, child: ProjectChild): void {
    const t = child.task;
    const today = !!child.date && isToday(child.date);
    const dateEl = parent.createSpan({
      cls: "dt-project-child-date",
      text: child.date
        ? today
          ? "本日"
          : `${child.date.getMonth() + 1}/${child.date.getDate()}`
        : "未定",
    });
    const scheduled = t.start !== null && t.end !== null;
    if (child.date === null) dateEl.addClass("is-undated");
    // 時刻未定（＝遅れ）は今日でもオレンジのまま。持ち越し済み [>] は閉じた記録なので「遅れ」扱いにしない
    else if (!scheduled && !t.forwarded) dateEl.addClass("is-unscheduled");
    else if (today) dateEl.addClass("is-today");
  }

  /**
   * テーブル表示の子タスクの期日セル: 今日のタスクは青の●、日付未定・時刻未定（＝遅れ）はオレンジの●。
   * それ以外の日付は出さない（一覧で見たいのは「今日やるか、まだ決めていないか」だけなので）
   */
  private renderChildDateDot(td: HTMLElement, child: ProjectChild): void {
    const t = child.task;
    const scheduled = t.start !== null && t.end !== null;
    const today = !!child.date && isToday(child.date);
    let cls = "";
    let label = "";
    if (child.date === null) {
      cls = "is-undated";
      label = "日付未定";
    } else if (!scheduled && !t.forwarded) {
      // 持ち越し済み [>] は閉じた記録なので「遅れ」の印は出さない
      cls = "is-unscheduled";
      label = `時刻未定（${child.date.getMonth() + 1}/${child.date.getDate()}）`;
    } else if (today) {
      cls = "is-today";
      label = "本日";
    }
    if (!cls) return;
    td.createSpan({ cls: "dt-project-child-dot " + cls, attr: { title: label, "aria-label": label } });
  }

  /** 子タスク行のふるまい（ツールチップ・ドラッグ・クリック・右クリックメニュー）。ツリー・テーブル共通 */
  private attachProjectChildBehavior(item: HTMLElement, child: ProjectChild): void {
    const t = child.task;
    const scheduled = t.start !== null && t.end !== null;
    const plan = scheduled ? t.end! - t.start! : 0;
    const act = t.actual.reduce((n, r) => n + (r.end - r.start), 0);
    const sp = stepProgress(t);
    item.setAttr(
      "aria-label",
      `${t.title || "(無題)"}\n` +
        (child.date
          ? moment(child.date).format("M月D日 (ddd)") +
            (scheduled ? ` ${minutesToHHMM(t.start!)} - ${minutesToHHMM(t.end!)}` : "（時刻は未定）")
          : "日付は未定") +
        (plan || act ? `\n実績 ${act ? hmm(act) : "–"} / 予定 ${plan ? hmm(plan) : "–"}` : "") +
        (sp ? `\nステップ ${sp.done}/${sp.total}（${Math.round(sp.ratio * 100)}%）` : "") +
        (child.settledByCarry
          ? "\n持ち越し先で完了（このブロックは引き継ぎ前の記録）"
          : t.forwarded
            ? "\n持ち越し済み（続きは持ち越し先のブロック）"
            : "") +
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
        if (this.touchDragging) return;
        this.showInboxTaskMenu(t, e);
      });
    } else {
      const childDate = child.date;
      // 選択中のタスクの行には印を付ける（パネルを描き直しても残る）
      item.toggleClass("is-selected", this.taskElKey(childDate, t) === this.selectedTaskKey);
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
          // その日へ移動し、タイムラインの対応するブロックを強調して画面内へスクロールする。
          // 表示範囲の外の日なら読み込みを待って reload の最後で反映する
          this.selectTask(childDate, t, item);
          this.setDate(childDate);
          // 狭い画面では移動した先が見えるよう、タイムラインへ切り替える
          if (this.isNarrow) this.setNarrowPane("timeline");
          this.revealSelectedTask();
        }
      );
      item.addEventListener("contextmenu", (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (this.touchDragging) return;
        this.showTaskMenu(childDate, t, e);
      });
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

  /** プロジェクト行の右クリックメニュー（ノートを開く・タスクを追加・チケット・ドキュメント・グループの付け替え・完了にする） */
  private showProjectMenu(sum: ProjectSummary, e: MouseEvent): void {
    if (!this.plugin.projects) return;
    const key = sum.ref.linktext;
    const menu = new Menu();
    // 行に操作アイコンは出さず、ここにまとめる（Ctrl/Cmd + クリックのプレビューは名前側）
    menu.addItem((i) =>
      i.setTitle("プロジェクトノートを開く").setIcon("arrow-up-right").onClick(() => void this.plugin.openProject(key))
    );
    menu.addItem((i) =>
      i
        .setTitle("このプロジェクトのタスクを追加")
        .setIcon("plus")
        .onClick(() => this.openProjectCreateModal(key))
    );
    menu.addSeparator();
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
    menu.addSeparator();
    menu.addItem((i) =>
      i.setTitle("プロジェクトを完了にする").setIcon("check-circle-2").onClick(() => this.completeProject(sum))
    );
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
    // タッチではタップ（＝ネイティブの click）で開き、長押ししてからドラッグ
    // （パネルのスクロールを妨げない）
    let touchTapArmed = false;
    chip.addEventListener("pointerdown", (e: PointerEvent) => {
      if (e.button !== 0) return;
      touchTapArmed = false;
      if ((e.target as HTMLElement).closest(ignoreSelector)) return;
      if (this.isTouch(e)) {
        touchTapArmed = true;
        this.touchGate(chip, e, {
          onLongPress: () => {
            touchTapArmed = false;
            chip.addClass("is-lifted");
            begin(e);
          },
        });
        return;
      }
      e.preventDefault();
      begin(e);
    });
    chip.addEventListener("click", (ce: MouseEvent) => {
      if (!touchTapArmed) return; // マウスのクリックは begin の onEnd(!moved) が扱う
      touchTapArmed = false;
      ce.stopPropagation();
      if (this.touchDragging) return;
      if ((ce.target as HTMLElement).closest(ignoreSelector)) return;
      onClick();
    });
    const begin = (e: PointerEvent) => {
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
          chip.removeClass("is-lifted");
          ghost?.remove();
          if (!moved) {
            if (this.isTouch(e)) this.swallowNextClick(); // 合成 click がダイアログに当たらないように
            onClick();
            return;
          }
          if (dropStart !== null && dropCol) {
            onDrop(dropCol.date, dropStart, Math.min(dropStart + duration, dayEnd));
          }
        },
        onCancel: () => {
          chip.removeClass("is-dragging");
          chip.removeClass("is-lifted");
          ghost?.remove();
        },
      });
    };
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

  /** 表示範囲の外の過去のノートを読む必要があるか（再スケジュール欄の取り残し・本日のサマリー） */
  private needsPastDays(): boolean {
    const s = this.plugin.settings;
    if (!this.plugin.blockStore()) return false;
    return (this.isTimeline() && s.showUnscheduledTray) || s.showTodaySummary;
  }

  /**
   * 表示範囲の外のノートを読む（再スケジュール欄の取り残し・本日のサマリー用）。
   * 今日から過去 RESCHEDULE_LOOKBACK_DAYS 日のノートを見る。表示中の日は通常の
   * 読み込みが拾うので除外。古い日付から順に入る
   */
  private async loadPastDays(): Promise<Map<string, { date: Date; tasks: Task[] }>> {
    const out = new Map<string, { date: Date; tasks: Task[] }>();
    const store = this.plugin.blockStore();
    if (!store || !this.needsPastDays()) return out;
    const visible = new Set(this.visibleDays().map(dateKey));
    const today = startOfDay(new Date());
    for (let i = RESCHEDULE_LOOKBACK_DAYS; i >= 0; i--) {
      const date = addDays(today, -i);
      const key = dateKey(date);
      if (visible.has(key)) continue;
      if (!store.getFile(date)) continue; // ノートの無い日は読まない
      try {
        out.set(key, { date, tasks: (await store.load(date)).tasks });
      } catch (e) {
        console.error(e);
      }
    }
    return out;
  }

  /** 表示範囲の外に取り残された時刻なしタスク（再スケジュール欄用）。
   * 完了・持ち越し済み [>] は「片付いた」ものなので出さない */
  private pastUnscheduledFrom(
    past: Map<string, { date: Date; tasks: Task[] }>
  ): { date: Date; tasks: Task[] }[] {
    const s = this.plugin.settings;
    if (!this.isTimeline() || !s.showUnscheduledTray) return [];
    const out: { date: Date; tasks: Task[] }[] = [];
    for (const { date, tasks: all } of past.values()) {
      const tasks = all.filter((t) => !isScheduled(t) && !t.done && !t.forwarded);
      if (tasks.length) out.push({ date, tasks });
    }
    return out;
  }

  // ---------- 本日のサマリー（サイドバーの下） ----------

  /** その日のタスク。表示範囲内なら読み込み済みのデータ、範囲外なら過去のノートのキャッシュから。
   * どちらにも無い（ノートが無い・過去 30 日より前で読んでいない）なら null */
  private tasksOn(date: Date): Task[] | null {
    const key = dateKey(date);
    const d = this.data.get(key);
    if (d) return d.tasks;
    return this.pastDays.get(key)?.tasks ?? null;
  }

  /**
   * 連続達成: 達成率が閾値以上の日が何日続いているか。
   * 今日は達成していれば数え、まだ届いていなくても途切れとは見なさない（まだ途中なので）。
   * タスクの無い日（休日など）は数えず飛ばす。読んでいる範囲（過去 30 日）で打ち切る
   */
  private summaryStreak(threshold: number): number {
    if (threshold <= 0) return 0;
    const today = startOfDay(new Date());
    let n = 0;
    for (let i = 0; i <= RESCHEDULE_LOOKBACK_DAYS; i++) {
      const tasks = this.tasksOn(addDays(today, -i));
      const ratio = tasks ? dayStats(tasks).ratio : null;
      if (ratio === null) continue;
      if (ratio >= threshold) n++;
      else if (i > 0) break;
    }
    return n;
  }

  /**
   * サイドバーの下の「本日のサマリー」。renderInbox で器（summaryEl）を作り、
   * 30 秒ごとの更新と計測の開始・終了（renderTracking）でも描き直す。
   * 見出しのクリックで1行に畳める（記憶される）
   */
  private renderSummary(): void {
    const el = this.summaryEl;
    if (!el) return;
    el.empty();
    const s = this.plugin.settings;
    const today = startOfDay(new Date());
    const all = this.tasksOn(today) ?? [];
    const st = dayStats(all);
    // ステップの消化（今日の自分のタスクに書かれた「- [ ] …」の合計）。タスク数だけだと
    // 「1タスクの中でどこまで進んだか」が見えないので、タスクと並べて出す
    const steps = stepStats(all);
    const collapsed = s.summaryCollapsed;
    const complete = st.total > 0 && st.done === st.total;
    el.toggleClass("is-collapsed", collapsed);
    el.toggleClass("is-complete", complete);

    // 見出し: 「本日 9/2 (水)」。右端は達成の一言（畳んだときは数字だけ）
    const head = el.createDiv("dt-summary-head");
    head.setAttr("aria-label", collapsed ? "クリックで開く" : "クリックで畳む");
    head.createSpan({ cls: "dt-summary-title", text: "本日" });
    head.createSpan({
      cls: "dt-summary-date",
      text: `${today.getMonth() + 1}/${today.getDate()} (${WEEKDAY_JA[today.getDay()]})`,
    });
    const pct = st.ratio === null ? 0 : Math.round(st.ratio * 100);
    head.createSpan({
      cls: "dt-summary-brief",
      text: collapsed
        ? st.total
          ? `タスク ${st.done}/${st.total}` +
            (steps.total ? ` · ステップ ${steps.done}/${steps.total}` : "") +
            `・${pct}%`
          : "タスクなし"
        : summaryMessage(st),
    });
    const chevron = head.createSpan("dt-summary-chevron");
    setIcon(chevron, collapsed ? "chevron-up" : "chevron-down");
    head.addEventListener("click", () => {
      s.summaryCollapsed = !s.summaryCollapsed;
      void this.plugin.persistSettings();
      this.renderSummary();
    });
    if (collapsed) return;

    const body = el.createDiv("dt-summary-body");
    if (!st.total) {
      body.createDiv({
        cls: "dt-summary-empty",
        text: "今日のタスクはまだありません。タイムラインの空き時間をクリックすると追加できます",
      });
    } else {
      // 件数と時間の2本のメーター。件数だけだと短いタスクを片付けたくなるので、
      // 予定時間ベース（完了したタスクの予定時間 / 今日の予定時間）も並べる。
      // バーはタスクごとに区切る（件数は等分、時間は予定の長さに比例）ので、1つのタスクの大きさが見える
      const mine = all.filter((t) => !t.owner).sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity));
      const own = mine.filter((t) => !t.forwarded);
      const segTip = (t: Task) =>
        [
          this.displayTitle(t),
          (isScheduled(t) ? `${minutesToHHMM(t.start)} - ${minutesToHHMM(t.end)}（${hmm(t.end - t.start)}）` : "時刻未定") +
            (t.done ? " · 完了" : ""),
        ].join("\n");
      this.summaryMeter(
        body,
        "タスク",
        own.map((t) => ({ weight: 1, done: t.done, tip: segTip(t) })),
        `${st.done}/${st.total}`,
        `完了 ${st.done} タスク / 全 ${st.total} タスク（持ち越し済み [>] のタスクは数えません）`
      );
      if (steps.total > 0) {
        // ステップ: タスクをまたいで1ステップ = 1区切り。区切りにマウスを乗せると「タスク名 / ステップ」
        //（持ち越し済み [>] のタスクはチェック済みのステップだけ。stepStats と同じ数え方）
        this.summaryMeter(
          body,
          "ステップ",
          mine.flatMap((t) =>
            countedSteps(t).map((sp) => ({
              weight: 1,
              done: sp.done,
              tip: `${this.displayTitle(t)}\n${sp.text}${sp.done ? " · 完了" : ""}`,
            }))
          ),
          `${steps.done}/${steps.total}`,
          `チェック済み ${steps.done} ステップ / 全 ${steps.total} ステップ（今日のタスクに書いた「- [ ] …」の合計。持ち越し済み [>] はチェック済みだけ）`
        );
      }
      if (st.plan > 0) {
        this.summaryMeter(
          body,
          "時間",
          own.filter(isScheduled).map((t) => ({ weight: t.end - t.start, done: t.done, tip: segTip(t) })),
          `${hmm(st.donePlan)}/${hmm(st.plan)}`,
          `完了したタスクの予定時間 ${hmm(st.donePlan)} / 今日の予定時間の合計 ${hmm(st.plan)}`
        );
      }
      // 残量（件数・予定時間）と実績の合計。「%」より「あと 3 件・2:55」のほうが見通しが立つ
      const remain = st.total - st.done;
      const remainPlan = st.plan - st.donePlan;
      const parts: string[] = [];
      const remainSteps = steps.total - steps.done;
      if (remain > 0) parts.push(`あと ${remain} タスク` + (remainPlan > 0 ? `・${hmm(remainPlan)}` : ""));
      if (remainSteps > 0) parts.push(`ステップ あと ${remainSteps}`);
      if (st.actual > 0) parts.push(`実績 ${hmm(st.actual)}`);
      if (parts.length) {
        const line = body.createDiv({ cls: "dt-summary-line", text: parts.join("　") });
        line.setAttr(
          "aria-label",
          [
            remain > 0 ? `残り ${remain} タスク（予定時間 ${hmm(remainPlan)}）` : "",
            remainSteps > 0 ? `未チェックのステップ ${remainSteps} 件` : "",
            st.actual > 0 ? `今日の実績の合計 ${hmm(st.actual)}` : "",
          ]
            .filter(Boolean)
            .join("\n")
        );
      }
    }
    this.renderSummaryNext(body, today, all);
    this.renderSummaryWeek(body, today);
    // 記録の埋まり具合: 完了タスクで、タグの必須欄（結果など）が空のもの、または 15 分以上でふりかえりが空のもの
    //（完了時のポップアップと同じ条件）。達成率とは切り離し、色を付けずに出す
    const schema = this.plugin.settings.tagFieldSchema;
    const unfilled = all.filter((t) => {
      if (t.owner || !t.done || t.forwarded) return false;
      const def = schemaForTags(schema, t.tags);
      const required = def ? def.required.map(normalizeFieldLabel) : ["結果"];
      if (def && !def.required.length) return false; // #私用 など、記録の要らないタグ
      const values: Record<string, string> = {
        結果: t.result,
        原因: t.cause,
        判断: t.judgment,
        残: t.remaining,
        回答: t.answer,
        完了条件: t.doneCondition,
        Owner: t.ownerName,
        次アクション: t.nextAction,
        期限: t.due,
      };
      if (required.some((l) => l in values && !values[l].trim())) return true;
      return isScheduled(t) && t.end - t.start >= 15 && !t.retrospective.trim();
    });
    if (unfilled.length) {
      const note = body.createDiv({
        cls: "dt-summary-note",
        text: `結果・ふりかえりの未記入 ${unfilled.length} 件`,
      });
      note.setAttr(
        "aria-label",
        [...unfilled.map((t) => "・" + this.displayTitle(t)), "クリックで先頭のタスクを編集"].join("\n")
      );
      note.addEventListener("click", () => this.openEditModal(today, unfilled[0]));
    }
  }

  /**
   * サマリーのメーター1本（ラベル・バー・値・%）。
   * バーはタスクごとの区切り（縦線）入りで、幅は weight に比例（件数なら 1、時間なら予定の分）。
   * 完了したタスクを左に寄せて塗るので、塗りの境目が完了 / 未完了の境目と一致し、
   * 残りの区切りで「大きいタスクがいくつ残っているか」も見える。区切りにマウスを乗せるとそのタスク名
   */
  private summaryMeter(
    parent: HTMLElement,
    label: string,
    segments: { weight: number; done: boolean; tip: string }[],
    value: string,
    tip: string
  ): void {
    const total = segments.reduce((n, sg) => n + sg.weight, 0);
    const done = segments.reduce((n, sg) => n + (sg.done ? sg.weight : 0), 0);
    const pct = total > 0 ? Math.round(clamp(done / total, 0, 1) * 100) : 0;
    const row = parent.createDiv("dt-summary-meter");
    row.setAttr("aria-label", tip);
    row.toggleClass("is-complete", total > 0 && pct >= 100);
    row.createSpan({ cls: "dt-summary-meter-label", text: label });
    const bar = row.createDiv("dt-summary-bar");
    const ordered = [...segments.filter((sg) => sg.done), ...segments.filter((sg) => !sg.done)];
    if (ordered.length <= MAX_SUMMARY_SEGMENTS) {
      for (const sg of ordered) {
        const seg = bar.createDiv("dt-summary-seg");
        seg.style.flexGrow = String(sg.weight);
        seg.toggleClass("is-done", sg.done);
        seg.setAttr("aria-label", sg.tip);
      }
    } else {
      // 区切りが多すぎると線だけになるので、1本の棒として塗る
      const fill = bar.createDiv("dt-summary-seg is-done is-plain");
      fill.style.flex = `0 0 ${pct}%`;
    }
    row.createSpan({ cls: "dt-summary-meter-value", text: value });
    row.createSpan({ cls: "dt-summary-meter-pct", text: `${pct}%` });
  }

  /**
   * 「いま / 次にやる1件」の行。現在時刻にかかっている未完了タスク → これから始まるタスク →
   * 予定の時刻を過ぎて残っているタスク → 時刻未定のタスク、の順で1件だけ出す。
   * チェックで完了、▶ で実績の計測を開始、クリックで編集、右クリックでメニュー
   */
  private renderSummaryNext(parent: HTMLElement, today: Date, all: Task[]): void {
    const undone = all.filter((t) => !t.owner && !t.done && !t.forwarded);
    if (!undone.length) return;
    const now = nowMinutes();
    const scheduled = undone.filter(isScheduled).sort((a, b) => a.start - b.start || a.end - b.end);
    let task: Task;
    let label: string;
    let kind: string;
    const current = scheduled.find((t) => t.start <= now && now < t.end);
    const upcoming = scheduled.find((t) => t.start > now);
    if (current) {
      task = current;
      label = "いま";
      kind = "now";
    } else if (upcoming) {
      task = upcoming;
      label = "次";
      kind = "next";
    } else if (scheduled.length) {
      task = scheduled[0];
      label = "未了";
      kind = "overdue";
    } else {
      task = undone[0];
      label = "未定";
      kind = "unscheduled";
    }
    const t = task;
    const row = parent.createDiv("dt-summary-next");
    row.addClass(`is-${kind}`);
    const box = row.createDiv("dt-tray-check");
    setIcon(box, iconName("square"));
    box.setAttr("aria-label", "完了にする");
    box.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.commitUpdate(today, t, { ...this.draftOf(t), done: true });
    });
    row.createSpan({ cls: "dt-summary-next-label", text: label });
    if (isScheduled(t)) row.createSpan({ cls: "dt-summary-next-time", text: minutesToHHMM(t.start) });
    row.createSpan({ cls: "dt-summary-next-title", text: this.displayTitle(t) });
    if (isScheduled(t)) row.createSpan({ cls: "dt-summary-next-dur", text: hmm(t.end - t.start) });
    // ステップ: 「2/4」の小さなバーと、次にやる（最初の未チェックの）ステップ。タスク名だけだと
    // いま何をすればいいかが分からないので、タスクとステップの両方を出す
    const stepsOf = t.steps.filter((sp) => sp.text.trim());
    if (stepsOf.length) {
      const doneSteps = stepsOf.filter((sp) => sp.done).length;
      const nextStep = stepsOf.find((sp) => !sp.done);
      const line = row.createDiv("dt-summary-next-steps");
      const bar = line.createDiv("dt-summary-bar");
      const fill = bar.createDiv("dt-summary-seg is-done is-plain");
      fill.style.flex = `0 0 ${Math.round((doneSteps / stepsOf.length) * 100)}%`;
      line.createSpan({ cls: "dt-summary-next-steps-count", text: `ステップ ${doneSteps}/${stepsOf.length}` });
      if (nextStep) {
        line.createSpan({ cls: "dt-summary-next-steps-sep", text: "·" });
        line.createSpan({ cls: "dt-summary-next-steps-next", text: `次: ${nextStep.text}`, attr: { title: nextStep.text } });
      }
    }
    // 実績の計測（ストップウォッチ）の開始 / 終了。右クリックメニューと同じ操作
    if (this.plugin.blockStoreFor(t.owner)) {
      const tr = this.plugin.settings.tracking;
      const isTracking =
        !!tr && !!t.blockId && tr.blockId === t.blockId && (tr.owner ?? null) === (t.owner ?? null);
      const btn = this.iconButton(
        row,
        isTracking ? "stop-circle" : "play",
        isTracking ? "計測を終了して実績に記録" : "実績の計測を開始",
        () => {
          if (isTracking) void this.plugin.stopTaskTracking(true);
          else void this.plugin.startTaskTracking(today, t);
        }
      );
      btn.addClass("dt-summary-next-play");
      btn.toggleClass("is-tracking", isTracking);
      btn.addEventListener("click", (e) => e.stopPropagation());
    }
    const kindTip = {
      now: "いま取りかかる時間のタスク",
      next: "次に始まるタスク",
      overdue: "予定の時刻を過ぎて残っているタスク",
      unscheduled: "時刻を決めていないタスク",
    }[kind];
    row.setAttr(
      "aria-label",
      [
        t.title || "(無題)",
        isScheduled(t) ? `${minutesToHHMM(t.start)} - ${minutesToHHMM(t.end)}` : "",
        kindTip,
        stepsOf.length ? `ステップ ${stepsOf.filter((sp) => sp.done).length}/${stepsOf.length}` : "",
        t.doneCondition ? `完了条件: ${t.doneCondition}` : "",
        "クリックで編集、右クリックでメニュー",
      ]
        .filter(Boolean)
        .join("\n")
    );
    row.addEventListener("click", () => this.openEditModal(today, t));
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.showTaskMenu(today, t, e);
    });
  }

  /** 連続達成の日数と、今週 7 日ぶんの達成率の小さな棒グラフ */
  private renderSummaryWeek(parent: HTMLElement, today: Date): void {
    const s = this.plugin.settings;
    const threshold = s.summaryStreakPercent / 100;
    const foot = parent.createDiv("dt-summary-foot");
    if (s.summaryStreakPercent > 0) {
      const streak = this.summaryStreak(threshold);
      const el = foot.createSpan("dt-summary-streak");
      el.toggleClass("is-active", streak > 0);
      setIcon(el.createSpan("dt-summary-streak-icon"), "flame");
      el.createSpan({ text: streak > 0 ? `${streak}日連続` : "連続 0日" });
      el.setAttr(
        "aria-label",
        `達成率 ${s.summaryStreakPercent}% 以上の日が` +
          (streak > 0 ? ` ${streak} 日続いています` : "まだ続いていません") +
          "\n（タスクの無い日は数えません。今日はまだ途中なので、届いていなくても途切れません。設定で閾値を変えられます）"
      );
    }
    const week = foot.createDiv("dt-summary-week");
    week.setAttr("aria-label", "今週の達成率");
    const first = startOfWeek(today, s.weekStart);
    for (let i = 0; i < 7; i++) {
      const date = addDays(first, i);
      const bar = week.createDiv("dt-summary-week-day");
      const fill = bar.createDiv();
      const future = date > today;
      const st = future ? null : (() => {
        const tasks = this.tasksOn(date);
        return tasks ? dayStats(tasks) : null;
      })();
      const ratio = st?.ratio ?? null;
      bar.toggleClass("is-today", isSameDay(date, today));
      bar.toggleClass("is-future", future);
      bar.toggleClass("is-empty", !future && ratio === null);
      if (ratio !== null) {
        fill.style.height = `${Math.round(clamp(ratio, 0, 1) * 100)}%`;
        bar.toggleClass("is-hit", threshold > 0 && ratio >= threshold);
      }
      const label = `${date.getMonth() + 1}/${date.getDate()} (${WEEKDAY_JA[date.getDay()]})`;
      bar.setAttr(
        "aria-label",
        future
          ? label
          : ratio === null || !st
            ? `${label}: タスクなし`
            : `${label}: ${Math.round(ratio * 100)}%（${st.done}/${st.total} 件）`
      );
      // 過去の日をクリックでその日へ
      if (!future) bar.addEventListener("click", () => this.showDate(date));
    }
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
        setIcon(box, iconName(t.done ? "check-square" : "square"));
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
        onEnd: (moved, ev) => {
          el.removeClass("is-dragging");
          el.removeClass("is-lifted");
          if (!moved) {
            if (viaLongPress) {
              this.swallowNextClick();
              this.showTaskMenu(col.date, task, ev);
            } else if (toNote) void this.showMemoPopover(col.date, task, ev);
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
        // 「実績/予定」（小数1桁の時間）と差異を1つのピルにまとめる。列が広ければ1行、
        // 狭ければ差異が自然に2行目へ折り返す。下端の極小バーが予定に対する実績の割合
        const nums = el.createSpan("dt-day-total-nums");
        nums.createSpan({ cls: "dt-day-total-act", text: hoursDecimal(act) });
        nums.createSpan({ text: `/${hoursDecimal(plan)}` });
        el.setAttr("aria-label", `実績 ${hmm(act)} / 予定 ${hmm(plan)}`);
        if (plan && act) {
          const diff = act - plan;
          const d = el.createSpan({
            cls: "dt-day-total-diff",
            text: `${diff >= 0 ? "+" : "-"}${hoursDecimal(Math.abs(diff))}`,
          });
          d.toggleClass("is-over", diff > 0);
        }
        if (plan) {
          const fill = el.createDiv("dt-day-total-bar").createDiv();
          fill.style.width = `${Math.min(100, Math.round((act / plan) * 100))}%`;
          fill.toggleClass("is-over", act > plan);
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
        this.registerTaskEl(`${key}|${task.key}`, item);
        item.addEventListener("click", (e) => {
          e.stopPropagation();
          if (e.ctrlKey || e.metaKey) void this.showMemoPopover(cell.date, task, e);
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

  // ---------- パネルからの選択（プロジェクト一覧のタスク → タイムラインのブロック） ----------

  /** taskEls / activeTaskKey / selectedTaskKey の鍵（"日付キー|タスクの key"） */
  private taskElKey(date: Date, task: Task): string {
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
  private selectTask(date: Date, task: Task, rowEl?: HTMLElement): void {
    const key = this.taskElKey(date, task);
    this.selectedTaskKey = key;
    this.pendingReveal = true;
    for (const [k, el] of this.taskEls) el.toggleClass("is-selected", k === key);
    this.inboxEl
      ?.querySelectorAll<HTMLElement>(".dt-project-child.is-selected, .dt-project-child-trow.is-selected")
      .forEach((el) => el.removeClass("is-selected"));
    rowEl?.addClass("is-selected");
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
  private revealSelectedTask(): void {
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
    const headerH = this.mode === "month" ? 0 : (this.headersEl?.offsetHeight ?? 0);
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
  private showProjectPreview(targetEl: HTMLElement, linktext: string, e: MouseEvent): void {
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
  private attachProjectNamePreview(el: HTMLElement, linktext: string): void {
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

  // ---------- 作業メモのポップアップ（Ctrl/Cmd + クリック / 右クリック「作業メモを見る」） ----------

  /** 表示中の作業メモのポップアップ（1つだけ） */
  private memoPopoverEl: HTMLElement | null = null;
  private memoPopoverCleanup: (() => void) | null = null;

  /**
   * タスクの作業メモ（ステップ・備考）を、ノートも編集ダイアログも開かずにその場のポップアップで見る。
   * ステップはその場でチェックでき、「編集」で作業メモのタブを開いたダイアログへ、「ノートで開く」でブロックへ飛べる。
   * 記録（結果など）は出さない: 作業中に見返したいのは手順と手元のメモだけなので
   */
  private async showMemoPopover(date: Date, task: Task, e: MouseEvent): Promise<void> {
    this.closeMemoPopover();
    const pop = document.body.createDiv({ cls: "dt-memo-popover", attr: { role: "dialog", "aria-label": "作業メモ" } });
    this.memoPopoverEl = pop;
    pop.style.left = `${e.clientX + 8}px`;
    pop.style.top = `${e.clientY + 8}px`;

    const head = pop.createDiv("dt-memo-pop-head");
    const titleWrap = head.createDiv("dt-memo-pop-title");
    titleWrap.createSpan({ cls: "dt-memo-pop-label", text: "作業メモ" });
    titleWrap.createSpan({ cls: "dt-memo-pop-name", text: this.displayTitle(task), attr: { title: task.title } });
    const actions = head.createDiv("dt-memo-pop-actions");
    const button = (icon: string, label: string, onClick: () => void) => {
      const b = actions.createEl("button", { cls: "dt-memo-pop-btn", attr: { type: "button", "aria-label": label, title: label } });
      setIcon(b, iconName(icon));
      b.onclick = (ev: MouseEvent) => {
        ev.stopPropagation();
        onClick();
      };
    };
    button("pencil", "作業メモを編集", () => {
      this.closeMemoPopover();
      this.openEditModal(date, task, "memo");
    });
    // プロジェクトが結びついていれば、そのノートを直接開くアイコン（作業中は案件ノートを見ながら進めることが多い）
    const projectLink = task.project;
    if (projectLink) {
      button("folder-open", `プロジェクトノートを開く: ${projectDisplayName(projectLink)}`, () => {
        this.closeMemoPopover();
        void this.plugin.openProject(projectLink);
      });
    }
    button("file-text", "ノートで開く", () => {
      this.closeMemoPopover();
      void this.openTaskInNote(date, task);
    });
    button("x", "閉じる", () => this.closeMemoPopover());

    const body = pop.createDiv("dt-memo-pop-body");
    await this.renderMemoPopoverBody(body, date, task);
    if (this.memoPopoverEl !== pop) return; // 描画中に閉じられた

    // 画面からはみ出す分は寄せる（右・下にあふれたら左・上へ）
    const rect = pop.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = e.clientX + 8;
    let top = e.clientY + 8;
    if (left + rect.width > vw - 8) left = Math.max(8, e.clientX - rect.width - 8);
    if (top + rect.height > vh - 8) top = Math.max(8, vh - rect.height - 8);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;

    // 外側のクリック・Esc で閉じる（このクリック自体で閉じないよう、登録は次のティックで）
    const onDown = (ev: PointerEvent) => {
      if (!pop.contains(ev.target as Node)) this.closeMemoPopover();
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") this.closeMemoPopover();
    };
    window.setTimeout(() => {
      if (this.memoPopoverEl !== pop) return;
      document.addEventListener("pointerdown", onDown, true);
      document.addEventListener("keydown", onKey, true);
      this.memoPopoverCleanup = () => {
        document.removeEventListener("pointerdown", onDown, true);
        document.removeEventListener("keydown", onKey, true);
      };
    }, 0);
  }

  private closeMemoPopover(): void {
    this.memoPopoverCleanup?.();
    this.memoPopoverCleanup = null;
    this.memoPopoverEl?.remove();
    this.memoPopoverEl = null;
  }

  /** ポップアップの中身（ステップのチェックリスト + 備考の Markdown）。ステップの切替後にも呼んで描き直す */
  private async renderMemoPopoverBody(body: HTMLElement, date: Date, task: Task): Promise<void> {
    body.empty();
    const sourcePath = this.storeOf(task).pathFor(date);
    const steps = task.steps.filter((st) => st.text.trim());
    if (steps.length) {
      const sec = body.createDiv("dt-memo-pop-steps");
      const done = steps.filter((st) => st.done).length;
      sec.createDiv({ cls: "dt-memo-pop-sec", text: `ステップ ${done} / ${steps.length}` });
      const bar = sec.createDiv("dt-memo-pop-bar");
      bar.createDiv().style.width = `${(done / steps.length) * 100}%`;
      for (const [idx, st] of steps.entries()) {
        const row = sec.createDiv("dt-memo-pop-step");
        row.toggleClass("is-done", st.done);
        const cb = row.createEl("input", { type: "checkbox", attr: { "aria-label": st.text } });
        cb.checked = st.done;
        cb.addEventListener("change", () => void this.toggleMemoStep(body, date, task, idx, cb.checked));
        row.createSpan({ cls: "dt-memo-pop-step-text", text: st.text });
        const children = st.children.map((l) => l.replace(/^\s+/, "")).filter((l) => l.trim());
        if (children.length) {
          const sub = row.createDiv("dt-memo-pop-step-sub markdown-rendered");
          await MarkdownRenderer.render(this.app, children.join("\n"), sub, sourcePath, this);
        }
      }
    }
    if (task.details.trim()) {
      const sec = body.createDiv("dt-memo-pop-details");
      sec.createDiv({ cls: "dt-memo-pop-sec", text: "備考" });
      const md = sec.createDiv("dt-memo-pop-md markdown-rendered");
      await MarkdownRenderer.render(this.app, task.details, md, sourcePath, this);
    }
    if (!steps.length && !task.details.trim()) {
      body.createDiv({
        cls: "dt-memo-pop-empty",
        text: "作業メモはまだありません。「作業メモを編集」でステップや備考を書けます",
      });
    }
  }

  /** ポップアップのチェックでステップの完了を切り替えて保存し、最新のタスクで描き直す */
  private async toggleMemoStep(body: HTMLElement, date: Date, task: Task, index: number, done: boolean): Promise<void> {
    const steps = task.steps.map((st) => ({ ...st, children: [...st.children] }));
    const visible = steps.filter((st) => st.text.trim());
    if (!visible[index]) return;
    visible[index].done = done;
    await this.commitUpdate(date, task, { ...this.draftOf(task), steps });
    if (!this.memoPopoverEl) return;
    const fresh = (this.data.get(dateKey(date))?.tasks ?? []).find(
      (t) => (task.blockId ? t.blockId === task.blockId : t.key === task.key)
    );
    if (fresh) await this.renderMemoPopoverBody(body, date, fresh);
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

  /**
   * 縮尺が変わったときに、いま見えている時刻を保ったままグリッドを作り直す。
   * anchorClientY を渡すと、その画面位置（ポインタ位置）の時刻を動かさないように合わせる
   */
  private rebuildTimeline(anchorClientY?: number): void {
    if (this.mode === "month" || !this.scrollEl) return;
    const s = this.plugin.settings;
    const anchor =
      anchorClientY != null
        ? this.clientYToMinutes(anchorClientY)
        : s.startHour * 60 + this.pxToMinutes(this.scrollEl.scrollTop);
    this.buildGrid();
    this.renderEvents();
    if (anchorClientY != null) {
      // 作り直しで scrollTop は 0 に戻っている。アンカーの時刻がポインタ位置に来る量だけずらす
      const rect = this.daysEl.getBoundingClientRect();
      this.scrollEl.scrollTop += rect.top + this.minutesToPx(anchor) - anchorClientY;
    } else if (!this.shouldScroll) {
      this.scrollEl.scrollTop = Math.max(0, this.minutesToPx(anchor));
    }
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

  private isTouch(e: PointerEvent): boolean {
    return e.pointerType === "touch";
  }

  /**
   * タッチの pointerdown から「長押し」だけを判定する。
   * - 指が動かないまま LONG_PRESS_MS 経過 → onLongPress（ここからドラッグを始める）
   * - 先に TOUCH_SLOP を超えて動いた / 離した / キャンセル → 何もしない
   *   （スクロール・横スワイプはブラウザと swipe ナビに、タップは各要素の click に任せる。
   *    タップを pointerup から自前で再構成すると、実機の WebView や Obsidian 本体の
   *    ジェスチャ処理に食われて拾えないことがあるため、click に寄せている）
   */
  private touchGate(target: HTMLElement, e: PointerEvent, h: { onLongPress: () => void }): void {
    const pointerId = e.pointerId;
    const sx = e.clientX;
    const sy = e.clientY;
    const cleanup = () => {
      window.clearTimeout(timer);
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUpOrCancel);
      target.removeEventListener("pointercancel", onUpOrCancel);
    };
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      if (Math.abs(ev.clientX - sx) > TOUCH_SLOP || Math.abs(ev.clientY - sy) > TOUCH_SLOP) cleanup();
    };
    const onUpOrCancel = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      cleanup();
    };
    const timer = window.setTimeout(() => {
      cleanup();
      // 2本指ピンチが始まっていたら長押しにしない（指をあまり動かさないピンチで
      // ドラッグが誤って始まらないように）
      if (this.pinchZooming) return;
      navigator.vibrate?.(15);
      h.onLongPress();
    }, LONG_PRESS_MS);
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUpOrCancel);
    target.addEventListener("pointercancel", onUpOrCancel);
  }

  /**
   * タッチ操作の直後にブラウザが合成する click を、次の1回だけ握りつぶす。
   * 長押しから指を離した位置にメニューやダイアログが出ると、その合成 click が
   * 出てきたばかりの UI に当たって即閉じてしまうのを防ぐ
   */
  private swallowNextClick(): void {
    const swallow = (ev: MouseEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      cleanup();
    };
    const cleanup = () => {
      document.removeEventListener("click", swallow, true);
      window.clearTimeout(timer);
    };
    const timer = window.setTimeout(cleanup, 400);
    document.addEventListener("click", swallow, { capture: true });
  }

  /** マウス／タッチのドラッグをまとめて扱う */
  private startDrag(target: HTMLElement, e: PointerEvent, h: DragHandlers): void {
    const startY = e.clientY;
    const pointerId = e.pointerId;
    const touch = this.isTouch(e);
    let moved = false;
    this.interacting = true;
    if (touch) this.touchDragging = true;

    // タッチのドラッグ中はブラウザにスクロールを始めさせない（始まると pointercancel で
    // ドラッグが打ち切られる）。touch イベントは touchstart した要素に届き続けるので
    // target で受けられる
    const onTouchMove = (ev: TouchEvent) => ev.preventDefault();
    if (touch) target.addEventListener("touchmove", onTouchMove, { passive: false });

    const detach = () => {
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onCancel);
      if (touch) target.removeEventListener("touchmove", onTouchMove);
      try {
        target.releasePointerCapture(pointerId);
      } catch (_e) {
        /* すでに解放済み */
      }
    };
    const done = () => {
      this.interacting = false;
      // contextmenu（Android は長押しの約 500ms 後、指を離した後に来ることもある）を
      // 拾ってメニューが二重に開かないよう、少し遅らせて解除する
      if (touch) window.setTimeout(() => (this.touchDragging = false), 350);
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
    const targetEl = e.target as HTMLElement;
    this.canvasTapArmed = false;
    if (targetEl.closest(".dt-event")) return;

    if (this.isTouch(e)) {
      // チップ自身のタップはチップの click（作成ダイアログを開く）に任せる
      if (targetEl.closest(".dt-touch-chip")) return;
      // タッチでは誤操作を避ける: タップ（＝ネイティブの click、onCanvasClick）→
      // 「＋ 追加」チップを出して 2 タップ目で作成、長押し → その場からドラッグで
      // 範囲を決めて作成（Google カレンダー方式）。スクロール・横スワイプでは何もしない
      this.canvasTapArmed = true;
      this.touchGate(col.canvasEl, e, {
        onLongPress: () => {
          this.canvasTapArmed = false;
          this.beginCanvasCreateDrag(e, col);
        },
      });
      return;
    }
    this.dismissTouchChip();
    this.beginCanvasCreateDrag(e, col);
  }

  /** タッチのタップ（ブラウザが確定した click）で「＋ 追加」チップを出す */
  private onCanvasClick(e: MouseEvent, col: DayColumn): void {
    if (!this.canvasTapArmed) return; // マウスのクリックは onCanvasPointerDown 側で扱う
    this.canvasTapArmed = false;
    if (this.touchDragging) return;
    const targetEl = e.target as HTMLElement;
    if (targetEl.closest(".dt-event, .dt-touch-chip")) return;
    this.showTouchCreateChip(col, e.clientY);
  }

  /** タッチで空き時間をタップ → その枠に「＋ 時刻」チップを出す。チップをタップで作成 */
  private showTouchCreateChip(col: DayColumn, clientY: number): void {
    this.dismissTouchChip();
    const s = this.plugin.settings;
    const dayStart = s.startHour * 60;
    const dayEnd = s.endHour * 60;
    const start = clamp(this.snapFloor(this.clientYToMinutes(clientY)), dayStart, dayEnd - s.snapMinutes);
    const end = Math.min(start + s.defaultDurationMinutes, dayEnd);
    const el = col.eventsEl.createDiv("dt-ghost dt-touch-chip");
    el.style.top = this.minutesToPx(start) + "px";
    el.style.height = Math.max(this.minutesToPx(end) - this.minutesToPx(start) - 2, 4) + "px";
    el.setText(`＋ ${minutesToHHMM(start)} - ${minutesToHHMM(end)}`);
    el.addEventListener("click", (ev) => {
      ev.stopPropagation();
      this.dismissTouchChip();
      this.openCreateModal(col.date, start, end);
    });
    this.touchChipEl = el;
  }

  private dismissTouchChip(): void {
    this.touchChipEl?.remove();
    this.touchChipEl = null;
  }

  /** 空き時間からのドラッグ（マウス、またはタッチの長押し後）でタスクを作成する */
  private beginCanvasCreateDrag(e: PointerEvent, col: DayColumn): void {
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
        if (!moved) {
          range = defaultRange();
          // 長押しだけで離した場合は合成 click が来うるので、ダイアログに当たらないように
          if (this.isTouch(e)) this.swallowNextClick();
        }
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

    // 本体: クリックで編集（Ctrl/Cmd+クリックでノートへ）、ドラッグで移動（週表示では別の日へも）。
    // タッチではタップ（＝ネイティブの click）で編集、長押ししてからドラッグで移動
    // （長押しして動かさなければメニュー）
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
    // タップ = ブラウザが確定した click（スクロールや長押しになったタップでは発火しない）。
    // マウスのクリックは beginMove の onEnd(!moved) が扱うのでここでは無視する
    el.addEventListener("click", (ce: MouseEvent) => {
      ce.stopPropagation();
      if (!touchTapArmed) return;
      touchTapArmed = false;
      if (this.touchDragging) return;
      this.openEditModal(col.date, task);
    });
    const beginMove = (e: PointerEvent, viaLongPress: boolean) => {
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
        onEnd: (moved, ev) => {
          el.removeClass("is-dragging");
          el.removeClass("is-lifted");
          if (!moved) {
            // 長押しだけ（動かさず離した）→ 右クリック相当のメニュー。
            // モバイルでは完了・削除・持ち越しなどへの入口になる
            if (viaLongPress) {
              this.swallowNextClick(); // 合成 click がメニューに当たって即閉じないように
              this.showTaskMenu(col.date, task, ev);
            } else if (toNote) void this.showMemoPopover(col.date, task, ev);
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
          el.removeClass("is-lifted");
          if (moved && newEnd !== task.end) {
            void this.commitUpdate(col.date, task, { ...this.draftOf(task), end: newEnd });
          } else {
            this.renderEvents();
          }
        },
        onCancel: () => this.renderEvents(),
      });
    };

    // 右クリックメニュー
    el.addEventListener("contextmenu", (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.touchDragging) return; // 長押しドラッグ中の contextmenu（Android）は無視
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
      if (this.touchDragging) return;
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
      if (this.touchDragging) return;
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
    if (this.plugin.blockStoreFor(task.owner)) {
      menu.addItem((i) =>
        i
          .setTitle("作業メモを見る")
          .setIcon("list-checks")
          .onClick(() => void this.showMemoPopover(date, task, e))
      );
    }
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
      menu.addItem((i) =>
        i
          .setTitle("当日内で続きを作る（記録を残す）")
          .setIcon("repeat")
          .onClick(() => void this.commitCarryOver(date, task, "same-day"))
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
              // タスクのステップを「共通のステップ」の初期値に（毎回未チェックで入る）
              steps: task.steps.map((st) => st.text.trim()).filter(Boolean),
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
      tagFieldSchema: s.tagFieldSchema,
      validateRequiredOnSave: s.validateRequiredOnSave,
      memberNames: s.members.map((m) => m.name),
      reminderDefault: this.plugin.blockStore() ? s.reminderDefaultMinutes : undefined,
      showDoneCondition: !!this.plugin.blockStore(),
      trackers: s.trackers,
      owners: this.ownerChoices(),
      initialOwner: null,
      otherActuals: this.otherActualsFor(date, null),
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
      tagFieldSchema: s.tagFieldSchema,
      validateRequiredOnSave: s.validateRequiredOnSave,
      memberNames: s.members.map((m) => m.name),
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

  private openEditModal(date: Date, task: Task, pane?: "record" | "memo"): void {
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
      tagFieldSchema: this.plugin.settings.tagFieldSchema,
      validateRequiredOnSave: this.plugin.settings.validateRequiredOnSave,
      memberNames: this.plugin.settings.members.map((m) => m.name),
      reminderDefault: this.plugin.blockStore() ? this.plugin.settings.reminderDefaultMinutes : undefined,
      showDoneCondition: !!this.plugin.blockStore(),
      showActual: !!this.plugin.blockStore(),
      trackers: this.plugin.settings.trackers,
      owners: this.ownerChoices(),
      initialOwner: task.owner ?? null,
      otherActuals: this.otherActualsFor(date, task.owner ?? null, task.key),
      initialPane: pane,
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
      result: task.result,
      remaining: task.remaining,
      cause: task.cause,
      judgment: task.judgment,
      others: task.others,
      answer: task.answer,
      status: task.status,
      ownerName: task.ownerName,
      due: task.due,
      nextAction: task.nextAction,
      actual: task.actual,
      project: task.project,
      details: task.details,
      ticket: task.ticket,
    };
  }

  /**
   * 編集ダイアログに渡す「同じ日の他のタスクの実績」（実績の重複を保存前に注意するため）。
   * 同じ持ち主のタスクだけを見る（メンバーの予定と自分の予定は別のノートなので重なってよい）
   */
  private otherActualsFor(date: Date, owner: string | null, exceptKey?: string): OtherActual[] {
    return (this.data.get(dateKey(date))?.tasks ?? [])
      .filter((t) => t.key !== exceptKey && (t.owner ?? null) === (owner ?? null) && t.actual.length)
      .map((t) => ({ title: stripTags(t.title) || "(無題)", tags: t.tags, ranges: t.actual }));
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
    // 未完了 → 完了で未チェックのステップが残っていれば、先に確認する
    if (this.maybeConfirmRemainingSteps(date, task, data, wasDone)) return;
    await this.performUpdate(date, task, data, wasDone);
  }

  /**
   * 未完了 → 完了にするとき、未チェックのステップが残っていれば確認ダイアログを出す。
   * 「残:」を書かずに完了にすると、日報などの下流で残件が完了扱いのまま埋もれてしまうため。
   * ダイアログを出したら true（続きは選択に応じて performUpdate / commitCarryOver が行う）
   */
  private maybeConfirmRemainingSteps(date: Date, task: Task, data: TaskDraft, wasDone: boolean): boolean {
    if (!this.plugin.blockStoreFor(task.owner)) return false; // ブロック形式のみ
    if (!data.done || wasDone) return false; // 「未完了 → 完了」のときだけ
    const steps = data.steps ?? task.steps;
    const unchecked = steps.filter((st) => !st.done && st.text.trim()).map((st) => st.text.trim());
    if (!unchecked.length) return false;
    // すでに「残:」が書いてあれば、改めては聞かない
    const remaining = data.remaining !== undefined ? data.remaining : task.remaining;
    if (remaining.trim()) return false;
    new RemainingStepsModal(this.app, {
      taskTitle: stripTags(data.title || task.title),
      steps: unchecked,
      onComplete: (rem) => this.performUpdate(date, task, rem ? { ...data, remaining: rem } : data, wasDone),
      onCarryOver: !task.forwarded ? () => this.commitCarryOver(date, task, "next-day") : undefined,
      onCarryOverSameDay: !task.forwarded ? () => this.commitCarryOver(date, task, "same-day") : undefined,
    }).open();
    return true;
  }

  private async performUpdate(date: Date, task: Task, data: TaskDraft, wasDone = task.done): Promise<void> {
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
   * 同じ日の他タスクの実績と重なる時間帯は除く（完了操作の遅れや中断が
   * 二重の実績として記録され、予実の合計と記録チェックを狂わせるのを防ぐ）。
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
    let candidate: ActualRange[] = [{ start, end }];
    if (isToday(date)) {
      const now = nowMinutes();
      if (now > start && now <= end + 60) candidate = [{ start, end: Math.min(now, 1440) }];
    }
    const others = (this.data.get(dateKey(date))?.tasks ?? [])
      .filter((t) => t.key !== task.key && (t.owner ?? null) === (task.owner ?? null))
      .flatMap((t) => t.actual);
    const clipped = subtractActualRanges(candidate, others);
    // すべて他タスクの実績と重なっていたら、記録しないよりは元の候補を残す（ポップアップで直せる）
    return clipped.length ? clipped : candidate;
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
   * 完了にしたとき、選んだタグで必須の欄（結果。障害なら原因・判断、質問なら回答 …）が空なら、
   * その欄だけを聞くポップアップを出す（Rules/Work記録チェック担当ルール.md: 完了 [x] に結果が無いと 🔴）。
   * 15分以上のタスクはふりかえりが空でも出す。実績の確認・修正欄も一緒に出す。ポップアップを出したら true
   */
  private maybePromptRetrospective(date: Date, task: Task, data: TaskDraft, wasDone = task.done): boolean {
    if (!this.plugin.blockStore()) return false; // ブロック形式のみ
    if (!data.done || wasDone) return false; // 「未完了 → 完了」のときだけ
    const start = data.start ?? task.start;
    const end = data.end ?? task.end;
    const duration = start !== null && end !== null ? end - start : 0;
    const merged = { ...this.draftOf(task), ...data };
    const title = data.title ?? task.title;
    const tags = extractTags(title);
    const schema = this.plugin.settings.tagFieldSchema;
    const def = schemaForTags(schema, tags);
    // 選んだタグの必須欄のうち空のもの（結果は先頭に。定義の無いタグは結果だけ）
    const required = def ? def.required.map(normalizeFieldLabel) : ["結果"];
    const valueOf: Record<string, () => string> = {
      結果: () => merged.result ?? "",
      原因: () => merged.cause ?? "",
      判断: () => merged.judgment ?? "",
      残: () => merged.remaining ?? "",
      回答: () => merged.answer ?? "",
      完了条件: () => merged.doneCondition ?? "",
      Owner: () => merged.ownerName ?? "",
      次アクション: () => merged.nextAction ?? "",
      期限: () => merged.due ?? "",
    };
    const keyOf: Record<string, string> = {
      原因: "cause",
      判断: "judgment",
      残: "remaining",
      回答: "answer",
      完了条件: "doneCondition",
      Owner: "ownerName",
      次アクション: "nextAction",
      期限: "due",
    };
    const missing = required.filter((l) => valueOf[l] && !valueOf[l]().trim());
    const retro = merged.retrospective ?? "";
    const needRetro = duration >= 15 && !retro.trim() && (!def || def.required.length > 0);
    if (!missing.length && !needRetro) return false;
    const tag = tags.find((t) => schemaForTags(schema, [t])) ?? tags[0] ?? "";
    const phField = (f: string) => placeholderFor(schema, tag, f as never);
    const extraFields: RetroExtraField[] = missing
      .filter((l) => l !== "結果" && keyOf[l])
      .map((l) => ({
        key: keyOf[l],
        label: l,
        kind: l === "回答" ? "answer" : "text",
        placeholder: l === "期限" ? "YYYY-MM-DD" : phField(l),
      }));
    const recorded = data.actual !== undefined ? data.actual : task.actual;
    const result = merged.result ?? "";
    new RetrospectiveModal(this.app, {
      taskTitle: stripTags(title),
      durationLabel: duration ? formatDuration(duration) : "時刻なし",
      actual: recorded,
      result,
      resultPlaceholder: phField("結果"),
      retroPlaceholder: phField("ふりかえり"),
      extraFields,
      doneSteps: (merged.steps ?? []).filter((st) => st.done).map((st) => st.text),
      onSave: async (text, actual, resultText, extras) => {
        try {
          const patch: TaskDraft = { ...data };
          if (text) patch.retrospective = text;
          if (resultText.trim() !== (result ?? "").trim()) patch.result = resultText;
          if (actual !== undefined) patch.actual = actual;
          for (const [k, v] of Object.entries(extras)) (patch as unknown as Record<string, string>)[k] = v;
          const ok = await this.storeOf(task).update(date, task, patch);
          if (!ok) new Notice("完了の記録を保存できませんでした。ノートが変更された可能性があります。");
        } catch (e) {
          console.error(e);
          new Notice("完了の記録を保存できませんでした: " + String(e));
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
   * 続きのブロックを翌日・当日（同じノート）・Inbox のどれかに作る。実績・本文は今日の記録として残る。
   * 当日内は「1回目が終わらず、同じ日にもう一度取り組む」ためのもので、続きは未スケジュールで
   * 同じノートの末尾に入る（再スケジュールのトレイからタイムラインへドラッグして2回目の時刻を決める）
   */
  private async commitCarryOver(date: Date, task: Task, dest: CarryDest): Promise<void> {
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
      const toDate = dest === "inbox" ? INBOX_DATE : dest === "same-day" ? date : addDays(date, 1);
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
        // 未完了セット（Owner・期限・次アクション）も続きのブロックへ引き継ぐ（翌日に追えるように）
        ownerName: task.ownerName || undefined,
        due: task.due || undefined,
        nextAction: task.nextAction || undefined,
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
        const name = stripTags(task.title) || "(無題)";
        const rem = remaining.length ? `（残ステップ ${remaining.length} 件）` : "";
        new Notice(
          dest === "inbox"
            ? `「${name}」を Inbox へ持ち越しました${rem}`
            : dest === "same-day"
              ? `「${name}」の続きを当日に作りました${rem}。再スケジュールのトレイからタイムラインへドラッグして2回目の時刻を決められます`
              : `「${name}」を翌日へ持ち越しました${rem}。明日の未スケジュールのトレイに入ります`
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
      tagFieldSchema: this.plugin.settings.tagFieldSchema,
      validateRequiredOnSave: this.plugin.settings.validateRequiredOnSave,
      memberNames: this.plugin.settings.members.map((m) => m.name),
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
        // 時刻を外し、Inbox に入れた日を「登録日」として刻む（滞留日数を後から判定できるように）
        await inbox.update(INBOX_DATE, task, {
          ...(draft ?? this.draftOf(task)),
          start: null,
          end: null,
          registered: moment().format("YYYY-MM-DD"),
        });
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

/** 分を "6.5" のような小数1桁の時間表示に（日ヘッダーの予実合計用）。"9.0" は "9" に詰める */
function hoursDecimal(min: number): string {
  return (min / 60).toFixed(1).replace(/\.0$/, "");
}

/** 1日の消化度（本日のサマリー・連続達成・今週のグラフ用） */
interface DayStats {
  /** 数える対象の件数（自分のタスク。持ち越し済み [>] は除く） */
  total: number;
  done: number;
  /** 予定時間の合計と、そのうち完了したタスクぶん（分。時刻のあるタスクだけ） */
  plan: number;
  donePlan: number;
  /** 実績の合計（分）。持ち越し済み [>] のブロックに残した実績も、その日に働いた時間なので含める */
  actual: number;
  /** 達成率 0〜1。予定時間があれば時間ベース、無ければ件数ベース。タスクが無ければ null */
  ratio: number | null;
}

/**
 * その日のタスクから消化度を出す。メンバーの予定は他の人のものなので数えない。
 * 持ち越し [>] にしたタスクは「今日やる分」から外す（分母から消えるので、整理した分だけ達成率が上がる）
 */
function dayStats(tasks: Task[]): DayStats {
  let total = 0;
  let done = 0;
  let plan = 0;
  let donePlan = 0;
  let actual = 0;
  for (const t of tasks) {
    if (t.owner) continue;
    // 持ち越し済み [>] は件数・予定からは外すが、実績はその日に働いた時間なので足す
    //（当日内の持ち越しだと、1回目の実績が消えて見えるのが目立つ）
    actual += t.actual.reduce((m, r) => m + (r.end - r.start), 0);
    if (t.forwarded) continue;
    total++;
    const p = isScheduled(t) ? t.end - t.start : 0;
    plan += p;
    if (t.done) {
      done++;
      donePlan += p;
    }
  }
  const ratio = plan > 0 ? donePlan / plan : total > 0 ? done / total : null;
  return { total, done, plan, donePlan, actual, ratio };
}

/**
 * サマリーのステップの区切りに数えるステップ。空のステップ行は数えない。
 * 持ち越し済み [>] のタスクはチェック済みのステップだけ数える: 未チェックのものは続きのブロックへ
 * 引き継がれている（当日内なら同じ日に並ぶ）ので、両方数えると二重になる。
 * チェック済みのほうはその日にこなした分なので、持ち越しても消えないようにする
 */
function countedSteps(t: Task): TaskStep[] {
  return t.steps.filter((sp) => sp.text.trim() && (!t.forwarded || sp.done));
}

/** 今日の自分のタスクに書かれたステップの消化（持ち越し済み [>] はチェック済みだけ数える） */
function stepStats(tasks: Task[]): { total: number; done: number } {
  let total = 0;
  let done = 0;
  for (const t of tasks) {
    if (t.owner) continue;
    for (const sp of countedSteps(t)) {
      total++;
      if (sp.done) done++;
    }
  }
  return { total, done };
}

/** 進み具合に応じた一言（本日のサマリーの見出しの右端）。控えめに */
function summaryMessage(st: DayStats): string {
  if (!st.total) return "";
  if (st.done === st.total) return "おつかれさま！全部終わりました";
  if (st.done === 0) return "まずは 1 件";
  const r = st.ratio ?? 0;
  if (r >= 0.8) return "あと少し";
  if (r >= 0.5) return "折り返し";
  return "いい調子";
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
