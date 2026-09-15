#!/usr/bin/env node
/**
 * 保存形式の仕様書を src/markdown/fields.ts の定義から生成する。
 *
 *   npm run gen:spec            # docs/format.md と README.md の一覧を書き換える
 *   npm run gen:spec -- --check # 生成物が最新か確かめるだけ（CI 用。古ければ exit 1）
 *
 * 出力:
 *   - docs/format.md … 仕様書の全文（既定の設定で生成。保管庫向けはプラグインのコマンドで書き出す）
 *   - README.md の <!-- fields:start --> 〜 <!-- fields:end --> の間 … フィールドの箇条書き
 *
 * src/spec.ts は TypeScript なので、esbuild で束ねてから読み込む（依存は追加しない）
 */
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const rootDir = join(appDir, "..");
const check = process.argv.includes("--check");

const bundled = await build({
  entryPoints: [join(appDir, "src/spec.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  logLevel: "silent",
});
const spec = await import("data:text/javascript;base64," + Buffer.from(bundled.outputFiles[0].text).toString("base64"));

const manifest = JSON.parse(readFileSync(join(appDir, "manifest.json"), "utf8"));

const outputs = [];

// docs/format.md
outputs.push({
  path: join(rootDir, "docs/format.md"),
  content: spec.renderFormatSpec(spec.defaultSpecContext(manifest.version)),
});

// README.md のマーカーの間
const readmePath = join(rootDir, "README.md");
const readme = readFileSync(readmePath, "utf8");
const START = "<!-- fields:start -->";
const END = "<!-- fields:end -->";
const a = readme.indexOf(START);
const b = readme.indexOf(END);
if (a < 0 || b < 0 || b < a) {
  console.error(`README.md に ${START} 〜 ${END} のマーカーがありません`);
  process.exit(1);
}
const generated =
  START +
  "\n<!-- この間は npm run gen:spec が src/markdown/fields.ts から生成する。手で直さない -->\n" +
  spec.renderFieldList() +
  "\n" +
  END;
outputs.push({ path: readmePath, content: readme.slice(0, a) + generated + readme.slice(b + END.length) });

let stale = 0;
for (const o of outputs) {
  let current = null;
  try {
    current = readFileSync(o.path, "utf8");
  } catch (_e) {
    // まだ無い
  }
  if (current === o.content) continue;
  stale++;
  if (check) {
    console.error(`${o.path} が最新ではありません。npm run gen:spec を実行してコミットしてください`);
  } else {
    writeFileSync(o.path, o.content);
    console.log(`更新: ${o.path}`);
  }
}
if (check && stale) process.exit(1);
if (!stale) console.log("生成物は最新です");
