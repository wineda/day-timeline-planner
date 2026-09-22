/**
 * タスクのリマインド（開始の N 分前に通知）と、通知の出し方（OS 通知 / 画面内バナー）。
 */
import { Notice } from "obsidian";
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
