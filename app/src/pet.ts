/**
 * ペット: いま対応中のタスクが結びついているプロジェクトのモンスターを、画面の好きな位置に出す
 * （ボス戦の仲間。Codex のペットのような小さな浮かぶウィジェット）。
 * ドラッグで動かせて位置は設定に記憶される。クリックでそのタスクを編集、右クリックでメニュー。
 *
 * 保存で一撃が入るときは、ペットがゆっくり画面の中央へ来て、その場で演出（一撃・討伐）を受ける。
 * まだ残っていれば元の位置へゆっくり戻り、討伐なら消えて、次の相手が元の位置に現れる
 */
import { Menu } from "obsidian";
import { monsterSVG, type Monster } from "./bestiary";
import { hpRatio, playBattle, type BattleHp, type BattlePuppet, type BattleStageOptions } from "./battle";

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

/** 演出のときにペットへ渡すもの（ステージのモンスターの代わりにペットを殴る） */
export type PetBattleOptions = Omit<BattleStageOptions, "anchor" | "onHit" | "puppet">;

const PET_SIZE: Record<Monster["rank"], number> = { 雑魚: 40, 中級: 50, ボス: 60 };
const MARGIN = 8;
/** 中央へ行く・戻るのにかける時間（ms）。CSS の .dt-pet.is-traveling と合わせる */
const TRAVEL_MS = 800;
/** 討伐で消えるのにかける時間（ms）。CSS の .dt-pet.is-vanish と合わせる */
const VANISH_MS = 450;

const wait = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

export class PetWidget {
  private el: HTMLElement | null = null;
  private spriteEl: HTMLElement | null = null;
  private bubbleEl: HTMLElement | null = null;
  private info: PetInfo | null = null;
  /** 演出中。update は演出が終わるまで保留する（途中で姿や位置が変わらないように） */
  private battling = false;
  /** 演出中に届いた update の内容（undefined = 届いていない） */
  private pending: PetInfo | null | undefined = undefined;
  private onResize = () => {
    if (!this.battling) this.place();
  };

  constructor(private handlers: PetHandlers) {}

  /** いまの情報で描き直す。null なら隠す。演出中は終わってから反映する */
  update(info: PetInfo | null): void {
    if (this.battling) {
      this.pending = info;
      return;
    }
    this.info = info;
    if (!info) {
      this.destroy();
      return;
    }
    if (!this.el) this.build();
    const el = this.el!;
    this.drawSprite(info.monster, hpRatio(info.hp));
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

  /** 演出に合わせてのけぞる（ステージが別の場所で再生されているとき用） */
  react(kind: "small" | "big" | "kill"): void {
    const sprite = this.spriteEl;
    if (!sprite) return;
    const cls = kind === "small" ? "is-flinch" : "is-shake";
    sprite.removeClass("is-flinch", "is-shake");
    void sprite.offsetWidth;
    sprite.addClass(cls);
  }

  /**
   * 保存の演出をペットの上で再生する。
   * 1. 相手のモンスターの姿になって（別のタスクを編集したときのため）、ゆっくり画面の中央へ
   * 2. その場で一撃・討伐の演出
   * 3. 討伐なら消える。まだ残っていれば元の位置へゆっくり戻る
   * 4. 演出中に保留した update（次の相手）を反映する。消えたあとに次の相手がいれば元の位置に現れる
   * 演出が終わると解決する
   */
  async playBattle(o: PetBattleOptions): Promise<void> {
    if (this.battling) return;
    this.battling = true;
    this.pending = undefined;
    try {
      if (!this.el) this.build();
      const el = this.el!;
      const sprite = this.spriteEl!;
      el.addClass("is-battling");
      const size = PET_SIZE[o.monster.rank];
      const ratio = o.hp.total > 0 ? Math.min(1, (o.hp.remain + o.event.smallHits * o.event.smallDamage + o.event.bigDamage) / o.hp.total) : 1;
      this.drawSprite(o.monster, ratio, size);
      if (!this.info) this.place(); // 隠れていた（相手がいなかった）ときは、元の位置から出発する
      const puppet: BattlePuppet = {
        el: sprite,
        size,
        draw: (r) => this.drawSprite(o.monster, r, size),
      };
      await this.travelTo(this.centerPoint());
      await playBattle({ ...o, anchor: null, puppet });
      const kill = o.hp.remain <= 0 && o.hp.total > 0;
      if (kill) {
        el.addClass("is-vanish");
        await wait(VANISH_MS);
      } else {
        await this.travelTo(this.homePoint());
      }
    } finally {
      this.endBattle();
    }
  }

  destroy(): void {
    window.removeEventListener("resize", this.onResize);
    this.el?.remove();
    this.el = null;
    this.spriteEl = null;
    this.bubbleEl = null;
  }

  private drawSprite(monster: Monster, ratio: number, size = PET_SIZE[monster.rank]): void {
    const sprite = this.spriteEl;
    if (!sprite) return;
    sprite.style.width = `${size}px`;
    sprite.style.height = `${size}px`;
    sprite.innerHTML = monsterSVG(monster, ratio, size);
  }

  /** 演出の終わり: 一時的なクラスを外し、保留していた update（無ければ元の姿）を反映する */
  private endBattle(): void {
    this.battling = false;
    const el = this.el;
    const vanished = !!el?.hasClass("is-vanish");
    el?.removeClass("is-battling", "is-traveling", "is-vanish");
    this.spriteEl?.removeClass("is-flinch", "is-shake", "is-tremble", "is-fall");
    const next = this.pending !== undefined ? this.pending : this.info;
    this.pending = undefined;
    this.update(next);
    // 消えたあとに次の相手がいれば、元の位置にふわっと現れる
    if (vanished && next && this.el) {
      this.el.removeClass("is-appear");
      void this.el.offsetWidth;
      this.el.addClass("is-appear");
    }
  }

  private build(): void {
    document.body.querySelectorAll(".dt-pet").forEach((e) => e.remove());
    const el = document.body.createDiv("dt-pet");
    this.el = el;
    this.bubbleEl = el.createDiv("dt-pet-bubble");
    this.spriteEl = el.createDiv("dt-pet-sprite");
    window.addEventListener("resize", this.onResize);

    // ドラッグ（ポインター）。動かさずに離したらクリック扱い。演出中は動かせない
    let start: { x: number; y: number; left: number; top: number } | null = null;
    let moved = false;
    el.addEventListener("pointerdown", (e: PointerEvent) => {
      if (e.button !== 0 || this.battling) return;
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
      if (this.battling) return;
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

  /** 記憶した位置（無ければ右下）。画面からはみ出さないように収めた左上の座標 */
  private homePoint(): PetPosition {
    const el = this.el;
    const w = el?.offsetWidth || 60;
    const h = el?.offsetHeight || 60;
    const p = this.handlers.getPosition();
    const x = p ? p.x : window.innerWidth - w - 24;
    const y = p ? p.y : window.innerHeight - h - 72;
    return this.clamp(x, y);
  }

  /** 画面の中央（ペットの中心が来る左上の座標） */
  private centerPoint(): PetPosition {
    const el = this.el;
    const w = el?.offsetWidth || 60;
    const h = el?.offsetHeight || 60;
    return this.clamp((window.innerWidth - w) / 2, (window.innerHeight - h) / 2);
  }

  /** 記憶した位置（無ければ右下）に置く */
  private place(): void {
    const p = this.homePoint();
    this.moveTo(p.x, p.y);
  }

  /** ゆっくり移動する（CSS のトランジション）。着いたら解決 */
  private async travelTo(p: PetPosition): Promise<void> {
    const el = this.el;
    if (!el) return;
    const cur = el.getBoundingClientRect();
    if (Math.abs(cur.left - p.x) < 1 && Math.abs(cur.top - p.y) < 1) return;
    el.addClass("is-traveling");
    void el.offsetWidth;
    this.moveTo(p.x, p.y);
    await wait(TRAVEL_MS + 50);
    el.removeClass("is-traveling");
  }

  private clamp(x: number, y: number): PetPosition {
    const el = this.el;
    const w = el?.offsetWidth || 60;
    const h = el?.offsetHeight || 60;
    return {
      x: Math.min(Math.max(MARGIN, x), Math.max(MARGIN, window.innerWidth - w - MARGIN)),
      y: Math.min(Math.max(MARGIN, y), Math.max(MARGIN, window.innerHeight - h - MARGIN)),
    };
  }

  private moveTo(x: number, y: number): void {
    const el = this.el;
    if (!el) return;
    const c = this.clamp(x, y);
    el.style.left = `${c.x}px`;
    el.style.top = `${c.y}px`;
  }
}
