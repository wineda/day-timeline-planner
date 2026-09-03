/**
 * ペット: いま対応中のタスクが結びついているプロジェクトのモンスターを、画面の好きな位置に出す
 * （ボス戦の仲間。Codex のペットのような小さな浮かぶウィジェット）。
 * ドラッグで動かせて位置は設定に記憶される。クリックでそのタスクを編集、右クリックでメニュー。
 * 一撃・討伐の演出に合わせてのけぞる
 */
import { Menu } from "obsidian";
import { monsterSVG, type Monster } from "./bestiary";
import { hpRatio, type BattleHp } from "./battle";

export interface PetInfo {
  monster: Monster;
  hp: BattleHp;
  /** プロジェクトのリンク先（演出の照合に使う） */
  projectLink: string;
  projectName: string;
  taskTitle: string;
  /** 「計測中」「いま」「次」「未了」「未定」 */
  label: string;
  /** プロジェクトに属さないタスクを 1 件 1 体として出しているか（プロジェクトノートは無い） */
  solo?: boolean;
}

export interface PetPosition {
  x: number;
  y: number;
}

export interface PetHandlers {
  getPosition: () => PetPosition | null;
  setPosition: (p: PetPosition) => void;
  onClick: () => void;
  onOpenProject: () => void;
  onHide: () => void;
}

const PET_SIZE: Record<Monster["rank"], number> = { 雑魚: 40, 中級: 50, ボス: 60 };
const MARGIN = 8;

export class PetWidget {
  private el: HTMLElement | null = null;
  private spriteEl: HTMLElement | null = null;
  private bubbleEl: HTMLElement | null = null;
  private info: PetInfo | null = null;
  private onResize = () => this.place();

  constructor(private handlers: PetHandlers) {}

  /** いまの情報で描き直す。null なら隠す */
  update(info: PetInfo | null): void {
    this.info = info;
    if (!info) {
      this.destroy();
      return;
    }
    if (!this.el) this.build();
    const el = this.el!;
    const size = PET_SIZE[info.monster.rank];
    const sprite = this.spriteEl!;
    sprite.style.width = `${size}px`;
    sprite.style.height = `${size}px`;
    sprite.innerHTML = monsterSVG(info.monster, hpRatio(info.hp), size);
    const hmm = (m: number) => `${Math.floor(m / 60)}:${String(Math.round(m) % 60).padStart(2, "0")}`;
    const bubble = this.bubbleEl!;
    bubble.empty();
    bubble.createDiv({ cls: "dt-pet-bubble-label", text: `${info.label}: ${info.taskTitle}` });
    // 単独タスクはプロジェクト名がタスク名と同じなので、HP だけを出す
    const hpText = `HP ${hmm(info.hp.remain)} / ${hmm(info.hp.total)}`;
    bubble.createDiv({
      cls: "dt-pet-bubble-project",
      text: info.solo ? `${info.monster.rank} · ${hpText}` : `${info.projectName} · ${hpText}`,
    });
    el.setAttr(
      "aria-label",
      info.solo ? `${info.label}: ${info.taskTitle}` : `${info.label}: ${info.taskTitle}（${info.projectName}）`
    );
    this.place();
  }

  /** 演出に合わせてのけぞる */
  react(kind: "small" | "big" | "kill"): void {
    const sprite = this.spriteEl;
    if (!sprite) return;
    const cls = kind === "small" ? "is-flinch" : "is-shake";
    sprite.removeClass("is-flinch", "is-shake");
    void sprite.offsetWidth;
    sprite.addClass(cls);
  }

  destroy(): void {
    window.removeEventListener("resize", this.onResize);
    this.el?.remove();
    this.el = null;
    this.spriteEl = null;
    this.bubbleEl = null;
  }

  private build(): void {
    document.body.querySelectorAll(".dt-pet").forEach((e) => e.remove());
    const el = document.body.createDiv("dt-pet");
    this.el = el;
    this.bubbleEl = el.createDiv("dt-pet-bubble");
    this.spriteEl = el.createDiv("dt-pet-sprite");
    window.addEventListener("resize", this.onResize);

    // ドラッグ（ポインター）。動かさずに離したらクリック扱い
    let start: { x: number; y: number; left: number; top: number } | null = null;
    let moved = false;
    el.addEventListener("pointerdown", (e: PointerEvent) => {
      if (e.button !== 0) return;
      const r = el.getBoundingClientRect();
      start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
      moved = false;
      el.setPointerCapture(e.pointerId);
      el.addClass("is-dragging");
      e.preventDefault();
    });
    el.addEventListener("pointermove", (e: PointerEvent) => {
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      moved = true;
      this.moveTo(start.left + dx, start.top + dy);
    });
    const finish = (e: PointerEvent) => {
      if (!start) return;
      el.removeClass("is-dragging");
      try {
        el.releasePointerCapture(e.pointerId);
      } catch (_e) {
        /* すでに解放済み */
      }
      const wasMoved = moved;
      start = null;
      if (wasMoved) {
        const r = el.getBoundingClientRect();
        this.handlers.setPosition({ x: r.left, y: r.top });
      } else if (e.type === "pointerup") {
        this.handlers.onClick();
      }
    };
    el.addEventListener("pointerup", finish);
    el.addEventListener("pointercancel", finish);
    el.addEventListener("contextmenu", (e: MouseEvent) => {
      e.preventDefault();
      const menu = new Menu();
      menu.addItem((i) => i.setTitle("タスクを編集").setIcon("pencil").onClick(() => this.handlers.onClick()));
      // 単独タスク（1 件 1 体）にはプロジェクトノートが無い
      if (!this.info?.solo) {
        menu.addItem((i) =>
          i.setTitle("プロジェクトノートを開く").setIcon("folder-open").onClick(() => this.handlers.onOpenProject())
        );
      }
      menu.addSeparator();
      menu.addItem((i) => i.setTitle("ペットを隠す（設定で戻せます）").setIcon("eye-off").onClick(() => this.handlers.onHide()));
      menu.showAtMouseEvent(e);
    });
  }

  /** 記憶した位置（無ければ右下）に置く。画面からはみ出さないように収める */
  private place(): void {
    const el = this.el;
    if (!el) return;
    const p = this.handlers.getPosition();
    const w = el.offsetWidth || 60;
    const h = el.offsetHeight || 60;
    const x = p ? p.x : window.innerWidth - w - 24;
    const y = p ? p.y : window.innerHeight - h - 72;
    this.moveTo(x, y);
  }

  private moveTo(x: number, y: number): void {
    const el = this.el;
    if (!el) return;
    const w = el.offsetWidth || 60;
    const h = el.offsetHeight || 60;
    const cx = Math.min(Math.max(MARGIN, x), Math.max(MARGIN, window.innerWidth - w - MARGIN));
    const cy = Math.min(Math.max(MARGIN, y), Math.max(MARGIN, window.innerHeight - h - MARGIN));
    el.style.left = `${cx}px`;
    el.style.top = `${cy}px`;
  }
}
