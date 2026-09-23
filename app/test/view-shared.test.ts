/**
 * view-shared.ts: サブメニューの補助（addSubmenu）。
 * Obsidian の MenuItem.setSubmenu は公開 API に無いので、あるときはサブメニューに、無いときは見出しの下に平らに並べる
 */
import { describe, expect, it } from "vitest";
import type { Menu } from "obsidian";
import { addSubmenu } from "../src/view-shared";

interface FakeItem {
  title: string;
  icon: string | null;
  label: boolean;
  setTitle(t: string): FakeItem;
  setIcon(i: string | null): FakeItem;
  setIsLabel(v: boolean): FakeItem;
  onClick(cb: () => void): FakeItem;
  setSubmenu?: () => FakeMenu;
}

class FakeMenu {
  items: FakeItem[] = [];
  submenus: FakeMenu[] = [];
  constructor(private withSubmenu: boolean) {}
  addItem(cb: (item: FakeItem) => unknown): this {
    const menu = this;
    const item: FakeItem = {
      title: "",
      icon: null,
      label: false,
      setTitle(t) {
        this.title = t;
        return this;
      },
      setIcon(i) {
        this.icon = i;
        return this;
      },
      setIsLabel(v) {
        this.label = v;
        return this;
      },
      onClick() {
        return this;
      },
    };
    if (this.withSubmenu) {
      item.setSubmenu = () => {
        const sub = new FakeMenu(true);
        menu.submenus.push(sub);
        return sub;
      };
    }
    this.items.push(item);
    cb(item);
    return this;
  }
  addSeparator(): this {
    return this;
  }
}

const asMenu = (m: FakeMenu) => m as unknown as Menu;

describe("addSubmenu", () => {
  it("setSubmenu があれば、項目はサブメニューに入る", () => {
    const menu = new FakeMenu(true);
    addSubmenu(asMenu(menu), "渡す", "users", (sub) => {
      sub.addItem((i) => i.setTitle("田中"));
      sub.addItem((i) => i.setTitle("佐藤"));
    });
    expect(menu.items.map((i) => [i.title, i.label])).toEqual([["渡す", false]]);
    expect(menu.submenus).toHaveLength(1);
    expect(menu.submenus[0].items.map((i) => i.title)).toEqual(["田中", "佐藤"]);
  });

  it("setSubmenu が無ければ、見出し（ラベル）の下に平らに並ぶ", () => {
    const menu = new FakeMenu(false);
    addSubmenu(asMenu(menu), "ドキュメント", "book-open", (sub) => {
      sub.addItem((i) => i.setTitle("設計書"));
    });
    expect(menu.items.map((i) => [i.title, i.label])).toEqual([
      ["ドキュメント", true],
      ["設計書", false],
    ]);
    expect(menu.submenus).toHaveLength(0);
  });
});
