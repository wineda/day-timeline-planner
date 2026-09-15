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
export class TFile extends Base {}
export class TFolder extends Base {}
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
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
}
export function moment(): never {
  throw new Error("moment はテストでは使えません");
}
