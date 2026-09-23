/**
 * タイムラインビューの左サイドバー（パネル）: 「Inbox・時刻なし」の一覧、プロジェクトのツリー、本日のサマリー。
 * DayTimelineView のミックスイン（view.ts の末尾で合成）。this はビュー自身
 */
import { Menu, Notice, getIcon, moment, setIcon } from "obsidian";
import { Task, isScheduled, stepProgress } from "./model";
import { ConfirmModal, PromptModal, TaskModal } from "./modal";
import type { TicketRef } from "./markdown/blocks";
import {
  groupProjects,
  isChildSettled,
  knownGroupNames,
  projectDisplayName,
  renderGroupIcon,
  type ProjectChild,
  type ProjectDoc,
  type ProjectFields,
  type ProjectGroup,
  type ProjectSummary,
} from "./project";
import { iconName } from "./icons";
import type { MenuLike } from "./dropdown";
import { colorForTags, ticketUrl, type ProjectsFilter } from "./settings";
import { INBOX_DATE } from "./store";
import {
  addDays,
  clamp,
  dateKey,
  errorText,
  isSameDay,
  isToday,
  minutesToHHMM,
  nowMinutes,
  startOfDay,
} from "./util";
import type { DayTimelineView } from "./view";
import {
  MAX_SUMMARY_SEGMENTS,
  RESCHEDULE_LOOKBACK_DAYS,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  WEEKDAY_JA,
  countedSteps,
  dayStats,
  hmm,
  stepStats,
  summaryMessage,
} from "./view-shared";

export class SidebarMixin {
  /** Inbox パネルに出すタスク: 未完了のもののうち、プロジェクト付きでないもの
   *（プロジェクト付きはプロジェクトパネル側に出る。完了してもノートには残る）。
   * ただし、そのプロジェクトがパネルに出ていない（完了済み・ノートが見つからない・
   * パネル非表示）タスクは、どこにも表示されず行方不明になるので Inbox 側に出す */
  inboxVisible(this: DayTimelineView, tasks: Task[]): Task[] {
    return tasks.filter((t) => !t.done && (!t.project || !this.projectPanelShows(t.project)));
  }

  /** そのプロジェクトリンクが、プロジェクトパネルに進行中の行として出ているか */
  projectPanelShows(this: DayTimelineView, linktext: string): boolean {
    if (!this.plugin.projects || !this.plugin.settings.showProjects) return false;
    const src = this.plugin.inbox?.pathFor(INBOX_DATE) ?? "";
    // プロジェクトの集計（projectSummaries）と同じ方法でリンク先を解決して照合する
    const dest = this.app.metadataCache.getFirstLinkpathDest(linktext, src);
    const key = dest?.path ?? linktext + ".md";
    return this.projectData.some((s) => !s.done && s.ref.linktext + ".md" === key);
  }

  /** Inbox だけ読み直す（コマンドから追加したときなど） */
  async reloadInbox(this: DayTimelineView): Promise<void> {
    const inbox = this.plugin.inbox;
    if (!inbox || !this.inboxEl) return;
    this.inboxTasks = this.plugin.settings.showInbox
      ? this.inboxVisible((await inbox.load(INBOX_DATE)).tasks)
      : [];
    this.renderInbox();
  }

  /**
   * 左サイドバーのパネル。上から「Inbox・時刻なし」の一覧、プロジェクトのツリー、本日のサマリー。
   * タブは無く、セクションごとに見出しのクリックで畳める（記憶される）
   */
  renderInbox(this: DayTimelineView): void {
    const s = this.plugin.settings;
    const inbox = this.plugin.inbox;
    this.inboxEl.empty();
    const showInbox = !!inbox && s.showInbox;
    const reschedule = this.rescheduleGroups(); // 設定「時刻なしのタスクを一覧に出す」がオフなら空
    const showTasks = showInbox || s.showUnscheduledTray;
    const showProjects = !!this.plugin.projects && s.showProjects;
    // 本日のサマリーは一番下に常に出す（他が無くても、これだけでパネルを出す）
    const showSummary = s.showTodaySummary && !!this.plugin.blockStore();
    const visible = showTasks || showProjects || showSummary;
    this.summaryEl = null;
    this.inboxEl.toggleClass("is-visible", visible);
    // 狭い画面の切替ボタンは、パネルに出すものがあるときだけ出す
    this.paneEl.toggleClass("is-available", visible);
    if (!visible && this.narrowPane === "panel") {
      // パネルに出すものが無くなったら、真っ白にならないようタイムラインへ戻す
      this.narrowPane = "timeline";
      this.applyNarrowClasses();
    }
    if (!visible) return;

    const today = startOfDay(new Date());
    const inboxTasks = showInbox ? this.inboxTasks : [];
    const waiting = reschedule.reduce((n, g) => n + g.tasks.length, 0) + inboxTasks.length;
    const overdue = reschedule.some((g) => g.date < today);
    const activeProjects = this.projectData.filter((x) => !x.done);

    // 狭い画面でパネルを全面表示しているときは、畳まず幅も固定しない
    const narrowPanel = this.isNarrow && this.narrowPane === "panel";
    const collapsed = s.inboxCollapsed && !narrowPanel;
    this.inboxEl.toggleClass("is-collapsed", collapsed);
    this.applySidebarWidth(collapsed || narrowPanel ? null : s.sidebarWidth);
    if (!collapsed && !narrowPanel) this.attachSidebarResize();

    const doToggle = () => {
      s.inboxCollapsed = !s.inboxCollapsed;
      void this.plugin.persistSettings();
      this.renderInbox();
    };
    const toggleButton = (parent: HTMLElement) => {
      const b = this.iconButton(
        parent,
        collapsed ? "panel-left-open" : "panel-left-close",
        collapsed ? "パネルを開く" : "パネルを畳む",
        doToggle
      );
      b.addClass("dt-inbox-toggle");
    };

    if (collapsed) {
      // 細い帯: 開くボタンと縦書きの見出し、待っているタスクの件数
      const head = this.inboxEl.createDiv("dt-inbox-head");
      toggleButton(head);
      const label = head.createSpan({ cls: "dt-inbox-label", text: "パネル" });
      label.onclick = doToggle;
      if (showTasks) {
        const count = head.createSpan({ cls: "dt-inbox-count", text: String(waiting) });
        count.toggleClass("has-overdue", overdue);
        count.setAttr(
          "aria-label",
          overdue ? "過去に取り残された時刻なしタスクがあります" : "Inbox・時刻なしのタスクの件数"
        );
      }
      return;
    }
    if (narrowPanel) {
      // パネルを全面表示中はツールバー（タイムライン⇄パネルの切替ごと）が隠れているので、
      // 同じ切替セグメントをツールバーと同じ左端に出す（パネル側がアクティブ）。
      // 位置・大きさをそろえておくと、面を行き来しても指を動かさずに押せる
      const head = this.inboxEl.createDiv("dt-inbox-head");
      const seg = head.createDiv("dt-pane");
      seg.addClass("is-available", "dt-inbox-toggle");
      const btns = this.buildPaneSegmentButtons(seg);
      btns.panel.addClass("is-active");
      btns.timeline.setAttr("aria-pressed", "false");
      btns.panel.setAttr("aria-pressed", "true");
      head.createSpan({ cls: "dt-inbox-label", text: "パネル" });
    }

    const body = this.inboxEl.createDiv("dt-inbox-body");
    // 最初のセクションの見出しに「畳む」ボタンを置く（全面表示中は切替セグメントが代わり）
    let lead: ((host: HTMLElement) => void) | undefined = narrowPanel ? undefined : toggleButton;
    if (showTasks) {
      const sec = this.renderSection(body, {
        title: "Inbox・時刻なし",
        count: waiting,
        overdue,
        collapsed: s.sidebarTasksCollapsed,
        tip: "日付や時刻を決めていないタスク。タイムラインへドラッグで予定に",
        onToggle: () => {
          s.sidebarTasksCollapsed = !s.sidebarTasksCollapsed;
          void this.plugin.persistSettings();
          this.renderInbox();
        },
        lead,
        actions: (host) => {
          this.iconButton(host, "plus", "タスクを追加（日付未定 / 時刻なし）", () => this.openWaitingAddModal());
          if (showInbox) {
            this.iconButton(host, "file-text", "Inbox のノートを開く", () =>
              void inbox?.ensureFile(INBOX_DATE).then((f) => this.app.workspace.getLeaf("tab").openFile(f))
            );
          }
        },
      });
      if (sec) this.renderTaskList(sec, reschedule, inboxTasks);
      lead = undefined;
    }
    if (showProjects) {
      const sec = this.renderSection(body, {
        title: "プロジェクト",
        count: activeProjects.length,
        collapsed: s.sidebarProjectsCollapsed,
        tip: "進行中のプロジェクト。⋮ から新規作成・展開・完了済みの表示切替",
        onToggle: () => {
          s.sidebarProjectsCollapsed = !s.sidebarProjectsCollapsed;
          void this.plugin.persistSettings();
          this.renderInbox();
        },
        lead,
        actions: (host) => {
          this.menuButton(host, "プロジェクトのメニュー", (menu) =>
            this.buildProjectsMenu(menu, activeProjects)
          );
        },
      });
      if (sec) this.renderProjects(sec, activeProjects);
      lead = undefined;
    }
    if (lead) {
      // サマリーだけのとき: 畳むボタンと「今日のノートを開く」だけの見出し
      const head = body.createDiv("dt-section-head is-plain");
      const leadEl = head.createSpan("dt-section-lead");
      lead(leadEl);
      head.createSpan({ cls: "dt-section-title", text: "本日のサマリー" });
      const actions = head.createDiv("dt-section-actions");
      this.iconButton(actions, "file-text", "今日のノートを開く", () => void this.openNote(today));
    }
    if (showSummary) {
      this.summaryEl = this.inboxEl.createDiv("dt-summary");
      this.renderSummary();
    }
  }

  /** パネルのセクション（見出し + 中身）。見出しのクリックで畳む。中身の器を返す（畳んでいれば null） */
  renderSection(
    this: DayTimelineView,
    parent: HTMLElement,
    o: {
      title: string;
      count: number;
      /** 過去に取り残しがある（件数に赤い点を付ける） */
      overdue?: boolean;
      collapsed: boolean;
      tip: string;
      onToggle: () => void;
      /** 見出しの左端に置くもの（パネルを畳むボタン） */
      lead?: (host: HTMLElement) => void;
      /** 見出しの右端の操作ボタン */
      actions?: (host: HTMLElement) => void;
    }
  ): HTMLElement | null {
    const sec = parent.createDiv("dt-section");
    sec.toggleClass("is-collapsed", o.collapsed);
    const head = sec.createDiv({
      cls: "dt-section-head",
      attr: { role: "button", "aria-expanded": String(!o.collapsed) },
    });
    // 見出しの中のボタンのクリックは開閉に使わない
    const stop = (el: HTMLElement) => {
      el.addEventListener("click", (e) => e.stopPropagation());
      el.addEventListener("pointerdown", (e) => e.stopPropagation());
    };
    if (o.lead) {
      const leadEl = head.createSpan("dt-section-lead");
      stop(leadEl);
      o.lead(leadEl);
    }
    const chevron = head.createSpan("dt-section-chevron");
    setIcon(chevron, o.collapsed ? "chevron-right" : "chevron-down");
    head.createSpan({ cls: "dt-section-title", text: o.title });
    const count = head.createSpan({ cls: "dt-inbox-count", text: String(o.count) });
    count.toggleClass("has-overdue", !!o.overdue);
    head.setAttr(
      "aria-label",
      [
        `${o.title}: ${o.count} 件`,
        o.overdue ? "過去に取り残された時刻なしタスクがあります" : "",
        o.tip,
        o.collapsed ? "クリックで開く" : "クリックで畳む",
      ]
        .filter(Boolean)
        .join("\n")
    );
    head.addEventListener("click", () => o.onToggle());
    if (o.actions) {
      const actions = head.createDiv("dt-section-actions");
      stop(actions);
      o.actions(actions);
    }
    if (o.collapsed) return null;
    return sec.createDiv("dt-section-body");
  }

  /**
   * 「Inbox・時刻なし」の一覧。過去に取り残した時刻なし（赤い日付）→ 表示中の日の時刻なし（日付）→
   * 日付未定（Inbox。「未定」）の順に 1 行 1 タスクで並べる。
   * 旧・タイムライン上部の「未スケジュール」トレイと、Inbox / 再スケジュールのタブの置き換え
   */
  renderTaskList(
    this: DayTimelineView,
    parent: HTMLElement,
    groups: { date: Date; tasks: Task[] }[],
    inboxTasks: Task[]
  ): void {
    const list = parent.createDiv("dt-inbox-list");
    const today = startOfDay(new Date());
    if (!groups.length && !inboxTasks.length) {
      list.createSpan({
        cls: "dt-tray-empty",
        text: "日付や時刻を決めていないタスクがここに並びます。＋ で追加、タイムラインへドラッグで予定に。",
      });
      return;
    }
    const chipBase = (t: Task, undated: boolean) => {
      const chip = list.createDiv("dt-tray-chip dt-inbox-chip");
      chip.toggleClass("is-undated", undated);
      chip.toggleClass("is-done", t.done);
      const color = this.taskColor(t);
      if (color) {
        const dot = chip.createSpan("dt-tray-color");
        dot.style.background = color;
      }
      const box = chip.createDiv("dt-tray-check");
      setIcon(box, iconName(t.done ? "check-square" : "square"));
      return { chip, box };
    };
    for (const g of groups) {
      for (const t of g.tasks) {
        const { chip, box } = chipBase(t, false);
        box.addEventListener("click", (e) => {
          e.stopPropagation();
          void this.commitUpdate(g.date, t, { ...this.draftOf(t), done: !t.done });
        });
        const dateEl = chip.createSpan({
          cls: "dt-project-child-date is-unscheduled",
          text: `${g.date.getMonth() + 1}/${g.date.getDate()}`,
        });
        // 過去の取り残しは赤系で目立たせる
        if (g.date < today) dateEl.addClass("is-overdue");
        const owner = this.ownerName(t);
        if (owner) chip.createSpan({ cls: "dt-owner-label", text: owner });
        chip.createSpan({ cls: "dt-tray-title", text: this.displayTitle(t) });
        chip.setAttr(
          "aria-label",
          [
            t.title || "(無題)",
            `${moment(g.date).format("M月D日 (ddd)")}（時刻は未定）`,
            t.doneCondition ? `完了条件: ${t.doneCondition}` : "",
            t.preview,
            "タイムラインへドラッグで時刻を割り当て。クリックで編集、右クリックでメニュー",
          ]
            .filter(Boolean)
            .join("\n")
        );
        this.attachTrayInteractions(chip, g.date, t);
      }
    }
    for (const t of inboxTasks) {
      const { chip, box } = chipBase(t, true);
      box.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.commitInboxUpdate(t, { ...this.draftOf(t), done: !t.done });
      });
      chip.createSpan({ cls: "dt-project-child-date is-undated", text: "未定" });
      chip.createSpan({ cls: "dt-tray-title", text: this.displayTitle(t) });
      if (t.project) {
        // プロジェクトがパネルに出ていない（完了済み・見つからない）ため Inbox に出ているタスク
        const link = t.project;
        const badge = chip.createSpan({ cls: "dt-inbox-project", text: projectDisplayName(link) });
        // クリックでノートを開く。Ctrl/Cmd + クリックならポップアップでプレビュー
        badge.addEventListener("pointerdown", (ev) => ev.stopPropagation());
        badge.addEventListener("click", (ev) => {
          ev.stopPropagation();
          if (ev.ctrlKey || ev.metaKey) this.showProjectPreview(badge, link, ev);
          else void this.plugin.openProject(link);
        });
      }
      chip.setAttr(
        "aria-label",
        [
          t.title || "(無題)",
          "日付未定（Inbox）",
          t.doneCondition ? `完了条件: ${t.doneCondition}` : "",
          t.preview,
          "タイムラインへドラッグでその日の予定に。クリックで編集、右クリックでメニュー",
        ]
          .filter(Boolean)
          .join("\n")
      );
      this.attachInboxInteractions(chip, t);
    }
  }

  /**
   * 「Inbox・時刻なし」の ＋ からのタスク追加。日付を空のまま保存すると日付未定（Inbox）、
   * 日付を選ぶとその日へ（時刻を空にすれば時刻なしのまま）。日付を選ばずに時刻だけ入れたら表示中の日へ
   */
  openWaitingAddModal(this: DayTimelineView): void {
    const inbox = this.plugin.inbox;
    if (!inbox) {
      this.openCreateModal(this.date, null, null);
      return;
    }
    const s = this.plugin.settings;
    const dayLabel = moment(this.date).format("M月D日");
    new TaskModal(this.app, {
      mode: "create",
      initial: { title: "", start: null, end: null, done: false },
      snapMinutes: s.snapMinutes,
      allowUnscheduled: true,
      dateLabel: "日付未定",
      dateField: {
        value: null,
        allowEmpty: true,
        hint: "空のままなら日付を決めずに Inbox に登録します",
      },
      unscheduledHint: `時刻なし — 日付を選べばその日の時刻なしのタスクに、空なら Inbox に入ります（時刻を入れると ${dayLabel} に登録）`,
      tagChoices: s.tagColors,
      reminderDefault: s.reminderDefaultMinutes,
      trackers: s.trackers,
      ...this.projectOptions(),
      onSubmit: async (data, dateSel) => {
        // 日付を選んだらその日へ。選ばずに時刻だけ入れたら表示中の日へ
        const to = dateSel ?? (data.start !== null && data.end !== null ? this.date : null);
        if (to) {
          await this.commitCreate(to, data);
          return;
        }
        try {
          await inbox.create(INBOX_DATE, { ...data, start: null, end: null });
          new Notice("Inbox に追加しました");
        } catch (e) {
          console.error(e);
          new Notice("Inbox に追加できませんでした: " + errorText(e));
        }
        await this.reloadInbox();
      },
    }).open();
  }

  /**
   * サイドバーの幅の上限。タイムラインが潰れないようビュー幅の6割までとしつつ、
   * デスクトップなど広い画面では最大 800px まで広げられる（狭い画面でも従来の 480px は保証）
   */
  maxSidebarWidth(this: DayTimelineView): number {
    const w = this.contentEl.clientWidth;
    if (!w) return SIDEBAR_MAX_WIDTH;
    return clamp(Math.round(w * 0.6), 480, SIDEBAR_MAX_WIDTH);
  }

  /** サイドバーの幅を反映する（null なら CSS の既定 = 畳んだ状態に任せる） */
  applySidebarWidth(this: DayTimelineView, width: number | null): void {
    if (width === null) {
      this.inboxEl.style.width = "";
      this.inboxEl.style.flexBasis = "";
      return;
    }
    const w = clamp(width, SIDEBAR_MIN_WIDTH, this.maxSidebarWidth());
    this.inboxEl.style.width = w + "px";
    this.inboxEl.style.flexBasis = w + "px";
  }

  /** サイドバーの右端をドラッグして幅を変えるハンドル */
  attachSidebarResize(this: DayTimelineView): void {
    const grip = this.inboxEl.createDiv({
      cls: "dt-sidebar-resize",
      attr: { "aria-label": "ドラッグで幅を変更" },
    });
    grip.addEventListener("pointerdown", (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const startW = this.inboxEl.getBoundingClientRect().width;
      const startX = e.clientX;
      const maxW = this.maxSidebarWidth();
      let w = startW;
      this.startDrag(grip, e, {
        onMove: (_dy, ev) => {
          w = clamp(startW + (ev.clientX - startX), SIDEBAR_MIN_WIDTH, maxW);
          this.applySidebarWidth(w);
        },
        onEnd: (moved) => {
          if (!moved) return;
          this.plugin.settings.sidebarWidth = Math.round(w);
          void this.plugin.persistSettings();
        },
        onCancel: () => this.applySidebarWidth(this.plugin.settings.sidebarWidth),
      });
    });
  }

  /** 進行中のプロジェクトがすべて展開されているか */
  areAllProjectsExpanded(this: DayTimelineView): boolean {
    const active = this.projectData.filter((s) => !s.done);
    return active.length > 0 && active.every((s) => this.expandedProjects.has(s.ref.linktext));
  }

  /** プロジェクトのツリーをまとめて展開 / 閉じる（パネルのボタン・コマンドから） */
  setAllProjectsExpanded(this: DayTimelineView, expand: boolean): void {
    if (expand) {
      for (const s of this.projectData) {
        if (!s.done) this.expandedProjects.add(s.ref.linktext);
      }
      // 畳んだグループの中のプロジェクトも見えるように、グループも開く
      this.collapsedGroups.clear();
    } else {
      this.expandedProjects.clear();
    }
    this.renderInbox();
  }

  /** すべて展開 ⇄ すべて閉じるを切り替える（コマンド用） */
  toggleAllProjects(this: DayTimelineView): void {
    this.setAllProjectsExpanded(!this.areAllProjectsExpanded());
  }

  setProjectsFilter(this: DayTimelineView, f: ProjectsFilter): void {
    if (this.plugin.settings.projectsFilter === f) return;
    this.plugin.settings.projectsFilter = f;
    void this.plugin.persistSettings();
    this.renderInbox();
  }

  /** そのプロジェクトに今日のタスク（自分・メンバー問わず）があるか。
   * 持ち越し済み [>] は別の日へ送った記録なので、今日のタスクには数えない */
  projectHasToday(this: DayTimelineView, sum: ProjectSummary): boolean {
    const today = startOfDay(new Date());
    return sum.children.some(
      (c) => c.date !== null && isSameDay(c.date, today) && !c.task.forwarded
    );
  }

  /** プロジェクトのパネルのヘッダー（⋮）から開くメニュー。active は進行中のプロジェクト */
  buildProjectsMenu(this: DayTimelineView, menu: MenuLike, active: ProjectSummary[]): void {
    menu.addItem((i) =>
      i
        .setTitle("新しいプロジェクトを作成…")
        .setIcon("plus")
        .onClick(() => this.plugin.openNewProjectModal())
    );
    if (active.length) {
      menu.addSeparator();
      const allExpanded = this.areAllProjectsExpanded();
      menu.addItem((i) =>
        i
          .setTitle(allExpanded ? "すべてのプロジェクトを閉じる" : "すべてのプロジェクトを展開")
          .setIcon(allExpanded ? "chevrons-down-up" : "chevrons-up-down")
          .onClick(() => this.setAllProjectsExpanded(!allExpanded))
      );
      const hideDone = this.plugin.settings.projectsHideDone;
      menu.addItem((i) =>
        i
          .setTitle(
            hideDone ? "完了済みの子タスクを表示する" : "完了済みの子タスクを隠す（持ち越し済みも）"
          )
          .setIcon(hideDone ? "eye-off" : "eye")
          .onClick(() => {
            this.plugin.settings.projectsHideDone = !hideDone;
            void this.plugin.persistSettings();
            this.renderInbox();
          })
      );
    }
    menu.addSeparator();
    menu.addItem((i) =>
      i
        .setTitle("全プロジェクトノートのタスク一覧を更新")
        .setIcon("file-text")
        .onClick(() => void this.plugin.updateAllProjectNotes())
    );
  }

  /** プロジェクトのセクションの中身（一覧・進捗・予実合計・子タスク）。完了済のプロジェクトは出さない。
   * ⋮（ケバブ）メニューはセクションの見出し側に出る */
  renderProjects(this: DayTimelineView, parent: HTMLElement, all: ProjectSummary[]): void {
    const hiddenDone = this.projectData.length - all.length;
    const wrap = parent.createDiv("dt-projects");
    // 絞り込みの切替（すべて / 本日タスクあり）。よく使うので ⋮ メニューではなく一覧の上に出す
    const filter = this.plugin.settings.projectsFilter;
    const todayOnes = all.filter((s) => this.projectHasToday(s));
    if (all.length) {
      const seg = wrap.createDiv("dt-projects-filter");
      seg.setAttr("role", "tablist");
      const chip = (id: ProjectsFilter, label: string, count: number, tip: string) => {
        const b = seg.createEl("button", { cls: "dt-projects-filter-chip", text: label });
        b.createSpan({ cls: "dt-projects-filter-count", text: String(count) });
        b.toggleClass("is-active", filter === id);
        b.setAttr("aria-pressed", String(filter === id));
        b.setAttr("aria-label", tip);
        b.addEventListener("click", () => this.setProjectsFilter(id));
      };
      chip("all", "すべて", all.length, "進行中のプロジェクトをすべて表示");
      chip("today", "本日", todayOnes.length, "今日のタスクがあるプロジェクトだけを表示（持ち越し済みは除く）");
    }
    const active = filter === "today" ? todayOnes : all;
    const list = wrap.createDiv("dt-projects-list");
    if (!active.length) {
      list.createSpan({
        cls: "dt-tray-empty",
        text: all.length
          ? "今日のタスクがあるプロジェクトはありません（「すべて」で全部を表示）。"
          : hiddenDone
            ? `進行中のプロジェクトはありません（完了済 ${hiddenDone} 件は非表示）。`
            : "上の ⋮ メニューの「新しいプロジェクトを作成」、またはタスクの編集ダイアログの「プロジェクト」欄から作成すると、ここに一覧されます。",
      });
      return;
    }
    const groups = groupProjects(
      active,
      this.plugin.settings.projectGroups.map((x) => x.name)
    );
    // どのプロジェクトにもグループが無ければ見出しなしの一覧
    const showGroupHeads = groups.some((g) => g.name !== null);
    if (!showGroupHeads) {
      for (const g of groups) {
        for (const sum of g.items) this.renderProjectRow(list, sum);
      }
      return;
    }
    const groupIcons = this.groupIconMap();
    for (const g of groups) {
      if (this.renderProjectGroupHead(list, g, groupIcons)) continue;
      const itemsEl = list.createDiv("dt-project-group-items");
      for (const sum of g.items) this.renderProjectRow(itemsEl, sum);
    }
  }

  /** グループの見出し行。開閉のクリックを設定し、畳まれているかを返す */
  renderProjectGroupHead(
    this: DayTimelineView,
    parent: HTMLElement,
    g: ProjectGroup,
    groupIcons: Map<string, string>
  ): boolean {
    const groupKey = g.name ?? "";
    const collapsed = this.collapsedGroups.has(groupKey);
    const groupHead = parent.createDiv("dt-project-group");
    const groupChev = groupHead.createDiv("dt-project-chevron");
    setIcon(groupChev, collapsed ? "chevron-right" : "chevron-down");
    // グループごとの指定があればそれ、無ければ既定のアイコン（未分類は常に既定）
    const custom = g.name !== null ? groupIcons.get(g.name) : undefined;
    const icon = custom ?? this.plugin.settings.defaultGroupIcon.trim();
    if (icon) {
      const iconEl = groupHead.createSpan("dt-project-group-icon");
      renderGroupIcon(iconEl, icon);
    }
    groupHead.createSpan({ cls: "dt-project-group-name", text: g.name ?? "未分類" });
    groupHead.createSpan({ cls: "dt-project-group-count", text: String(g.items.length) });
    groupHead.setAttr(
      "aria-label",
      `${g.name ?? "未分類"}: プロジェクト ${g.items.length} 件\nクリックでグループを開閉`
    );
    groupHead.addEventListener("click", () => {
      if (collapsed) this.collapsedGroups.delete(groupKey);
      else this.collapsedGroups.add(groupKey);
      this.renderInbox();
    });
    return collapsed;
  }

  /** プロジェクト1件分（行 + 展開時の子タスク一覧）をツリー表示のパネルへ描画する */
  renderProjectRow(this: DayTimelineView, container: HTMLElement, sum: ProjectSummary): void {
    const expanded = this.expandedProjects.has(sum.ref.linktext);

    const row = container.createDiv("dt-project-row");
    row.dataset.dtProject = sum.ref.linktext;
    const chev = row.createDiv("dt-project-chevron");
    setIcon(chev, expanded ? "chevron-down" : "chevron-right");
    const nameEl = row.createSpan({ cls: "dt-project-name", text: sum.ref.name });
    // 名前を Ctrl/Cmd + クリックするとプロジェクトノートをプレビュー表示
    this.attachProjectNamePreview(nameEl, sum.ref.linktext);
    const total = sum.children.length;
    // プロジェクト自身の期日・チケット（ノートの「- 期日: 」「- チケット: 」行）
    const fields = sum.fields;
    if (fields?.due) {
      const dueEl = row.createSpan({
        cls: "dt-project-due",
        text: `期日 ${this.projectDueLabel(fields)}`,
      });
      if (this.projectDueIsOverdue(fields)) dueEl.addClass("is-overdue");
    }
    if (fields?.ticket) this.renderProjectTicketBadge(row, fields.ticket);
    const stats = row.createSpan({ cls: "dt-project-stats" });
    // 予実の合計は行が見づらくなるため出さない（テーブル表示・プロジェクトノートのタスク一覧・予実レポートで見られる）
    stats.setText(total ? `${sum.doneCount}/${total}` : "タスクなし");
    if (total) stats.setAttr("aria-label", `予 ${hmm(sum.planMin)}・実 ${hmm(sum.actMin)}`);
    // 行のホバー時のツールチップは情報量が多すぎたため、いったん出さない
    // 操作（ノートを開く・タスクを追加・完了にする）は行のアイコンではなく右クリックメニューから
    this.attachProjectRowBehavior(row, chev, sum);

    if (!expanded) return;
    const childrenEl = container.createDiv("dt-project-children");
    // プロジェクトのドキュメント（ノートの「- ドキュメント: [[...]]」行）を子タスクの上に並べる
    if (fields?.docs.length) this.renderProjectDocs(childrenEl, sum, fields.docs);
    const shown = this.visibleProjectChildren(sum);
    if (!sum.children.length) {
      childrenEl.createSpan({ cls: "dt-tray-empty", text: "結びついたタスクはまだありません" });
    } else if (!shown.length) {
      childrenEl.createSpan({
        cls: "dt-tray-empty",
        text: `完了済み ${sum.children.length} 件を非表示`,
      });
    }
    for (const child of shown) {
      const t = child.task;
      const item = childrenEl.createDiv("dt-project-child");
      // 持ち越し先で完了した [>] も完了として見せる（引き継いだ先で終わった仕事）
      item.toggleClass("is-done", isChildSettled(child));
      this.renderChildCheckbox(item, child);
      this.renderChildDateBadge(item, child);
      item.createSpan({ cls: "dt-tray-title", text: this.displayTitle(t) });
      this.renderChildTagBadge(item, t);
      // 予定・実績の時間は行には出さない（ツリーが見づらくなるため）。ツールチップとテーブル表示で見られる
      this.attachProjectChildBehavior(item, child);
    }
  }

  /**
   * 子タスクのタグのバッジ（設定「タグの色」に登録されたタグだけ。サブタグがあればそちら）。
   * タイムラインの色と同じ色の枠と左の帯で、どの種類の作業かがパネルでも分かる
   */
  renderChildTagBadge(this: DayTimelineView, parent: HTMLElement, t: Task): void {
    const rules = this.plugin.settings.tagColors;
    const known = t.tags.filter((tag) => colorForTags([tag], rules));
    if (!known.length) return;
    // 最も深いタグ（#管理/質問 が付いていれば #管理 より優先）
    const tag = known.reduce((a, b) => (b.split("/").length > a.split("/").length ? b : a));
    const color = colorForTags([tag], rules) ?? "";
    const badge = parent.createSpan({ cls: "dt-project-child-tag", text: "#" + tag, attr: { title: "#" + tag } });
    badge.style.setProperty("--dt-chip-color", color);
  }

  /** プロジェクトの期日の表示文字列（日付として読めれば M/D、年が違えば YYYY/M/D、読めなければ書かれたまま） */
  projectDueLabel(this: DayTimelineView, fields: ProjectFields): string {
    return fields.dueDate
      ? moment(fields.dueDate).format(
          moment(fields.dueDate).year() === moment().year() ? "M/D" : "YYYY/M/D"
        )
      : fields.due;
  }

  /** プロジェクトの期日が過ぎているか */
  projectDueIsOverdue(this: DayTimelineView, fields: ProjectFields): boolean {
    return !!fields.dueDate && fields.dueDate.getTime() < startOfDay(new Date()).getTime();
  }

  /** プロジェクトのチケットバッジ（クリックでブラウザで開く） */
  renderProjectTicketBadge(this: DayTimelineView, parent: HTMLElement, t: TicketRef): void {
    const badge = parent.createSpan({ cls: "dt-project-ticket", text: `#${t.id}` });
    const url = ticketUrl(this.plugin.settings.trackers, t.tracker, t.id);
    badge.setAttr("aria-label", `${t.tracker || "チケット"} #${t.id}` + (url ? `\n${url}` : ""));
    if (url) {
      badge.addClass("is-linked");
      badge.addEventListener("pointerdown", (ev) => ev.stopPropagation());
      badge.addEventListener("click", (ev) => {
        ev.stopPropagation();
        window.open(url);
      });
    }
  }

  /** プロジェクトを完了にする（右クリックメニューから。未完了のタスクが残っていれば確認する）。パネルから消える */
  completeProject(this: DayTimelineView, sum: ProjectSummary): void {
    const projects = this.plugin.projects;
    if (!projects) return;
    const key = sum.ref.linktext;
    const run = async () => {
      const ok = await projects.setDone(key, true);
      if (!ok) {
        new Notice("プロジェクトを完了にできませんでした（ノートが開けるか確認してください）");
        return;
      }
      sum.done = true; // すぐパネルから消す（次の再読み込みでも isDone が同じ判定を返す）
      new Notice(`プロジェクト「${sum.ref.name}」を完了にしました。ノート先頭のチェックを外すと戻せます`);
      this.renderInbox();
    };
    const open = sum.children.filter((c) => !c.task.done && !c.task.forwarded).length;
    if (open) {
      new ConfirmModal(
        this.app,
        `「${sum.ref.name}」には未完了のタスクが ${open} 件あります。プロジェクトを完了にしますか？（タスクはそのまま残ります）`,
        "完了にする",
        run
      ).open();
    } else {
      void run();
    }
  }

  /** プロジェクト行のふるまい（クリックで展開・ドラッグで子タスク作成・右クリックメニュー）。ツリー・テーブル共通 */
  attachProjectRowBehavior(this: DayTimelineView, row: HTMLElement, chev: HTMLElement, sum: ProjectSummary): void {
    const key = sum.ref.linktext;
    const toggleExpand = () => {
      if (this.expandedProjects.has(key)) this.expandedProjects.delete(key);
      else this.expandedProjects.add(key);
      this.renderInbox();
    };
    chev.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleExpand();
    });
    this.attachProjectDrag(row, sum, toggleExpand);
    row.addEventListener("contextmenu", (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.touchDragging) return;
      this.showProjectMenu(sum, e);
    });
  }

  /** プロジェクトのドキュメントのチップを並べる。ツリー・テーブル共通 */
  renderProjectDocs(this: DayTimelineView, parent: HTMLElement, sum: ProjectSummary, docs: ProjectDoc[]): void {
    const docsEl = parent.createDiv("dt-project-docs");
    for (const doc of docs) {
      const chip = docsEl.createDiv("dt-project-doc");
      const iconEl = chip.createSpan("dt-project-doc-icon");
      setIcon(iconEl, doc.external ? "external-link" : "file-text");
      chip.createSpan({ cls: "dt-project-doc-label", text: doc.label });
      chip.setAttr("aria-label", `ドキュメント: ${doc.target}\nクリックで開く`);
      chip.addEventListener("click", (e) => {
        e.stopPropagation();
        this.openProjectDoc(sum, doc);
      });
    }
  }

  /** 展開時に見せる子タスク。「完了済みを隠す」がオンなら、完了・持ち越し済み [>]（＝片付いた記録）を出さない */
  visibleProjectChildren(this: DayTimelineView, sum: ProjectSummary): ProjectChild[] {
    const s = this.plugin.settings;
    return sum.children.filter(
      (c) =>
        (!s.projectsHideDone || (!c.task.done && !c.task.forwarded)) &&
        // 「本日」の絞り込み中は持ち越し済み [>]（別の日へ送った記録）を出さない
        (s.projectsFilter !== "today" || !c.task.forwarded)
    );
  }

  /** 子タスクの完了チェックボックス。ツリー・テーブル共通 */
  renderChildCheckbox(this: DayTimelineView, parent: HTMLElement, child: ProjectChild): void {
    const t = child.task;
    const box = parent.createDiv("dt-tray-check");
    if (child.settledByCarry) {
      // 持ち越し先で完了した [>]: チェック済みに見せるが、このブロック自体は「引き継いだ記録」なので
      // ここからは切り替えない（外すなら持ち越し先のほうを未完了に戻す）
      setIcon(box, iconName("check-square"));
      box.addClass("is-settled-by-carry");
      box.setAttr("aria-label", "持ち越し先で完了しています（このブロックは引き継ぎ前の記録）");
      box.addEventListener("click", (e) => {
        e.stopPropagation();
        new Notice("持ち越し先のタスクで完了しています。戻すときは持ち越し先のほうを未完了にしてください");
      });
      return;
    }
    setIcon(box, iconName(t.done ? "check-square" : "square"));
    box.addEventListener("click", (e) => {
      e.stopPropagation();
      if (child.date === null) void this.commitInboxUpdate(t, { ...this.draftOf(t), done: !t.done });
      else void this.commitUpdate(child.date, t, { ...this.draftOf(t), done: !t.done });
    });
  }

  /**
   * 子タスクの日付バッジ。今日のタスクは「本日」、日付未定は「未定」のバッジにする。
   * 日時が決まっていないものは枠付きのバッジで見分ける（日付ごと未定はアクセント色・時刻未定はオレンジ）
   */
  renderChildDateBadge(this: DayTimelineView, parent: HTMLElement, child: ProjectChild): void {
    const t = child.task;
    const today = !!child.date && isToday(child.date);
    const dateEl = parent.createSpan({
      cls: "dt-project-child-date",
      text: child.date
        ? today
          ? "本日"
          : `${child.date.getMonth() + 1}/${child.date.getDate()}`
        : "未定",
    });
    const scheduled = t.start !== null && t.end !== null;
    if (child.date === null) dateEl.addClass("is-undated");
    // 時刻未定（＝遅れ）は今日でもオレンジのまま。持ち越し済み [>] は閉じた記録なので「遅れ」扱いにしない
    else if (!scheduled && !t.forwarded) dateEl.addClass("is-unscheduled");
    else if (today) dateEl.addClass("is-today");
  }

  /** 子タスク行のふるまい（ツールチップ・ドラッグ・クリック・右クリックメニュー）。ツリー・テーブル共通 */
  attachProjectChildBehavior(this: DayTimelineView, item: HTMLElement, child: ProjectChild): void {
    const t = child.task;
    const scheduled = t.start !== null && t.end !== null;
    const plan = scheduled ? t.end! - t.start! : 0;
    const act = t.actual.reduce((n, r) => n + (r.end - r.start), 0);
    const sp = stepProgress(t);
    item.setAttr(
      "aria-label",
      `${t.title || "(無題)"}\n` +
        (child.date
          ? moment(child.date).format("M月D日 (ddd)") +
            (scheduled ? ` ${minutesToHHMM(t.start!)} - ${minutesToHHMM(t.end!)}` : "（時刻は未定）")
          : "日付は未定") +
        (plan || act ? `\n実績 ${act ? hmm(act) : "–"} / 予定 ${plan ? hmm(plan) : "–"}` : "") +
        (sp ? `\nステップ ${sp.done}/${sp.total}（${Math.round(sp.ratio * 100)}%）` : "") +
        (child.settledByCarry
          ? "\n持ち越し先で完了（このブロックは引き継ぎ前の記録）"
          : t.forwarded
            ? "\n持ち越し済み（続きは持ち越し先のブロック）"
            : "") +
        (child.date
          ? "\nクリックでその日へ移動、タイムラインへドラッグで時刻を割り当て、右クリックでメニュー"
          : "\nクリックで編集、タイムラインへドラッグで日時を割り当て、右クリックでメニュー")
    );
    if (child.date === null) {
      // 日付未定: タイムラインへドラッグで日時を割り当て、クリックで編集できるようにする
      this.attachChipDrag(
        item,
        ".dt-tray-check",
        () => this.displayTitle(t),
        (date, start, end) =>
          void this.commitInboxToDay(t, date, { ...this.draftOf(t), start, end }),
        () => this.openInboxEditModal(t)
      );
      item.addEventListener("contextmenu", (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (this.touchDragging) return;
        this.showInboxTaskMenu(t, e);
      });
    } else {
      const childDate = child.date;
      // 選択中のタスクの行には印を付ける（パネルを描き直しても残る）
      item.toggleClass("is-selected", this.taskElKey(childDate, t) === this.selectedTaskKey);
      this.attachChipDrag(
        item,
        ".dt-tray-check",
        () => this.displayTitle(t),
        (date, start, end) => {
          const draft = { ...this.draftOf(t), start, end };
          if (isSameDay(date, childDate)) void this.commitUpdate(childDate, t, draft);
          else void this.commitMove(childDate, t, date, draft);
        },
        () => {
          // その日へ移動し、タイムラインの対応するブロックを強調して画面内へスクロールする。
          // 表示範囲の外の日なら読み込みを待って reload の最後で反映する
          this.selectTask(childDate, t, item);
          this.setDate(childDate);
          // 狭い画面では移動した先が見えるよう、タイムラインへ切り替える
          if (this.isNarrow) this.setNarrowPane("timeline");
          this.revealSelectedTask();
        }
      );
      item.addEventListener("contextmenu", (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (this.touchDragging) return;
        this.showTaskMenu(childDate, t, e);
      });
    }
  }

  /** 設定にあるグループのアイコン（グループ名 → アイコン。未設定・空は含めない） */
  groupIconMap(this: DayTimelineView): Map<string, string> {
    const out = new Map<string, string>();
    for (const g of this.plugin.settings.projectGroups) {
      const name = g.name.trim();
      const icon = g.icon.trim();
      if (name && icon && !out.has(name)) out.set(name, icon);
    }
    return out;
  }

  /** プロジェクトのドキュメントを開く（Wikilink はノート・外部 URL はブラウザ） */
  openProjectDoc(this: DayTimelineView, sum: ProjectSummary, doc: ProjectDoc): void {
    if (doc.external) {
      window.open(doc.target);
      return;
    }
    void this.app.workspace.openLinkText(doc.target, sum.ref.linktext + ".md", false).catch((e) => {
      console.error(e);
      new Notice("ドキュメントを開けませんでした: " + String(e));
    });
  }

  /** プロジェクト行の右クリックメニュー（ノートを開く・タスクを追加・チケット・ドキュメント・グループの付け替え・完了にする） */
  showProjectMenu(this: DayTimelineView, sum: ProjectSummary, e: MouseEvent): void {
    if (!this.plugin.projects) return;
    const key = sum.ref.linktext;
    const menu = new Menu();
    // 行に操作アイコンは出さず、ここにまとめる（Ctrl/Cmd + クリックのプレビューは名前側）
    menu.addItem((i) =>
      i.setTitle("プロジェクトノートを開く").setIcon("arrow-up-right").onClick(() => void this.plugin.openProject(key))
    );
    menu.addItem((i) =>
      i
        .setTitle("このプロジェクトのタスクを追加")
        .setIcon("plus")
        .onClick(() => this.openProjectCreateModal(key))
    );
    menu.addSeparator();
    // プロジェクト自身のチケット・ドキュメント
    const fields = sum.fields;
    let hasExtras = false;
    if (fields?.ticket) {
      const t = fields.ticket;
      const url = ticketUrl(this.plugin.settings.trackers, t.tracker, t.id);
      if (url) {
        menu.addItem((i) =>
          i.setTitle(`チケット #${t.id} を開く`).setIcon("ticket").onClick(() => window.open(url))
        );
        hasExtras = true;
      }
    }
    for (const doc of fields?.docs ?? []) {
      menu.addItem((i) =>
        i
          .setTitle(`ドキュメント「${doc.label}」を開く`)
          .setIcon(doc.external ? "external-link" : "file-text")
          .onClick(() => this.openProjectDoc(sum, doc))
      );
      hasExtras = true;
    }
    if (hasExtras) menu.addSeparator();
    const current = sum.ref.group ?? null;
    // 完了済みプロジェクトだけが使っているグループへも移せるよう、候補は全プロジェクトから集める
    const names = knownGroupNames(
      this.projectData.map((s) => s.ref),
      this.plugin.settings.projectGroups.map((x) => x.name)
    );
    const groupIcons = this.groupIconMap();
    for (const groupName of names) {
      menu.addItem((i) => {
        // アイコンが Lucide 名ならメニューのアイコン欄に、絵文字などはタイトルの頭に出す
        // （現在のグループは ✓ を優先）
        const icon = groupIcons.get(groupName);
        const asText = icon && !getIcon(icon) ? icon + " " : "";
        i.setTitle(`グループ: ${asText}${groupName}`).onClick(() => void this.setProjectGroup(sum, groupName));
        if (groupName === current) i.setIcon("check");
        else if (icon && !asText) i.setIcon(icon);
      });
    }
    if (names.length) menu.addSeparator();
    menu.addItem((i) =>
      i
        .setTitle("新しいグループへ…")
        .setIcon("folder-plus")
        .onClick(() =>
          new PromptModal(this.app, {
            title: `「${sum.ref.name}」のグループ`,
            placeholder: "グループ名（例: 仕事）",
            cta: "移動",
            onSubmit: (groupName) => void this.setProjectGroup(sum, groupName),
          }).open()
        )
    );
    if (current) {
      menu.addItem((i) =>
        i.setTitle("グループを外す").setIcon("x").onClick(() => void this.setProjectGroup(sum, null))
      );
    }
    menu.addSeparator();
    menu.addItem((i) =>
      i.setTitle("プロジェクトを完了にする").setIcon("check-circle-2").onClick(() => this.completeProject(sum))
    );
    menu.showAtMouseEvent(e);
  }

  /** プロジェクトのグループを付け替えて、パネルへ即反映する */
  async setProjectGroup(this: DayTimelineView, sum: ProjectSummary, group: string | null): Promise<void> {
    const projects = this.plugin.projects;
    if (!projects) return;
    const g = group?.trim() || null;
    if (g === (sum.ref.group ?? null)) return;
    const ok = await projects.setGroup(sum.ref.linktext, g);
    if (!ok) {
      new Notice("グループを変更できませんでした（ノートが開けるか確認してください）");
      return;
    }
    sum.ref.group = g; // メタデータキャッシュの反映を待たずに表示へ
    this.renderInbox();
  }

  /** プロジェクト行: クリックで展開、タイムラインへドラッグで子タスクを作成 */
  attachProjectDrag(this: DayTimelineView, row: HTMLElement, sum: ProjectSummary, onClick: () => void): void {
    this.attachChipDrag(
      row,
      ".dt-icon-btn, .dt-project-chevron",
      () => `${sum.ref.name} の新しいタスク`,
      (date, start, end) =>
        this.openCreateModal(date, start, end, undefined, { project: sum.ref.linktext }),
      onClick
    );
  }

  /** 「Inbox・時刻なし」の一覧に出す時刻なしタスク: 表示中の日の時刻を決めていないタスクに加えて、
   * 表示範囲の外（過去 RESCHEDULE_LOOKBACK_DAYS 日以内）に取り残された時刻なしタスク。
   * 週をまたいでも取り残しが消えないようにする。いずれも日付順 */
  rescheduleGroups(this: DayTimelineView): { date: Date; tasks: Task[] }[] {
    const s = this.plugin.settings;
    if (!s.showUnscheduledTray) return [];
    const visible = this.columns
      .map((c) => ({ date: c.date, tasks: this.dataFor(c.date).tasks.filter((t) => !isScheduled(t)) }))
      .filter((g) => g.tasks.length > 0);
    // 過去の取り残しを先頭に（古い日付から）。表示中の日は visible 側にだけ出る
    return [...this.pastUnscheduled, ...visible];
  }

  /** 表示範囲の外の過去のノートを読む必要があるか（「Inbox・時刻なし」の一覧の取り残し・本日のサマリー） */
  needsPastDays(this: DayTimelineView): boolean {
    const s = this.plugin.settings;
    if (!this.plugin.blockStore()) return false;
    return s.showUnscheduledTray || s.showTodaySummary;
  }

  /**
   * 表示範囲の外のノートを読む（「Inbox・時刻なし」の一覧の取り残し・本日のサマリー用）。
   * 今日から過去 RESCHEDULE_LOOKBACK_DAYS 日のノートを見る。表示中の日は通常の
   * 読み込みが拾うので除外。古い日付から順に入る
   */
  async loadPastDays(this: DayTimelineView): Promise<Map<string, { date: Date; tasks: Task[] }>> {
    const out = new Map<string, { date: Date; tasks: Task[] }>();
    const store = this.plugin.blockStore();
    if (!store || !this.needsPastDays()) return out;
    const visible = new Set(this.visibleDays().map(dateKey));
    const today = startOfDay(new Date());
    for (let i = RESCHEDULE_LOOKBACK_DAYS; i >= 0; i--) {
      const date = addDays(today, -i);
      const key = dateKey(date);
      if (visible.has(key)) continue;
      if (!store.getFile(date)) continue; // ノートの無い日は読まない
      try {
        out.set(key, { date, tasks: (await store.load(date)).tasks });
      } catch (e) {
        console.error(e);
      }
    }
    return out;
  }

  /** 表示範囲の外に取り残された時刻なしタスク（「Inbox・時刻なし」の一覧用）。
   * 完了・持ち越し済み [>] は「片付いた」ものなので出さない */
  pastUnscheduledFrom(
    this: DayTimelineView,
    past: Map<string, { date: Date; tasks: Task[] }>
  ): { date: Date; tasks: Task[] }[] {
    const s = this.plugin.settings;
    if (!s.showUnscheduledTray) return [];
    const out: { date: Date; tasks: Task[] }[] = [];
    for (const { date, tasks: all } of past.values()) {
      const tasks = all.filter((t) => !isScheduled(t) && !t.done && !t.forwarded);
      if (tasks.length) out.push({ date, tasks });
    }
    return out;
  }

  // ---------- 本日のサマリー（サイドバーの下） ----------

  /** その日のタスク。表示範囲内なら読み込み済みのデータ、範囲外なら過去のノートのキャッシュから。
   * どちらにも無い（ノートが無い・過去 30 日より前で読んでいない）なら null */
  tasksOn(this: DayTimelineView, date: Date): Task[] | null {
    const key = dateKey(date);
    const d = this.data.get(key);
    if (d) return d.tasks;
    return this.pastDays.get(key)?.tasks ?? null;
  }

  /**
   * サイドバーの下の「本日のサマリー」。renderInbox で器（summaryEl）を作り、
   * 30 秒ごとの更新と計測の開始・終了（renderTracking）でも描き直す。
   * 見出しのクリックで1行に畳める（記憶される）
   */
  renderSummary(this: DayTimelineView): void {
    const el = this.summaryEl;
    if (!el) return;
    el.empty();
    const s = this.plugin.settings;
    const today = startOfDay(new Date());
    const all = this.tasksOn(today) ?? [];
    const st = dayStats(all);
    // ステップの消化（今日の自分のタスクに書かれた「- [ ] …」の合計）。タスク数だけだと
    // 「1タスクの中でどこまで進んだか」が見えないので、タスクと並べて出す
    const steps = stepStats(all);
    const collapsed = s.summaryCollapsed;
    const complete = st.total > 0 && st.done === st.total;
    el.toggleClass("is-collapsed", collapsed);
    el.toggleClass("is-complete", complete);

    // 見出し: 「本日 9/2 (水)」。右端は達成の一言（畳んだときは数字だけ）
    const head = el.createDiv("dt-summary-head");
    head.setAttr("aria-label", collapsed ? "クリックで開く" : "クリックで畳む");
    head.createSpan({ cls: "dt-summary-title", text: "本日" });
    head.createSpan({
      cls: "dt-summary-date",
      text: `${today.getMonth() + 1}/${today.getDate()} (${WEEKDAY_JA[today.getDay()]})`,
    });
    const pct = st.ratio === null ? 0 : Math.round(st.ratio * 100);
    head.createSpan({
      cls: "dt-summary-brief",
      text: collapsed
        ? st.total
          ? `タスク ${st.done}/${st.total}` +
            (steps.total ? ` · ステップ ${steps.done}/${steps.total}` : "") +
            `・${pct}%`
          : "タスクなし"
        : summaryMessage(st),
    });
    const chevron = head.createSpan("dt-summary-chevron");
    setIcon(chevron, collapsed ? "chevron-up" : "chevron-down");
    head.addEventListener("click", () => {
      s.summaryCollapsed = !s.summaryCollapsed;
      void this.plugin.persistSettings();
      this.renderSummary();
    });
    if (collapsed) return;

    const body = el.createDiv("dt-summary-body");
    if (!st.total) {
      body.createDiv({
        cls: "dt-summary-empty",
        text: "今日のタスクはまだありません。タイムラインの空き時間をクリックすると追加できます",
      });
    } else {
      // 件数と時間の2本のメーター。件数だけだと短いタスクを片付けたくなるので、
      // 予定時間ベース（完了したタスクの予定時間 / 今日の予定時間）も並べる。
      // バーはタスクごとに区切る（件数は等分、時間は予定の長さに比例）ので、1つのタスクの大きさが見える
      const mine = all.filter((t) => !t.owner).sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity));
      const own = mine.filter((t) => !t.forwarded);
      const segTip = (t: Task) =>
        [
          this.displayTitle(t),
          (isScheduled(t) ? `${minutesToHHMM(t.start)} - ${minutesToHHMM(t.end)}（${hmm(t.end - t.start)}）` : "時刻未定") +
            (t.done ? " · 完了" : ""),
        ].join("\n");
      this.summaryMeter(
        body,
        "タスク",
        own.map((t) => ({ weight: 1, done: t.done, tip: segTip(t) })),
        `${st.done}/${st.total}`,
        `完了 ${st.done} タスク / 全 ${st.total} タスク（持ち越し済み [>] のタスクは数えません）`
      );
      if (steps.total > 0) {
        // ステップ: タスクをまたいで1ステップ = 1区切り。区切りにマウスを乗せると「タスク名 / ステップ」
        //（持ち越し済み [>] のタスクはチェック済みのステップだけ。stepStats と同じ数え方）
        this.summaryMeter(
          body,
          "ステップ",
          mine.flatMap((t) =>
            countedSteps(t).map((sp) => ({
              weight: 1,
              done: sp.done,
              tip: `${this.displayTitle(t)}\n${sp.text}${sp.done ? " · 完了" : ""}`,
            }))
          ),
          `${steps.done}/${steps.total}`,
          `チェック済み ${steps.done} ステップ / 全 ${steps.total} ステップ（今日のタスクに書いた「- [ ] …」の合計。持ち越し済み [>] はチェック済みだけ）`
        );
      }
      if (st.plan > 0) {
        this.summaryMeter(
          body,
          "時間",
          own.filter(isScheduled).map((t) => ({ weight: t.end - t.start, done: t.done, tip: segTip(t) })),
          `${hmm(st.donePlan)}/${hmm(st.plan)}`,
          `完了したタスクの予定時間 ${hmm(st.donePlan)} / 今日の予定時間の合計 ${hmm(st.plan)}`
        );
      }
      // 残量（件数・予定時間）と実績の合計。「%」より「あと 3 件・2:55」のほうが見通しが立つ
      const remain = st.total - st.done;
      const remainPlan = st.plan - st.donePlan;
      const parts: string[] = [];
      const remainSteps = steps.total - steps.done;
      if (remain > 0) parts.push(`あと ${remain} タスク` + (remainPlan > 0 ? `・${hmm(remainPlan)}` : ""));
      if (remainSteps > 0) parts.push(`ステップ あと ${remainSteps}`);
      if (st.actual > 0) parts.push(`実績 ${hmm(st.actual)}`);
      if (parts.length) {
        const line = body.createDiv({ cls: "dt-summary-line", text: parts.join("　") });
        line.setAttr(
          "aria-label",
          [
            remain > 0 ? `残り ${remain} タスク（予定時間 ${hmm(remainPlan)}）` : "",
            remainSteps > 0 ? `未チェックのステップ ${remainSteps} 件` : "",
            st.actual > 0 ? `今日の実績の合計 ${hmm(st.actual)}` : "",
          ]
            .filter(Boolean)
            .join("\n")
        );
      }
    }
    this.renderSummaryNext(body, today, all);
  }

  /**
   * サマリーのメーター1本（ラベル・バー・値・%）。
   * バーはタスクごとの区切り（縦線）入りで、幅は weight に比例（件数なら 1、時間なら予定の分）。
   * 完了したタスクを左に寄せて塗るので、塗りの境目が完了 / 未完了の境目と一致し、
   * 残りの区切りで「大きいタスクがいくつ残っているか」も見える。区切りにマウスを乗せるとそのタスク名
   */
  summaryMeter(
    this: DayTimelineView,
    parent: HTMLElement,
    label: string,
    segments: { weight: number; done: boolean; tip: string }[],
    value: string,
    tip: string
  ): void {
    const total = segments.reduce((n, sg) => n + sg.weight, 0);
    const done = segments.reduce((n, sg) => n + (sg.done ? sg.weight : 0), 0);
    const pct = total > 0 ? Math.round(clamp(done / total, 0, 1) * 100) : 0;
    const row = parent.createDiv("dt-summary-meter");
    row.setAttr("aria-label", tip);
    row.toggleClass("is-complete", total > 0 && pct >= 100);
    row.createSpan({ cls: "dt-summary-meter-label", text: label });
    const bar = row.createDiv("dt-summary-bar");
    const ordered = [...segments.filter((sg) => sg.done), ...segments.filter((sg) => !sg.done)];
    if (ordered.length <= MAX_SUMMARY_SEGMENTS) {
      for (const sg of ordered) {
        const seg = bar.createDiv("dt-summary-seg");
        seg.style.flexGrow = String(sg.weight);
        seg.toggleClass("is-done", sg.done);
        seg.setAttr("aria-label", sg.tip);
      }
    } else {
      // 区切りが多すぎると線だけになるので、1本の棒として塗る
      const fill = bar.createDiv("dt-summary-seg is-done is-plain");
      fill.style.flex = `0 0 ${pct}%`;
    }
    row.createSpan({ cls: "dt-summary-meter-value", text: value });
    row.createSpan({ cls: "dt-summary-meter-pct", text: `${pct}%` });
  }

  /**
   * 今日の未完了タスクから「いま取り組む1件」を選ぶ: 現在時刻にかかっているもの → これから始まるもの →
   * 時刻を過ぎて残っているもの → 時刻未定、の順
   */
  pickFocusTask(this: DayTimelineView, undone: Task[]): { task: Task; label: string; kind: string } | null {
    if (!undone.length) return null;
    const now = nowMinutes();
    const scheduled = undone.filter(isScheduled).sort((a, b) => a.start - b.start || a.end - b.end);
    const current = scheduled.find((t) => t.start <= now && now < t.end);
    const upcoming = scheduled.find((t) => t.start > now);
    if (current) return { task: current, label: "いま", kind: "now" };
    if (upcoming) return { task: upcoming, label: "次", kind: "next" };
    if (scheduled.length) return { task: scheduled[0], label: "未了", kind: "overdue" };
    return { task: undone[0], label: "未定", kind: "unscheduled" };
  }

  /**
   * 「いま / 次にやる1件」の行。現在時刻にかかっている未完了タスク → これから始まるタスク →
   * 予定の時刻を過ぎて残っているタスク → 時刻未定のタスク、の順で1件だけ出す。
   * チェックで完了、▶ で実績の計測を開始、クリックで編集、右クリックでメニュー
   */
  renderSummaryNext(this: DayTimelineView, parent: HTMLElement, today: Date, all: Task[]): void {
    const undone = all.filter((t) => !t.owner && !t.done && !t.forwarded);
    const pick = this.pickFocusTask(undone);
    if (!pick) return;
    const { task, label, kind } = pick;
    const t = task;
    const row = parent.createDiv("dt-summary-next");
    row.addClass(`is-${kind}`);
    const box = row.createDiv("dt-tray-check");
    setIcon(box, iconName("square"));
    box.setAttr("aria-label", "完了にする");
    box.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.commitUpdate(today, t, { ...this.draftOf(t), done: true });
    });
    row.createSpan({ cls: "dt-summary-next-label", text: label });
    if (isScheduled(t)) row.createSpan({ cls: "dt-summary-next-time", text: minutesToHHMM(t.start) });
    row.createSpan({ cls: "dt-summary-next-title", text: this.displayTitle(t) });
    if (isScheduled(t)) row.createSpan({ cls: "dt-summary-next-dur", text: hmm(t.end - t.start) });
    // ステップ: 「2/4」の小さなバーと、次にやる（最初の未チェックの）ステップ。タスク名だけだと
    // いま何をすればいいかが分からないので、タスクとステップの両方を出す
    const stepsOf = t.steps.filter((sp) => sp.text.trim());
    if (stepsOf.length) {
      const doneSteps = stepsOf.filter((sp) => sp.done).length;
      const nextStep = stepsOf.find((sp) => !sp.done);
      const line = row.createDiv("dt-summary-next-steps");
      const bar = line.createDiv("dt-summary-bar");
      const fill = bar.createDiv("dt-summary-seg is-done is-plain");
      fill.style.flex = `0 0 ${Math.round((doneSteps / stepsOf.length) * 100)}%`;
      line.createSpan({ cls: "dt-summary-next-steps-count", text: `ステップ ${doneSteps}/${stepsOf.length}` });
      if (nextStep) {
        line.createSpan({ cls: "dt-summary-next-steps-sep", text: "·" });
        line.createSpan({ cls: "dt-summary-next-steps-next", text: `次: ${nextStep.text}`, attr: { title: nextStep.text } });
      }
    }
    // 実績の計測（ストップウォッチ）の開始 / 終了。右クリックメニューと同じ操作
    if (this.plugin.blockStoreFor(t.owner)) {
      const tr = this.plugin.settings.tracking;
      const isTracking =
        !!tr && !!t.blockId && tr.blockId === t.blockId && (tr.owner ?? null) === (t.owner ?? null);
      const btn = this.iconButton(
        row,
        isTracking ? "stop-circle" : "play",
        isTracking ? "計測を終了して実績に記録" : "実績の計測を開始",
        () => {
          if (isTracking) void this.plugin.stopTaskTracking(true);
          else void this.plugin.startTaskTracking(today, t);
        }
      );
      btn.addClass("dt-summary-next-play");
      btn.toggleClass("is-tracking", isTracking);
      btn.addEventListener("click", (e) => e.stopPropagation());
    }
    const kindTip = {
      now: "いま取りかかる時間のタスク",
      next: "次に始まるタスク",
      overdue: "予定の時刻を過ぎて残っているタスク",
      unscheduled: "時刻を決めていないタスク",
    }[kind];
    row.setAttr(
      "aria-label",
      [
        t.title || "(無題)",
        isScheduled(t) ? `${minutesToHHMM(t.start)} - ${minutesToHHMM(t.end)}` : "",
        kindTip,
        stepsOf.length ? `ステップ ${stepsOf.filter((sp) => sp.done).length}/${stepsOf.length}` : "",
        t.doneCondition ? `完了条件: ${t.doneCondition}` : "",
        "クリックで編集、右クリックでメニュー",
      ]
        .filter(Boolean)
        .join("\n")
    );
    row.addEventListener("click", () => this.openEditModal(today, t));
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.showTaskMenu(today, t, e);
    });
  }
}
