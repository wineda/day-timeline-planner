import { App, DropdownComponent, Modal, Notice, Platform, Setting, moment, setIcon } from "obsidian";
import type { TaskDraft } from "./model";
import { projectDisplayName, type ProjectRef } from "./project";
import { actualTotal, type ActualRange, type ReminderSetting, type TaskStep, type TicketRef } from "./markdown/blocks";
import { normalizeTag, ticketUrl, type IssueTracker, type TagColor } from "./settings";
import { contrastTextColor, formatDuration, minutesToHHMM, parseTimeInput } from "./util";
import { iconName } from "./icons";

export interface TaskModalOptions {
  mode: "create" | "edit";
  initial: TaskDraft;
  snapMinutes: number;
  /** 時刻を空にして「未スケジュール」にできるか */
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
  /** リマインドの選択欄を出すか（既定の「N分前」を表示に使う）。undefined なら出さない */
  reminderDefault?: number;
  /** 実績（実際に作業した時間）の入力欄を出すか（編集時のみ） */
  showActual?: boolean;
  /** プロジェクト（大きなタスク）の選択肢。渡すと欄を出す */
  projects?: ProjectRef[];
  /** 新しいプロジェクトノートを作る。作れたらリンク先を返す */
  onCreateProject?: (name: string) => Promise<string | null>;
  /** プロジェクトノートを開く（ダイアログは閉じてから呼ばれる） */
  onOpenProject?: (linktext: string) => void | Promise<void>;
  /** チケット管理ツール（登録があれば「詳細」にチケット欄を出す） */
  trackers?: IssueTracker[];
  /** 同じ日の他のタスクの実績（実績の重複を注意する。無ければチェックしない） */
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
  ranges: ActualRange[];
}

/** 実績の重複とみなす最小の分数（これ以下の重なりは注意しない） */
const OVERLAP_MIN = 15;

/**
 * タスクを追加・編集するダイアログ。
 * 欄はタイトル・日時・実績・プロジェクト・誰の予定か・タグ・ステップ・備考と、
 * 畳んである「詳細」（チケット・リマインド・結果・ふりかえり）だけ。
 * ノートにある他のフィールド（原因・判断・残・他者・回答・状態・Owner・期限・完了条件・次アクション）は
 * ここでは触らず、保存してもそのまま残る（手書きか AI が書く欄）
 */
export class TaskModal extends Modal {
  private opts: TaskModalOptions;
  private title: string;
  private done: boolean;
  private reminder: ReminderSetting;
  private result: string;
  private retrospective: string;
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
  /** モバイルの日時サマリー行の表示を更新する（モバイル以外は null） */
  private refreshSchedSummary: (() => void) | null = null;
  /** 実績欄の下の注意（合計・重複） */
  private actualDescEl: HTMLElement | null = null;

  constructor(app: App, opts: TaskModalOptions) {
    super(app);
    this.opts = opts;
    this.done = opts.initial.done;
    this.reminder = opts.initial.reminder ?? null;
    this.result = opts.initial.result ?? "";
    this.retrospective = opts.initial.retrospective ?? "";
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

    /** 伸び縮みする複数行の欄（フォーカスで広がり、離れたら内容ぶんの高さに縮む） */
    const growTextarea = (ta: HTMLTextAreaElement, max: number) => {
      ta.style.height = "auto";
      ta.style.height = Math.min(Math.max(ta.scrollHeight, 36), max) + "px";
    };
    const textarea = (
      parent: HTMLElement,
      cls: string,
      rows: number,
      max: number,
      placeholder: string,
      get: () => string,
      set: (v: string) => void
    ) => {
      const ta = parent.createEl("textarea", { cls: "dt-retro-field " + cls, attr: { rows: String(rows), placeholder } });
      ta.value = get();
      const grow = () => growTextarea(ta, max);
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
      return ta;
    };
    const mobile = Platform.isMobile;

    // ---- モバイル: TickTick 風のシンプル表示 ----
    // 上段は「丸い完了チェック + 日時サマリー」の1行だけにし、日付・時間・実績の
    // 入力欄はサマリーのタップで開閉する
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
    const pairMain = contentEl.createDiv("dt-row-pair");
    if (this.opts.projects) this.buildProjectSection(pairMain);
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
      ownerSetting.addDropdown((d) => {
        for (const o of owners) d.addOption(o.id ?? "", o.name);
        d.setValue(this.owner ?? "").onChange((v) => {
          this.owner = v || null;
          paintDot();
        });
      });
      paintDot();
    }
    if (!pairMain.childElementCount) pairMain.remove();

    // ---- タグ（親タグ → サブタグの2段。書き込むのは最も深い1つ）----
    if (this.tagChoices.length) {
      const tagSetting = new Setting(contentEl).setName("タグ");
      tagSetting.settingEl.addClass("dt-tag-setting");
      tip(tagSetting.settingEl, "選んだタグは見出しの末尾に #タグ として書き込まれます（サブタグを選んだときはサブタグだけ）。");
      renderTagChips(tagSetting.controlEl, this.tagChoices, this.selectedTags, () => this.scheduleAutosave());
    }

    // ---- ステップ（チェックリスト）----
    this.buildStepsSection(contentEl);

    // ---- 備考（自由な本文）----
    const detailSetting = new Setting(contentEl).setName("備考");
    tip(detailSetting.settingEl, "自由なメモ（Markdown）。ノートのブロック本文と相互に反映されます。");
    detailSetting.settingEl.addClass("dt-retro-setting");
    textarea(detailSetting.controlEl, "dt-details-field", 2, 320, "自由なメモ（Markdown）", () => this.details, (v) => (this.details = v));

    // ---- 詳細（チケット・リマインド・結果・ふりかえり）。値が入っていなければ畳んでおく ----
    const detailsWrap = contentEl.createDiv("dt-details");
    const detailsHead = detailsWrap.createEl("button", {
      cls: "dt-details-toggle",
      attr: { type: "button", "aria-expanded": "false" },
    });
    const detailsChevron = detailsHead.createSpan("dt-details-chevron");
    detailsHead.createSpan({ text: "詳細" });
    const detailsSub = detailsHead.createSpan("dt-details-sub");
    const detailsBody = detailsWrap.createDiv("dt-details-body");
    const detailsLabels: string[] = [];
    const setDetailsOpen = (open: boolean) => {
      detailsBody.toggleClass("dt-collapsed", !open);
      detailsHead.setAttr("aria-expanded", String(open));
      setIcon(detailsChevron, open ? "chevron-down" : "chevron-right");
      // 隠れていた textarea は高さが 0 のままなので伸ばし直す
      if (open) detailsBody.querySelectorAll<HTMLTextAreaElement>("textarea").forEach((ta) => growTextarea(ta, 220));
    };
    detailsHead.onclick = () => setDetailsOpen(detailsBody.hasClass("dt-collapsed"));

    const trackers = this.opts.trackers ?? [];
    if (trackers.length) {
      detailsLabels.push("チケット");
      const tkSetting = new Setting(detailsBody).setName("チケット");
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
      tkSetting.addText((t) => {
        t.setPlaceholder("番号")
          .setValue(this.ticketId)
          .onChange((v) => {
            this.ticketId = v.trim().replace(/^#+/, "");
            updateDesc();
          });
        t.inputEl.addClass("dt-ticket-input");
        t.inputEl.addEventListener("keydown", onKey);
      });
      updateDesc();
    }

    if (this.opts.reminderDefault !== undefined) {
      detailsLabels.push("リマインド");
      const def = this.opts.reminderDefault;
      const rmSetting = new Setting(detailsBody).setName("リマインド");
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

    detailsLabels.push("結果");
    const resSetting = new Setting(detailsBody).setName("結果");
    tip(resSetting.settingEl, "何がどこまで終わったか。ノートには「- 結果: …」として保存され、日報の元データになります。改行は「 / 」区切りで1行になります。");
    resSetting.settingEl.addClass("dt-retro-setting");
    textarea(resSetting.controlEl, "", 1, 220, "何がどこまで終わったか", () => this.result.replace(/ \/ /g, "\n"), (v) => (this.result = v));

    if (this.opts.mode === "edit") {
      detailsLabels.push("ふりかえり");
      const retroSetting = new Setting(detailsBody).setName("ふりかえり");
      tip(retroSetting.settingEl, "作業してみてどうだったか・次はどう改善するか。ノートには「- ふりかえり: …」として保存されます。");
      retroSetting.settingEl.addClass("dt-retro-setting");
      textarea(retroSetting.controlEl, "", 1, 220, "作業してみてどうだったか・次はどう改善するか", () => this.retrospective.replace(/ \/ /g, "\n"), (v) => (this.retrospective = v));
    }
    detailsSub.setText(detailsLabels.join("・"));
    setDetailsOpen(
      this.ticketId.trim() !== "" || this.result.trim() !== "" || this.retrospective.trim() !== "" || this.reminder !== null
    );

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

  // ---------- 実績の注意（合計と、同じ日の他のタスクとの重複） ----------

  /** 実績が同じ日の他のタスクと重なっているもの（OVERLAP_MIN 分超） */
  private actualOverlaps(): { title: string; minutes: number }[] {
    const ranges = this.parseActual();
    if (!ranges || !ranges.length) return [];
    const out: { title: string; minutes: number }[] = [];
    for (const o of this.opts.otherActuals ?? []) {
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
      el.setText(`${total}。「${hits.map((h) => h.title).join("」「")}」の実績と ${hits.map((h) => h.minutes).join("・")} 分重なっています`);
      el.addClass("dt-desc-warn");
    } else {
      el.setText(total);
    }
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

  /** 「プロジェクト」欄（選択・新規作成・ノートを開く） */
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
   * いまの入力内容を TaskDraft にまとめる。
   * ダイアログに無いフィールド（原因・判断・残・他者・回答・状態・Owner・期限・完了条件・次アクション）は
   * undefined（= 変更しない）のままにして、ノートの行をそのまま残す
   */
  private buildDraft(times: { start: number | null; end: number | null }): TaskDraft {
    return {
      title: joinTitleAndTags(this.title, this.tagChoices, this.selectedTags),
      start: times.start,
      end: times.end,
      done: this.done,
      reminder: this.reminder,
      steps: this.steps.filter((st) => st.text.trim()).map((st) => ({ ...st, text: st.text.trim() })),
      retrospective:
        this.opts.mode === "edit" ? this.retrospective.replace(/\s*\n+\s*/g, " / ").trim() : undefined,
      result: this.result.replace(/\s*\n+\s*/g, " / ").trim(),
      details: this.details.replace(/\s+$/, ""),
      ticket: this.opts.trackers?.length
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
