/** 2桁ゼロ埋め */
export function pad2(n: number): string {
  return (n < 10 ? "0" : "") + n;
}

/** 分（0〜1440）→ "HH:MM"。1440 は "24:00" になる */
export function minutesToHHMM(min: number): string {
  const m = Math.max(0, Math.min(1440, Math.round(min)));
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
}

/**
 * ユーザー入力の時刻を分に変換する。
 * "9:00" "09:00" "930" "0930" "9" "２１：３０"（全角）などを受け付ける。
 * 解釈できなければ null。
 */
export function parseTimeInput(input: string): number | null {
  const t = input
    .trim()
    .replace(/：/g, ":")
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  if (!t) return null;

  let h: number;
  let mi: number;
  let m = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (m) {
    h = Number(m[1]);
    mi = Number(m[2]);
  } else if ((m = /^(\d{1,2})(\d{2})$/.exec(t))) {
    h = Number(m[1]);
    mi = Number(m[2]);
  } else if ((m = /^(\d{1,2})$/.exec(t))) {
    h = Number(m[1]);
    mi = 0;
  } else {
    return null;
  }
  if (h > 24 || mi > 59) return null;
  if (h === 24 && mi > 0) return null;
  return h * 60 + mi;
}

/** 分数を「1時間30分」のような表記に */
export function formatDuration(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h && m) return `${h}時間${m}分`;
  if (h) return `${h}時間`;
  return `${m}分`;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** その日の 0:00（ローカル時刻）を返す */
export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addDays(d: Date, n: number): Date {
  const r = new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  return startOfDay(r);
}

export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function isToday(d: Date): boolean {
  return isSameDay(d, new Date());
}

/** 現在時刻を「0:00 からの分数」で返す */
export function nowMinutes(): number {
  const n = new Date();
  return n.getHours() * 60 + n.getMinutes();
}

/** 日付を "YYYY-MM-DD" のキーにする（Map の鍵などに使う） */
export function dateKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** その日を含む週の先頭（weekStart: 0 = 日曜 … 6 = 土曜） */
export function startOfWeek(d: Date, weekStart = 0): Date {
  const diff = (d.getDay() - weekStart + 7) % 7;
  return addDays(d, -diff);
}

/** テキストから Obsidian のタグ（#tag / #親/子）を取り出す。"#" は含まない */
export function extractTags(text: string): string[] {
  const out: string[] = [];
  const re = /(?:^|[\s(（「\[])#([\p{L}\p{N}_\-\/]+)/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const tag = m[1].replace(/\/+$/, "");
    if (!tag || /^\d+$/.test(tag)) continue; // 数字だけのタグは Obsidian でも無効
    if (!out.includes(tag)) out.push(tag);
  }
  return out;
}

/** "#rrggbb" の色に対して読みやすい文字色（黒 or 白）を返す */
export function contrastTextColor(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "";
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? "rgba(0, 0, 0, 0.85)" : "#ffffff";
}

/** 表示用に #タグ を取り除いたタイトル（タグしか無ければそのまま返す） */
export function stripTags(text: string): string {
  const stripped = text
    .replace(/(^|[\s(（「\[])#[\p{L}\p{N}_\-\/]+/gu, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
  return stripped || text;
}
