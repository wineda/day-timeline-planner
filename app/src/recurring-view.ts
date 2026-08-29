/**
 * 定期タスクの管理画面（専用ビュー）。
 *
 * 左にルールの一覧、右に選択中ルールの編集フォームと「今後の予定」を表示する。
 * 発生日ごとに 未反映 / 反映済み / 取り消し / 個別調整 の状態を出し、
 * 行を開くと、その回だけの詳細（個別詳細）や時刻を書ける。
 */
import { ItemView, Notice, WorkspaceLeaf, debounce, moment, setIcon } from "obsidian";
import type DayTimelinePlugin from "./main";
import type { RecurringInstance, RecurringOverride, RecurringRule } from "./settings";
import {
  RuleForm,
  applyRecurring,
  clearInstance,
  describeOccurrence,
  describeRule,
  instanceOf,
  occurrenceInfo,
  propagateAndNotify,
  reapplyOccurrence,
  setInstance,
  skipOccurrence,
  type OccurrenceInfo,
} from "./recurring";
import { ConfirmModal } from "./modal";
import { addDays, dateKey, minutesToHHMM, parseTimeInput, startOfDay } from "./util";

export const VIEW_TYPE_RECURRING = "day-timeline-recurring-view";

/** 「今後の予定」に出す日数（今日から4週間） */
const OCCURRENCE_DAYS = 28;

export class RecurringManagerView extends ItemView {
  private plugin: DayTimelinePlugin;
  /** 選択中のルール ID。null = 未選択 */
  private selectedId: string | null = null;
  /** 新規作成フォームを開いているか */
  private creating = false;
  /** 個別詳細エディタを開いている発生日（"ルールID|日付キー"） */
  private expanded = new Set<string>();
  private form: RuleForm | null = null;
  /** 発生日一覧のコンテナ（フォームを壊さずに状態だけ更新するために持つ） */
  private occBoxEl: HTMLElement | null = null;
  private refreshOccDebounced: () => void;

  constructor(leaf: WorkspaceLeaf, plugin: DayTimelinePlugin) {
    super(leaf);
    this.plugin = plugin;
    this.refreshOccDebounced = debounce(() => this.refreshOccurrences(), 400, true);
  }

  getViewType(): string {
    return VIEW_TYPE_RECURRING;
  }

  getDisplayText(): string {
    return "定期タスク";
  }

  getIcon(): string {
    return "repeat";
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("dt-rec-view");
    // タイムラインやノートの直接編集による変化を拾って、状態表示を最新に保つ
    this.registerEvent(this.app.vault.on("modify", () => this.refreshOccDebounced()));
    if (!this.selectedId) this.selectedId = this.plugin.settings.recurring[0]?.id ?? null;
    this.render();
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  private selectedRule(): RecurringRule | null {
    return this.plugin.settings.recurring.find((r) => r.id === this.selectedId) ?? null;
  }

  // ---------- 全体 ----------

  private render(): void {
    const root = this.contentEl;
    root.empty();
    this.occBoxEl = null;
    const s = this.plugin.settings;

    const layout = root.createDiv("dt-rec-layout");

    // ---- 左: ルール一覧 ----
    const side = layout.createDiv("dt-rec-side");
    const sideHead = side.createDiv("dt-rec-side-head");
    sideHead.createDiv({ cls: "dt-rec-side-title", text: "定期タスク" });
    const addBtn = sideHead.createEl("button", {
      cls: "mod-cta dt-rec-add",
      text: "追加",
      attr: { type: "button" },
    });
    addBtn.onclick = () => {
      this.creating = true;
      this.expanded.clear();
      this.render();
    };

    if (!s.autoApplyRecurring) {
      side.createDiv({
        cls: "dt-recurring-warn",
        text:
          "設定「定期タスクを自動で入れる」がオフです。" +
          "タイムラインには自動で入りません（各日の「今すぐ入れる」でのみ書き込まれます）。",
      });
    }

    const list = side.createDiv("dt-rec-list");
    if (!s.recurring.length && !this.creating) {
      list.createDiv({
        cls: "dt-recurring-empty",
        text: "定期タスクはまだありません。「追加」から作成できます。タスクの右クリック「定期タスクとして登録…」からも作れます。",
      });
    }
    for (const rule of s.recurring) {
      const item = list.createDiv("dt-rec-item");
      item.toggleClass("is-selected", rule.id === this.selectedId && !this.creating);
      item.toggleClass("is-disabled", !rule.enabled);
      const dot = item.createDiv({
        cls: "dt-rec-item-dot",
        attr: { "aria-label": rule.enabled ? "有効" : "無効" },
      });
      setIcon(dot, rule.enabled ? "check-circle-2" : "circle");
      const body = item.createDiv("dt-rec-item-body");
      body.createDiv({ cls: "dt-rec-item-title", text: rule.title || "(無題)" });
      body.createDiv({ cls: "dt-rec-item-desc", text: describeRule(rule) });
      item.onclick = () => {
        this.creating = false;
        this.selectedId = rule.id;
        this.expanded.clear();
        this.render();
      };
    }

    // ---- 右: 編集フォームと発生日一覧 ----
    const main = layout.createDiv("dt-rec-main");
    if (this.creating) {
      this.renderEditor(main, null);
    } else {
      const rule = this.selectedRule();
      if (!rule) {
        main.createDiv({
          cls: "dt-rec-placeholder",
          text: "左の一覧からルールを選ぶか、「追加」で新しく作成してください。",
        });
      } else {
        this.renderEditor(main, rule);
        this.occBoxEl = main.createDiv("dt-rec-occ");
        this.renderOccurrences(this.occBoxEl, rule);
      }
    }
  }

  // ---------- ルールの編集フォーム ----------

  private renderEditor(parent: HTMLElement, rule: RecurringRule | null): void {
    const box = parent.createDiv("dt-rec-editor");
    box.createDiv({ cls: "dt-rec-section-title", text: rule ? "ルールを編集" : "新しいルール" });
    const formEl = box.createDiv("dt-rec-form");
    this.form = new RuleForm({
      initial: rule ?? undefined,
      tagChoices: this.plugin.settings.tagColors,
      projects: this.plugin.projects?.list(),
      showEnabled: !!rule,
      onEnter: () => void this.saveRule(rule),
    });
    this.form.render(formEl);

    const buttons = box.createDiv("dt-rec-editor-buttons");
    if (rule) {
      const del = buttons.createEl("button", {
        text: "削除",
        cls: "dt-rec-danger",
        attr: { type: "button" },
      });
      del.onclick = () => {
        new ConfirmModal(
          this.app,
          `定期タスク「${rule.title || "(無題)"}」を削除しますか？（書き込み済みのタスクはノートに残ります）`,
          "削除",
          async () => {
            const s = this.plugin.settings;
            s.recurring = s.recurring.filter((r) => r.id !== rule.id);
            this.selectedId = s.recurring[0]?.id ?? null;
            await this.plugin.saveSettings();
            this.render();
          }
        ).open();
      };
    } else {
      const cancel = buttons.createEl("button", { text: "キャンセル", attr: { type: "button" } });
      cancel.onclick = () => {
        this.creating = false;
        this.render();
      };
    }
    const save = buttons.createEl("button", {
      cls: "mod-cta",
      text: rule ? "保存して今日以降に反映" : "追加",
      attr: { type: "button" },
    });
    save.onclick = () => void this.saveRule(rule);
  }

  private async saveRule(prev: RecurringRule | null): Promise<void> {
    if (!this.form) return;
    const r = this.form.build();
    if ("error" in r) {
      new Notice(r.error);
      return;
    }
    const s = this.plugin.settings;
    if (prev) {
      const idx = s.recurring.findIndex((x) => x.id === prev.id);
      if (idx >= 0) s.recurring[idx] = r.rule;
      else s.recurring.push(r.rule);
    } else {
      s.recurring.push(r.rule);
      new Notice(`定期タスク「${r.rule.title}」を追加しました`);
    }
    this.creating = false;
    this.selectedId = r.rule.id;
    await this.plugin.saveSettings();
    // 既存ルールの編集は、書き込み済みのタスクへ反映して結果を通知する
    if (prev) await propagateAndNotify(this.plugin, r.rule, prev);
    this.render();
  }

  // ---------- 今後の予定（発生日一覧） ----------

  /** フォームの入力を保ったまま、発生日一覧だけを描き直す */
  private refreshOccurrences(): void {
    const box = this.occBoxEl;
    const rule = this.selectedRule();
    if (!box || !box.isConnected || !rule || this.creating) return;
    // 個別詳細などを入力中に（ノート変更イベントで）打ちかけの内容を消さない
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      box.contains(active) &&
      (active.tagName === "TEXTAREA" || active.tagName === "INPUT")
    )
      return;
    box.empty();
    this.renderOccurrences(box, rule);
  }

  private renderOccurrences(box: HTMLElement, rule: RecurringRule): void {
    box.createDiv({ cls: "dt-rec-section-title", text: "今後の予定（4週間）" });
    box.createDiv({
      cls: "dt-rec-occ-hint",
      text: "行を開くと、その回だけの詳細（個別詳細）や時刻を書けます。「入れない / 取り消す」でその日だけやめられます。",
    });
    const listEl = box.createDiv("dt-rec-occ-list");

    const s = this.plugin.settings;
    const today = startOfDay(new Date());
    const dates: Date[] = [];
    for (let i = 0; i < OCCURRENCE_DAYS; i++) {
      const d = addDays(today, i);
      const key = dateKey(d);
      const hasRecord =
        !!instanceOf(s, key, rule.id) || (s.recurringApplied[key] ?? []).includes(rule.id);
      // 曜日が合う日と、（曜日を変えた後などで）記録が残っている日を出す
      if (rule.weekdays.includes(d.getDay()) || hasRecord) dates.push(d);
    }
    if (!dates.length) {
      listEl.createDiv({ cls: "dt-recurring-empty", text: "この期間に対象の曜日はありません。" });
      return;
    }
    for (const d of dates) this.renderOccurrenceRow(listEl, rule, d);
  }

  private renderOccurrenceRow(parent: HTMLElement, rule: RecurringRule, date: Date): void {
    const key = dateKey(date);
    const row = parent.createDiv("dt-rec-occ-row");
    const head = row.createDiv("dt-rec-occ-head");
    const caret = head.createDiv("dt-rec-occ-caret");
    const dateEl = head.createDiv({ cls: "dt-rec-occ-date", text: moment(date).format("M/D (ddd)") });
    dateEl.toggleClass("is-today", key === dateKey(startOfDay(new Date())));
    const timeEl = head.createDiv("dt-rec-occ-time");
    const badge = head.createDiv({ cls: "dt-rec-occ-badge", text: "確認中…" });
    const btns = head.createDiv("dt-rec-occ-actions");

    void occurrenceInfo(this.plugin, rule, date).then((info) => {
      if (!row.isConnected) return;
      this.paintOccurrence({ row, head, caret, timeEl, badge, btns }, rule, date, info);
    });
  }

  private paintOccurrence(
    els: {
      row: HTMLElement;
      head: HTMLElement;
      caret: HTMLElement;
      timeEl: HTMLElement;
      badge: HTMLElement;
      btns: HTMLElement;
    },
    rule: RecurringRule,
    date: Date,
    info: OccurrenceInfo
  ): void {
    const { row, head, caret, timeEl, badge, btns } = els;
    const key = dateKey(date);
    const offday = !rule.weekdays.includes(date.getDay());

    badge.setText(describeOccurrence(info.kind) + (offday ? "・曜日対象外" : ""));
    badge.className = "dt-rec-occ-badge is-" + info.kind;
    row.toggleClass("is-skipped", info.kind === "skipped");

    const time =
      info.task !== null
        ? info.task.start !== null && info.task.end !== null
          ? `${minutesToHHMM(info.task.start)} - ${minutesToHHMM(info.task.end)}`
          : "時刻なし"
        : info.override && info.override.start !== undefined
          ? info.override.start !== null && info.override.end != null
            ? `${minutesToHHMM(info.override.start)} - ${minutesToHHMM(info.override.end)}`
            : "時刻なし"
          : "";
    timeEl.setText(time);

    btns.empty();
    const mkBtn = (label: string, onClick: () => void, danger = false) => {
      const b = btns.createEl("button", {
        text: label,
        cls: "dt-rec-occ-btn" + (danger ? " dt-rec-danger" : ""),
        attr: { type: "button" },
      });
      b.onclick = (e) => {
        e.stopPropagation();
        onClick();
      };
      return b;
    };
    const refresh = () => this.refreshOccurrences();

    switch (info.kind) {
      case "pending":
      case "pending-custom":
        if (offday) {
          // 曜日から外れた日に残っている個別調整の予約: 消すだけ
          mkBtn("記録を消す", () => {
            clearInstance(this.plugin.settings, key, rule.id);
            void this.plugin.persistSettings().then(() => refresh());
          });
          break;
        }
        mkBtn("今すぐ入れる", () =>
          void applyRecurring(this.plugin, [date], true).then((n) => {
            if (!n) new Notice("入れられませんでした（ルールが無効になっていないか確認してください）");
            refresh();
          })
        );
        mkBtn(
          "この日は入れない",
          () => void skipOccurrence(this.plugin, rule, date).then(() => refresh()),
          true
        );
        break;
      case "applied":
      case "applied-custom":
        mkBtn("ノートで開く", () => void this.openTask(date, info));
        mkBtn(
          "この日は取り消す",
          () => {
            const doSkip = () =>
              void skipOccurrence(this.plugin, rule, date).then((removed) => {
                new Notice(removed ? "この日のタスクを削除して取り消しました" : "この日を取り消しました");
                refresh();
              });
            const t = info.task;
            if (t && (t.done || t.details.trim() || t.actual.length || t.steps.length)) {
              new ConfirmModal(
                this.app,
                `${moment(date).format("M月D日")} の「${t.title || "(無題)"}」には記録があります。ノートから削除して取り消しますか？`,
                "削除して取り消す",
                doSkip
              ).open();
            } else {
              doSkip();
            }
          },
          true
        );
        break;
      case "skipped":
        mkBtn(offday ? "記録を消す" : "入れ直す", () =>
          void reapplyOccurrence(this.plugin, rule, date).then((ok) => {
            if (!offday)
              new Notice(ok ? "入れ直しました" : "取り消しを解除しました（その日を表示すると入ります）");
            refresh();
          })
        );
        break;
      case "missing":
        if (offday) {
          mkBtn("記録を消す", () =>
            void reapplyOccurrence(this.plugin, rule, date).then(() => refresh())
          );
          break;
        }
        mkBtn("入れ直す", () =>
          void reapplyOccurrence(this.plugin, rule, date).then((ok) => {
            new Notice(ok ? "入れ直しました" : "記録を消しました（その日を表示すると入ります）");
            refresh();
          })
        );
        mkBtn(
          "取り消し扱いにする",
          () => void skipOccurrence(this.plugin, rule, date).then(() => refresh())
        );
        break;
    }

    // 個別詳細エディタ（未反映と反映済みの日で開ける）
    const editable =
      !!this.plugin.blockStore() &&
      (info.kind === "pending" ||
        info.kind === "pending-custom" ||
        info.kind === "applied" ||
        info.kind === "applied-custom");
    const expandKey = `${rule.id}|${key}`;
    if (editable) {
      row.addClass("is-editable");
      setIcon(caret, this.expanded.has(expandKey) ? "chevron-down" : "chevron-right");
      head.onclick = () => {
        if (this.expanded.has(expandKey)) this.expanded.delete(expandKey);
        else this.expanded.add(expandKey);
        this.refreshOccurrences();
      };
      if (this.expanded.has(expandKey)) this.renderOccEditor(row, rule, date, info);
    } else {
      this.expanded.delete(expandKey);
    }
  }

  /** その回だけの詳細・時刻の入力エリア */
  private renderOccEditor(
    row: HTMLElement,
    rule: RecurringRule,
    date: Date,
    info: OccurrenceInfo
  ): void {
    const box = row.createDiv("dt-rec-occ-editor");
    const isApplied = info.kind === "applied" || info.kind === "applied-custom";
    box.createDiv({
      cls: "dt-rec-occ-editor-hint",
      text: isApplied
        ? "この日のノートに書き込まれたタスクを直接書き換えます。"
        : "この日の分を書き込むときに、ここの内容がルールの共通設定より優先して使われます。",
    });

    const timeRow = box.createDiv("dt-rec-occ-editor-row");
    timeRow.createSpan({ cls: "dt-rec-occ-editor-label", text: "時刻" });
    const startIn = timeRow.createEl("input", {
      cls: "dt-time-input",
      attr: { placeholder: rule.start !== null ? minutesToHHMM(rule.start) : "なし" },
    });
    timeRow.createSpan({ text: "〜", cls: "dt-modal-tilde" });
    const endIn = timeRow.createEl("input", {
      cls: "dt-time-input",
      attr: { placeholder: rule.end !== null ? minutesToHHMM(rule.end) : "なし" },
    });
    const curStart = isApplied
      ? info.task?.start ?? null
      : info.override && info.override.start !== undefined
        ? info.override.start
        : rule.start;
    const curEnd = isApplied
      ? info.task?.end ?? null
      : info.override && info.override.end !== undefined
        ? info.override.end ?? null
        : rule.end;
    startIn.value = curStart === null ? "" : minutesToHHMM(curStart);
    endIn.value = curEnd === null ? "" : minutesToHHMM(curEnd);

    const detRow = box.createDiv("dt-rec-occ-editor-row is-details");
    detRow.createSpan({ cls: "dt-rec-occ-editor-label", text: "個別詳細" });
    const ta = detRow.createEl("textarea", {
      cls: "dt-rec-details-field",
      attr: { rows: "3", placeholder: "この回だけのメモ（Markdown）" },
    });
    ta.value = isApplied ? info.task?.details ?? "" : info.override?.details ?? rule.details ?? "";

    const btnRow = box.createDiv("dt-rec-occ-editor-buttons");
    const save = btnRow.createEl("button", {
      cls: "mod-cta",
      text: "この日を保存",
      attr: { type: "button" },
    });
    save.onclick = () =>
      void this.saveOccurrence(rule, date, info, startIn.value, endIn.value, ta.value);
  }

  private async saveOccurrence(
    rule: RecurringRule,
    date: Date,
    info: OccurrenceInfo,
    startText: string,
    endText: string,
    detailsText: string
  ): Promise<void> {
    let start: number | null = null;
    let end: number | null = null;
    if (startText.trim() !== "" || endText.trim() !== "") {
      start = parseTimeInput(startText);
      end = parseTimeInput(endText);
      if (start === null || end === null) {
        new Notice("時刻は 09:00 のように入力してください");
        return;
      }
      if (end <= start) {
        new Notice("終了時刻は開始時刻より後にしてください");
        return;
      }
    }
    const s = this.plugin.settings;
    const key = dateKey(date);
    const details = detailsText.replace(/\s+$/, "");
    const isApplied = info.kind === "applied" || info.kind === "applied-custom";
    const label = moment(date).format("M月D日");

    if (isApplied) {
      // すでにノートにある日: タスクを直接書き換える
      const store = this.plugin.blockStore();
      const blockId = info.task?.blockId ?? null;
      if (!store || !blockId) {
        new Notice("このタスクは追跡できないため、ノートを直接編集してください");
        return;
      }
      const ok = await store.updateByBlockId(date, blockId, { start, end, details });
      if (!ok) {
        new Notice("書き換えられませんでした（タスクが見つかりません）");
        this.refreshOccurrences();
        return;
      }
      // 時刻をルールと変えた回は、以後ルール編集で上書きしない
      const next: RecurringInstance = { blockId };
      if (start !== rule.start || end !== rule.end) next.detached = true;
      setInstance(s, key, rule.id, next);
      await this.plugin.persistSettings();
      new Notice(`${label} の分を保存しました`);
    } else {
      // まだ書き込まれていない日: 上書きとして覚えておき、書き込み時に使う
      const ov: RecurringOverride = {};
      if (details !== (rule.details ?? "").replace(/\s+$/, "")) ov.details = details;
      if (start !== rule.start || end !== rule.end) {
        ov.start = start;
        ov.end = end;
      }
      if (Object.keys(ov).length) {
        setInstance(s, key, rule.id, { blockId: null, override: ov });
        new Notice(`${label} の個別調整を保存しました（書き込み時に反映されます）`);
      } else {
        clearInstance(s, key, rule.id);
        new Notice(`${label} はルールどおりに戻しました`);
      }
      await this.plugin.persistSettings();
    }
    this.refreshOccurrences();
  }

  private async openTask(date: Date, info: OccurrenceInfo): Promise<void> {
    const store = this.plugin.blockStore();
    if (!store || !info.task) return;
    try {
      const link = await store.linkTo(date, info.task);
      if (link) await this.app.workspace.openLinkText(link, "", true);
    } catch (e) {
      console.error(e);
      new Notice("ノートを開けませんでした: " + String(e));
    }
  }
}
