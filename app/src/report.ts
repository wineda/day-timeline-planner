/**
 * 予実レポート（Markdown）の生成。
 * 週の日ごとのタスクを受け取り、日別・タグ別・チケット別の予定/実績/差異の表を組み立てる。
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
        `${hmm(r.plan)} | ${hmm(r.act)} | ${diffLabel(r.plan, r.act)} | ${r.task.done ? "✅" : ""} |`
    );
  }
  lines.push(`| **合計** | | | **${hmm(totalPlan)}** | **${hmm(totalAct)}** | **${diffLabel(totalPlan, totalAct)}** | |`, "");

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
