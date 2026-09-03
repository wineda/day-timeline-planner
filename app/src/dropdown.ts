/**
 * スマホのヘッダー用ドロップダウンメニュー。
 *
 * Obsidian の Menu はスマホ（Platform.isPhone）では画面下から出るシートとして表示される。
 * 画面の上端にあるヘッダーのボタンを押してから、指を画面の下端まで運んで選ぶことになり、
 * 「押した場所のすぐ下に選択肢が出る」PC の感覚とかけ離れて使いにくかった。
 * ここでは押したボタンの真下に付く小さなメニュー（TickTick の表示切替と同じ見え方）を
 * 自前で描く。中身の組み立ては Obsidian の Menu と同じ書き方（addItem / setTitle /
 * setIcon / setChecked / onClick …）でできるようにし、呼び出し側は端末に応じて
 * どちらで出すかを選ぶだけにする。
 */
import { setIcon } from "obsidian";
import { iconName } from "./icons";

/** Obsidian の MenuItem と DropdownItem の両方が満たす、このプラグインで使う最小限の形 */
export interface MenuItemLike {
  setTitle(title: string): this;
  setIcon(icon: string | null): this;
  setChecked(checked: boolean | null): this;
  setDisabled(disabled: boolean): this;
  onClick(callback: (evt: MouseEvent | KeyboardEvent) => any): this;
}

/** Obsidian の Menu と DropdownMenu の両方が満たす形。メニューの中身を組み立てる関数はこれで受ける */
export interface MenuLike {
  addItem(cb: (item: MenuItemLike) => any): this;
  addSeparator(): this;
}

class DropdownItem implements MenuItemLike {
  title = "";
  icon: string | null = null;
  checked: boolean | null = null;
  disabled = false;
  callback: ((evt: MouseEvent | KeyboardEvent) => any) | null = null;

  setTitle(title: string): this {
    this.title = title;
    return this;
  }
  setIcon(icon: string | null): this {
    this.icon = icon;
    return this;
  }
  setChecked(checked: boolean | null): this {
    this.checked = checked;
    return this;
  }
  setDisabled(disabled: boolean): this {
    this.disabled = disabled;
    return this;
  }
  onClick(callback: (evt: MouseEvent | KeyboardEvent) => any): this {
    this.callback = callback;
    return this;
  }
}

type Entry = { kind: "item"; item: DropdownItem } | { kind: "separator" };

/** 画面の端からメニューまでの最小の余白（px） */
const EDGE_MARGIN = 8;
/** ボタンとメニューの間隔（px） */
const ANCHOR_GAP = 4;

/** 開いているメニュー（同時に出すのは1つだけ。別のを開いたら前のは閉じる） */
let current: DropdownMenu | null = null;

export class DropdownMenu implements MenuLike {
  private entries: Entry[] = [];
  private el: HTMLElement | null = null;
  private backdropEl: HTMLElement | null = null;
  private doc: Document | null = null;
  private win: Window | null = null;

  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    this.hide();
  };
  /** 回転やキーボードの出し入れで位置が狂うので、サイズが変わったら閉じる */
  private readonly onResize = () => this.hide();

  addItem(cb: (item: MenuItemLike) => any): this {
    const item = new DropdownItem();
    cb(item);
    this.entries.push({ kind: "item", item });
    return this;
  }

  addSeparator(): this {
    this.entries.push({ kind: "separator" });
    return this;
  }

  /** ボタン（anchor）の真下に出す。右端のボタンなら右ぞろえ、はみ出すなら画面内に収める */
  showAtElement(anchor: HTMLElement): this {
    current?.hide();
    current = this;
    const doc = anchor.ownerDocument;
    const win = doc.defaultView ?? window;
    this.doc = doc;
    this.win = win;

    // 外側のタップを受け止める透明な幕。タイムラインへタップが抜けて
    // 「＋ 時刻」チップが出たりしないよう、click ごと飲み込んで閉じるだけにする
    const backdrop = doc.body.createDiv("dt-dropdown-backdrop");
    backdrop.addEventListener("click", (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      this.hide();
    });
    backdrop.addEventListener("contextmenu", (e: MouseEvent) => e.preventDefault());
    this.backdropEl = backdrop;

    const el = doc.body.createDiv({ cls: "dt-dropdown", attr: { role: "menu" } });
    this.el = el;
    this.renderEntries(el);

    // 位置決め: まず縦（ボタンの下）と高さの上限を決め、幅が確定してから横を決める
    const r = anchor.getBoundingClientRect();
    const vw = win.innerWidth;
    const vh = win.innerHeight;
    const top = r.bottom + ANCHOR_GAP;
    el.style.top = `${Math.round(top)}px`;
    el.style.maxHeight = `${Math.max(120, Math.floor(vh - top - EDGE_MARGIN))}px`;
    const w = el.offsetWidth;
    // ボタンの右端にメニューの右端をそろえる（ヘッダーのボタンは右寄りにあることが多い）。
    // 左にはみ出す（ボタンが左寄り）なら左ぞろえにし、それでもはみ出すなら画面内へ寄せる
    let left = r.right - w;
    let alignRight = true;
    if (left < EDGE_MARGIN) {
      left = r.left;
      alignRight = false;
    }
    left = Math.max(EDGE_MARGIN, Math.min(left, vw - EDGE_MARGIN - w));
    el.style.left = `${Math.round(left)}px`;
    el.toggleClass("is-align-right", alignRight);

    doc.addEventListener("keydown", this.onKeyDown, true);
    win.addEventListener("resize", this.onResize);
    return this;
  }

  private renderEntries(el: HTMLElement): void {
    // アイコン付きの項目が1つでもあれば、無い項目にも同じ幅を空けて文字の頭をそろえる
    const hasIcons = this.entries.some((e) => e.kind === "item" && !!e.item.icon);
    el.toggleClass("has-icons", hasIcons);
    for (const entry of this.entries) {
      if (entry.kind === "separator") {
        el.createDiv("dt-dropdown-separator");
        continue;
      }
      const item = entry.item;
      if (item.disabled) {
        // Obsidian の Menu では、押せない項目を「一度に表示する時間」のような小見出しとして
        // 使っているので、ここでも見出しとして描く
        el.createDiv({ cls: "dt-dropdown-label", text: item.title });
        continue;
      }
      const row = el.createEl("button", {
        cls: "dt-dropdown-item",
        attr: {
          type: "button",
          role: item.checked === null ? "menuitem" : "menuitemcheckbox",
        },
      });
      if (item.checked !== null) row.setAttr("aria-checked", String(item.checked));
      row.toggleClass("is-checked", item.checked === true);
      if (hasIcons) {
        const ic = row.createSpan("dt-dropdown-icon");
        if (item.icon) setIcon(ic, iconName(item.icon));
      }
      row.createSpan({ cls: "dt-dropdown-title", text: item.title });
      if (item.checked === true) {
        const check = row.createSpan("dt-dropdown-check");
        setIcon(check, "check");
      }
      row.addEventListener("click", (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        this.hide();
        item.callback?.(e);
      });
    }
  }

  hide(): void {
    if (current === this) current = null;
    this.doc?.removeEventListener("keydown", this.onKeyDown, true);
    this.win?.removeEventListener("resize", this.onResize);
    this.el?.remove();
    this.backdropEl?.remove();
    this.el = null;
    this.backdropEl = null;
    this.doc = null;
    this.win = null;
  }

  /** 開いているメニューを閉じる（ビューを閉じるときなど） */
  static closeAll(): void {
    current?.hide();
  }
}
