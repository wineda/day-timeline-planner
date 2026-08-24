/**
 * タイマー（タスクとは無関係の単純なカウントダウン）と、
 * タスクのリマインド（開始の N 分前に通知）。
 */
import { App, Modal, Notice, Setting } from "obsidian";
import type DayTimelinePlugin from "./main";
import { isScheduled } from "./model";
import { dateKey, minutesToHHMM, startOfDay } from "./util";

/** 短いビープ音（外部ファイル不要）。失敗しても何もしない */
export function beep(times = 3): void {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const t0 = ctx.currentTime;
    for (let i = 0; i < times; i++) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, t0 + i * 0.35);
      gain.gain.exponentialRampToValueAtTime(0.25, t0 + i * 0.35 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.35 + 0.25);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + i * 0.35);
      osc.stop(t0 + i * 0.35 + 0.3);
    }
    window.setTimeout(() => void ctx.close(), times * 400 + 200);
  } catch (_e) {
    /* 音が鳴らせない環境 */
  }
}

// ---------------------------------------------------------------------------
// 通知の出し方（OS 通知 / 画面内の大きなバナー）
// ---------------------------------------------------------------------------

export interface AlertOptions {
  title: string;
  body: string;
  /** バナー / OS 通知をクリックしたとき */
  onOpen?: () => void;
  /** バナーの追加ボタン */
  actions?: { label: string; onClick: () => void }[];
  /** 音を鳴らす回数（0 で鳴らさない） */
  beeps?: number;
}

/** OS の通知（Electron では Windows / macOS のトーストになる）。出せたら true */
function showSystemNotification(o: AlertOptions): boolean {
  try {
    const N = window.Notification;
    if (!N) return false;
    if (N.permission === "default") {
      void N.requestPermission();
      return false;
    }
    if (N.permission !== "granted") return false;
    const n = new N(o.title, { body: o.body, silent: true });
    n.onclick = () => {
      window.focus();
      o.onOpen?.();
      n.close();
    };
    return true;
  } catch (_e) {
    return false;
  }
}

/** 画面内の大きめのバナー（右下に重ねて表示。閉じるまで残る） */
function showBanner(o: AlertOptions): void {
  let host = document.body.querySelector<HTMLElement>(".dt-alert-host");
  if (!host) host = document.body.createDiv("dt-alert-host");

  const el = host.createDiv("dt-alert");
  el.createDiv({ cls: "dt-alert-title", text: o.title });
  if (o.body) el.createDiv({ cls: "dt-alert-body", text: o.body });
  const buttons = el.createDiv("dt-alert-buttons");
  const close = () => {
    el.addClass("is-leaving");
    window.setTimeout(() => el.remove(), 180);
  };
  for (const a of o.actions ?? []) {
    const b = buttons.createEl("button", { text: a.label });
    b.onclick = (e) => {
      e.stopPropagation();
      a.onClick();
      close();
    };
  }
  if (o.onOpen) {
    const b = buttons.createEl("button", { text: "タイムラインを開く", cls: "mod-cta" });
    b.onclick = (e) => {
      e.stopPropagation();
      o.onOpen?.();
      close();
    };
  }
  const x = buttons.createEl("button", { text: "閉じる" });
  x.onclick = (e) => {
    e.stopPropagation();
    close();
  };
  el.onclick = () => {
    o.onOpen?.();
    close();
  };
  // 描画後にクラスを付けてスライドイン
  window.requestAnimationFrame(() => el.addClass("is-shown"));
}

/** 設定に従って通知を出す */
export function showAlert(plugin: DayTimelinePlugin, o: AlertOptions): void {
  const s = plugin.settings;
  const style = s.notifyStyle;
  let system = false;
  if (style === "system" || style === "both") system = showSystemNotification(o);
  if (style === "banner" || style === "both" || (style === "system" && !system)) showBanner(o);
  if (s.notifySound && (o.beeps ?? 0) > 0) beep(o.beeps);
}

/** OS 通知の許可をあらかじめ求めておく（初回だけダイアログが出る環境がある） */
export function requestNotificationPermission(): void {
  try {
    if (window.Notification && window.Notification.permission === "default") {
      void window.Notification.requestPermission();
    }
  } catch (_e) {
    /* 非対応 */
  }
}

/** 秒 → "MM:SS"（1時間以上なら "H:MM:SS"） */
export function formatSeconds(total: number): string {
  const s = Math.max(0, Math.round(total));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = (h ? String(m).padStart(2, "0") : String(m)) + ":" + String(sec).padStart(2, "0");
  return h ? `${h}:${mm}` : mm;
}

// ---------------------------------------------------------------------------
// タイマー
// ---------------------------------------------------------------------------

export interface TimerState {
  /** 終了予定（epoch ms）。null なら停止中 */
  endAt: number | null;
  /** 全体の長さ（秒） */
  totalSeconds: number;
  label: string;
  /** 終了して、まだ閉じていない */
  finished: boolean;
}

export class TimerService {
  private state: TimerState = { endAt: null, totalSeconds: 0, label: "", finished: false };
  private interval: number | null = null;
  private listeners = new Set<(s: TimerState) => void>();
  private statusEl: HTMLElement | null = null;

  constructor(private plugin: DayTimelinePlugin) {}

  getState(): TimerState {
    return this.state;
  }

  isRunning(): boolean {
    return this.state.endAt !== null;
  }

  /** 残り秒数（停止中は 0） */
  remainingSeconds(): number {
    if (this.state.endAt === null) return 0;
    return Math.max(0, Math.ceil((this.state.endAt - Date.now()) / 1000));
  }

  onChange(fn: (s: TimerState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  attachStatusBar(el: HTMLElement): void {
    this.statusEl = el;
    el.addClass("dt-status-timer");
    el.onclick = () => this.plugin.openTimerModal();
    this.renderStatus();
  }

  start(minutes: number, label = ""): void {
    const secs = Math.max(1, Math.round(minutes * 60));
    this.state = { endAt: Date.now() + secs * 1000, totalSeconds: secs, label, finished: false };
    this.ensureTick();
    this.emit();
    new Notice(`タイマー開始: ${formatSeconds(secs)}${label ? `（${label}）` : ""}`);
  }

  /** 残り時間を足す（分） */
  extend(minutes: number): void {
    if (this.state.endAt === null) return;
    this.state.endAt += minutes * 60_000;
    this.state.totalSeconds += minutes * 60;
    this.emit();
  }

  cancel(): void {
    this.state = { endAt: null, totalSeconds: 0, label: "", finished: false };
    this.stopTick();
    this.emit();
  }

  /** 終了表示を閉じる */
  dismiss(): void {
    if (!this.state.finished) return;
    this.state = { endAt: null, totalSeconds: 0, label: "", finished: false };
    this.emit();
  }

  private ensureTick(): void {
    if (this.interval !== null) return;
    this.interval = window.setInterval(() => this.tick(), 500);
    this.plugin.registerInterval(this.interval);
  }

  private stopTick(): void {
    if (this.interval !== null) {
      window.clearInterval(this.interval);
      this.interval = null;
    }
  }

  private tick(): void {
    if (this.state.endAt === null) {
      this.stopTick();
      return;
    }
    if (Date.now() >= this.state.endAt) {
      const label = this.state.label;
      this.state = { ...this.state, endAt: null, finished: true };
      this.stopTick();
      this.emit();
      this.notifyFinished(label);
      return;
    }
    this.emit();
  }

  private notifyFinished(label: string): void {
    showAlert(this.plugin, {
      title: `⏱ タイマー終了${label ? `: ${label}` : ""}`,
      body: label ? `「${label}」の時間になりました。` : "設定した時間が経過しました。",
      beeps: 3,
      actions: [{ label: "もう一度（同じ長さ）", onClick: () => this.start(this.state.totalSeconds / 60, label) }],
    });
    new TimerDoneModal(this.plugin.app, label, () => this.dismiss()).open();
  }

  private emit(): void {
    this.renderStatus();
    for (const fn of this.listeners) fn(this.state);
  }

  private renderStatus(): void {
    const el = this.statusEl;
    if (!el) return;
    if (this.state.endAt !== null) {
      el.setText(`⏱ ${formatSeconds(this.remainingSeconds())}`);
      el.toggleClass("is-visible", true);
      el.setAttr("aria-label", `タイマー${this.state.label ? `: ${this.state.label}` : ""}（クリックで操作）`);
    } else if (this.state.finished) {
      el.setText("⏱ 終了");
      el.toggleClass("is-visible", true);
    } else {
      el.setText("");
      el.toggleClass("is-visible", false);
    }
  }
}

/** タイマーの開始・操作ダイアログ */
export class TimerModal extends Modal {
  private minutesText = "";
  private label = "";

  constructor(
    app: App,
    private timer: TimerService
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.modalEl.addClass("dt-modal");
    const st = this.timer.getState();

    if (this.timer.isRunning()) {
      this.titleEl.setText("タイマー");
      const remain = contentEl.createDiv("dt-timer-remaining");
      const paint = () => remain.setText(formatSeconds(this.timer.remainingSeconds()));
      paint();
      const off = this.timer.onChange((s) => {
        if (s.endAt === null) {
          this.close();
          return;
        }
        paint();
      });
      this.onClose = () => {
        off();
        contentEl.empty();
      };
      if (st.label) contentEl.createDiv({ cls: "dt-timer-label", text: st.label });
      const buttons = new Setting(contentEl);
      buttons.settingEl.addClass("dt-modal-buttons");
      buttons.addButton((b) => b.setButtonText("+1分").onClick(() => this.timer.extend(1)));
      buttons.addButton((b) => b.setButtonText("+5分").onClick(() => this.timer.extend(5)));
      buttons.addButton((b) =>
        b
          .setButtonText("停止")
          .setWarning()
          .onClick(() => {
            this.timer.cancel();
            this.close();
          })
      );
      buttons.addButton((b) => b.setButtonText("閉じる").onClick(() => this.close()));
      return;
    }

    this.titleEl.setText("タイマーを開始");
    const presets = contentEl.createDiv("dt-timer-presets");
    for (const m of [1, 3, 5, 10, 15, 20, 25, 30, 45, 60, 90]) {
      const b = presets.createEl("button", { text: `${m}分`, cls: "dt-timer-preset", attr: { type: "button" } });
      b.onclick = () => this.startWith(m);
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        this.submit();
      }
    };
    new Setting(contentEl)
      .setName("分数")
      .setDesc("小数も可（例: 0.5 = 30秒）")
      .addText((t) => {
        t.setPlaceholder("例: 25").onChange((v) => (this.minutesText = v));
        t.inputEl.addClass("dt-time-input");
        t.inputEl.addEventListener("keydown", onKey);
        window.setTimeout(() => t.inputEl.focus(), 0);
      });
    new Setting(contentEl).setName("ラベル（任意）").addText((t) => {
      t.setPlaceholder("例: 集中").onChange((v) => (this.label = v));
      t.inputEl.addEventListener("keydown", onKey);
    });

    const buttons = new Setting(contentEl);
    buttons.settingEl.addClass("dt-modal-buttons");
    buttons.addButton((b) => b.setButtonText("キャンセル").onClick(() => this.close()));
    buttons.addButton((b) => b.setButtonText("開始").setCta().onClick(() => this.submit()));
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private submit(): void {
    const n = Number(this.minutesText.replace(/[０-９．]/g, (c) => (c === "．" ? "." : String.fromCharCode(c.charCodeAt(0) - 0xfee0))));
    if (!Number.isFinite(n) || n <= 0) {
      new Notice("分数を入力するか、プリセットを選んでください");
      return;
    }
    this.startWith(n);
  }

  private startWith(minutes: number): void {
    this.timer.start(minutes, this.label.trim());
    this.close();
  }
}

/** タイマー終了のダイアログ */
class TimerDoneModal extends Modal {
  constructor(
    app: App,
    private label: string,
    private onDismiss: () => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("dt-modal", "dt-timer-done");
    this.titleEl.setText("⏱ タイマー終了");
    this.contentEl.createDiv({
      cls: "dt-timer-done-text",
      text: this.label ? `「${this.label}」の時間になりました。` : "設定した時間が経過しました。",
    });
    const buttons = new Setting(this.contentEl);
    buttons.settingEl.addClass("dt-modal-buttons");
    buttons.addButton((b) => b.setButtonText("OK").setCta().onClick(() => this.close()));
  }

  onClose(): void {
    this.contentEl.empty();
    this.onDismiss();
  }
}

// ---------------------------------------------------------------------------
// リマインド
// ---------------------------------------------------------------------------

/**
 * 今日のタスクを定期的に見て、開始の N 分前になったら通知する。
 * N はタスクごとの指定（メタ行の 🔔）があればそれ、無ければ設定の既定値。
 */
export class ReminderService {
  private interval: number | null = null;
  /** 通知済み（"日付|タスクkey|開始分|N"） */
  private fired = new Set<string>();
  private lastDay = "";

  constructor(private plugin: DayTimelinePlugin) {}

  start(): void {
    if (this.interval !== null) return;
    this.interval = window.setInterval(() => void this.check(), 20_000);
    this.plugin.registerInterval(this.interval);
    void this.check();
  }

  private async check(): Promise<void> {
    const s = this.plugin.settings;
    if (!s.reminderEnabled) return;
    const now = new Date();
    const today = startOfDay(now);
    const key = dateKey(today);
    if (key !== this.lastDay) {
      this.fired.clear();
      this.lastDay = key;
    }
    const nowMin = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;

    let tasks;
    try {
      tasks = (await this.plugin.store.load(today)).tasks;
      for (const m of s.members) {
        if (!m.remind) continue;
        const ms = this.plugin.memberStores.get(m.id);
        if (!ms) continue;
        try {
          tasks.push(...(await ms.load(today)).tasks);
        } catch (_e) {
          /* その人のノートが読めなければ飛ばす */
        }
      }
    } catch (_e) {
      return;
    }
    for (const t of tasks) {
      if (!isScheduled(t) || t.done) continue;
      const lead = t.reminder === null ? s.reminderDefaultMinutes : t.reminder;
      if (lead === "off") continue;
      const fireAt = t.start - lead;
      // 通知時刻を過ぎていて、まだ 2 分以内（Obsidian を閉じていた分は追いかけない）
      if (nowMin < fireAt || nowMin >= fireAt + 2 || nowMin >= t.end) continue;
      const fkey = `${key}|${t.owner ?? ""}|${t.key}|${t.start}|${lead}`;
      if (this.fired.has(fkey)) continue;
      this.fired.add(fkey);
      const owner = this.plugin.memberOf(t.owner);
      this.notify((owner ? `[${owner.name}] ` : "") + t.title, t.start, t.end, lead);
    }
  }

  private notify(title: string, start: number, end: number, lead: number): void {
    const when = lead <= 0 ? "開始時刻です" : `あと${lead}分で開始`;
    showAlert(this.plugin, {
      title: `🔔 ${title || "(無題)"}`,
      body: `${when}（${minutesToHHMM(start)} - ${minutesToHHMM(end)}）`,
      onOpen: () => void this.plugin.activateView(),
      actions: [{ label: "5分後にもう一度", onClick: () => this.snooze(title, start, end, 5) }],
      beeps: 2,
    });
  }

  /** 少し後にもう一度通知する */
  private snooze(title: string, start: number, end: number, minutes: number): void {
    window.setTimeout(() => this.notify(title, start, end, 0), minutes * 60_000);
    new Notice(`${minutes}分後にもう一度お知らせします`);
  }
}
