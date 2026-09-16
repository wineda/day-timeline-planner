import { describe, expect, it } from "vitest";
import { parseBlockDocument, renderTaskBlock } from "../src/markdown/blocks";
import { FIELDS, FORMAT_VERSION, TEXT_FIELDS } from "../src/markdown/fields";
import {
  EXAMPLE_OPTIONS,
  defaultSpecContext,
  exampleCarrySources,
  exampleOptionsOf,
  exampleTaskSource,
  renderFieldList,
  renderFieldTable,
  renderFormatSpec,
} from "../src/spec";

describe("仕様書の生成（spec.ts）", () => {
  it("実例タスクは全フィールドを持ち、書き出して読み戻すと fields.ts の実例と一致する", () => {
    const lines = renderTaskBlock(exampleTaskSource(), EXAMPLE_OPTIONS);
    const doc = parseBlockDocument(lines.join("\n") + "\n", EXAMPLE_OPTIONS);
    expect(doc.tasks).toHaveLength(1);
    const t = doc.tasks[0] as unknown as Record<string, unknown>;
    for (const f of TEXT_FIELDS) expect(t[f.key], f.key).toBe(f.example);
    expect(t.others).toEqual([FIELDS.find((f) => f.key === "others")!.example, "佐藤 / 影響範囲の確認"]);
    expect(t.project).toBe("Timeline/Projects/環境構築");
    expect(t.actual).toEqual([
      { start: 9 * 60 + 15, end: 9 * 60 + 45 },
      { start: 13 * 60, end: 13 * 60 + 30 },
    ]);
    expect(t.ticket).toEqual({ tracker: "redmine", id: "65130" });
    expect(t.reminder).toBe(10);
    expect(t.done).toBe(true);
    expect((t.steps as unknown[]).length).toBe(2);
    expect(t.details).toEqual(["詳細のメモ。ここは自由な Markdown で、プラグインは触らない。", "- 箇条書きも書ける"]);
  });

  it("持ち越しの実例は [>] と持ち越し先・持ち越し元を持つ", () => {
    const { from, to } = exampleCarrySources();
    const doc = parseBlockDocument(
      [...renderTaskBlock(from, EXAMPLE_OPTIONS), "", ...renderTaskBlock(to, EXAMPLE_OPTIONS)].join("\n") + "\n",
      EXAMPLE_OPTIONS
    );
    expect(doc.tasks).toHaveLength(2);
    expect(doc.tasks[0].checkChar).toBe(">");
    // 元のブロックの持ち越し先は続きのブロックの ID を、続きのブロックの持ち越し元は元のブロックの ID を指す
    expect(doc.tasks[0].carryTo).toBe(`2026-08-19#^${doc.tasks[1].id}`);
    expect(doc.tasks[1].carryFrom).toBe(`2026-08-18#^${doc.tasks[0].id}`);
    expect(doc.tasks[1].start).toBeNull();
  });

  it("README 用の一覧と仕様書の表は、全フィールドを 1 件 1 行で持つ", () => {
    const list = renderFieldList().split("\n");
    expect(list).toHaveLength(FIELDS.length);
    for (const f of FIELDS) {
      expect(list.some((l) => l.startsWith(`- **${f.label}** = 本文中の \`- ${f.label}: ${f.example}\` 行`)), f.key).toBe(true);
    }
    const table = renderFieldTable().split("\n").slice(2);
    expect(table).toHaveLength(FIELDS.length);
    expect(table.find((r) => r.startsWith("| `期限`"))).toContain("`期日`");
    expect(table.find((r) => r.startsWith("| `他者`"))).toContain("（複数行可）");
    expect(table.find((r) => r.startsWith("| `状態`"))).toContain("中断(理由)");
  });

  it("仕様書の全文: frontmatter に版、全フィールドの表、実例、保管庫の設定が入る", () => {
    const ctx = {
      ...defaultSpecContext("2.117.0"),
      folder: "Work",
      trackers: ["gitea", "redmine"],
      members: [{ name: "田中", folder: "Work/Members/田中" }],
    };
    const md = renderFormatSpec(ctx);
    expect(md.startsWith(`---\nformat_version: "${FORMAT_VERSION}"\nplugin_version: "2.117.0"\n`)).toBe(true);
    for (const f of FIELDS) expect(md).toContain(`| \`${f.label}\``);
    expect(md).toContain("`Work/YYYY-MM-DD.md`");
    expect(md).toContain("`Work/Projects/<名前>.md`");
    expect(md).toContain("メンバー: 田中（`Work/Members/田中/`）");
    expect(md).toContain("## 誤検知の調査 #障害");
    expect(md).not.toContain("generated_at");
    expect(renderFormatSpec({ ...ctx, generatedAt: "2026-09-15 10:00" })).toContain("generated_at: 2026-09-15 10:00");
  });

  it("チケット管理ツールの先頭を、実例ブロックとメタ行の説明の両方に使う", () => {
    const md = renderFormatSpec({ ...defaultSpecContext("x"), trackers: ["gitea", "redmine"] });
    expect(md).toContain("- [x] 10:00 - 11:00 🎫gitea#65130 🔔10 ^dtp-k3f9a2");
    expect(md).not.toContain("🎫redmine#65130");
    expect(md).toContain("先頭のツール: gitea / redmine");
  });

  it("レポートのファイル名は設定の日付形式によらず YYYY-MM-DD（プラグインの書き出しと同じ）", () => {
    const md = renderFormatSpec({ ...defaultSpecContext("x"), dateFormat: "YYYYMMDD" });
    expect(md).toContain("`Timeline/YYYYMMDD.md`"); // 日付ノートは設定どおり
    expect(md).toContain("`Timeline/Reports/日報 YYYY-MM-DD.md`、`Timeline/Reports/予実レポート YYYY-MM-DD.md`");
    expect(md).not.toContain("日報 YYYYMMDD");
  });

  it("実例ブロックは保管庫の設定（見出しレベル・チェックボックス・メタ行のタイトル）で書き出す", () => {
    const base = defaultSpecContext("x");
    const level3 = renderFormatSpec({ ...base, rootHeading: "## 予定", headingLevel: 3 });
    expect(level3).toContain("親見出し `## 予定` の配下に、レベル 3（`###`）");
    expect(level3).toContain("### 誤検知の調査 #障害");
    expect(level3).toContain("### 設計レビューの準備 #開発/設計");
    expect(level3).not.toContain("\n## 誤検知の調査");

    const noBox = renderFormatSpec({ ...base, useCheckbox: false });
    expect(noBox).toContain("- ^dtp-c0ffee\n"); // 未完了はチェックボックス無し
    expect(noBox).toContain("- [x] 10:00 - 11:00"); // 完了は [x] のまま
    expect(noBox).toContain("未完了のタスクはチェックボックス無し");

    const mirror = renderFormatSpec({ ...base, mirrorTitle: true });
    expect(mirror).toContain("- [x] 10:00 - 11:00 誤検知の調査 #障害 🎫redmine#65130 🔔10 ^dtp-k3f9a2");
    expect(mirror).toContain("| タイトル | この保管庫の設定では");
    expect(renderFormatSpec(base)).not.toContain("| タイトル | この保管庫の設定では");
  });

  it("実例の書き出し設定は保管庫の設定から組む", () => {
    const opts = exampleOptionsOf({ ...defaultSpecContext("x"), headingLevel: 4, rootHeading: "# 予定", useCheckbox: false, mirrorTitle: true });
    expect(opts).toEqual({ headingLevel: 4, rootHeading: "# 予定", useCheckbox: false, mirrorTitle: true });
  });
});
