/**
 * テスト共通のヘルパー。
 * フィクスチャ（test/fixtures/*.md）は「仕様の実例」で、README の保存形式の説明と一致させる。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BlockOptions, TaskBlock } from "../src/markdown/blocks";
import type { InsertOptions } from "../src/markdown/edit";

export const FIXTURE_DIR = join(__dirname, "fixtures");

export function fixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), "utf8");
}

/** 既定の設定（設定画面の初期値と同じ: ## 見出し、ファイル直下、チェックボックスあり） */
export const OPTS: BlockOptions = {
  headingLevel: 2,
  rootHeading: "",
  useCheckbox: true,
  mirrorTitle: false,
  excludeHeadings: ["タイムスケジュール"],
};

export const INSERT_OPTS: InsertOptions = { ...OPTS, insertPosition: "time" };

/**
 * TaskBlock から「意味のある値」だけを取り出す（行番号などの位置情報は捨てる）。
 * 解析 → 書き出し → 解析 の往復で保たれるべき情報の一覧でもある
 */
export function semantic(t: TaskBlock) {
  return {
    id: t.id,
    title: t.title,
    start: t.start,
    end: t.end,
    done: t.done,
    checkChar: t.checkChar,
    note: t.note,
    reminder: t.reminder,
    ticket: t.ticket,
    doneCondition: t.doneCondition,
    retrospective: t.retrospective,
    result: t.result,
    remaining: t.remaining,
    cause: t.cause,
    judgment: t.judgment,
    others: t.others,
    answer: t.answer,
    status: t.status,
    ownerName: t.ownerName,
    due: t.due,
    nextAction: t.nextAction,
    registered: t.registered,
    actual: t.actual,
    project: t.project,
    carryTo: t.carryTo,
    carryFrom: t.carryFrom,
    steps: t.steps,
    details: t.details,
  };
}

/** 2つのテキストで異なる行の数（追加・削除・変更をざっくり数える） */
export function changedLines(before: string, after: string): number {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  const setA = new Map<string, number>();
  for (const l of a) setA.set(l, (setA.get(l) ?? 0) + 1);
  let diff = 0;
  for (const l of b) {
    const n = setA.get(l) ?? 0;
    if (n > 0) setA.set(l, n - 1);
    else diff++;
  }
  for (const n of setA.values()) diff += n;
  return diff;
}
