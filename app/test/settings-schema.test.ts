import { describe, expect, it } from "vitest";
import { FIELDS, fieldByLabel } from "../src/markdown/fields";
import {
  DEFAULT_PLACEHOLDERS,
  DEFAULT_TAG_FIELD_SCHEMA,
  DONE_ONLY_FIELDS,
  PLACEHOLDER_FIELDS,
} from "../src/settings";

/**
 * 設定（タグ別フィールド）が使う「欄名」と、保存形式のフィールド定義（fields.ts）の整合。
 * フィールドを足したり名前を変えたりしたときに、設定側の文字列が取り残されるのを防ぐ
 */
describe("タグ別フィールドの既定値と fields.ts の整合", () => {
  const labels = new Set(FIELDS.map((f) => f.label));

  it("required / suggested の欄名はすべて fields.ts に定義されたラベル", () => {
    for (const s of DEFAULT_TAG_FIELD_SCHEMA) {
      for (const name of [...s.required, ...s.suggested]) {
        expect(labels.has(name), `#${s.tag} の欄「${name}」`).toBe(true);
      }
    }
  });

  it("required / suggested に挙がるのは AI が読む欄（記録タブ）だけ", () => {
    for (const s of DEFAULT_TAG_FIELD_SCHEMA) {
      for (const name of [...s.required, ...s.suggested]) {
        expect(fieldByLabel(name)?.aiReads, `#${s.tag} の欄「${name}」`).toBe(true);
      }
    }
  });

  it("完了時だけ必須の欄は fields.ts のラベル", () => {
    for (const name of DONE_ONLY_FIELDS) expect(labels.has(name), name).toBe(true);
  });

  it("プレースホルダーの欄名は、フィールドのラベルか、ダイアログ固有の欄（タイトル・他者の相手/内容・中断理由・備考）", () => {
    const dialogOnly = new Set(["タイトル", "他者/相手", "他者/内容", "中断理由", "備考"]);
    for (const name of PLACEHOLDER_FIELDS) {
      expect(labels.has(name) || dialogOnly.has(name), name).toBe(true);
      expect(DEFAULT_PLACEHOLDERS[name].trim(), name).not.toBe("");
    }
    for (const s of DEFAULT_TAG_FIELD_SCHEMA) {
      for (const name of Object.keys(s.placeholders ?? {})) {
        expect((PLACEHOLDER_FIELDS as readonly string[]).includes(name), `#${s.tag} の文言「${name}」`).toBe(true);
      }
    }
  });
});
