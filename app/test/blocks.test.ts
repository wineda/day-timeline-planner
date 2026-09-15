import { describe, expect, it } from "vitest";
import {
  bodyPreview,
  parseBlockDocument,
  parseMetaLine,
  parseStatusValue,
  buildStatusValue,
  renderTaskBlock,
  splitOtherEntry,
  joinOtherEntry,
  subtractActualRanges,
  type TaskBlock,
} from "../src/markdown/blocks";
import { OPTS, fixture, semantic } from "./helpers";

const byTitle = (tasks: TaskBlock[], title: string): TaskBlock => {
  const t = tasks.find((x) => x.title === title);
  if (!t) throw new Error(`task not found: ${title}`);
  return t;
};

describe("parseBlockDocument: 基本のデイリーノート", () => {
  const doc = parseBlockDocument(fixture("daily-basic.md"), OPTS);

  it("メタ行のある見出しだけをタスクにする（コードブロック内・メタ行なしは除く）", () => {
    expect(doc.tasks.map((t) => t.title)).toEqual([
      "朝会",
      "設計レビューの準備 #work",
      "メールの棚卸し",
      "手書きのタスク",
    ]);
  });

  it("frontmatter の後ろから走査する", () => {
    expect(doc.scanStart).toBe(3);
    expect(doc.rootMissing).toBe(false);
  });

  it("時刻・完了・ID・実績・完了条件・ステップ・詳細を読む", () => {
    const t = byTitle(doc.tasks, "朝会");
    expect(t.id).toBe("dtp-k3f9a2");
    expect(t.start).toBe(9 * 60);
    expect(t.end).toBe(10 * 60);
    expect(t.done).toBe(true);
    expect(t.actual).toEqual([{ start: 9 * 60 + 5, end: 10 * 60 + 10 }]);
    expect(t.doneCondition).toBe("今日の担当が決まっている");
    expect(t.steps.map((s) => [s.text, s.done])).toEqual([
      ["昨日の振り返り", true],
      ["今日の担当決め", false],
    ]);
    expect(t.details).toEqual(["議題: 進捗確認", "決定: リリースは金曜"]);
  });

  it("ステップの下のインデント行は子として付く。リマインド指定を読む", () => {
    const t = byTitle(doc.tasks, "設計レビューの準備 #work");
    expect(t.reminder).toBe(10);
    expect(t.steps[1].children).toEqual(["    補足: 構成図は draw.io"]);
    expect(t.details).toEqual([]);
  });

  it("時刻なし = 未スケジュール", () => {
    const t = byTitle(doc.tasks, "メールの棚卸し");
    expect(t.start).toBeNull();
    expect(t.end).toBeNull();
  });

  it("手書きの「- HH:MM - HH:MM」だけでもタスク（ID は無し・チェックボックス無し）", () => {
    const t = byTitle(doc.tasks, "手書きのタスク");
    expect(t.id).toBeNull();
    expect(t.checkChar).toBeNull();
    expect(t.start).toBe(13 * 60);
  });
});

describe("parseBlockDocument: 記録フィールド", () => {
  const doc = parseBlockDocument(fixture("daily-fields.md"), OPTS);

  it("全フィールドを読む", () => {
    const t = byTitle(doc.tasks, "誤検知の調査 #障害");
    expect(semantic(t)).toMatchObject({
      id: "dtp-a1b2c3",
      done: true,
      ticket: { tracker: "redmine", id: "65130" },
      reminder: "off",
      project: "Timeline/Projects/WAF 移行",
      actual: [
        { start: 10 * 60 + 5, end: 10 * 60 + 40 },
        { start: 13 * 60, end: 13 * 60 + 30 },
      ],
      due: "2026-08-20",
      doneCondition: "原因が特定されている",
      result: "GenericRFI_BODY の誤検知と特定",
      cause: "署名のパターンが URL エンコード済みの本文に一致",
      judgment: "該当ルールを検知モードに落として様子見",
      remaining: "恒久対応の検討",
      others: ["田中 / ルール変更の承認", "佐藤 / 影響範囲の確認"],
      answer: "未",
      status: "中断(承認待ち)",
      ownerName: "鈴木",
      nextAction: "承認が下りたら本番に反映",
      retrospective: "調査に時間がかかった",
      details: ["詳細のメモ。複数行。", "- 箇条書きも自由に書ける"],
    });
    expect(t.steps.map((s) => s.text)).toEqual(["ログを集める", "再現手順を書く"]);
  });

  it("別表記（太字・全角コロン・期日）も読む", () => {
    const t = byTitle(doc.tasks, "別表記のフィールド");
    expect(t.doneCondition).toBe("太字表記");
    expect(t.retrospective).toBe("全角コロン");
    expect(t.due).toBe("2026-08-31");
    expect(t.details).toEqual([]);
  });

  it("持ち越し [>] と持ち越し先リンク", () => {
    const t = byTitle(doc.tasks, "持ち越し元");
    expect(t.checkChar).toBe(">");
    expect(t.done).toBe(false);
    expect(t.carryTo).toBe("2026-08-20#^dtp-carry2");
  });
});

describe("parseBlockDocument: 親見出しと Inbox", () => {
  it("親見出しの配下だけを走査し、外側の同レベル見出しは無視する", () => {
    const doc = parseBlockDocument(fixture("root-heading.md"), {
      ...OPTS,
      headingLevel: 3,
      rootHeading: "## タイムスケジュール",
      excludeHeadings: [],
    });
    expect(doc.rootMissing).toBe(false);
    expect(doc.tasks.map((t) => t.title)).toEqual(["朝会", "開発"]);
  });

  it("親見出しがノートに無ければ rootMissing", () => {
    const doc = parseBlockDocument("# メモ\n\n何もない\n", { ...OPTS, rootHeading: "## 予定" });
    expect(doc.rootMissing).toBe(true);
    expect(doc.tasks).toEqual([]);
  });

  it("Inbox のノートは登録日を持つ未スケジュールのタスク", () => {
    const doc = parseBlockDocument(fixture("inbox.md"), OPTS);
    expect(doc.tasks.map((t) => [t.title, t.start, t.registered])).toEqual([
      ["いつかやる調査", null, "2026-08-10"],
      ["期限だけ決まっている #管理", null, "2026-08-15"],
    ]);
  });

  it("CRLF のノートも読める", () => {
    const doc = parseBlockDocument(fixture("daily-basic.md").replace(/\n/g, "\r\n"), OPTS);
    expect(doc.eol).toBe("\r\n");
    expect(doc.tasks).toHaveLength(4);
  });
});

describe("往復: 解析 → 書き出し → 解析 で情報が落ちない", () => {
  for (const name of ["daily-basic.md", "daily-fields.md", "inbox.md"]) {
    it(name, () => {
      const doc = parseBlockDocument(fixture(name), OPTS);
      expect(doc.tasks.length).toBeGreaterThan(0);
      for (const t of doc.tasks) {
        // 手書きのブロック（ID 無し）は書き出しで ID を付けない（そのまま保持）
        const lines = renderTaskBlock({ ...t, body: t.details }, OPTS, t.level);
        const again = parseBlockDocument(lines.join("\n") + "\n", OPTS);
        expect(again.tasks).toHaveLength(1);
        expect(semantic(again.tasks[0])).toEqual(semantic(t));
      }
    });
  }

  it("書き出しは冪等（2回目の書き出しは1回目と同じ）", () => {
    const doc = parseBlockDocument(fixture("daily-fields.md"), OPTS);
    for (const t of doc.tasks) {
      const once = renderTaskBlock({ ...t, body: t.details }, OPTS, t.level);
      const t2 = parseBlockDocument(once.join("\n") + "\n", OPTS).tasks[0];
      const twice = renderTaskBlock({ ...t2, body: t2.details }, OPTS, t2.level);
      expect(twice).toEqual(once);
    }
  });

  it("書き出しの並びは固定（プロジェクト → 実績 → … → ふりかえり → 本文）", () => {
    const t = parseBlockDocument(fixture("daily-fields.md"), OPTS).tasks[0];
    expect(renderTaskBlock({ ...t, body: t.details }, OPTS)).toEqual([
      "## 誤検知の調査 #障害",
      "- [x] 10:00 - 11:00 🎫redmine#65130 🔔off ^dtp-a1b2c3",
      "- プロジェクト: [[Timeline/Projects/WAF 移行]]",
      "- 実績: 10:05 - 10:40 / 13:00 - 13:30",
      "- 期限: 2026-08-20",
      "- 完了条件: 原因が特定されている",
      "- [x] ログを集める",
      "- [ ] 再現手順を書く",
      "- 結果: GenericRFI_BODY の誤検知と特定",
      "- 原因: 署名のパターンが URL エンコード済みの本文に一致",
      "- 判断: 該当ルールを検知モードに落として様子見",
      "- 残: 恒久対応の検討",
      "- 他者: 田中 / ルール変更の承認",
      "- 他者: 佐藤 / 影響範囲の確認",
      "- 回答: 未",
      "- 状態: 中断(承認待ち)",
      "- Owner: 鈴木",
      "- 次アクション: 承認が下りたら本番に反映",
      "- ふりかえり: 調査に時間がかかった",
      "",
      "詳細のメモ。複数行。",
      "- 箇条書きも自由に書ける",
    ]);
  });
});

describe("メタ行の細部", () => {
  it("時刻も dtp- の ID も無い行はタスクではない", () => {
    expect(parseMetaLine("- [ ] ただの項目")).toBeNull();
    expect(parseMetaLine("- [ ] ただの項目 ^other-id")).toBeNull();
    expect(parseMetaLine("- [ ] ^dtp-abc")).not.toBeNull();
  });

  it("終了が開始以前なら 30 分として扱う。24:00 は上限", () => {
    expect(parseMetaLine("- 10:00 - 09:00")).toMatchObject({ start: 600, end: 630 });
    expect(parseMetaLine("- 23:50 - 25:00")).toMatchObject({ start: 23 * 60 + 50, end: 1440 });
  });

  it("状態の値: 中断(理由) の組み立てと分解", () => {
    expect(parseStatusValue("中断(承認待ち)")).toEqual({ kind: "中断", reason: "承認待ち" });
    expect(parseStatusValue("進行中")).toEqual({ kind: "進行中", reason: "" });
    expect(buildStatusValue("中断", "理由")).toBe("中断(理由)");
    expect(buildStatusValue("進行中", "無視される")).toBe("進行中");
  });

  it("他者の「相手 / 内容」の分解と結合", () => {
    expect(splitOtherEntry("田中 / 承認")).toEqual({ who: "田中", what: "承認" });
    expect(splitOtherEntry("内容だけ")).toEqual({ who: "", what: "内容だけ" });
    expect(joinOtherEntry("田中", "承認")).toBe("田中 / 承認");
    expect(joinOtherEntry("", "承認")).toBe("承認");
  });

  it("実績の重なりを取り除く", () => {
    expect(subtractActualRanges([{ start: 600, end: 720 }], [{ start: 630, end: 660 }])).toEqual([
      { start: 600, end: 630 },
      { start: 660, end: 720 },
    ]);
  });

  it("本文プレビューはフィールド行を飛ばして最初の文を出す", () => {
    const t = parseBlockDocument(fixture("daily-basic.md"), OPTS).tasks[0];
    expect(bodyPreview(t.body)).toBe("昨日の振り返り");
    expect(bodyPreview(["- 実績: 09:00 - 10:00", "- プロジェクト: [[X]]", "> 引用の一文"])).toBe("引用の一文");
  });
});
