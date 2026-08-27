import { App, Notice, PluginSettingTab, Setting, moment } from "obsidian";
import type DayTimelinePlugin from "./main";
import { RecurringModal, describeRule, propagateRecurringUpdate } from "./recurring";
import { requestNotificationPermission, showAlert } from "./notify";

export type ViewLocation = "tab" | "right" | "left";
export type StorageFormat = "block" | "list";
export type InsertPosition = "time" | "end";
export type ViewMode = "day" | "3day" | "week" | "month";

/** タイムラインに出すバー: 予定だけ / 予定と実績 / 実績だけ */
export type PlanActualMode = "plan" | "both" | "actual";
/** 通知の出し方 */
export type NotifyStyle = "both" | "system" | "banner";

/** タグ → 色の対応（先に書いたものが優先） */
export interface TagColor {
  /** "#" 抜きのタグ。"work" は "#work" と "#work/xxx" に一致 */
  tag: string;
  /** "#rrggbb" */
  color: string;
}

/** チケット管理ツール（Redmine / Gitea / Backlog など） */
export interface IssueTracker {
  /** メタ行に書く短い名前（例: "redmine"） */
  name: string;
  /** チケットの URL。{id} が番号に置き換わる */
  urlTemplate: string;
}

/** チケットの URL を組み立てる */
export function ticketUrl(trackers: IssueTracker[], tracker: string, id: string): string | null {
  const t =
    trackers.find((x) => x.name.toLowerCase() === tracker.toLowerCase()) ??
    (tracker === "" ? trackers[0] : undefined);
  if (!t || !t.urlTemplate.trim()) return null;
  const tpl = t.urlTemplate.trim();
  return tpl.includes("{id}") ? tpl.replace(/\{id\}/g, encodeURIComponent(id)) : tpl.replace(/\/+$/, "") + "/" + encodeURIComponent(id);
}

/** 他の人の予定（自分とは別のフォルダのノートに保存し、カレンダーに重ねて表示する） */
export interface Member {
  id: string;
  name: string;
  /** "#rrggbb" */
  color: string;
  /** ノートのフォルダ（"" なら <自分のフォルダ>/Members/<名前>） */
  folder: string;
  /** タイムラインに表示するか（ヘッダーのチップで切替） */
  visible: boolean;
  /** この人の予定もリマインドするか */
  remind: boolean;
}

/** メンバーのノートのフォルダ */
export function memberFolder(s: { folder: string }, m: Member): string {
  const f = m.folder.trim().replace(/^\/+|\/+$/g, "");
  return f || `${s.folder}/Members/${m.name.trim() || m.id}`;
}

/** 定期タスクのルール */
export interface RecurringRule {
  id: string;
  title: string;
  /** 繰り返す曜日（0 = 日 … 6 = 土） */
  weekdays: number[];
  /** 0:00 からの分。null なら未スケジュールとして入れる */
  start: number | null;
  end: number | null;
  enabled: boolean;
}

/** 既定の保存フォルダ（空欄にはできない） */
export const DEFAULT_FOLDER = "Timeline";
/** Inbox（日付を決めていないタスク）のノート */
export const DEFAULT_INBOX_PATH = "Timeline/Inbox";
/** 設定の版。旧既定値からの移行判定に使う */
export const SETTINGS_VERSION = 2;

export interface DayTimelineSettings {
  /** 設定の版（移行用） */
  settingsVersion: number;
  /** 予定を保存するノートのフォルダ（保管庫直下には置かない） */
  folder: string;
  /** ファイル名の日付形式（Moment.js 形式） */
  dateFormat: string;
  /** 旧リスト形式で予定を書き込む見出し（例: "## タイムスケジュール"）。移行元にもなる */
  heading: string;
  /** ノート新規作成時に使うテンプレートのパス（任意） */
  templatePath: string;

  /** 保存形式: "block" = 1タスク = 1ブロック / "list" = 見出しの下のリスト（旧形式） */
  storageFormat: StorageFormat;
  /** タスクとみなす見出しレベル（1〜6） */
  taskHeadingLevel: number;
  /** タスクを置く親見出し（"" ならファイル直下） */
  taskRootHeading: string;
  /** 新しいタスクを入れる位置 */
  insertPosition: InsertPosition;
  /** 本文があるタスクを消すときに確認するか */
  confirmBodyDelete: boolean;
  /** メタ行にもタイトルを書くか（他プラグインとの互換用） */
  mirrorTitleInMeta: boolean;

  /** 表示開始時刻（0〜23） */
  startHour: number;
  /** 表示終了時刻（1〜24） */
  endHour: number;
  /** 1時間あたりの高さ（px） */
  hourHeight: number;
  /** タイムラインに一度に表示する時間の幅（4 / 8 / 12 時間）。0 = 「1時間あたりの高さ」に従う */
  zoomHours: number;
  /** タイムラインに出すバー（予定 / 予実 / 実績） */
  paMode: PlanActualMode;
  /** スナップ間隔（分） */
  snapMinutes: number;
  /** クリックで作る予定の既定の長さ（分） */
  defaultDurationMinutes: number;
  /** "- [ ] " のチェックボックス形式で保存するか */
  useCheckbox: boolean;
  /** 現在時刻のラインを表示するか */
  showCurrentTime: boolean;
  /** 未スケジュールのタスクのトレイを表示するか */
  showUnscheduledTray: boolean;
  /** ビューを開く場所 */
  viewLocation: ViewLocation;
  /** 日表示 / 週表示 */
  viewMode: ViewMode;
  /** 週の始まり（0 = 日曜 … 6 = 土曜） */
  weekStart: number;
  /** タグごとの色 */
  tagColors: TagColor[];

  /** 定期タスクのルール */
  recurring: RecurringRule[];
  /** 定期タスクを表示時に自動でノートへ書き込むか */
  autoApplyRecurring: boolean;
  /** 日付キー → 反映済みのルール ID（消したタスクが復活しないように覚えておく） */
  recurringApplied: Record<string, string[]>;
  /** 日付キー → ルール ID → 書き込んだタスクのブロックID（ルール編集を将来分に反映するため） */
  recurringInstances: Record<string, Record<string, string>>;

  /** Inbox のノート（拡張子なしでも可） */
  inboxPath: string;
  /** Inbox パネルを表示するか */
  showInbox: boolean;
  /** Inbox パネルを畳んでいるか */
  inboxCollapsed: boolean;

  /** タスクのリマインドを出すか */
  reminderEnabled: boolean;
  /** 既定の「N分前」 */
  reminderDefaultMinutes: number;
  /** タイマー終了・リマインドで音を鳴らすか */
  notifySound: boolean;
  /** 通知の出し方 */
  notifyStyle: NotifyStyle;
  /** チケット管理ツール */
  trackers: IssueTracker[];
  /** 他の人の予定 */
  members: Member[];
}

export const DEFAULT_SETTINGS: DayTimelineSettings = {
  settingsVersion: SETTINGS_VERSION,
  folder: DEFAULT_FOLDER,
  dateFormat: "YYYY-MM-DD",
  heading: "## タイムスケジュール",
  templatePath: "",
  storageFormat: "block",
  taskHeadingLevel: 2,
  taskRootHeading: "",
  insertPosition: "time",
  confirmBodyDelete: true,
  mirrorTitleInMeta: false,
  startHour: 7,
  endHour: 22,
  hourHeight: 60,
  zoomHours: 0,
  paMode: "plan",
  snapMinutes: 15,
  defaultDurationMinutes: 30,
  useCheckbox: true,
  showCurrentTime: true,
  showUnscheduledTray: true,
  viewLocation: "tab",
  viewMode: "week",
  weekStart: 0,
  tagColors: [],
  recurring: [],
  autoApplyRecurring: true,
  recurringApplied: {},
  recurringInstances: {},
  inboxPath: DEFAULT_INBOX_PATH,
  showInbox: true,
  inboxCollapsed: false,
  reminderEnabled: true,
  reminderDefaultMinutes: 5,
  notifySound: true,
  notifyStyle: "both",
  trackers: [],
  members: [],
};

/**
 * 保存されている設定を現在の版に合わせる。
 * v1（版なし）: 表示時間帯の既定が 0:00〜24:00、フォルダの既定が保管庫直下だった。
 */
export function migrateSettings(loaded: Partial<DayTimelineSettings>): DayTimelineSettings {
  const version = loaded.settingsVersion ?? 1;
  const s: DayTimelineSettings = { ...DEFAULT_SETTINGS, ...loaded };
  if (version < 2) {
    if ((loaded.startHour ?? 0) === 0 && (loaded.endHour ?? 24) === 24) {
      s.startHour = DEFAULT_SETTINGS.startHour;
      s.endHour = DEFAULT_SETTINGS.endHour;
    }
  }
  if (!s.folder.trim()) s.folder = DEFAULT_FOLDER;
  if (!Array.isArray(s.tagColors)) s.tagColors = [];
  if (!Array.isArray(s.recurring)) s.recurring = [];
  if (!s.recurringApplied || typeof s.recurringApplied !== "object") s.recurringApplied = {};
  if (!s.recurringInstances || typeof s.recurringInstances !== "object") s.recurringInstances = {};
  if (!s.inboxPath.trim()) s.inboxPath = DEFAULT_INBOX_PATH;
  if (!Array.isArray(s.trackers)) s.trackers = [];
  if (!Array.isArray(s.members)) s.members = [];
  s.settingsVersion = SETTINGS_VERSION;
  return s;
}

/** タグの表記ゆれを吸収（先頭の # と前後の空白を落とし、小文字に） */
export function normalizeTag(tag: string): string {
  return tag.trim().replace(/^#+/, "").replace(/\/+$/, "").toLowerCase();
}

/** タスクのタグに対応する色。無ければ null */
export function colorForTags(tags: string[], rules: TagColor[]): string | null {
  if (!tags.length || !rules.length) return null;
  const lower = tags.map((t) => t.toLowerCase());
  for (const r of rules) {
    const key = normalizeTag(r.tag);
    if (!key || !r.color) continue;
    if (lower.some((t) => t === key || t.startsWith(key + "/"))) return r.color;
  }
  return null;
}

export class DayTimelineSettingTab extends PluginSettingTab {
  plugin: DayTimelinePlugin;

  constructor(app: App, plugin: DayTimelinePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const save = () => this.plugin.saveSettings();

    // ---------- 保存先 ----------
    new Setting(containerEl).setName("保存先").setHeading();

    new Setting(containerEl)
      .setName("フォルダ")
      .setDesc(
        `予定を保存するノートを置くフォルダ（既定: ${DEFAULT_FOLDER}）。保管庫直下には置きません。` +
          "デイリーノートのフォルダと同じにすると、デイリーノートに予定が書き込まれます。"
      )
      .addText((t) =>
        t
          .setPlaceholder(DEFAULT_FOLDER)
          .setValue(s.folder)
          .onChange(async (v) => {
            s.folder = v.trim().replace(/^\/+|\/+$/g, "") || DEFAULT_FOLDER;
            await save();
          })
      );

    const fmtSetting = new Setting(containerEl)
      .setName("ファイル名の日付形式")
      .setDesc("Moment.js の書式。デイリーノートの設定と合わせると同じノートを使えます。");
    const previewEl = fmtSetting.descEl.createDiv({ cls: "dt-setting-preview" });
    const updatePreview = () =>
      previewEl.setText(`例: ${moment().format(s.dateFormat)}.md`);
    updatePreview();
    fmtSetting.addText((t) =>
      t
        .setPlaceholder("YYYY-MM-DD")
        .setValue(s.dateFormat)
        .onChange(async (v) => {
          s.dateFormat = v.trim() || DEFAULT_SETTINGS.dateFormat;
          updatePreview();
          await save();
        })
    );

    new Setting(containerEl)
      .setName("新規ノートのテンプレート")
      .setDesc(
        "ノートがまだ無いときに使うテンプレートファイル（任意）。" +
          "{{date}} {{date:FORMAT}} {{title}} {{time}} を置き換えます。"
      )
      .addText((t) =>
        t
          .setPlaceholder("例: Templates/Daily")
          .setValue(s.templatePath)
          .onChange(async (v) => {
            s.templatePath = v.trim();
            await save();
          })
      );

    // ---------- 保存形式 ----------
    new Setting(containerEl).setName("保存形式").setHeading();

    new Setting(containerEl)
      .setName("タスクの形式")
      .setDesc(
        "タスクブロック: 1タスクをノート内の1ブロック（見出し + 本文）として保存。" +
          "本文に自由にメモを書け、タスク単位でリンクできます。" +
          "リスト（旧形式）: 1つの見出しの下に1行ずつ並べる 1.x までの形式。"
      )
      .addDropdown((d) =>
        d
          .addOption("block", "タスクブロック（1タスク = 1ブロック）")
          .addOption("list", "リスト（旧形式）")
          .setValue(s.storageFormat)
          .onChange(async (v) => {
            s.storageFormat = v as StorageFormat;
            await save();
            this.display();
          })
      );

    if (s.storageFormat === "block") {
      new Setting(containerEl)
        .setName("タスクの見出しレベル")
        .setDesc("このレベルの見出し + 直下の「- [ ] 09:00 - 10:00」行をタスクとして扱います。")
        .addDropdown((d) => {
          for (let l = 1; l <= 6; l++) d.addOption(String(l), "#".repeat(l) + " 見出し");
          d.setValue(String(s.taskHeadingLevel)).onChange(async (v) => {
            s.taskHeadingLevel = Number(v);
            await save();
          });
        });

      new Setting(containerEl)
        .setName("タスクを置く場所")
        .setDesc(
          "空欄ならファイル直下にタスクブロックを並べます。" +
            "「## 今日のタスク」のように指定すると、その見出しの配下だけを使います。" +
            "タスクの見出しレベルが親と同じかそれより浅い場合は、親より1つ深いレベルとして扱います。"
        )
        .addText((t) =>
          t
            .setPlaceholder("例: ## 今日のタスク（空欄 = ファイル直下）")
            .setValue(s.taskRootHeading)
            .onChange(async (v) => {
              s.taskRootHeading = v.trim();
              await save();
            })
        );

      new Setting(containerEl)
        .setName("新しいタスクの挿入位置")
        .setDesc("ノート内のどこに新しいタスクブロックを差し込むか。既存の並びは変えません。")
        .addDropdown((d) =>
          d
            .addOption("time", "時刻順の位置")
            .addOption("end", "末尾")
            .setValue(s.insertPosition)
            .onChange(async (v) => {
              s.insertPosition = v as InsertPosition;
              await save();
            })
        );

      new Setting(containerEl)
        .setName("本文があるタスクの削除を確認")
        .setDesc("オンにすると、本文が書かれたブロックを消す前に確認ダイアログを出します。")
        .addToggle((t) =>
          t.setValue(s.confirmBodyDelete).onChange(async (v) => {
            s.confirmBodyDelete = v;
            await save();
          })
        );

      new Setting(containerEl)
        .setName("メタ行にもタイトルを書く")
        .setDesc(
          "「- [ ] 09:00 - 10:00 朝会 ^dtp-xxx」のようにタイトルを重複して書きます。" +
            "Tasks や Day Planner など他のプラグインからもタイトルが見えるようになります。"
        )
        .addToggle((t) =>
          t.setValue(s.mirrorTitleInMeta).onChange(async (v) => {
            s.mirrorTitleInMeta = v;
            await save();
          })
        );
    }

    new Setting(containerEl)
      .setName(s.storageFormat === "block" ? "旧形式の見出し" : "見出し")
      .setDesc(
        s.storageFormat === "block"
          ? "リスト（旧形式）で使っていた見出し。この下の予定は「変換」でタスクブロックにできます。"
          : "この見出しの下に予定を書き込みます。ノート内の他の内容はそのまま保持されます。"
      )
      .addText((t) =>
        t
          .setPlaceholder(DEFAULT_SETTINGS.heading)
          .setValue(s.heading)
          .onChange(async (v) => {
            s.heading = v.trim() || DEFAULT_SETTINGS.heading;
            await save();
          })
      );

    new Setting(containerEl)
      .setName("チェックボックス形式で保存")
      .setDesc("オン: 「- [ ] 09:00 - 10:00」　オフ: 「- 09:00 - 10:00」")
      .addToggle((t) =>
        t.setValue(s.useCheckbox).onChange(async (v) => {
          s.useCheckbox = v;
          await save();
        })
      );

    // ---------- 表示 ----------
    new Setting(containerEl).setName("表示").setHeading();

    new Setting(containerEl)
      .setName("既定の表示")
      .setDesc("タイムラインを開いたときの表示。ヘッダーの「日 / 週」でいつでも切り替えられます。")
      .addDropdown((d) =>
        d
          .addOption("week", "週（7日）")
          .addOption("3day", "3日")
          .addOption("day", "日（1日）")
          .addOption("month", "月（カレンダー）")
          .setValue(s.viewMode)
          .onChange(async (v) => {
            s.viewMode = v as ViewMode;
            await save();
          })
      );

    new Setting(containerEl)
      .setName("週の始まり")
      .setDesc("週表示の左端に置く曜日。")
      .addDropdown((d) => {
        const names = ["日曜日", "月曜日", "火曜日", "水曜日", "木曜日", "金曜日", "土曜日"];
        names.forEach((n, i) => d.addOption(String(i), n));
        d.setValue(String(s.weekStart)).onChange(async (v) => {
          s.weekStart = Number(v);
          await save();
        });
      });

    new Setting(containerEl)
      .setName("表示する時間帯")
      .setDesc("タイムラインに表示する開始時刻と終了時刻。")
      .addDropdown((d) => {
        for (let h = 0; h <= 23; h++) d.addOption(String(h), `${h}:00`);
        d.setValue(String(s.startHour)).onChange(async (v) => {
          const n = Number(v);
          if (n >= s.endHour) {
            new Notice("開始時刻は終了時刻より前にしてください");
            d.setValue(String(s.startHour));
            return;
          }
          s.startHour = n;
          await save();
        });
      })
      .addDropdown((d) => {
        for (let h = 1; h <= 24; h++) d.addOption(String(h), `${h}:00`);
        d.setValue(String(s.endHour)).onChange(async (v) => {
          const n = Number(v);
          if (n <= s.startHour) {
            new Notice("終了時刻は開始時刻より後にしてください");
            d.setValue(String(s.endHour));
            return;
          }
          s.endHour = n;
          await save();
        });
      });

    new Setting(containerEl)
      .setName("1時間の高さ")
      .setDesc("タイムラインの拡大率（px）。")
      .addSlider((sl) =>
        sl
          .setLimits(30, 160, 5)
          .setValue(s.hourHeight)
          .setDynamicTooltip()
          .onChange(async (v) => {
            s.hourHeight = v;
            await save();
          })
      );

    new Setting(containerEl)
      .setName("スナップ間隔")
      .setDesc("クリックやドラッグ時に時刻を丸める単位。")
      .addDropdown((d) => {
        for (const m of [5, 10, 15, 30, 60]) d.addOption(String(m), `${m}分`);
        d.setValue(String(s.snapMinutes)).onChange(async (v) => {
          s.snapMinutes = Number(v);
          await save();
        });
      });

    new Setting(containerEl)
      .setName("新しい予定の長さ")
      .setDesc("空き時間をクリックしたときに作られる予定の長さ。")
      .addDropdown((d) => {
        for (const m of [15, 30, 45, 60, 90, 120]) d.addOption(String(m), `${m}分`);
        d.setValue(String(s.defaultDurationMinutes)).onChange(async (v) => {
          s.defaultDurationMinutes = Number(v);
          await save();
        });
      });

    new Setting(containerEl)
      .setName("現在時刻のラインを表示")
      .addToggle((t) =>
        t.setValue(s.showCurrentTime).onChange(async (v) => {
          s.showCurrentTime = v;
          await save();
        })
      );

    if (s.storageFormat === "block") {
      new Setting(containerEl)
        .setName("未スケジュールのトレイを表示")
        .setDesc("時刻が決まっていないタスクをタイムラインの上に一覧します。ドラッグで時刻を割り当てられます。")
        .addToggle((t) =>
          t.setValue(s.showUnscheduledTray).onChange(async (v) => {
            s.showUnscheduledTray = v;
            await save();
          })
        );
    }

    // ---------- タグの色 ----------
    new Setting(containerEl).setName("タグの色").setHeading();
    new Setting(containerEl)
      .setName("タグごとにタスクの色を変える")
      .setDesc(
        "タスクの見出し・メタ行・本文に書かれた #タグ に応じてタイムライン上の色を変えます。" +
          "上にあるものが優先。「work」は #work と #work/xxx の両方に一致します。"
      )
      .addButton((b) =>
        b
          .setButtonText("追加")
          .setCta()
          .onClick(async () => {
            s.tagColors.push({ tag: "", color: "#4a90d9" });
            await save();
            this.display();
          })
      );

    s.tagColors.forEach((rule, idx) => {
      const row = new Setting(containerEl);
      row.settingEl.addClass("dt-tag-color-row");
      const swatch = row.nameEl.createSpan({ cls: "dt-tag-swatch" });
      swatch.style.background = rule.color;
      const nameSpan = row.nameEl.createSpan();
      const updateName = () =>
        nameSpan.setText(rule.tag ? `#${normalizeTag(rule.tag)}` : "(タグ未設定)");
      updateName();
      row
        .addText((t) =>
          t
            .setPlaceholder("例: work")
            .setValue(rule.tag)
            .onChange(async (v) => {
              rule.tag = v.trim().replace(/^#+/, "");
              updateName();
              await save();
            })
        )
        .addColorPicker((c) =>
          c.setValue(rule.color).onChange(async (v) => {
            rule.color = v;
            swatch.style.background = v;
            await save();
          })
        )
        .addExtraButton((b) =>
          b
            .setIcon("arrow-up")
            .setTooltip("上へ")
            .setDisabled(idx === 0)
            .onClick(async () => {
              if (idx === 0) return;
              [s.tagColors[idx - 1], s.tagColors[idx]] = [s.tagColors[idx], s.tagColors[idx - 1]];
              await save();
              this.display();
            })
        )
        .addExtraButton((b) =>
          b
            .setIcon("trash")
            .setTooltip("削除")
            .onClick(async () => {
              s.tagColors.splice(idx, 1);
              await save();
              this.display();
            })
        );
    });

    // ---------- 定期タスク ----------
    new Setting(containerEl).setName("定期タスク").setHeading();
    new Setting(containerEl)
      .setName("定期タスクを自動で入れる")
      .setDesc(
        "タイムラインで今日以降の日を表示したとき、まだ入っていない定期タスクをその日のノートに書き込みます。" +
          "一度入れた日は記録するので、消したタスクが勝手に復活することはありません。"
      )
      .addToggle((t) =>
        t.setValue(s.autoApplyRecurring).onChange(async (v) => {
          s.autoApplyRecurring = v;
          await save();
        })
      );
    new Setting(containerEl)
      .setName("ルール")
      .setDesc("曜日と時刻を決めて、毎週同じタスクを入れます。タスクの右クリック「定期タスクとして登録…」からも作れます。")
      .addButton((b) =>
        b
          .setButtonText("追加")
          .setCta()
          .onClick(() => {
            new RecurringModal(this.app, {
              tagChoices: s.tagColors,
              onSubmit: async (rule) => {
                s.recurring.push(rule);
                await save();
                this.display();
              },
            }).open();
          })
      );
    if (s.recurring.length === 0) {
      containerEl.createDiv({ cls: "dt-setting-empty", text: "定期タスクはまだありません。" });
    }
    s.recurring.forEach((rule, idx) => {
      const row = new Setting(containerEl)
        .setName(rule.title || "(無題)")
        .setDesc(describeRule(rule));
      row.settingEl.addClass("dt-recurring-row");
      row.settingEl.toggleClass("is-disabled", !rule.enabled);
      row
        .addToggle((t) =>
          t
            .setTooltip("有効 / 無効")
            .setValue(rule.enabled)
            .onChange(async (v) => {
              rule.enabled = v;
              row.settingEl.toggleClass("is-disabled", !v);
              await save();
            })
        )
        .addExtraButton((b) =>
          b
            .setIcon("pencil")
            .setTooltip("編集")
            .onClick(() => {
              new RecurringModal(this.app, {
                initial: rule,
                tagChoices: s.tagColors,
                onSubmit: async (next) => {
                  s.recurring[idx] = next;
                  await save();
                  this.display();
                  const n = await propagateRecurringUpdate(this.plugin, next);
                  if (n) new Notice(`今日以降の ${n} 件のタスクにも反映しました`);
                },
              }).open();
            })
        )
        .addExtraButton((b) =>
          b
            .setIcon("trash")
            .setTooltip("削除")
            .onClick(async () => {
              s.recurring.splice(idx, 1);
              await save();
              this.display();
            })
        );
    });

    // ---------- Inbox ----------
    new Setting(containerEl).setName("Inbox（日付を決めていないタスク）").setHeading();
    new Setting(containerEl)
      .setName("Inbox パネルを表示")
      .setDesc(
        "とりあえず登録しておくタスクの置き場。タイムラインの上に一覧し、日付の列へドラッグするとその日に移ります。" +
          "タスクブロック形式のときだけ使えます。"
      )
      .addToggle((t) =>
        t.setValue(s.showInbox).onChange(async (v) => {
          s.showInbox = v;
          await save();
        })
      );
    new Setting(containerEl)
      .setName("Inbox のノート")
      .setDesc("Inbox のタスクを保存するノートのパス（拡張子は省略可）。")
      .addText((t) =>
        t
          .setPlaceholder(DEFAULT_INBOX_PATH)
          .setValue(s.inboxPath)
          .onChange(async (v) => {
            s.inboxPath = v.trim().replace(/^\/+|\/+$/g, "") || DEFAULT_INBOX_PATH;
            await save();
          })
      );

    // ---------- 通知 ----------
    new Setting(containerEl).setName("通知（リマインド・タイマー）").setHeading();
    new Setting(containerEl)
      .setName("タスクのリマインド")
      .setDesc("今日の未完了タスクについて、開始の少し前に通知を出します（Obsidian を開いている間だけ）。")
      .addToggle((t) =>
        t.setValue(s.reminderEnabled).onChange(async (v) => {
          s.reminderEnabled = v;
          await save();
        })
      );
    new Setting(containerEl)
      .setName("既定のリマインド時刻")
      .setDesc("タスクごとに指定が無いときの「N分前」。タスクの編集ダイアログで個別に変えられます（メタ行に 🔔10 のように保存）。")
      .addDropdown((d) => {
        for (const m of [0, 1, 3, 5, 10, 15, 30, 60]) d.addOption(String(m), m === 0 ? "開始時刻" : `${m}分前`);
        d.setValue(String(s.reminderDefaultMinutes)).onChange(async (v) => {
          s.reminderDefaultMinutes = Number(v);
          await save();
        });
      });
    new Setting(containerEl)
      .setName("通知の出し方")
      .setDesc(
        "OS の通知: Windows / macOS のトースト（画面の右下など）。Obsidian が最小化されていても届きます。" +
          "画面内のバナー: Obsidian のウィンドウ右下に大きめのカードを閉じるまで表示します。"
      )
      .addDropdown((d) =>
        d
          .addOption("both", "OS の通知 + 画面内のバナー")
          .addOption("system", "OS の通知（出せなければバナー）")
          .addOption("banner", "画面内のバナーだけ")
          .setValue(s.notifyStyle)
          .onChange(async (v) => {
            s.notifyStyle = v as NotifyStyle;
            if (v !== "banner") requestNotificationPermission();
            await save();
          })
      );
    new Setting(containerEl)
      .setName("テスト通知を出す")
      .setDesc("今の設定で通知がどう見えるか確認します。")
      .addButton((b) =>
        b.setButtonText("テスト").onClick(() =>
          showAlert(this.plugin, {
            title: "🔔 テスト通知",
            body: "リマインドはこのように表示されます（09:00 - 10:00）",
            onOpen: () => void this.plugin.activateView(),
            beeps: 1,
          })
        )
      );
    new Setting(containerEl)
      .setName("音を鳴らす")
      .setDesc("タイマー終了とリマインドのときに短いビープ音を鳴らします。")
      .addToggle((t) =>
        t.setValue(s.notifySound).onChange(async (v) => {
          s.notifySound = v;
          await save();
        })
      );

    // ---------- メンバー（他の人の予定） ----------
    new Setting(containerEl).setName("メンバー（他の人の予定）").setHeading();
    new Setting(containerEl)
      .setName("他の人の予定をカレンダーに重ねる")
      .setDesc(
        "メンバーごとに別フォルダのノート（既定: <フォルダ>/Members/<名前>/YYYY-MM-DD.md）に保存し、" +
          "自分の予定と同じカレンダーに色分けして表示します。表示の切替はタイムラインのヘッダーのチップで行います。"
      )
      .addButton((b) =>
        b
          .setButtonText("追加")
          .setCta()
          .onClick(async () => {
            const palette = ["#e06c75", "#61afef", "#98c379", "#e5c07b", "#c678dd", "#56b6c2"];
            s.members.push({
              id: "m-" + Math.random().toString(36).slice(2, 8),
              name: "",
              color: palette[s.members.length % palette.length],
              folder: "",
              visible: true,
              remind: false,
            });
            await save();
            this.display();
          })
      );
    s.members.forEach((m, idx) => {
      const row = new Setting(containerEl).setName(m.name || "(名前未設定)");
      row.settingEl.addClass("dt-member-row");
      const swatch = row.nameEl.createSpan({ cls: "dt-tag-swatch" });
      swatch.style.background = m.color;
      row.nameEl.prepend(swatch);
      row.setDesc(`保存先: ${memberFolder(s, m)}/`);
      row
        .addText((t) =>
          t
            .setPlaceholder("名前（例: 田中）")
            .setValue(m.name)
            .onChange(async (v) => {
              m.name = v.trim();
              row.setName(m.name || "(名前未設定)");
              row.nameEl.prepend(swatch);
              row.setDesc(`保存先: ${memberFolder(s, m)}/`);
              await save();
            })
        )
        .addColorPicker((c) =>
          c.setValue(m.color).onChange(async (v) => {
            m.color = v;
            swatch.style.background = v;
            await save();
          })
        )
        .addText((t) => {
          t.setPlaceholder("フォルダ（空欄 = 既定）")
            .setValue(m.folder)
            .onChange(async (v) => {
              m.folder = v.trim().replace(/^\/+|\/+$/g, "");
              row.setDesc(`保存先: ${memberFolder(s, m)}/`);
              await save();
            });
          t.inputEl.addClass("dt-member-folder");
        })
        .addToggle((t) =>
          t
            .setTooltip("この人の予定もリマインドする")
            .setValue(m.remind)
            .onChange(async (v) => {
              m.remind = v;
              await save();
            })
        )
        .addExtraButton((b) =>
          b
            .setIcon("trash")
            .setTooltip("削除（ノートは消しません）")
            .onClick(async () => {
              s.members.splice(idx, 1);
              await save();
              this.display();
            })
        );
    });

    // ---------- チケット管理ツール ----------
    new Setting(containerEl).setName("チケット管理ツール").setHeading();
    new Setting(containerEl)
      .setName("Redmine / Gitea / Backlog などと連携")
      .setDesc(
        "登録すると、タスクの編集ダイアログでチケット番号を付けられます。" +
          "URL の {id} が番号に置き換わります。例: https://redmine.example.com/issues/{id} / " +
          "https://gitea.example.com/org/repo/issues/{id} / https://space.backlog.jp/view/{id}"
      )
      .addButton((b) =>
        b
          .setButtonText("追加")
          .setCta()
          .onClick(async () => {
            s.trackers.push({ name: "", urlTemplate: "" });
            await save();
            this.display();
          })
      );
    s.trackers.forEach((tr, idx) => {
      const row = new Setting(containerEl).setName(tr.name || "(名前未設定)");
      row.settingEl.addClass("dt-tracker-row");
      row
        .addText((t) =>
          t
            .setPlaceholder("名前（例: redmine）")
            .setValue(tr.name)
            .onChange(async (v) => {
              tr.name = v.trim();
              row.setName(tr.name || "(名前未設定)");
              await save();
            })
        )
        .addText((t) => {
          t.setPlaceholder("https://…/issues/{id}")
            .setValue(tr.urlTemplate)
            .onChange(async (v) => {
              tr.urlTemplate = v.trim();
              await save();
            });
          t.inputEl.addClass("dt-tracker-url");
        })
        .addExtraButton((b) =>
          b
            .setIcon("trash")
            .setTooltip("削除")
            .onClick(async () => {
              s.trackers.splice(idx, 1);
              await save();
              this.display();
            })
        );
    });

    // ---------- その他 ----------
    new Setting(containerEl).setName("その他").setHeading();

    new Setting(containerEl)
      .setName("ビューを開く場所")
      .setDesc("リボンアイコンやコマンドで開いたときの位置。")
      .addDropdown((d) =>
        d
          .addOption("tab", "メインエリア（タブ）")
          .addOption("right", "右サイドバー")
          .addOption("left", "左サイドバー")
          .setValue(s.viewLocation)
          .onChange(async (v) => {
            s.viewLocation = v as ViewLocation;
            await save();
          })
      );
  }
}
