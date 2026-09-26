/**
 * プロジェクトノートの frontmatter（完了 done / 完了日 completed / 進捗）の読み書き。
 * 完了の正は frontmatter の `done: true`。本文先頭のチェック（`- [x] ^id`）は ID としてだけ使い、完了判定には使わない
 */
import { beforeEach, describe, expect, it } from "vitest";
import { TFile, TFolder, type App } from "obsidian";
import { FakeVault } from "./fake-vault";
import { DEFAULT_SETTINGS, type DayTimelineSettings } from "../src/settings";
import type { Task } from "../src/model";
import {
  ProjectStore,
  buildProgress,
  ensureFrontmatterDone,
  frontmatterValueOf,
  plainTaskTitle,
  readFrontmatterDone,
  type ProjectChild,
} from "../src/project";

// ---------- 純関数 ----------

describe("frontmatter の done を読む", () => {
  it("done: true だけを完了とみなす", () => {
    expect(readFrontmatterDone("---\ndone: true\n---\n# A\n")).toBe(true);
    expect(readFrontmatterDone("---\ngroup: 仕事\ndone: True\n---\n")).toBe(true);
    expect(readFrontmatterDone("---\ndone: false\n---\n")).toBe(false);
    expect(readFrontmatterDone("---\ndone: yes\n---\n")).toBe(false);
    expect(readFrontmatterDone("---\ngroup: 仕事\n---\n")).toBe(false);
    expect(readFrontmatterDone("# A\n- [x] ^dtp-1\n")).toBe(false);
  });

  it("frontmatter の外の done: は読まない", () => {
    expect(readFrontmatterDone("# A\ndone: true\n")).toBe(false);
    expect(readFrontmatterDone("---\ngroup: x\n---\ndone: true\n")).toBe(false);
  });

  it("frontmatterValueOf は 1 行の値を返し、無ければ null", () => {
    const c = "---\nstatus: done\ntasks_total: 3\n---\n";
    expect(frontmatterValueOf(c, "status")).toBe("done");
    expect(frontmatterValueOf(c, "tasks_total")).toBe("3");
    expect(frontmatterValueOf(c, "done")).toBeNull();
    expect(frontmatterValueOf("# no fm\n", "status")).toBeNull();
  });
});

describe("新規作成時の done: false", () => {
  it("frontmatter が無ければ先頭に作る", () => {
    expect(ensureFrontmatterDone("# A\n- [ ] ^dtp-1\n")).toBe("---\ndone: false\n---\n# A\n- [ ] ^dtp-1\n");
  });

  it("frontmatter があれば末尾に足す（group と同じ場所）", () => {
    expect(ensureFrontmatterDone("---\ngroup: 仕事\n---\n# A\n")).toBe("---\ngroup: 仕事\ndone: false\n---\n# A\n");
  });

  it("既に done があれば変えない", () => {
    const c = "---\ndone: true\n---\n# A\n";
    expect(ensureFrontmatterDone(c)).toBe(c);
  });
});

function task(p: Partial<Task> & { title: string }): Task {
  return {
    key: p.title,
    start: null,
    end: null,
    done: false,
    preview: "",
    blockId: null,
    tags: [],
    reminder: null,
    steps: [],
    others: [],
    actual: [],
    project: null,
    forwarded: false,
    carryTo: null,
    carryFrom: null,
    details: "",
    ticket: null,
    owner: null,
    ref: { kind: "block", id: null, title: p.title, start: null, end: null },
    ...p,
  } as Task;
}

function child(title: string, date: string | null, extra: Partial<Task> = {}): ProjectChild {
  return {
    date: date ? new Date(date + "T00:00:00") : null,
    path: date ? `Timeline/${date}.md` : "Timeline/Inbox.md",
    task: task({ title, ...extra }),
    owner: null,
  };
}

describe("タスク名の表示名", () => {
  it("リンク記法とタグを外す", () => {
    expect(plainTaskTitle("[[Timeline/Projects/環境構築|環境]] を直す #仕事")).toBe("環境 を直す");
    expect(plainTaskTitle("[[docs/設計書.md]] を読む")).toBe("設計書 を読む");
    expect(plainTaskTitle("[issue](https://example.com/1) 対応")).toBe("issue 対応");
    expect(plainTaskTitle("")).toBe("(無題)");
  });
});

describe("タスク表の進捗", () => {
  it("件数・最後に完了したタスク・次のタスクを集計する", () => {
    const p = buildProgress([
      child("準備", "2026-09-01", { done: true, start: 540, end: 600 }),
      child("本番", "2026-09-03", { done: true, start: 600, end: 660 }),
      child("片付け", "2026-09-03", { done: true, start: 540, end: 600 }),
      child("報告", "2026-09-05"),
      child("ふりかえり", "2026-09-04", { start: 900, end: 960 }),
      child("いつか", null),
    ]);
    expect(p.total).toBe(6);
    expect(p.done).toBe(3);
    // 同じ日なら開始時刻が遅いほう
    expect(p.lastDone).toBe("2026-09-03 本番");
    // 未完了で日付がいちばん早いもの（日付ありを優先）
    expect(p.nextTask).toBe("2026-09-04 ふりかえり");
  });

  it("日付未定の未完了しか無ければ「未定 タスク名」", () => {
    const p = buildProgress([child("済み", null, { done: true }), child("いつか", null)]);
    expect(p.done).toBe(1);
    expect(p.lastDone).toBeNull(); // 日付ありの完了が無い
    expect(p.nextTask).toBe("未定 いつか");
  });

  it("持ち越し済み [>] は次のタスクにせず、持ち越し先で完了していれば完了に数える", () => {
    const p = buildProgress([
      child("作業", "2026-09-01", {
        forwarded: true,
        blockId: "a1",
        carryTo: "Timeline/2026-09-02#^a2",
      }),
      child("作業", "2026-09-02", { done: true, blockId: "a2", carryFrom: "Timeline/2026-09-01#^a1" }),
    ]);
    expect(p.total).toBe(2);
    expect(p.done).toBe(2);
    expect(p.lastDone).toBe("2026-09-02 作業");
    expect(p.nextTask).toBeNull();
  });

  it("タスクが無ければ 0 件で last_done / next_task は無し", () => {
    expect(buildProgress([])).toEqual({ total: 0, done: 0, lastDone: null, nextTask: null });
  });
});

// ---------- ProjectStore（frontmatter の書き込み） ----------

type FM = Record<string, unknown>;

/** frontmatter を「1 行 = 1 キー」で読み書きする簡易 YAML（テスト用。プラグインが書くキーはこの範囲） */
function parseFm(content: string): { fm: FM; body: string } {
  const lines = content.split("\n");
  if (lines[0] !== "---") return { fm: {}, body: content };
  const close = lines.findIndex((l, i) => i > 0 && l === "---");
  const fm: FM = {};
  for (const l of lines.slice(1, close)) {
    const m = /^([^:]+):\s*(.*)$/.exec(l);
    if (!m) continue;
    const v = m[2];
    fm[m[1]] = v === "true" ? true : v === "false" ? false : /^\d+$/.test(v) ? Number(v) : v;
  }
  return { fm, body: lines.slice(close + 1).join("\n") };
}

function renderFm(fm: FM, body: string): string {
  const keys = Object.keys(fm);
  if (!keys.length) return body;
  return "---\n" + keys.map((k) => `${k}: ${String(fm[k])}`).join("\n") + "\n---\n" + body;
}

/** vault + metadataCache（frontmatter とリスト項目）+ fileManager.processFrontMatter の代わり */
function projectApp(vault: FakeVault, folder: string): App {
  const cache = (file: TFile) => {
    const content = vault.files.get(file.path) ?? "";
    const { fm } = parseFm(content);
    return { frontmatter: Object.keys(fm).length ? fm : undefined };
  };
  const base = vault.getAbstractFileByPath.bind(vault);
  vault.getAbstractFileByPath = (path: string) => {
    const f = base(path);
    if (f instanceof TFolder && path === folder) {
      f.children = [...vault.files.keys()]
        .filter((p) => p.startsWith(folder + "/") && !p.slice(folder.length + 1).includes("/"))
        .map((p) => {
          const tf = base(p) as TFile;
          tf.parent = f;
          return tf;
        });
    }
    return f;
  };
  return {
    vault,
    metadataCache: {
      getFileCache: cache,
      getFirstLinkpathDest: () => null,
    },
    fileManager: {
      processFrontMatter: async (file: TFile, fn: (fm: FM) => void) => {
        await vault.process(file, (content) => {
          const { fm, body } = parseFm(content);
          fn(fm);
          return renderFm(fm, body);
        });
      },
    },
  } as unknown as App;
}

describe("ProjectStore と frontmatter", () => {
  const FOLDER = "Timeline/Projects";
  let vault: FakeVault;
  let settings: DayTimelineSettings;
  let store: ProjectStore;

  beforeEach(() => {
    vault = new FakeVault();
    vault.folders.add("Timeline");
    vault.folders.add(FOLDER);
    settings = { ...DEFAULT_SETTINGS, folder: "Timeline", projectsFolder: "" };
    store = new ProjectStore(projectApp(vault, FOLDER), () => settings);
  });

  it("一覧の完了は frontmatter の done で決まり、先頭のチェックは見ない", async () => {
    vault.files.set(`${FOLDER}/A.md`, "---\ndone: true\n---\n# A\n- [ ] ^dtp-a\n");
    vault.files.set(`${FOLDER}/B.md`, "# B\n- [x] ^dtp-b\n");
    vault.files.set(`${FOLDER}/C.md`, "---\ndone: false\ngroup: 仕事\n---\n# C\n- [x] ^dtp-c\n");
    const list = store.list();
    expect(list.map((r) => [r.name, r.done, r.group ?? null])).toEqual([
      ["A", true, null],
      ["B", false, null],
      ["C", false, "仕事"],
    ]);
    expect(await store.isDone(`${FOLDER}/A`)).toBe(true);
    expect(await store.isDone(`${FOLDER}/B`)).toBe(false);
    expect((await store.selfState(`${FOLDER}/C`))?.done).toBe(false);
    expect(await store.isDone(`${FOLDER}/なし`)).toBeNull();
  });

  it("完了にすると done: true と completed（今日）が入り、本文と他の property は変わらない", async () => {
    const path = `${FOLDER}/A.md`;
    vault.files.set(path, "---\ngroup: 仕事\n---\n# A\n- [ ] ^dtp-a\n\n## メモ\n");
    expect(await store.setDone(`${FOLDER}/A`, true)).toBe(true);
    const { fm, body } = parseFm(vault.files.get(path)!);
    expect(fm.group).toBe("仕事");
    expect(fm.done).toBe(true);
    expect(fm.completed).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body).toBe("# A\n- [ ] ^dtp-a\n\n## メモ\n");
    expect(store.list()[0].done).toBe(true);
  });

  it("未完了に戻すと done: false になり completed が消える", async () => {
    const path = `${FOLDER}/A.md`;
    vault.files.set(path, "---\ndone: true\ncompleted: 2026-09-01\n---\n# A\n- [x] ^dtp-a\n");
    expect(await store.setDone(`${FOLDER}/A`, false)).toBe(true);
    const { fm, body } = parseFm(vault.files.get(path)!);
    expect(fm).toEqual({ done: false });
    expect(body).toBe("# A\n- [x] ^dtp-a\n"); // 本文のチェックには触らない
  });

  it("値が同じなら書かない", async () => {
    const path = `${FOLDER}/A.md`;
    vault.files.set(path, "---\ndone: true\ncompleted: 2026-09-01\n---\n# A\n");
    await store.setDone(`${FOLDER}/A`, true);
    vault.files.set(`${FOLDER}/B.md`, "---\ndone: false\n---\n# B\n");
    await store.setDone(`${FOLDER}/B`, false);
    expect(vault.ops.filter((o) => o.startsWith("process"))).toEqual([]);
    expect(vault.files.get(path)).toBe("---\ndone: true\ncompleted: 2026-09-01\n---\n# A\n");
  });

  it("新規作成したノートには done: false が入る", async () => {
    const link = await store.create("新規");
    expect(link).toBe(`${FOLDER}/新規`);
    const content = vault.files.get(`${FOLDER}/新規.md`)!;
    expect(content.startsWith("---\ndone: false\n---\n# 新規\n- [ ] ^")).toBe(true);
    expect(store.list()[0].done).toBe(false);
  });

  it("移行コマンド: 先頭チェックか status: done なら done: true、それ以外は false。status は消す", async () => {
    vault.files.set(`${FOLDER}/チェック済.md`, "---\ngroup: 仕事\n---\n# チェック済\n- [x] ^dtp-a\n");
    vault.files.set(`${FOLDER}/status.md`, "---\nstatus: done\n---\n# status\n- [ ] ^dtp-b\n");
    vault.files.set(`${FOLDER}/進行中.md`, "# 進行中\n- [ ] ^dtp-c\n");
    vault.files.set(`${FOLDER}/手書き.md`, "---\nstatus: wip\n---\n# 手書き\n\n- [x] 買い物\n");
    vault.files.set(`${FOLDER}/済み.md`, "---\ndone: true\n---\n# 済み\n- [ ] ^dtp-e\n");
    vault.files.set(`${FOLDER}/済みstatus付き.md`, "---\ndone: false\nstatus: done\n---\n# x\n");
    const r = await store.migrateDoneToFrontmatter();
    expect(r).toEqual({ done: 2, notDone: 2, unchanged: 2, statusRemoved: 3 });
    expect(vault.files.get(`${FOLDER}/チェック済.md`)).toBe("---\ngroup: 仕事\ndone: true\n---\n# チェック済\n- [x] ^dtp-a\n");
    expect(vault.files.get(`${FOLDER}/status.md`)).toBe("---\ndone: true\n---\n# status\n- [ ] ^dtp-b\n");
    expect(vault.files.get(`${FOLDER}/進行中.md`)).toBe("---\ndone: false\n---\n# 進行中\n- [ ] ^dtp-c\n");
    // ID 無しの手書きチェックはメタ行ではない
    expect(vault.files.get(`${FOLDER}/手書き.md`)).toBe("---\ndone: false\n---\n# 手書き\n\n- [x] 買い物\n");
    expect(vault.files.get(`${FOLDER}/済み.md`)).toBe("---\ndone: true\n---\n# 済み\n- [ ] ^dtp-e\n");
    expect(vault.files.get(`${FOLDER}/済みstatus付き.md`)).toBe("---\ndone: false\n---\n# x\n");
    // 2 回目は何も変わらない
    expect(await store.migrateDoneToFrontmatter()).toEqual({ done: 0, notDone: 0, unchanged: 6, statusRemoved: 0 });
  });

  it("進捗を frontmatter に書く（next には触らず、無い値のキーは消す）", async () => {
    const path = `${FOLDER}/A.md`;
    vault.files.set(path, "---\ndone: false\nnext: 設計を見直す\nlast_done: 2026-08-01 古い\n---\n# A\n- 期日: 2026/09/30\n");
    const progress = buildProgress([child("準備", "2026-09-01", { done: true }), child("本番", "2026-09-03")]);
    const fields = (await store.selfState(`${FOLDER}/A`))!.fields;
    expect(await store.writeProgress(`${FOLDER}/A`, progress, fields)).toBe(true);
    expect(parseFm(vault.files.get(path)!).fm).toEqual({
      done: false,
      next: "設計を見直す",
      last_done: "2026-09-01 準備",
      tasks_total: 2,
      tasks_done: 1,
      next_task: "2026-09-03 本番",
      due: "2026-09-30",
    });
    // 同じ値なら書かない
    vault.ops = [];
    await store.writeProgress(`${FOLDER}/A`, progress, fields);
    expect(vault.ops).toEqual([]);
    // タスクが無くなれば last_done / next_task は消える。due は本文に無ければ触らない
    await store.writeProgress(`${FOLDER}/A`, buildProgress([]), { due: "", dueDate: null, ticket: null, docs: [] });
    expect(parseFm(vault.files.get(path)!).fm).toEqual({
      done: false,
      next: "設計を見直す",
      tasks_total: 0,
      tasks_done: 0,
      due: "2026-09-30",
    });
  });
});
