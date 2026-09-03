/**
 * モック用の Obsidian の代わり。ブラウザ単体で pet.ts / battle.ts / bestiary.ts を動かすのに必要なぶんだけ。
 * Obsidian が HTMLElement に生やしている createDiv などのヘルパーもここで生やす
 */

type ElInfo = string | { cls?: string | string[]; text?: string; attr?: Record<string, string>; title?: string };

function applyInfo(el: HTMLElement, o?: ElInfo): void {
  if (!o) return;
  if (typeof o === "string") {
    el.className = o;
    return;
  }
  if (o.cls) el.className = Array.isArray(o.cls) ? o.cls.join(" ") : o.cls;
  if (o.text !== undefined) el.textContent = o.text;
  if (o.title) el.title = o.title;
  if (o.attr) for (const [k, v] of Object.entries(o.attr)) el.setAttribute(k, v);
}

const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
const def = (name: string, fn: unknown) => {
  if (!(name in proto)) Object.defineProperty(proto, name, { value: fn, writable: true, configurable: true });
};
def("createEl", function (this: HTMLElement, tag: string, o?: ElInfo) {
  const el = document.createElement(tag);
  applyInfo(el, o);
  this.appendChild(el);
  return el;
});
def("createDiv", function (this: HTMLElement, o?: ElInfo) {
  return (this as unknown as { createEl: (t: string, o?: ElInfo) => HTMLElement }).createEl("div", o);
});
def("createSpan", function (this: HTMLElement, o?: ElInfo) {
  return (this as unknown as { createEl: (t: string, o?: ElInfo) => HTMLElement }).createEl("span", o);
});
def("empty", function (this: HTMLElement) {
  this.replaceChildren();
});
def("setText", function (this: HTMLElement, t: string) {
  this.textContent = t;
});
def("setAttr", function (this: HTMLElement, k: string, v: string | number | boolean) {
  this.setAttribute(k, String(v));
});
def("addClass", function (this: HTMLElement, ...cls: string[]) {
  this.classList.add(...cls);
});
def("removeClass", function (this: HTMLElement, ...cls: string[]) {
  this.classList.remove(...cls);
});
def("toggleClass", function (this: HTMLElement, cls: string, on: boolean) {
  this.classList.toggle(cls, on);
});
def("hasClass", function (this: HTMLElement, cls: string) {
  return this.classList.contains(cls);
});
def("find", function (this: HTMLElement, sel: string) {
  return this.querySelector(sel);
});
// document.body.createDiv のために Document にも（body は HTMLElement なので不要だが念のため）
(window as unknown as { createDiv?: unknown }).createDiv = (o?: ElInfo) =>
  (document.body as unknown as { createDiv: (o?: ElInfo) => HTMLElement }).createDiv(o);
(globalThis as unknown as { createDiv?: unknown }).createDiv = (o?: ElInfo) => {
  const el = document.createElement("div");
  applyInfo(el, o);
  return el;
};

// ---- モジュールとしての export（使われる名前だけ。中身は最小） ----

class MenuItem {
  title = "";
  icon = "";
  cb: (() => void) | null = null;
  setTitle(t: string) {
    this.title = t;
    return this;
  }
  setIcon(i: string) {
    this.icon = i;
    return this;
  }
  onClick(cb: () => void) {
    this.cb = cb;
    return this;
  }
}

export class Menu {
  private items: (MenuItem | "sep")[] = [];
  addItem(cb: (i: MenuItem) => void) {
    const it = new MenuItem();
    cb(it);
    this.items.push(it);
    return this;
  }
  addSeparator() {
    this.items.push("sep");
    return this;
  }
  showAtMouseEvent(e: MouseEvent) {
    document.querySelectorAll(".mock-menu").forEach((m) => m.remove());
    const menu = document.body.createDiv("mock-menu");
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;
    for (const it of this.items) {
      if (it === "sep") {
        menu.createDiv("mock-menu-sep");
        continue;
      }
      const row = menu.createDiv({ cls: "mock-menu-item", text: it.title });
      row.addEventListener("click", () => {
        menu.remove();
        it.cb?.();
      });
    }
    const close = (ev: MouseEvent) => {
      if (!menu.contains(ev.target as Node)) {
        menu.remove();
        document.removeEventListener("pointerdown", close);
      }
    };
    window.setTimeout(() => document.addEventListener("pointerdown", close), 0);
  }
}

export class Notice {
  constructor(msg: string) {
    const el = document.body.createDiv({ cls: "mock-notice", text: msg });
    window.setTimeout(() => el.remove(), 3000);
  }
}

export class App {}
export class TFile {}
export class TFolder {}
export function normalizePath(p: string): string {
  return p;
}
export function setIcon(_el: HTMLElement, _icon: string): void {}
export function getIcon(_icon: string): SVGSVGElement | null {
  return null;
}
export function moment(): never {
  throw new Error("moment はモックでは使えません");
}
