/**
 * 日報のポップアップ（日付ヘッダーの日付をクリックすると開く）。
 * その日の予定・実績の合計、タスクの一覧、結果・ふりかえりなどの記録、集計をまとめて見せる。
 * 「ノートに書き出す」で同じ内容を Markdown のノート（日報）にできる。
 */
import { App, Modal, Notice, Setting, moment, setIcon } from "obsidian";
import type { Task } from "./model";
import {
  actualLabel,
  buildDailyReport,
  planLabel,
  statusLabel,
  summarizeDaily,
  type DailyBucket,
  type DailyReport,
} from "./report";
import { stripTags } from "./util";
import { iconName } from "./icons";

export interface DailyReportModalOptions {
  date: Date;
  /** その日のタスク（メンバーの予定が混ざっていても中で除外する） */
  tasks: Task[];
  /** チケットの URL（無ければ null） */
  ticketUrlOf: (tracker: string, id: string) => string | null;
  /** タグの色（バッジの色分けに使う。無ければ枠線だけ） */
  colorOfTags: (tags: string[]) => string | null;
  /** 「ノートに書き出す」を押したとき */
  onExport: () => void;
  /** タスクの行をクリックしたとき（タイムラインの該当ブロックへジャンプ）。無ければクリック不可 */
  onSelectTask?: (task: Task) => void;
}

/** 分を "6:30" のような時:分表示に。0 は "–" */
function hmm(min: number): string {
  if (!min) return "–";
  return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}`;
}

/** 差異（実績 - 予定）。どちらかが 0 なら比べない */
function diff(plan: number, act: number): string {
  if (!plan || !act) return "";
  const d = act - plan;
  if (d === 0) return "±0:00";
  return `${d > 0 ? "+" : "-"}${hmm(Math.abs(d))}`;
}

export class DailyReportModal extends Modal {
  private report: DailyReport;

  constructor(
    app: App,
    private opts: DailyReportModalOptions
  ) {
    super(app);
    this.report = summarizeDaily({ date: opts.date, tasks: opts.tasks });
  }

  onOpen(): void {
    const { contentEl } = this;
    this.modalEl.addClass("dt-modal");
    this.modalEl.addClass("dt-daily-modal");
    this.titleEl.setText(`日報 ${moment(this.opts.date).format("M月D日 (ddd)")}`);

    this.renderTotals(contentEl);
    this.renderTasks(contentEl);
    this.renderNotes(contentEl);
    this.renderOthers(contentEl);
    this.renderLeftovers(contentEl);
    this.renderBuckets(contentEl);

    const buttons = new Setting(contentEl);
    buttons.settingEl.addClass("dt-modal-buttons");
    buttons.addButton((b) =>
      b
        .setButtonText("コピー")
        .setTooltip("日報の Markdown をクリップボードにコピー")
        .onClick(() => void this.copy())
    );
    buttons.addButton((b) =>
      b
        .setButtonText("ノートに書き出す")
        .setCta()
        .onClick(() => {
          this.close();
          this.opts.onExport();
        })
    );
    buttons.addButton((b) => b.setButtonText("閉じる").onClick(() => this.close()));
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private markdown(): string {
    return buildDailyReport(
      { date: this.opts.date, tasks: this.opts.tasks },
      { ticketUrlOf: this.opts.ticketUrlOf }
    );
  }

  private async copy(): Promise<void> {
    const text = this.markdown();
    try {
      // モバイルの WebView では navigator.clipboard が使えないことがあるので、
      // 使えなければ隠しテキストエリア + execCommand("copy") に落とす
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else if (!copyFallback(text)) throw new Error("クリップボードを使えません");
      new Notice("日報をコピーしました");
    } catch (e) {
      console.error(e);
      if (copyFallback(text)) {
        new Notice("日報をコピーしました");
        return;
      }
      new Notice("コピーできませんでした: " + String(e));
    }
  }

  /** 上段: 予定・実績・差異・完了件数のピル */
  private renderTotals(parent: HTMLElement): void {
    const r = this.report;
    const el = parent.createDiv("dt-daily-totals");
    const pill = (label: string, value: string, cls?: string) => {
      const p = el.createDiv("dt-daily-pill");
      if (cls) p.addClass(cls);
      p.createSpan({ cls: "dt-daily-pill-label", text: label });
      p.createSpan({ cls: "dt-daily-pill-value", text: value });
    };
    pill("予定", hmm(r.totalPlan));
    pill("実績", hmm(r.totalAct));
    const d = diff(r.totalPlan, r.totalAct);
    if (d) pill("差異", d, r.totalAct > r.totalPlan ? "is-over" : "is-under");
    pill("完了", r.total ? `${r.done}/${r.total}` : "–");
    if (r.forwarded) pill("持ち越し", String(r.forwarded));

    // 完了の割合を細いバーで（件数ベース。0 件の日は出さない）
    if (r.total) {
      const bar = parent.createDiv("dt-daily-bar");
      const fill = bar.createDiv();
      fill.style.width = `${Math.round((r.done / r.total) * 100)}%`;
      fill.toggleClass("is-complete", r.done === r.total);
    }
  }

  private section(parent: HTMLElement, title: string): HTMLElement {
    const wrap = parent.createDiv("dt-daily-section");
    wrap.createDiv({ cls: "dt-daily-section-title", text: title });
    return wrap.createDiv("dt-daily-section-body");
  }

  /** タスクの一覧（時間・タイトル・予実・状態） */
  private renderTasks(parent: HTMLElement): void {
    const r = this.report;
    if (!r.rows.length) {
      parent.createDiv({
        cls: "dt-daily-empty",
        text: "この日には予定・実績のあるタスクがありません",
      });
      return;
    }
    const body = this.section(parent, "タスク");
    for (const row of r.rows) {
      const t = row.task;
      const el = body.createDiv("dt-daily-task");
      el.toggleClass("is-done", t.done);
      el.toggleClass("is-forwarded", t.forwarded);
      const color = this.opts.colorOfTags(t.tags);
      if (color) el.style.setProperty("--dt-daily-color", color);

      const head = el.createDiv("dt-daily-task-head");
      head.createSpan({ cls: "dt-daily-time", text: planLabel(t) || "時刻未定" });
      head.createSpan({ cls: "dt-daily-title", text: this.titleOf(t) });
      const st = statusLabel(t);
      if (st) head.createSpan({ cls: "dt-daily-status", text: st });

      const meta = el.createDiv("dt-daily-task-meta");
      meta.createSpan({ text: `予定 ${hmm(row.plan)}` });
      meta.createSpan({ text: `実績 ${hmm(row.act)}` });
      const d = diff(row.plan, row.act);
      if (d) {
        const dEl = meta.createSpan({ cls: "dt-daily-diff", text: d });
        dEl.toggleClass("is-over", row.act > row.plan);
      }
      const act = actualLabel(t);
      if (act) meta.createSpan({ cls: "dt-daily-actual", text: act });
      if (t.ticket) {
        const label = `${t.ticket.tracker || ""}#${t.ticket.id}`;
        const url = this.opts.ticketUrlOf(t.ticket.tracker, t.ticket.id);
        if (url) {
          const a = meta.createEl("a", { cls: "dt-daily-ticket", text: label, href: url });
          a.setAttr("target", "_blank");
          a.setAttr("rel", "noopener");
        } else {
          meta.createSpan({ cls: "dt-daily-ticket", text: label });
        }
      }
      if (t.project) {
        meta.createSpan({ cls: "dt-daily-project", text: t.project.split("/").pop() ?? t.project });
      }
      for (const tag of t.tags) meta.createSpan({ cls: "dt-daily-tag", text: "#" + tag });

      if (this.opts.onSelectTask) {
        el.addClass("is-clickable");
        el.setAttr("role", "button");
        el.setAttr("tabindex", "0");
        el.setAttr("aria-label", "タイムラインのこのタスクへ移動");
        const jump = () => {
          this.close();
          this.opts.onSelectTask?.(t);
        };
        el.addEventListener("click", jump);
        el.addEventListener("keydown", (e: KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            jump();
          }
        });
      }
    }
  }

  /** 結果・ふりかえりなどの記録 */
  private renderNotes(parent: HTMLElement): void {
    if (!this.report.notes.length) return;
    const body = this.section(parent, "記録");
    for (const n of this.report.notes) {
      const el = body.createDiv("dt-daily-note");
      el.createDiv({ cls: "dt-daily-note-title", text: n.title });
      for (const f of n.fields) {
        const line = el.createDiv("dt-daily-note-field");
        line.createSpan({ cls: "dt-daily-note-label", text: f.label });
        line.createSpan({ cls: "dt-daily-note-text", text: f.text });
      }
    }
  }

  /** 相手にボールがあるもの */
  private renderOthers(parent: HTMLElement): void {
    if (!this.report.others.length) return;
    const body = this.section(parent, "相手待ち");
    for (const o of this.report.others) {
      const el = body.createDiv("dt-daily-line");
      const icon = el.createSpan("dt-daily-line-icon");
      setIcon(icon, iconName("user"));
      el.createSpan({ cls: "dt-daily-note-text", text: o.text });
      el.createSpan({ cls: "dt-daily-note-title", text: o.title });
    }
  }

  /** 未完了のまま残ったタスク */
  private renderLeftovers(parent: HTMLElement): void {
    if (!this.report.leftovers.length) return;
    const body = this.section(parent, "残っているタスク");
    for (const l of this.report.leftovers) {
      const el = body.createDiv("dt-daily-line");
      el.createSpan({ cls: "dt-daily-note-text", text: l.title });
      if (l.nextAction) el.createSpan({ cls: "dt-daily-next", text: `次: ${l.nextAction}` });
    }
  }

  /** 集計（プロジェクト別・タグ別・チケット別） */
  private renderBuckets(parent: HTMLElement): void {
    const r = this.report;
    this.bucketTable(parent, "プロジェクト別", r.byProject);
    this.bucketTable(parent, "タグ別", r.byTag.some((b) => b.key !== "(タグなし)") ? r.byTag : []);
    this.bucketTable(parent, "チケット別", r.byTicket);
  }

  private bucketTable(parent: HTMLElement, title: string, rows: DailyBucket[]): void {
    if (!rows.length) return;
    const body = this.section(parent, title);
    // 狭い画面（スマホ）でも本文がはみ出さないよう、表だけ横にスクロールさせる
    const table = body.createDiv("dt-daily-table-wrap").createEl("table", { cls: "dt-daily-table" });
    const head = table.createEl("thead").createEl("tr");
    for (const h of [title.replace("別", ""), "件数", "予定", "実績", "差異"]) head.createEl("th", { text: h });
    const tbody = table.createEl("tbody");
    for (const b of rows) {
      const tr = tbody.createEl("tr");
      tr.createEl("td", { text: b.key });
      tr.createEl("td", { cls: "dt-daily-num", text: String(b.count) });
      tr.createEl("td", { cls: "dt-daily-num", text: hmm(b.plan) });
      tr.createEl("td", { cls: "dt-daily-num", text: hmm(b.act) });
      const d = tr.createEl("td", { cls: "dt-daily-num", text: diff(b.plan, b.act) });
      d.toggleClass("is-over", b.act > b.plan && !!b.plan);
    }
  }

  /** タグを外したタイトル（空なら「(無題)」） */
  private titleOf(t: Task): string {
    return stripTags(t.title) || "(無題)";
  }
}

/**
 * navigator.clipboard が無い / 失敗したときのコピー（隠しテキストエリア + execCommand）。
 * コピーできたかを返す
 */
function copyFallback(text: string): boolean {
  const ta = document.body.createEl("textarea", { attr: { readonly: "" } });
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch (e) {
    console.error(e);
  }
  ta.remove();
  return ok;
}
