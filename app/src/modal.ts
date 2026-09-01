import { App, DropdownComponent, Menu, Modal, Notice, Platform, Setting, moment, setIcon } from "obsidian";
import type { TaskDraft } from "./model";
import { projectDisplayName, type ProjectRef } from "./project";
import {
  actualTotal,
  renderStatusValue,
  statusReason,
  type ActualRange,
  type ReminderSetting,
  type TaskStep,
  type TicketRef,
} from "./markdown/blocks";
import {
  normalizeFieldLabel,
  normalizeTag,
  schemaForTag,
  ticketUrl,
  type IssueTracker,
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
  /** 他者の入力（1行 = 1件。保存時に「- 他者: …」の行に分ける） */
  private othersText: string;
  private answer: string;
  /** 状態の中断理由（表示・入力用。保存時に「中断(理由)」へ戻す） */
  private statusText: string;
  /** 開いたときの状態の生の値（理由が変わっていなければ書式を保つ） */
  private initialStatus: string;
  private ownerNameText: string;
  private dueText: string;
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
  /** 選択中のタグ（正規化済み。"#" 抜き） */
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
  /** 必須フィールドの警告を出したあと「このまま保存」が選ばれた */
  private skipRequiredCheck = false;
  /** モバイルの日時サマリー行の表示を更新する（モバイル以外は null） */
  private refreshSchedSummary: (() => void) | null = null;

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
    this.othersText = (opts.initial.others ?? []).join("\n");
    this.answer = opts.initial.answer ?? "";
    this.initialStatus = opts.initial.status ?? "";
    this.statusText = statusReason(this.initialStatus);
    this.ownerNameText = opts.initial.ownerName ?? "";
    this.dueText = opts.initial.due ?? "";
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

    // 項目の説明は行のツールチップ（ホバー）で出す
    const tip = (el: HTMLElement, text: string) => el.setAttr("title", text);

    // 値が空の任意項目は隠しておき、下の「＋」チップで開く。
    // hasValue は「今の入力に値があるか」を返す関数（タグ別スキーマの適用時に毎回見直す）
    this.fieldRows = [];
    this.userOpened = new Set();
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

    // ---- モバイル: TickTick 風のシンプル表示 ----
    // 上段は「丸い完了チェック + 日時サマリー」の1行だけにし、日付・時間・実績の
    // 入力欄はサマリーのタップで開閉する（空の任意項目は「＋ 項目を追加」のメニューへ）
    const mobile = Platform.isMobile;
    let schedBody: HTMLElement | null = null;
    if (mobile) {
      this.modalEl.addClass("dt-modal-mobile");
      const head = contentEl.createDiv("dt-m-head");
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
        };
      }
      const sched = head.createEl("button", { cls: "dt-m-sched", attr: { type: "button" } });
      tip(sched, "タップで日付・時間の欄を開閉します。");
      const schedText = sched.createSpan("dt-m-sched-text");
      const chevron = sched.createSpan("dt-m-sched-chevron");
      setIcon(chevron, "chevron-down");
      schedBody = contentEl.createDiv({ cls: ["dt-m-sched-body", "dt-collapsed"] });
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
    const schedParent = schedBody ?? contentEl;

    // ---- タイトル（編集時は「完了」も同じ行に。モバイルの完了は上の丸チェック）----
    const titleSetting = new Setting(contentEl).setName("タイトル");
    titleSetting.settingEl.addClass("dt-title-setting");
    titleSetting.addText((t) => {
      t.setPlaceholder("タスクの名前")
        .setValue(this.title)
        .onChange((v) => (this.title = v));
      t.inputEl.addClass("dt-title-input");
      t.inputEl.addEventListener("keydown", onKey);
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
        tg.setValue(this.done).onChange((v) => (this.done = v));
        doneWrap.appendChild(tg.toggleEl);
      });
    }

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
      tip(actSetting.settingEl, "実際に作業した時間。中断したら / で区切って複数書けます。");
      let actualInput: HTMLInputElement | null = null;
      const updateActualDesc = () => {
        const r = this.parseActual();
        actSetting.descEl.toggleClass("is-error", r === null);
        if (r === null) {
          actSetting.descEl.setText("実績は 10:05 - 11:20 / 13:00 - 13:30 のように入力してください");
        } else if (r.length === 0) {
          actSetting.descEl.setText("");
        } else {
          actSetting.descEl.setText(`実績合計: ${formatDuration(actualTotal(r))}`);
        }
      };
      actSetting.addText((t) => {
        t.setPlaceholder("10:05 - 11:20 / 13:00 - 13:30")
          .setValue(this.actualText)
          .onChange((v) => {
            this.actualText = v;
            updateActualDesc();
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
            updateActualDesc();
          })
      );
      updateActualDesc();
    }

    // ---- プロジェクト・誰の予定か（横並び）----
    const pairMain = contentEl.createDiv("dt-row-pair");
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

    // ---- タグ ----
    if (this.tagChoices.length) {
      const tagSetting = new Setting(contentEl).setName("タグ");
      tagSetting.settingEl.addClass("dt-tag-setting");
      tip(tagSetting.settingEl, "選んだタグは見出しの末尾に #タグ として書き込まれます。");
      renderTagChips(tagSetting.controlEl, this.tagChoices, this.selectedTags, () =>
        this.applyTagSchema()
      );
    }

    if (this.opts.showDoneCondition) {
      // ---- ステップ（空のときは「＋」チップから開く）----
      const stepsEl = this.buildStepsSection(contentEl);
      collapsible(stepsEl, "ステップ", () => this.steps.length > 0, () => this.stepAddInput?.focus());

      // ---- 完了条件 ----
      const dcSetting = new Setting(contentEl).setName("完了条件");
      tip(dcSetting.settingEl, "何ができたら終わりか。ノートには「- 完了条件: …」として保存されます。");
      let dcInput: HTMLInputElement | null = null;
      dcSetting.addText((t) => {
        t.setPlaceholder("例: レビューが通ってマージされている")
          .setValue(this.doneCondition)
          .onChange((v) => (this.doneCondition = v));
        t.inputEl.addClass("dt-title-input");
        t.inputEl.addEventListener("keydown", onKey);
        dcInput = t.inputEl;
      });
      collapsible(dcSetting.settingEl, "完了条件", () => this.doneCondition.trim() !== "", () => dcInput?.focus());

      // ---- 詳細 ----
      const detailSetting = new Setting(contentEl).setName("詳細");
      tip(detailSetting.settingEl, "自由なメモ（Markdown）。ノートのブロック本文と相互に反映されます。");
      detailSetting.settingEl.addClass("dt-retro-setting");
      const detailTa = detailSetting.controlEl.createEl("textarea", {
        cls: "dt-retro-field dt-details-field",
        attr: { rows: "1", placeholder: "例: - 参考リンク\n- 気づいたことのメモ" },
      });
      detailTa.value = this.details;
      const growDetail = () => {
        detailTa.style.height = "auto";
        detailTa.style.height = Math.min(Math.max(detailTa.scrollHeight, 36), 320) + "px";
      };
      detailTa.addEventListener("input", () => {
        this.details = detailTa.value;
        growDetail();
      });
      detailTa.addEventListener("focus", () => {
        detailTa.addClass("is-active");
        growDetail();
      });
      detailTa.addEventListener("blur", () => {
        detailTa.removeClass("is-active");
        growDetail();
      });
      // Enter は改行（Markdown なので変換しない）。保存は Ctrl+Enter
      detailTa.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.isComposing) {
          e.preventDefault();
          void this.submit();
        }
      });
      window.setTimeout(growDetail, 0);
      collapsible(detailSetting.settingEl, "詳細", () => this.details.trim() !== "", () => detailTa.focus());

      // ---- 結果・残（編集時のみ。何がどこまで終わったか / 完了後に何が残ったか）----
      if (this.opts.mode === "edit") {
        const resSetting = new Setting(contentEl).setName("結果");
        tip(resSetting.settingEl, "何がどこまで終わったか。ノートには「- 結果: …」として保存され、日報の元データになります。");
        resSetting.settingEl.addClass("dt-retro-setting");
        const resTa = resSetting.controlEl.createEl("textarea", {
          cls: "dt-retro-field",
          attr: { rows: "1", placeholder: "例: 実装完了。テストケースの修正まで終わった" },
        });
        resTa.value = this.result.replace(/ \/ /g, "\n");
        const growRes = () => {
          resTa.style.height = "auto";
          resTa.style.height = Math.min(Math.max(resTa.scrollHeight, 36), 220) + "px";
        };
        resTa.addEventListener("input", () => {
          this.result = resTa.value;
          growRes();
        });
        resTa.addEventListener("focus", () => {
          resTa.addClass("is-active");
          growRes();
        });
        resTa.addEventListener("blur", () => {
          resTa.removeClass("is-active");
          growRes();
        });
        // Enter は改行（保存は Ctrl+Enter）
        resTa.addEventListener("keydown", (e: KeyboardEvent) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.isComposing) {
            e.preventDefault();
            void this.submit();
          }
        });
        window.setTimeout(growRes, 0);
        collapsible(resSetting.settingEl, "結果", () => this.result.trim() !== "", () => resTa.focus());

        // ---- 原因・判断（横並び。障害・バグ系の記録）----
        const pairCause = contentEl.createDiv("dt-row-pair");
        const causeSetting = new Setting(pairCause).setName("原因");
        tip(causeSetting.settingEl, "障害・バグの原因。ノートには「- 原因: …」として保存されます。");
        let causeInput: HTMLInputElement | null = null;
        causeSetting.addText((t) => {
          t.setPlaceholder("例: 排他制御の考慮漏れ")
            .setValue(this.cause)
            .onChange((v) => (this.cause = v));
          t.inputEl.addClass("dt-title-input");
          t.inputEl.addEventListener("keydown", onKey);
          causeInput = t.inputEl;
        });
        collapsible(causeSetting.settingEl, "原因", () => this.cause.trim() !== "", () => causeInput?.focus());

        const judgeSetting = new Setting(pairCause).setName("判断");
        tip(judgeSetting.settingEl, "その場でどう判断したか。ノートには「- 判断: …」として保存されます。");
        let judgeInput: HTMLInputElement | null = null;
        judgeSetting.addText((t) => {
          t.setPlaceholder("例: 恒久対応は次スプリントで")
            .setValue(this.judgment)
            .onChange((v) => (this.judgment = v));
          t.inputEl.addClass("dt-title-input");
          t.inputEl.addEventListener("keydown", onKey);
          judgeInput = t.inputEl;
        });
        collapsible(judgeSetting.settingEl, "判断", () => this.judgment.trim() !== "", () => judgeInput?.focus());
        finishPair(pairCause);

        const remSetting = new Setting(contentEl).setName("残");
        tip(remSetting.settingEl, "完了にしたあとに残っている作業。ノートには「- 残: …」として保存されます。");
        let remInput: HTMLInputElement | null = null;
        remSetting.addText((t) => {
          t.setPlaceholder("例: 結合環境に投入")
            .setValue(this.remaining)
            .onChange((v) => (this.remaining = v));
          t.inputEl.addClass("dt-title-input");
          t.inputEl.addEventListener("keydown", onKey);
          remInput = t.inputEl;
        });
        collapsible(remSetting.settingEl, "残", () => this.remaining.trim() !== "", () => remInput?.focus());

        // ---- 他者（ボールが相手にあるもの。1行 = 1件で複数書ける）----
        const othSetting = new Setting(contentEl).setName("他者");
        tip(
          othSetting.settingEl,
          "ボールが相手にあるもの。「相手 / 内容」を1行に1件で書くと、ノートには「- 他者: …」の行が件数ぶん保存されます。"
        );
        othSetting.settingEl.addClass("dt-retro-setting");
        const othTa = othSetting.controlEl.createEl("textarea", {
          cls: "dt-retro-field",
          attr: { rows: "1", placeholder: "例: 田中 / レビュー依頼中（1行に1件）" },
        });
        othTa.value = this.othersText;
        const growOth = () => {
          othTa.style.height = "auto";
          othTa.style.height = Math.min(Math.max(othTa.scrollHeight, 36), 220) + "px";
        };
        othTa.addEventListener("input", () => {
          this.othersText = othTa.value;
          growOth();
        });
        othTa.addEventListener("focus", () => {
          othTa.addClass("is-active");
          growOth();
        });
        othTa.addEventListener("blur", () => {
          othTa.removeClass("is-active");
          growOth();
        });
        // Enter は改行（1行 = 1件なので変換しない）。保存は Ctrl+Enter
        othTa.addEventListener("keydown", (e: KeyboardEvent) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.isComposing) {
            e.preventDefault();
            void this.submit();
          }
        });
        window.setTimeout(growOth, 0);
        collapsible(othSetting.settingEl, "他者", () => this.othersText.trim() !== "", () => othTa.focus());

        // ---- 回答・状態（横並び）----
        const pairAns = contentEl.createDiv("dt-row-pair");
        const ansSetting = new Setting(pairAns).setName("回答");
        tip(ansSetting.settingEl, "質問への回答が済んだか。ノートには「- 回答: 済 / 未」として保存されます。");
        let ansSelect: HTMLSelectElement | null = null;
        ansSetting.addDropdown((d) => {
          d.addOption("", "（未設定）");
          d.addOption("未", "未");
          d.addOption("済", "済");
          if (this.answer && !["未", "済"].includes(this.answer)) d.addOption(this.answer, this.answer);
          d.setValue(this.answer).onChange((v) => (this.answer = v));
          ansSelect = d.selectEl;
        });
        collapsible(ansSetting.settingEl, "回答", () => this.answer.trim() !== "", () => ansSelect?.focus());

        const stSetting = new Setting(pairAns).setName("状態");
        tip(
          stSetting.settingEl,
          "中断したタスクの理由。ノートには「- 状態: 中断(理由)」として保存されます（空なら行を出しません）。"
        );
        let stInput: HTMLInputElement | null = null;
        stSetting.addText((t) => {
          t.setPlaceholder("中断した理由")
            .setValue(this.statusText)
            .onChange((v) => (this.statusText = v));
          t.inputEl.addClass("dt-title-input");
          t.inputEl.addEventListener("keydown", onKey);
          stInput = t.inputEl;
        });
        collapsible(stSetting.settingEl, "状態", () => this.statusText.trim() !== "", () => stInput?.focus());
        finishPair(pairAns);

        // ---- Owner・期限（横並び）----
        const pairOwn = contentEl.createDiv("dt-row-pair");
        const onSetting = new Setting(pairOwn).setName("Owner");
        tip(
          onSetting.settingEl,
          "このタスクのオーナー（ボールを持っている人）。ノートには「- Owner: 名前」として保存されます。"
        );
        let onInput: HTMLInputElement | null = null;
        onSetting.addText((t) => {
          t.setPlaceholder("例: 田中")
            .setValue(this.ownerNameText)
            .onChange((v) => (this.ownerNameText = v));
          t.inputEl.addClass("dt-title-input");
          t.inputEl.addEventListener("keydown", onKey);
          // メンバー設定があれば入力候補に出す（自由入力も可）
          const names = (this.opts.memberNames ?? []).map((n) => n.trim()).filter(Boolean);
          if (names.length) {
            const dlId = "dt-owner-names-" + Math.random().toString(36).slice(2, 8);
            const dl = contentEl.createEl("datalist", { attr: { id: dlId } });
            for (const n of names) dl.createEl("option", { attr: { value: n } });
            t.inputEl.setAttr("list", dlId);
          }
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
            .onChange((v) => (this.dueText = v));
          t.inputEl.addClass("dt-title-input");
          t.inputEl.addEventListener("keydown", onKey);
          dueInput = t.inputEl;
        });
        collapsible(dueSetting.settingEl, "期限", () => this.dueText.trim() !== "", () => dueInput?.focus());
        finishPair(pairOwn);
      }

      // ---- ふりかえり（編集時のみ。作った直後には要らない）----
      if (this.opts.mode === "edit") {
        const retroSetting = new Setting(contentEl).setName("ふりかえり");
        tip(retroSetting.settingEl, "作業してみてどうだったか・次はどう改善するか。");
        retroSetting.settingEl.addClass("dt-retro-setting");
        const retroTa = retroSetting.controlEl.createEl("textarea", {
          cls: "dt-retro-field",
          attr: { rows: "1", placeholder: "例: 調査に時間がかかった。次は先に既知の事例を探す" },
        });
        retroTa.value = this.retrospective.replace(/ \/ /g, "\n");
        const growRetro = () => {
          retroTa.style.height = "auto";
          retroTa.style.height = Math.min(Math.max(retroTa.scrollHeight, 36), 220) + "px";
        };
        retroTa.addEventListener("input", () => {
          this.retrospective = retroTa.value;
          growRetro();
        });
        // フォーカスで広がり、離れたら（内容ぶんの高さを保ちつつ）縮む
        retroTa.addEventListener("focus", () => {
          retroTa.addClass("is-active");
          growRetro();
        });
        retroTa.addEventListener("blur", () => {
          retroTa.removeClass("is-active");
          growRetro();
        });
        // Enter は改行（保存は Ctrl+Enter）
        retroTa.addEventListener("keydown", (e: KeyboardEvent) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.isComposing) {
            e.preventDefault();
            void this.submit();
          }
        });
        window.setTimeout(growRetro, 0);
        collapsible(retroSetting.settingEl, "ふりかえり", () => this.retrospective.trim() !== "", () => retroTa.focus());
      }
    }

    // ---- チケット・リマインド（横並び）----
    const pairSub = contentEl.createDiv("dt-row-pair");
    const trackers = this.opts.trackers ?? [];
    if (this.opts.showDoneCondition && trackers.length) {
      const tkSetting = new Setting(pairSub).setName("チケット");
      tip(tkSetting.settingEl, "管理ツールと番号を選ぶと、ブロックからチケットを開けます。");
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
    if (this.opts.reminderDefault !== undefined) {
      const def = this.opts.reminderDefault;
      const rmSetting = new Setting(pairSub).setName("リマインド");
      tip(rmSetting.settingEl, "開始の何分前に通知するか。");
      let rmSelect: HTMLSelectElement | null = null;
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
        rmSelect = d.selectEl;
      });
      collapsible(rmSetting.settingEl, "リマインド", () => this.reminder !== null, () => rmSelect?.focus());
    }
    finishPair(pairSub);

    // ---- 隠している項目を開く「＋」チップ + タグ別スキーマの適用 ----
    // 選択中のタグの required の欄を開き、suggested のチップを先頭に並べる
    this.addFieldsEl = contentEl.createDiv("dt-add-fields");
    this.applyTagSchema();

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

  // ---------- タグ別スキーマ（選んだタグに応じた欄の表示） ----------

  /** 選択中のタグの必須・候補フィールドをまとめる（サブタグは親タグへフォールバック） */
  private schemaForSelectedTags(): { required: Set<string>; suggested: string[] } {
    const required = new Set<string>();
    const suggested: string[] = [];
    const schema = this.opts.tagFieldSchema ?? [];
    for (const tag of this.selectedTags) {
      const def = schemaForTag(schema, tag);
      if (!def) continue;
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
   * 選択中のタグに応じて、欄の開閉・必須マーク・「＋」チップの並びを更新する。
   * 値が入っている欄と一度開いた欄は、タグを切り替えても閉じない（書いた内容が隠れて
   * 消える事故を防ぐ）。開いている欄の入力内容とフォーカスには触らない
   */
  private applyTagSchema(): void {
    const sch = this.schemaForSelectedTags();
    for (const row of this.fieldRows) {
      const required = sch.required.has(row.label);
      const open = required || this.userOpened.has(row.label) || row.hasValue();
      row.el.toggleClass("dt-collapsed", !open);
      row.el.toggleClass("dt-field-required", required);
      this.setRequiredMark(row.el, required);
      if (row.hasValue()) row.el.removeClass("dt-field-invalid");
    }
    // 横並びの行: 中身が全部隠れていたら行ごと隠す
    this.contentEl.querySelectorAll<HTMLElement>(".dt-row-pair").forEach((pair) => {
      pair.toggleClass("dt-collapsed", !pair.querySelector(".setting-item:not(.dt-collapsed)"));
    });
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
   * 閉じている欄を開く「＋」チップを並べ直す。候補（suggested）の欄が定義順で先頭に来る。
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
    for (const r of [...head, ...rest]) {
      const chip = box.createEl("button", {
        cls: "dt-add-field-chip",
        text: "＋ " + r.label,
        attr: { type: "button", title: `${r.label}の欄を開く` },
      });
      if (suggested.includes(r.label)) chip.addClass("is-suggested");
      chip.onclick = () => openRow(r);
    }
  }

  /** 必須なのに空の欄（保存時の警告に使う） */
  private requiredMissing(): { label: string; el: HTMLElement; focus?: () => void }[] {
    const sch = this.schemaForSelectedTags();
    if (!sch.required.size) return [];
    return this.fieldRows.filter((r) => sch.required.has(r.label) && !r.hasValue());
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
    // 選択中のタグで必須の欄が空なら警告する（「このまま保存」も選べる。途中保存を妨げないため）
    if (!this.skipRequiredCheck && (this.opts.validateRequiredOnSave ?? true)) {
      const missing = this.requiredMissing();
      if (missing.length) {
        for (const row of missing) {
          row.el.removeClass("dt-collapsed");
          row.el.addClass("dt-field-invalid");
        }
        missing[0].focus?.();
        new RequiredFieldsModal(this.app, missing.map((r) => r.label), () => {
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
   * 状態欄の入力（中断理由）から保存する値を作る。
   * 理由が変わっていなければ元の書式のまま（既存ノートの表記を崩さない）
   */
  private statusValue(): string {
    if (this.statusText.trim() === statusReason(this.initialStatus)) return this.initialStatus;
    return renderStatusValue(this.statusText);
  }

  /** いまの入力内容を TaskDraft にまとめる */
  private buildDraft(times: { start: number | null; end: number | null }): TaskDraft {
    return {
      title: joinTitleAndTags(this.title, this.tagChoices, this.selectedTags),
      start: times.start,
      end: times.end,
      done: this.done,
      reminder: this.reminder,
      doneCondition: this.opts.showDoneCondition ? this.doneCondition.trim() : undefined,
      steps: this.opts.showDoneCondition
        ? this.steps.filter((st) => st.text.trim()).map((st) => ({ ...st, text: st.text.trim() }))
        : undefined,
      retrospective: this.opts.showDoneCondition
        ? this.retrospective.replace(/\s*\n+\s*/g, " / ").trim()
        : undefined,
      result: this.opts.showDoneCondition ? this.result.replace(/\s*\n+\s*/g, " / ").trim() : undefined,
      remaining: this.opts.showDoneCondition ? this.remaining.trim() : undefined,
      cause: this.opts.showDoneCondition ? this.cause.trim() : undefined,
      judgment: this.opts.showDoneCondition ? this.judgment.trim() : undefined,
      others: this.opts.showDoneCondition
        ? this.othersText
            .split(/\r?\n/)
            .map((v) => v.trim())
            .filter(Boolean)
        : undefined,
      answer: this.opts.showDoneCondition ? this.answer.trim() : undefined,
      status: this.opts.showDoneCondition ? this.statusValue() : undefined,
      ownerName: this.opts.showDoneCondition ? this.ownerNameText.trim() : undefined,
      due: this.opts.showDoneCondition ? this.dueText.trim() : undefined,
      details: this.opts.showDoneCondition ? this.details.replace(/\s+$/, "") : undefined,
      ticket: this.opts.showDoneCondition
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
    out.push({ tag, color: r.color });
  }
  return out;
}

/**
 * 色付きのタグボタンを並べる。クリックで selected を付け外しし、変更を onChange に通知する。
 * タイトルに付けるタグは1タスク1つ（Rules/Timeline記録ルール.md。複数付くと日報の集計が
 * 二重計上になる）。ただし親タグとサブタグの併記（#管理 と #管理/質問）は将来的にありうるため、
 * 完全な単一選択ではなく「親タグが異なるタグは同時に選べない」という制約として実装している
 */
export function renderTagChips(
  parent: HTMLElement,
  choices: TagColor[],
  selected: Set<string>,
  onChange?: (selected: Set<string>) => void
): void {
  const chips = parent.createDiv("dt-tag-chips");
  const paints: (() => void)[] = [];
  for (const c of choices) {
    const chip = chips.createEl("button", {
      cls: "dt-tag-chip",
      text: "#" + c.tag,
      attr: { type: "button" },
    });
    chip.style.setProperty("--dt-chip-color", c.color);
    chip.style.setProperty("--dt-chip-fg", contrastTextColor(c.color) || "#fff");
    const paint = () => {
      const on = selected.has(c.tag);
      chip.toggleClass("is-selected", on);
      chip.setAttr("aria-pressed", String(on));
    };
    paints.push(paint);
    paint();
    chip.onclick = () => {
      if (selected.has(c.tag)) {
        selected.delete(c.tag);
      } else {
        const parentOf = (tag: string) => tag.split("/")[0];
        for (const t of [...selected]) {
          if (parentOf(t) !== parentOf(c.tag)) selected.delete(t);
        }
        selected.add(c.tag);
      }
      // 他のタグの選択も外れうるので、全チップを塗り直す
      for (const p of paints) p();
      onChange?.(selected);
    };
  }
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

/** タイトルの末尾に選択したタグを付ける（設定の並び順で） */
export function joinTitleAndTags(title: string, choices: TagColor[], selected: Set<string>): string {
  const tags = choices.filter((c) => selected.has(c.tag)).map((c) => "#" + c.tag);
  return [title.trim(), ...tags].filter(Boolean).join(" ");
}

/**
 * 選択中のタグで必須のフィールドが空のまま保存しようとしたときの警告。
 * 会議中の途中保存などを妨げないよう、「このまま保存」で必ず保存できる
 */
class RequiredFieldsModal extends Modal {
  constructor(
    app: App,
    private labels: string[],
    private onProceed: () => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("dt-modal");
    this.titleEl.setText("必須の欄が未入力です");
    const list = this.labels.map((l) => `「${l}:」`).join("・");
    this.contentEl.createEl("p", {
      text: `選択中のタグでは必須の ${list} が未入力です。あとで書く場合は、このまま保存できます。`,
    });
    const buttons = new Setting(this.contentEl);
    buttons.settingEl.addClass("dt-modal-buttons");
    buttons.addButton((b) =>
      b
        .setButtonText("このまま保存")
        .setTooltip("空欄のまま保存します")
        .onClick(() => {
          this.close();
          this.onProceed();
        })
    );
    buttons.addButton((b) => b.setButtonText("入力に戻る").setCta().onClick(() => this.close()));
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

export interface RetrospectiveOptions {
  taskTitle: string;
  durationLabel: string;
  /** 記録済みの実績。渡すと実績の確認・修正欄を出す（完了時の自動記録の直しに使う） */
  actual?: ActualRange[];
  /** 記録済みの「結果」。欄の初期値になる（すでに書いてあれば書き換えの機会になる） */
  result?: string;
  /**
   * text = ふりかえり（空 = 変更なし）、actual = 実績欄の内容（欄を出していなければ undefined）、
   * result = 結果欄の内容
   */
  onSave: (text: string, actual: ActualRange[] | undefined, result: string) => void | Promise<void>;
}

/** 完了時に「結果」と「ふりかえり」の入力を促すダイアログ（実績の確認・修正もここでできる） */
export class RetrospectiveModal extends Modal {
  private text = "";
  private resultText: string;
  private actualText: string;

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
    this.titleEl.setText("結果とふりかえりを書きませんか？");
    this.contentEl.createEl("p", {
      cls: "dt-retro-lead",
      text:
        `「${this.opts.taskTitle || "(無題)"}」（${this.opts.durationLabel}）が完了しました。` +
        "何がどこまで終わったか（結果）と、次への改善（ふりかえり）を残しておくと、日報とふりかえりに活きます。",
    });

    // ---- 結果 ----
    const resSetting = new Setting(this.contentEl).setName("結果");
    resSetting.settingEl.addClass("dt-retro-setting");
    resSetting.setDesc("ノートには「- 結果: …」として保存されます。1行の要約でかまいません。");
    const resTa = resSetting.controlEl.createEl("textarea", {
      cls: "dt-retro-field",
      attr: { rows: "2", placeholder: "例: 実装完了。テストケースの修正まで終わった" },
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
      attr: { rows: "3", placeholder: "例: 想定より調査に時間がかかった。次は先に既知の事例を探す" },
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
    if (text || actualChanged || resultChanged) await this.opts.onSave(text, actual, result);
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
