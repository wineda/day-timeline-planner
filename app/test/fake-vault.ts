/**
 * テスト用の保管庫（メモリ上の Map）。store.ts / recurring.ts が使う vault の API だけを持つ。
 * 失敗の注入（failWith）と、書き込み直前のフック（onBeforeProcess。読み取りと削除の間に
 * ノートが外から変わった状況を作る）ができる
 */
import { TFile, TFolder, type App } from "obsidian";

export type VaultOp = "create" | "process" | "read";

export class FakeVault {
  files = new Map<string, string>();
  folders = new Set<string>();
  /** 失敗を注入する: (パス, 操作) → 投げる Error（null なら成功） */
  failWith: ((path: string, op: VaultOp) => Error | null) | null = null;
  /** process（書き込み）の直前に呼ぶフック */
  onBeforeProcess: ((path: string) => void) | null = null;
  /** 行った操作の記録（"create <path>" / "process <path>"）。順序の検証用 */
  ops: string[] = [];

  getAbstractFileByPath(path: string): TFile | TFolder | null {
    if (this.files.has(path)) return fileOf(path);
    if (this.folders.has(path)) {
      const f = new TFolder();
      f.path = path;
      return f;
    }
    return null;
  }

  async create(path: string, content: string): Promise<TFile> {
    this.ops.push(`create ${path}`);
    const err = this.failWith?.(path, "create");
    if (err) throw err;
    if (this.files.has(path)) throw new Error("File already exists.");
    this.files.set(path, content);
    return fileOf(path);
  }

  async createFolder(path: string): Promise<void> {
    this.folders.add(path);
  }

  async read(file: TFile): Promise<string> {
    const err = this.failWith?.(file.path, "read");
    if (err) throw err;
    return this.files.get(file.path) ?? "";
  }

  async cachedRead(file: TFile): Promise<string> {
    return this.read(file);
  }

  async process(file: TFile, fn: (content: string) => string): Promise<string> {
    this.ops.push(`process ${file.path}`);
    this.onBeforeProcess?.(file.path);
    const err = this.failWith?.(file.path, "process");
    if (err) throw err;
    const next = fn(this.files.get(file.path) ?? "");
    this.files.set(file.path, next);
    return next;
  }
}

function fileOf(path: string): TFile {
  const f = new TFile();
  f.path = path;
  const name = path.slice(path.lastIndexOf("/") + 1);
  f.name = name;
  f.basename = name.replace(/\.md$/, "");
  f.extension = "md";
  return f;
}

/** vault だけを持つ App の代わり */
export function fakeApp(vault: FakeVault): App {
  return { vault } as unknown as App;
}
