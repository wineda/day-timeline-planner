#!/usr/bin/env node
/**
 * バージョンを上げて、リリースに必要なファイルをすべて揃える。
 *
 *   npm run bump            # minor を上げる（2.116.0 → 2.117.0。機能追加・修正の既定）
 *   npm run bump -- patch   # patch を上げる（2.116.0 → 2.116.1）
 *   npm run bump -- major   # major を上げる
 *   npm run bump -- 2.120.0 # 番号を直接指定
 *   npm run bump -- --no-build  # ビルドと dist/ のコピーを省く（番号だけ揃える）
 *
 * やること（CI の ci.yml が同じ整合性を検証する）:
 *   1. app/manifest.json の version を更新
 *   2. リポジトリ直下の manifest.json を app/manifest.json のコピーにする（BRAT 用）
 *   3. app/versions.json に「新バージョン: minAppVersion」の行を足す
 *   4. npm run build（型チェック + esbuild）
 *   5. main.js / styles.css / manifest.json を app/dist/ へコピー
 */
import { execSync } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const rootDir = join(appDir, "..");
const manifestPath = join(appDir, "manifest.json");
const rootManifestPath = join(rootDir, "manifest.json");
const versionsPath = join(appDir, "versions.json");

const args = process.argv.slice(2);
const noBuild = args.includes("--no-build");
const spec = args.find((a) => !a.startsWith("--")) ?? "minor";

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const current = manifest.version;

function nextVersion(cur, how) {
  if (/^\d+\.\d+\.\d+$/.test(how)) return how;
  const [major, minor, patch] = cur.split(".").map(Number);
  switch (how) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    default:
      throw new Error(`不明な指定: ${how}（major / minor / patch / X.Y.Z）`);
  }
}

const next = nextVersion(current, spec);
const versions = JSON.parse(readFileSync(versionsPath, "utf8"));
if (versions[next]) throw new Error(`${next} は versions.json にすでにあります`);

// 1. app/manifest.json
manifest.version = next;
const manifestText = JSON.stringify(manifest, null, 2) + "\n";
writeFileSync(manifestPath, manifestText);
// 2. ルートの manifest.json（同じ中身）
writeFileSync(rootManifestPath, manifestText);
// 3. versions.json
versions[next] = manifest.minAppVersion;
writeFileSync(versionsPath, JSON.stringify(versions, null, 2) + "\n");
console.log(`version: ${current} → ${next}`);

if (!noBuild) {
  // 4. ビルド
  execSync("npm run build", { cwd: appDir, stdio: "inherit" });
  // 5. dist/ へコピー
  for (const f of ["main.js", "styles.css", "manifest.json"]) {
    copyFileSync(join(appDir, f), join(appDir, "dist", f));
  }
  console.log("dist/ を更新しました");
}

console.log(`\n次: 変更をコミットしてください。コミットメッセージの末尾に (v${next}) を付けます`);
