/**
 * store.ts: ノート間の移動（日をまたぐ移動・持ち主の変更・Inbox との往復）。
 * 「先に移動先へ書き、それから元を消す」順なので、途中で失敗してもブロックは消えないことを確かめる
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  BlockTaskStore,
  DuplicateAfterTransferError,
  INBOX_DATE,
  InboxStore,
  MemberStore,
} from "../src/store";
import { DEFAULT_SETTINGS, type DayTimelineSettings, type Member } from "../src/settings";
import type { Task } from "../src/model";
import { FakeVault, fakeApp } from "./fake-vault";

const D1 = new Date(2026, 8, 25);
const D2 = new Date(2026, 8, 26);
const TANAKA: Member = { id: "m1", name: "田中", color: "#e06c75", folder: "", visible: true, remind: true };

let vault: FakeVault;
let settings: DayTimelineSettings;
let store: BlockTaskStore;
let inbox: InboxStore;
let member: MemberStore;

beforeEach(() => {
  vault = new FakeVault();
  settings = { ...DEFAULT_SETTINGS, deletionLog: false, members: [TANAKA] };
  const app = fakeApp(vault);
  store = new BlockTaskStore(app, () => settings);
  inbox = new InboxStore(app, () => settings);
  member = new MemberStore(app, () => settings, () => TANAKA);
});

/** 朝会（ID 付き・本文あり）とレビュー（ID なし）を D1 に作る */
async function seedD1(): Promise<{ meeting: Task; review: Task }> {
  await store.createWithId(D1, { title: "朝会", start: 540, end: 600, done: false, details: "メモ1\nメモ2" }, "dtp-m1");
  await store.create(D1, { title: "レビュー", start: 780, end: 840, done: false });
  const tasks = (await store.load(D1)).tasks;
  const meeting = tasks.find((t) => t.title === "朝会")!;
  const review = tasks.find((t) => t.title === "レビュー")!;
  return { meeting, review };
}

const titles = async (s: BlockTaskStore, d: Date) => (await s.load(d)).tasks.map((t) => t.title);

describe("moveToDate: 日をまたぐ移動", () => {
  it("移動先に書いてから元を消す。ブロック ID と本文はそのまま", async () => {
    const { meeting } = await seedD1();
    vault.ops = [];
    expect(await store.moveToDate(D1, meeting, D2)).toBe("moved");
    expect(await titles(store, D1)).toEqual(["レビュー"]);
    const moved = (await store.load(D2)).tasks;
    expect(moved.map((t) => [t.title, t.blockId, t.details])).toEqual([["朝会", "dtp-m1", "メモ1\nメモ2"]]);
    // 書き込みの順序: 移動先（作成 → 書き込み）→ 元
    const to = store.pathFor(D2);
    const from = store.pathFor(D1);
    expect(vault.ops).toEqual([`create ${to}`, `process ${to}`, `process ${from}`]);
  });

  it("ID の無いタスク（手書きのブロック）も移せる（見出しの題と時刻で照合）", async () => {
    await seedD1();
    const from = store.pathFor(D1);
    vault.files.set(from, vault.files.get(from)! + "\n## 手書き\n- [ ] 15:00 - 16:00\n");
    const raw = (await store.load(D1)).tasks.find((t) => t.title === "手書き")!;
    expect(raw.blockId).toBeNull();
    expect(await store.moveToDate(D1, raw, D2)).toBe("moved");
    expect(await titles(store, D1)).toEqual(["朝会", "レビュー"]);
    expect(await titles(store, D2)).toEqual(["手書き"]);
  });

  it("元のノートにタスクが無ければ何も書かない", async () => {
    const { meeting } = await seedD1();
    await store.remove(D1, meeting);
    expect(await store.moveToDate(D1, meeting, D2)).toBe("missing");
    expect(vault.files.has(store.pathFor(D2))).toBe(false);
  });

  it("移動先への書き込みに失敗しても、元のノートは変わらない", async () => {
    const { meeting } = await seedD1();
    const before = vault.files.get(store.pathFor(D1));
    vault.failWith = (path, op) => (op === "process" && path === store.pathFor(D2) ? new Error("disk full") : null);
    await expect(store.moveToDate(D1, meeting, D2)).rejects.toThrow("disk full");
    expect(vault.files.get(store.pathFor(D1))).toBe(before);
    expect(await titles(store, D1)).toEqual(["朝会", "レビュー"]);
  });

  it("読んでから消すまでの間に元のノートが変わっていたら、移動先に入れた分を取り消す", async () => {
    const { meeting } = await seedD1();
    const from = store.pathFor(D1);
    // 移動先へ書き込む瞬間に、元のブロックが外から書き換えられた（ID が変わった）ことにする
    vault.onBeforeProcess = (path) => {
      if (path === store.pathFor(D2)) {
        vault.files.set(from, vault.files.get(from)!.replace("^dtp-m1", "^dtp-other"));
      }
    };
    expect(await store.moveToDate(D1, meeting, D2)).toBe("conflict");
    expect(await titles(store, D2)).toEqual([]);
    // 元は（外から変わった内容のまま）残っている
    expect(await titles(store, D1)).toEqual(["朝会", "レビュー"]);
  });

  it("移動先に書いた後で元から消せなかったら、両方に残っていることを知らせる", async () => {
    const { meeting } = await seedD1();
    vault.failWith = (path, op) => (op === "process" && path === store.pathFor(D1) ? new Error("EIO") : null);
    const err = await store.moveToDate(D1, meeting, D2).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DuplicateAfterTransferError);
    expect(String((err as Error).message)).toContain("両方に残っています");
    expect(await titles(store, D1)).toEqual(["朝会", "レビュー"]);
    expect(await titles(store, D2)).toEqual(["朝会"]);
  });
});

describe("持ち主の変更（MemberStore）", () => {
  it("メンバーのノートは <フォルダ>/Members/<名前>/<日付>.md。パスから日付を戻せる", () => {
    expect(member.pathFor(D1)).toBe("Timeline/Members/田中/2026-09-25.md");
    expect(member.dateFromPath("Timeline/Members/田中/2026-09-25.md")?.getTime()).toBe(D1.getTime());
    // 自分のストアはメンバーのノートを自分の日付ノートとは見なさない
    expect(store.dateFromPath("Timeline/Members/田中/2026-09-25.md")).toBeNull();
    expect(store.dateFromPath("Timeline/2026-09-25.md")?.getTime()).toBe(D1.getTime());
  });

  it("フォルダを指定したメンバーはそのフォルダに", () => {
    const m = new MemberStore(fakeApp(vault), () => settings, () => ({ ...TANAKA, folder: "/People/Tanaka/" }));
    expect(m.pathFor(D1)).toBe("People/Tanaka/2026-09-25.md");
  });

  it("自分 → メンバー: ブロックごとメンバーのノートへ移り、読み込むと owner が付く", async () => {
    const { meeting } = await seedD1();
    expect(await store.transferTo(D1, meeting, member, D1, meeting.start)).toBe("moved");
    expect(await titles(store, D1)).toEqual(["レビュー"]);
    const theirs = (await member.load(D1)).tasks;
    expect(theirs.map((t) => [t.title, t.blockId, t.owner])).toEqual([["朝会", "dtp-m1", "m1"]]);
  });

  it("メンバー → 自分: 元に戻せる", async () => {
    const { meeting } = await seedD1();
    await store.transferTo(D1, meeting, member, D1, meeting.start);
    const theirs = (await member.load(D1)).tasks[0];
    expect(await member.transferTo(D1, theirs, store, D1, theirs.start)).toBe("moved");
    expect(await titles(member, D1)).toEqual([]);
    expect(await titles(store, D1)).toEqual(["朝会", "レビュー"]);
  });
});

describe("Inbox との往復", () => {
  it("Inbox → 日付ノート → Inbox。Inbox のノートは日付に関係なく 1 つ", async () => {
    await inbox.create(INBOX_DATE, { title: "買い物", start: null, end: null, done: false });
    expect(inbox.pathFor(D1)).toBe("Timeline/Inbox.md");
    const t = (await inbox.load(INBOX_DATE)).tasks[0];
    expect(t.registered).toMatch(/^\d{4}-\d{2}-\d{2}$/); // Inbox に入れた日

    expect(await inbox.transferTo(INBOX_DATE, t, store, D1, 600)).toBe("moved");
    expect(await titles(inbox, INBOX_DATE)).toEqual([]);
    const onDay = (await store.load(D1)).tasks[0];
    expect(onDay.title).toBe("買い物");

    expect(await store.transferTo(D1, onDay, inbox, INBOX_DATE, null)).toBe("moved");
    expect(await titles(store, D1)).toEqual([]);
    expect(await titles(inbox, INBOX_DATE)).toEqual(["買い物"]);
  });
});
