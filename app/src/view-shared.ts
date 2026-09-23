/**
 * タイムラインビュー（view.ts）と、その責務ごとの分割ファイル（view-sidebar / view-pointer / view-actions）が
 * 共通で使う型・定数・小さなヘルパー。ビューのファイル同士は互いに import しないよう、ここに集める
 */
import { Platform, type HoverParent, type HoverPopover, type Menu, type MenuItem } from "obsidian";
import { Task, isScheduled } from "./model";
import type { TaskStep } from "./markdown/blocks";
import type { ViewMode } from "./settings";

/** プロジェクト名のノートプレビューの hover-link ソース ID。
 * ホバーではなく Ctrl/Cmd + クリックで出す（showProjectPreview）。表示自体はコアプラグイン
 * 「ページプレビュー」に任せるため、hover-link のソースとして登録しておく */
export const PROJECT_HOVER_SOURCE = "day-timeline-planner-project";

/** プロジェクトノートのプレビューのポップアップに付けるクラス（styles.css で通常のプレビューより大きく表示する） */
export const PROJECT_PREVIEW_CLASS = "dt-project-preview";

/**
 * プロジェクト名のプレビュー用の hover-link の親（HoverParent）。
 * ページプレビューはポップアップ（HoverPopover）を作るとき親の hoverPopover に代入してくるので、
 * そのタイミングでポップアップの要素にクラスを付け、CSS で通常のプレビューより大きく表示する。
 * タスクブロックのプレビュー（親はビュー自身）とは分けているので、そちらの大きさは変わらない。
 */
export class ProjectHoverParent implements HoverParent {
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

export interface DragHandlers {
  onMove?: (dy: number, ev: PointerEvent) => void;
  onEnd: (moved: boolean, ev: PointerEvent) => void;
  onCancel?: () => void;
}

/** 1日分の列 */
export interface DayColumn {
  date: Date;
  key: string;
  headerEl: HTMLElement;
  canvasEl: HTMLElement;
  eventsEl: HTMLElement;
  nowEl: HTMLElement | null;
  /** この列が属する段 */
  row: TimelineRow;
}

/** タイムラインの1段（曜日ヘッダー + 時間軸 + 日の列）。いまは常に1段 */
export interface TimelineRow {
  /** 段の入れ物。sticky なヘッダーはこの中で止まり、次の段に押し出される */
  el: HTMLElement;
  headersEl: HTMLElement;
  labelsEl: HTMLElement;
  daysEl: HTMLElement;
  columns: DayColumn[];
  /** 現在時刻: 全列をまたぐ細い線と、時刻の目盛りに出す「17:58」（今日がこの段にあるときだけ） */
  nowLineEl: HTMLElement | null;
  nowLabelEl: HTMLElement | null;
}

/** 1日分の読み込み結果 */
export interface DayData {
  tasks: Task[];
  exists: boolean;
  legacyCount: number;
}

export const WEEKDAY_JA = ["日", "月", "火", "水", "木", "金", "土"];

/** 「Inbox・時刻なし」の一覧のために、過去何日ぶんのノートから時刻なしタスクを拾うか */
export const RESCHEDULE_LOOKBACK_DAYS = 30;

/** ビューの幅（px）がこれ未満なら「狭い画面」（スマホなど）。
 * サイドバーとタイムラインを並べると共倒れになるので、片方だけを全面に出して切り替える */
export const NARROW_VIEW_WIDTH = 500;

/** サイドバー（Inbox・プロジェクト）の幅の下限（px） */
export const SIDEBAR_MIN_WIDTH = 160;
/** サイドバーの幅の上限（px）。実際の上限はビューの幅からも決まる（maxSidebarWidth） */
export const SIDEBAR_MAX_WIDTH = 800;

/** 本日のサマリーのバーをタスクごとに区切る上限。これより多いと区切り線だけになるので1本の棒にする */
export const MAX_SUMMARY_SEGMENTS = 40;

/** タッチでこれ以上（px）動いたら「タップ・長押し」ではなくスクロール等とみなす */
export const TOUCH_SLOP = 10;
/** タッチの長押し（ここからドラッグ）と判定するまでの時間（ms）。
 * Android が contextmenu を発火する長押し（約 500ms）より先に確定させる */
export const LONG_PRESS_MS = 350;
/** 横スワイプで前後の日へ移動するのに必要な移動量（px） */
export const SWIPE_MIN_X = 48;

/** Ctrl+ホイールのズーム感度。1ノッチ（deltaY=100）で約 1.16 倍になる */
export const WHEEL_ZOOM_INTENSITY = 0.0015;

/** 狭い画面で全面に出す面 */
export type NarrowPane = "timeline" | "panel";

/** 表示モードの並び順と、セグメント用の短いラベル・メニュー用のラベル */
export const VIEW_MODES: [ViewMode, string, string][] = [
  ["day", "日", "日表示"],
  ["3day", "3日", "3日表示"],
  ["week", "週", "週表示"],
];



/** 分を "6:30" のような時:分表示に（日ヘッダーの予実合計用） */
export function hmm(min: number): string {
  return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}`;
}

/** 分を "1.5" のような時間の小数表示に（予実合計の補助表示用） */
export function hoursDecimal(min: number): string {
  return (min / 60).toFixed(1).replace(/\.0$/, "");
}

/** 1日の消化度（本日のサマリー用） */
export interface DayStats {
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
export function dayStats(tasks: Task[]): DayStats {
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
export function countedSteps(t: Task): TaskStep[] {
  return t.steps.filter((sp) => sp.text.trim() && (!t.forwarded || sp.done));
}

/** 今日の自分のタスクに書かれたステップの消化（持ち越し済み [>] はチェック済みだけ数える） */
export function stepStats(tasks: Task[]): { total: number; done: number } {
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
export function summaryMessage(st: DayStats): string {
  if (!st.total) return "";
  if (st.done === st.total) return "おつかれさま！全部終わりました";
  if (st.done === 0) return "まずは 1 件";
  const r = st.ratio ?? 0;
  if (r >= 0.8) return "あと少し";
  if (r >= 0.5) return "折り返し";
  return "いい調子";
}

/** 移動の途中で元のノートが変わっていたとき（transferTo が "conflict" を返したとき）の通知 */
export const TRANSFER_CONFLICT_MESSAGE =
  "移動中にノートが変更されたため、移動を取り消しました。もう一度お試しください。";

/**
 * 非同期処理を1つずつ順番に実行するキュー。
 * 編集ダイアログの自動保存と、閉じる・削除などの操作が同じノートに重ならないようにする
 */
export function serialQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => T | Promise<T>): Promise<T> => {
    const run = tail.then(fn);
    tail = run.catch(() => undefined);
    return run;
  };
}

/**
 * 責務ごとに分けたメソッド群（ミックスイン）を 1 つのクラスに合成する。
 * 各ミックスインは this を DayTimelineView として書いた通常のクラスで、
 * ここでプロトタイプのメソッドをビューのプロトタイプへ写す（実行時のオブジェクトは 1 つのまま）
 */
export function applyMixins(target: { prototype: object }, mixins: { prototype: object }[]): void {
  for (const m of mixins) {
    for (const name of Object.getOwnPropertyNames(m.prototype)) {
      if (name === "constructor") continue;
      const desc = Object.getOwnPropertyDescriptor(m.prototype, name);
      if (desc) Object.defineProperty(target.prototype, name, desc);
    }
  }
}

/** MenuItem.setSubmenu は Obsidian の公開 API には無い（実装にはある）ので、あるときだけ使う */
type SubmenuCapable = MenuItem & { setSubmenu?: () => Menu };

/**
 * サブメニュー付きの項目を足す。デスクトップで setSubmenu が使えればサブメニューに、
 * スマホや使えないときは見出し（ラベル）の下に平らに並べる
 */
export function addSubmenu(menu: Menu, title: string, icon: string, build: (sub: Menu) => void): void {
  let sub = null as Menu | null;
  menu.addItem((item) => {
    item.setTitle(title).setIcon(icon);
    const capable = item as SubmenuCapable;
    if (!Platform.isMobile && typeof capable.setSubmenu === "function") sub = capable.setSubmenu();
    else item.setIsLabel(true);
  });
  build(sub ?? menu);
}
