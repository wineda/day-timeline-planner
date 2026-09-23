/**
 * 定期タスク: 曜日と時刻を決めたルールに従って、その日のノートにタスクを入れる。
 *
 * 発生日（日 × ルール）ごとの帳簿は recurringInstances の 1 つだけ:
 *   記録なし                     … 未反映（その日を表示すると入る）
 *   { blockId: null, override }  … 未反映・個別調整の予約あり
 *   { blockId: "…" }             … 反映済み（ノートのブロックを blockId で追う。detached なら個別調整済み）
 *   { blockId: null, skipped }   … この日は入れない（取り消し）
 * ノートのタスクとの照合は blockId だけで行い、タイトルの一致では照合しない
 * （手書きの同名タスクを定期タスクと取り違えて書き換えたり消したりしないため）。
 * 一覧・状態の確認・個別詳細の編集は recurring-view.ts の管理画面で行う。
 */
import { App, Modal, Notice, Setting } from "obsidian";
import type DayTimelinePlugin from "./main";
import type {
  DayTimelineSettings,
  RecurringInstance,
  RecurringOverride,
  RecurringRule,
  TagColor,
} from "./settings";
import {
  endOfDayFix,
  joinTitleAndTags,
  normalizeTagChoices,
  renderTagChips,
  setupTimeInput,
  splitKnownTags,
} from "./modal";
import { dateKey, errorText, formatDuration, minutesToHHMM, parseTimeInput, startOfDay } from "./util";
import { newBlockId } from "./markdown/id";
import { projectDisplayName, type ProjectRef } from "./project";
import type { Task, TaskDraft } from "./model";
import type { TaskStep } from "./markdown/blocks";

const WEEKDAY_JA = ["日", "月", "火", "水", "木", "金", "土"];

export function newRuleId(): string {
  return "rec-" + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);
}

/** 設定画面などに出す説明文（例: "毎週 月・水・金  09:00 - 09:30"） */
export function describeRule(rule: RecurringRule): string {
  const days = [...rule.weekdays].sort((a, b) => a - b);
  const dayText =
    days.length === 7
      ? "毎日"
      : days.length === 0
        ? "曜日未設定"
        : "毎週 " + days.map((d) => WEEKDAY_JA[d]).join("・");
  const time =
    rule.start !== null && rule.end !== null
      ? `${minutesToHHMM(rule.start)} - ${minutesToHHMM(rule.end)}`
      : "時刻なし（未スケジュール）";
  return `${dayText}　${time}`;
}

/** ルールの共通のステップ（空行を除いたテキストの一覧） */
export function ruleSteps(rule: RecurringRule): string[] {
  return (rule.steps ?? []).map((t) => t.trim()).filter(Boolean);
}

/** 共通のステップから、タスクに入れる未チェックのステップを組み立てる */
function buildRuleSteps(rule: RecurringRule): TaskStep[] {
  return ruleSteps(rule).map((text) => ({ text, done: false, children: [] }));
}

/**
 * タスクのステップがルールの共通のステップのままか
 * （チェック・追記・並べ替え・ぶら下がり行の追加をしていない）。
 * 共通のステップが無いルールでは「ステップが空のまま」を意味する
 */
export function stepsMatchRule(steps: TaskStep[], rule: RecurringRule): boolean {
  const texts = ruleSteps(rule);
  return (
    steps.length === texts.length &&
    steps.every(
      (st, i) => !st.done && !(st.children ?? []).length && st.text.trim() === texts[i]
    )
  );
}

/** "YYYY-MM-DD" のキーを日付に戻す。壊れていれば null */
export function dateFromKey(key: string): Date | null {
  const [y, m, d] = key.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

/** 発生日の記録（無ければ undefined） */
export function instanceOf(
  s: DayTimelineSettings,
  key: string,
  ruleId: string
): RecurringInstance | undefined {
  return s.recurringInstances[key]?.[ruleId];
}

/** 発生日の記録を書き込む */
export function setInstance(
  s: DayTimelineSettings,
  key: string,
  ruleId: string,
  inst: RecurringInstance
): void {
  const map = s.recurringInstances[key] ?? {};
  map[ruleId] = inst;
  s.recurringInstances[key] = map;
}

/** 発生日の記録を消す（空になった日付キーも消す） */
export function clearInstance(s: DayTimelineSettings, key: string, ruleId: string): void {
  const map = s.recurringInstances[key];
  if (!map) return;
  delete map[ruleId];
  if (!Object.keys(map).length) delete s.recurringInstances[key];
}

/** 記録を書き込む前の状態に戻す（ノートに書けなかった回の後始末。前の記録が無ければ消す） */
function restoreInstance(
  s: DayTimelineSettings,
  key: string,
  ruleId: string,
  prev: RecurringInstance | undefined
): void {
  if (prev) setInstance(s, key, ruleId, prev);
  else clearInstance(s, key, ruleId);
}

/**
 * 時刻欄の 2 つの入力を読む（ルールのフォームと管理画面の個別調整で共用）。
 * 両方空なら「時刻なし」。終了が開始より前なら翌日 0:00 までの範囲として補正する（endOfDayFix）
 */
export function parseTimeRange(
  startText: string,
  endText: string
): { start: number | null; end: number | null } | { error: string } {
  if (startText.trim() === "" && endText.trim() === "") return { start: null, end: null };
  const start = parseTimeInput(startText);
  let end = parseTimeInput(endText);
  if (start === null || end === null) return { error: "時刻は 09:00 のように入力してください" };
  end = endOfDayFix(start, end);
  if (end <= start) return { error: "終了時刻は開始時刻より後にしてください" };
  return { start, end };
}

/** applyRecurring の直列化用。複数のビューが同時に呼んでも 1 つずつ処理し、同じ回を二重に入れない */
let applyTail: Promise<unknown> = Promise.resolve();

/**
 * 表示中の日のうち今日以降について、まだ入れていない定期タスクをノートに書き込む。
 * force = true なら設定「定期タスクを自動で入れる」がオフでも書き込む（管理画面の明示操作用）。
 * 書き込んだ件数を返す。呼び出しは直列に処理される
 */
export function applyRecurring(plugin: DayTimelinePlugin, days: Date[], force = false): Promise<number> {
  const run = applyTail.then(() => applyRecurringNow(plugin, days, force));
  applyTail = run.catch(() => undefined);
  return run;
}

/** 書き込む回（帳簿に記録してからノートに書く） */
interface PlannedOccurrence {
  day: Date;
  key: string;
  rule: RecurringRule;
  draft: TaskDraft;
  blockId: string;
  /** 記録する前の状態（書けなかったときに戻す） */
  prev: RecurringInstance | undefined;
}

async function applyRecurringNow(plugin: DayTimelinePlugin, days: Date[], force: boolean): Promise<number> {
  const s = plugin.settings;
  if (!s.autoApplyRecurring && !force) return 0;
  const rules = s.recurring.filter((r) => r.enabled && r.title.trim() && r.weekdays.length);
  if (!rules.length) return 0;
  const today = startOfDay(new Date());
  const store = plugin.blockStore();

  // 1. 入れる回を決め、帳簿に先に記録して保存する。ノートに書く前に記録するので、
  //    途中で落ちても同じ回を二重に入れることはない（記録だけ残って書けなかった回は
  //    管理画面に「削除されています」と出て、「入れ直す」で回復できる）
  const planned: PlannedOccurrence[] = [];
  for (const day of days) {
    if (day < today) continue;
    const key = dateKey(day);
    for (const rule of rules) {
      if (!rule.weekdays.includes(day.getDay())) continue;
      const inst = instanceOf(s, key, rule.id);
      if (inst?.skipped || inst?.blockId) continue; // 取り消し済み / すでに書き込み済み
      // 個別の上書き（管理画面の「個別詳細」）があればそちらを使う
      const ov = inst?.override;
      const start = ov && ov.start !== undefined ? ov.start : rule.start;
      const end = ov && ov.end !== undefined ? ov.end : rule.end;
      const details = ov?.details !== undefined ? ov.details : rule.details ?? "";
      const steps = buildRuleSteps(rule);
      const blockId = newBlockId();
      planned.push({
        day,
        key,
        rule,
        blockId,
        prev: inst,
        draft: {
          title: rule.title,
          start,
          end,
          done: false,
          project: rule.project ?? undefined,
          details: details.trim() ? details : undefined,
          steps: steps.length ? steps : undefined,
        },
      });
      setInstance(s, key, rule.id, {
        blockId,
        // 時刻を個別に変えていた回は、以後ルール編集で上書きしない
        ...(ov && (ov.start !== undefined || ov.end !== undefined) ? { detached: true } : {}),
      });
    }
  }
  if (!planned.length) return 0;
  pruneOld(s.recurringInstances, today);
  try {
    await plugin.persistSettings();
  } catch (e) {
    // 帳簿を保存できなければ何も書かない（メモリ上の記録も戻す）
    for (const p of planned) restoreInstance(s, p.key, p.rule.id, p.prev);
    throw e;
  }

  // 2. ノートに書く。書けなかった回は記録を戻して、次に表示したときにもう一度入れる
  let count = 0;
  let rolledBack = false;
  for (const p of planned) {
    try {
      await store.createWithId(p.day, p.draft, p.blockId);
      count++;
    } catch (e) {
      console.error(e);
      new Notice(`定期タスク「${p.rule.title}」を入れられませんでした: ${errorText(e)}`);
      restoreInstance(s, p.key, p.rule.id, p.prev);
      rolledBack = true;
    }
  }
  if (rolledBack) {
    try {
      await plugin.persistSettings();
    } catch (e) {
      console.error(e);
    }
  }
  return count;
}

/**
 * その日の分を取り消す。書き込み済みならノートのタスクも消す。
 * タスクを消したら true を返す（まだ書き込まれていなければ false のまま成功）。
 */
export async function skipOccurrence(
  plugin: DayTimelinePlugin,
  rule: RecurringRule,
  date: Date
): Promise<boolean> {
  const s = plugin.settings;
  const key = dateKey(date);
  const inst = instanceOf(s, key, rule.id);
  let removed = false;
  if (inst?.blockId) {
    try {
      const store = plugin.blockStore();
      const t = (await store.load(date)).tasks.find((x) => x.blockId === inst.blockId);
      if (t) removed = await store.remove(date, t);
    } catch (e) {
      console.error(e);
    }
  }
  setInstance(s, key, rule.id, { blockId: null, skipped: true });
  await plugin.persistSettings();
  return removed;
}

/**
 * 取り消し・削除された日の記録を消して、その日の分をすぐ入れ直す。
 * 入れられたら true（今日より前の日には入れない）。
 */
export async function reapplyOccurrence(
  plugin: DayTimelinePlugin,
  rule: RecurringRule,
  date: Date
): Promise<boolean> {
  const s = plugin.settings;
  clearInstance(s, dateKey(date), rule.id);
  await plugin.persistSettings();
  const n = await applyRecurring(plugin, [startOfDay(date)], true);
  return n > 0;
}

/**
 * タイムラインなどでタスクが削除されたとき、それが定期タスクの回だったら
 * 「その日は取り消した」として記録する（未反映との区別が付くように）。
 */
export async function noteRecurringDeletion(
  plugin: DayTimelinePlugin,
  date: Date,
  task: Task
): Promise<void> {
  if (!task.blockId || task.owner) return;
  const key = dateKey(date);
  const map = plugin.settings.recurringInstances[key];
  if (!map) return;
  for (const [ruleId, inst] of Object.entries(map)) {
    if (inst.blockId !== task.blockId) continue;
    map[ruleId] = { blockId: null, skipped: true };
    await plugin.persistSettings();
    return;
  }
}

// ---------------------------------------------------------------------------
// 発生日ごとの状態
// ---------------------------------------------------------------------------

export type OccurrenceKind =
  | "pending" // 未反映（その日を表示すると入る）
  | "pending-custom" // 未反映・個別調整の予約あり
  | "applied" // 反映済み
  | "applied-custom" // 反映済み・個別調整あり
  | "skipped" // この日は取り消し済み
  | "missing"; // 反映した記録はあるがタスクが見つからない（削除・移動）

export interface OccurrenceInfo {
  kind: OccurrenceKind;
  /** ノートに書き込まれているタスク（applied / applied-custom のとき） */
  task: Task | null;
  /** 未反映の日の個別上書き（pending-custom のとき） */
  override: RecurringOverride | null;
}

/** その日 × ルールの状態を調べる。preloaded にその日のタスク一覧を渡すと読み直さない */
export async function occurrenceInfo(
  plugin: DayTimelinePlugin,
  rule: RecurringRule,
  date: Date,
  preloaded?: Task[]
): Promise<OccurrenceInfo> {
  const inst = instanceOf(plugin.settings, dateKey(date), rule.id);
  if (inst?.skipped) return { kind: "skipped", task: null, override: null };
  if (!inst?.blockId) {
    return {
      kind: inst?.override ? "pending-custom" : "pending",
      task: null,
      override: inst?.override ?? null,
    };
  }
  let tasks = preloaded;
  if (!tasks) {
    try {
      tasks = (await plugin.blockStore().load(date)).tasks;
    } catch (e) {
      console.error(e);
      tasks = [];
    }
  }
  // 照合は blockId だけ（同名の手書きタスクを定期タスクとは見なさない）
  const task = tasks.find((t) => t.blockId === inst.blockId) ?? null;
  if (!task) return { kind: "missing", task: null, override: null };
  return { kind: inst.detached ? "applied-custom" : "applied", task, override: null };
}

/** 状態の短い表示名 */
export function describeOccurrence(kind: OccurrenceKind): string {
  switch (kind) {
    case "pending":
      return "未反映";
    case "pending-custom":
      return "未反映・個別調整あり";
    case "applied":
      return "反映済み";
    case "applied-custom":
      return "反映済み・個別調整あり";
    case "skipped":
      return "取り消し";
    case "missing":
      return "削除されています";
  }
}

/** 古い記録を捨てる（90日より前） */
function pruneOld(rec: Record<string, unknown>, today: Date): void {
  const limit = dateKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 90));
  for (const k of Object.keys(rec)) {
    if (k < limit) delete rec[k];
  }
}

// ---------------------------------------------------------------------------
// ルール編集の反映
// ---------------------------------------------------------------------------

export interface PropagateResult {
  /** タイトル・時刻などを書き換えた件数 */
  updated: number;
  /** 曜日から外れたので削除した件数 */
  removed: number;
  /** 個別調整済みのため触らなかった件数 */
  keptCustom: number;
  /** 手で編集されていたので残した件数（曜日から外れた日） */
  keptEdited: number;
}

/**
 * ルールの編集を、すでにノートへ書き込んだ「今日以降」のタスクに反映する。
 * - タイトル・時刻（・ルールにあればプロジェクト）を書き換える
 * - 共通の詳細は、その日の本文を手で変えていないときだけ書き換える
 * - 個別調整（detached）の日は触らない
 * - 曜日から外れた日は、ルール由来のまま手つかずならタスクごと消す（編集済みなら残す）
 * 対象は帳簿に blockId のある回だけ。ノートにそのブロックが無い日（削除・移動）は触らない
 */
export async function propagateRecurringUpdate(
  plugin: DayTimelinePlugin,
  rule: RecurringRule,
  prev?: RecurringRule
): Promise<PropagateResult> {
  const s = plugin.settings;
  const store = plugin.blockStore();
  const todayKey = dateKey(startOfDay(new Date()));
  const result: PropagateResult = { updated: 0, removed: 0, keptCustom: 0, keptEdited: 0 };
  let touched = false;
  for (const key of Object.keys(s.recurringInstances).sort()) {
    if (key < todayKey) continue;
    const inst = instanceOf(s, key, rule.id);
    if (!inst?.blockId || inst.skipped) continue; // 未反映・取り消しの日は対象外
    const date = dateFromKey(key);
    if (!date) continue;
    let task: Task | null;
    try {
      task = (await store.load(date)).tasks.find((t) => t.blockId === inst.blockId) ?? null;
    } catch (e) {
      console.error(e);
      continue;
    }
    if (!task) continue; // 消されている日は触らない（管理画面には「削除されています」と出る）
    if (!rule.weekdays.includes(date.getDay())) {
      if (prev && isUntouched(task, prev)) {
        try {
          if (await store.remove(date, task)) {
            result.removed++;
            clearInstance(s, key, rule.id);
            touched = true;
          }
        } catch (e) {
          console.error(e);
        }
      } else {
        result.keptEdited++;
      }
      continue;
    }
    if (inst.detached) {
      result.keptCustom++;
      continue;
    }
    const patch: {
      title: string;
      start: number | null;
      end: number | null;
      project?: string;
      details?: string;
      steps?: TaskStep[];
    } = {
      title: rule.title,
      start: rule.start,
      end: rule.end,
      // プロジェクトは、ルールに設定があるときだけ合わせる（手で付けたものは消さない）
      ...(rule.project ? { project: rule.project } : {}),
    };
    const prevDetails = (prev?.details ?? "").trim();
    const nextDetails = (rule.details ?? "").trim();
    if (prev && nextDetails !== prevDetails && task.details.trim() === prevDetails) {
      patch.details = rule.details ?? "";
    }
    // 共通のステップも詳細と同じ約束: その回のステップに手を付けていないときだけ差し替える
    const prevSteps = prev ? ruleSteps(prev) : [];
    if (
      prev &&
      ruleSteps(rule).join("\n") !== prevSteps.join("\n") &&
      stepsMatchRule(task.steps, prev)
    ) {
      patch.steps = buildRuleSteps(rule);
    }
    try {
      if (await store.updateByBlockId(date, inst.blockId, patch)) result.updated++;
    } catch (e) {
      console.error(e);
    }
  }
  if (touched) await plugin.persistSettings();
  return result;
}

/** ルール由来のまま手を付けていないか（曜日変更で消してよいかの判定） */
function isUntouched(task: Task, rule: RecurringRule): boolean {
  return (
    !task.done &&
    !task.forwarded &&
    task.title === rule.title &&
    task.start === rule.start &&
    task.end === rule.end &&
    task.details.trim() === (rule.details ?? "").trim() &&
    task.actual.length === 0 &&
    stepsMatchRule(task.steps, rule) &&
    task.retrospective.trim() === "" &&
    task.doneCondition.trim() === ""
  );
}

/** ルール編集を反映して、結果を必ず通知する（「反映されたか分からない」をなくす） */
export async function propagateAndNotify(
  plugin: DayTimelinePlugin,
  rule: RecurringRule,
  prev?: RecurringRule
): Promise<PropagateResult> {
  const r = await propagateRecurringUpdate(plugin, rule, prev);
  const parts: string[] = [];
  if (r.updated) parts.push(`${r.updated} 件を書き換え`);
  if (r.removed) parts.push(`曜日から外れた ${r.removed} 件を削除`);
  if (r.keptCustom) parts.push(`個別調整の ${r.keptCustom} 件はそのまま`);
  if (r.keptEdited) parts.push(`編集済みの ${r.keptEdited} 件は残しました`);
  new Notice(
    parts.length
      ? `ルールを保存しました。今日以降の書き込み済みタスク: ${parts.join("・")}`
      : "ルールを保存しました（今日以降に書き換える対象はありません）"
  );
  return r;
}

// ---------------------------------------------------------------------------
// ルールの入力フォーム（追加・編集ダイアログと管理画面で共用）
// ---------------------------------------------------------------------------

export interface RuleFormOptions {
  /** 編集するルール。無ければ新規 */
  initial?: RecurringRule;
  /** 新規のときの初期値（タスクから「定期タスクとして登録」したとき） */
  preset?: {
    title: string;
    start: number | null;
    end: number | null;
    weekday?: number;
    project?: string | null;
    /** 共通のステップの初期値（タスクのステップを引き継ぐとき） */
    steps?: string[];
  };
  tagChoices?: TagColor[];
  /** プロジェクトの選択肢（渡すと欄を出す） */
  projects?: ProjectRef[];
  /** 「有効」トグルを出すか。既定は initial があるとき */
  showEnabled?: boolean;
  /** Enter キーで呼ぶ（モーダルの送信用） */
  onEnter?: () => void;
}

/** タイトル・タグ・曜日・時刻・共通の詳細などの入力欄。build() でルールに組み立てる */
export class RuleForm {
  private opts: RuleFormOptions;
  private title: string;
  private weekdays: Set<number>;
  private startText: string;
  private endText: string;
  private enabled: boolean;
  private project: string | null;
  private details: string;
  /** 共通のステップ（テキストエリアの内容。1行 = 1ステップ） */
  private steps: string;
  private tagChoices: TagColor[];
  private selectedTags: Set<string>;
  private hintEl: HTMLElement | null = null;

  constructor(opts: RuleFormOptions) {
    this.opts = opts;
    this.tagChoices = normalizeTagChoices(opts.tagChoices);
    const src = opts.initial ?? {
      id: "",
      title: opts.preset?.title ?? "",
      weekdays: opts.preset?.weekday !== undefined ? [opts.preset.weekday] : [1, 2, 3, 4, 5],
      start: opts.preset?.start ?? 9 * 60,
      end: opts.preset?.end ?? 9 * 60 + 30,
      enabled: true,
      project: opts.preset?.project ?? undefined,
      steps: opts.preset?.steps,
    };
    const { text, selected } = splitKnownTags(src.title, this.tagChoices.map((c) => c.tag));
    this.title = text;
    this.selectedTags = selected;
    this.weekdays = new Set(src.weekdays);
    this.startText = src.start === null ? "" : minutesToHHMM(src.start);
    this.endText = src.end === null ? "" : minutesToHHMM(src.end);
    this.enabled = src.enabled;
    this.project = src.project ?? null;
    this.details = src.details ?? "";
    this.steps = (src.steps ?? []).join("\n");
  }

  render(contentEl: HTMLElement): void {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.isComposing && this.opts.onEnter) {
        e.preventDefault();
        this.opts.onEnter();
      }
    };

    new Setting(contentEl).setName("タイトル").addText((t) => {
      t.setPlaceholder("例: 朝会")
        .setValue(this.title)
        .onChange((v) => (this.title = v));
      t.inputEl.addClass("dt-title-input");
      t.inputEl.addEventListener("keydown", onKey);
      window.setTimeout(() => t.inputEl.focus(), 0);
    });

    if (this.tagChoices.length) {
      const tagSetting = new Setting(contentEl).setName("タグ");
      tagSetting.settingEl.addClass("dt-tag-setting");
      renderTagChips(tagSetting.controlEl, this.tagChoices, this.selectedTags);
    }

    if (this.opts.projects?.length || this.project) {
      const projects = this.opts.projects ?? [];
      new Setting(contentEl)
        .setName("プロジェクト")
        .setDesc("作られるタスクをプロジェクト（大きなタスク）に結びつけます。")
        .addDropdown((d) => {
          d.addOption("", "なし");
          // 完了済のプロジェクトは選択肢に出さない（既に選ばれているものは表示を保つ）
          for (const p of projects) {
            if (p.done && p.linktext !== this.project) continue;
            d.addOption(p.linktext, p.done ? p.name + "（完了）" : p.name);
          }
          if (this.project && !projects.some((p) => p.linktext === this.project)) {
            d.addOption(this.project, projectDisplayName(this.project));
          }
          d.setValue(this.project ?? "").onChange((v) => (this.project = v || null));
        });
    }

    // 曜日
    const daySetting = new Setting(contentEl).setName("曜日");
    daySetting.settingEl.addClass("dt-tag-setting");
    const dayWrap = daySetting.controlEl.createDiv("dt-weekday-chips");
    const dayBtns: HTMLElement[] = [];
    const paintDays = () =>
      dayBtns.forEach((b, i) => {
        b.toggleClass("is-selected", this.weekdays.has(i));
        b.setAttr("aria-pressed", String(this.weekdays.has(i)));
      });
    WEEKDAY_JA.forEach((name, i) => {
      const b = dayWrap.createEl("button", {
        cls: "dt-tag-chip dt-weekday-chip",
        text: name,
        attr: { type: "button" },
      });
      b.toggleClass("is-sunday", i === 0);
      b.toggleClass("is-saturday", i === 6);
      b.onclick = () => {
        if (this.weekdays.has(i)) this.weekdays.delete(i);
        else this.weekdays.add(i);
        paintDays();
      };
      dayBtns.push(b);
    });
    const presets = daySetting.controlEl.createDiv("dt-weekday-presets");
    const preset = (label: string, days: number[]) => {
      const b = presets.createEl("button", {
        text: label,
        cls: "dt-weekday-preset",
        attr: { type: "button" },
      });
      b.onclick = () => {
        this.weekdays = new Set(days);
        paintDays();
      };
    };
    preset("毎日", [0, 1, 2, 3, 4, 5, 6]);
    preset("平日", [1, 2, 3, 4, 5]);
    preset("週末", [0, 6]);
    paintDays();

    // 時刻
    const timeSetting = new Setting(contentEl).setName("時間");
    timeSetting.addText((t) => {
      t.setPlaceholder("09:00")
        .setValue(this.startText)
        .onChange((v) => {
          this.startText = v;
          this.updateHint();
        });
      t.inputEl.addClass("dt-time-input");
      setupTimeInput(t.inputEl);
      t.inputEl.addEventListener("keydown", onKey);
    });
    timeSetting.controlEl.createSpan({ text: "〜", cls: "dt-modal-tilde" });
    timeSetting.addText((t) => {
      t.setPlaceholder("09:30")
        .setValue(this.endText)
        .onChange((v) => {
          this.endText = v;
          this.updateHint();
        });
      t.inputEl.addClass("dt-time-input");
      setupTimeInput(t.inputEl);
      t.inputEl.addEventListener("keydown", onKey);
    });
    timeSetting.addExtraButton((b) =>
      b
        .setIcon("timer-off")
        .setTooltip("時刻を外して「未スケジュール」として入れる")
        .onClick(() => {
          this.startText = "";
          this.endText = "";
          timeSetting.controlEl
            .querySelectorAll("input")
            .forEach((i) => ((i as HTMLInputElement).value = ""));
          this.updateHint();
        })
    );
    this.hintEl = timeSetting.descEl;
    this.updateHint();

    // 共通の詳細
    const detailSetting = new Setting(contentEl).setName("共通の詳細");
    detailSetting.setDesc("毎回のタスクの本文（詳細）に入れるメモ。回ごとの内容は管理画面の「個別詳細」で書けます。");
    detailSetting.settingEl.addClass("dt-rec-details-setting");
    const ta = detailSetting.controlEl.createEl("textarea", {
      cls: "dt-rec-details-field",
      attr: { rows: "3", placeholder: "例: - アジェンダを確認\n- 議事録リンク" },
    });
    ta.value = this.details;
    ta.addEventListener("input", () => (this.details = ta.value));

    // 共通のステップ（通常のタスクのステップと同じく、未チェックのチェックリストとして毎回入る）
    const stepSetting = new Setting(contentEl).setName("共通のステップ");
    stepSetting.setDesc(
      "1行に1ステップ。毎回のタスクに未チェックのステップ（- [ ] …）として入ります。回ごとのチェックはタスクの編集ダイアログで。"
    );
    stepSetting.settingEl.addClass("dt-rec-details-setting");
    const stepTa = stepSetting.controlEl.createEl("textarea", {
      cls: "dt-rec-details-field",
      attr: { rows: "3", placeholder: "例: アジェンダを確認\n議事録を書く" },
    });
    stepTa.value = this.steps;
    stepTa.addEventListener("input", () => (this.steps = stepTa.value));

    if (this.opts.showEnabled ?? !!this.opts.initial) {
      new Setting(contentEl)
        .setName("有効")
        .addToggle((t) => t.setValue(this.enabled).onChange((v) => (this.enabled = v)));
    }
  }

  private parse(): { start: number | null; end: number | null } | { error: string } {
    return parseTimeRange(this.startText, this.endText);
  }

  private updateHint(): void {
    if (!this.hintEl) return;
    const r = this.parse();
    if ("error" in r) {
      this.hintEl.setText(r.error);
      this.hintEl.addClass("is-error");
    } else if (r.start === null) {
      this.hintEl.setText("時刻なし（未スケジュールのトレイに入ります）");
      this.hintEl.removeClass("is-error");
    } else {
      this.hintEl.setText(`所要時間: ${formatDuration((r.end as number) - r.start)}`);
      this.hintEl.removeClass("is-error");
    }
  }

  /** 入力からルールを組み立てる。問題があればエラーメッセージ */
  build(): { rule: RecurringRule } | { error: string } {
    const r = this.parse();
    if ("error" in r) return r;
    const title = joinTitleAndTags(this.title, this.tagChoices, this.selectedTags);
    if (!title) return { error: "タイトルを入力してください" };
    if (this.weekdays.size === 0) return { error: "曜日を1つ以上選んでください" };
    const details = this.details.replace(/\s+$/, "");
    const steps = this.steps
      .split("\n")
      .map((t) => t.trim())
      .filter(Boolean);
    return {
      rule: {
        id: this.opts.initial?.id || newRuleId(),
        title,
        weekdays: [...this.weekdays].sort((a, b) => a - b),
        start: r.start,
        end: r.end,
        enabled: this.enabled,
        project: this.project ?? undefined,
        ...(details ? { details } : {}),
        ...(steps.length ? { steps } : {}),
      },
    };
  }
}

// ---------------------------------------------------------------------------
// ルールの追加・編集ダイアログ
// ---------------------------------------------------------------------------

export interface RecurringModalOptions {
  /** 編集するルール。無ければ新規 */
  initial?: RecurringRule;
  /** 新規のときの初期値（タスクから「定期タスクとして登録」したとき） */
  preset?: RuleFormOptions["preset"];
  tagChoices?: TagColor[];
  /** プロジェクトの選択肢（渡すと欄を出す） */
  projects?: ProjectRef[];
  onSubmit: (rule: RecurringRule) => void | Promise<void>;
}

export class RecurringModal extends Modal {
  private opts: RecurringModalOptions;
  private form: RuleForm;

  constructor(app: App, opts: RecurringModalOptions) {
    super(app);
    this.opts = opts;
    this.form = new RuleForm({
      initial: opts.initial,
      preset: opts.preset,
      tagChoices: opts.tagChoices,
      projects: opts.projects,
      onEnter: () => void this.submit(),
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    this.modalEl.addClass("dt-modal");
    this.titleEl.setText(this.opts.initial ? "定期タスクを編集" : "定期タスクを追加");
    this.form.render(contentEl);

    const buttons = new Setting(contentEl);
    buttons.settingEl.addClass("dt-modal-buttons");
    buttons.addButton((b) => b.setButtonText("キャンセル").onClick(() => this.close()));
    buttons.addButton((b) =>
      b
        .setButtonText(this.opts.initial ? "保存" : "追加")
        .setCta()
        .onClick(() => void this.submit())
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async submit(): Promise<void> {
    const r = this.form.build();
    if ("error" in r) {
      new Notice(r.error);
      return;
    }
    this.close();
    await this.opts.onSubmit(r.rule);
  }
}
