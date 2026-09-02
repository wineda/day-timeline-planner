import { App, DropdownComponent, Menu, Modal, Notice, Platform, Setting, moment, setIcon } from "obsidian";
import type { TaskDraft } from "./model";
import { projectDisplayName, type ProjectRef } from "./project";
import {
  STATUS_KINDS,
  actualTotal,
  buildStatusValue,
  joinOtherEntry,
  parseStatusValue,
  splitOtherEntry,
  type ActualRange,
  type ReminderSetting,
  type TaskStep,
  type TicketRef,
} from "./markdown/blocks";
import {
  DONE_ONLY_FIELDS,
  MEETING_TAGS,
  PLACEHOLDER_FIELDS,
  TROUBLE_TAGS,
  normalizeFieldLabel,
  normalizeTag,
  placeholderFor,
  schemaForTag,
  ticketUrl,
  type IssueTracker,
  type PlaceholderField,
  type TagColor,
  type TagFieldSchema,
} from "./settings";
import { contrastTextColor, formatDuration, minutesToHHMM, parseTimeInput } from "./util";
import { iconName } from "./icons";

export interface TaskModalOptions {
  mode: "create" | "edit";
  initial: TaskDraft;
  snapMinutes: number;
  /** 時刻を空にして「未スケジュール」にできるか（ブロック形式のみ） */
  allowUnscheduled: boolean;
  /** 対象の日付の表示（週表示のときにどの日か分かるように） */
  dateLabel?: string;
  /**
   * 日付の入力欄。渡すと日付を編集できる（value は "YYYY-MM-DD"、null = 日付未定）。
   * 選んだ日付は onSubmit の第2引数で返す（undefined = 欄なし / null = 日付未定）
   */
  dateField?: {
    value: string | null;
    /** 空にして「日付未定」にできるか */
    allowEmpty?: boolean;
    /** 空のときに欄の下へ出すヒント */
    hint?: string;
  };
  /** 時刻が空のときに時間欄の下へ出すヒント（既定は「時刻なし（未スケジュール）」） */
  unscheduledHint?: string;
  /** 設定画面で登録したタグ（ボタンで選べるようにする） */
  tagChoices?: TagColor[];
  /** タグごとの必須・候補フィールド（選んだタグに応じて欄を開き、チップを並べ替える） */
  tagFieldSchema?: TagFieldSchema[];
  /** 必須フィールドが空のまま保存しようとしたとき警告する（既定: true。保存は止めない） */
  validateRequiredOnSave?: boolean;
  /** メンバーの名前（「Owner」欄の入力候補に出す） */
  memberNames?: string[];
  /** リマインドの選択欄を出すか（既定の「N分前」を表示に使う）。undefined なら出さない */
  reminderDefault?: number;
  /** 完了条件・ステップの入力欄を出すか（ブロック形式のみ） */
  showDoneCondition?: boolean;
  /** 実績（実際に作業した時間）の入力欄を出すか（ブロック形式の編集時のみ） */
  showActual?: boolean;
  /** プロジェクト（大きなタスク）の選択肢。渡すと欄を出す（ブロック形式のみ） */
  projects?: ProjectRef[];
  /** 新しいプロジェクトノートを作る。作れたらリンク先を返す */
  onCreateProject?: (name: string) => Promise<string | null>;
  /** プロジェクトノートを開く（ダイアログは閉じてから呼ばれる） */
  onOpenProject?: (linktext: string) => void | Promise<void>;
  /** チケット管理ツール（登録があればチケット欄を出す。ブロック形式のみ） */
  trackers?: IssueTracker[];
  /** 同じ日の他のタスクの実績（実績の重複を保存前に注意する。無ければチェックしない） */
  otherActuals?: OtherActual[];
  /** 「誰の予定か」の選択肢（無ければ欄を出さない） */
  owners?: { id: string | null; name: string; color: string }[];
  initialOwner?: string | null;
  /** date: dateField を渡したときの選択日（null = 日付未定 / undefined = 欄なし） */
  onSubmit: (data: TaskDraft, date?: Date | null) => void | Promise<void>;
  /**
   * 変更を自動保存する（編集時のみ）。渡すと保存ボタンの代わりに「閉じる」を出し、
   * 項目が変わるたびに（少し待ってから）呼ばれる。戻り値は保存できたかどうか。
   * 閉じるときは、開いてから変更があれば onSubmit が1回呼ばれる。
   */
  onAutoSave?: (data: TaskDraft) => boolean | Promise<boolean>;
  onDelete?: () => void | Promise<void>;
  /** ノートの該当ブロックを開く（編集時のみ表示） */
  onOpenNote?: () => void | Promise<void>;
  onClose?: () => void;
}

/** 同じ日の他のタスクの実績（実績の重複チェックに使う） */
export interface OtherActual {
  title: string;
  /** そのタスクのタグ（"#" 抜き）。#会議 は重複チェックの対象外 */
  tags: string[];
  ranges: ActualRange[];
}

/** 他者の1件（編集中の形。保存時に「相手 / 内容」へ組み立てる） */
interface OtherEntry {
  who: string;
  what: string;
}

/** 実績の重複とみなす最小の分数（Rules/Work記録チェック担当ルール.md: 15分以内は指摘しない） */
const OVERLAP_MIN = 15;
/** 備考の長文とみなす行数（同ルール: 1タスク10行超の長文） */
const DETAILS_MAX_LINES = 10;
/** パスワード・トークンらしき文字列（同ルール: 秘密情報） */
const SECRET_RE = /(password|passwd|pwd|token|secret|api[_-]?key|bearer)\s*[:=]\s*\S+|[A-Za-z0-9+/]{40,}={0,2}/i;
/** 「未完了セット」= 未完了のまま閉じるタスクを翌日に追うための4欄（Rules/Work共通ルール.md） */
const OPEN_SET_FIELDS = ["Owner", "期限", "完了条件", "次アクション"];

/** タスクを追加・編集するダイアログ */
export class TaskModal extends Modal {
  private opts: TaskModalOptions;
  private title: string;
  private done: boolean;
  private reminder: ReminderSetting;
  private doneCondition: string;
  private retrospective: string;
  private result: string;
  private remaining: string;
  private cause: string;
  private judgment: string;
  /** 他者（1件 = 相手 + 内容。保存時に「- 他者: 相手 / 内容」の行に分ける） */
  private others: OtherEntry[];
  private answer: string;
  /** 状態の種類（未着手 / 進行中 / 中断 / 回答待ち / 期限未定 / ""）と中断理由 */
  private statusKind: string;
  private statusReasonText: string;
  /** 開いたときの状態の生の値（変わっていなければ書式を保つ） */
  private initialStatus: string;
  private ownerNameText: string;
  private dueText: string;
  private nextActionText: string;
  private details: string;
  private ticketTracker: string;
  private ticketId: string;
  private owner: string | null;
  /** プロジェクト（リンク先文字列）。null = なし */
  private project: string | null;
  private steps: TaskStep[];
  private stepsListEl!: HTMLElement;
  private stepsCountEl!: HTMLElement;
  private stepsBarEl!: HTMLElement;
  private startText: string;
  private endText: string;
  /** 日付欄の入力（"YYYY-MM-DD"。空 = 日付未定）。dateField を渡したときだけ使う */
  private dateText: string;
  private initialDateText: string;
  private hintEl!: HTMLElement;
  /** 実績の入力内容（"10:05 - 11:20 / 13:00 - 13:30" のような文字列） */
  private actualText: string;
  private stepAddInput: HTMLInputElement | null = null;
  // 自動保存（onAutoSave 付きの編集時のみ使う）
  private autosaveTimer: number | null = null;
  private autosaveInFlight = false;
  /** 直近に自動保存した内容（JSON）。同じ内容なら保存しない */
  private savedJson = "";
  /** 開いたときの内容（JSON）。変わっていなければ閉じるときに保存しない */
  private initialJson = "";
  private autosaveStatusEl: HTMLElement | null = null;
  /** 日本語 IME の変換中は保存しない */
  private composing = false;
  /** 選択中のタグ（正規化済み。"#" 抜き）。書き込むのは最も深い1つ */
  private selectedTags = new Set<string>();
  /** ボタンで選べるタグ（正規化して重複を除いたもの） */
  private tagChoices: TagColor[];
  /** 折りたためる欄の一覧（タグ別スキーマの適用と保存時の必須チェックに使う） */
  private fieldRows: { label: string; el: HTMLElement; hasValue: () => boolean; focus?: () => void }[] = [];
  /**
   * 開いたままにする欄。値が入っていた欄と、ユーザーが「＋」チップで開いた欄。
   * タグ切り替えで required から外れても、ここに載っている欄は閉じない
   */
  private userOpened = new Set<string>();
  /** 「＋」チップを並べるコンテナ */
  private addFieldsEl: HTMLElement | null = null;
  /** 候補以外の「＋」チップ（その他）を展開しているか */
  private moreOpen = false;
  /** 必須フィールドの警告を出したあと「このまま保存」が選ばれた */
  private skipRequiredCheck = false;
  /** モバイルの日時サマリー行の表示を更新する（モバイル以外は null） */
  private refreshSchedSummary: (() => void) | null = null;
  /** タグに応じてプレースホルダーを差し替える欄 */
  private placeholderTargets: { field: PlaceholderField; el: HTMLInputElement | HTMLTextAreaElement }[] = [];
  /** タグ選択の描画を更新する（タグ欄が無ければ null） */
  private repaintTags: (() => void) | null = null;
  /** 欄の下に出す注意（タイトル・実績・状態・備考） */
  private titleDescEl: HTMLElement | null = null;
  private actualDescEl: HTMLElement | null = null;
  private statusDescEl: HTMLElement | null = null;
  private detailsDescEl: HTMLElement | null = null;
  private statusReasonInput: HTMLInputElement | null = null;
  /** 他者の行を並べるコンテナ */
  private othersEl: HTMLElement | null = null;
  /** 「未完了セット」の外枠 */
  private openSetEl: HTMLElement | null = null;
  /** 「記録 / 作業メモ」タブ（ブロック形式のときだけ） */
  private paneButtons: { name: "record" | "memo"; el: HTMLElement }[] = [];
  private panes: { name: "record" | "memo"; el: HTMLElement }[] = [];
  private memoBadgeEl: HTMLElement | null = null;

  constructor(app: App, opts: TaskModalOptions) {
    super(app);
    this.opts = opts;
    this.done = opts.initial.done;
    this.reminder = opts.initial.reminder ?? null;
    this.doneCondition = opts.initial.doneCondition ?? "";
    this.retrospective = opts.initial.retrospective ?? "";
    this.result = opts.initial.result ?? "";
    this.remaining = opts.initial.remaining ?? "";
    this.cause = opts.initial.cause ?? "";
    this.judgment = opts.initial.judgment ?? "";
    this.others = (opts.initial.others ?? []).map((v) => splitOtherEntry(v));
    this.answer = opts.initial.answer ?? "";
    this.initialStatus = opts.initial.status ?? "";
    const st = parseStatusValue(this.initialStatus);
    this.statusKind = st.kind;
    this.statusReasonText = st.reason;
    this.ownerNameText = opts.initial.ownerName ?? "";
    this.dueText = opts.initial.due ?? "";
    this.nextActionText = opts.initial.nextAction ?? "";
    this.details = opts.initial.details ?? "";
    this.ticketTracker = opts.initial.ticket?.tracker ?? "";
    this.ticketId = opts.initial.ticket?.id ?? "";
    this.owner = opts.initialOwner ?? null;
    this.project = opts.initial.project ?? null;
    this.steps = (opts.initial.steps ?? []).map((st) => ({ ...st, children: [...(st.children ?? [])] }));

    this.tagChoices = normalizeTagChoices(opts.tagChoices);
    // タイトルに書かれている選択肢のタグは、タイトルから外してボタンの選択状態にする
    const { text, selected } = splitKnownTags(opts.initial.title, this.tagChoices.map((c) => c.tag));
    this.title = text;
    this.selectedTags = selected;
    this.startText = opts.initial.start === null ? "" : minutesToHHMM(opts.initial.start);
    this.endText = opts.initial.end === null ? "" : minutesToHHMM(opts.initial.end);
    this.dateText = this.initialDateText = opts.dateField?.value ?? "";
    this.actualText = formatActualRanges(opts.initial.actual ?? []);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.modalEl.addClass("dt-modal");
    this.titleEl.setText(
      (this.opts.mode === "create" ? "タスクを追加" : "タスクを編集") +
        (this.opts.dateLabel ? ` — ${this.opts.dateLabel}` : "")
    );

    // Enter で保存（日本語 IME の変換確定 Enter は無視）
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        void this.submit();
      }
    };
    // 複数行の欄: Enter は改行、保存は Ctrl+Enter
    const onKeyMultiline = (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.isComposing) {
        e.preventDefault();
        void this.submit();
      }
    };

    // 項目の説明は行のツールチップ（ホバー）で出す
    const tip = (el: HTMLElement, text: string) => el.setAttr("title", text);

    // 値が空の任意項目は隠しておき、下の「＋」チップで開く。
    // hasValue は「今の入力に値があるか」を返す関数（タグ別スキーマの適用時に毎回見直す）
    this.fieldRows = [];
    this.userOpened = new Set();
    this.placeholderTargets = [];
    const collapsible = (el: HTMLElement, label: string, hasValue: () => boolean, focus?: () => void) => {
      // 最初から値が入っていた欄は、タグを切り替えても閉じない
      if (hasValue()) this.userOpened.add(label);
      else el.addClass("dt-collapsed");
      this.fieldRows.push({ label, el, hasValue, focus });
    };
    /** 横に並べた2欄が両方隠れていたら行ごと隠す（欄が無ければ行ごと消す） */
    const finishPair = (pair: HTMLElement) => {
      if (!pair.childElementCount) pair.remove();
      else if (!pair.querySelector(".setting-item:not(.dt-collapsed)")) pair.addClass("dt-collapsed");
    };
    /** タグに応じてプレースホルダーを差し替える欄として登録する */
    const ph = (el: HTMLInputElement | HTMLTextAreaElement, field: PlaceholderField) => {
      this.placeholderTargets.push({ field, el });
      el.placeholder = this.placeholderFor(field);
    };
    /** 伸び縮みする複数行の欄（フォーカスで広がり、離れたら内容ぶんの高さに縮む） */
    const textarea = (parent: HTMLElement, cls: string, rows: number, max: number, get: () => string, set: (v: string) => void) => {
      const ta = parent.createEl("textarea", { cls: "dt-retro-field " + cls, attr: { rows: String(rows) } });
      ta.value = get();
      const grow = () => {
        ta.style.height = "auto";
        ta.style.height = Math.min(Math.max(ta.scrollHeight, 36), max) + "px";
      };
      ta.addEventListener("input", () => {
        set(ta.value);
        grow();
      });
      ta.addEventListener("focus", () => {
        ta.addClass("is-active");
        grow();
      });
      ta.addEventListener("blur", () => {
        ta.removeClass("is-active");
        grow();
      });
      ta.addEventListener("keydown", onKeyMultiline);
      window.setTimeout(grow, 0);
      return { ta, grow };
    };
    const mobile = Platform.isMobile;
    const blockMode = !!this.opts.showDoneCondition;

    // ---- 「記録」（AIが読む欄）と「作業メモ」（ステップ・備考・リマインド）のタブ ----
    // 日報・記録チェックの入力になる欄と、自分の作業用の欄を分ける（ブロック形式のときだけ）
    this.paneButtons = [];
    this.panes = [];
    let recordPane: HTMLElement = contentEl;
    let memoPane: HTMLElement = contentEl;
    if (blockMode) {
      const tabs = contentEl.createDiv({ cls: "dt-modal-tabs", attr: { role: "tablist" } });
      const mkTab = (name: "record" | "memo", label: string, sub: string) => {
        const b = tabs.createEl("button", { cls: "dt-modal-tab", attr: { type: "button", role: "tab" } });
        b.createSpan({ text: label });
        b.createSpan({ cls: "dt-modal-tab-sub", text: sub });
        if (name === "memo") this.memoBadgeEl = b.createSpan({ cls: "dt-modal-tab-badge" });
        b.onclick = () => this.showPane(name);
        this.paneButtons.push({ name, el: b });
        return b;
      };
      mkTab("record", "記録", "AIが読む欄");
      tip(this.paneButtons[0].el, "結果・残・次アクションなど、日報と記録チェックの元になる欄");
      mkTab("memo", "作業メモ", "自分用");
      tip(this.paneButtons[1].el, "ステップ・備考・リマインド。AIは行名として読みません");
      recordPane = contentEl.createDiv({ cls: "dt-modal-pane", attr: { role: "tabpanel" } });
      memoPane = contentEl.createDiv({ cls: "dt-modal-pane", attr: { role: "tabpanel" } });
      this.panes.push({ name: "record", el: recordPane }, { name: "memo", el: memoPane });
      this.showPane("record");
    }

    // ---- モバイル: TickTick 風のシンプル表示 ----
    // 上段は「丸い完了チェック + 日時サマリー」の1行だけにし、日付・時間・実績の
    // 入力欄はサマリーのタップで開閉する（空の任意項目は「＋ 項目を追加」のメニューへ）
    let schedBody: HTMLElement | null = null;
    if (mobile) {
      this.modalEl.addClass("dt-modal-mobile");
      const head = recordPane.createDiv("dt-m-head");
      if (this.opts.mode === "edit") {
        const check = head.createEl("button", {
          cls: "dt-m-done",
          attr: { type: "button", role: "checkbox", "aria-label": "完了" },
        });
        tip(check, "タップすると完了（[x]）として保存されます。");
        setIcon(check, "check");
        const paintDone = () => {
          check.toggleClass("is-done", this.done);
          check.setAttr("aria-checked", String(this.done));
        };
        paintDone();
        check.onclick = () => {
          this.done = !this.done;
          paintDone();
          this.applyTagSchema();
        };
      }
      const sched = head.createEl("button", { cls: "dt-m-sched", attr: { type: "button" } });
      tip(sched, "タップで日付・時間の欄を開閉します。");
      const schedText = sched.createSpan("dt-m-sched-text");
      const chevron = sched.createSpan("dt-m-sched-chevron");
      setIcon(chevron, "chevron-down");
      schedBody = recordPane.createDiv({ cls: ["dt-m-sched-body", "dt-collapsed"] });
      sched.onclick = () => {
        const open = schedBody?.hasClass("dt-collapsed") ?? false;
        schedBody?.toggleClass("dt-collapsed", !open);
        sched.toggleClass("is-open", open);
      };
      this.refreshSchedSummary = () => {
        const parts: string[] = [];
        if (this.opts.dateField) {
          const d = this.parseDateText();
          parts.push(
            d ? moment(d).format("M月D日(ddd)") : this.opts.dateField.allowEmpty ? "日付未定" : "日付を入力"
          );
        } else if (this.opts.dateLabel) {
          parts.push(this.opts.dateLabel);
        }
        const r = this.parse();
        let error = false;
        if ("error" in r) {
          parts.push("時刻を確認");
          error = true;
        } else if (r.start === null) {
          parts.push("時刻なし");
        } else {
          parts.push(`${minutesToHHMM(r.start)} - ${minutesToHHMM(r.end as number)}`);
        }
        schedText.setText(parts.join(" "));
        sched.toggleClass("is-error", error);
      };
      this.refreshSchedSummary();
    }
    /** 日付・時間・実績の欄の親（モバイルでは折りたたみ領域の中に入れる） */
    const schedParent = schedBody ?? recordPane;

    // ---- タイトル（編集時は「完了」も同じ行に。モバイルの完了は上の丸チェック）----
    const titleSetting = new Setting(recordPane).setName("タイトル");
    titleSetting.settingEl.addClass("dt-title-setting");
    titleSetting.addText((t) => {
      t.setValue(this.title).onChange((v) => {
        this.title = v;
        this.updateTitleDesc();
      });
      t.inputEl.addClass("dt-title-input");
      t.inputEl.addEventListener("keydown", onKey);
      ph(t.inputEl, "タイトル");
      // モバイルの編集時は自動フォーカスしない（開くたびにキーボードが出て内容が隠れるため）
      if (!mobile || this.opts.mode === "create") {
        window.setTimeout(() => {
          t.inputEl.focus();
          t.inputEl.select();
        }, 0);
      }
    });
    if (this.opts.mode === "edit" && !mobile) {
      const doneWrap = titleSetting.controlEl.createDiv("dt-done-inline");
      doneWrap.createSpan({ cls: "dt-done-inline-label", text: "完了" });
      tip(doneWrap, "チェックすると完了（[x]）として保存されます。");
      titleSetting.addToggle((tg) => {
        tg.setValue(this.done).onChange((v) => {
          this.done = v;
          this.applyTagSchema();
        });
        doneWrap.appendChild(tg.toggleEl);
      });
    }
    this.titleDescEl = titleSetting.descEl;

    // ---- 日付（dateField を渡したときだけ。変えると別の日のノートへ移る）----
    if (this.opts.dateField) {
      const df = this.opts.dateField;
      const dateSetting = new Setting(schedParent).setName("日付");
      tip(
        dateSetting.settingEl,
        df.allowEmpty
          ? "タスクの日付。変えるとその日のノートへ移り、空にすると「日付未定」になります。"
          : "タスクの日付。変えると、その日のノートへ移ります。"
      );
      const dateInput = dateSetting.controlEl.createEl("input", {
        type: "date",
        cls: "dt-date-field",
      });
      dateInput.value = this.dateText;
      const updateDateHint = () => {
        const d = this.parseDateText();
        if (d) {
          dateSetting.descEl.setText(moment(d).format("M月D日 (ddd)"));
        } else {
          dateSetting.descEl.setText(
            df.allowEmpty ? df.hint ?? "日付未定" : "日付を入力してください"
          );
        }
        this.refreshSchedSummary?.();
      };
      const onDateInput = () => {
        this.dateText = dateInput.value;
        updateDateHint();
      };
      dateInput.addEventListener("input", onDateInput);
      dateInput.addEventListener("change", onDateInput);
      dateInput.addEventListener("keydown", onKey);
      if (df.allowEmpty) {
        dateSetting.addExtraButton((b) =>
          b
            .setIcon("calendar-x")
            .setTooltip("日付を外して「日付未定」にする")
            .onClick(() => {
              this.dateText = "";
              dateInput.value = "";
              updateDateHint();
            })
        );
      }
      updateDateHint();
    }

    // ---- 時間・実績 ----
    // 時刻の候補リスト（入力欄をクリックすると選べる）。
    // モバイルは OS の時刻ピッカー（type=time）を使うので出さない
    let listId: string | null = null;
    if (!Platform.isMobile) {
      listId = "dt-times-" + Math.random().toString(36).slice(2, 8);
      const datalist = contentEl.createEl("datalist", { attr: { id: listId } });
      const step = Math.max(this.opts.snapMinutes, 15);
      for (let m = 0; m <= 1440; m += step) {
        datalist.createEl("option", { attr: { value: minutesToHHMM(m) } });
      }
    }

    const timeSetting = new Setting(schedParent).setName("時間");
    timeSetting.addText((t) => {
      t.setPlaceholder("09:00")
        .setValue(this.startText)
        .onChange((v) => {
          this.startText = v;
          this.updateHint();
        });
      t.inputEl.addClass("dt-time-input");
      setupTimeInput(t.inputEl);
      if (listId) t.inputEl.setAttr("list", listId);
      t.inputEl.addEventListener("keydown", onKey);
    });
    timeSetting.controlEl.createSpan({ text: "〜", cls: "dt-modal-tilde" });
    timeSetting.addText((t) => {
      t.setPlaceholder("10:00")
        .setValue(this.endText)
        .onChange((v) => {
          this.endText = v;
          this.updateHint();
        });
      t.inputEl.addClass("dt-time-input");
      setupTimeInput(t.inputEl);
      if (listId) t.inputEl.setAttr("list", listId);
      t.inputEl.addEventListener("keydown", onKey);
    });
    if (this.opts.allowUnscheduled) {
      timeSetting.addExtraButton((b) =>
        b
          .setIcon("timer-off")
          .setTooltip("時刻を外して「未スケジュール」にする")
          .onClick(() => {
            this.startText = "";
            this.endText = "";
            const inputs = timeSetting.controlEl.querySelectorAll("input");
            inputs.forEach((i) => ((i as HTMLInputElement).value = ""));
            this.updateHint();
          })
      );
    }
    this.hintEl = timeSetting.descEl;
    this.updateHint();

    if (this.opts.showActual) {
      const actSetting = new Setting(schedParent).setName("実績");
      actSetting.settingEl.addClass("dt-tight");
      tip(actSetting.settingEl, "実際に作業した時間。中断したら / で区切って複数書けます。同じ日の他のタスクの実績と重なると注意が出ます。");
      let actualInput: HTMLInputElement | null = null;
      this.actualDescEl = actSetting.descEl;
      actSetting.addText((t) => {
        t.setPlaceholder("10:05 - 11:20 / 13:00 - 13:30")
          .setValue(this.actualText)
          .onChange((v) => {
            this.actualText = v;
            this.updateActualDesc();
          });
        t.inputEl.addClass("dt-actual-input");
        t.inputEl.addEventListener("keydown", onKey);
        actualInput = t.inputEl;
      });
      actSetting.addExtraButton((b) =>
        b
          .setIcon("copy")
          .setTooltip("予定と同じ時間を実績に入れる")
          .onClick(() => {
            const r = this.parse();
            if ("error" in r || r.start === null || r.end === null) {
              new Notice("予定の時刻が入っていません");
              return;
            }
            this.actualText = formatActualRanges([{ start: r.start, end: r.end }]);
            if (actualInput) actualInput.value = this.actualText;
            this.updateActualDesc();
          })
      );
      this.updateActualDesc();
    }

    // ---- プロジェクト・誰の予定か（横並び）----
    const pairMain = recordPane.createDiv("dt-row-pair");
    if (this.opts.projects) {
      const projSetting = this.buildProjectSection(pairMain);
      // モバイルでは未設定のプロジェクト欄も隠し、「＋ 項目を追加」から開く
      if (mobile) {
        collapsible(projSetting.settingEl, "プロジェクト", () => this.project !== null, () =>
          projSetting.settingEl.querySelector<HTMLSelectElement>("select")?.focus()
        );
      }
    }
    if (this.opts.owners?.length) {
      const owners = this.opts.owners;
      const ownerSetting = new Setting(pairMain).setName("誰の予定か");
      tip(
        ownerSetting.settingEl,
        this.opts.mode === "edit"
          ? "変えると、その人のノートへブロックごと移ります。"
          : "自分以外を選ぶと、その人の予定として登録します。"
      );
      const dot = ownerSetting.controlEl.createSpan("dt-owner-dot");
      const paintDot = () => {
        const o = owners.find((x) => (x.id ?? null) === (this.owner ?? null));
        dot.style.background = o?.color || "transparent";
        dot.toggleClass("is-self", !o?.color);
      };
      let ownerSelect: HTMLSelectElement | null = null;
      ownerSetting.addDropdown((d) => {
        for (const o of owners) d.addOption(o.id ?? "", o.name);
        d.setValue(this.owner ?? "").onChange((v) => {
          this.owner = v || null;
          paintDot();
        });
        ownerSelect = d.selectEl;
      });
      paintDot();
      collapsible(ownerSetting.settingEl, "誰の予定か", () => this.owner !== null, () => ownerSelect?.focus());
    }
    finishPair(pairMain);

    // ---- タグ（親タグ → サブタグの2段。書き込むのは最も深い1つ）----
    if (this.tagChoices.length) {
      const tagSetting = new Setting(recordPane).setName("タグ");
      tagSetting.settingEl.addClass("dt-tag-setting");
      tip(tagSetting.settingEl, "選んだタグは見出しの末尾に #タグ として書き込まれます（サブタグを選んだときはサブタグだけ）。");
      if (this.opts.tagFieldSchema?.length) {
        const link = tagSetting.nameEl.createEl("a", {
          cls: "dt-tag-ph-link",
          text: "文言一覧",
          attr: { href: "#", title: "選んだタグで各欄にどんな書き方の例が出るかを一覧で見る" },
        });
        link.onclick = (e: MouseEvent) => {
          e.preventDefault();
          new PlaceholderListModal(this.app, this.opts.tagFieldSchema ?? [], this.tagChoices, this.primaryTag()).open();
        };
      }
      this.repaintTags = renderTagChips(tagSetting.controlEl, this.tagChoices, this.selectedTags, () =>
        this.applyTagSchema()
      );
    }

    if (blockMode) {
      // ---- チケット ----
      const trackers = this.opts.trackers ?? [];
      if (trackers.length) {
        const tkSetting = new Setting(recordPane).setName("チケット");
        tip(tkSetting.settingEl, "管理ツールと番号を選ぶと、ブロックからチケットを開けます。障害はここかタイトルに番号を入れます。");
        const updateDesc = () => {
          const url = this.ticketId.trim()
            ? ticketUrl(trackers, this.ticketTracker, this.ticketId.trim())
            : null;
          tkSetting.descEl.empty();
          if (url) {
            tkSetting.descEl.createEl("a", {
              cls: "dt-ticket-link",
              text: url,
              href: url,
              attr: { target: "_blank", rel: "noopener" },
            });
          }
          this.updateTitleDesc();
        };
        tkSetting.addDropdown((d) => {
          for (const tr of trackers) if (tr.name) d.addOption(tr.name, tr.name);
          const cur =
            this.ticketTracker && trackers.some((tr) => tr.name === this.ticketTracker)
              ? this.ticketTracker
              : trackers.find((tr) => tr.name)?.name ?? "";
          if (this.ticketTracker && !trackers.some((tr) => tr.name === this.ticketTracker)) {
            d.addOption(this.ticketTracker, this.ticketTracker + "（未登録）");
          }
          this.ticketTracker = this.ticketId ? this.ticketTracker || cur : cur;
          d.setValue(this.ticketTracker || cur).onChange((v) => {
            this.ticketTracker = v;
            updateDesc();
          });
        });
        let tkInput: HTMLInputElement | null = null;
        tkSetting.addText((t) => {
          t.setPlaceholder("番号（例: 65130）")
            .setValue(this.ticketId)
            .onChange((v) => {
              this.ticketId = v.trim().replace(/^#+/, "");
              updateDesc();
            });
          t.inputEl.addClass("dt-ticket-input");
          t.inputEl.addEventListener("keydown", onKey);
          tkInput = t.inputEl;
        });
        updateDesc();
        collapsible(tkSetting.settingEl, "チケット", () => this.ticketId.trim() !== "", () => tkInput?.focus());
      }

      // ---- 結果（何がどこまで終わったか）----
      const resSetting = new Setting(recordPane).setName("結果");
      tip(resSetting.settingEl, "何がどこまで終わったか。ノートには「- 結果: …」として保存され、日報の元データになります。改行は「 / 」区切りで1行になります。");
      resSetting.settingEl.addClass("dt-retro-setting");
      const res = textarea(resSetting.controlEl, "", 1, 220, () => this.result.replace(/ \/ /g, "\n"), (v) => (this.result = v));
      ph(res.ta, "結果");
      collapsible(resSetting.settingEl, "結果", () => this.result.trim() !== "", () => res.ta.focus());

      // ---- 原因・残（横並び）----
      const pairCause = recordPane.createDiv("dt-row-pair");
      const causeSetting = new Setting(pairCause).setName("原因");
      tip(causeSetting.settingEl, "障害・バグの原因。ノートには「- 原因: …」として保存されます。");
      let causeInput: HTMLInputElement | null = null;
      causeSetting.addText((t) => {
        t.setValue(this.cause).onChange((v) => (this.cause = v));
        t.inputEl.addClass("dt-title-input");
        t.inputEl.addEventListener("keydown", onKey);
        ph(t.inputEl, "原因");
        causeInput = t.inputEl;
      });
      collapsible(causeSetting.settingEl, "原因", () => this.cause.trim() !== "", () => causeInput?.focus());

      const remSetting = new Setting(pairCause).setName("残");
      tip(remSetting.settingEl, "完了にしたあとに残っている作業。ノートには「- 残: …」として保存されます。");
      let remInput: HTMLInputElement | null = null;
      remSetting.addText((t) => {
        t.setValue(this.remaining).onChange((v) => (this.remaining = v));
        t.inputEl.addClass("dt-title-input");
        t.inputEl.addEventListener("keydown", onKey);
        ph(t.inputEl, "残");
        remInput = t.inputEl;
      });
      collapsible(remSetting.settingEl, "残", () => this.remaining.trim() !== "", () => remInput?.focus());
      finishPair(pairCause);

      // ---- 判断（PLとしてどう判断したか。障害に限らない）----
      const judgeSetting = new Setting(recordPane).setName("判断");
      judgeSetting.nameEl.createSpan({ cls: "dt-field-note", text: "PLとして" });
      tip(judgeSetting.settingEl, "その場でどう判断したか。障害以外でも使います。件数はPL行動分析の指標になります。ノートには「- 判断: …」として保存されます。");
      let judgeInput: HTMLInputElement | null = null;
      judgeSetting.addText((t) => {
        t.setValue(this.judgment).onChange((v) => (this.judgment = v));
        t.inputEl.addClass("dt-title-input");
        t.inputEl.addEventListener("keydown", onKey);
        ph(t.inputEl, "判断");
        judgeInput = t.inputEl;
      });
      collapsible(judgeSetting.settingEl, "判断", () => this.judgment.trim() !== "", () => judgeInput?.focus());

      // ---- 他者（ボールが相手にあるもの。相手 + 内容で1件、複数書ける）----
      const othSetting = new Setting(recordPane).setName("他者");
      othSetting.nameEl.createSpan({ cls: "dt-field-note", text: "相手のボール" });
      tip(
        othSetting.settingEl,
        "ボールが相手にあるもの。相手と内容を1件ずつ書くと、ノートには「- 他者: 相手 / 内容」の行が件数ぶん保存されます。相手が空だと記録チェックで指摘されます。"
      );
      othSetting.settingEl.addClass("dt-others-setting");
      this.othersEl = othSetting.controlEl.createDiv("dt-others");
      this.renderOthers();
      collapsible(
        othSetting.settingEl,
        "他者",
        () => this.others.some((o) => o.who.trim() || o.what.trim()),
        () => {
          if (!this.others.length) {
            this.others.push({ who: "", what: "" });
            this.renderOthers();
          }
          this.othersEl?.querySelector<HTMLInputElement>("input")?.focus();
        }
      );

      // ---- 回答・状態（横並び）----
      const pairAns = recordPane.createDiv("dt-row-pair");
      const ansSetting = new Setting(pairAns).setName("回答");
      tip(ansSetting.settingEl, "質問への回答が済んだか。ノートには「- 回答: 済 / 未」として保存されます。");
      let ansSelect: HTMLSelectElement | null = null;
      ansSetting.addDropdown((d) => {
        d.addOption("", "（未設定）");
        d.addOption("未", "未");
        d.addOption("済", "済");
        if (this.answer && !["未", "済"].includes(this.answer)) d.addOption(this.answer, this.answer);
        d.setValue(this.answer).onChange((v) => {
          this.answer = v;
          this.updateStatusDesc();
        });
        ansSelect = d.selectEl;
      });
      collapsible(ansSetting.settingEl, "回答", () => this.answer.trim() !== "", () => ansSelect?.focus());

      const stSetting = new Setting(pairAns).setName("状態");
      tip(
        stSetting.settingEl,
        "未着手 / 進行中 / 中断 / 回答待ち / 期限未定。中断は理由を付けて「- 状態: 中断(理由)」として保存されます。"
      );
      stSetting.settingEl.addClass("dt-status-setting");
      let stSelect: HTMLSelectElement | null = null;
      stSetting.addDropdown((d) => {
        d.addOption("", "（未設定）");
        for (const k of STATUS_KINDS) d.addOption(k, k);
        if (this.statusKind && !(STATUS_KINDS as readonly string[]).includes(this.statusKind)) {
          d.addOption(this.statusKind, this.statusKind);
        }
        d.setValue(this.statusKind).onChange((v) => {
          this.statusKind = v;
          this.updateStatusDesc();
          if (v === "中断") window.setTimeout(() => this.statusReasonInput?.focus(), 0);
        });
        stSelect = d.selectEl;
      });
      const reasonInput = stSetting.controlEl.createEl("input", { type: "text", cls: "dt-title-input dt-status-reason" });
      reasonInput.value = this.statusReasonText;
      reasonInput.addEventListener("input", () => (this.statusReasonText = reasonInput.value));
      reasonInput.addEventListener("keydown", onKey);
      ph(reasonInput, "中断理由");
      this.statusReasonInput = reasonInput;
      this.statusDescEl = stSetting.descEl;
      this.updateStatusDesc();
      collapsible(stSetting.settingEl, "状態", () => this.statusKind.trim() !== "", () => stSelect?.focus());
      finishPair(pairAns);

      // ---- 未完了セット（Owner・期限・完了条件・次アクション。未完了で閉じるタスクを翌日に追う4欄）----
      const openSet = recordPane.createDiv("dt-open-set");
      const setHead = openSet.createDiv("dt-open-set-head");
      setHead.createSpan({ cls: "dt-open-set-title", text: "未完了セット" });
      setHead.createSpan({ cls: "dt-open-set-desc", text: "未完了のまま閉じるタスクは、この4つで翌日に追えます" });
      this.openSetEl = openSet;

      const pairOwn = openSet.createDiv("dt-row-pair");
      const onSetting = new Setting(pairOwn).setName("Owner");
      tip(
        onSetting.settingEl,
        "このタスクのオーナー（ボールを持っている人）。ノートには「- Owner: 名前」として保存されます。"
      );
      let onInput: HTMLInputElement | null = null;
      onSetting.addText((t) => {
        t.setValue(this.ownerNameText).onChange((v) => (this.ownerNameText = v));
        t.inputEl.addClass("dt-title-input");
        t.inputEl.addEventListener("keydown", onKey);
        t.inputEl.setAttr("list", this.memberListId());
        ph(t.inputEl, "Owner");
        onInput = t.inputEl;
      });
      collapsible(onSetting.settingEl, "Owner", () => this.ownerNameText.trim() !== "", () => onInput?.focus());

      const dueSetting = new Setting(pairOwn).setName("期限");
      tip(
        dueSetting.settingEl,
        "タスクの期限。ノートには「- 期限: YYYY-MM-DD」として保存されます（既存の「期日:」の行も読み込めます）。"
      );
      let dueInput: HTMLInputElement | null = null;
      dueSetting.addText((t) => {
        t.setPlaceholder("YYYY-MM-DD")
          .setValue(this.dueText)
          .onChange((v) => {
            this.dueText = v;
            this.updateDueDesc(dueSetting.descEl);
          });
        t.inputEl.addClass("dt-title-input");
        t.inputEl.addEventListener("keydown", onKey);
        dueInput = t.inputEl;
      });
      this.updateDueDesc(dueSetting.descEl);
      collapsible(dueSetting.settingEl, "期限", () => this.dueText.trim() !== "", () => dueInput?.focus());
      finishPair(pairOwn);

      const dcSetting = new Setting(openSet).setName("完了条件");
      tip(dcSetting.settingEl, "何ができたら終わりか。ノートには「- 完了条件: …」として保存されます。調査・依頼・委譲のタスクでは記録チェックが求めます。");
      let dcInput: HTMLInputElement | null = null;
      dcSetting.addText((t) => {
        t.setValue(this.doneCondition).onChange((v) => (this.doneCondition = v));
        t.inputEl.addClass("dt-title-input");
        t.inputEl.addEventListener("keydown", onKey);
        ph(t.inputEl, "完了条件");
        dcInput = t.inputEl;
      });
      collapsible(dcSetting.settingEl, "完了条件", () => this.doneCondition.trim() !== "", () => dcInput?.focus());

      const naSetting = new Setting(openSet).setName("次アクション");
      tip(naSetting.settingEl, "次にやることを1つ。ノートには「- 次アクション: …」として保存され、PL補佐の次アクション整理に使われます。");
      let naInput: HTMLInputElement | null = null;
      naSetting.addText((t) => {
        t.setValue(this.nextActionText).onChange((v) => (this.nextActionText = v));
        t.inputEl.addClass("dt-title-input");
        t.inputEl.addEventListener("keydown", onKey);
        ph(t.inputEl, "次アクション");
        naInput = t.inputEl;
      });
      collapsible(naSetting.settingEl, "次アクション", () => this.nextActionText.trim() !== "", () => naInput?.focus());

      // ---- ふりかえり（編集時のみ。作った直後には要らない）----
      if (this.opts.mode === "edit") {
        const retroSetting = new Setting(recordPane).setName("ふりかえり");
        tip(retroSetting.settingEl, "作業してみてどうだったか・次はどう改善するか。「忘れた」「手間」「毎回」「調べ直した」「手順書に無かった」と書くと、Runbook 候補として拾われます。");
        retroSetting.settingEl.addClass("dt-retro-setting");
        const retro = textarea(retroSetting.controlEl, "", 1, 220, () => this.retrospective.replace(/ \/ /g, "\n"), (v) => (this.retrospective = v));
        ph(retro.ta, "ふりかえり");
        collapsible(retroSetting.settingEl, "ふりかえり", () => this.retrospective.trim() !== "", () => retro.ta.focus());
      }

      // ---- 作業メモ: ステップ（自分の作業管理用。AIには「残」への変換だけが届く）----
      memoPane.createEl("p", {
        cls: "dt-memo-lead",
        text: "ここは自分の作業用です。AIは行名として読みません。日報に載せたいことは「記録」タブの結果・残・次アクションへ。未チェックのステップは、完了にするときに「残:」へ変換できます。",
      });
      this.buildStepsSection(memoPane);

      // ---- 作業メモ: 備考（自由な本文）----
      const detailSetting = new Setting(memoPane).setName("備考");
      tip(detailSetting.settingEl, "自由なメモ（Markdown）。ノートのブロック本文と相互に反映されます。10行を超える手順やログは案件ノートか Runbook に置き、ここにはリンクだけ残します。");
      detailSetting.settingEl.addClass("dt-retro-setting");
      const det = textarea(detailSetting.controlEl, "dt-details-field", 2, 320, () => this.details, (v) => {
        this.details = v;
        this.updateDetailsDesc();
        this.updateMemoBadge();
      });
      ph(det.ta, "備考");
      this.detailsDescEl = detailSetting.descEl;
      this.updateDetailsDesc();
    }

    // ---- リマインド（作業メモ側。ブロック形式でなければ本体に）----
    if (this.opts.reminderDefault !== undefined) {
      const def = this.opts.reminderDefault;
      const rmSetting = new Setting(memoPane).setName("リマインド");
      tip(rmSetting.settingEl, "開始の何分前に通知するか。");
      rmSetting.addDropdown((d) => {
        d.addOption("default", `既定（${def === 0 ? "開始時刻" : `${def}分前`}）`);
        d.addOption("off", "しない");
        for (const m of [0, 1, 3, 5, 10, 15, 30, 60]) d.addOption(String(m), m === 0 ? "開始時刻" : `${m}分前`);
        const cur = this.reminder;
        const val = cur === null ? "default" : cur === "off" ? "off" : String(cur);
        if (cur !== null && cur !== "off" && !d.selectEl.querySelector(`option[value="${cur}"]`)) {
          d.addOption(String(cur), `${cur}分前`);
        }
        d.setValue(val).onChange((v) => {
          this.reminder = v === "default" ? null : v === "off" ? "off" : Number(v);
        });
      });
    }

    // ---- 隠している項目を開く「＋」チップ + タグ別スキーマの適用 ----
    // 選択中のタグの required の欄を開き、suggested のチップを先頭に並べ、残りは「その他」に畳む
    this.addFieldsEl = recordPane.createDiv("dt-add-fields");
    this.applyTagSchema();
    this.updateTitleDesc();
    this.updateMemoBadge();

    // 入力が入ったら、保存時の警告で付けた「未入力」マークを消す
    contentEl.addEventListener("input", () => {
      for (const row of this.fieldRows) {
        if (row.hasValue()) row.el.removeClass("dt-field-invalid");
      }
    });

    const buttons = new Setting(contentEl);
    buttons.settingEl.addClass("dt-modal-buttons");
    if (this.autosaveOn) this.autosaveStatusEl = buttons.descEl;
    // モバイルは「削除」「ノートで開く」をアイコンボタンにして1行に収める
    if (this.opts.mode === "edit" && this.opts.onDelete) {
      const onDelete = this.opts.onDelete;
      buttons.addButton((b) => {
        if (mobile) {
          b.setIcon("trash-2").setTooltip("削除");
          b.buttonEl.addClass("dt-m-icon-btn");
          b.buttonEl.setAttr("aria-label", "削除");
        } else {
          b.setButtonText("削除");
        }
        b.setWarning().onClick(async () => {
          this.close();
          await onDelete();
        });
      });
    }
    if (this.opts.mode === "edit" && this.opts.onOpenNote) {
      const onOpenNote = this.opts.onOpenNote;
      buttons.addButton((b) => {
        if (mobile) {
          b.setIcon("file-text");
          b.buttonEl.addClass("dt-m-icon-btn");
          b.buttonEl.setAttr("aria-label", "ノートで開く");
        } else {
          b.setButtonText("ノートで開く");
        }
        b.setTooltip("このタスクのブロックをノートで開く").onClick(async () => {
          this.close();
          await onOpenNote();
        });
      });
    }
    if (this.autosaveOn) {
      // 自動保存なので「保存」ボタンは出さない（閉じるだけでよい）
      buttons.addButton((b) => b.setButtonText("閉じる").setCta().onClick(() => void this.submit()));
    } else {
      buttons.addButton((b) => b.setButtonText("キャンセル").onClick(() => this.close()));
      buttons.addButton((b) =>
        b
          .setButtonText(this.opts.mode === "create" ? "追加" : "保存")
          .setCta()
          .onClick(() => void this.submit())
      );
    }

    if (this.autosaveOn) {
      // どの欄が変わっても拾えるように、ダイアログ全体で変更を見張る。
      // 実際に内容が変わったかは autosaveNow() が JSON 比較で判定する
      const bump = () => this.scheduleAutosave();
      contentEl.addEventListener("input", bump);
      contentEl.addEventListener("change", bump);
      contentEl.addEventListener("click", bump);
      contentEl.addEventListener("compositionstart", () => (this.composing = true));
      contentEl.addEventListener("compositionend", () => {
        this.composing = false;
        this.scheduleAutosave();
      });
      // 欄の初期化（チケット欄の正規化など）が終わった状態を「変更なし」の基準にする
      const d = this.draftForAutosave();
      this.initialJson = this.savedJson = d ? JSON.stringify(d) : "";
      this.setAutosaveStatus("変更は自動で保存されます");
    }
  }

  onClose(): void {
    if (this.autosaveTimer !== null) {
      window.clearTimeout(this.autosaveTimer);
      this.autosaveTimer = null;
    }
    if (this.autosaveOn) this.saveOnClose();
    this.contentEl.empty();
    this.opts.onClose?.();
  }

  // ---------- タブ（記録 / 作業メモ） ----------

  private showPane(name: "record" | "memo"): void {
    for (const p of this.panes) p.el.toggleClass("is-hidden", p.name !== name);
    for (const b of this.paneButtons) {
      b.el.toggleClass("is-active", b.name === name);
      b.el.setAttr("aria-selected", String(b.name === name));
    }
    // 隠れていた欄の textarea は高さが 0 のままなので伸ばし直す
    const pane = this.panes.find((p) => p.name === name)?.el;
    pane?.querySelectorAll<HTMLTextAreaElement>("textarea").forEach((ta) => {
      ta.style.height = "auto";
      ta.style.height = Math.min(Math.max(ta.scrollHeight, 36), 320) + "px";
    });
  }

  /** 作業メモタブのバッジ（ステップの消化と備考の有無。開かなくても忘れないように） */
  private updateMemoBadge(): void {
    if (!this.memoBadgeEl) return;
    const parts: string[] = [];
    const steps = this.steps.filter((st) => st.text.trim());
    if (steps.length) parts.push(`${steps.filter((st) => st.done).length}/${steps.length}`);
    if (this.details.trim()) parts.push("備考");
    this.memoBadgeEl.setText(parts.join(" · "));
  }

  // ---------- 他者（相手 + 内容の行） ----------

  private renderOthers(): void {
    const box = this.othersEl;
    if (!box) return;
    box.empty();
    this.others.forEach((o, i) => {
      const row = box.createDiv("dt-others-row");
      const who = row.createEl("input", { type: "text", cls: "dt-others-who" });
      who.value = o.who;
      who.setAttr("list", this.memberListId());
      who.placeholder = this.placeholderFor("他者/相手");
      who.addEventListener("input", () => (o.who = who.value));
      const what = row.createEl("input", { type: "text", cls: "dt-others-what" });
      what.value = o.what;
      what.placeholder = this.placeholderFor("他者/内容");
      what.addEventListener("input", () => (o.what = what.value));
      for (const el of [who, what]) {
        el.addEventListener("keydown", (e: KeyboardEvent) => {
          if (e.key === "Enter" && !e.isComposing) {
            e.preventDefault();
            void this.submit();
          }
        });
      }
      const del = row.createEl("button", { cls: "dt-others-del", attr: { type: "button", "aria-label": "この行を消す", title: "この行を消す" } });
      setIcon(del, "x");
      del.onclick = () => {
        this.others.splice(i, 1);
        this.renderOthers();
        this.scheduleAutosave();
      };
    });
    const add = box.createEl("button", { cls: "dt-others-add", text: "＋ 相手を追加", attr: { type: "button" } });
    add.onclick = () => {
      this.others.push({ who: "", what: "" });
      this.renderOthers();
      const inputs = box.querySelectorAll<HTMLInputElement>(".dt-others-row input");
      inputs[inputs.length - 2]?.focus();
    };
  }

  /** メンバー名の候補リスト（Owner・他者の相手に付ける）。無ければ空の ID */
  private memberListId(): string {
    const names = (this.opts.memberNames ?? []).map((n) => n.trim()).filter(Boolean);
    if (!names.length) return "";
    let dl = this.contentEl.querySelector<HTMLDataListElement>("datalist.dt-member-names");
    if (!dl) {
      dl = this.contentEl.createEl("datalist", { cls: "dt-member-names", attr: { id: "dt-member-names-" + Math.random().toString(36).slice(2, 8) } });
      for (const n of names) dl.createEl("option", { attr: { value: n } });
    }
    return dl.id;
  }

  // ---------- 注意（記録チェック担当が指摘する条件を保存前に見せる） ----------

  /** 選択中のタグ（最も深いもの。無ければ ""） */
  private primaryTag(): string {
    return deepestTag(this.selectedTags);
  }

  private parentTag(): string {
    return this.primaryTag().split("/")[0];
  }

  private placeholderFor(field: PlaceholderField): string {
    return placeholderFor(this.opts.tagFieldSchema ?? [], this.primaryTag(), field);
  }

  private applyPlaceholders(): void {
    for (const t of this.placeholderTargets) t.el.placeholder = this.placeholderFor(t.field);
    this.othersEl?.querySelectorAll<HTMLInputElement>(".dt-others-who").forEach((el) => (el.placeholder = this.placeholderFor("他者/相手")));
    this.othersEl?.querySelectorAll<HTMLInputElement>(".dt-others-what").forEach((el) => (el.placeholder = this.placeholderFor("他者/内容")));
  }

  /** 障害: タイトルに対象機能名かチケット番号が無いと後から区別できない */
  private updateTitleDesc(): void {
    const el = this.titleDescEl;
    if (!el) return;
    const trouble = TROUBLE_TAGS.includes(this.parentTag());
    const hasNumber = /#?\d{3,}/.test(this.title);
    if (trouble && !this.ticketId.trim() && !hasNumber) {
      el.setText("障害は、対象機能名かチケット番号をタイトルに入れると後から区別できます（チケット欄でも可）");
      el.addClass("dt-desc-warn");
    } else {
      el.setText("");
      el.removeClass("dt-desc-warn");
    }
  }

  /** 実績が同じ日の他のタスクと重なっているもの（15分超。#会議 はどちら側でも対象外） */
  private actualOverlaps(): { title: string; minutes: number }[] {
    const ranges = this.parseActual();
    if (!ranges || !ranges.length) return [];
    if (MEETING_TAGS.includes(this.parentTag())) return [];
    const out: { title: string; minutes: number }[] = [];
    for (const o of this.opts.otherActuals ?? []) {
      if (o.tags.some((t) => MEETING_TAGS.includes(normalizeTag(t).split("/")[0]))) continue;
      let total = 0;
      for (const a of ranges) for (const b of o.ranges) total += Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
      if (total > OVERLAP_MIN) out.push({ title: o.title, minutes: total });
    }
    return out;
  }

  private updateActualDesc(): void {
    const el = this.actualDescEl;
    if (!el) return;
    const r = this.parseActual();
    el.removeClass("is-error");
    el.removeClass("dt-desc-warn");
    if (r === null) {
      el.setText("実績は 10:05 - 11:20 / 13:00 - 13:30 のように入力してください");
      el.addClass("is-error");
      return;
    }
    if (r.length === 0) {
      el.setText("");
      return;
    }
    const total = `実績合計: ${formatDuration(actualTotal(r))}`;
    const hits = this.actualOverlaps();
    if (hits.length) {
      el.setText(`${total}。「${hits.map((h) => h.title).join("」「")}」の実績と ${hits.map((h) => h.minutes).join("・")} 分重なっています（15分超）`);
      el.addClass("dt-desc-warn");
    } else {
      el.setText(total);
    }
  }

  private updateStatusDesc(): void {
    const el = this.statusDescEl;
    if (!el) return;
    if (this.statusReasonInput) this.statusReasonInput.toggleClass("is-hidden", this.statusKind !== "中断");
    el.removeClass("dt-desc-warn");
    if (this.statusKind === "回答待ち" && this.answer !== "未") {
      el.setText("回答待ちなら「回答: 未」も入れると、質問対応として追跡できます");
      el.addClass("dt-desc-warn");
    } else {
      el.setText("");
    }
  }

  private updateDueDesc(el: HTMLElement): void {
    const due = this.dueText.trim();
    const today = moment().format("YYYY-MM-DD");
    el.removeClass("dt-desc-warn");
    if (due && /^\d{4}-\d{2}-\d{2}$/.test(due) && due < today && !this.done) {
      el.setText("期限を過ぎています");
      el.addClass("dt-desc-warn");
    } else {
      el.setText("");
    }
  }

  /** 備考: 10行超の長文と、パスワード・トークンらしき文字列 */
  private updateDetailsDesc(): void {
    const el = this.detailsDescEl;
    if (!el) return;
    const lines = this.details.split("\n").filter((l) => l.trim()).length;
    const secret = SECRET_RE.test(this.details);
    const msgs: string[] = [];
    if (lines > DETAILS_MAX_LINES) msgs.push(`${lines} 行あります。10行を超える手順やログは案件ノートか Runbook に置き、ここにはリンクだけ残します`);
    if (secret) msgs.push("パスワードやトークンに見える文字列があります。日報や Runbook へ転載されるので、ここには書かないでください");
    el.setText(msgs.join(" / "));
    el.toggleClass("dt-desc-warn", msgs.length > 0 && !secret);
    el.toggleClass("is-error", secret);
  }

  // ---------- タグ別スキーマ（選んだタグに応じた欄の表示） ----------

  /** 選択中のタグの必須・候補フィールドをまとめる（サブタグは親タグへフォールバック） */
  private schemaForSelectedTags(): { required: Set<string>; suggested: string[] } {
    const required = new Set<string>();
    const suggested: string[] = [];
    const schema = this.opts.tagFieldSchema ?? [];
    const tag = this.primaryTag();
    const def = tag ? schemaForTag(schema, tag) : null;
    if (def) {
      for (const f of def.required) {
        const label = normalizeFieldLabel(f);
        if (label) required.add(label);
      }
      for (const f of def.suggested) {
        const label = normalizeFieldLabel(f);
        if (label && !suggested.includes(label)) suggested.push(label);
      }
    }
    return { required, suggested: suggested.filter((l) => !required.has(l)) };
  }

  /**
   * 選択中のタグに応じて、欄の開閉・必須マーク・「＋」チップの並び・プレースホルダーを更新する。
   * 値が入っている欄と一度開いた欄は、タグを切り替えても閉じない（書いた内容が隠れて
   * 消える事故を防ぐ）。開いている欄の入力内容とフォーカスには触らない
   */
  private applyTagSchema(): void {
    const sch = this.schemaForSelectedTags();
    for (const row of this.fieldRows) {
      const required = sch.required.has(row.label);
      // 未完了セットの欄は、未完了のタスクで候補に挙がっていれば最初から開く（翌日に追うための欄なので）
      const openSet = OPEN_SET_FIELDS.includes(row.label) && !this.done && sch.suggested.includes(row.label);
      const open = required || openSet || this.userOpened.has(row.label) || row.hasValue();
      // 他者の欄が開くのに行が1つも無いと入力できないので、空の1行を用意する
      if (open && row.label === "他者" && !this.others.length) {
        this.others.push({ who: "", what: "" });
        this.renderOthers();
      }
      row.el.toggleClass("dt-collapsed", !open);
      row.el.toggleClass("dt-field-required", required);
      this.setRequiredMark(row.el, required);
      if (row.hasValue()) row.el.removeClass("dt-field-invalid");
    }
    // 横並びの行: 中身が全部隠れていたら行ごと隠す
    this.contentEl.querySelectorAll<HTMLElement>(".dt-row-pair").forEach((pair) => {
      pair.toggleClass("dt-collapsed", !pair.querySelector(".setting-item:not(.dt-collapsed)"));
    });
    // 未完了セットの外枠: 中の欄が全部隠れていたら枠ごと隠す
    if (this.openSetEl) {
      this.openSetEl.toggleClass("dt-collapsed", !this.openSetEl.querySelector(".setting-item:not(.dt-collapsed)"));
    }
    this.applyPlaceholders();
    this.updateTitleDesc();
    this.updateActualDesc();
    this.repaintTags?.();
    this.renderAddFieldChips(sch.suggested);
  }

  /** 欄のラベルに必須マーク（●）を付け外しする */
  private setRequiredMark(el: HTMLElement, required: boolean): void {
    const nameEl = (el.querySelector(".setting-item-name") ??
      el.querySelector(".dt-steps-name")) as HTMLElement | null;
    if (!nameEl) return;
    const mark = nameEl.querySelector(".dt-required-mark");
    if (required && !mark) {
      nameEl.createSpan({ cls: "dt-required-mark", text: "●", attr: { "aria-label": "必須" } });
    } else if (!required && mark) {
      mark.remove();
    }
  }

  /**
   * 閉じている欄を開く「＋」チップを並べ直す。候補（suggested）の欄は色付きで先頭に、
   * それ以外は「その他 N」1つに畳み、押したときだけ展開する（項目が多すぎて迷わないように）。
   * モバイルではチップを十数個並べると画面が埋まるため、
   * 「＋ 項目を追加」ボタン1つ + メニュー（候補が先頭・区切り付き）にまとめる
   */
  private renderAddFieldChips(suggested: string[]): void {
    const box = this.addFieldsEl;
    if (!box) return;
    box.empty();
    const closed = this.fieldRows.filter((r) => r.el.hasClass("dt-collapsed"));
    const head = closed
      .filter((r) => suggested.includes(r.label))
      .sort((a, b) => suggested.indexOf(a.label) - suggested.indexOf(b.label));
    const rest = closed.filter((r) => !suggested.includes(r.label));
    box.toggleClass("dt-collapsed", closed.length === 0);
    const openRow = (r: { label: string; focus?: () => void }) => {
      this.userOpened.add(r.label);
      this.applyTagSchema();
      r.focus?.();
    };
    if (Platform.isMobile) {
      const btn = box.createEl("button", {
        cls: "dt-add-field-chip dt-add-field-menu-btn",
        text: "＋ 項目を追加",
        attr: { type: "button", title: "隠れている項目の一覧から選んで開く" },
      });
      btn.onclick = (e: MouseEvent) => {
        const menu = new Menu();
        for (const r of head) menu.addItem((it) => it.setTitle(r.label).onClick(() => openRow(r)));
        if (head.length && rest.length) menu.addSeparator();
        for (const r of rest) menu.addItem((it) => it.setTitle(r.label).onClick(() => openRow(r)));
        menu.showAtMouseEvent(e);
      };
      return;
    }
    const chipFor = (r: { label: string; focus?: () => void }, suggestedChip: boolean) => {
      const chip = createEl("button", {
        cls: "dt-add-field-chip" + (suggestedChip ? " is-suggested" : ""),
        text: "＋ " + r.label,
        attr: { type: "button", title: `${r.label}の欄を開く` },
      });
      chip.onclick = () => openRow(r);
      return chip;
    };
    for (const r of head) box.appendChild(chipFor(r, true));
    if (rest.length) {
      const more = box.createEl("button", {
        cls: "dt-add-field-chip dt-add-field-more" + (this.moreOpen ? " is-open" : ""),
        attr: {
          type: "button",
          "aria-expanded": String(this.moreOpen),
          title: this.moreOpen ? "その他の項目を閉じる" : `その他の項目（${rest.map((r) => r.label).join("・")}）を開く`,
        },
      });
      const tri = more.createSpan("dt-add-field-more-icon");
      setIcon(tri, "chevron-down");
      more.createSpan({ text: "その他 " });
      more.createSpan({ cls: "dt-add-field-more-count", text: String(rest.length) });
      more.onclick = () => {
        this.moreOpen = !this.moreOpen;
        this.renderAddFieldChips(suggested);
      };
      if (this.moreOpen) {
        const sub = box.createDiv("dt-add-field-more-box");
        for (const r of rest) sub.appendChild(chipFor(r, false));
      }
    }
  }

  /** 必須なのに空の欄（保存時の警告に使う）。結果・原因・判断は完了にするときだけ求める */
  private requiredMissing(): { label: string; el: HTMLElement; focus?: () => void }[] {
    const sch = this.schemaForSelectedTags();
    if (!sch.required.size) return [];
    return this.fieldRows.filter(
      (r) => sch.required.has(r.label) && !r.hasValue() && (this.done || !DONE_ONLY_FIELDS.has(r.label))
    );
  }

  // ---------- 自動保存 ----------

  private get autosaveOn(): boolean {
    return this.opts.mode === "edit" && !!this.opts.onAutoSave;
  }

  private scheduleAutosave(): void {
    if (!this.autosaveOn) return;
    if (this.autosaveTimer !== null) window.clearTimeout(this.autosaveTimer);
    this.autosaveTimer = window.setTimeout(() => {
      this.autosaveTimer = null;
      this.autosaveNow();
    }, 700);
  }

  /** いまの入力内容から保存用の下書きを作る。時刻・実績の入力が途中なら null */
  private draftForAutosave(): TaskDraft | null {
    const r = this.parse();
    if ("error" in r) return null;
    if (this.opts.showActual && this.parseActual() === null) return null;
    return this.buildDraft(r);
  }

  private autosaveNow(): void {
    const cb = this.opts.onAutoSave;
    if (!cb) return;
    if (this.composing || this.autosaveInFlight) {
      // 変換中・保存中なら、落ち着いてからもう一度
      this.scheduleAutosave();
      return;
    }
    const d = this.draftForAutosave();
    if (!d) return; // 時刻が直ってから保存する（エラーはヒント欄に出ている）
    const json = JSON.stringify(d);
    if (json === this.savedJson) return;
    this.autosaveInFlight = true;
    this.setAutosaveStatus("保存中…");
    void Promise.resolve()
      .then(() => cb(d))
      .then(
        (ok) => {
          if (ok) {
            this.savedJson = json;
            this.setAutosaveStatus("保存しました ✓");
          } else {
            this.setAutosaveStatus("自動保存できませんでした", true);
          }
        },
        (e) => {
          console.error(e);
          this.setAutosaveStatus("自動保存できませんでした", true);
        }
      )
      .finally(() => {
        this.autosaveInFlight = false;
      });
  }

  /** 閉じるときの保存。開いてから何も変わっていなければ何もしない */
  private saveOnClose(): void {
    // ステップの追加欄に書きかけの文字が残っていれば拾う
    const pending = this.stepAddInput?.value.trim();
    if (pending) this.steps.push({ text: pending, done: false, children: [] });
    if (this.opts.dateField && !this.opts.dateField.allowEmpty && this.parseDateText() === null) {
      // 日付が空のまま閉じられた: 日付以外だけ保存する
      this.dateText = this.initialDateText;
      new Notice("日付が空のため、日付は変更していません");
    }
    if (this.opts.showActual && this.parseActual() === null) {
      // 実績が入力途中のまま閉じられた: 実績以外だけ保存する
      const prev = this.savedJson ? (JSON.parse(this.savedJson) as TaskDraft) : this.opts.initial;
      this.actualText = formatActualRanges(prev.actual ?? []);
      new Notice("実績の入力が正しくないため、実績は変更していません");
    }
    const r = this.parse();
    let times: { start: number | null; end: number | null };
    if ("error" in r) {
      // 時刻が入力途中のまま閉じられた: 時刻以外だけ保存する
      const prev = this.savedJson ? (JSON.parse(this.savedJson) as TaskDraft) : this.opts.initial;
      times = { start: prev.start, end: prev.end };
      new Notice("時刻の入力が正しくないため、時刻は変更していません");
    } else {
      times = r;
    }
    const data = this.buildDraft(times);
    if (JSON.stringify(data) === this.initialJson && this.dateText === this.initialDateText) return;
    void this.opts.onSubmit(data, this.dateSelection());
  }

  private setAutosaveStatus(text: string, isError = false): void {
    if (!this.autosaveStatusEl) return;
    this.autosaveStatusEl.setText(text);
    this.autosaveStatusEl.toggleClass("dt-autosave-error", isError);
  }

  // ---------- プロジェクト ----------

  /** 「プロジェクト」欄（選択・新規作成・ノートを開く）。折りたたみ登録用に Setting を返す */
  private buildProjectSection(contentEl: HTMLElement): Setting {
    const projects = this.opts.projects ?? [];
    const setting = new Setting(contentEl).setName("プロジェクト");
    setting.settingEl.setAttr(
      "title",
      "大きなタスクにまとめると、日をまたいでメモや進捗を共有できます。↗ ボタンでプロジェクトノートを開けます。"
    );
    let dd: DropdownComponent | null = null;

    // 「＋ 新規作成…」を選んだときに出す入力欄
    const newInput = setting.controlEl.createEl("input", {
      type: "text",
      cls: "dt-project-new",
      attr: { placeholder: "新しいプロジェクト名（Enter で作成）" },
    });
    const hideNew = () => newInput.removeClass("is-visible");
    const cancelNew = () => {
      newInput.value = "";
      hideNew();
      dd?.setValue(this.project ?? "");
    };
    const commitNew = async () => {
      const name = newInput.value.trim();
      if (!name) {
        cancelNew();
        return;
      }
      const link = await this.opts.onCreateProject?.(name);
      if (!link) {
        new Notice("プロジェクトを作成できませんでした");
        return;
      }
      if (dd && !Array.from(dd.selectEl.options).some((o) => o.value === link)) {
        dd.addOption(link, projectDisplayName(link));
      }
      this.project = link;
      dd?.setValue(link);
      newInput.value = "";
      hideNew();
      this.scheduleAutosave(); // setValue はイベントを出さないので明示的に
    };
    newInput.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        void commitNew();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancelNew();
      }
    });

    setting.addDropdown((d) => {
      dd = d;
      d.addOption("", "なし");
      // 完了済のプロジェクトは選択肢に出さない（既に選ばれているものは表示を保つ）
      for (const p of projects) {
        if (p.done && p.linktext !== this.project) continue;
        d.addOption(p.linktext, p.done ? p.name + "（完了）" : p.name);
      }
      if (this.project && !projects.some((p) => p.linktext === this.project)) {
        d.addOption(this.project, projectDisplayName(this.project));
      }
      d.addOption("__new__", "＋ 新規作成…");
      d.setValue(this.project ?? "");
      d.onChange((v) => {
        if (v === "__new__") {
          newInput.addClass("is-visible");
          newInput.focus();
          return;
        }
        hideNew();
        this.project = v || null;
      });
    });
    // 入力欄はドロップダウンの後ろに出す
    setting.controlEl.appendChild(newInput);

    setting.addExtraButton((b) =>
      b
        .setIcon("arrow-up-right")
        .setTooltip("プロジェクトノートを開く")
        .onClick(() => {
          if (!this.project) {
            new Notice("プロジェクトが選ばれていません");
            return;
          }
          const open = this.opts.onOpenProject;
          if (!open) return;
          const link = this.project;
          this.close(); // 自動保存があれば閉じるときに保存される
          void open(link);
        })
    );
    return setting;
  }

  // ---------- ステップ ----------

  /** 「ステップ」の入力欄（チェック・並べ替え・追加・削除）。折りたたみ用に外枠を返す */
  private buildStepsSection(contentEl: HTMLElement): HTMLElement {
    const wrap = contentEl.createDiv("dt-steps");
    const head = wrap.createDiv("dt-steps-head");
    head.setAttr(
      "title",
      "⋮⋮ をドラッグで並べ替え・Enter で次を追加。ノートには「- [ ] ステップ」のチェックリストとして保存されます。"
    );
    const name = head.createDiv("dt-steps-name");
    name.createSpan({ text: "ステップ" });
    this.stepsCountEl = name.createSpan({ cls: "dt-steps-count" });
    const bar = wrap.createDiv("dt-steps-progress");
    this.stepsBarEl = bar.createDiv();
    this.stepsListEl = wrap.createDiv("dt-steps-list");

    const addRow = wrap.createDiv("dt-step-add");
    const plus = addRow.createSpan("dt-step-add-icon");
    setIcon(plus, "plus");
    const addInput = addRow.createEl("input", { type: "text", attr: { placeholder: "ステップを追加…" } });
    this.stepAddInput = addInput;
    const commitAdd = () => {
      const text = addInput.value.trim();
      if (!text) return;
      this.steps.push({ text, done: false, children: [] });
      addInput.value = "";
      this.renderSteps();
    };
    addInput.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        e.stopPropagation();
        commitAdd();
      }
    });
    addInput.addEventListener("blur", commitAdd);
    this.renderSteps();
    return wrap;
  }

  private renderSteps(focusIndex?: number): void {
    // ステップの変更（チェック・追加・削除・並べ替え）はここを通るので、自動保存もここで拾う
    this.scheduleAutosave();
    const list = this.stepsListEl;
    list.empty();
    const done = this.steps.filter((st) => st.done).length;
    this.stepsCountEl.setText(this.steps.length ? `${done} / ${this.steps.length} 完了` : "");
    this.stepsBarEl.style.width = this.steps.length ? `${(done / this.steps.length) * 100}%` : "0%";
    this.stepsBarEl.parentElement?.toggleClass("is-empty", this.steps.length === 0);
    this.updateMemoBadge();

    this.steps.forEach((st, idx) => {
      const row = list.createDiv("dt-step");
      row.toggleClass("is-done", st.done);
      const grip = row.createDiv({ cls: "dt-step-grip", attr: { "aria-label": "ドラッグで並べ替え" } });
      setIcon(grip, "grip-vertical");
      const box = row.createDiv({ cls: "dt-step-check", attr: { role: "checkbox", "aria-checked": String(st.done) } });
      setIcon(box, iconName(st.done ? "check-square" : "square"));
      box.onclick = () => {
        st.done = !st.done;
        this.renderSteps();
      };
      const input = row.createEl("input", { type: "text", cls: "dt-step-text" });
      input.value = st.text;
      input.addEventListener("input", () => (st.text = input.value));
      input.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.isComposing) return;
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          this.steps.splice(idx + 1, 0, { text: "", done: false, children: [] });
          this.renderSteps(idx + 1);
        } else if (e.key === "Backspace" && input.value === "" && this.steps.length > 0) {
          e.preventDefault();
          this.steps.splice(idx, 1);
          this.renderSteps(Math.max(0, idx - 1));
        } else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && e.altKey) {
          // Alt + ↑↓ でも並べ替え
          e.preventDefault();
          const to = e.key === "ArrowUp" ? idx - 1 : idx + 1;
          if (to < 0 || to >= this.steps.length) return;
          [this.steps[idx], this.steps[to]] = [this.steps[to], this.steps[idx]];
          this.renderSteps(to);
        }
      });
      const del = row.createDiv({ cls: "dt-step-delete", attr: { "aria-label": "削除" } });
      setIcon(del, "x");
      del.onclick = () => {
        this.steps.splice(idx, 1);
        this.renderSteps();
      };
      this.attachStepDrag(row, grip, idx);
      if (focusIndex === idx) window.setTimeout(() => input.focus(), 0);
    });
  }

  /** ⋮⋮ をドラッグして順番を入れ替える */
  private attachStepDrag(row: HTMLElement, grip: HTMLElement, from: number): void {
    grip.addEventListener("pointerdown", (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const list = this.stepsListEl;
      const rows = Array.from(list.children) as HTMLElement[];
      const placeholder = document.createElement("div");
      placeholder.className = "dt-step dt-step-placeholder";
      placeholder.style.height = row.offsetHeight + "px";
      let to = from;
      let started = false;
      const pointerId = e.pointerId;
      const startY = e.clientY;

      const move = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        if (!started) {
          if (Math.abs(ev.clientY - startY) < 3) return;
          started = true;
          row.addClass("is-dragging");
          row.after(placeholder);
        }
        // 他の行の中央より上か下かで挿入位置を決める
        let index = 0;
        for (const r of rows) {
          if (r === row) continue;
          const rect = r.getBoundingClientRect();
          if (ev.clientY > rect.top + rect.height / 2) index++;
        }
        to = index;
        // プレースホルダーを移動
        const others = rows.filter((r) => r !== row);
        if (index >= others.length) list.appendChild(placeholder);
        else others[index].before(placeholder);
      };
      const finish = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", finish);
        grip.removeEventListener("pointercancel", cancel);
        try {
          grip.releasePointerCapture(pointerId);
        } catch (_e) {
          /* ignore */
        }
        placeholder.remove();
        row.removeClass("is-dragging");
        if (!started || to === from) return;
        const [item] = this.steps.splice(from, 1);
        this.steps.splice(to, 0, item);
        this.renderSteps();
      };
      const cancel = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        placeholder.remove();
        row.removeClass("is-dragging");
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", finish);
        grip.removeEventListener("pointercancel", cancel);
      };
      try {
        grip.setPointerCapture(pointerId);
      } catch (_e) {
        /* ignore */
      }
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", finish);
      grip.addEventListener("pointercancel", cancel);
    });
  }

  private parse(): { start: number | null; end: number | null } | { error: string } {
    const startEmpty = this.startText.trim() === "";
    const endEmpty = this.endText.trim() === "";
    if (startEmpty && endEmpty) {
      if (this.opts.allowUnscheduled) return { start: null, end: null };
      return { error: "時刻は 09:00 のように入力してください" };
    }
    const start = parseTimeInput(this.startText);
    let end = parseTimeInput(this.endText);
    if (start === null || end === null) return { error: "時刻は 09:00 のように入力してください" };
    end = endOfDayFix(start, end);
    if (end <= start) return { error: "終了時刻は開始時刻より後にしてください" };
    return { start, end };
  }

  /** 実績の入力を解析する。空なら [] 、読めなければ null */
  private parseActual(): ActualRange[] | null {
    return parseActualRanges(this.actualText);
  }

  /** 日付欄の入力（"YYYY-MM-DD"）を日付に。空・読めなければ null */
  private parseDateText(): Date | null {
    const t = this.dateText.trim();
    if (!t) return null;
    const [y, m, d] = t.split("-").map(Number);
    if (!y || !m || !d) return null;
    return new Date(y, m - 1, d);
  }

  /** onSubmit に渡す選択日（undefined = 日付欄なし / null = 日付未定） */
  private dateSelection(): Date | null | undefined {
    if (!this.opts.dateField) return undefined;
    return this.parseDateText();
  }

  private updateHint(): void {
    const r = this.parse();
    if ("error" in r) {
      this.hintEl.setText(r.error);
      this.hintEl.addClass("is-error");
    } else if (r.start === null) {
      this.hintEl.setText(this.opts.unscheduledHint ?? "時刻なし（未スケジュール）");
      this.hintEl.removeClass("is-error");
    } else {
      this.hintEl.setText(`所要時間: ${formatDuration((r.end as number) - r.start)}`);
      this.hintEl.removeClass("is-error");
    }
    this.refreshSchedSummary?.();
  }

  private async submit(): Promise<void> {
    const r = this.parse();
    if ("error" in r) {
      new Notice(r.error);
      return;
    }
    if (this.opts.showActual && this.parseActual() === null) {
      new Notice("実績は 10:05 - 11:20 のように入力してください");
      return;
    }
    if (this.opts.dateField && !this.opts.dateField.allowEmpty && this.parseDateText() === null) {
      new Notice("日付を入力してください");
      return;
    }
    // 保存前の確認: 必須の欄が空、または実績が同じ日の他タスクと重なっている
    //（記録チェック担当が 🔴🟡 にする条件。「このまま保存」も選べる。途中保存を妨げないため）
    if (!this.skipRequiredCheck && (this.opts.validateRequiredOnSave ?? true)) {
      const missing = this.requiredMissing();
      const overlaps = this.actualOverlaps();
      if (missing.length || overlaps.length) {
        for (const row of missing) {
          row.el.removeClass("dt-collapsed");
          row.el.addClass("dt-field-invalid");
        }
        if (missing.length) {
          this.showPane("record");
          missing[0].focus?.();
        }
        const items = [
          ...missing.map(
            (m) => `必須の「${m.label}:」が空です${DONE_ONLY_FIELDS.has(m.label) ? "（完了時に必須）" : ""}`
          ),
          ...overlaps.map((o) => `実績が「${o.title}」の実績と ${o.minutes} 分重なっています（15分超）`),
        ];
        new SaveCheckModal(this.app, items, () => {
          this.skipRequiredCheck = true;
          void this.submit();
        }).open();
        return;
      }
    }
    if (this.autosaveOn) {
      // 変更があれば onClose 側（saveOnClose）が保存する
      this.close();
      return;
    }
    const data = this.buildDraft(r);
    this.close();
    await this.opts.onSubmit(data, this.dateSelection());
  }

  /**
   * 状態欄の入力（種類 + 中断理由）から保存する値を作る。
   * 変わっていなければ元の書式のまま（既存ノートの表記を崩さない）
   */
  private statusValue(): string {
    const init = parseStatusValue(this.initialStatus);
    if (this.statusKind === init.kind && this.statusReasonText.trim() === init.reason) return this.initialStatus;
    return buildStatusValue(this.statusKind, this.statusReasonText);
  }

  /** いまの入力内容を TaskDraft にまとめる */
  private buildDraft(times: { start: number | null; end: number | null }): TaskDraft {
    const block = !!this.opts.showDoneCondition;
    return {
      title: joinTitleAndTags(this.title, this.tagChoices, this.selectedTags),
      start: times.start,
      end: times.end,
      done: this.done,
      reminder: this.reminder,
      doneCondition: block ? this.doneCondition.trim() : undefined,
      steps: block
        ? this.steps.filter((st) => st.text.trim()).map((st) => ({ ...st, text: st.text.trim() }))
        : undefined,
      retrospective: block && this.opts.mode === "edit"
        ? this.retrospective.replace(/\s*\n+\s*/g, " / ").trim()
        : undefined,
      result: block ? this.result.replace(/\s*\n+\s*/g, " / ").trim() : undefined,
      remaining: block ? this.remaining.trim() : undefined,
      cause: block ? this.cause.trim() : undefined,
      judgment: block ? this.judgment.trim() : undefined,
      others: block ? this.others.map((o) => joinOtherEntry(o.who, o.what)).filter(Boolean) : undefined,
      answer: block ? this.answer.trim() : undefined,
      status: block ? this.statusValue() : undefined,
      ownerName: block ? this.ownerNameText.trim() : undefined,
      due: block ? this.dueText.trim() : undefined,
      nextAction: block ? this.nextActionText.trim() : undefined,
      details: block ? this.details.replace(/\s+$/, "") : undefined,
      ticket: block
        ? this.ticketId.trim()
          ? ({ tracker: this.ticketTracker, id: this.ticketId.trim() } as TicketRef)
          : null
        : undefined,
      actual: this.opts.showActual ? this.parseActual() ?? undefined : undefined,
      project: this.opts.projects ? this.project : undefined,
      owner: this.opts.owners?.length ? this.owner : undefined,
    };
  }
}

/**
 * 時刻の入力欄をモバイル向けに調える: OS の時刻ピッカー（type="time"）にする。
 * スマホのフルキーボードで "09:00" を打つのは大変で、実質編集できなかったため。
 * デスクトップは自由入力（"0930" "9" なども可）のまま。
 * ピッカーでは 24:00 を選べないので、終了時刻の解釈側で 0:00 を「翌0時」とみなす
 * （endOfDayFix）。type=time は値が "HH:MM" 形式でないと表示されないが、
 * 値はすべて minutesToHHMM で作っているので問題ない
 */
export function setupTimeInput(el: HTMLInputElement): void {
  if (Platform.isMobile) el.type = "time";
}

/** 終了時刻の 0:00 を「翌0時（24:00）」とみなす（モバイルのピッカーで一日の終わりを選べるように） */
export function endOfDayFix(start: number, end: number): number {
  return end === 0 && start > 0 ? 1440 : end;
}

/** 実績の時間帯を入力欄の文字列に */
export function formatActualRanges(ranges: ActualRange[]): string {
  return ranges.map((r) => `${minutesToHHMM(r.start)} - ${minutesToHHMM(r.end)}`).join(" / ");
}

/** 実績の入力（"10:05 - 11:20 / 13:00 - 13:30"）を解析する。空なら []、読めなければ null */
export function parseActualRanges(text: string): ActualRange[] | null {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const out: ActualRange[] = [];
  for (const part of trimmed.split(/[/、,]+/)) {
    const p = part.trim();
    if (!p) continue;
    const m = /^(.+?)\s*(?:-|–|—|~|〜|～)\s*(.+)$/.exec(p);
    if (!m) return null;
    const start = parseTimeInput(m[1]);
    const end = parseTimeInput(m[2]);
    if (start === null || end === null || end <= start) return null;
    out.push({ start, end });
  }
  return out;
}

/** 設定のタグを正規化して重複を除く */
export function normalizeTagChoices(choices: TagColor[] | undefined): TagColor[] {
  const seen = new Set<string>();
  const out: TagColor[] = [];
  for (const r of choices ?? []) {
    const tag = normalizeTag(r.tag);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push({ tag, color: r.color, ...(r.hint ? { hint: r.hint } : {}) });
  }
  return out;
}

/** 選択中のタグのうち最も深いもの（サブタグ優先）。無ければ "" */
export function deepestTag(selected: Set<string>): string {
  let best = "";
  for (const t of selected) {
    if (!best || t.split("/").length > best.split("/").length) best = t;
  }
  return best;
}

/**
 * 色付きのタグボタンを2段で並べる。1段目は親タグ、親を選ぶとその下にサブタグ（設定に
 * "管理/質問" のように登録したもの）が出る。選べるのは最も深い1つで、クリックのたびに
 * selected を作り直して onChange に通知する（タイトルに付けるタグは1タスク1つ。
 * Rules/Timeline記録ルール.md。複数付くと日報の集計が二重計上になる）。
 * 戻り値は再描画関数（外から選択を変えたときに呼ぶ）
 */
export function renderTagChips(
  parent: HTMLElement,
  choices: TagColor[],
  selected: Set<string>,
  onChange?: (selected: Set<string>) => void
): () => void {
  const chips = parent.createDiv("dt-tag-chips");
  const subs = parent.createDiv("dt-tag-subs");
  const hint = parent.createDiv("dt-tag-hint");
  // 親タグ: "/" を含まない登録。サブタグしか登録されていない親は、そのサブタグの色で補う
  const parents: TagColor[] = [];
  for (const c of choices) {
    const p = c.tag.split("/")[0];
    if (parents.some((x) => x.tag === p)) continue;
    const own = choices.find((x) => x.tag === p);
    parents.push(own ?? { tag: p, color: c.color });
  }
  const subsOf = (p: string) => choices.filter((c) => c.tag.startsWith(p + "/"));
  const select = (tag: string) => {
    selected.clear();
    if (tag) selected.add(tag);
    paint();
    onChange?.(selected);
  };
  const mkChip = (host: HTMLElement, c: TagColor, label: string) => {
    const chip = host.createEl("button", { cls: "dt-tag-chip", text: label, attr: { type: "button" } });
    chip.style.setProperty("--dt-chip-color", c.color);
    chip.style.setProperty("--dt-chip-fg", contrastTextColor(c.color) || "#fff");
    if (c.hint) chip.setAttr("title", c.hint);
    return chip;
  };
  const parentChips = parents.map((c) => {
    const chip = mkChip(chips, c, "#" + c.tag);
    chip.onclick = () => select(deepestTag(selected).split("/")[0] === c.tag ? "" : c.tag);
    return { tag: c.tag, chip };
  });
  const paint = () => {
    const cur = deepestTag(selected);
    const parentTag = cur.split("/")[0];
    for (const p of parentChips) {
      const on = p.tag === parentTag;
      p.chip.toggleClass("is-selected", on);
      p.chip.setAttr("aria-pressed", String(on));
    }
    subs.empty();
    const list = parentTag ? subsOf(parentTag) : [];
    subs.toggleClass("is-hidden", list.length === 0);
    if (list.length) {
      subs.createSpan({ cls: "dt-tag-subs-lead", text: "サブタグ（分かるときだけ）" });
      for (const c of list) {
        const chip = mkChip(subs, c, "/" + c.tag.slice(parentTag.length + 1));
        const on = c.tag === cur;
        chip.toggleClass("is-selected", on);
        chip.setAttr("aria-pressed", String(on));
        chip.onclick = () => select(on ? parentTag : c.tag);
      }
    }
    const def = choices.find((c) => c.tag === cur);
    hint.setText(
      def?.hint
        ? (cur.includes("/") ? `#${cur}: ` : "") + def.hint
        : cur
          ? ""
          : "タイトルには最も深いタグを1つだけ書き込みます（#管理/質問 なら #管理 は書きません）"
    );
    hint.toggleClass("is-hidden", !hint.getText());
  };
  paint();
  return paint;
}

/**
 * タイトルから「選択肢にあるタグ」を取り出す。
 * 選択肢に無いタグ（手書きの #memo など）はタイトルに残す。
 */
export function splitKnownTags(title: string, known: string[]): { text: string; selected: Set<string> } {
  const selected = new Set<string>();
  if (!known.length) return { text: title, selected };
  const text = title
    .replace(/(^|[\s(（「\[])#([\p{L}\p{N}_\-\/]+)/gu, (all, pre: string, tag: string) => {
      const norm = normalizeTag(tag);
      if (!known.includes(norm)) return all;
      selected.add(norm);
      return pre;
    })
    .replace(/\s{2,}/g, " ")
    .trim();
  return { text, selected };
}

/**
 * タイトルの末尾に選択したタグを付ける。書くのは最も深い1つだけ
 * （「#管理 #管理/質問」と併記されていた古いタイトルも、保存時に「#管理/質問」へ揃う）
 */
export function joinTitleAndTags(title: string, choices: TagColor[], selected: Set<string>): string {
  const cur = deepestTag(selected);
  const known = choices.some((c) => c.tag === cur);
  return [title.trim(), cur && known ? "#" + cur : ""].filter(Boolean).join(" ");
}

/**
 * 保存前の確認（必須の欄が空・実績の重複など、記録チェック担当が指摘する条件）。
 * 会議中の途中保存などを妨げないよう、「このまま保存」で必ず保存できる
 */
class SaveCheckModal extends Modal {
  constructor(
    app: App,
    private items: string[],
    private onProceed: () => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("dt-modal");
    this.titleEl.setText("保存前の確認");
    this.contentEl.createEl("p", {
      cls: "dt-retro-lead",
      text: "このまま保存すると、記録チェックで指摘される状態です。会議中の途中保存なら「このまま保存」でかまいません。",
    });
    const ul = this.contentEl.createEl("ul", { cls: "dt-remaining-list" });
    for (const it of this.items) ul.createEl("li", { text: it });
    const buttons = new Setting(this.contentEl);
    buttons.settingEl.addClass("dt-modal-buttons");
    buttons.addButton((b) =>
      b
        .setButtonText("このまま保存")
        .setTooltip("指摘を残したまま保存します")
        .onClick(() => {
          this.close();
          this.onProceed();
        })
    );
    buttons.addButton((b) => b.setButtonText("戻って入力").setCta().onClick(() => this.close()));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** タグを選んだときに各欄へ出る文言（プレースホルダー）の一覧。選択中のタグを先頭に出す */
class PlaceholderListModal extends Modal {
  constructor(
    app: App,
    private schema: TagFieldSchema[],
    private choices: TagColor[],
    private current: string
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("dt-modal", "dt-ph-modal");
    this.titleEl.setText("タグ別の文言一覧");
    this.contentEl.createEl("p", {
      cls: "dt-retro-lead",
      text: "タグを選んだ瞬間に各欄へ薄く出る書き方の例です。サブタグに無い欄は親タグ、親にも無ければ既定の文言になります。設定「タグ別フィールド」の「文言」で変えられます。",
    });
    const tags = this.schema.map((r) => normalizeTag(r.tag)).filter(Boolean);
    for (const c of this.choices) if (!tags.includes(c.tag)) tags.push(c.tag);
    const cur = normalizeTag(this.current);
    tags.sort((a, b) => (a === cur ? -1 : b === cur ? 1 : 0));
    for (const tag of tags) {
      const color = this.choices.find((c) => c.tag === tag)?.color ?? this.choices.find((c) => c.tag === tag.split("/")[0])?.color ?? "";
      const box = this.contentEl.createEl("details", { cls: "dt-ph-group" + (tag === cur ? " is-current" : "") });
      if (tag === cur) box.setAttr("open", "");
      const sum = box.createEl("summary");
      const dot = sum.createSpan("dt-ph-dot");
      if (color) dot.style.background = color;
      sum.createSpan({ text: "#" + tag });
      if (tag === cur) sum.createSpan({ cls: "dt-ph-current", text: "選択中" });
      const dl = box.createEl("dl", { cls: "dt-ph-list" });
      const own = this.schema.find((r) => normalizeTag(r.tag) === tag)?.placeholders ?? {};
      for (const f of PLACEHOLDER_FIELDS) {
        const text = placeholderFor(this.schema, tag, f);
        dl.createEl("dt", { text: f });
        dl.createEl("dd", { text, cls: own[f] ? "" : "is-inherited" });
      }
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** 削除の確認（本文があるタスク用） */
export class ConfirmModal extends Modal {
  constructor(
    app: App,
    private message: string,
    private confirmText: string,
    private onConfirm: () => void | Promise<void>
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("dt-modal");
    this.titleEl.setText("確認");
    this.contentEl.createEl("p", { text: this.message });
    const buttons = new Setting(this.contentEl);
    buttons.settingEl.addClass("dt-modal-buttons");
    buttons.addButton((b) => b.setButtonText("キャンセル").onClick(() => this.close()));
    buttons.addButton((b) =>
      b
        .setButtonText(this.confirmText)
        .setWarning()
        .onClick(async () => {
          this.close();
          await this.onConfirm();
        })
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export interface PromptOptions {
  title: string;
  placeholder?: string;
  /** 決定ボタンのラベル */
  cta: string;
  initial?: string;
  /** 空欄のままでは呼ばれない（trim 済みの値を渡す） */
  onSubmit: (value: string) => void | Promise<void>;
}

/** 1行テキストの入力ダイアログ（プロジェクトのグループ名など） */
export class PromptModal extends Modal {
  constructor(
    app: App,
    private opts: PromptOptions
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("dt-modal");
    this.titleEl.setText(this.opts.title);
    const input = this.contentEl.createEl("input", {
      type: "text",
      cls: "dt-prompt-input",
      attr: { placeholder: this.opts.placeholder ?? "" },
    });
    input.value = this.opts.initial ?? "";
    const submit = () => {
      const v = input.value.trim();
      if (!v) return;
      this.close();
      void this.opts.onSubmit(v);
    };
    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    });
    const buttons = new Setting(this.contentEl);
    buttons.settingEl.addClass("dt-modal-buttons");
    buttons.addButton((b) => b.setButtonText("キャンセル").onClick(() => this.close()));
    buttons.addButton((b) => b.setButtonText(this.opts.cta).setCta().onClick(submit));
    window.setTimeout(() => input.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export interface ProjectCreateOptions {
  /** グループの選択肢（設定の並び順 + 使用中のもの） */
  groups: string[];
  /** 最初から選んでおくグループ（null / 無指定 = なし） */
  initialGroup?: string | null;
  /** 使うテンプレートのパス（表示用）。null = 最小の雛形で作る */
  templatePath?: string | null;
  /** 空欄のままでは呼ばれない（trim 済みの名前と、選んだグループを渡す） */
  onSubmit: (name: string, group: string | null) => void | Promise<void>;
}

/** 新しいプロジェクトを作るダイアログ（パネルの＋ボタン・コマンドから） */
export class ProjectCreateModal extends Modal {
  private name = "";
  private group: string | null;

  constructor(
    app: App,
    private opts: ProjectCreateOptions
  ) {
    super(app);
    this.group = opts.initialGroup ?? null;
  }

  onOpen(): void {
    this.modalEl.addClass("dt-modal");
    this.titleEl.setText("新しいプロジェクト");

    const submit = () => {
      const name = this.name.trim();
      if (!name) {
        new Notice("プロジェクト名を入力してください");
        return;
      }
      this.close();
      void this.opts.onSubmit(name, this.group?.trim() || null);
    };

    const nameSetting = new Setting(this.contentEl).setName("名前");
    nameSetting.setDesc(
      this.opts.templatePath
        ? `テンプレート「${this.opts.templatePath}」から作成します。`
        : "最小の雛形で作成します（設定「プロジェクトのテンプレート」でテンプレートを指定できます）。"
    );
    const nameInput = nameSetting.controlEl.createEl("input", {
      type: "text",
      cls: "dt-prompt-input",
      attr: { placeholder: "例: 環境構築" },
    });
    nameInput.addEventListener("input", () => (this.name = nameInput.value));
    nameInput.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        submit();
      }
    });

    // グループ: 既存の一覧から選ぶか、「＋ 新しいグループ…」でその場で入力する
    const groupSetting = new Setting(this.contentEl).setName("グループ");
    groupSetting.settingEl.setAttr("title", "プロジェクトノートの frontmatter（group）に保存されます");
    const newGroupInput = groupSetting.controlEl.createEl("input", {
      type: "text",
      cls: "dt-project-new",
      attr: { placeholder: "新しいグループ名" },
    });
    newGroupInput.addEventListener("input", () => (this.group = newGroupInput.value));
    newGroupInput.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        submit();
      }
    });
    groupSetting.addDropdown((d) => {
      d.addOption("", "なし");
      const groups = [...new Set(this.opts.groups.map((g) => g.trim()).filter(Boolean))];
      for (const g of groups) d.addOption(g, g);
      if (this.group && !groups.includes(this.group)) d.addOption(this.group, this.group);
      d.addOption("__new__", "＋ 新しいグループ…");
      d.setValue(this.group ?? "");
      d.onChange((v) => {
        if (v === "__new__") {
          this.group = newGroupInput.value;
          newGroupInput.addClass("is-visible");
          newGroupInput.focus();
          return;
        }
        newGroupInput.removeClass("is-visible");
        this.group = v || null;
      });
    });
    groupSetting.controlEl.appendChild(newGroupInput);

    const buttons = new Setting(this.contentEl);
    buttons.settingEl.addClass("dt-modal-buttons");
    buttons.addButton((b) => b.setButtonText("キャンセル").onClick(() => this.close()));
    buttons.addButton((b) => b.setButtonText("作成").setCta().onClick(submit));
    window.setTimeout(() => nameInput.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** 完了時のポップアップに追加で出す欄（選んだタグで必須なのに空のもの） */
export interface RetroExtraField {
  /** TaskDraft のキー（cause / judgment / remaining / answer / doneCondition / ownerName / nextAction / due） */
  key: string;
  /** 欄のラベル（原因 / 判断 …） */
  label: string;
  placeholder?: string;
  /** "answer" = 済/未のドロップダウン。それ以外は1行テキスト */
  kind?: "text" | "answer";
}

export interface RetrospectiveOptions {
  taskTitle: string;
  durationLabel: string;
  /** タグに応じた「結果」「ふりかえり」のプレースホルダー */
  resultPlaceholder?: string;
  retroPlaceholder?: string;
  /** 選んだタグで必須なのに空の欄（結果以外）。この順に出す */
  extraFields?: RetroExtraField[];
  /** チェック済みのステップ（「結果の下書きにする」ボタンの材料。無ければボタンを出さない） */
  doneSteps?: string[];
  /** 記録済みの実績。渡すと実績の確認・修正欄を出す（完了時の自動記録の直しに使う） */
  actual?: ActualRange[];
  /** 記録済みの「結果」。欄の初期値になる（すでに書いてあれば書き換えの機会になる） */
  result?: string;
  /**
   * text = ふりかえり（空 = 変更なし）、actual = 実績欄の内容（欄を出していなければ undefined）、
   * result = 結果欄の内容、extras = 追加欄の入力（キー = RetroExtraField.key。空欄は含めない）
   */
  onSave: (
    text: string,
    actual: ActualRange[] | undefined,
    result: string,
    extras: Record<string, string>
  ) => void | Promise<void>;
}

/** 完了時に「結果」と「ふりかえり」の入力を促すダイアログ（実績の確認・修正もここでできる） */
export class RetrospectiveModal extends Modal {
  private text = "";
  private resultText: string;
  private actualText: string;
  private extras: Record<string, string> = {};

  constructor(
    app: App,
    private opts: RetrospectiveOptions
  ) {
    super(app);
    this.resultText = (opts.result ?? "").replace(/ \/ /g, "\n");
    this.actualText = formatActualRanges(opts.actual ?? []);
  }

  onOpen(): void {
    this.modalEl.addClass("dt-modal", "dt-retro-modal");
    this.titleEl.setText("完了の記録");
    const extras = this.opts.extraFields ?? [];
    this.contentEl.createEl("p", {
      cls: "dt-retro-lead",
      text:
        `「${this.opts.taskTitle || "(無題)"}」（${this.opts.durationLabel}）が完了しました。` +
        (extras.length
          ? "記録チェックが求める欄だけを出しています。あとで書くこともできます。"
          : "何がどこまで終わったか（結果）と、次への改善（ふりかえり）を残しておくと、日報とふりかえりに活きます。"),
    });

    // ---- 結果 ----
    const resSetting = new Setting(this.contentEl).setName("結果");
    resSetting.settingEl.addClass("dt-retro-setting");
    resSetting.setDesc("ノートには「- 結果: …」として保存されます。1行の要約でかまいません。");
    const resTa = resSetting.controlEl.createEl("textarea", {
      cls: "dt-retro-field",
      attr: { rows: "2", placeholder: this.opts.resultPlaceholder ?? "例: 実装完了。テストケースの修正まで終わった" },
    });
    resTa.value = this.resultText;
    const growRes = () => {
      resTa.style.height = "auto";
      resTa.style.height = Math.min(Math.max(resTa.scrollHeight, 56), 220) + "px";
    };
    resTa.addEventListener("input", () => {
      this.resultText = resTa.value;
      growRes();
    });
    resTa.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.isComposing) {
        e.preventDefault();
        void this.save();
      }
    });
    window.setTimeout(() => {
      growRes();
      resTa.focus();
    }, 0);
    // チェック済みのステップを結果の下書きにする（ステップが結果の材料になる）
    const doneSteps = (this.opts.doneSteps ?? []).map((t) => t.trim()).filter(Boolean);
    if (doneSteps.length) {
      const btn = resSetting.descEl.createEl("button", {
        cls: "dt-retro-from-steps",
        text: "チェック済みのステップを結果の下書きにする",
        attr: { type: "button" },
      });
      btn.onclick = () => {
        const draft = doneSteps.join("\n");
        resTa.value = this.resultText.trim() ? this.resultText + "\n" + draft : draft;
        this.resultText = resTa.value;
        growRes();
        resTa.focus();
      };
    }

    // ---- 追加欄（選んだタグで必須なのに空のもの: 原因・判断・回答など）----
    for (const f of extras) {
      const st = new Setting(this.contentEl).setName(f.label);
      st.nameEl.createSpan({ cls: "dt-required-mark", text: "●", attr: { "aria-label": "必須" } });
      if (f.kind === "answer") {
        st.addDropdown((d) => {
          d.addOption("", "（未設定）");
          d.addOption("未", "未");
          d.addOption("済", "済");
          d.setValue("").onChange((v) => {
            if (v) this.extras[f.key] = v;
            else delete this.extras[f.key];
          });
        });
      } else {
        st.addText((t) => {
          t.setPlaceholder(f.placeholder ?? "").onChange((v) => {
            if (v.trim()) this.extras[f.key] = v.trim();
            else delete this.extras[f.key];
          });
          t.inputEl.addClass("dt-title-input");
          t.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
            if (e.key === "Enter" && !e.isComposing) {
              e.preventDefault();
              void this.save();
            }
          });
        });
      }
    }

    // ---- 実績 ----
    if (this.opts.actual !== undefined) {
      const actSetting = new Setting(this.contentEl).setName("実績");
      const updateDesc = () => {
        const r = parseActualRanges(this.actualText);
        actSetting.descEl.toggleClass("is-error", r === null);
        actSetting.descEl.setText(
          r === null
            ? "実績は 10:05 - 11:20 のように入力してください"
            : this.opts.actual?.length
              ? "自動で記録した実績です。違っていればここで直せます（中断は / で区切り）。"
              : "実際に作業した時間（空のままでもかまいません）。"
        );
      };
      actSetting.addText((t) => {
        t.setPlaceholder("10:05 - 11:20 / 13:00 - 13:30")
          .setValue(this.actualText)
          .onChange((v) => {
            this.actualText = v;
            updateDesc();
          });
        t.inputEl.addClass("dt-actual-input");
        t.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
          if (e.key === "Enter" && !e.isComposing) {
            e.preventDefault();
            void this.save();
          }
        });
      });
      updateDesc();
    }

    // ---- ふりかえり ----
    const retroSetting = new Setting(this.contentEl).setName("ふりかえり");
    retroSetting.settingEl.addClass("dt-retro-setting");
    retroSetting.setDesc("作業してみてどうだったか・次はどう改善するか。");
    const ta = retroSetting.controlEl.createEl("textarea", {
      cls: "dt-retro-field",
      attr: { rows: "3", placeholder: this.opts.retroPlaceholder ?? "例: 想定より調査に時間がかかった。次は先に既知の事例を探す" },
    });
    const grow = () => {
      ta.style.height = "auto";
      ta.style.height = Math.min(Math.max(ta.scrollHeight, 80), 320) + "px";
    };
    ta.addEventListener("input", () => {
      this.text = ta.value;
      grow();
    });
    ta.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.isComposing) {
        e.preventDefault();
        void this.save();
      }
    });
    window.setTimeout(grow, 0);

    const buttons = new Setting(this.contentEl);
    buttons.settingEl.addClass("dt-modal-buttons");
    buttons.addButton((b) => b.setButtonText("あとで").onClick(() => this.close()));
    buttons.addButton((b) => b.setButtonText("保存").setCta().onClick(() => void this.save()));
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async save(): Promise<void> {
    const text = this.text.replace(/\s*\n+\s*/g, " / ").trim();
    const result = this.resultText.replace(/\s*\n+\s*/g, " / ").trim();
    let actual: ActualRange[] | undefined;
    if (this.opts.actual !== undefined) {
      const r = parseActualRanges(this.actualText);
      if (r === null) {
        new Notice("実績は 10:05 - 11:20 のように入力してください");
        return;
      }
      actual = r;
    }
    this.close();
    // ふりかえりが空でも、結果や実績を書き換えていれば保存する
    const actualChanged =
      actual !== undefined && JSON.stringify(actual) !== JSON.stringify(this.opts.actual ?? []);
    const resultChanged = result !== (this.opts.result ?? "").trim();
    const extras = { ...this.extras };
    if (text || actualChanged || resultChanged || Object.keys(extras).length) {
      await this.opts.onSave(text, actual, result, extras);
    }
  }
}

export interface RemainingStepsOptions {
  taskTitle: string;
  /** 未チェックのステップの文言 */
  steps: string[];
  /**
   * 完了を続行する。remaining = 「- 残: …」として書き込む文言（「そのまま完了」なら null）
   */
  onComplete: (remaining: string | null) => void | Promise<void>;
  /** 「翌日へ持ち越す」を選んだとき（完了にはしない）。無ければボタンを出さない */
  onCarryOver?: () => void | Promise<void>;
}

/**
 * 未チェックのステップが残っているタスクを完了にしようとしたときの確認。
 * 残件を「- 残: …」として明示するか、持ち越すか、そのまま完了するかを選ぶ
 * （残が書かれていないと、日報などの下流では完了扱いになってしまうため）
 */
export class RemainingStepsModal extends Modal {
  constructor(
    app: App,
    private opts: RemainingStepsOptions
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("dt-modal", "dt-retro-modal");
    this.titleEl.setText("未完了のステップがあります");
    this.contentEl.createEl("p", {
      cls: "dt-retro-lead",
      text:
        `「${this.opts.taskTitle || "(無題)"}」を完了にしようとしていますが、` +
        `チェックされていないステップが ${this.opts.steps.length} 件あります。` +
        "残件を「残:」として書いておくと、完了扱いのまま埋もれるのを防げます。",
    });
    const ul = this.contentEl.createEl("ul", { cls: "dt-remaining-list" });
    for (const st of this.opts.steps) ul.createEl("li", { text: st });

    const buttons = new Setting(this.contentEl);
    buttons.settingEl.addClass("dt-modal-buttons");
    buttons.addButton((b) => b.setButtonText("キャンセル").onClick(() => this.close()));
    if (this.opts.onCarryOver) {
      const onCarryOver = this.opts.onCarryOver;
      buttons.addButton((b) =>
        b
          .setButtonText("翌日へ持ち越す")
          .setTooltip("完了にせず、残ステップを引き継いだ続きのブロックを翌日に作ります")
          .onClick(async () => {
            this.close();
            await onCarryOver();
          })
      );
    }
    buttons.addButton((b) =>
      b
        .setButtonText("そのまま完了")
        .setTooltip("残: を書かずに完了にします")
        .onClick(async () => {
          this.close();
          await this.opts.onComplete(null);
        })
    );
    buttons.addButton((b) =>
      b
        .setButtonText("残: に記録して完了")
        .setCta()
        .setTooltip("未チェックのステップを「- 残: …」として書き込んでから完了にします")
        .onClick(async () => {
          this.close();
          await this.opts.onComplete(this.opts.steps.join(" / "));
        })
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
