/**
 * タスクとマークダウンのブロックを結び付ける ID。
 * Obsidian のブロックID（行末の `^xxxx`）をそのまま使うので、
 * 他のノートから `[[2026-08-18#^dtp-k3f9a2]]` のように参照できる。
 */

/** このプラグインが作った ID の目印 */
export const ID_PREFIX = "dtp-";

/** 行末のブロックID。Obsidian が許すのは英数字とハイフン */
const TRAILING_ID_RE = /(?:^|\s)\^([A-Za-z0-9][A-Za-z0-9-]*)\s*$/;

/** 新しいブロックID を作る */
export function newBlockId(): string {
  const t = Date.now().toString(36).slice(-6);
  const r = Math.random().toString(36).slice(2, 5);
  return ID_PREFIX + t + r;
}

/** このプラグインが付けた ID か */
export function isOwnId(id: string | null): boolean {
  return id !== null && id.startsWith(ID_PREFIX);
}

/** 行末のブロックID を取り出す（無ければ null） */
export function extractBlockId(text: string): string | null {
  const m = TRAILING_ID_RE.exec(text);
  return m ? m[1] : null;
}

/** 行末のブロックID を取り除く */
export function stripBlockId(text: string): string {
  return text.replace(TRAILING_ID_RE, "").replace(/\s+$/, "");
}
