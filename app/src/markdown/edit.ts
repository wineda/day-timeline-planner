/**
 * タスクブロックの書き換え。
 *
 * どの操作も「ノート全文を解析し直す → 対象のブロックを ID で見つける →
 * その行範囲だけを差し替える」という手順で行う。
 * ビューが覚えている行番号は使わないので、ユーザーがノートを直接編集していても壊れない。
 */
import {
  ActualRange,
  BlockDocument,
  BlockOptions,
  MetaSource,
  ReminderSetting,
  TaskBlock,
  TaskStep,
  TicketRef,
  parseBlockDocument,
  parseHeadingSetting,
  renderActualLine,
  renderAnswerLine,
  renderCarryFromLine,
  renderCarryToLine,
  renderCauseLine,
  renderProjectLine,
  renderDoneConditionLine,
  renderDueLine,
  renderHeadingLine,
  renderJudgmentLine,
  renderNextActionLine,
  renderOthersLine,
  renderOwnerNameLine,
  renderRegisteredLine,
  renderRemainingLine,
  renderResultLine,
  renderRetrospectiveLine,
  renderStatusLine,
  renderStepLines,
  renderMetaLine,
  renderTaskBlock,
  trimBlankLines,
} from "./blocks";
import { newBlockId } from "./id";

export interface InsertOptions extends BlockOptions {
  /** 新しいタスクを入れる位置 */
  insertPosition: "time" | "end";
}

/** 書き換え対象のタスクを指す情報 */
export interface TaskRef {
  id: string | null;
  title: string;
  start: number | null;
  end: number | null;
}

export interface TaskPatch {
  title?: string;
  start?: number | null;
  end?: number | null;
  done?: boolean;
  reminder?: ReminderSetting;
  /** undefined = 変更しない / null = 消す */
  ticket?: TicketRef | null;
  /** undefined = 変更しない / "" = 消す */
  doneCondition?: string;
  /** undefined = 変更しない / [] = 消す */
  steps?: TaskStep[];
  /** undefined = 変更しない / "" = 消す */
  retrospective?: string;
  /** 結果。undefined = 変更しない / "" = 消す */
  result?: string;
  /** 残。undefined = 変更しない / "" = 消す */
  remaining?: string;
  /** 原因。undefined = 変更しない / "" = 消す */
  cause?: string;
  /** 判断。undefined = 変更しない / "" = 消す */
  judgment?: string;
  /** 他者（1件 = 1行）。undefined = 変更しない / [] = 全部消す */
  others?: string[];
  /** 回答。undefined = 変更しない / "" = 消す */
  answer?: string;
  /** 状態。undefined = 変更しない / "" = 消す */
  status?: string;
  /** Owner。undefined = 変更しない / "" = 消す */
  ownerName?: string;
  /** 期限。undefined = 変更しない / "" = 消す */
  due?: string;
  /** 次アクション。undefined = 変更しない / "" = 消す */
  nextAction?: string;
  /** 登録日。undefined = 変更しない / "" = 消す */
  registered?: string;
  /** 実績。undefined = 変更しない / [] = 消す */
  actual?: ActualRange[];
  /** プロジェクト。undefined = 変更しない / null = 外す */
  project?: string | null;
  /** true にするとチェックを [>]（持ち越し）にする。undefined = 変更しない */
  forward?: boolean;
  /** 持ち越し先リンク。undefined = 変更しない / null = 行を消す */
  carryTo?: string | null;
  /** 持ち越し元リンク。undefined = 変更しない / null = 行を消す */
  carryFrom?: string | null;
  /** 詳細（自由な本文）。undefined = 変更しない / "" = 消す */
  details?: string;
}

export interface NewTaskInput {
  title: string;
  start: number | null;
  end: number | null;
  done: boolean;
  reminder?: ReminderSetting;
  ticket?: TicketRef | null;
  doneCondition?: string;
  steps?: TaskStep[];
  retrospective?: string;
  result?: string;
  remaining?: string;
  cause?: string;
  judgment?: string;
  others?: string[];
  answer?: string;
  status?: string;
  ownerName?: string;
  due?: string;
  nextAction?: string;
  registered?: string;
  actual?: ActualRange[];
  project?: string | null;
  carryTo?: string | null;
  carryFrom?: string | null;
  details?: string;
  body?: string[];
  /** 指定すればその ID を使う（日をまたぐ移動などで使う） */
  id?: string;
}

/** ノート内のタスクを特定する。ID があれば ID、無ければ見出しと時刻で照合 */
export function locateTask(doc: BlockDocument, ref: TaskRef): TaskBlock | null {
  if (ref.id) return doc.tasks.find((t) => t.id === ref.id) ?? null;
  return (
    doc.tasks.find(
      (t) =>
        t.id === null &&
        t.title === ref.title &&
        t.start === ref.start &&
        t.end === ref.end
    ) ?? null
  );
}

/** タスクを追加する */
export function insertTask(content: string, draft: NewTaskInput, opts: InsertOptions): string {
  const id = draft.id ?? newBlockId();
  const source: MetaSource & { body?: string[] } = {
    id,
    title: draft.title,
    start: draft.start,
    end: draft.end,
    done: draft.done,
    note: "",
    reminder: draft.reminder ?? null,
    ticket: draft.ticket ?? null,
    doneCondition: draft.doneCondition,
    steps: draft.steps,
    retrospective: draft.retrospective,
    result: draft.result,
    remaining: draft.remaining,
    cause: draft.cause,
    judgment: draft.judgment,
    others: draft.others,
    answer: draft.answer,
    status: draft.status,
    ownerName: draft.ownerName,
    due: draft.due,
    nextAction: draft.nextAction,
    registered: draft.registered,
    actual: draft.actual,
    project: draft.project,
    carryTo: draft.carryTo,
    carryFrom: draft.carryFrom,
    body: draft.body ?? (draft.details ? draft.details.replace(/\s+$/, "").split("\n") : undefined),
  };
  return insertBlockLines(content, renderTaskBlock(source, opts), draft.start, opts);
}

/** 出来上がったブロックの行をそのまま差し込む（日をまたぐ移動で使う） */
export function insertBlockLines(
  content: string,
  block: string[],
  start: number | null,
  opts: InsertOptions
): string {
  let text = content;
  let doc = parseBlockDocument(text, opts);

  if (doc.rootMissing) {
    text = appendRootHeading(text, doc.eol, opts);
    doc = parseBlockDocument(text, opts);
  }
  // 空のノートなら、そのままブロックだけを書く
  if (text.trim() === "") return joinLines(block, doc.eol);

  const at = insertionIndex(doc, start, opts.insertPosition);
  return joinLines(spliceIn(doc.lines, at, 0, block), doc.eol);
}

/**
 * タスクを更新する。見出し行とメタ行だけを書き換えるので、本文には触れない。
 * 見つからなければ null。
 */
export function updateTask(
  content: string,
  ref: TaskRef,
  patch: TaskPatch,
  opts: BlockOptions
): string | null {
  const doc = parseBlockDocument(content, opts);
  const t = locateTask(doc, ref);
  if (!t) return null;

  const next: MetaSource = {
    id: t.id ?? newBlockId(), // 手書きのブロックにはこのタイミングで ID を付ける
    title: patch.title ?? t.title,
    start: patch.start !== undefined ? patch.start : t.start,
    end: patch.end !== undefined ? patch.end : t.end,
    done: patch.done ?? t.done,
    // forward = true でチェックを [>]（持ち越し）にする
    checkChar: patch.forward ? ">" : t.checkChar,
    note: t.note,
    reminder: patch.reminder !== undefined ? patch.reminder : t.reminder,
    ticket: patch.ticket !== undefined ? patch.ticket : t.ticket,
  };
  // 片方だけ時刻が消えた状態は作らない
  if (next.start === null || next.end === null) {
    next.start = null;
    next.end = null;
  }

  const lines = [...doc.lines];
  lines[t.headingLine] = renderHeadingLine(next.title, t.level);
  lines[t.metaLine] = renderMetaLine(next, opts);

  // 完了条件とステップ: 既存の行を書き換える / 無ければメタ行の直下に足す / 空にしたら行ごと消す。
  // 行番号がずれないように、後ろにある方から差し替える
  const ops: { at: number; del: number; lines: string[]; order: number }[] = [];
  let deleted = false;
  // 詳細（自由な本文）: 特別な行（完了条件など）の後ろの領域をまるごと差し替える
  if (patch.details !== undefined) {
    const text = patch.details.replace(/\s+$/, "");
    const add = text ? text.split("\n") : [];
    if (add.length && t.detailsStart > 0 && lines[t.detailsStart - 1].trim() !== "") add.unshift("");
    if (add.length && lines[t.endLine] !== undefined && lines[t.endLine].trim() !== "") add.push("");
    ops.push({ at: t.detailsStart, del: t.endLine - t.detailsStart, lines: add, order: -1 });
    if (!add.length) deleted = true;
  }
  // 詳細の領域内にある「ふりかえり」「完了条件」「実績」行は詳細と一緒に編集されるので、個別の書き換えは行わない
  const insideDetails = (line: number | null) =>
    patch.details !== undefined && line !== null && line >= t.detailsStart;
  // メタ行直下に並ぶ特別な行（プロジェクト・実績・持ち越し・登録日・期限・完了条件）を飛ばした挿入位置
  let afterMeta = t.metaLine + 1;
  while (
    afterMeta === t.actualLine ||
    afterMeta === t.doneConditionLine ||
    afterMeta === t.projectLine ||
    afterMeta === t.carryToLine ||
    afterMeta === t.carryFromLine ||
    afterMeta === t.registeredLine ||
    afterMeta === t.dueLine
  )
    afterMeta++;
  // ふりかえり・結果・残の新規行を入れる位置（ステップ・完了条件の後ろ）
  const afterSteps =
    t.stepsStart !== null
      ? t.stepsEnd
      : t.doneConditionLine !== null
        ? t.doneConditionLine + 1
        : afterMeta;
  // ふりかえり: 既存行を書き換え / 無ければステップ・完了条件の後ろに足す / 空なら消す
  if (patch.retrospective !== undefined && !insideDetails(t.retrospectiveLine)) {
    const text = patch.retrospective.trim();
    if (t.retrospectiveLine !== null) {
      ops.push({ at: t.retrospectiveLine, del: 1, lines: text ? [renderRetrospectiveLine(text)] : [], order: 0 });
      if (!text) deleted = true;
    } else if (text) {
      ops.push({ at: afterSteps, del: 0, lines: [renderRetrospectiveLine(text)], order: 0 });
    }
  }
  // 結果・残: ふりかえりと同じ扱い（同じ位置に重なったら 結果 → 残 → ふりかえり の順に並ぶ）
  if (patch.result !== undefined && !insideDetails(t.resultLine)) {
    const text = patch.result.trim();
    if (t.resultLine !== null) {
      ops.push({ at: t.resultLine, del: 1, lines: text ? [renderResultLine(text)] : [], order: 0.7 });
      if (!text) deleted = true;
    } else if (text) {
      ops.push({ at: afterSteps, del: 0, lines: [renderResultLine(text)], order: 0.7 });
    }
  }
  if (patch.remaining !== undefined && !insideDetails(t.remainingLine)) {
    const text = patch.remaining.trim();
    if (t.remainingLine !== null) {
      ops.push({ at: t.remainingLine, del: 1, lines: text ? [renderRemainingLine(text)] : [], order: 0.5 });
      if (!text) deleted = true;
    } else if (text) {
      ops.push({ at: afterSteps, del: 0, lines: [renderRemainingLine(text)], order: 0.5 });
    }
  }
  // 1行の値を持つフィールドの共通処理: 既存行を書き換え / 無ければ at に足す / 空なら消す
  const patchLine = (
    value: string | undefined,
    line: number | null,
    render: (text: string) => string,
    at: number,
    order: number
  ) => {
    if (value === undefined || insideDetails(line)) return;
    const text = value.trim();
    if (line !== null) {
      ops.push({ at: line, del: 1, lines: text ? [render(text)] : [], order });
      if (!text) deleted = true;
    } else if (text) {
      ops.push({ at, del: 0, lines: [render(text)], order });
    }
  };
  // 原因・判断・回答・状態・Owner: 結果・残と同じ扱い
  //（order は同じ位置に重なったときの並び。大きいほど上 = 結果 → 原因 → 判断 → 残 → 他者 → 回答 → 状態 → Owner → ふりかえり）
  patchLine(patch.cause, t.causeLine, renderCauseLine, afterSteps, 0.65);
  patchLine(patch.judgment, t.judgmentLine, renderJudgmentLine, afterSteps, 0.6);
  patchLine(patch.answer, t.answerLine, renderAnswerLine, afterSteps, 0.2);
  patchLine(patch.status, t.statusLine, renderStatusLine, afterSteps, 0.15);
  patchLine(patch.ownerName, t.ownerNameLine, renderOwnerNameLine, afterSteps, 0.1);
  patchLine(patch.nextAction, t.nextActionLine, renderNextActionLine, afterSteps, 0.05);
  // 期限: メタ行直下の特別な行（登録日の下）に置く。既存の「期日:」行も「期限:」に書き換わる（出力の統一）
  patchLine(patch.due, t.dueLine, renderDueLine, afterMeta, 2.35);
  // 他者: 唯一の複数行フィールド。既存の行を前から順に書き換え、余りは消し、足りなければ最後の行の下に足す
  if (patch.others !== undefined) {
    const values = patch.others.map((v) => v.trim()).filter(Boolean);
    const existing = t.othersLines.filter((ln) => !insideDetails(ln));
    const shared = Math.min(existing.length, values.length);
    for (let i = 0; i < shared; i++) {
      ops.push({ at: existing[i], del: 1, lines: [renderOthersLine(values[i])], order: 0.25 });
    }
    for (let i = values.length; i < existing.length; i++) {
      ops.push({ at: existing[i], del: 1, lines: [], order: 0.25 });
      deleted = true;
    }
    if (values.length > existing.length) {
      const rest = values.slice(existing.length).map(renderOthersLine);
      const at = existing.length ? existing[existing.length - 1] + 1 : afterSteps;
      ops.push({ at, del: 0, lines: rest, order: 0.25 });
    }
  }
  // 登録日: 既存行を書き換え / 無ければメタ行直下の特別な行の下に足す / 空なら消す
  if (patch.registered !== undefined && !insideDetails(t.registeredLine)) {
    const text = patch.registered.trim();
    if (t.registeredLine !== null) {
      ops.push({ at: t.registeredLine, del: 1, lines: text ? [renderRegisteredLine(text)] : [], order: 2.4 });
      if (!text) deleted = true;
    } else if (text) {
      ops.push({ at: afterMeta, del: 0, lines: [renderRegisteredLine(text)], order: 2.4 });
    }
  }
  if (patch.steps !== undefined) {
    const rendered = renderStepLines(patch.steps);
    if (t.stepsStart !== null) {
      ops.push({ at: t.stepsStart, del: t.stepsEnd - t.stepsStart, lines: rendered, order: 1 });
      if (!rendered.length) deleted = true;
    } else if (rendered.length) {
      ops.push({ at: afterMeta, del: 0, lines: rendered, order: 1 });
    }
  }
  if (patch.doneCondition !== undefined && !insideDetails(t.doneConditionLine)) {
    const text = patch.doneCondition.trim();
    if (t.doneConditionLine !== null) {
      ops.push({ at: t.doneConditionLine, del: 1, lines: text ? [renderDoneConditionLine(text)] : [], order: 2 });
      if (!text) deleted = true;
    } else if (text) {
      // 既存のプロジェクト・実績行の下に入れる
      ops.push({ at: afterMeta, del: 0, lines: [renderDoneConditionLine(text)], order: 2 });
    }
  }
  // 実績: 既存行を書き換え / 無ければメタ行の直下に足す / 空なら消す
  if (patch.actual !== undefined && !insideDetails(t.actualLine)) {
    const ranges = patch.actual;
    if (t.actualLine !== null) {
      ops.push({ at: t.actualLine, del: 1, lines: ranges.length ? [renderActualLine(ranges)] : [], order: 3 });
      if (!ranges.length) deleted = true;
    } else if (ranges.length) {
      // 既存のプロジェクト行がメタ行の直下にあれば、その下に入れる
      const at = t.projectLine === t.metaLine + 1 ? t.metaLine + 2 : t.metaLine + 1;
      ops.push({ at, del: 0, lines: [renderActualLine(ranges)], order: 3 });
    }
  }
  // プロジェクト: 既存行を書き換え / 無ければメタ行の直下に足す / null なら消す
  if (patch.project !== undefined && !insideDetails(t.projectLine)) {
    const link = patch.project;
    if (t.projectLine !== null) {
      ops.push({ at: t.projectLine, del: 1, lines: link ? [renderProjectLine(link)] : [], order: 4 });
      if (!link) deleted = true;
    } else if (link) {
      ops.push({ at: t.metaLine + 1, del: 0, lines: [renderProjectLine(link)], order: 4 });
    }
  }
  // 持ち越し先・元: 既存行を書き換え / 無ければ特別な行の下（afterMeta）に足す / null なら消す
  if (patch.carryTo !== undefined && !insideDetails(t.carryToLine)) {
    const link = patch.carryTo;
    if (t.carryToLine !== null) {
      ops.push({ at: t.carryToLine, del: 1, lines: link ? [renderCarryToLine(link)] : [], order: 2.5 });
      if (!link) deleted = true;
    } else if (link) {
      ops.push({ at: afterMeta, del: 0, lines: [renderCarryToLine(link)], order: 2.5 });
    }
  }
  if (patch.carryFrom !== undefined && !insideDetails(t.carryFromLine)) {
    const link = patch.carryFrom;
    if (t.carryFromLine !== null) {
      ops.push({ at: t.carryFromLine, del: 1, lines: link ? [renderCarryFromLine(link)] : [], order: 2.6 });
      if (!link) deleted = true;
    } else if (link) {
      ops.push({ at: afterMeta, del: 0, lines: [renderCarryFromLine(link)], order: 2.6 });
    }
  }
  // 行の後ろから順に適用する。同じ位置に重なったときは、既存行の書き換え・削除を先に行い、
  // そのあとで挿入を order の順に重ねる（挿入で行がずれた後に書き換えると別の行を壊すため）
  ops.sort((a, b) => {
    if (a.at !== b.at) return b.at - a.at;
    if (a.del > 0 !== b.del > 0) return a.del > 0 ? -1 : 1;
    return a.order - b.order;
  });
  for (const op of ops) lines.splice(op.at, op.del, ...op.lines);
  if (deleted) {
    // 消したことで空行が続いた場合は1つにまとめる（このブロックの範囲だけ）
    const limit = Math.min(lines.length, t.endLine + 8);
    for (let i = t.metaLine + 1; i < limit && i < lines.length; ) {
      if (lines[i].trim() === "" && i > 0 && lines[i - 1].trim() === "") lines.splice(i, 1);
      else i++;
    }
  }
  return joinLines(lines, doc.eol);
}

/** タスクを消す。消したブロックの行も返す（日をまたぐ移動で使い回す） */
export function removeTask(
  content: string,
  ref: TaskRef,
  opts: BlockOptions
): { content: string; block: string[] } | null {
  const doc = parseBlockDocument(content, opts);
  const t = locateTask(doc, ref);
  if (!t) return null;
  const block = trimBlankLines(doc.lines.slice(t.headingLine, t.endLine));
  const lines = spliceIn(doc.lines, t.headingLine, t.endLine - t.headingLine, []);
  return { content: joinLines(lines, doc.eol), block };
}

/** ブロックID を確実に付ける（リンクを作るときに使う）。既にあれば書き換えない */
export function ensureTaskId(
  content: string,
  ref: TaskRef,
  opts: BlockOptions
): { content: string; id: string } | null {
  const doc = parseBlockDocument(content, opts);
  const t = locateTask(doc, ref);
  if (!t) return null;
  if (t.id) return { content, id: t.id };

  const id = newBlockId();
  const lines = [...doc.lines];
  lines[t.metaLine] = renderMetaLine({ ...t, id }, opts);
  return { content: joinLines(lines, doc.eol), id };
}

/** タスクを時刻順に並べ替える（コマンドから明示的に呼ぶときだけ） */
export function sortTasksByTime(content: string, opts: BlockOptions): string | null {
  const doc = parseBlockDocument(content, opts);
  if (doc.tasks.length < 2) return null;

  const order = [...doc.tasks].sort((a, b) => {
    if (a.start === null && b.start === null) return 0;
    if (a.start === null) return 1; // 未スケジュールは末尾へ
    if (b.start === null) return -1;
    return a.start - b.start || (a.end ?? 0) - (b.end ?? 0);
  });
  if (order.every((t, i) => t === doc.tasks[i])) return null; // 既に並んでいる

  const blocks = doc.tasks.map((t) => trimBlankLines(doc.lines.slice(t.headingLine, t.endLine)));
  const indexOf = new Map(doc.tasks.map((t, i) => [t, i]));

  const first = doc.tasks[0].headingLine;
  const last = doc.tasks[doc.tasks.length - 1].endLine;
  // タスクの間に挟まっていた非タスクの行は消さずに、並べ替えたタスクの後ろへ寄せる
  const between: string[] = [];
  for (let i = 0; i < doc.tasks.length - 1; i++) {
    const gap = doc.lines.slice(doc.tasks[i].endLine, doc.tasks[i + 1].headingLine);
    between.push(...trimBlankLines(gap));
  }

  const rebuilt: string[] = [];
  for (const t of order) {
    if (rebuilt.length) rebuilt.push("");
    rebuilt.push(...blocks[indexOf.get(t) as number]);
  }
  if (between.length) rebuilt.push("", ...between);

  return joinLines(spliceIn(doc.lines, first, last - first, rebuilt), doc.eol);
}

// ---------- 内部処理 ----------

/** 新しいタスクを差し込む行 */
function insertionIndex(
  doc: BlockDocument,
  start: number | null,
  mode: "time" | "end"
): number {
  if (!doc.tasks.length) return doc.scanEnd;
  if (mode === "time" && start !== null) {
    const next = doc.tasks.find((t) => t.start !== null && t.start > start);
    if (next) return next.headingLine;
  }
  return doc.tasks[doc.tasks.length - 1].endLine;
}

/** 親見出しがノートに無いときに末尾へ足す */
function appendRootHeading(content: string, eol: string, opts: BlockOptions): string {
  const { level, text } = parseHeadingSetting(opts.rootHeading);
  const body = content.replace(/\s+$/, "");
  const heading = "#".repeat(level) + " " + text;
  return (body ? body + eol + eol : "") + heading + eol;
}

/** 行を差し替える。継ぎ目の空行が増えたり減ったりしないように整える */
export function spliceIn(
  lines: string[],
  at: number,
  deleteCount: number,
  insert: string[]
): string[] {
  const out = [...lines];
  if (insert.length === 0) {
    out.splice(at, deleteCount);
    while (at > 0 && at < out.length && out[at - 1].trim() === "" && out[at].trim() === "") {
      out.splice(at, 1);
    }
    return out;
  }
  const add = [...insert];
  if (at > 0 && out[at - 1].trim() !== "") add.unshift("");
  const after = out[at + deleteCount];
  if (after !== undefined && after.trim() !== "") add.push("");
  out.splice(at, deleteCount, ...add);
  return out;
}

export function joinLines(lines: string[], eol: string): string {
  return lines.join(eol).replace(/(\r?\n)*$/, "") + eol;
}
