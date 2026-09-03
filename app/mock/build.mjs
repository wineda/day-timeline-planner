// ペットの演出モックを 1 枚の HTML にまとめる: node mock/build.mjs → mock/dist/pet-mock.html
import esbuild from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, "..");
const out = resolve(here, "dist");
mkdirSync(out, { recursive: true });

const result = await esbuild.build({
  entryPoints: [resolve(here, "pet-mock.ts")],
  bundle: true,
  write: false,
  format: "iife",
  target: "es2018",
  alias: { obsidian: resolve(here, "obsidian-shim.ts") },
  logLevel: "info",
});
const js = result.outputFiles[0].text;
const css = readFileSync(resolve(app, "styles.css"), "utf8") + "\n" + readFileSync(resolve(here, "mock.css"), "utf8");
const html =
  `<title>ペットの演出モック</title>\n<style>\n${css}\n</style>\n` +
  // body ができてからスクリプトを動かす（head の中で実行されると document.body が無い）
  `<div class="mock-root"></div>\n<script>\n${js.replace(/<\/script/g, "<\\/script")}\n</script>\n`;
writeFileSync(resolve(out, "pet-mock.html"), html);
console.log(`wrote ${resolve(out, "pet-mock.html")} (${(html.length / 1024).toFixed(0)} KB)`);
