/**
 * ビューが扱うタスクの型。
 * 保存形式（ブロック形式 / 旧リスト形式）の違いは TaskSource が吸収する。
 */
import type { TFile } from "obsidian";
import type { ListEvent } from "./markdown/legacy";
import type { ActualRange, ReminderSetting, TaskStep, TicketRef } from "./markdown/blocks";

/** ソースだけが解釈する参照情報 */
export type TaskRefData =
  | {
      kind: "block";
      id: string | null;
      title: string;
      start: number | null;
      end: number | null;
    }
  | { kind: "list"; event: ListEvent };

export interface Task {
  /** 同一性の鍵（描画とメニューの照合に使う） */
  key: string;
  title: string;
  /** 0:00 からの分。null なら未スケジュール */
  start: number | null;
  end: number | null;
  done: boolean;
  /** タイムラインに出す短い本文プレビュー */
  preview: string;
  /** ノート内のブロックID（`^` は含まない）。無ければ null */
  blockId: string | null;
  /** タイトル・メタ行・本文に書かれたタグ（"#" 抜き）。色分けに使う */
  tags: string[];
  /** リマインド: 分前 / "off" / null = 既定 */
  reminder: ReminderSetting;
  /** 完了条件（ブロック形式のみ。無ければ ""） */
  doneCondition: string;
  /** ステップ（ブロック形式のみ） */
  steps: TaskStep[];
  /** ふりかえり（ブロック形式のみ。無ければ ""） */
  retrospective: string;
  /** 結果 = 何がどこまで終わったか（ブロック形式のみ。無ければ ""） */
  result: string;
  /** 残 = 完了後に残った作業（ブロック形式のみ。無ければ ""） */
  remaining: string;
  /** 登録日（Inbox に入れた日。ブロック形式のみ。無ければ ""） */
  registered: string;
  /** 実績 = 実際に作業した時間帯（ブロック形式のみ。無ければ []） */
  actual: ActualRange[];
  /** プロジェクト（大きなタスク）ノートへのリンク先（ブロック形式のみ。無ければ null） */
  project: string | null;
  /** 持ち越し済み（チェックが [>]）。完了でも未完了でもない「翌日へ送った」状態 */
  forwarded: boolean;
  /** 持ち越し先ブロックへのリンク（無ければ null） */
  carryTo: string | null;
  /** 持ち越し元ブロックへのリンク（無ければ null） */
  carryFrom: string | null;
  /** 詳細 = 自由な本文（ブロック形式のみ。Markdown、複数行可） */
  details: string;
  /** チケット（ブロック形式のみ。無ければ null） */
  ticket: TicketRef | null;
  /** 誰の予定か（メンバー ID）。null = 自分 */
  owner: string | null;
  ref: TaskRefData;
}

/** 時刻が入っているタスク */
export interface ScheduledTask extends Task {
  start: number;
  end: number;
}

export function isScheduled(t: Task): t is ScheduledTask {
  return t.start !== null && t.end !== null;
}

/** 追加・編集フォームの内容 */
export interface TaskDraft {
  title: string;
  start: number | null;
  end: number | null;
  done: boolean;
  /** undefined = 変更しない（新規なら既定） */
  reminder?: ReminderSetting;
  /** undefined = 変更しない */
  doneCondition?: string;
  /** undefined = 変更しない */
  steps?: TaskStep[];
  /** undefined = 変更しない */
  retrospective?: string;
  /** 結果。undefined = 変更しない / "" = 消す */
  result?: string;
  /** 残。undefined = 変更しない / "" = 消す */
  remaining?: string;
  /** 登録日。undefined = 変更しない / "" = 消す */
  registered?: string;
  /** 実績。undefined = 変更しない / [] = 消す */
  actual?: ActualRange[];
  /** プロジェクト。undefined = 変更しない / null = 外す */
  project?: string | null;
  /** true でチェックを [>]（持ち越し）にする。undefined = 変更しない */
  forward?: boolean;
  /** 持ち越し先・元リンク。undefined = 変更しない / null = 消す */
  carryTo?: string | null;
  carryFrom?: string | null;
  /** undefined = 変更しない */
  details?: string;
  /** undefined = 変更しない / null = 外す */
  ticket?: TicketRef | null;
  /** 誰の予定か（メンバー ID）。undefined = 変更しない / null = 自分 */
  owner?: string | null;
}

export interface DayTasks {
  path: string;
  exists: boolean;
  tasks: Task[];
}

/** 保存形式ごとの読み書き */
export interface TaskSource {
  /** 未スケジュールのタスクを扱えるか */
  readonly supportsUnscheduled: boolean;
  /** ブロック単位で本文を持てるか */
  readonly supportsBody: boolean;

  pathFor(date: Date): string;
  getFile(date: Date): TFile | null;
  ensureFile(date: Date): Promise<TFile>;
  load(date: Date): Promise<DayTasks>;

  create(date: Date, draft: TaskDraft): Promise<boolean>;
  update(date: Date, task: Task, draft: TaskDraft): Promise<boolean>;
  remove(date: Date, task: Task): Promise<boolean>;
  /** 別の日へ移す。対応していなければ null を返す */
  moveToDate(from: Date, task: Task, to: Date): Promise<boolean | null>;
  /** ノートの該当箇所へのリンク（"path#^id"）。無ければ null */
  linkTo(date: Date, task: Task): Promise<string | null>;
}
