import { describe, expect, it } from "vitest";
import { parseBlockDocument } from "../src/markdown/blocks";
import {
  ensureTaskId,
  insertTask,
  removeTask,
  sortTasksByTime,
  updateTask,
} from "../src/markdown/edit";
import { INSERT_OPTS, OPTS, changedLines, fixture } from "./helpers";

const ref = (id: string) => ({ id, title: "", start: null, end: null });

describe("updateTask: ブロック単位の部分置換", () => {
  const src = fixture("daily-basic.md");

  it("時刻とタイトルの変更は見出し行とメタ行の2行だけを書き換える", () => {
    const out = updateTask(src, ref("dtp-9b2c44"), { title: "設計レビュー #work", start: 11 * 60, end: 12 * 60 }, OPTS);
    expect(out).not.toBeNull();
    expect(changedLines(src, out!)).toBe(4); // 2行の削除 + 2行の追加
    const t = parseBlockDocument(out!, OPTS).tasks[1];
    expect(t.title).toBe("設計レビュー #work");
    expect(t.start).toBe(11 * 60);
    expect(t.reminder).toBe(10); // メタ行の他の情報は保持
    expect(t.steps).toHaveLength(2);
  });

  it("本文のメモ（詳細）には触れない", () => {
    const out = updateTask(src, ref("dtp-k3f9a2"), { done: false }, OPTS)!;
    expect(out).toContain("議題: 進捗確認\n決定: リリースは金曜");
    expect(parseBlockDocument(out, OPTS).tasks[0].done).toBe(false);
  });

  it("フィールドを空にすると行ごと消え、値を入れると行が足される", () => {
    const cleared = updateTask(src, ref("dtp-k3f9a2"), { doneCondition: "", actual: [] }, OPTS)!;
    expect(cleared).not.toContain("- 完了条件:");
    expect(cleared).not.toContain("- 実績:");
    const added = updateTask(cleared, ref("dtp-k3f9a2"), { result: "担当決定", doneCondition: "戻した" }, OPTS)!;
    const t = parseBlockDocument(added, OPTS).tasks[0];
    expect(t.result).toBe("担当決定");
    expect(t.doneCondition).toBe("戻した");
    expect(t.steps).toHaveLength(2);
    expect(t.details).toEqual(["議題: 進捗確認", "決定: リリースは金曜"]);
  });

  it("他者は複数行を前から書き換え、余りを消し、足りない分を足す", () => {
    const fields = fixture("daily-fields.md");
    const fewer = updateTask(fields, ref("dtp-a1b2c3"), { others: ["山田 / 確認"] }, OPTS)!;
    expect(parseBlockDocument(fewer, OPTS).tasks[0].others).toEqual(["山田 / 確認"]);
    const more = updateTask(fields, ref("dtp-a1b2c3"), { others: ["a / 1", "b / 2", "c / 3"] }, OPTS)!;
    expect(parseBlockDocument(more, OPTS).tasks[0].others).toEqual(["a / 1", "b / 2", "c / 3"]);
  });

  it("旧表記の「期日:」は保存時に「期限:」へ統一される", () => {
    const fields = fixture("daily-fields.md");
    const out = updateTask(fields, ref("dtp-d4e5f6"), { due: "2026-09-01" }, OPTS)!;
    expect(out).toContain("- 期限: 2026-09-01");
    expect(out).not.toContain("期日:");
  });

  it("手書きブロック（ID 無し）は更新時に ID が付く", () => {
    const out = updateTask(src, { id: null, title: "手書きのタスク", start: 13 * 60, end: 13 * 60 + 30 }, { done: true }, OPTS)!;
    const t = parseBlockDocument(out, OPTS).tasks[3];
    expect(t.id).toMatch(/^dtp-/);
    expect(t.done).toBe(true);
  });

  it("forward で [>] になり、持ち越し先が書かれる", () => {
    const out = updateTask(src, ref("dtp-9b2c44"), { forward: true, carryTo: "2026-08-19#^dtp-next" }, OPTS)!;
    const t = parseBlockDocument(out, OPTS).tasks[1];
    expect(t.checkChar).toBe(">");
    expect(t.carryTo).toBe("2026-08-19#^dtp-next");
  });

  it("見つからなければ null", () => {
    expect(updateTask(src, ref("dtp-nope"), { done: true }, OPTS)).toBeNull();
  });
});

describe("insertTask / removeTask / ensureTaskId / sortTasksByTime", () => {
  const src = fixture("daily-basic.md");

  it("時刻順の位置に差し込む（次に始まるタスクの手前）", () => {
    const out = insertTask(src, { title: "昼食", start: 12 * 60, end: 13 * 60, done: false, details: "社食" }, INSERT_OPTS);
    const titles = parseBlockDocument(out, OPTS).tasks.map((t) => t.title);
    // 未スケジュールのタスクは飛ばして、次に始まる時刻付きタスク（13:00）の手前に入る
    expect(titles).toEqual(["朝会", "設計レビューの準備 #work", "メールの棚卸し", "昼食", "手書きのタスク"]);
    expect(out).toContain("## 昼食\n- [ ] 12:00 - 13:00 ^dtp-");
    expect(out).toContain("\n\n社食\n");
  });

  it("空のノートにはブロックだけを書く。親見出しが無ければ作る", () => {
    expect(insertTask("", { title: "A", start: null, end: null, done: false }, INSERT_OPTS)).toMatch(/^## A\n- \[ \] \^dtp-\w+\n$/);
    const withRoot = insertTask("# メモ\n", { title: "A", start: 600, end: 660, done: false }, { ...INSERT_OPTS, rootHeading: "## 予定" });
    expect(withRoot).toBe("# メモ\n\n## 予定\n\n## A\n- [ ] 10:00 - 11:00 " + /\^dtp-\w+/.exec(withRoot)![0] + "\n");
  });

  it("removeTask はブロック全体を消し、消した行を返す", () => {
    const r = removeTask(src, ref("dtp-k3f9a2"), OPTS)!;
    expect(r.block[0]).toBe("## 朝会");
    expect(r.block).toContain("決定: リリースは金曜");
    expect(parseBlockDocument(r.content, OPTS).tasks.map((t) => t.title)).not.toContain("朝会");
    expect(r.content).toContain("今日のメモ。");
  });

  it("ensureTaskId は無いときだけ付ける", () => {
    const same = ensureTaskId(src, ref("dtp-k3f9a2"), OPTS)!;
    expect(same.content).toBe(src);
    const added = ensureTaskId(src, { id: null, title: "手書きのタスク", start: 780, end: 810 }, OPTS)!;
    expect(added.id).toMatch(/^dtp-/);
    expect(added.content).toContain(`- 13:00 - 13:30 ^${added.id}`);
  });

  it("sortTasksByTime は未スケジュールを末尾へ、非タスク行は残す", () => {
    const shuffled = insertTask(src, { title: "早朝", start: 7 * 60, end: 8 * 60, done: false }, { ...INSERT_OPTS, insertPosition: "end" });
    const sorted = sortTasksByTime(shuffled, OPTS)!;
    const titles = parseBlockDocument(sorted, OPTS).tasks.map((t) => t.title);
    expect(titles).toEqual(["早朝", "朝会", "設計レビューの準備 #work", "手書きのタスク", "メールの棚卸し"]);
    expect(sorted).toContain("今日のメモ。");
    expect(sorted).toContain("## 振り返り");
    expect(sortTasksByTime(sorted, OPTS)).toBeNull(); // 並び済み
  });
});
