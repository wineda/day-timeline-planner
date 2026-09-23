/**
 * settings.ts: 保存されている設定の移行。廃止したキーが落ち、帳簿が壊れずに引き継がれること
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, SETTINGS_VERSION, migrateSettings, type DayTimelineSettings } from "../src/settings";

const load = (loaded: Record<string, unknown>) => migrateSettings(loaded as unknown as Partial<DayTimelineSettings>);

describe("migrateSettings: 定期タスクの帳簿", () => {
  it("v10 の recurringApplied を recurringInstances に畳み、キーを落とす", () => {
    const s = load({
      settingsVersion: 10,
      recurringApplied: { "2026-10-01": ["r1", "r2"], "2026-10-02": ["r1"] },
      recurringInstances: { "2026-10-01": { r1: { blockId: "b1" } } },
    });
    expect(s.settingsVersion).toBe(SETTINGS_VERSION);
    expect(s.recurringInstances).toEqual({
      "2026-10-01": { r1: { blockId: "b1" }, r2: { blockId: null, skipped: true } },
      "2026-10-02": { r1: { blockId: null, skipped: true } },
    });
    expect("recurringApplied" in s).toBe(false);
  });

  it("旧形式（文字列）の記録はオブジェクトに揃え、壊れた値は捨てる", () => {
    const s = load({ settingsVersion: 2, recurringInstances: { "2026-10-01": { r1: "b1", r2: 5 }, "2026-10-02": "x" } });
    expect(s.recurringInstances).toEqual({ "2026-10-01": { r1: { blockId: "b1" } } });
  });

  it("既定のオブジェクトを共有しない（2 回読んでも帳簿が混ざらない）", () => {
    const a = load({});
    a.recurringInstances["2026-10-01"] = { r1: { blockId: "x" } };
    expect(load({}).recurringInstances).toEqual({});
    expect(DEFAULT_SETTINGS.recurringInstances).toEqual({});
  });

  it("廃止した設定のキーは落ちる", () => {
    const s = load({ settingsVersion: 9, bossBattle: true, sidebarTab: "inbox", storageFormat: "list" });
    for (const k of ["bossBattle", "storageFormat", "recurringApplied"]) expect(k in s, k).toBe(false);
  });
});
