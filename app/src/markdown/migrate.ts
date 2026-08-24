/**
 * 旧形式（見出しの下のリスト）→ 新形式（1タスク = 1ブロック）への変換。
 *
 *   ## タイムスケジュール          →   ## 朝会
 *   - [ ] 09:00 - 10:00 朝会           - [ ] 09:00 - 10:00 ^dtp-k3f9a2
 *       - 議題: 進捗確認
 *                                      議題: 進捗確認
 */
import { BlockOptions, parseHeadingSetting, renderTaskBlock } from "./blocks";
import { joinLines, spliceIn } from "./edit";
import { newBlockId } from "./id";
import { dedentChildren, parseListNote } from "./legacy";

export interface MigrateOptions extends BlockOptions {
  /** 旧形式の見出し（設定の「見出し」） */
  legacyHeading: string;
}

/** 変換した内容と件数。変換するものが無ければ null */
export function migrateListToBlocks(
  content: string,
  opts: MigrateOptions
): { content: string; count: number } | null {
  const parsed = parseListNote(content, opts.legacyHeading);
  if (!parsed.section || parsed.events.length === 0) return null;

  const rootText = opts.rootHeading.trim()
    ? parseHeadingSetting(opts.rootHeading).text
    : null;
  const legacyText = parseHeadingSetting(opts.legacyHeading).text;
  const asRoot = rootText === legacyText;

  const blocks: string[] = [];
  for (const e of parsed.events) {
    if (blocks.length) blocks.push("");
    blocks.push(
      ...renderTaskBlock(
        {
          id: newBlockId(),
          title: e.title,
          start: e.start,
          end: e.end,
          done: e.done,
          checkChar: e.checkChar,
          note: "",
          body: dedentChildren(e.children),
        },
        opts
      )
    );
  }

  const { lines, eol, section } = parsed;
  let out: string[];
  if (asRoot) {
    // 旧セクションを親見出しとして使い続ける: 中身を extras + ブロックに置き換える
    const replacement = [
      ...parsed.extras,
      ...(parsed.extras.length && blocks.length ? [""] : []),
      ...blocks,
    ];
    out = spliceIn(lines, section.bodyStart, section.bodyEnd - section.bodyStart, replacement);
  } else if (parsed.extras.length === 0) {
    // 予定しか無かった: セクションごとブロックに置き換える
    out = spliceIn(lines, section.headingIndex, section.bodyEnd - section.headingIndex, blocks);
  } else {
    // 予定以外の行が残っている: 見出しと extras を残し、ブロックはセクションの外に出す。
    // タスクの見出しレベルが旧見出しより深いと、セクションの直後ではその中に
    // 取り込まれてしまうので、その場合はセクションの前に置く。
    const after = opts.headingLevel <= section.level;
    out = spliceIn(lines, section.bodyStart, section.bodyEnd - section.bodyStart, parsed.extras);
    const delta = out.length - lines.length;
    const at = after ? section.bodyEnd + delta : section.headingIndex;
    out = spliceIn(out, at, 0, blocks);
  }
  return { content: joinLines(out, eol), count: parsed.events.length };
}

/** 変換すべき旧形式の予定がノートにあるか */
export function hasLegacyEvents(content: string, legacyHeading: string): boolean {
  const parsed = parseListNote(content, legacyHeading);
  return !!parsed.section && parsed.events.length > 0;
}
