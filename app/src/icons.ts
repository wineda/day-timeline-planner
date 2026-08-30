/**
 * Lucide アイコン名のバージョン差を吸収する。
 *
 * Obsidian は Lucide のアイコン集を同梱しているが、そのバージョンはアプリの
 * バージョンによって異なる（おおむね 1.6 以前は v0.268、1.7 以降は v0.446）。
 * v0.446 では一部のアイコンが改名されて旧名が消えたため、旧名のまま指定すると
 * 新しい Obsidian（特に自動更新されるモバイル）で何も描画されない。
 * ここで「まず指定名 → 無ければ改名後の名前」の順に、実在する名前へ解決する。
 */
import { getIcon } from "obsidian";

/** 旧名（〜v0.268）→ 改名後の候補（v0.446〜。先に見つかったものを使う） */
const ICON_RENAMES: Record<string, string[]> = {
  "check-circle-2": ["circle-check-big", "circle-check"],
  "check-square": ["square-check-big", "square-check"],
  "more-vertical": ["ellipsis-vertical"],
};

/** 解決結果のキャッシュ（同梱アイコンは実行中に変わらない） */
const resolved = new Map<string, string>();

/** この Obsidian に実在するアイコン名へ解決する（見つからなければ指定名のまま返す） */
export function iconName(name: string): string {
  const hit = resolved.get(name);
  if (hit) return hit;
  let out = name;
  if (!getIcon(name)) {
    for (const alt of ICON_RENAMES[name] ?? []) {
      if (getIcon(alt)) {
        out = alt;
        break;
      }
    }
  }
  resolved.set(name, out);
  return out;
}
