/**
 * ペットの演出のモック（ブラウザ単体で動く）。
 * 本体の pet.ts / battle.ts / bestiary.ts をそのまま使い、編集ダイアログとタスクだけを模型にしている。
 * 保存のときの流れは view.ts の playBattleFor と同じ:
 *   snapshotOf(保存前) → 保存 → battleEvent → pet.playBattle({...})
 */
import "./obsidian-shim";
import type { Task, TaskDraft } from "../src/model";
import type { TaskStep } from "../src/markdown/blocks";
import { monsterSVG } from "../src/bestiary";
import {
  battleEvent,
  hpRatio,
  monsterOf,
  projectHp,
  snapshotOf,
  soloSummary,
  type BattleRules,
} from "../src/battle";
import { PetWidget, type PetInfo, type PetPosition } from "../src/pet";

const rules: BattleRules = { midHours: 10, bossHours: 40, defaultMinutes: 60, soloMidHours: 1, soloBossHours: 3 };

interface MockTask {
  task: Task;
}

function makeTask(id: string, title: string, minutes: number, steps: string[]): Task {
  return {
    key: id,
    title,
    start: 9 * 60,
    end: 9 * 60 + minutes,
    done: false,
    preview: "",
    blockId: id,
    tags: [],
    reminder: null,
    doneCondition: "",
    steps: steps.map((text) => ({ text, done: false, children: [] as string[] })),
    retrospective: "",
    result: "",
    remaining: "",
    cause: "",
    judgment: "",
    others: [],
    answer: "",
    status: "",
    ownerName: "",
    due: "",
    nextAction: "",
    registered: "",
    actual: [],
    project: null,
    forwarded: false,
    carryTo: null,
    carryFrom: null,
    details: "",
    ticket: null,
    owner: null,
    ref: { kind: "block", id, title, start: 9 * 60, end: 9 * 60 + minutes },
  };
}

const initial = (): MockTask[] => [
  { task: makeTask("a1", "メール返信", 45, ["受信箱を整理", "返信 3 件", "フォルダへ移動"]) },
  { task: makeTask("b2", "設計書レビュー", 150, ["目次を確認", "API 章", "画面章", "指摘をまとめる"]) },
  { task: makeTask("c3", "リリース作業", 240, ["タグを切る", "ビルド", "ステージング確認", "本番反映", "告知"]) },
  { task: makeTask("d4", "日報を書く", 20, []) },
];

let tasks: MockTask[] = initial();
let petPos: PetPosition | null = null;
let sound = false;

const page = (document.querySelector<HTMLElement>(".mock-root") ?? document.body).createDiv("mock-page");
page.createEl("h1", { text: "ペットの演出モック" });
const lead = page.createEl("p", { cls: "mock-lead" });
lead.innerHTML =
  "「編集」でダイアログを開き、<b>ステップにチェック</b>を入れるか<b>完了</b>にして保存すると、右下のペットがゆっくり中央へ来て一撃を受けます。" +
  "まだ残っていれば元の位置へ戻り、完了なら討伐して消え、次のタスクのモンスターが元の位置に現れます。ペットはドラッグで動かせます（位置は記憶）。";

const bar = page.createDiv("mock-bar");
const soundLabel = bar.createEl("label");
const soundCb = soundLabel.createEl("input", { attr: { type: "checkbox" } }) as HTMLInputElement;
soundLabel.createSpan({ text: "効果音" });
soundCb.addEventListener("change", () => (sound = soundCb.checked));
const resetBtn = bar.createEl("button", { text: "タスクを最初に戻す" });
resetBtn.addEventListener("click", () => {
  tasks = initial();
  render();
  log("タスクを最初に戻しました", true);
});
const posBtn = bar.createEl("button", { text: "ペットの位置を右下に戻す" });
posBtn.addEventListener("click", () => {
  petPos = null;
  updatePet();
});
bar.createSpan({ text: "ランク: 1 時間以内 = 雑魚 / 3 時間以内 = 中級 / それ以上 = ボス" });

const listEl = page.createDiv("mock-tasks");
const logEl = page.createDiv("mock-log");

function log(text: string, head = false): void {
  const t = new Date();
  const hh = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}:${String(t.getSeconds()).padStart(2, "0")}`;
  const row = logEl.createDiv({ text: head ? text : `${hh}  ${text}` });
  if (head) row.addClass("is-head");
  logEl.scrollTop = logEl.scrollHeight;
}

const PATH = "Timeline/2026-09-03.md";
const hmm = (m: number) => `${Math.floor(m / 60)}:${String(Math.round(m) % 60).padStart(2, "0")}`;

function focusTask(): MockTask | null {
  return tasks.find((m) => !m.task.done) ?? null;
}

function render(): void {
  listEl.empty();
  const focus = focusTask();
  for (const m of tasks) {
    const t = m.task;
    const sum = soloSummary(t, PATH, new Date());
    const mon = monsterOf(sum, rules);
    const hp = projectHp(sum, rules);
    const row = listEl.createDiv("mock-task");
    row.toggleClass("is-done", t.done);
    row.toggleClass("is-focus", m === focus);
    const icon = row.createDiv("mock-task-mon");
    icon.innerHTML = monsterSVG(mon, hpRatio(hp), 30);
    const body = row.createDiv("mock-task-body");
    body.createDiv({ cls: "mock-task-title", text: t.title });
    const done = t.steps.filter((s) => s.done).length;
    body.createDiv({
      cls: "mock-task-meta",
      text: `${mon.rank} ${mon.name} · 予定 ${hmm(t.end! - t.start!)} · HP ${hmm(hp.remain)} / ${hmm(hp.total)}` +
        (t.steps.length ? ` · ステップ ${done}/${t.steps.length}` : " · ステップなし") +
        (m === focus ? " · ペットの相手" : ""),
    });
    const btn = row.createEl("button", { text: "編集" });
    btn.addEventListener("click", () => openDialog(m));
  }
  updatePet();
}

// ---------- ペット（view.ts の updatePet と同じ組み立て） ----------

const pet = new PetWidget({
  getPosition: () => petPos,
  setPosition: (p) => {
    petPos = p;
    log(`ペットの位置を記憶: (${Math.round(p.x)}, ${Math.round(p.y)})`);
  },
  onClick: () => {
    const f = focusTask();
    if (f) openDialog(f);
  },
  onOpenProject: () => log("（単独タスクなのでプロジェクトノートはありません）"),
  onHide: () => log("（モックでは隠しません）"),
});

function updatePet(): void {
  const f = focusTask();
  if (!f) {
    pet.update(null);
    return;
  }
  const sum = soloSummary(f.task, PATH, new Date());
  const info: PetInfo = {
    monster: monsterOf(sum, rules),
    hp: projectHp(sum, rules),
    projectLink: sum.ref.linktext,
    projectName: sum.ref.name,
    taskTitle: f.task.title,
    label: "次",
    solo: true,
  };
  pet.update(info);
}

// ---------- 編集ダイアログの模型 ----------

function openDialog(m: MockTask): void {
  const t = m.task;
  const backdrop = document.body.createDiv("mock-backdrop");
  const dlg = backdrop.createDiv("mock-dialog");
  dlg.createEl("h2", { text: "タスクを編集" });

  const titleRow = dlg.createDiv("mock-row");
  titleRow.createSpan({ cls: "mock-row-label", text: "タイトル" });
  const titleIn = titleRow.createEl("input", { attr: { type: "text" } }) as HTMLInputElement;
  titleIn.value = t.title;

  const planRow = dlg.createDiv("mock-row");
  planRow.createSpan({ cls: "mock-row-label", text: "予定" });
  const planSel = planRow.createEl("select") as HTMLSelectElement;
  for (const [v, label] of [
    ["20", "20 分"],
    ["45", "45 分"],
    ["60", "1 時間"],
    ["90", "1 時間 30 分"],
    ["150", "2 時間 30 分"],
    ["180", "3 時間"],
    ["240", "4 時間"],
  ]) {
    const o = planSel.createEl("option", { text: label, attr: { value: v } }) as HTMLOptionElement;
    if (Number(v) === t.end! - t.start!) o.selected = true;
  }

  const doneRow = dlg.createDiv("mock-row");
  doneRow.createSpan({ cls: "mock-row-label", text: "完了" });
  const doneLabel = doneRow.createEl("label");
  const doneCb = doneLabel.createEl("input", { attr: { type: "checkbox" } }) as HTMLInputElement;
  doneCb.checked = t.done;
  doneLabel.createSpan({ text: " 完了にする" });

  const stepsRow = dlg.createDiv("mock-row");
  stepsRow.createSpan({ cls: "mock-row-label", text: "ステップ" });
  stepsRow.createSpan({ cls: "mock-hint", text: t.steps.length ? "" : "（ステップなし。完了だけで討伐）" });
  const stepsEl = dlg.createDiv("mock-steps");
  const stepCbs: HTMLInputElement[] = [];
  for (const st of t.steps) {
    const l = stepsEl.createEl("label");
    const cb = l.createEl("input", { attr: { type: "checkbox" } }) as HTMLInputElement;
    cb.checked = st.done;
    l.createSpan({ text: st.text });
    stepCbs.push(cb);
  }
  dlg.createDiv({
    cls: "mock-hint",
    text: "保存すると: 新しくチェックしたステップ 1 つにつき小の一撃、完了で大の一撃（残り HP ぶん）。",
  });

  const foot = dlg.createDiv("mock-dialog-foot");
  const cancel = foot.createEl("button", { text: "キャンセル" });
  cancel.addEventListener("click", () => backdrop.remove());
  const save = foot.createEl("button", { cls: "is-primary", text: "保存" });
  save.addEventListener("click", () => {
    const steps: TaskStep[] = t.steps.map((st, i) => ({ ...st, done: stepCbs[i].checked }));
    const minutes = Number(planSel.value);
    const draft: TaskDraft = {
      title: titleIn.value,
      start: t.start,
      end: t.start! + minutes,
      done: doneCb.checked,
      steps,
    };
    backdrop.remove();
    void commit(m, draft);
  });
  backdrop.addEventListener("pointerdown", (e) => {
    if (e.target === backdrop) backdrop.remove();
  });
}

/** view.ts の performUpdate → playBattleFor と同じ順番: 保存 → 再描画 → 演出 */
async function commit(m: MockTask, draft: TaskDraft): Promise<void> {
  const before = snapshotOf(m.task);
  const wasDone = m.task.done;
  const after: Task = {
    ...m.task,
    title: draft.title,
    start: draft.start,
    end: draft.end,
    done: draft.done,
    steps: draft.steps ?? m.task.steps,
  };
  const ev = battleEvent(before, m.task, draft, rules);
  m.task = after;
  render(); // 保存後の再読み込み（ペットは次の相手に更新される。演出中なら保留）

  if (!ev.smallHits && !ev.bigDamage) {
    log(`「${after.title}」を保存（一撃なし: ステップの完了数が増えていない・完了になっていない）`, true);
    return;
  }
  const sum = soloSummary(after, PATH, new Date());
  const hp = projectHp(sum, rules);
  const mon = monsterOf(sum, rules);
  const kill = hp.remain <= 0 && hp.total > 0;
  log(`「${after.title}」を保存: ${mon.rank} ${mon.name}${wasDone ? "（すでに完了）" : ""}`, true);
  if (ev.smallHits) log(`小の一撃 × ${ev.smallHits}（1 発 ${hmm(ev.smallDamage)}）`);
  if (ev.bigDamage) log(`大の一撃 ${hmm(ev.bigDamage)}`);
  log("ペットが中央へ移動 …");
  const t0 = performance.now();
  await pet.playBattle({
    monster: mon,
    title: sum.ref.name,
    hp,
    totalWork: sum.actMin || sum.planMin,
    event: ev,
    sound,
    host: document.body,
    brief: true,
  });
  const sec = ((performance.now() - t0) / 1000).toFixed(1);
  if (kill) log(`討伐 → 消えて、次の相手が元の位置に現れる（${sec} 秒）`);
  else log(`残り HP ${hmm(hp.remain)} → 元の位置へ戻る（${sec} 秒）`);
}

render();
log("準備できました。「編集」からどうぞ", true);
