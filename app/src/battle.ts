/**
 * プロジェクト＝ボス戦。
 *
 * プロジェクトの子タスクの予定時間の合計をモンスターの HP とみなし、ステップのチェックとタスクの完了で
 * ダメージが入る。パネルの行にはモンスターと HP バーを出し、保存のたびに「小（ステップ）・大（タスク完了）・
 * 討伐（最後のタスク）」の演出をその行の上に重ねて再生する（行そのものは再読み込みで作り直されるので、
 * 演出は別のオーバーレイで行う）。
 */
import type { ProjectSummary } from "./project";
import type { Task, TaskDraft } from "./model";
import { isScheduled } from "./model";
import {
  monsterByName,
  monsterSVG,
  pickMonster,
  rankForHours,
  RANK_STARS,
  type Monster,
  type MonsterRank,
} from "./bestiary";

/** ランクを決める閾値（時間）と、時刻の無いタスクを何分とみなすか */
export interface BattleRules {
  midHours: number;
  bossHours: number;
  defaultMinutes: number;
}

/** プロジェクトの HP（分） */
export interface BattleHp {
  total: number;
  remain: number;
}

/** パネルの行とオーバーレイに出す、モンスターの大きさ（px） */
export const SPRITE_SIZE: Record<MonsterRank, number> = { 雑魚: 30, 中級: 38, ボス: 46 };

/** タスク1件の重さ（分）。時刻が無ければ既定の長さ */
export function taskWeight(t: Task, rules: BattleRules): number {
  return isScheduled(t) ? Math.max(0, t.end - t.start) : rules.defaultMinutes;
}

/** 1ステップぶんのダメージ（分） */
export function stepDamage(t: Task, rules: BattleRules): number {
  const n = t.steps.filter((st) => st.text.trim()).length;
  return n ? taskWeight(t, rules) / n : 0;
}

/**
 * プロジェクトの HP。完了（持ち越し先で完了したものも）したタスクはその重さぶん、
 * 未完了のタスクはチェック済みステップぶんだけ削れている
 */
export function projectHp(sum: ProjectSummary, rules: BattleRules): BattleHp {
  let total = 0;
  let done = 0;
  for (const c of sum.children) {
    const w = taskWeight(c.task, rules);
    total += w;
    if (c.task.done || c.settledByCarry || c.task.forwarded) done += w;
    else {
      const steps = c.task.steps.filter((st) => st.text.trim());
      if (steps.length) done += (w * steps.filter((st) => st.done).length) / steps.length;
    }
  }
  return { total, remain: Math.max(0, total - done) };
}

export function hpRatio(hp: BattleHp): number {
  return hp.total > 0 ? hp.remain / hp.total : 1;
}

/**
 * プロジェクトのモンスター。ノートの「- モンスター: 名前」があればそれ。
 * 無ければ「- 難易度: 」（作成時・右クリックで選んだランク）、それも無ければ予定時間の合計から決めたランクの中で
 * 名前から自動で選ぶ
 */
export function monsterOf(sum: ProjectSummary, rules: BattleRules): Monster {
  const named = sum.fields?.monster ? monsterByName(sum.fields.monster) : undefined;
  if (named) return named;
  const rank =
    sum.fields?.difficulty ?? rankForHours(projectHp(sum, rules).total / 60, rules.midHours, rules.bossHours);
  return pickMonster(sum.ref.linktext, rank);
}

export function monsterLabel(m: Monster): string {
  return `${m.rank} ${RANK_STARS[m.rank]} ${m.name}`;
}

/** 保存の前後を比べるための、タスクの状態の写し */
export interface BattleSnapshot {
  stepsDone: number;
  done: boolean;
  forwarded: boolean;
}

export function snapshotOf(t: Task): BattleSnapshot {
  return { stepsDone: t.steps.filter((st) => st.done && st.text.trim()).length, done: t.done, forwarded: t.forwarded };
}

/** 保存で起きた出来事（演出の入力） */
export interface BattleEvent {
  /** 小の一撃（新しくチェックしたステップ）の数 */
  smallHits: number;
  /** 小の一撃1発のダメージ（分） */
  smallDamage: number;
  /** 大の一撃（タスク完了）のダメージ（分）。0 なら無し */
  bigDamage: number;
}

/**
 * 保存前（before）と保存内容（data）からダメージを求める。
 * ステップ: 新しくチェックした数 × 1ステップぶん。完了: そのタスクの残り（未チェックのステップぶん）
 */
export function battleEvent(before: BattleSnapshot, task: Task, data: TaskDraft, rules: BattleRules): BattleEvent {
  const steps = (data.steps ?? task.steps).filter((st) => st.text.trim());
  const after: Task = { ...task, steps, start: data.start, end: data.end };
  const weight = taskWeight(after, rules);
  const per = steps.length ? weight / steps.length : 0;
  const nowDone = steps.filter((st) => st.done).length;
  const smallHits = before.done || before.forwarded ? 0 : Math.max(0, nowDone - before.stepsDone);
  const completes = !!data.done && !before.done && !before.forwarded;
  const bigDamage = completes ? Math.max(0, weight - per * nowDone) : 0;
  return { smallHits, smallDamage: Math.round(per), bigDamage: Math.round(bigDamage) };
}

// ---------------------------------------------------------------------------
// 効果音（Web Audio のノイズ。ファイルは持たない）

export function hitSound(kind: "small" | "big" | "kill"): void {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ac = new Ctx();
    const t = ac.currentTime;
    const big = kind !== "small";
    const len = big ? 0.22 : 0.09;
    const buf = ac.createBuffer(1, Math.floor(ac.sampleRate * len), ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, big ? 2 : 3);
    const src = ac.createBufferSource();
    src.buffer = buf;
    const f = ac.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.setValueAtTime(big ? 900 : 2200, t);
    f.frequency.exponentialRampToValueAtTime(big ? 120 : 400, t + len);
    const g = ac.createGain();
    g.gain.setValueAtTime(big ? 0.8 : 0.3, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + len);
    src.connect(f).connect(g).connect(ac.destination);
    src.start(t);
    if (big) {
      const o = ac.createOscillator();
      o.type = "square";
      o.frequency.setValueAtTime(kind === "kill" ? 70 : 110, t);
      o.frequency.exponentialRampToValueAtTime(30, t + 0.25);
      const og = ac.createGain();
      og.gain.setValueAtTime(0.3, t);
      og.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
      o.connect(og).connect(ac.destination);
      o.start(t);
      o.stop(t + 0.3);
    }
    window.setTimeout(() => void ac.close(), 600);
  } catch (_e) {
    /* 音が鳴らせない環境 */
  }
}

// ---------------------------------------------------------------------------
// 演出

const wait = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

function hmm(min: number): string {
  return `${Math.floor(min / 60)}:${String(Math.round(min) % 60).padStart(2, "0")}`;
}

/** クラスを付け直してアニメーションを頭から再生する */
function replay(el: HTMLElement, cls: string): void {
  el.removeClass(cls);
  void el.offsetWidth;
  el.addClass(cls);
}

export interface BattleStageOptions {
  monster: Monster;
  title: string;
  hp: BattleHp;
  /** 討伐したときに出す総工数（分） */
  totalWork: number;
  event: BattleEvent;
  sound: boolean;
  /** 演出を重ねる相手の行（無ければビューの隅に出す） */
  anchor: HTMLElement | null;
  /** ビューの内容（行が見えているかの判定と、隅に出すときの位置に使う） */
  host: HTMLElement;
}

/**
 * 演出を1回ぶん再生する。HP は「保存後の残り + ダメージ」から始めて、
 * 一撃ごとに減らしていく。終わったらオーバーレイを消す（下の行は保存後の状態になっている）
 */
export async function playBattle(o: BattleStageOptions): Promise<void> {
  const { event: ev, monster } = o;
  if (!ev.smallHits && !ev.bigDamage) return;
  const damage = ev.smallHits * ev.smallDamage + ev.bigDamage;
  const total = Math.max(o.hp.total, 1);
  let remain = Math.min(total, o.hp.remain + damage);
  const kill = o.hp.remain <= 0 && o.hp.total > 0;
  const size = SPRITE_SIZE[monster.rank];

  // 行の上に重ねる（行が見えていなければビューの右下に出す）。
  // 行は再読み込みで作り直されるので、行の中ではなく document.body に画面座標（fixed）で置く
  const host = o.host;
  document.body.querySelectorAll(".dt-battle").forEach((el) => el.remove());
  const stage = document.body.createDiv("dt-battle");
  const hostRect = host.getBoundingClientRect();
  const a = o.anchor?.getBoundingClientRect();
  const visible =
    !!a &&
    a.width > 0 &&
    a.bottom > hostRect.top &&
    a.top < hostRect.bottom &&
    a.right > hostRect.left &&
    a.left < hostRect.right;
  if (a && visible) {
    stage.addClass("is-anchored");
    stage.style.left = `${a.left}px`;
    stage.style.top = `${a.top}px`;
    stage.style.width = `${a.width}px`;
    stage.style.minHeight = `${a.height}px`;
  } else {
    stage.addClass("is-floating");
    const w = Math.min(280, Math.max(160, hostRect.width - 32));
    stage.style.width = `${w}px`;
    stage.style.left = `${hostRect.right - w - 16}px`;
    stage.style.top = `${hostRect.bottom - 16 - 60}px`;
  }
  const flash = stage.createDiv("dt-battle-flash");
  const monWrap = stage.createDiv("dt-battle-mon-wrap");
  monWrap.style.width = `${size}px`;
  monWrap.style.height = `${size}px`;
  const mon = monWrap.createDiv("dt-battle-mon");
  const slashS = monWrap.createDiv("dt-battle-slash");
  const slashB = monWrap.createDiv("dt-battle-slash is-big");
  const slashC = monWrap.createDiv("dt-battle-slash is-big is-cross");
  const info = stage.createDiv("dt-battle-info");
  info.createDiv({ cls: "dt-battle-title", text: o.title });
  const bar = info.createDiv("dt-battle-bar");
  const ghost = bar.createDiv("dt-battle-ghost");
  const fill = bar.createDiv("dt-battle-fill");
  const hpt = info.createDiv("dt-battle-hpt");
  const stamp = stage.createDiv({ cls: "dt-battle-stamp", text: "討伐" });

  const draw = (ratioOverride?: number) => {
    const ratio = Math.max(0, remain / total);
    mon.innerHTML = monsterSVG(monster, ratioOverride ?? ratio, size);
    fill.style.width = `${ratio * 100}%`;
    fill.toggleClass("is-mid", ratio <= 0.5 && ratio > 0.2);
    fill.toggleClass("is-low", ratio <= 0.2);
    hpt.setText(`HP ${hmm(remain)} / ${hmm(total)}`);
  };
  const pop = (text: string, big: boolean) => {
    const d = monWrap.createDiv({ cls: "dt-battle-dmg" + (big ? " is-big" : ""), text });
    d.style.left = `${40 + Math.random() * 20}%`;
    replay(d, "is-on");
    window.setTimeout(() => d.remove(), 1000);
  };

  draw();
  ghost.style.width = fill.style.width;
  await wait(120);

  for (let i = 0; i < ev.smallHits; i++) {
    remain = Math.max(0, remain - ev.smallDamage);
    replay(mon, "is-flinch");
    replay(slashS, "is-on");
    pop(`−${hmm(ev.smallDamage)}`, false);
    if (o.sound) hitSound("small");
    draw();
    await wait(110);
  }
  if (ev.bigDamage) {
    if (ev.smallHits) await wait(180);
    remain = kill ? 0 : Math.max(0, remain - ev.bigDamage);
    replay(stage, "is-shake");
    replay(flash, "is-on");
    replay(slashB, "is-on");
    replay(slashC, "is-on");
    pop(`−${hmm(ev.bigDamage)}`, true);
    if (o.sound) hitSound(kill ? "kill" : "big");
    draw(kill ? 0.05 : undefined);
  }
  if (kill) {
    await wait(350);
    replay(mon, "is-tremble");
    await wait(900);
    mon.removeClass("is-tremble");
    replay(mon, "is-fall");
    await wait(560);
    mon.removeClass("is-fall");
    draw(0);
    stage.addClass("is-dead");
    hpt.setText(`討伐！ 総工数 ${hmm(o.totalWork)}`);
    replay(stamp, "is-on");
    if (o.sound) hitSound("kill");
    confetti(stage);
    await wait(2600);
  } else {
    await wait(900);
  }
  stage.addClass("is-out");
  await wait(300);
  stage.remove();
}

function confetti(stage: HTMLElement): void {
  const colors = ["#fbbf24", "#f87171", "#60a5fa", "#4ade80", "#c084fc"];
  for (let i = 0; i < 24; i++) {
    const c = stage.createDiv("dt-battle-confetti");
    c.style.background = colors[i % colors.length];
    const a = Math.random() * Math.PI * 2;
    const r = 50 + Math.random() * 90;
    const anim = c.animate(
      [
        { transform: "translate(0,0) rotate(0)", opacity: 1 },
        { transform: `translate(${Math.cos(a) * r}px,${Math.sin(a) * r - 30}px) rotate(${Math.random() * 720}deg)`, opacity: 0 },
      ],
      { duration: 700 + Math.random() * 500, easing: "cubic-bezier(.2,.8,.4,1)", fill: "forwards" }
    );
    anim.onfinish = () => c.remove();
  }
}
