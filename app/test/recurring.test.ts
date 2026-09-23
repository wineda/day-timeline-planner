/**
 * recurring.ts: 定期タスクの実体化（帳簿を先に保存・直列化・失敗時の後始末）と、
 * blockId だけで照合すること（手書きの同名タスクを取り違えない）
 */
import { describe, expect, it, vi } from "vitest";
import type DayTimelinePlugin from "../src/main";
import {
  applyRecurring,
  dateFromKey,
  describeRule,
  instanceOf,
  occurrenceInfo,
  parseTimeRange,
  propagateRecurringUpdate,
  reapplyOccurrence,
  setInstance,
  skipOccurrence,
  stepsMatchRule,
} from "../src/recurring";
import { BlockTaskStore } from "../src/store";
import { DEFAULT_SETTINGS, type DayTimelineSettings, type RecurringRule } from "../src/settings";
import { addDays, dateKey, startOfDay } from "../src/util";
import { FakeVault, fakeApp } from "./fake-vault";

const today = startOfDay(new Date());
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

function rule(over: Partial<RecurringRule> = {}): RecurringRule {
  return { id: "r1", title: "朝会", weekdays: ALL_DAYS, start: 540, end: 570, enabled: true, ...over };
}

type FakePlugin = DayTimelinePlugin & {
  vault: FakeVault;
  store: BlockTaskStore;
  persistFail: Error | null;
};

/** applyRecurring が使う分だけのプラグインの代わり（settings / blockStore / persistSettings） */
function makePlugin(rules: RecurringRule[]): FakePlugin {
  const vault = new FakeVault();
  const settings: DayTimelineSettings = {
    ...DEFAULT_SETTINGS,
    deletionLog: false,
    recurring: rules,
    recurringInstances: {},
  };
  const store = new BlockTaskStore(fakeApp(vault), () => settings);
  const p = {
    vault,
    settings,
    store,
    persistFail: null as Error | null,
    blockStore: () => store,
    async persistSettings() {
      if (p.persistFail) throw p.persistFail;
      vault.ops.push("persist");
    },
  };
  return p as unknown as FakePlugin;
}

const key = dateKey(today);

describe("applyRecurring: 実体化", () => {
  it("帳簿を先に保存してからノートに書く。書いたタスクは帳簿のブロック ID で追える", async () => {
    const p = makePlugin([rule()]);
    expect(await applyRecurring(p, [today])).toBe(1);
    const tasks = (await p.store.load(today)).tasks;
    expect(tasks.map((t) => [t.title, t.start, t.end])).toEqual([["朝会", 540, 570]]);
    expect(instanceOf(p.settings, key, "r1")?.blockId).toBe(tasks[0].blockId);
    const path = p.store.pathFor(today);
    expect(p.vault.ops).toEqual(["persist", `create ${path}`, `process ${path}`]);
    expect((await occurrenceInfo(p, rule(), today)).kind).toBe("applied");
  });

  it("同時に 2 回呼んでも、あとでもう一度呼んでも 1 回しか入れない", async () => {
    const p = makePlugin([rule()]);
    const counts = await Promise.all([applyRecurring(p, [today]), applyRecurring(p, [today])]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
    expect(await applyRecurring(p, [today])).toBe(0);
    expect((await p.store.load(today)).tasks).toHaveLength(1);
  });

  it("今日より前の日と、曜日の合わない日には入れない", async () => {
    const p = makePlugin([rule({ weekdays: [(today.getDay() + 3) % 7] })]);
    expect(await applyRecurring(p, [addDays(today, -1), today])).toBe(0);
    expect(p.vault.files.size).toBe(0);
  });

  it("ノートに書けなかった回は帳簿を戻し、次に表示したときにもう一度入れる", async () => {
    const p = makePlugin([rule()]);
    const path = p.store.pathFor(today);
    p.vault.failWith = (f, op) => (op === "process" && f === path ? new Error("disk full") : null);
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {}); // 失敗のログは期待どおり
    expect(await applyRecurring(p, [today])).toBe(0);
    quiet.mockRestore();
    expect(instanceOf(p.settings, key, "r1")).toBeUndefined();
    p.vault.failWith = null;
    expect(await applyRecurring(p, [today])).toBe(1);
    expect((await p.store.load(today)).tasks).toHaveLength(1);
  });

  it("帳簿を保存できなければノートには書かず、メモリ上の記録も戻す", async () => {
    const p = makePlugin([rule()]);
    p.persistFail = new Error("data.json を書けない");
    await expect(applyRecurring(p, [today])).rejects.toThrow("data.json");
    expect(p.vault.files.size).toBe(0);
    expect(instanceOf(p.settings, key, "r1")).toBeUndefined();
  });

  it("取り消した日は入れない。入れ直すと入る", async () => {
    const p = makePlugin([rule()]);
    expect(await skipOccurrence(p, rule(), today)).toBe(false);
    expect(await applyRecurring(p, [today])).toBe(0);
    expect((await occurrenceInfo(p, rule(), today)).kind).toBe("skipped");
    expect(await reapplyOccurrence(p, rule(), today)).toBe(true);
    expect((await p.store.load(today)).tasks).toHaveLength(1);
  });

  it("書き込み済みの日を取り消すとノートのタスクも消える", async () => {
    const p = makePlugin([rule()]);
    await applyRecurring(p, [today]);
    expect(await skipOccurrence(p, rule(), today)).toBe(true);
    expect((await p.store.load(today)).tasks).toHaveLength(0);
    expect(instanceOf(p.settings, key, "r1")).toEqual({ blockId: null, skipped: true });
  });

  it("個別調整の時刻・詳細で入り、その回は detached になる", async () => {
    const p = makePlugin([rule({ details: "共通メモ" })]);
    setInstance(p.settings, key, "r1", { blockId: null, override: { start: 600, end: 660, details: "今日だけ" } });
    expect((await occurrenceInfo(p, rule(), today)).kind).toBe("pending-custom");
    await applyRecurring(p, [today]);
    const t = (await p.store.load(today)).tasks[0];
    expect([t.start, t.end, t.details]).toEqual([600, 660, "今日だけ"]);
    expect(instanceOf(p.settings, key, "r1")?.detached).toBe(true);
    expect((await occurrenceInfo(p, rule(), today)).kind).toBe("applied-custom");
  });
});

describe("照合は blockId だけ", () => {
  it("手書きの同名タスクがあっても「未反映」のまま（入れると 2 件になる）", async () => {
    const p = makePlugin([rule()]);
    await p.store.create(today, { title: "朝会", start: 540, end: 570, done: false });
    expect((await occurrenceInfo(p, rule(), today)).kind).toBe("pending");
    expect(await applyRecurring(p, [today])).toBe(1);
    expect((await p.store.load(today)).tasks).toHaveLength(2);
  });

  it("記録のブロックがノートに無ければ「削除されています」。勝手には復活しない", async () => {
    const p = makePlugin([rule()]);
    await applyRecurring(p, [today]);
    const t = (await p.store.load(today)).tasks[0];
    await p.store.remove(today, t);
    expect((await occurrenceInfo(p, rule(), today)).kind).toBe("missing");
    expect(await applyRecurring(p, [today])).toBe(0);
  });
});

describe("propagateRecurringUpdate: ルール編集の反映", () => {
  it("ルール由来のタスクだけ書き換え、同名の手書きタスクは触らない", async () => {
    const prev = rule();
    const p = makePlugin([prev]);
    await applyRecurring(p, [today]);
    await p.store.create(today, { title: "朝会", start: 540, end: 570, done: false });
    const next = rule({ title: "朝会（新）", start: 600, end: 630 });
    p.settings.recurring = [next];
    expect(await propagateRecurringUpdate(p, next, prev)).toEqual({
      updated: 1,
      removed: 0,
      keptCustom: 0,
      keptEdited: 0,
    });
    const tasks = (await p.store.load(today)).tasks.map((t) => [t.title, t.start]);
    expect(tasks).toContainEqual(["朝会（新）", 600]);
    expect(tasks).toContainEqual(["朝会", 540]);
  });

  it("曜日から外れた日は、手つかずなら消し、編集済みなら残す", async () => {
    const prev = rule();
    const p = makePlugin([prev]);
    const tomorrow = addDays(today, 1);
    await applyRecurring(p, [today, tomorrow]);
    // 明日の分には本文を書き足してある
    const t2 = (await p.store.load(tomorrow)).tasks[0];
    await p.store.update(tomorrow, t2, { title: t2.title, start: t2.start, end: t2.end, done: false, details: "準備メモ" });
    const next = rule({ weekdays: [(today.getDay() + 3) % 7] }); // 今日でも明日でもない曜日
    p.settings.recurring = [next];
    expect(await propagateRecurringUpdate(p, next, prev)).toEqual({
      updated: 0,
      removed: 1,
      keptCustom: 0,
      keptEdited: 1,
    });
    expect((await p.store.load(today)).tasks).toHaveLength(0);
    expect(instanceOf(p.settings, key, "r1")).toBeUndefined();
    expect((await p.store.load(tomorrow)).tasks.map((t) => t.details)).toEqual(["準備メモ"]);
  });

  it("個別調整した回（detached）は触らない", async () => {
    const prev = rule();
    const p = makePlugin([prev]);
    setInstance(p.settings, key, "r1", { blockId: null, override: { start: 600, end: 660 } });
    await applyRecurring(p, [today]);
    const next = rule({ title: "朝会（新）" });
    p.settings.recurring = [next];
    expect(await propagateRecurringUpdate(p, next, prev)).toMatchObject({ updated: 0, keptCustom: 1 });
    expect((await p.store.load(today)).tasks[0].title).toBe("朝会");
  });
});

describe("純関数", () => {
  it("parseTimeRange: 両方空なら時刻なし、片方だけ・逆順はエラー、翌日 0:00 は 24:00", () => {
    expect(parseTimeRange("", "")).toEqual({ start: null, end: null });
    expect(parseTimeRange("9:00", "9:30")).toEqual({ start: 540, end: 570 });
    expect(parseTimeRange("9:00", "")).toHaveProperty("error");
    expect(parseTimeRange("10:00", "9:00")).toHaveProperty("error");
    expect(parseTimeRange("23:00", "0:00")).toEqual({ start: 1380, end: 1440 });
  });

  it("describeRule / stepsMatchRule / dateFromKey", () => {
    expect(describeRule(rule())).toBe("毎日　09:00 - 09:30");
    expect(describeRule(rule({ weekdays: [1, 3, 5], start: null, end: null }))).toBe("毎週 月・水・金　時刻なし（未スケジュール）");
    const r = rule({ steps: ["a", " b "] });
    expect(stepsMatchRule([{ text: "a", done: false, children: [] }, { text: "b", done: false, children: [] }], r)).toBe(true);
    expect(stepsMatchRule([{ text: "a", done: true, children: [] }, { text: "b", done: false, children: [] }], r)).toBe(false);
    expect(stepsMatchRule([], rule())).toBe(true);
    expect(dateFromKey("2026-09-25")?.getTime()).toBe(new Date(2026, 8, 25).getTime());
    expect(dateFromKey("broken")).toBeNull();
  });
});
