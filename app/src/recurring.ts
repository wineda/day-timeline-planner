/**
 * 定期タスク: 曜日と時刻を決めたルールに従って、その日のノートにタスクを入れる。
 */
import { App, Modal, Notice, Setting, setIcon } from "obsidian";
import type DayTimelinePlugin from "./main";
import type { RecurringRule, TagColor } from "./settings";
import {
  joinTitleAndTags,
  normalizeTagChoices,
  renderTagChips,
  splitKnownTags,
} from "./modal";
import { dateKey, formatDuration, minutesToHHMM, parseTimeInput, startOfDay } from "./util";
import { newBlockId } from "./markdown/id";

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

/**
 * 表示中の日のうち今日以降について、まだ入れていない定期タスクをノートに書き込む。
 * 書き込んだ件数を返す。
 */
export async function applyRecurring(plugin: DayTimelinePlugin, days: Date[]): Promise<number> {
  const s = plugin.settings;
  if (!s.autoApplyRecurring) return 0;
  const rules = s.recurring.filter((r) => r.enabled && r.title.trim() && r.weekdays.length);
  if (!rules.length) return 0;

  const today = startOfDay(new Date());
  let count = 0;
  let touched = false;

  for (const day of days) {
    if (day < today) continue;
    const key = dateKey(day);
    const applied = new Set(s.recurringApplied[key] ?? []);
    for (const rule of rules) {
      if (!rule.weekdays.includes(day.getDay())) continue;
      if (applied.has(rule.id)) continue;
      // 旧リスト形式は時刻必須
      if (rule.start === null && !plugin.store.supportsUnscheduled) continue;
      const draft = { title: rule.title, start: rule.start, end: rule.end, done: false };
      const blockStore = plugin.blockStore();
      try {
        if (blockStore) {
          // ブロックID を控えておき、ルールを編集したときに追いかけて更新できるようにする
          const bid = newBlockId();
          await blockStore.createWithId(day, draft, bid);
          const inst = s.recurringInstances[key] ?? {};
          inst[rule.id] = bid;
          s.recurringInstances[key] = inst;
        } else {
          await plugin.store.create(day, draft);
        }
        count++;
      } catch (e) {
        console.error(e);
        new Notice(`定期タスク「${rule.title}」を入れられませんでした: ${String(e)}`);
        continue;
      }
      applied.add(rule.id);
      touched = true;
    }
    if (applied.size) s.recurringApplied[key] = [...applied];
  }

  if (touched) {
    pruneApplied(s.recurringApplied, today);
    pruneApplied(s.recurringInstances as unknown as Record<string, string[]>, today);
    await plugin.persistSettings();
  }
  return count;
}

/** 古い反映記録を捨てる（90日より前） */
function pruneApplied(applied: Record<string, string[]>, today: Date): void {
  const limit = dateKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 90));
  for (const k of Object.keys(applied)) {
    if (k < limit) delete applied[k];
  }
}

/**
 * ルールの編集を、すでにノートへ書き込んだ「今日以降」のタスクに反映する。
 * タイトルと時刻を書き換える（本文・完了状態・手で動かした日付には触れない）。
 * 反映できた件数を返す。
 */
export async function propagateRecurringUpdate(
  plugin: DayTimelinePlugin,
  rule: RecurringRule
): Promise<number> {
  const s = plugin.settings;
  const store = plugin.blockStore();
  if (!store) return 0;
  const todayKey = dateKey(startOfDay(new Date()));
  let n = 0;
  for (const [key, map] of Object.entries(s.recurringInstances)) {
    if (key < todayKey) continue;
    const blockId = map?.[rule.id];
    if (!blockId) continue;
    const [y, m, d] = key.split("-").map(Number);
    if (!y || !m || !d) continue;
    try {
      const ok = await store.updateByBlockId(new Date(y, m - 1, d), blockId, {
        title: rule.title,
        start: rule.start,
        end: rule.end,
      });
      if (ok) n++;
    } catch (e) {
      console.error(e);
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// ルールの追加・編集ダイアログ
// ---------------------------------------------------------------------------

export interface RecurringModalOptions {
  /** 編集するルール。無ければ新規 */
  initial?: RecurringRule;
  /** 新規のときの初期値（タスクから「定期タスクとして登録」したとき） */
  preset?: { title: string; start: number | null; end: number | null; weekday?: number };
  tagChoices?: TagColor[];
  onSubmit: (rule: RecurringRule) => void | Promise<void>;
}

export class RecurringModal extends Modal {
  private opts: RecurringModalOptions;
  private title: string;
  private weekdays: Set<number>;
  private startText: string;
  private endText: string;
  private enabled: boolean;
  private tagChoices: TagColor[];
  private selectedTags: Set<string>;
  private hintEl!: HTMLElement;

  constructor(app: App, opts: RecurringModalOptions) {
    super(app);
    this.opts = opts;
    this.tagChoices = normalizeTagChoices(opts.tagChoices);
    const src = opts.initial ?? {
      id: "",
      title: opts.preset?.title ?? "",
      weekdays: opts.preset?.weekday !== undefined ? [opts.preset.weekday] : [1, 2, 3, 4, 5],
      start: opts.preset?.start ?? 9 * 60,
      end: opts.preset?.end ?? 9 * 60 + 30,
      enabled: true,
    };
    const { text, selected } = splitKnownTags(src.title, this.tagChoices.map((c) => c.tag));
    this.title = text;
    this.selectedTags = selected;
    this.weekdays = new Set(src.weekdays);
    this.startText = src.start === null ? "" : minutesToHHMM(src.start);
    this.endText = src.end === null ? "" : minutesToHHMM(src.end);
    this.enabled = src.enabled;
  }

  onOpen(): void {
    const { contentEl } = this;
    this.modalEl.addClass("dt-modal");
    this.titleEl.setText(this.opts.initial ? "定期タスクを編集" : "定期タスクを追加");

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        void this.submit();
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
      const b = presets.createEl("button", { text: label, cls: "dt-weekday-preset", attr: { type: "button" } });
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
      t.inputEl.addEventListener("keydown", onKey);
    });
    timeSetting.addExtraButton((b) =>
      b
        .setIcon("timer-off")
        .setTooltip("時刻を外して「未スケジュール」として入れる")
        .onClick(() => {
          this.startText = "";
          this.endText = "";
          timeSetting.controlEl.querySelectorAll("input").forEach((i) => ((i as HTMLInputElement).value = ""));
          this.updateHint();
        })
    );
    this.hintEl = timeSetting.descEl;
    this.updateHint();

    if (this.opts.initial) {
      new Setting(contentEl)
        .setName("有効")
        .addToggle((t) => t.setValue(this.enabled).onChange((v) => (this.enabled = v)));
    }

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

  private parse(): { start: number | null; end: number | null } | { error: string } {
    if (this.startText.trim() === "" && this.endText.trim() === "") return { start: null, end: null };
    const start = parseTimeInput(this.startText);
    const end = parseTimeInput(this.endText);
    if (start === null || end === null) return { error: "時刻は 09:00 のように入力してください" };
    if (end <= start) return { error: "終了時刻は開始時刻より後にしてください" };
    return { start, end };
  }

  private updateHint(): void {
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

  private async submit(): Promise<void> {
    const r = this.parse();
    if ("error" in r) {
      new Notice(r.error);
      return;
    }
    const title = joinTitleAndTags(this.title, this.tagChoices, this.selectedTags);
    if (!title) {
      new Notice("タイトルを入力してください");
      return;
    }
    if (this.weekdays.size === 0) {
      new Notice("曜日を1つ以上選んでください");
      return;
    }
    const rule: RecurringRule = {
      id: this.opts.initial?.id || newRuleId(),
      title,
      weekdays: [...this.weekdays].sort((a, b) => a - b),
      start: r.start,
      end: r.end,
      enabled: this.enabled,
    };
    this.close();
    await this.opts.onSubmit(rule);
  }
}

// ---------------------------------------------------------------------------
// ルールの一覧（タイムラインのヘッダーから開く簡易管理画面）
// ---------------------------------------------------------------------------

export class RecurringListModal extends Modal {
  constructor(private plugin: DayTimelinePlugin) {
    super(plugin.app);
  }

  onOpen(): void {
    this.modalEl.addClass("dt-modal");
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText("定期タスク");
    const s = this.plugin.settings;
    const save = async () => {
      await this.plugin.saveSettings();
      this.render();
    };

    if (s.recurring.length === 0) {
      contentEl.createDiv({
        cls: "dt-recurring-empty",
        text: "定期タスクはまだありません。「追加」から作成できます。タスクの右クリック「定期タスクとして登録…」からも作れます。",
      });
    }

    const list = contentEl.createDiv("dt-recurring-list");
    s.recurring.forEach((rule, idx) => {
      const row = list.createDiv("dt-recurring-item");
      row.toggleClass("is-disabled", !rule.enabled);

      const toggle = row.createDiv({
        cls: "dt-recurring-toggle",
        attr: { role: "checkbox", "aria-checked": String(rule.enabled), "aria-label": "有効 / 無効" },
      });
      setIcon(toggle, rule.enabled ? "check-circle-2" : "circle");
      toggle.onclick = async () => {
        rule.enabled = !rule.enabled;
        await save();
      };

      const body = row.createDiv("dt-recurring-body");
      body.createDiv({ cls: "dt-recurring-title", text: rule.title || "(無題)" });
      body.createDiv({ cls: "dt-recurring-desc", text: describeRule(rule) });
      body.onclick = () => this.edit(idx);

      const editBtn = row.createDiv({ cls: "clickable-icon", attr: { "aria-label": "編集" } });
      setIcon(editBtn, "pencil");
      editBtn.onclick = () => this.edit(idx);

      const delBtn = row.createDiv({ cls: "clickable-icon", attr: { "aria-label": "削除" } });
      setIcon(delBtn, "trash");
      delBtn.onclick = async () => {
        s.recurring.splice(idx, 1);
        await save();
      };
    });

    const buttons = new Setting(contentEl);
    buttons.settingEl.addClass("dt-modal-buttons");
    buttons.addButton((b) => b.setButtonText("閉じる").onClick(() => this.close()));
    buttons.addButton((b) =>
      b
        .setButtonText("追加")
        .setCta()
        .onClick(() => {
          new RecurringModal(this.app, {
            tagChoices: s.tagColors,
            onSubmit: async (rule) => {
              s.recurring.push(rule);
              await this.plugin.saveSettings();
              this.render();
            },
          }).open();
        })
    );
  }

  private edit(idx: number): void {
    const s = this.plugin.settings;
    new RecurringModal(this.app, {
      initial: s.recurring[idx],
      tagChoices: s.tagColors,
      onSubmit: async (next) => {
        s.recurring[idx] = next;
        await this.plugin.saveSettings();
        this.render();
        const n = await propagateRecurringUpdate(this.plugin, next);
        if (n) new Notice(`今日以降の ${n} 件のタスクにも反映しました`);
      },
    }).open();
  }
}
