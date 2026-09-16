#!/usr/bin/env node
/**
 * バージョンを上げて、リリースに必要なファイルをすべて揃える。
 *
 *   npm run bump               # minor を上げる（2.116.0 → 2.117.0。機能追加・修正の既定）
 *   npm run bump -- patch      # patch を上げる（2.116.0 → 2.116.1）
 *   npm run bump -- major      # major を上げる
 *   npm run bump -- 2.120.0    # 番号を直接指定
 *   npm run bump -- --no-build # ビルドと dist/main.js のコピーを省く（ソースを変えていないときだけ）
 *   npm run bump -- --help
 *
 * やること（CI の ci.yml が同じ整合性を検証する）:
 *   1. manifest.json / versions.json に未コミットの変更が無いことを確認（失敗後の再実行で二重に上がるのを防ぐ）
 *   2. npm run build（型チェック + esbuild）。ここで失敗すれば何も書き換えない
 *   3. app/manifest.json の version を更新し、リポジトリ直下の manifest.json をそのコピーにする（BRAT 用）
 *   4. app/versions.json に「新バージョン: minAppVersion」の行を足す
 *   5. docs/format.md を生成し直す（plugin_version を含むため）
 *   6. main.js / styles.css / manifest.json を app/dist/ へコピー
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

const USAGE = `使い方: npm run bump -- [major|minor|patch|X.Y.Z] [--no-build]
  既定は minor。--no-build はソースを変えていないとき（dist/main.js が最新のとき）だけ使う`;

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith("-"));
const words = args.filter((a) => !a.startsWith("-"));
if (flags.includes("--help") || flags.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}
const unknown = flags.filter((f) => f !== "--no-build");
if (unknown.length || words.length > 1) {
  console.error(`不明な引数: ${[...unknown, ...words.slice(1)].join(" ")}\n${USAGE}`);
  process.exit(1);
}
const noBuild = flags.includes("--no-build");
const spec = words[0] ?? "minor";

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
      throw new Error(`不明な指定: ${how}\n${USAGE}`);
  }
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const current = manifest.version;
const next = nextVersion(current, spec);
const versions = JSON.parse(readFileSync(versionsPath, "utf8"));
if (versions[next]) throw new Error(`${next} は versions.json にすでにあります`);

// 1. 未コミットの変更が無いことを確認（前回の bump が途中で失敗していたら、先に git checkout で戻す）
try {
  execSync("git diff --quiet -- manifest.json versions.json ../manifest.json", { cwd: appDir, stdio: "ignore" });
} catch (_e) {
  console.error(
    "manifest.json / versions.json に未コミットの変更があります。前回の bump が途中で失敗した可能性があるので、\n" +
      "  git checkout -- app/manifest.json app/versions.json manifest.json\n" +
      "で戻してからやり直してください（意図した変更ならコミットしてから実行）"
  );
  process.exit(1);
}

// 2. ビルド（失敗したらここで止まり、番号は変わらない）
if (!noBuild) execSync("npm run build", { cwd: appDir, stdio: "inherit" });

// 3. app/manifest.json とルートの manifest.json（同じ中身）
manifest.version = next;
const manifestText = JSON.stringify(manifest, null, 2) + "\n";
writeFileSync(manifestPath, manifestText);
writeFileSync(rootManifestPath, manifestText);
// 4. versions.json
versions[next] = manifest.minAppVersion;
writeFileSync(versionsPath, JSON.stringify(versions, null, 2) + "\n");
console.log(`version: ${current} → ${next}`);

// 5. 仕様書（docs/format.md）は plugin_version を含むので、番号を変えたら生成し直す
execSync("node scripts/gen-spec.mjs", { cwd: appDir, stdio: "inherit" });

// 6. dist/ へコピー（main.js はビルドしたときだけ。--no-build のときは dist/main.js が最新である前提）
for (const f of noBuild ? ["styles.css", "manifest.json"] : ["main.js", "styles.css", "manifest.json"]) {
  copyFileSync(join(appDir, f), join(appDir, "dist", f));
}
console.log(noBuild ? "dist/ の manifest.json と styles.css を更新しました（main.js はそのまま）" : "dist/ を更新しました");

console.log(`\n次: 変更をコミットしてください。コミットメッセージの末尾に (v${next}) を付けます`);
