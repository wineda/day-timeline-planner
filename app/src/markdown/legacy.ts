/**
 * 従来の「見出しの下にリストで並べる」形式。
 *
 *   ## タイムスケジュール
 *   - [ ] 09:00 - 10:00 朝会
 *       - 議題: 進捗確認
 *
 * 1.x からのノートをタスクブロックへ変換する（migrate.ts）ための読み取り側だけを残してある。
 * このファイルも Obsidian の API に依存しない。
 */
import { parseHeadingSetting, trimBlankLines } from "./blocks";

/** リスト形式の1件 */
export interface ListEvent {
  start: number;
  end: number;
  title: string;
  done: boolean;
  /** 予定の下にぶら下がるインデントされた行（メモなど）。そのまま保持する */
  children: string[];
  /** 元の行のチェックボックス内の文字。無ければ null、新規なら undefined */
  checkChar?: string | null;
}

export interface ListSection {
  headingIndex: number;
  bodyStart: number;
  bodyEnd: number;
  level: number;
}

export interface ParsedListNote {
  lines: string[];
  eol: string;
  section: ListSection | null;
  events: ListEvent[];
  /** セクション内にあった、予定ではない行（そのまま保持） */
  extras: string[];
}

const EVENT_LINE_RE =
  /^[-*+]\s+(?:\[(.)\]\s+)?(\d{1,2}):(\d{2})\s*(?:-|–|—|~|〜|～)\s*(\d{1,2}):(\d{2})\s*(.*?)\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*$/;
const FENCE_RE = /^\s*(```|~~~)/;

/** 見出しのセクション範囲を探す（コードブロック内・frontmatter は無視） */
function findSection(lines: string[], headingText: string): ListSection | null {
  let i = 0;
  if (lines[0]?.trim() === "---") {
    for (let k = 1; k < lines.length; k++) {
      if (lines[k].trim() === "---" || lines[k].trim() === "...") {
        i = k + 1;
        break;
      }
    }
  }
  let inFence = false;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = HEADING_RE.exec(line);
    if (m && m[2] === headingText) {
      const level = m[1].length;
      let j = i + 1;
      let fence = false;
      for (; j < lines.length; j++) {
        if (FENCE_RE.test(lines[j])) {
          fence = !fence;
          continue;
        }
        if (fence) continue;
        const mm = HEADING_RE.exec(lines[j]);
        if (mm && mm[1].length <= level) break;
      }
      return { headingIndex: i, bodyStart: i + 1, bodyEnd: j, level };
    }
  }
  return null;
}

/** ノート全体を解析して予定を取り出す */
export function parseListNote(content: string, headingSetting: string): ParsedListNote {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  const { text } = parseHeadingSetting(headingSetting);
  const section = findSection(lines, text);
  const events: ListEvent[] = [];
  const extras: string[] = [];

  if (section) {
    let current: ListEvent | null = null;
    for (let i = section.bodyStart; i < section.bodyEnd; i++) {
      const line = lines[i];
      const m = EVENT_LINE_RE.exec(line);
      if (m) {
        const start = Number(m[2]) * 60 + Number(m[3]);
        let end = Number(m[4]) * 60 + Number(m[5]);
        if (end <= start) end = Math.min(start + 30, 1440); // 不正な範囲は 30 分として扱う
        const checkChar = m[1] ?? null;
        current = {
          start: Math.min(start, 1439),
          end: Math.min(end, 1440),
          title: m[6],
          done: /x/i.test(checkChar ?? ""),
          children: [],
          checkChar,
        };
        events.push(current);
      } else if (line.trim() === "") {
        continue;
      } else if (/^\s/.test(line) && current) {
        current.children.push(line);
      } else {
        extras.push(line);
        current = null;
      }
    }
  }
  return { lines, eol, section, events, extras };
}

/** 予定にぶら下がっていた行のインデントを揃えて外す */
export function dedentChildren(children: string[]): string[] {
  const lines = trimBlankLines(children);
  if (!lines.length) return [];
  let indent = Infinity;
  for (const l of lines) {
    if (!l.trim()) continue;
    const m = /^[ \t]*/.exec(l);
    indent = Math.min(indent, (m ? m[0] : "").replace(/\t/g, "    ").length);
  }
  if (!isFinite(indent) || indent === 0) return lines;
  return lines.map((l) => {
    const m = /^[ \t]*/.exec(l);
    const ws = (m ? m[0] : "").replace(/\t/g, "    ");
    return ws.slice(indent) + l.slice((m ? m[0] : "").length);
  });
}
