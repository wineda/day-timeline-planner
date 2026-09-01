import { App, Notice, PluginSettingTab, Setting, moment } from "obsidian";
import { renderGroupIcon } from "./project";
import type DayTimelinePlugin from "./main";
import { RecurringModal, describeRule, propagateAndNotify } from "./recurring";
import { requestNotificationPermission, showAlert } from "./notify";

export type ViewLocation = "tab" | "right" | "left";
export type StorageFormat = "block" | "list";
export type InsertPosition = "time" | "end";
export type ViewMode = "day" | "3day" | "week" | "month";
/** 左サイドバーのタブ */
export type SidebarTab = "inbox" | "projects" | "reschedule";

/** タイムラインに出すバー: 予定だけ / 予定と実績 / 実績だけ */
export type PlanActualMode = "plan" | "both" | "actual";

/** 1時間あたりの高さ（px）の範囲。設定のスライダーと Ctrl+ホイールのズームで共用する */
export const MIN_HOUR_HEIGHT = 20;
export const MAX_HOUR_HEIGHT = 240;

/** 実績の計測（ストップウォッチ）の状態。Obsidian を再起動しても続くように設定に保存する */
export interface TrackingState {
  /** 対象タスクの日付キー（YYYY-MM-DD） */
  date: string;
  /** 誰の予定か（null = 自分） */
  owner: string | null;
  /** 対象タスクのブロックID */
  blockId: string;
  /** 表示用のタイトル */
  title: string;
  /** 計測を始めた時刻（0:00 からの分） */
  startMin: number;
}
/** 通知の出し方 */
export type NotifyStyle = "both" | "system" | "banner";

/** タグ → 色の対応（先に書いたものが優先） */
export interface TagColor {
  /** "#" 抜きのタグ。"work" は "#work" と "#work/xxx" に一致 */
  tag: string;
  /** "#rrggbb" */
  color: string;
}

/**
 * タグ → 必須・候補フィールドの対応。
 * タスク編集ダイアログでこのタグを選ぶと、required の欄が自動で開き（必須マーク付き）、
 * suggested の欄が「＋」チップの先頭に並ぶ。フィールド名はダイアログの欄名
 * （結果 / 原因 / 判断 / 残 / 他者 / 回答 / 状態 / Owner / 期限 / 完了条件 / ふりかえり など）
 */
export interface TagFieldSchema {
  /** "#" 抜きのタグ。サブタグ（"管理/質問"）は完全一致 → 親タグ（"管理"）の順で引く */
  tag: string;
  /** 必須のフィールド名 */
  required: string[];
  /** 候補（推奨）のフィールド名。並び順のままチップの先頭に出す */
  suggested: string[];
}

/** tagFieldSchema の既定値（Rules/Timeline記録ルール.md のタグ別の記入ルールに合わせたもの） */
export const DEFAULT_TAG_FIELD_SCHEMA: TagFieldSchema[] = [
  { tag: "障害", required: ["結果", "原因", "判断"], suggested: ["残", "他者", "状態"] },
  { tag: "会議", required: ["結果"], suggested: ["他者", "残"] },
  { tag: "管理", required: ["結果"], suggested: ["完了条件", "回答", "他者"] },
  { tag: "レビュー", required: ["結果"], suggested: ["他者"] },
  { tag: "開発", required: ["結果"], suggested: ["残", "完了条件"] },
  { tag: "資料", required: ["結果"], suggested: ["残"] },
  { tag: "雑務", required: ["結果"], suggested: [] },
  { tag: "私用", required: [], suggested: [] },
];

/**
 * タグに対応するフィールド定義を引く。完全一致 → 親タグ一致の順
 * （"#管理/質問" は "管理/質問" の定義があればそれ、無ければ "管理" の定義に従う）。
 * どちらも無ければ null（= そのタグにルールなし。従来どおりの表示）
 */
export function schemaForTag(schema: TagFieldSchema[], tag: string): TagFieldSchema | null {
  const key = normalizeTag(tag);
  if (!key) return null;
  const exact = schema.find((r) => normalizeTag(r.tag) === key);
  if (exact) return exact;
  const parent = key.split("/")[0];
  if (parent === key) return null;
  return schema.find((r) => normalizeTag(r.tag) === parent) ?? null;
}

/**
 * スキーマに書くフィールド名の表記ゆれを、ダイアログの欄名に揃える
 * （「期日」→「期限」、「振り返り」→「ふりかえり」）
 */
export function normalizeFieldLabel(label: string): string {
  const t = label.trim();
  if (t === "期日") return "期限";
  if (t === "振り返り") return "ふりかえり";
  return t;
}

/** プロジェクトのグループの表示設定（配列の順 = パネルでの表示順） */
export interface ProjectGroupSetting {
  /** グループ名（プロジェクトノートの frontmatter「group」の値と一致させる） */
  name: string;
  /** Lucide のアイコン名（例: briefcase）か絵文字などの短いテキスト。"" = アイコンなし */
  icon: string;
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
  /** タイムラインに表示するか（ツールバーの「表示」メニューで切替） */
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
  /** 作るタスクを結びつけるプロジェクト（リンク先）。無ければ undefined */
  project?: string;
  /** 毎回のタスクの本文（詳細）に入れる共通のメモ。無ければ undefined */
  details?: string;
  /** 毎回のタスクに入れる共通のステップ（未チェックの `- [ ] …` で入る）。無ければ undefined */
  steps?: string[];
}

/** 定期タスクの発生日（日 × ルール）ごとの個別の上書き（管理画面の「個別詳細」） */
export interface RecurringOverride {
  /** この日だけの詳細（本文）。undefined = ルールの「共通の詳細」を使う */
  details?: string;
  /** この日だけの時刻。undefined = ルールどおり */
  start?: number | null;
  end?: number | null;
}

/** 定期タスクの発生日（日 × ルール）ごとの記録 */
export interface RecurringInstance {
  /** 書き込んだタスクのブロックID。まだ書き込んでいなければ null */
  blockId: string | null;
  /** この日は入れない（取り消し済み）。タイムラインでの削除や管理画面の操作で付く */
  skipped?: boolean;
  /** 個別調整済み: ルールを編集してもこの日のタスクの時刻・タイトルは書き換えない */
  detached?: boolean;
  /** まだ書き込んでいない日の個別の上書き。書き込むときに使われて消える */
  override?: RecurringOverride;
}

/** 既定の保存フォルダ（空欄にはできない） */
export const DEFAULT_FOLDER = "Timeline";
/** Inbox（日付を決めていないタスク）のノート */
export const DEFAULT_INBOX_PATH = "Timeline/Inbox";
/** 設定の版。旧既定値からの移行判定に使う */
export const SETTINGS_VERSION = 7;

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
  /** タスクを削除したとき <フォルダ>/Log.md に記録を残すか */
  deletionLog: boolean;
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
  /** 未完了→完了にしたとき、実績が空なら自動で記録する */
  autoRecordActual: boolean;
  /** プロジェクト（大きなタスク）ノートを置くフォルダ。空欄 = <フォルダ>/Projects */
  projectsFolder: string;
  /** プロジェクトを新規作成するときのテンプレートのパス（任意。空欄 = 最小の雛形） */
  projectTemplatePath: string;
  /** 実績の計測中のタスク（無ければ null） */
  tracking: TrackingState | null;
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
  /** スマホ（Platform.isPhone）での表示モード。画面が狭く週（7列）は使いにくいので別に記憶する */
  viewModeMobile: ViewMode;
  /** 週の始まり（0 = 日曜 … 6 = 土曜） */
  weekStart: number;
  /** タグごとの色 */
  tagColors: TagColor[];
  /** タグごとの必須・候補フィールド（タスク編集ダイアログの表示に使う） */
  tagFieldSchema: TagFieldSchema[];
  /** 必須フィールドが空のまま保存しようとしたとき警告する（保存自体は止めない） */
  validateRequiredOnSave: boolean;

  /** 定期タスクのルール */
  recurring: RecurringRule[];
  /** 定期タスクを表示時に自動でノートへ書き込むか */
  autoApplyRecurring: boolean;
  /** 日付キー → 反映済みのルール ID（消したタスクが復活しないように覚えておく） */
  recurringApplied: Record<string, string[]>;
  /** 日付キー → ルール ID → 発生日ごとの記録（ブロックID・取り消し・個別調整） */
  recurringInstances: Record<string, Record<string, RecurringInstance>>;

  /** Inbox のノート（拡張子なしでも可） */
  inboxPath: string;
  /** Inbox パネルを表示するか */
  showInbox: boolean;
  /** Inbox パネルを畳んでいるか */
  inboxCollapsed: boolean;
  /** プロジェクトのパネルを表示するか */
  showProjects: boolean;
  /** プロジェクトパネルで完了済み（持ち越し済みを含む）の子タスクを隠すか */
  projectsHideDone: boolean;
  /** プロジェクトパネルでグループの見出し（階層）を出さずフラットな一覧にするか。並びはグループ順のまま */
  projectsFlatList: boolean;
  /** プロジェクトのグループ（frontmatter の group）の表示順とアイコン。載っていないグループは名前順で後ろに */
  projectGroups: ProjectGroupSetting[];
  /** ツリーのグループ見出しに出す既定のアイコン（Lucide 名か絵文字。"" = なし。グループごとの指定が優先） */
  defaultGroupIcon: string;
  /** 左サイドバー（Inbox・プロジェクト）の幅（px）。端のドラッグで変えられる */
  sidebarWidth: number;
  /** 左サイドバーで表示中のタブ（Inbox / プロジェクト / 再スケジュール）。記憶される */
  sidebarTab: SidebarTab;

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
  deletionLog: true,
  mirrorTitleInMeta: false,
  startHour: 7,
  endHour: 22,
  hourHeight: 60,
  zoomHours: 0,
  paMode: "plan",
  autoRecordActual: true,
  projectsFolder: "",
  projectTemplatePath: "",
  tracking: null,
  snapMinutes: 15,
  defaultDurationMinutes: 30,
  useCheckbox: true,
  showCurrentTime: true,
  showUnscheduledTray: true,
  viewLocation: "tab",
  viewMode: "week",
  viewModeMobile: "day",
  weekStart: 0,
  tagColors: [],
  tagFieldSchema: DEFAULT_TAG_FIELD_SCHEMA,
  validateRequiredOnSave: true,
  recurring: [],
  autoApplyRecurring: true,
  recurringApplied: {},
  recurringInstances: {},
  inboxPath: DEFAULT_INBOX_PATH,
  showInbox: true,
  inboxCollapsed: false,
  showProjects: true,
  projectsHideDone: false,
  projectsFlatList: false,
  projectGroups: [],
  defaultGroupIcon: "folder",
  sidebarWidth: 220,
  sidebarTab: "inbox",
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
 * v2: recurringInstances が「ルールID → ブロックID の文字列」だった。
 * v3〜v5: プロジェクト行にアイコン（defaultProjectIcon）を出していた。
 * v6 → v7: tagFieldSchema（タグ別の必須・候補フィールド）と validateRequiredOnSave を追加。
 *          保存済みの設定に無ければ既定値が入る（既存の設定は変えない）。
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
  // 形の崩れた項目を落としつつ、既定値の配列を共有参照しないようコピーする
  if (!Array.isArray(s.tagFieldSchema)) s.tagFieldSchema = DEFAULT_TAG_FIELD_SCHEMA;
  s.tagFieldSchema = s.tagFieldSchema
    .filter((r) => !!r && typeof r === "object" && typeof r.tag === "string")
    .map((r) => ({
      tag: r.tag,
      required: Array.isArray(r.required) ? r.required.filter((f): f is string => typeof f === "string") : [],
      suggested: Array.isArray(r.suggested) ? r.suggested.filter((f): f is string => typeof f === "string") : [],
    }));
  if (typeof s.validateRequiredOnSave !== "boolean") s.validateRequiredOnSave = true;
  if (!Array.isArray(s.recurring)) s.recurring = [];
  if (!s.recurringApplied || typeof s.recurringApplied !== "object") s.recurringApplied = {};
  if (!s.recurringInstances || typeof s.recurringInstances !== "object") s.recurringInstances = {};
  // 旧形式（文字列）の発生日記録をオブジェクトに揃える（何度通っても安全）
  for (const map of Object.values(s.recurringInstances)) {
    if (!map || typeof map !== "object") continue;
    const m = map as Record<string, unknown>;
    for (const [ruleId, inst] of Object.entries(m)) {
      if (typeof inst === "string") m[ruleId] = { blockId: inst };
      else if (!inst || typeof inst !== "object") delete m[ruleId];
    }
  }
  if (!s.inboxPath.trim()) s.inboxPath = DEFAULT_INBOX_PATH;
  if (!Array.isArray(s.projectGroups)) s.projectGroups = [];
  s.projectGroups = s.projectGroups
    .filter((g) => !!g && typeof g === "object" && typeof g.name === "string")
    .map((g) => ({ name: g.name, icon: typeof g.icon === "string" ? g.icon : "" }));
  // v2.29.0 の projectGroupOrder（グループ名だけの配列）から移行（何度通っても安全）
  const legacyGroupOrder = (loaded as Record<string, unknown>).projectGroupOrder;
  if (!s.projectGroups.length && Array.isArray(legacyGroupOrder)) {
    s.projectGroups = legacyGroupOrder
      .filter((n): n is string => typeof n === "string" && !!n.trim())
      .map((name) => ({ name, icon: "" }));
  }
  delete (s as unknown as Record<string, unknown>).projectGroupOrder;
  // "" は「アイコンなし」の指定なので、文字列でないときだけ既定に戻す
  if (typeof s.defaultGroupIcon !== "string") s.defaultGroupIcon = DEFAULT_SETTINGS.defaultGroupIcon;
  // v2.43.0 でプロジェクト行のアイコンは廃止（行が見にくくなるため）。保存済みの値は落とす
  delete (s as unknown as Record<string, unknown>).defaultProjectIcon;
  if (typeof s.projectTemplatePath !== "string") s.projectTemplatePath = "";
  if (!["inbox", "projects", "reschedule"].includes(s.sidebarTab)) s.sidebarTab = "inbox";
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
        .setName("削除したタスクの記録を残す")
        .setDesc(
          "タスクを削除したとき、<フォルダ>/Log.md に日時・タイトル・元のノートを1行で記録します。" +
            "「消えたタスク」が意図した削除だったかを後から確かめられます。"
        )
        .addToggle((t) =>
          t.setValue(s.deletionLog).onChange(async (v) => {
            s.deletionLog = v;
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
      .setDesc(
        "タイムラインを開いたときの表示。ツールバーの「日 / 3日 / 週 / 月」でいつでも切り替えられます。" +
          "スマホでは画面が狭いため表示を別に記憶します（既定は日表示。ツールバーで切り替えるとそれを覚えます）。"
      )
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
      .setDesc("タイムラインの拡大率（px）。タイムライン上の Ctrl＋スクロールでも変えられます。")
      .addSlider((sl) =>
        sl
          .setLimits(MIN_HOUR_HEIGHT, MAX_HOUR_HEIGHT, 5)
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
        .setName("再スケジュール欄を表示")
        .setDesc("時刻を決めていないタスクを、左サイドバー（プロジェクトの下）の「再スケジュール」欄に日付付きで一覧します。タイムラインへドラッグで時刻を割り当てられます。")
        .addToggle((t) =>
          t.setValue(s.showUnscheduledTray).onChange(async (v) => {
            s.showUnscheduledTray = v;
            await save();
          })
        );

      new Setting(containerEl)
        .setName("プロジェクトのフォルダ")
        .setDesc("プロジェクト（大きなタスク）のノートを置く場所。空欄なら「<フォルダ>/Projects」。")
        .addText((t) =>
          t
            .setPlaceholder((s.folder ? s.folder + "/" : "") + "Projects")
            .setValue(s.projectsFolder)
            .onChange(async (v) => {
              s.projectsFolder = v.trim();
              await save();
            })
        );

      new Setting(containerEl)
        .setName("プロジェクトのテンプレート")
        .setDesc(
          "プロジェクトを新規作成するときに使うテンプレートファイル（任意。空欄なら最小の雛形）。" +
            "{{name}} はプロジェクト名、{{date}}・{{time}}・{{group}} も置き換えます。" +
            "「- 期日: 」「- チケット: 」「- ドキュメント: [[リンク]]」の行を書いておくと、プロジェクトパネルに表示されます。" +
            "「テンプレートを作成」で、このパス（空欄なら Templates/Project）にサンプルを作って開きます。"
        )
        .addText((t) =>
          t
            .setPlaceholder("例: Templates/Project")
            .setValue(s.projectTemplatePath)
            .onChange(async (v) => {
              s.projectTemplatePath = v.trim();
              await save();
            })
        )
        .addButton((b) =>
          b.setButtonText("テンプレートを作成").onClick(async () => {
            if (!s.projectTemplatePath.trim()) {
              s.projectTemplatePath = "Templates/Project";
              await save();
              this.display();
            }
            const projects = this.plugin.projects;
            if (!projects) return;
            const file = await projects.ensureTemplate();
            if (!file) {
              new Notice("テンプレートを作成できませんでした");
              return;
            }
            await this.app.workspace.getLeaf("tab").openFile(file);
          })
        );

      new Setting(containerEl)
        .setName("完了にしたとき実績を自動で記録")
        .setDesc(
          "実績が空のタスクを完了にすると「開始 = 予定の開始、終了 = 今」で実績を記録します" +
            "（完了が予定とかけ離れた時刻のときは予定どおりとして記録）。" +
            "同じ日の他のタスクの実績と重なる時間帯は除いて記録します。完了時のポップアップで直せます。"
        )
        .addToggle((t) =>
          t.setValue(s.autoRecordActual).onChange(async (v) => {
            s.autoRecordActual = v;
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

    // ---------- タグ別フィールド ----------
    new Setting(containerEl).setName("タグ別フィールド").setHeading();
    new Setting(containerEl)
      .setName("タグで必須・候補のフィールドを決める")
      .setDesc(
        "タスク編集ダイアログでタグを選ぶと、「必須」の欄が自動で開いて必須マークが付き、" +
          "「候補」の欄が「＋」チップの先頭に並びます。フィールド名はダイアログの欄名" +
          "（結果 / 原因 / 判断 / 残 / 他者 / 回答 / 状態 / Owner / 期限 / 完了条件 / ふりかえり など）を" +
          "カンマ区切りで書きます。サブタグ（#管理/質問）は親タグ（#管理）の定義に従います。" +
          "ここに無いタグを選んだときは従来どおりの表示です。"
      )
      .addButton((b) =>
        b
          .setButtonText("追加")
          .setCta()
          .onClick(async () => {
            s.tagFieldSchema.push({ tag: "", required: ["結果"], suggested: [] });
            await save();
            this.display();
          })
      );
    new Setting(containerEl)
      .setName("必須フィールドが空のまま保存するとき警告")
      .setDesc("空でも「このまま保存」を選べます（途中保存を妨げないため、保存自体は止めません）。")
      .addToggle((t) =>
        t.setValue(s.validateRequiredOnSave).onChange(async (v) => {
          s.validateRequiredOnSave = v;
          await save();
        })
      );
    const parseFieldList = (v: string) =>
      v
        .split(/[,、，]/)
        .map((f) => f.trim())
        .filter(Boolean);
    s.tagFieldSchema.forEach((rule, idx) => {
      const row = new Setting(containerEl);
      row.settingEl.addClass("dt-tag-schema-row");
      const nameSpan = row.nameEl.createSpan();
      const updateName = () =>
        nameSpan.setText(rule.tag ? `#${normalizeTag(rule.tag)}` : "(タグ未設定)");
      updateName();
      row
        .addText((t) => {
          t.setPlaceholder("タグ（例: 障害）")
            .setValue(rule.tag)
            .onChange(async (v) => {
              rule.tag = v.trim().replace(/^#+/, "");
              updateName();
              await save();
            });
          t.inputEl.addClass("dt-schema-tag");
        })
        .addText((t) => {
          t.setPlaceholder("必須（例: 結果, 原因）")
            .setValue(rule.required.join(", "))
            .onChange(async (v) => {
              rule.required = parseFieldList(v);
              await save();
            });
          t.inputEl.addClass("dt-schema-fields");
          t.inputEl.setAttr("title", "必須のフィールド名（カンマ区切り）");
        })
        .addText((t) => {
          t.setPlaceholder("候補（例: 残, 他者）")
            .setValue(rule.suggested.join(", "))
            .onChange(async (v) => {
              rule.suggested = parseFieldList(v);
              await save();
            });
          t.inputEl.addClass("dt-schema-fields");
          t.inputEl.setAttr("title", "候補のフィールド名（カンマ区切り。この順でチップの先頭に並びます）");
        })
        .addExtraButton((b) =>
          b
            .setIcon("arrow-up")
            .setTooltip("上へ")
            .setDisabled(idx === 0)
            .onClick(async () => {
              if (idx === 0) return;
              [s.tagFieldSchema[idx - 1], s.tagFieldSchema[idx]] = [
                s.tagFieldSchema[idx],
                s.tagFieldSchema[idx - 1],
              ];
              await save();
              this.display();
            })
        )
        .addExtraButton((b) =>
          b
            .setIcon("trash")
            .setTooltip("削除")
            .onClick(async () => {
              s.tagFieldSchema.splice(idx, 1);
              await save();
              this.display();
            })
        );
    });

    // ---------- 定期タスク ----------
    new Setting(containerEl).setName("定期タスク").setHeading();
    new Setting(containerEl)
      .setName("管理画面")
      .setDesc(
        "ルールの登録・編集、今後の予定の状態（反映済み / 取り消しなど）の確認、" +
          "回ごとの「個別詳細」の入力をまとめて行える画面を開きます。"
      )
      .addButton((b) =>
        b
          .setButtonText("定期タスクの管理画面を開く")
          .setCta()
          .onClick(() => {
            void this.plugin.activateRecurringView();
            // 後ろに開くビューが見えるよう、設定ダイアログを閉じる
            (this.app as unknown as { setting?: { close?: () => void } }).setting?.close?.();
          })
      );
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
              projects: this.plugin.projects?.list(),
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
              const prev = { ...rule };
              new RecurringModal(this.app, {
                initial: rule,
                tagChoices: s.tagColors,
                projects: this.plugin.projects?.list(),
                onSubmit: async (next) => {
                  s.recurring[idx] = next;
                  await save();
                  this.display();
                  await propagateAndNotify(this.plugin, next, prev);
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
      .setName("プロジェクトのパネルを表示")
      .setDesc("Inbox の下にプロジェクト（大きなタスク）の一覧・進捗・予実合計を表示します。")
      .addToggle((t) =>
        t.setValue(s.showProjects).onChange(async (v) => {
          s.showProjects = v;
          await save();
        })
      );
    new Setting(containerEl)
      .setName("プロジェクトの完了済みタスクを隠す")
      .setDesc(
        "プロジェクトパネルのツリーに、完了済み・持ち越し済みの子タスクを出しません。パネルの目のボタンでも切り替えられます。"
      )
      .addToggle((t) =>
        t.setValue(s.projectsHideDone).onChange(async (v) => {
          s.projectsHideDone = v;
          await save();
        })
      );
    new Setting(containerEl)
      .setName("プロジェクトをフラットな一覧で表示")
      .setDesc(
        "グループの見出し（階層）を出さず、プロジェクトだけを一覧します。並びはグループ順のまま" +
          "（ツリーと同じ: 設定の表示順 → 名前順 → 未分類は末尾。各グループの中は名前順）。" +
          "グループ名は行のツールチップで確認できます。パネルの一覧ボタンでも切り替えられます。"
      )
      .addToggle((t) =>
        t.setValue(s.projectsFlatList).onChange(async (v) => {
          s.projectsFlatList = v;
          await save();
        })
      );
    // ツリーのグループ見出しに出す既定のアイコン。プレビュー付きの入力欄
    {
      const st = new Setting(containerEl)
        .setName("グループの既定のアイコン")
        .setDesc(
          "パネルのツリーのグループ見出しに出すアイコン。Lucide のアイコン名（例: folder）か絵文字。" +
            "空欄にするとアイコンなし。下の一覧でグループごとに指定するとそちらが優先されます。"
        );
      const preview = st.nameEl.createSpan({ cls: "dt-group-icon-preview" });
      st.nameEl.prepend(preview);
      const updatePreview = () => {
        preview.empty();
        if (s.defaultGroupIcon.trim()) renderGroupIcon(preview, s.defaultGroupIcon.trim());
      };
      updatePreview();
      st.addText((t) => {
        t.setPlaceholder("folder")
          .setValue(s.defaultGroupIcon)
          .onChange(async (v) => {
            s.defaultGroupIcon = v.trim();
            updatePreview();
            await save();
          });
        t.inputEl.addClass("dt-group-icon-input");
      });
    }
    new Setting(containerEl)
      .setName("プロジェクトのグループ")
      .setDesc(
        "プロジェクトはグループ分けでき、パネルのツリーがグループごとに区切られます" +
          "（割り当てはパネルのプロジェクト行の右クリック、またはプロジェクトノートの frontmatter「group: 名前」）。" +
          "ここではグループの表示順を管理します。アイコン欄は、そのグループだけ既定のアイコンと" +
          "変えたいときに使います（Lucide のアイコン名か絵文字）。載っていないグループは名前順で後ろに、" +
          "グループなしのプロジェクトは「未分類」として末尾に並びます。"
      )
      .addButton((b) =>
        b
          .setButtonText("追加")
          .setCta()
          .onClick(async () => {
            s.projectGroups.push({ name: "", icon: "" });
            await save();
            this.display();
          })
      );
    s.projectGroups.forEach((grp, idx) => {
      const row = new Setting(containerEl);
      row.settingEl.addClass("dt-group-order-row");
      const preview = row.nameEl.createSpan({ cls: "dt-group-icon-preview" });
      const nameSpan = row.nameEl.createSpan();
      const updateName = () => nameSpan.setText(grp.name.trim() || "(名前未設定)");
      const updatePreview = () => {
        preview.empty();
        if (grp.icon.trim()) renderGroupIcon(preview, grp.icon.trim());
      };
      updateName();
      updatePreview();
      row
        .addText((t) =>
          t
            .setPlaceholder("グループ名（例: 仕事）")
            .setValue(grp.name)
            .onChange(async (v) => {
              grp.name = v.trim();
              updateName();
              await save();
            })
        )
        .addText((t) => {
          t.setPlaceholder("アイコン（briefcase / 💼）")
            .setValue(grp.icon)
            .onChange(async (v) => {
              grp.icon = v.trim();
              updatePreview();
              await save();
            });
          t.inputEl.addClass("dt-group-icon-input");
        })
        .addExtraButton((b) =>
          b
            .setIcon("arrow-up")
            .setTooltip("上へ")
            .setDisabled(idx === 0)
            .onClick(async () => {
              if (idx === 0) return;
              [s.projectGroups[idx - 1], s.projectGroups[idx]] = [
                s.projectGroups[idx],
                s.projectGroups[idx - 1],
              ];
              await save();
              this.display();
            })
        )
        .addExtraButton((b) =>
          b
            .setIcon("trash")
            .setTooltip("削除（プロジェクトのグループ割り当ては変わりません）")
            .onClick(async () => {
              s.projectGroups.splice(idx, 1);
              await save();
              this.display();
            })
        );
    });
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
          "自分の予定と同じカレンダーに色分けして表示します。表示の切替はツールバーの「表示」メニューで行います。"
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
