/**
 * 日報のポップアップ（日付ヘッダーの日付をクリックすると開く）。
 * 設定「日報のフォルダ」（既定 daily）にある、その日の日報ノート（AI などが書いたもの）を
 * そのまま Markdown として描画する。日報がまだ無い日は案内を出し、必要なら
 * プラグインが集計した予定・実績・記録（タスクの集計）を代わりに見られる。
 * 左右のスワイプ（◀ ▶ ボタン・← → キーでも）で前後の日の日報に移れる。
 */
import { App, Component, MarkdownRenderer, Modal, Notice, Setting, TFile, moment, setIcon } from "obsidian";
import type { ButtonComponent } from "obsidian";
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
import { addDays, dateKey, isToday, stripTags } from "./util";
import { iconName } from "./icons";

/** 日報のノート（フォルダから見つけたもの）と、その本文 */
export interface DailyNote {
  file: TFile;
  content: string;
}

/** 1日ぶんの材料: 日報ノート（無ければ null）と、集計用のその日のタスク */
export interface DailyDay {
  note: DailyNote | null;
  tasks: Task[];
}

export interface DailyReportModalOptions {
  date: Date;
  day: DailyDay;
  /** 別の日へ移ったときにその日の材料を読む（無ければ日付の移動はできない） */
  loadDay?: (date: Date) => Promise<DailyDay>;
  /** 日報ノートを探すフォルダ（無いときの案内に出す） */
  noteFolder: string;
  /** チケットの URL（無ければ null） */
  ticketUrlOf: (tracker: string, id: string) => string | null;
  /** タグの色（バッジの色分けに使う。無ければ枠線だけ） */
  colorOfTags: (tags: string[]) => string | null;
  /** 「ノートで開く」を押したとき（日報ノートをタブで開く） */
  onOpenNote: (file: TFile) => void;
  /** 「集計をノートに書き出す」を押したとき（表示中の日） */
  onExport: (date: Date) => void;
  /** 集計のタスク行をクリックしたとき（タイムラインの該当ブロックへジャンプ）。無ければクリック不可 */
  onSelectTask?: (date: Date, task: Task) => void;
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

/** 先頭の YAML フロントマターを外す（描画すると表やコードになって邪魔なので） */
function stripFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

/** 横スワイプと見なす最小の移動量（px）。タイムラインの日付移動と同じ */
const SWIPE_MIN_X = 48;
/** これより縦に動いたらスクロールと見なしてスワイプ判定をやめる */
const SWIPE_SLOP_Y = 10;

export class DailyReportModal extends Modal {
  /** 表示中の日（スワイプで変わる） */
  private date: Date;
  private note: DailyNote | null;
  private tasks: Task[];
  private report: DailyReport;
  /** 日報が無い日に「タスクの集計」を開いているか（日を移っても保つ） */
  private summaryOpen = false;
  /** 日付の切替が重ならないよう、最後の読み込みだけを反映するための通し番号 */
  private loadSeq = 0;
  private titleLabelEl: HTMLElement | null = null;
  private bodyEl: HTMLElement | null = null;
  private openNoteBtn: ButtonComponent | null = null;
  /** MarkdownRenderer の寿命をこのポップアップに合わせるための入れ物 */
  private component = new Component();

  constructor(
    app: App,
    private opts: DailyReportModalOptions
  ) {
    super(app);
    this.date = opts.date;
    this.note = opts.day.note;
    this.tasks = opts.day.tasks;
    this.report = summarizeDaily({ date: opts.date, tasks: opts.day.tasks });
  }

  onOpen(): void {
    const { contentEl } = this;
    this.component.load();
    this.modalEl.addClass("dt-modal");
    this.modalEl.addClass("dt-daily-modal");
    this.renderTitle();
    this.bodyEl = contentEl.createDiv("dt-daily-body");

    const buttons = new Setting(contentEl);
    buttons.settingEl.addClass("dt-modal-buttons");
    buttons.addButton((b) =>
      b
        .setButtonText("コピー")
        .setTooltip("日報の Markdown をクリップボードにコピー（日報が無い日はタスクの集計）")
        .onClick(() => void this.copy())
    );
    buttons.addButton((b) => {
      this.openNoteBtn = b;
      b.setButtonText("ノートで開く")
        .setCta()
        .onClick(() => {
          const note = this.note;
          if (!note) {
            new Notice("この日の日報はまだありません");
            return;
          }
          this.close();
          this.opts.onOpenNote(note.file);
        });
    });
    buttons.addButton((b) => b.setButtonText("閉じる").onClick(() => this.close()));

    void this.renderBody();

    if (this.opts.loadDay) {
      this.attachSwipe();
      // ← → で前後の日（入力欄は無いので、そのままキーを取ってよい）
      this.scope.register([], "ArrowLeft", (e) => {
        e.preventDefault();
        void this.go(-1);
      });
      this.scope.register([], "ArrowRight", (e) => {
        e.preventDefault();
        void this.go(1);
      });
    }
  }

  onClose(): void {
    this.loadSeq++;
    this.component.unload();
    this.contentEl.empty();
  }

  /** 見出し: 「◀ 日報 9月3日 (木) ▶」。日付の移動ができないときはボタンを出さない */
  private renderTitle(): void {
    const el = this.titleEl;
    el.empty();
    el.addClass("dt-daily-title-bar");
    if (this.opts.loadDay) {
      this.navButton(el, "chevron-left", "前の日の日報（← キー / 右へスワイプ）", -1);
    }
    this.titleLabelEl = el.createSpan("dt-daily-title-label");
    this.updateTitleLabel();
    if (this.opts.loadDay) {
      this.navButton(el, "chevron-right", "次の日の日報（→ キー / 左へスワイプ）", 1);
    }
  }

  private navButton(parent: HTMLElement, icon: string, label: string, dir: -1 | 1): void {
    const btn = parent.createEl("button", {
      cls: "clickable-icon dt-daily-nav",
      attr: { type: "button", "aria-label": label },
    });
    setIcon(btn, iconName(icon));
    btn.addEventListener("click", () => void this.go(dir));
  }

  private updateTitleLabel(): void {
    const el = this.titleLabelEl;
    if (!el) return;
    el.empty();
    el.createSpan({ cls: "dt-daily-title-word", text: "日報" });
    el.createSpan({ cls: "dt-daily-title-date", text: moment(this.date).format("M月D日 (ddd)") });
    if (isToday(this.date)) el.createSpan({ cls: "dt-daily-title-today", text: "今日" });
  }

  /**
   * 本文を描き直す。日報ノートがあればその Markdown を描画し、
   * 無ければ案内 + 「タスクの集計を見る」（開いていれば集計）
   */
  private async renderBody(): Promise<void> {
    const body = this.bodyEl;
    if (!body) return;
    body.empty();
    this.openNoteBtn?.setDisabled(!this.note);
    const note = this.note;
    if (note) {
      const md = body.createDiv("dt-daily-md markdown-rendered");
      const seq = this.loadSeq;
      await MarkdownRenderer.render(this.app, stripFrontmatter(note.content), md, note.file.path, this.component);
      if (seq !== this.loadSeq) return; // 描画中に別の日へ移った・閉じた
      // ノート内のリンクはポップアップを閉じてから開く（描画しただけでは動かないので）
      md.addEventListener("click", (e) => {
        const a = (e.target as HTMLElement).closest<HTMLElement>("a.internal-link");
        if (!a) return;
        e.preventDefault();
        const href = a.getAttr("data-href") ?? a.getAttr("href") ?? "";
        if (!href) return;
        this.close();
        void this.app.workspace.openLinkText(href, note.file.path, false).catch((err) => {
          console.error(err);
          new Notice("リンク先を開けませんでした: " + String(err));
        });
      });
      return;
    }

    const miss = body.createDiv("dt-daily-missing");
    const icon = miss.createSpan("dt-daily-missing-icon");
    setIcon(icon, iconName("file-x"));
    const text = miss.createDiv("dt-daily-missing-text");
    text.createDiv({
      cls: "dt-daily-missing-title",
      text: `${moment(this.date).format("M月D日")} の日報はまだありません`,
    });
    text.createDiv({
      cls: "dt-daily-missing-desc",
      text: `フォルダ「${this.opts.noteFolder}」で、ファイル名に ${dateKey(this.date)} を含むノートを探しています`,
    });
    const toggle = miss.createEl("button", {
      cls: "dt-daily-summary-toggle",
      text: this.summaryOpen ? "タスクの集計を隠す" : "タスクの集計を見る",
      attr: { type: "button" },
    });
    toggle.addEventListener("click", () => {
      this.summaryOpen = !this.summaryOpen;
      void this.renderBody();
    });
    if (this.summaryOpen) {
      const sum = body.createDiv("dt-daily-summary");
      this.renderTotals(sum);
      this.renderTasks(sum);
      this.renderNotes(sum);
      this.renderOthers(sum);
      this.renderLeftovers(sum);
      this.renderBuckets(sum);
      const exp = sum.createEl("button", {
        cls: "dt-daily-summary-export",
        text: "集計をノートに書き出す",
        attr: { type: "button" },
      });
      exp.addEventListener("click", () => {
        const date = this.date;
        this.close();
        this.opts.onExport(date);
      });
    }
  }

  /**
   * 前後の日へ移る。読み込みの間は本文を薄くし、読めたら移動した方向から滑り込ませる。
   * 連続でスワイプされたときは最後の日だけを反映する
   */
  private async go(dir: -1 | 1): Promise<void> {
    const load = this.opts.loadDay;
    const body = this.bodyEl;
    if (!load || !body) return;
    const date = addDays(this.date, dir);
    const seq = ++this.loadSeq;
    body.addClass("is-loading");
    let day: DailyDay;
    try {
      day = await load(date);
    } catch (e) {
      console.error(e);
      if (seq === this.loadSeq) body.removeClass("is-loading");
      new Notice("日報を読めませんでした: " + String(e));
      return;
    }
    if (seq !== this.loadSeq) return; // その後さらに移動している
    this.date = date;
    this.note = day.note;
    this.tasks = day.tasks;
    this.report = summarizeDaily({ date, tasks: day.tasks });
    this.updateTitleLabel();
    await this.renderBody();
    if (seq !== this.loadSeq) return;
    body.removeClass("is-loading");
    body.removeClass("is-slide-left", "is-slide-right");
    // 同じクラスを付け直してもアニメーションが再生されるよう、1フレーム空ける
    void body.offsetWidth;
    body.addClass(dir > 0 ? "is-slide-left" : "is-slide-right");
    body.addEventListener("animationend", () => body.removeClass("is-slide-left", "is-slide-right"), {
      once: true,
    });
    this.contentEl.scrollTop = 0;
  }

  /**
   * 左右スワイプで前後の日へ（タッチ・ペンだけ。マウスのドラッグでは動かさない）。
   * 縦方向が優勢ならスクロールに譲る。タイムラインの日付移動と同じ判定
   */
  private attachSwipe(): void {
    const el = this.modalEl;
    el.addEventListener("pointerdown", (e: PointerEvent) => {
      if (e.pointerType === "mouse" || !e.isPrimary) return;
      const sx = e.clientX;
      const sy = e.clientY;
      const id = e.pointerId;
      const cleanup = () => {
        document.removeEventListener("pointermove", onMove, true);
        document.removeEventListener("pointerup", onEnd, true);
        document.removeEventListener("pointercancel", onEnd, true);
      };
      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== id) return;
        const dx = ev.clientX - sx;
        const dy = ev.clientY - sy;
        if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > SWIPE_SLOP_Y) {
          cleanup();
          return;
        }
        if (Math.abs(dx) >= SWIPE_MIN_X && Math.abs(dx) > Math.abs(dy) * 1.5) {
          cleanup();
          // 左へ払う（dx < 0）= 次の日、右へ払う = 前の日
          void this.go(dx < 0 ? 1 : -1);
        }
      };
      const onEnd = (ev: PointerEvent) => {
        if (ev.pointerId !== id) return;
        cleanup();
      };
      document.addEventListener("pointermove", onMove, true);
      document.addEventListener("pointerup", onEnd, true);
      document.addEventListener("pointercancel", onEnd, true);
    });
    // 横方向の touchmove が Obsidian 本体（モバイルのサイドバー開閉）に取られないようにする
    let tsx = 0;
    let tsy = 0;
    el.addEventListener(
      "touchstart",
      (ev: TouchEvent) => {
        const t = ev.touches[0];
        if (!t) return;
        tsx = t.clientX;
        tsy = t.clientY;
      },
      { passive: true }
    );
    el.addEventListener(
      "touchmove",
      (ev: TouchEvent) => {
        const t = ev.touches[0];
        if (!t) return;
        if (Math.abs(t.clientX - tsx) > Math.abs(t.clientY - tsy)) ev.stopPropagation();
      },
      { passive: true }
    );
  }

  /** コピーする Markdown: 日報ノートの本文。無い日はタスクの集計 */
  private markdown(): string {
    if (this.note) return this.note.content;
    return buildDailyReport({ date: this.date, tasks: this.tasks }, { ticketUrlOf: this.opts.ticketUrlOf });
  }

  private async copy(): Promise<void> {
    const text = this.markdown();
    const what = this.note ? "日報" : "タスクの集計";
    try {
      // モバイルの WebView では navigator.clipboard が使えないことがあるので、
      // 使えなければ隠しテキストエリア + execCommand("copy") に落とす
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else if (!copyFallback(text)) throw new Error("クリップボードを使えません");
      new Notice(`${what}をコピーしました`);
    } catch (e) {
      console.error(e);
      if (copyFallback(text)) {
        new Notice(`${what}をコピーしました`);
        return;
      }
      new Notice("コピーできませんでした: " + String(e));
    }
  }

  // ---------- タスクの集計（日報が無い日のフォールバック） ----------

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
          const date = this.date;
          this.close();
          this.opts.onSelectTask?.(date, t);
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
