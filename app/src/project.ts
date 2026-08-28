/**
 * プロジェクト（大きなタスク）= 1つのノート。
 * 日々のタスクブロックが「- プロジェクト: [[...]]」行でここへリンクし、
 * メモや工程（ステップ）の置き場を1箇所にまとめる。
 */
import { App, Notice, TFile, TFolder, normalizePath } from "obsidian";
import type { DayTimelineSettings } from "./settings";
import { newBlockId } from "./markdown/id";

export interface ProjectRef {
  /** リンクに書く文字列（フォルダ付き・拡張子なし） */
  linktext: string;
  /** 表示名（ファイル名） */
  name: string;
}

/** リンク先文字列から表示名（ファイル名部分）を取り出す */
export function projectDisplayName(linktext: string): string {
  const base = linktext.split("/").pop() ?? linktext;
  return base.replace(/\.md$/, "");
}

export class ProjectStore {
  constructor(
    private app: App,
    private getSettings: () => DayTimelineSettings
  ) {}

  /** プロジェクトノートを置くフォルダ（既定: <フォルダ>/Projects） */
  folder(): string {
    const s = this.getSettings();
    const custom = s.projectsFolder.trim();
    if (custom) return normalizePath(custom);
    return normalizePath((s.folder ? s.folder + "/" : "") + "Projects");
  }

  /** プロジェクトの一覧（フォルダ内の .md ファイル）。名前順 */
  list(): ProjectRef[] {
    const folder = this.app.vault.getAbstractFileByPath(this.folder());
    if (!(folder instanceof TFolder)) return [];
    const out: ProjectRef[] = [];
    for (const f of folder.children) {
      if (f instanceof TFile && f.extension === "md") {
        out.push({ linktext: f.path.replace(/\.md$/, ""), name: f.basename });
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, "ja"));
  }

  /**
   * 名前からプロジェクトノートを作る（既にあればそのまま使う）。
   * タスクブロックと同じ文法（見出し + メタ行）で作るので、後から集計にも使える。
   * 作れなければ null
   */
  async create(name: string): Promise<string | null> {
    const safe = name
      .trim()
      .replace(/[\\/:*?"<>|#^[\]]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!safe) return null;
    const dir = this.folder();
    await this.ensureFolder(dir);
    const path = normalizePath(`${dir}/${safe}.md`);
    if (!this.app.vault.getAbstractFileByPath(path)) {
      const content = `# ${safe}\n- [ ] ^${newBlockId()}\n\n`;
      try {
        await this.app.vault.create(path, content);
      } catch (e) {
        if (!this.app.vault.getAbstractFileByPath(path)) {
          console.error(e);
          return null;
        }
      }
    }
    return path.replace(/\.md$/, "");
  }

  /** プロジェクトノートを開く */
  async open(linktext: string): Promise<void> {
    try {
      await this.app.workspace.openLinkText(linktext, "", false);
    } catch (e) {
      console.error(e);
      new Notice("プロジェクトノートを開けませんでした: " + String(e));
    }
  }

  private async ensureFolder(dir: string): Promise<void> {
    if (!dir) return;
    const parts = normalizePath(dir).split("/");
    let cur = "";
    for (const p of parts) {
      cur = cur ? `${cur}/${p}` : p;
      if (!this.app.vault.getAbstractFileByPath(cur)) {
        try {
          await this.app.vault.createFolder(cur);
        } catch (_e) {
          // 既に存在する場合など
        }
      }
    }
  }
}
