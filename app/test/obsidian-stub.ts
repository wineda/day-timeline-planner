/**
 * テスト用の "obsidian" モジュールの代わり。
 * 本物の obsidian パッケージは型定義だけで実行時の中身が無いので、
 * settings.ts のように obsidian を import するモジュールをテストで読み込むためにこれを使う（vitest.config.ts の alias）。
 * import 時に評価される分（クラスの継承・関数の参照）だけ用意し、中身は空
 */

class Base {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
  constructor(..._args: unknown[]) {}
}

export class AbstractInputSuggest extends Base {}
export class App extends Base {}
export class Component extends Base {}
export class DropdownComponent extends Base {}
export class Editor extends Base {}
export class ItemView extends Component {}
export class MarkdownRenderer extends Base {
  static async render(): Promise<void> {}
}
export class MarkdownView extends ItemView {}
export class Menu extends Base {}
export class Modal extends Base {}
export class Notice extends Base {}
export class Plugin extends Component {}
export class PluginSettingTab extends Base {}
export class Setting extends Base {}
export class Scope extends Base {}
export class TAbstractFile extends Base {}
export class TFile extends TAbstractFile {}
export class TFolder extends TAbstractFile {}
export class Vault extends Base {}
export class WorkspaceLeaf extends Base {}

export const Platform = { isMobile: false, isDesktop: true, isPhone: false, isTablet: false };

export function debounce<T extends (...args: never[]) => unknown>(fn: T): T {
  return fn;
}
export function getIcon(): SVGSVGElement | null {
  return null;
}
export function setIcon(): void {}
export function prepareSimpleSearch(): () => null {
  return () => null;
}
export function renderMatches(): void {}
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
}
// ---- moment の最小版（format と厳密な parse だけ）----
// store.ts の「日付 ⇄ ノートのパス」の変換（YYYY-MM-DD など）をテストで通すためのもの。
// 対応する書式記号: YYYY / MM / M / DD / D / HH / H / mm / ss / ddd / dddd

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const TOKEN_RE = /YYYY|MM|DD|HH|mm|ss|dddd|ddd|M|D|H/g;
const pad2 = (n: number) => String(n).padStart(2, "0");

class MiniMoment {
  constructor(
    private d: Date,
    private valid = true
  ) {}
  isValid(): boolean {
    return this.valid && !Number.isNaN(this.d.getTime());
  }
  toDate(): Date {
    return new Date(this.d.getTime());
  }
  valueOf(): number {
    return this.d.getTime();
  }
  format(fmt: string): string {
    const d = this.d;
    return fmt.replace(TOKEN_RE, (t) => {
      switch (t) {
        case "YYYY":
          return String(d.getFullYear());
        case "MM":
          return pad2(d.getMonth() + 1);
        case "M":
          return String(d.getMonth() + 1);
        case "DD":
          return pad2(d.getDate());
        case "D":
          return String(d.getDate());
        case "HH":
          return pad2(d.getHours());
        case "H":
          return String(d.getHours());
        case "mm":
          return pad2(d.getMinutes());
        case "ss":
          return pad2(d.getSeconds());
        case "dddd":
          return WEEKDAYS[d.getDay()] + "day";
        case "ddd":
          return WEEKDAYS[d.getDay()];
      }
      return t;
    });
  }
}

/** 書式どおり（厳密）に読む。合わなければ無効な moment */
function parseStrict(text: string, fmt: string): MiniMoment {
  const names: string[] = [];
  let pattern = "";
  let last = 0;
  for (const m of fmt.matchAll(TOKEN_RE)) {
    pattern += fmt.slice(last, m.index).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    last = (m.index ?? 0) + m[0].length;
    names.push(m[0]);
    pattern += m[0].length === 4 ? "(\\d{4})" : m[0].length === 2 ? "(\\d{2})" : "(\\d{1,2})";
  }
  pattern += fmt.slice(last).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hit = new RegExp("^" + pattern + "$").exec(text);
  if (!hit) return new MiniMoment(new Date(NaN), false);
  let y = 1970;
  let mo = 1;
  let day = 1;
  let h = 0;
  let mi = 0;
  let s = 0;
  names.forEach((n, i) => {
    const v = Number(hit[i + 1]);
    if (n === "YYYY") y = v;
    else if (n === "MM" || n === "M") mo = v;
    else if (n === "DD" || n === "D") day = v;
    else if (n === "HH" || n === "H") h = v;
    else if (n === "mm") mi = v;
    else if (n === "ss") s = v;
  });
  const d = new Date(y, mo - 1, day, h, mi, s);
  // 2月30日のような繰り上がりは無効
  const ok = d.getFullYear() === y && d.getMonth() === mo - 1 && d.getDate() === day;
  return new MiniMoment(d, ok);
}

export function moment(input?: Date | string | number, fmt?: string, _strict?: boolean): MiniMoment {
  if (input === undefined) return new MiniMoment(new Date());
  if (input instanceof Date) return new MiniMoment(new Date(input.getTime()));
  if (typeof input === "number") return new MiniMoment(new Date(input));
  if (fmt) return parseStrict(input, fmt);
  const d = new Date(input);
  return new MiniMoment(d, !Number.isNaN(d.getTime()));
}
