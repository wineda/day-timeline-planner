/**
 * 予実レポート・日報（Markdown）の生成。
 * 週の日ごとのタスクを受け取り、日別・タグ別・チケット別の予定/実績/差異の表を組み立てる。
 * 日報（1日ぶん）は summarizeDaily でまとめた中身を、ポップアップ（report-modal.ts）と
 * buildDailyReport（Markdown）で共通に使う。
 * Obsidian の API に依存しない（そのままテストできる）。
 */
import type { Task } from "./model";
import { stripTags } from "./util";

export interface ReportDay {
  date: Date;
  tasks: Task[];
}

export interface ReportOptions {
  /** チケットの URL（無ければ null）。settings.ticketUrl を渡す */
  ticketUrlOf: (tracker: string, id: string) => string | null;
}

const WEEKDAY_JA = ["日", "月", "火", "水", "木", "金", "土"];

/** 分を "6:30" のような時:分表示に。0 は "–" */
function hmm(min: number): string {
  if (!min) return "–";
  return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}`;
}

/** 差異（実績 - 予定）。どちらかが 0 なら比べない */
function diffLabel(plan: number, act: number): string {
  if (!plan || !act) return "";
  const d = act - plan;
  if (d === 0) return "±0:00";
  return `${d > 0 ? "+" : "-"}${hmm(Math.abs(d))}`;
}

function planMin(t: Task): number {
  return t.start !== null && t.end !== null ? t.end - t.start : 0;
}

function actMin(t: Task): number {
  return t.actual.reduce((n, r) => n + (r.end - r.start), 0);
}

function dayLabel(d: Date): string {
  return `${d.getMonth() + 1}/${d.getDate()} (${WEEKDAY_JA[d.getDay()]})`;
}

function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Markdown の表のセル用にエスケープ */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function ticketCell(t: Task, opts: ReportOptions): string {
  if (!t.ticket) return "";
  const label = `${t.ticket.tracker || ""}#${t.ticket.id}`;
  const url = opts.ticketUrlOf(t.ticket.tracker, t.ticket.id);
  return url ? `[${cell(label)}](${url})` : cell(label);
}

interface Bucket {
  count: number;
  plan: number;
  act: number;
}

function add(map: Map<string, Bucket>, key: string, plan: number, act: number): void {
  const b = map.get(key) ?? { count: 0, plan: 0, act: 0 };
  b.count++;
  b.plan += plan;
  b.act += act;
  map.set(key, b);
}

/** 集計表（タグ別・チケット別）を組み立てる */
function bucketTable(header: string, map: Map<string, Bucket>): string[] {
  const out = [`| ${header} | 件数 | 予定 | 実績 | 差異 |`, "| --- | ---: | ---: | ---: | ---: |"];
  const rows = [...map.entries()].sort((a, b) => b[1].act - a[1].act || b[1].plan - a[1].plan);
  for (const [key, b] of rows) {
    out.push(`| ${cell(key)} | ${b.count} | ${hmm(b.plan)} | ${hmm(b.act)} | ${diffLabel(b.plan, b.act)} |`);
  }
  return out;
}

/**
 * 週の予実レポートを Markdown で組み立てる。
 * 予定か実績のあるタスク（自分の予定のみ渡すこと）だけを載せる。
 */
export function buildWeeklyReport(days: ReportDay[], opts: ReportOptions): string {
  const lines: string[] = [];
  const first = days[0]?.date;
  const last = days[days.length - 1]?.date;
  lines.push(`# 予実レポート ${first ? ymd(first) : ""} 〜 ${last ? ymd(last) : ""}`, "");

  // 対象: 予定か実績が入っているタスク
  const rows: { date: Date; task: Task; plan: number; act: number }[] = [];
  for (const day of days) {
    for (const task of day.tasks) {
      if (task.owner) continue; // 念のため（自分の予定だけを対象にする)
      const plan = planMin(task);
      const act = actMin(task);
      if (!plan && !act) continue;
      rows.push({ date: day.date, task, plan, act });
    }
  }

  const totalPlan = rows.reduce((n, r) => n + r.plan, 0);
  const totalAct = rows.reduce((n, r) => n + r.act, 0);
  const doneCount = rows.filter((r) => r.task.done).length;
  lines.push(
    `- 予定合計: **${hmm(totalPlan)}** / 実績合計: **${hmm(totalAct)}**` +
      (totalPlan && totalAct ? ` / 差異: **${diffLabel(totalPlan, totalAct)}**` : ""),
    `- 完了: ${doneCount} / ${rows.length} 件`,
    ""
  );

  if (!rows.length) {
    lines.push("この週には予定・実績のあるタスクがありません。", "");
    return lines.join("\n");
  }

  lines.push("## 日別・タスク別", "");
  lines.push("| 日付 | タスク | チケット | 予定 | 実績 | 差異 | 完了 |");
  lines.push("| --- | --- | --- | ---: | ---: | ---: | :-: |");
  let prevKey = "";
  for (const r of rows) {
    const key = ymd(r.date);
    const dateCell = key === prevKey ? "" : dayLabel(r.date);
    prevKey = key;
    lines.push(
      `| ${dateCell} | ${cell(stripTags(r.task.title) || "(無題)")} | ${ticketCell(r.task, opts)} | ` +
        `${hmm(r.plan)} | ${hmm(r.act)} | ${diffLabel(r.plan, r.act)} | ${r.task.done ? "✅" : r.task.forwarded ? "▶" : ""} |`
    );
  }
  lines.push(`| **合計** | | | **${hmm(totalPlan)}** | **${hmm(totalAct)}** | **${diffLabel(totalPlan, totalAct)}** | |`, "");

  // プロジェクト別
  const byProject = new Map<string, Bucket>();
  for (const r of rows) {
    if (!r.task.project) continue;
    const name = r.task.project.split("/").pop() ?? r.task.project;
    add(byProject, name, r.plan, r.act);
  }
  if (byProject.size) {
    lines.push("## プロジェクト別", "");
    lines.push(...bucketTable("プロジェクト", byProject), "");
  }

  // タグ別（複数タグのタスクは最初のタグに数える）
  const byTag = new Map<string, Bucket>();
  for (const r of rows) add(byTag, r.task.tags.length ? "#" + r.task.tags[0] : "(タグなし)", r.plan, r.act);
  if ([...byTag.keys()].some((k) => k !== "(タグなし)")) {
    lines.push("## タグ別", "");
    lines.push(...bucketTable("タグ", byTag), "");
  }

  // チケット別
  const byTicket = new Map<string, Bucket>();
  for (const r of rows) {
    if (!r.task.ticket) continue;
    add(byTicket, `${r.task.ticket.tracker || ""}#${r.task.ticket.id}`, r.plan, r.act);
  }
  if (byTicket.size) {
    lines.push("## チケット別", "");
    lines.push(...bucketTable("チケット", byTicket), "");
  }

  return lines.join("\n").replace(/\n+$/, "") + "\n";
}

// ---------- 日報（1日ぶん） ----------

/** 日報の1行（予定か実績のあるタスク） */
export interface DailyRow {
  task: Task;
  /** 予定の分数（時刻未定なら 0） */
  plan: number;
  /** 実績の分数（無ければ 0） */
  act: number;
}

/** 集計表の1行（タグ別・プロジェクト別・チケット別） */
export interface DailyBucket {
  key: string;
  count: number;
  plan: number;
  act: number;
}

/** タスクに書かれた記録（結果・ふりかえりなど）を1つにまとめたもの */
export interface DailyNote {
  task: Task;
  /** 見出しに使うタスク名（タグを除いたもの） */
  title: string;
  /** ラベルと中身の組（「結果」「ふりかえり」「残」「次アクション」「原因」「判断」） */
  fields: { label: string; text: string }[];
}

/** 日報の中身。モーダル表示と Markdown 書き出しで同じものを使う */
export interface DailyReport {
  date: Date;
  /** 見出しに使う日付（例: "9/3 (木)"） */
  label: string;
  /** 予定か実績のあるタスク（開始時刻順。時刻未定は後ろ） */
  rows: DailyRow[];
  totalPlan: number;
  totalAct: number;
  /** 数える対象の件数（自分のタスク。持ち越し済み [>] は除く） */
  total: number;
  done: number;
  /** 持ち越し済み [>] の件数 */
  forwarded: number;
  byProject: DailyBucket[];
  byTag: DailyBucket[];
  byTicket: DailyBucket[];
  /** 結果・ふりかえりなどを書いたタスク */
  notes: DailyNote[];
  /** 相手にボールがあるもの（「- 他者:」の行） */
  others: { title: string; text: string }[];
  /** 未完了のまま残ったタスク（持ち越し済みは除く） */
  leftovers: { title: string; nextAction: string }[];
}

/** 開始時刻の順（時刻未定は後ろ）。同じ時刻なら終了時刻の順 */
function byTime(a: Task, b: Task): number {
  return (a.start ?? 1e9) - (b.start ?? 1e9) || (a.end ?? 1e9) - (b.end ?? 1e9);
}

/** 集計の Map を件数・時間の多い順の配列に */
function buckets(map: Map<string, Bucket>): DailyBucket[] {
  return [...map.entries()]
    .map(([key, b]) => ({ key, ...b }))
    .sort((a, b) => b.act - a.act || b.plan - a.plan || a.key.localeCompare(b.key));
}

/** 予定と実績の時間帯（"09:00 - 10:00" / 実績は "/" 区切り）。無ければ "" */
export function planLabel(t: Task): string {
  return t.start !== null && t.end !== null ? `${hhmm(t.start)} - ${hhmm(t.end)}` : "";
}

export function actualLabel(t: Task): string {
  return t.actual.map((r) => `${hhmm(r.start)} - ${hhmm(r.end)}`).join(" / ");
}

function hhmm(min: number): string {
  const m = Math.max(0, Math.round(min));
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** タスクの状態（"✅ 完了" / "▶ 持ち越し" / "中断(…)" / ""） */
export function statusLabel(t: Task): string {
  if (t.done) return "✅ 完了";
  if (t.forwarded) return "▶ 持ち越し";
  if (t.status) return t.status;
  return "";
}

/**
 * 1日ぶんのタスクを日報の材料にまとめる。
 * メンバー（他の人）の予定は数えない。Obsidian に依存しないのでそのままテストできる
 */
export function summarizeDaily(day: ReportDay): DailyReport {
  const mine = day.tasks.filter((t) => !t.owner).sort(byTime);

  const rows: DailyRow[] = [];
  for (const task of mine) {
    const plan = planMin(task);
    const act = actMin(task);
    if (!plan && !act) continue;
    rows.push({ task, plan, act });
  }

  const byProjectMap = new Map<string, Bucket>();
  const byTagMap = new Map<string, Bucket>();
  const byTicketMap = new Map<string, Bucket>();
  for (const r of rows) {
    if (r.task.project) {
      const name = r.task.project.split("/").pop() ?? r.task.project;
      add(byProjectMap, name, r.plan, r.act);
    }
    add(byTagMap, r.task.tags.length ? "#" + r.task.tags[0] : "(タグなし)", r.plan, r.act);
    if (r.task.ticket) add(byTicketMap, `${r.task.ticket.tracker || ""}#${r.task.ticket.id}`, r.plan, r.act);
  }

  const notes: DailyNote[] = [];
  const others: { title: string; text: string }[] = [];
  const leftovers: { title: string; nextAction: string }[] = [];
  for (const task of mine) {
    const title = stripTags(task.title) || "(無題)";
    const fields = [
      { label: "結果", text: task.result },
      { label: "残", text: task.remaining },
      { label: "ふりかえり", text: task.retrospective },
      { label: "原因", text: task.cause },
      { label: "判断", text: task.judgment },
      { label: "次アクション", text: task.nextAction },
    ].filter((f) => f.text.trim());
    if (fields.length) notes.push({ task, title, fields });
    for (const o of task.others) {
      if (o.trim()) others.push({ title, text: o.trim() });
    }
    if (!task.done && !task.forwarded) leftovers.push({ title, nextAction: task.nextAction.trim() });
  }

  const counted = mine.filter((t) => !t.forwarded);
  return {
    date: day.date,
    label: dayLabel(day.date),
    rows,
    totalPlan: rows.reduce((n, r) => n + r.plan, 0),
    totalAct: rows.reduce((n, r) => n + r.act, 0),
    total: counted.length,
    done: counted.filter((t) => t.done).length,
    forwarded: mine.length - counted.length,
    byProject: buckets(byProjectMap),
    byTag: buckets(byTagMap),
    byTicket: buckets(byTicketMap),
    notes,
    others,
    leftovers,
  };
}

/** 集計表（日報用。DailyBucket の配列から） */
function dailyBucketTable(header: string, rows: DailyBucket[]): string[] {
  const out = [`| ${header} | 件数 | 予定 | 実績 | 差異 |`, "| --- | ---: | ---: | ---: | ---: |"];
  for (const b of rows) {
    out.push(`| ${cell(b.key)} | ${b.count} | ${hmm(b.plan)} | ${hmm(b.act)} | ${diffLabel(b.plan, b.act)} |`);
  }
  return out;
}

/** Markdown の箇条書きに収まるよう、改行を「 / 」に畳む */
function inline(text: string): string {
  return text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .join(" / ");
}

/**
 * 1日ぶんの日報を Markdown で組み立てる。
 * 出力: 見出し + 合計 + タスクの表 + 記録（結果・ふりかえり）+ 相手待ち + 残り + 集計
 */
export function buildDailyReport(day: ReportDay, opts: ReportOptions): string {
  const rep = summarizeDaily(day);
  const lines: string[] = [`# 日報 ${ymd(rep.date)} (${WEEKDAY_JA[rep.date.getDay()]})`, ""];

  lines.push(
    `- 予定合計: **${hmm(rep.totalPlan)}** / 実績合計: **${hmm(rep.totalAct)}**` +
      (rep.totalPlan && rep.totalAct ? ` / 差異: **${diffLabel(rep.totalPlan, rep.totalAct)}**` : ""),
    `- 完了: ${rep.done} / ${rep.total} 件` + (rep.forwarded ? `（持ち越し ${rep.forwarded} 件）` : ""),
    ""
  );

  if (!rep.rows.length && !rep.notes.length) {
    lines.push("この日には予定・実績のあるタスクがありません。", "");
    return lines.join("\n");
  }

  if (rep.rows.length) {
    lines.push("## タスク", "");
    lines.push("| 時間 | タスク | チケット | 予定 | 実績 | 差異 | 状態 |");
    lines.push("| --- | --- | --- | ---: | ---: | ---: | :-: |");
    for (const r of rep.rows) {
      lines.push(
        `| ${cell(planLabel(r.task) || "時刻未定")} | ${cell(stripTags(r.task.title) || "(無題)")} | ` +
          `${ticketCell(r.task, opts)} | ${hmm(r.plan)} | ${hmm(r.act)} | ${diffLabel(r.plan, r.act)} | ` +
          `${cell(statusLabel(r.task))} |`
      );
    }
    lines.push(
      `| **合計** | | | **${hmm(rep.totalPlan)}** | **${hmm(rep.totalAct)}** | ` +
        `**${diffLabel(rep.totalPlan, rep.totalAct)}** | |`,
      ""
    );
  }

  if (rep.notes.length) {
    lines.push("## 記録", "");
    for (const n of rep.notes) {
      lines.push(`- **${inline(n.title)}**`);
      for (const f of n.fields) lines.push(`    - ${f.label}: ${inline(f.text)}`);
    }
    lines.push("");
  }

  if (rep.others.length) {
    lines.push("## 相手待ち", "");
    for (const o of rep.others) lines.push(`- ${inline(o.text)}（${inline(o.title)}）`);
    lines.push("");
  }

  if (rep.leftovers.length) {
    lines.push("## 残っているタスク", "");
    for (const l of rep.leftovers) {
      lines.push(`- ${inline(l.title)}` + (l.nextAction ? ` … 次アクション: ${inline(l.nextAction)}` : ""));
    }
    lines.push("");
  }

  if (rep.byProject.length) lines.push("## プロジェクト別", "", ...dailyBucketTable("プロジェクト", rep.byProject), "");
  if (rep.byTag.some((b) => b.key !== "(タグなし)")) lines.push("## タグ別", "", ...dailyBucketTable("タグ", rep.byTag), "");
  if (rep.byTicket.length) lines.push("## チケット別", "", ...dailyBucketTable("チケット", rep.byTicket), "");

  return lines.join("\n").replace(/\n+$/, "") + "\n";
}
