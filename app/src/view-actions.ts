/**
 * タイムラインビューの保存操作: 追加・編集ダイアログ、完了・削除・移動・持ち越し・持ち主の変更、
 * Inbox との往復、右クリックメニュー。ノートへの書き込みはすべてここを通る。
 * DayTimelineView のミックスイン（view.ts の末尾で合成）。this はビュー自身
 */
import { Menu, Notice, moment, setIcon } from "obsidian";
import { Task, TaskDraft, isScheduled } from "./model";
import { ConfirmModal, TaskModal, formatActualRanges, type OtherActual } from "./modal";
import { subtractActualRanges, type ActualRange } from "./markdown/blocks";
import { projectDisplayName } from "./project";
import { newBlockId } from "./markdown/id";
import { noteRecurringDeletion, RecurringModal } from "./recurring";
import { BlockTaskStore, INBOX_DATE } from "./store";
import {
  addDays,
  clamp,
  dateKey,
  errorText,
  isSameDay,
  isToday,
  nowMinutes,
  startOfDay,
  stripTags,
} from "./util";
import type { DayTimelineView } from "./view";
import { TRANSFER_CONFLICT_MESSAGE, serialQueue } from "./view-shared";

export class ActionsMixin {
  /** 日付未定（Inbox のノートにある）タスクの右クリックメニュー（Inbox・プロジェクトパネル共通） */
  showInboxTaskMenu(this: DayTimelineView, task: Task, e: MouseEvent): void {
    const menu = new Menu();
    menu.addItem((i) => i.setTitle("編集").setIcon("pencil").onClick(() => this.openInboxEditModal(task)));
    menu.addItem((i) =>
      i
        .setTitle(task.done ? "未完了に戻す" : "完了にする")
        .setIcon("check")
        .onClick(() => void this.commitInboxUpdate(task, { ...this.draftOf(task), done: !task.done }))
    );
    menu.addItem((i) =>
      i
        .setTitle("今日へ送る（未スケジュール）")
        .setIcon("calendar")
        .onClick(() => void this.commitInboxToDay(task, startOfDay(new Date())))
    );
    if (this.mode === "day" && !isToday(this.date)) {
      menu.addItem((i) =>
        i
          .setTitle(`${moment(this.date).format("M月D日")} へ送る（未スケジュール）`)
          .setIcon("calendar")
          .onClick(() => void this.commitInboxToDay(task, this.date))
      );
    }
    menu.addItem((i) =>
      i.setTitle("ノートで開く").setIcon("file-text").onClick(() => void this.openInboxTaskInNote(task))
    );
    menu.addSeparator();
    menu.addItem((i) =>
      i.setTitle("削除").setIcon("trash").onClick(() => void this.commitInboxDelete(task))
    );
    menu.showAtMouseEvent(e);
  }

  /** タスクの右クリックメニュー（タイムライン・トレイ共通） */
  showTaskMenu(this: DayTimelineView, date: Date, task: Task, e: MouseEvent): void {
    const menu = new Menu();
    menu.addItem((i) =>
      i.setTitle("編集").setIcon("pencil").onClick(() => this.openEditModal(date, task))
    );
    menu.addItem((i) =>
      i
        .setTitle(task.done ? "未完了に戻す" : "完了にする")
        .setIcon("check")
        .onClick(() => void this.commitUpdate(date, task, { ...this.draftOf(task), done: !task.done }))
    );
    if (this.plugin.blockStoreFor(task.owner)) {
      const tr = this.plugin.settings.tracking;
      const isTracking =
        !!tr && !!task.blockId && tr.blockId === task.blockId && (tr.owner ?? null) === (task.owner ?? null);
      menu.addItem((i) =>
        isTracking
          ? i
              .setTitle("計測を終了して実績に記録")
              .setIcon("square")
              .onClick(() => void this.plugin.stopTaskTracking(true))
          : i
              .setTitle("実績の計測を開始")
              .setIcon("play")
              .onClick(() => void this.plugin.startTaskTracking(date, task))
      );
    }
    menu.addItem((i) =>
      i.setTitle("ノートで開く").setIcon("file-text").onClick(() => void this.openTaskInNote(date, task))
    );
    if (task.project && this.plugin.projects) {
      const link = task.project;
      menu.addItem((i) =>
        i
          .setTitle(`プロジェクト「${projectDisplayName(link)}」を開く`)
          .setIcon("arrow-up-right")
          .onClick(() => void this.plugin.openProject(link))
      );
    }
    {
      const url = this.ticketUrlOf(task);
      if (url && task.ticket) {
        menu.addItem((i) =>
          i
            .setTitle(`チケット #${task.ticket?.id} を開く`)
            .setIcon("external-link")
            .onClick(() => window.open(url))
        );
      }
    }
    if (isScheduled(task)) {
      menu.addItem((i) =>
        i
          .setTitle("時刻を外す（未スケジュールへ）")
          .setIcon("timer-off")
          .onClick(() => void this.commitUpdate(date, task, { ...this.draftOf(task), start: null, end: null }))
      );
    }
    if (this.plugin.blockStoreFor(task.owner) && !task.done && !task.forwarded) {
      menu.addItem((i) =>
        i
          .setTitle("翌日へ持ち越す（記録を残す）")
          .setIcon("corner-down-right")
          .onClick(() => void this.commitCarryOver(date, task))
      );
    }
    if (this.plugin.blockStore() && this.plugin.settings.members.length) {
      const targets: { id: string | null; name: string }[] = [
        { id: null, name: "自分" },
        ...this.plugin.settings.members.map((m) => ({ id: m.id, name: m.name || "?" })),
      ].filter((o) => (o.id ?? null) !== (task.owner ?? null));
      for (const o of targets) {
        menu.addItem((i) =>
          i
            .setTitle(`${o.name}の予定にする`)
            .setIcon("user")
            .onClick(() => void this.commitChangeOwner(date, task, { ...this.draftOf(task), owner: o.id }))
        );
      }
    }
    if (this.plugin.inbox && !task.owner) {
      menu.addItem((i) =>
        i
          .setTitle("Inbox へ戻す（日付を外す）")
          .setIcon("inbox")
          .onClick(() => void this.commitDayToInbox(date, task))
      );
    }
    menu.addSeparator();
    menu.addItem((i) =>
      i
        .setTitle("定期タスクとして登録…")
        .setIcon("repeat")
        .onClick(() => {
          new RecurringModal(this.app, {
            preset: {
              title: task.title,
              start: task.start,
              end: task.end,
              weekday: date.getDay(),
              project: task.project,
              // タスクのステップを「共通のステップ」の初期値に（毎回未チェックで入る）
              steps: task.steps.map((st) => st.text.trim()).filter(Boolean),
            },
            tagChoices: this.plugin.settings.tagColors,
            projects: this.plugin.projects?.list(),
            onSubmit: async (rule) => {
              this.plugin.settings.recurring.push(rule);
              await this.plugin.saveSettings();
              new Notice(`定期タスク「${rule.title}」を登録しました`);
            },
          }).open();
        })
    );
    menu.addSeparator();
    menu.addItem((i) =>
      i.setTitle("削除").setIcon("trash").onClick(() => void this.commitDelete(date, task))
    );
    menu.showAtMouseEvent(e);
  }

  // ---------- モーダル ----------

  openCreateModal(
    this: DayTimelineView,
    date: Date,
    start?: number | null,
    end?: number | null,
    onClose?: () => void,
    preset?: Partial<TaskDraft>
  ): void {
    const s = this.plugin.settings;
    const dayStart = s.startHour * 60;
    const dayEnd = s.endHour * 60;
    if (start === undefined) {
      const base = isToday(date) ? Math.ceil(nowMinutes() / s.snapMinutes) * s.snapMinutes : 9 * 60;
      start = clamp(base, dayStart, Math.max(dayStart, dayEnd - s.snapMinutes));
    }
    if (start !== null) {
      if (end === undefined || end === null) end = Math.min(start + s.defaultDurationMinutes, dayEnd);
      if (end <= start) end = Math.min(start + s.snapMinutes, 1440);
    } else {
      end = null;
    }

    new TaskModal(this.app, {
      mode: "create",
      initial: { ...preset, title: preset?.title ?? "", start, end, done: false },
      snapMinutes: s.snapMinutes,
      allowUnscheduled: true,
      dateField: { value: dateKey(date) },
      tagChoices: s.tagColors,
      reminderDefault: s.reminderDefaultMinutes,
      trackers: s.trackers,
      owners: this.ownerChoices(),
      initialOwner: null,
      otherActuals: this.otherActualsFor(date, null),
      ...this.projectOptions(),
      onSubmit: (data, dateSel) => this.commitCreate(dateSel ?? date, data),
      onClose,
    }).open();
  }

  /**
   * プロジェクトパネルの「＋」からのタスク追加。日付はまだ決めない前提で、
   * 時刻を空のまま保存すると日付未定（実体は Inbox のノート。パネルには「未定」と表示）、
   * 時刻を入れると表示中の日へ登録する
   */
  openProjectCreateModal(this: DayTimelineView, project: string): void {
    const inbox = this.plugin.inbox;
    if (!inbox) {
      // Inbox の無い形式ではプロジェクトパネル自体が出ないはずだが、念のため従来どおり
      this.openCreateModal(this.date, undefined, undefined, undefined, { project });
      return;
    }
    const s = this.plugin.settings;
    const dayLabel = moment(this.date).format("M月D日");
    new TaskModal(this.app, {
      mode: "create",
      initial: { title: "", start: null, end: null, done: false, project },
      snapMinutes: s.snapMinutes,
      allowUnscheduled: true,
      dateLabel: "日付未定",
      dateField: {
        value: null,
        allowEmpty: true,
        hint: "空のままなら日付を決めずに登録します",
      },
      unscheduledHint: `時刻なし — 日付を決めずに登録します（プロジェクトパネルに「未定」として並びます。時刻を入れると ${dayLabel} に登録）`,
      tagChoices: s.tagColors,
      trackers: s.trackers,
      ...this.projectOptions(),
      onSubmit: async (data, dateSel) => {
        // 日付を選んだらその日へ。選ばずに時刻だけ入れたら、これまでどおり表示中の日へ
        const to = dateSel ?? (data.start !== null && data.end !== null ? this.date : null);
        if (to) {
          await this.commitCreate(to, data);
          return;
        }
        try {
          await inbox.create(INBOX_DATE, { ...data, start: null, end: null });
          new Notice("日付未定で登録しました（プロジェクトパネルに表示されます）");
        } catch (e) {
          console.error(e);
          new Notice("登録できませんでした: " + String(e));
        }
        await this.reload();
      },
    }).open();
  }

  openEditModal(this: DayTimelineView, date: Date, task: Task): void {
    // 自動保存のたびに参照を最新へ差し替える（タイトルや時刻が変わると照合できなくなるため）
    let current = task;
    const wasDone = task.done;
    const serially = serialQueue();
    // 日付を空にして「日付未定（Inbox）」へ戻せるのは、自分のタスクで Inbox があるときだけ
    const allowClearDate = !!this.plugin.inbox && !task.owner;
    new TaskModal(this.app, {
      mode: "edit",
      initial: this.draftOf(task),
      snapMinutes: this.plugin.settings.snapMinutes,
      allowUnscheduled: true,
      dateField: {
        value: dateKey(date),
        allowEmpty: allowClearDate,
        hint: allowClearDate ? "空にすると日付未定（Inbox）へ移します" : undefined,
      },
      tagChoices: this.plugin.settings.tagColors,
      reminderDefault: this.plugin.settings.reminderDefaultMinutes,
      showActual: true,
      trackers: this.plugin.settings.trackers,
      owners: this.ownerChoices(),
      initialOwner: task.owner ?? null,
      otherActuals: this.otherActualsFor(date, task.owner ?? null, task.key),
      ...this.projectOptions(),
      onAutoSave: async (data) => {
        // 持ち主・日付の変更はノートをまたぐ移動になるので、閉じるとき（onSubmit）にまとめて反映する
        const next = await serially(() => this.commitAutoSave(date, current, data));
        if (next) current = next;
        return next !== null;
      },
      onSubmit: (data, dateSel) =>
        serially(() => this.commitEditSubmit(date, current, data, dateSel, wasDone)),
      onDelete: () => serially(() => this.commitDelete(date, current)),
      onOpenNote: () => serially(() => this.openTaskInNote(date, current)),
    }).open();
  }

  /**
   * 編集ダイアログを閉じたときの反映。日付欄が変わっていれば別の日のノートへ移す
   * （空にしたときは Inbox の「日付未定」へ）
   */
  async commitEditSubmit(
    this: DayTimelineView,
    date: Date,
    task: Task,
    data: TaskDraft,
    dateSel: Date | null | undefined,
    wasDone: boolean
  ): Promise<void> {
    // 日付が変わっていない（または欄が無い）: これまでどおり
    if (dateSel === undefined || (dateSel !== null && isSameDay(dateSel, date))) {
      return this.commitUpdate(date, task, data, wasDone);
    }
    // 持ち主の変更と同時はノートをまたぐ移動が重なるため、持ち主の変更を優先する
    if (data.owner !== undefined && (data.owner ?? null) !== (task.owner ?? null)) {
      new Notice("持ち主と日付は同時に変えられないため、日付は変更していません");
      return this.commitUpdate(date, task, data, wasDone);
    }
    if (dateSel === null) return this.commitDayToInbox(date, task, data);
    return this.commitMove(date, task, dateSel, data);
  }

  /** 編集ダイアログの「誰の予定か」の選択肢（メンバーが居ないときは undefined = 欄を出さない） */
  ownerChoices(this: DayTimelineView): { id: string | null; name: string; color: string }[] | undefined {
    if (!this.plugin.blockStore() || !this.plugin.settings.members.length) return undefined;
    return [
      { id: null, name: "自分", color: "" },
      ...this.plugin.settings.members.map((m) => ({ id: m.id, name: m.name || "?", color: m.color })),
    ];
  }

  draftOf(this: DayTimelineView, task: Task): TaskDraft {
    return {
      title: task.title,
      start: task.start,
      end: task.end,
      done: task.done,
      reminder: task.reminder,
      doneCondition: task.doneCondition,
      steps: task.steps,
      retrospective: task.retrospective,
      result: task.result,
      remaining: task.remaining,
      cause: task.cause,
      judgment: task.judgment,
      others: task.others,
      answer: task.answer,
      status: task.status,
      ownerName: task.ownerName,
      due: task.due,
      nextAction: task.nextAction,
      actual: task.actual,
      project: task.project,
      details: task.details,
      ticket: task.ticket,
    };
  }

  /**
   * 編集ダイアログに渡す「同じ日の他のタスクの実績」（実績の重複を保存前に注意するため）。
   * 同じ持ち主のタスクだけを見る（メンバーの予定と自分の予定は別のノートなので重なってよい）
   */
  otherActualsFor(this: DayTimelineView, date: Date, owner: string | null, exceptKey?: string): OtherActual[] {
    return (this.data.get(dateKey(date))?.tasks ?? [])
      .filter((t) => t.key !== exceptKey && (t.owner ?? null) === (owner ?? null) && t.actual.length)
      .map((t) => ({ title: stripTags(t.title) || "(無題)", ranges: t.actual }));
  }

  /** 編集・追加ダイアログに渡すプロジェクトまわりの共通オプション */
  projectOptions(this: DayTimelineView) {
    const projects = this.plugin.projects;
    if (!projects) return {};
    return {
      projects: projects.list(),
      onCreateProject: (name: string) => projects.create(name),
      onOpenProject: (link: string) => this.plugin.openProject(link),
    };
  }

  async commitCreate(this: DayTimelineView, date: Date, data: TaskDraft): Promise<void> {
    try {
      await this.plugin.storeFor(data.owner).create(date, data);
    } catch (e) {
      console.error(e);
      new Notice("タスクを保存できませんでした: " + String(e));
    }
    await this.reload();
  }

  /**
   * @param before ボス戦の演出の基準（保存前の状態）。編集ダイアログは開いたときの写しを渡す。
   *   省略時は task そのもの（チェック・メニューからの完了）
   */
  async commitUpdate(
    this: DayTimelineView,
    date: Date,
    task: Task,
    data: TaskDraft,
    wasDone = task.done
  ): Promise<void> {
    // 持ち主が変わった場合は、別のノートへブロックごと移す
    if (data.owner !== undefined && (data.owner ?? null) !== (task.owner ?? null)) {
      await this.commitChangeOwner(date, task, data);
      return;
    }
    await this.performUpdate(date, task, data, wasDone);
  }

  async performUpdate(
    this: DayTimelineView,
    date: Date,
    task: Task,
    data: TaskDraft,
    wasDone = task.done
  ): Promise<void> {
    // 未完了 → 完了で実績が空なら、自動で実績を入れる
    const auto = this.autoActual(date, task, data, wasDone);
    if (auto) data = { ...data, actual: auto };
    let updated = false;
    try {
      const ok = await this.storeOf(task).update(date, task, data);
      if (!ok) new Notice("タスクが見つかりませんでした。ノートが変更された可能性があります。");
      updated = !!ok;
    } catch (e) {
      console.error(e);
      new Notice("タスクを保存できませんでした: " + String(e));
    }
    await this.reload();
    if (updated) {
      if (auto) new Notice(`実績 ${formatActualRanges(auto)} を記録しました（編集ダイアログで直せます）`);
      // 「未完了 → 完了」でプロジェクトの子が全部完了したら、プロジェクトの完了を提案
      if (data.done && !wasDone) {
        void this.maybeSuggestProjectDone(data.project !== undefined ? data.project : task.project);
      }
    }
  }

  /** プロジェクトの子タスクがすべて完了したら、プロジェクト自身の完了を提案する */
  async maybeSuggestProjectDone(this: DayTimelineView, link: string | null | undefined): Promise<void> {
    const projects = this.plugin.projects;
    if (!link || !projects) return;
    try {
      const children = await this.plugin.collectProjectChildren(link);
      // 持ち越し済み [>] のブロックは「閉じた記録」なので、完了扱いで数える
      if (!children.length || !children.every((c) => c.task.done || c.task.forwarded)) return;
      // メタ行なし（null）は「未完了」とみなす（setDone がメタ行を書き足してくれる）
      if ((await projects.isDone(link)) === true) return; // 既に完了
      new ConfirmModal(
        this.app,
        `プロジェクト「${projectDisplayName(link)}」のタスクがすべて完了しました。プロジェクトも完了にしますか？`,
        "完了にする",
        async () => {
          const ok = await projects.setDone(link, true);
          if (ok) {
            await this.plugin.updateProjectNote(link);
            new Notice(`プロジェクト「${projectDisplayName(link)}」を完了にしました`);
          } else {
            new Notice("プロジェクトノートを更新できませんでした");
          }
        }
      ).open();
    } catch (e) {
      console.error(e);
    }
  }

  /**
   * 完了にしたときの実績の自動記録（設定でオフ可）。
   * 今日のタスクを作業の前後で完了にしたときは「予定の開始 〜 今」、
   * それ以外（後からまとめてチェックした・別の日のタスク）は「予定どおり」として記録する。
   * 同じ日の他タスクの実績と重なる時間帯は除く（完了操作の遅れや中断が
   * 二重の実績として記録され、予実の合計と記録チェックを狂わせるのを防ぐ）。
   */
  autoActual(this: DayTimelineView, date: Date, task: Task, data: TaskDraft, wasDone: boolean): ActualRange[] | null {
    const s = this.plugin.settings;
    if (!s.autoRecordActual || !this.plugin.blockStore()) return null;
    if (!data.done || wasDone) return null;
    const existing = data.actual !== undefined ? data.actual : task.actual;
    if (existing.length) return null;
    const start = data.start ?? task.start;
    const end = data.end ?? task.end;
    if (start === null || end === null) return null;
    let candidate: ActualRange[] = [{ start, end }];
    if (isToday(date)) {
      const now = nowMinutes();
      if (now > start && now <= end + 60) candidate = [{ start, end: Math.min(now, 1440) }];
    }
    const others = (this.data.get(dateKey(date))?.tasks ?? [])
      .filter((t) => t.key !== task.key && (t.owner ?? null) === (task.owner ?? null))
      .flatMap((t) => t.actual);
    const clipped = subtractActualRanges(candidate, others);
    // すべて他タスクの実績と重なっていたら、記録しないよりは元の候補を残す（ポップアップで直せる）
    return clipped.length ? clipped : candidate;
  }

  /**
   * 編集ダイアログからの自動保存。持ち主の変更は反映しない（閉じるときに行う）。
   * 成功したら保存後のタスク参照を返し、失敗（見つからない・書き込みエラー）なら null。
   */
  async commitAutoSave(this: DayTimelineView, date: Date, task: Task, data: TaskDraft): Promise<Task | null> {
    const store = this.storeOf(task);
    try {
      if (!(await store.update(date, task, data))) return null;
    } catch (e) {
      console.error(e);
      return null;
    }
    await this.reload();
    return (await this.relocateTask(store, date, task, data)) ?? task;
  }

  /** 保存で ID が付いたり内容が変わったりしたあと、同じタスクを探し直す */
  async relocateTask(
    this: DayTimelineView,
    store: BlockTaskStore,
    date: Date,
    task: Task,
    draft: TaskDraft
  ): Promise<Task | null> {
    try {
      const day = await store.load(date);
      if (task.blockId) return day.tasks.find((t) => t.blockId === task.blockId) ?? null;
      // ID の無いタスク（旧形式・手書きのブロック）は保存した内容で照合する
      return (
        day.tasks.find(
          (t) =>
            t.title === draft.title && t.start === draft.start && t.end === draft.end && t.done === draft.done
        ) ?? null
      );
    } catch (e) {
      console.error(e);
      return null;
    }
  }

  async commitDelete(this: DayTimelineView, date: Date, task: Task): Promise<void> {
    const doDelete = async () => {
      try {
        const ok = await this.storeOf(task).remove(date, task);
        if (!ok) new Notice("タスクが見つかりませんでした。ノートが変更された可能性があります。");
        // 定期タスクの回だったら「その日は取り消した」として記録する（勝手に復活しない・管理画面で区別できる）
        else await noteRecurringDeletion(this.plugin, date, task);
      } catch (e) {
        console.error(e);
        new Notice("タスクを削除できませんでした: " + String(e));
      }
      await this.reload();
    };

    // 本文があるブロックはノートの中身ごと消えるので確認する
    const s = this.plugin.settings;
    const blockStore = this.plugin.blockStoreFor(task.owner);
    if (s.confirmBodyDelete && blockStore && (await blockStore.hasBody(date, task))) {
      new ConfirmModal(
        this.app,
        `「${task.title || "(無題)"}」には本文があります。ブロックごと削除しますか？`,
        "削除",
        doDelete
      ).open();
      return;
    }
    await doDelete();
  }

  /**
   * 別の日へ移す。draft を渡すと移動後にその内容（時刻など）で更新する
   * （週表示で別の日の列へドラッグしたときに使う）。
   */
  async commitMove(this: DayTimelineView, from: Date, task: Task, to: Date, draft?: TaskDraft): Promise<void> {
    try {
      const r = await this.storeOf(task).moveToDate(from, task, to);
      if (r === "missing") {
        new Notice("タスクが見つかりませんでした。ノートが変更された可能性があります。");
      } else if (r === "conflict") {
        new Notice(TRANSFER_CONFLICT_MESSAGE);
      } else {
        if (draft) {
          const updated = await this.storeOf(task).update(to, task, draft);
          if (!updated) new Notice("移動しましたが、時刻を更新できませんでした");
        }
        new Notice(`${moment(to).format("M月D日")} へ移動しました`);
      }
    } catch (e) {
      console.error(e);
      new Notice("タスクを移動できませんでした: " + errorText(e));
    }
    await this.reload();
  }

  /**
   * 残件の持ち越し: タスクは動かさず、今日のブロックを [>] で閉じて
   * 続きのブロックを翌日に作る。実績・本文は今日の記録として残る
   */
  async commitCarryOver(this: DayTimelineView, date: Date, task: Task): Promise<void> {
    const store = this.plugin.blockStoreFor(task.owner);
    if (!store) {
      new Notice("持ち越しはタスクブロック形式のときだけ使えます");
      return;
    }
    if (task.done) {
      new Notice("完了したタスクは持ち越せません");
      return;
    }
    try {
      // 元ブロックに ID を付けて、リンクで鎖にできるようにする
      const link = await store.linkTo(date, task);
      const fromId = link?.split("#^")[1];
      if (!fromId) {
        new Notice("持ち越し元のタスクが見つかりませんでした。ノートが変更された可能性があります。");
        await this.reload();
        return;
      }
      const fromLink = `${store.pathFor(date).replace(/\.md$/, "")}#^${fromId}`;

      // 続きのブロック: 残ステップ・完了条件・プロジェクト等を引き継ぎ、未スケジュールで作る
      const remaining = task.steps
        .filter((st) => !st.done)
        .map((st) => ({ ...st, children: [...(st.children ?? [])] }));
      const newId = newBlockId();
      const toDate = addDays(date, 1);
      const toLink = `${store.pathFor(toDate).replace(/\.md$/, "")}#^${newId}`;
      await store.createWithId(toDate, {
        title: task.title,
        start: null,
        end: null,
        done: false,
        reminder: task.reminder,
        doneCondition: task.doneCondition || undefined,
        steps: remaining,
        ticket: task.ticket ?? undefined,
        project: task.project ?? undefined,
        // 未完了セット（Owner・期限・次アクション）も続きのブロックへ引き継ぐ（翌日に追えるように）
        ownerName: task.ownerName || undefined,
        due: task.due || undefined,
        nextAction: task.nextAction || undefined,
        carryFrom: fromLink,
      }, newId);

      // 元ブロックを閉じる: [>] + 持ち越し先リンク（実績・ステップ・本文はそのまま）
      const ok = await store.update(date, { ...task, blockId: fromId, ref: { kind: "block", id: fromId, title: task.title, start: task.start, end: task.end } }, {
        title: task.title,
        start: task.start,
        end: task.end,
        done: false,
        forward: true,
        carryTo: toLink,
      });
      if (!ok) new Notice("持ち越し先は作りましたが、元のタスクを閉じられませんでした");
      else {
        const name = stripTags(task.title) || "(無題)";
        const rem = remaining.length ? `（残ステップ ${remaining.length} 件）` : "";
        new Notice(`「${name}」を翌日へ持ち越しました${rem}。明日の未スケジュールのトレイに入ります`);
      }
    } catch (e) {
      console.error(e);
      new Notice("持ち越せませんでした: " + String(e));
    }
    await this.reload();
  }

  /** タスクの持ち主を変える（別のフォルダのノートへブロックごと移す） */
  async commitChangeOwner(this: DayTimelineView, date: Date, task: Task, data: TaskDraft): Promise<void> {
    const from = this.plugin.blockStoreFor(task.owner);
    const to = this.plugin.blockStoreFor(data.owner);
    if (!from || !to || from === to) return;
    try {
      // 先に移動先へ書いてから元を消す（途中で失敗してもブロックは消えない）
      const r = await from.transferTo(date, task, to, date, data.start ?? task.start);
      if (r === "missing") {
        new Notice("タスクが見つかりませんでした。ノートが変更された可能性があります。");
      } else if (r === "conflict") {
        new Notice(TRANSFER_CONFLICT_MESSAGE);
      } else {
        const ok = await to.update(date, task, { ...data, owner: undefined });
        if (!ok) new Notice("移しましたが、内容を更新できませんでした");
        const name = this.plugin.memberOf(data.owner)?.name ?? "自分";
        new Notice(`${name}の予定にしました`);
      }
    } catch (e) {
      console.error(e);
      new Notice("タスクを移せませんでした: " + errorText(e));
    }
    await this.reload();
  }

  // ---------- Inbox ----------

  openInboxEditModal(this: DayTimelineView, task: Task): void {
    const inbox = this.plugin.inbox;
    if (!inbox) return;
    let current = task;
    const serially = serialQueue();
    new TaskModal(this.app, {
      mode: "edit",
      initial: this.draftOf(task),
      snapMinutes: this.plugin.settings.snapMinutes,
      allowUnscheduled: true,
      dateLabel: "Inbox",
      dateField: {
        value: null,
        allowEmpty: true,
        hint: "日付未定。日付を入れると、その日のノートへ移します",
      },
      tagChoices: this.plugin.settings.tagColors,
      showActual: true,
      trackers: this.plugin.settings.trackers,
      ...this.projectOptions(),
      onAutoSave: async (data) => {
        // 自動保存では Inbox に留める。「日付・時刻を入れたら移す」のは閉じるときに行う
        const next = await serially(() => this.commitInboxAutoSave(current, data));
        if (next) current = next;
        return next !== null;
      },
      onSubmit: (data, dateSel) =>
        serially(() => {
          // 日付を選んだらその日へ（時刻なしなら未スケジュールのまま）
          if (dateSel) return this.commitInboxToDay(current, dateSel, data);
          // 日付を選ばずに時刻を入れたら「今日」に移す（従来どおり）
          if (data.start !== null && data.end !== null) {
            return this.commitInboxToDay(current, startOfDay(new Date()), data);
          }
          return this.commitInboxUpdate(current, data);
        }),
      onDelete: () => serially(() => this.commitInboxDelete(current)),
      onOpenNote: () => serially(() => this.openInboxTaskInNote(current)),
    }).open();
  }

  /** Inbox の編集ダイアログからの自動保存（時刻は付けずに保存する） */
  async commitInboxAutoSave(this: DayTimelineView, task: Task, data: TaskDraft): Promise<Task | null> {
    const inbox = this.plugin.inbox;
    if (!inbox) return null;
    const draft = { ...data, start: null, end: null };
    try {
      if (!(await inbox.update(INBOX_DATE, task, draft))) return null;
    } catch (e) {
      console.error(e);
      return null;
    }
    await this.reloadInbox();
    return (await this.relocateTask(inbox, INBOX_DATE, task, draft)) ?? task;
  }

  async openInboxTaskInNote(this: DayTimelineView, task: Task): Promise<void> {
    const inbox = this.plugin.inbox;
    if (!inbox) return;
    try {
      const link = await inbox.linkTo(INBOX_DATE, task);
      if (link) await this.app.workspace.openLinkText(link, "", false);
      else await this.app.workspace.getLeaf("tab").openFile(await inbox.ensureFile(INBOX_DATE));
    } catch (e) {
      console.error(e);
      new Notice("ノートを開けませんでした: " + String(e));
    }
  }

  async commitInboxUpdate(this: DayTimelineView, task: Task, data: TaskDraft): Promise<void> {
    const inbox = this.plugin.inbox;
    if (!inbox) return;
    try {
      const ok = await inbox.update(INBOX_DATE, task, { ...data, start: null, end: null });
      if (!ok) new Notice("タスクが見つかりませんでした。Inbox が変更された可能性があります。");
    } catch (e) {
      console.error(e);
      new Notice("タスクを保存できませんでした: " + String(e));
    }
    await this.reload();
  }

  async commitInboxDelete(this: DayTimelineView, task: Task): Promise<void> {
    const inbox = this.plugin.inbox;
    if (!inbox) return;
    const doDelete = async () => {
      try {
        const ok = await inbox.remove(INBOX_DATE, task);
        if (!ok) new Notice("タスクが見つかりませんでした。Inbox が変更された可能性があります。");
      } catch (e) {
        console.error(e);
        new Notice("タスクを削除できませんでした: " + String(e));
      }
      await this.reload();
    };
    if (this.plugin.settings.confirmBodyDelete && (await inbox.hasBody(INBOX_DATE, task))) {
      new ConfirmModal(
        this.app,
        `「${task.title || "(無題)"}」には本文があります。ブロックごと削除しますか？`,
        "削除",
        doDelete
      ).open();
      return;
    }
    await doDelete();
  }

  /** Inbox のタスクをその日のノートへ移す。draft があれば移動後にその内容で更新 */
  async commitInboxToDay(this: DayTimelineView, task: Task, to: Date, draft?: TaskDraft): Promise<void> {
    const inbox = this.plugin.inbox;
    const day = this.plugin.blockStore();
    if (!inbox || !day) return;
    try {
      const r = await inbox.transferTo(INBOX_DATE, task, day, to, draft?.start ?? null);
      if (r === "missing") {
        new Notice("タスクが見つかりませんでした。Inbox が変更された可能性があります。");
      } else if (r === "conflict") {
        new Notice(TRANSFER_CONFLICT_MESSAGE);
      } else {
        if (draft) {
          const ok = await day.update(to, task, draft);
          if (!ok) new Notice("移動しましたが、時刻を更新できませんでした");
        }
        new Notice(`${moment(to).format("M月D日")} へ移動しました`);
      }
    } catch (e) {
      console.error(e);
      new Notice("タスクを移動できませんでした: " + errorText(e));
    }
    await this.reload();
  }

  /** その日のタスクを Inbox へ戻す（時刻も外す）。draft があれば移動後にその内容で更新 */
  async commitDayToInbox(this: DayTimelineView, from: Date, task: Task, draft?: TaskDraft): Promise<void> {
    const inbox = this.plugin.inbox;
    const day = this.plugin.blockStore();
    if (!inbox || !day) return;
    try {
      const r = await day.transferTo(from, task, inbox, INBOX_DATE, null);
      if (r === "missing") {
        new Notice("タスクが見つかりませんでした。ノートが変更された可能性があります。");
      } else if (r === "conflict") {
        new Notice(TRANSFER_CONFLICT_MESSAGE);
      } else {
        // 時刻を外し、Inbox に入れた日を「登録日」として刻む（滞留日数を後から判定できるように）
        await inbox.update(INBOX_DATE, task, {
          ...(draft ?? this.draftOf(task)),
          start: null,
          end: null,
          registered: moment().format("YYYY-MM-DD"),
        });
        new Notice("Inbox へ戻しました（日付未定）");
      }
    } catch (e) {
      console.error(e);
      new Notice("タスクを移動できませんでした: " + errorText(e));
    }
    await this.reload();
  }

  // ---------- その他 ----------
}
