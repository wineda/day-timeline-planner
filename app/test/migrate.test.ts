import { describe, expect, it } from "vitest";
import { parseBlockDocument } from "../src/markdown/blocks";
import { hasLegacyEvents, migrateListToBlocks } from "../src/markdown/migrate";
import { OPTS, fixture } from "./helpers";

describe("旧リスト形式 → ブロック形式", () => {
  const src = fixture("legacy-list.md");
  const opts = { ...OPTS, legacyHeading: "## タイムスケジュール" };

  it("旧形式の予定を検出する", () => {
    expect(hasLegacyEvents(src, "## タイムスケジュール")).toBe(true);
    expect(hasLegacyEvents(fixture("daily-basic.md"), "## タイムスケジュール")).toBe(false);
  });

  it("1行 + ぶら下がりメモ → 見出し + メタ行 + 本文", () => {
    const r = migrateListToBlocks(src, opts)!;
    expect(r.count).toBe(3);
    const doc = parseBlockDocument(r.content, OPTS);
    expect(doc.tasks.map((t) => [t.title, t.start, t.done])).toEqual([
      ["朝会", 540, false],
      ["開発作業", 630, true],
      ["昼休み", 780, false],
    ]);
    expect(doc.tasks[0].details).toEqual(["- 議題: 進捗確認"]);
    expect(doc.tasks.every((t) => t.id?.startsWith("dtp-"))).toBe(true);
    expect(r.content).toContain("## メモ\n自由なメモ。");
  });
});
