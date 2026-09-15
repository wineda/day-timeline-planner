import { describe, expect, it } from "vitest";
import {
  FIELDS,
  HEAD_FIELDS,
  RECORD_FIELDS,
  TEXT_FIELDS,
  emptyTextFields,
  fieldByLabel,
  matchFieldLine,
  parseFieldLine,
  pickTextFields,
  renderFieldLine,
} from "../src/markdown/fields";
import { parseBlockDocument, renderFieldLineOf } from "../src/markdown/blocks";
import { OPTS } from "./helpers";

describe("フィールド定義（fields.ts）の整合性", () => {
  it("key とラベル（別表記を含む）が重複していない", () => {
    const keys = FIELDS.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    const labels = FIELDS.flatMap((f) => [f.label, ...f.aliases].map((l) => l.toLowerCase()));
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("head 領域 → record 領域の順に並び、挿入位置が領域と矛盾しない", () => {
    const zones = FIELDS.map((f) => f.zone);
    const firstRecord = zones.indexOf("record");
    expect(zones.slice(0, firstRecord).every((z) => z === "head")).toBe(true);
    expect(zones.slice(firstRecord).every((z) => z === "record")).toBe(true);
    for (const f of HEAD_FIELDS) expect(f.insertAt).not.toBe("afterSteps");
    for (const f of RECORD_FIELDS) expect(f.insertAt).toBe("afterSteps");
  });

  it("説明と実例が全フィールドにある（README / AI 向け仕様の生成に使う）", () => {
    for (const f of FIELDS) {
      expect(f.description.trim(), f.key).not.toBe("");
      expect(f.example.trim(), f.key).not.toBe("");
    }
  });

  it("実例は自分の定義で読める（ラベル: 実例 → 実例）", () => {
    for (const f of FIELDS) {
      expect(parseFieldLine(f.key, renderFieldLine(f.key, f.example)), f.key).toBe(f.example);
      expect(matchFieldLine(`- ${f.label}: ${f.example}`)?.def.key).toBe(f.key);
    }
  });

  it("別表記・太字・全角コロン・リスト記号なしも読み、大文字小文字は Owner だけ無視する", () => {
    expect(parseFieldLine("due", "- 期日: 2026-01-01")).toBe("2026-01-01");
    expect(parseFieldLine("retrospective", "振り返り：よかった")).toBe("よかった");
    expect(parseFieldLine("doneCondition", "**完了条件**: レビュー通過")).toBe("レビュー通過");
    expect(parseFieldLine("ownerName", "- owner: 田中")).toBe("田中");
    expect(parseFieldLine("result", "- 結果:")).toBe("");
    expect(parseFieldLine("result", "- 結果的には: x")).toBeNull();
    expect(parseFieldLine("remaining", "- 残り: x")).toBeNull();
    expect(matchFieldLine("ただの本文")).toBeNull();
  });

  it("書き出しは1つの表記に固定される（別表記で読んでも正規のラベルで書く）", () => {
    expect(renderFieldLineOf("due", "2026-01-01")).toEqual(["- 期限: 2026-01-01"]);
    expect(renderFieldLineOf("retrospective", " よかった ")).toEqual(["- ふりかえり: よかった"]);
    expect(renderFieldLineOf("project", "Timeline/Projects/A")).toEqual(["- プロジェクト: [[Timeline/Projects/A]]"]);
    expect(renderFieldLineOf("actual", [{ start: 540, end: 600 }])).toEqual(["- 実績: 09:00 - 10:00"]);
    expect(renderFieldLineOf("others", ["a / 1", " ", "b / 2"])).toEqual(["- 他者: a / 1", "- 他者: b / 2"]);
    expect(renderFieldLineOf("result", "  ")).toEqual([]);
    expect(renderFieldLineOf("project", null)).toEqual([]);
    expect(renderFieldLineOf("actual", [])).toEqual([]);
  });

  it("TaskBlock には text フィールドごとに key と keyLine が生える", () => {
    const doc = parseBlockDocument("## A\n- [ ] ^dtp-x\n- 結果: done\n", OPTS);
    const t = doc.tasks[0] as unknown as Record<string, unknown>;
    for (const f of TEXT_FIELDS) {
      expect(typeof t[f.key], f.key).toBe("string");
      expect(t[`${f.key}Line`] === null || typeof t[`${f.key}Line`] === "number", f.key).toBe(true);
    }
    expect(t.result).toBe("done");
    expect(t.resultLine).toBe(2);
  });

  it("emptyTextFields / pickTextFields は text フィールドだけを扱う", () => {
    const empty = emptyTextFields() as Record<string, string>;
    expect(Object.keys(empty).sort()).toEqual(TEXT_FIELDS.map((f) => f.key).sort());
    expect(Object.values(empty).every((v) => v === "")).toBe(true);
    const picked = pickTextFields({ result: "r", due: "d" }) as Record<string, string>;
    expect(picked.result).toBe("r");
    expect(picked.due).toBe("d");
    expect(picked.cause).toBe("");
    expect("others" in picked).toBe(false);
  });

  it("ダイアログの欄名（ラベル）からフィールドを引ける", () => {
    expect(fieldByLabel("結果")?.key).toBe("result");
    expect(fieldByLabel("Owner")?.key).toBe("ownerName");
    expect(fieldByLabel("期日")).toBeNull(); // 別表記は欄名ではない
  });
});
