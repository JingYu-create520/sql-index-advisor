import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Build the README terminal image from a real run.
 *
 * Every character inside the picture is captured stdout from `dist/cli.js`; this
 * script only adds terminal chrome and colour. Regenerate with
 * `node scripts/build-demo-image.mjs` after changing output wording, so the
 * screenshot can never show something the tool no longer prints.
 */

const CLI = "dist/cli.js";

// The frame is HTML, so an ANSI sequence would show up as literal "[39m" garbage.
// Colour is disabled in the child and stripped defensively afterwards.
const ESC = String.fromCharCode(27);
const stripAnsi = (text) => text.replace(new RegExp(ESC + "\\[[0-9;]*m", "g"), "");

// The CLI exits 1 when it reports findings at or above --fail-on; only 2 is a
// genuine failure.
function run(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    maxBuffer: 1 << 24,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", TERM: "dumb" },
  });
  if (r.status !== 0 && r.status !== 1) {
    throw new Error(`cli exited ${r.status}: ${r.stderr}`);
  }
  return stripAnsi(r.stdout);
}

const report = run([
  "examples/slow.log",
  "--schema",
  "examples/schema.json",
  "--top",
  "3",
  "--lang",
  "en",
]);

run([
  "examples/slow.log",
  "--schema",
  "examples/schema.json",
  "--emit-sql",
  "demo-migrations.sql",
  "--format",
  "json",
  "--lang",
  "en",
]);

const migration = readFileSync("demo-migrations.sql", "utf8")
  .split("\n")
  .filter((l) => /^ALTER TABLE|^-- SIA/.test(l))
  .slice(0, 8)
  .join("\n");

if (report.includes(ESC) || migration.includes(ESC)) {
  throw new Error("captured output still contains escape codes");
}

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const colorize = (line) =>
  esc(line)
    .replace(/\[error\]/g, '<span class="err">[error]</span>')
    .replace(/\[warn\]/g, '<span class="warn">[warn]</span>')
    .replace(/\[info\]/g, '<span class="info">[info]</span>')
    .replace(/^(\s+)evidence\b/, '$1<span class="dim">evidence</span>')
    .replace(/^(\s+)rewrite\b/, '$1<span class="lbl">rewrite</span>')
    .replace(/^(\s+)DDL\b/, '$1<span class="lbl">DDL</span>')
    .replace(/^(\s+)why\b/, '$1<span class="dim">why</span>')
    .replace(/^(ALTER TABLE .*)$/, '<span class="ddl">$1</span>')
    .replace(/^(-- SIA.*)$/, '<span class="dim">$1</span>');

const reportHtml = report.split("\n").map(colorize).join("\n");
const migrationHtml = migration.split("\n").map(colorize).join("\n");

// Rows that wrap add height the line count cannot see, so this is measured
// against the rendered image rather than trusted.
const logicalRows = report.split("\n").length + migration.split("\n").length;
const wrappedRows = report.split("\n").reduce((acc, l) => acc + Math.ceil(l.length / 118), 0)
  + migration.split("\n").length;
const height = Math.round(Math.max(wrappedRows, logicalRows) * 21 + 150);

const html = `<!doctype html>
<meta charset="utf-8">
<style>
  html,body{margin:0;background:#0d1117}
  .term{width:1180px;margin:10px auto;background:#0d1117;color:#e6edf3;
        font:14px/1.5 "Cascadia Mono",Consolas,"DejaVu Sans Mono",monospace;
        border:1px solid #30363d;border-radius:10px;overflow:hidden}
  .bar{background:#161b22;padding:10px 14px;border-bottom:1px solid #30363d;
       font:12.5px system-ui;color:#8b949e;display:flex;align-items:center;gap:8px}
  .dot{width:11px;height:11px;border-radius:50%;display:inline-block}
  .r{background:#ff5f56}.y{background:#ffbd2e}.g{background:#27c93f}
  pre{margin:0;padding:14px 18px 18px;white-space:pre-wrap;word-break:break-word}
  .err{color:#ff7b72;font-weight:700}.warn{color:#d29922}.info{color:#79c0ff}
  .lbl{color:#7ee787;font-weight:700}.dim{color:#8b949e}.ddl{color:#f2cc60}
  .cmd{color:#a5d6ff}
</style>
<div class="term">
  <div class="bar">
    <span class="dot r"></span><span class="dot y"></span><span class="dot g"></span>
    <span>sia &mdash; offline MySQL / MyBatis index advisor &middot; no API key</span>
  </div>
  <pre><span class="cmd">$ sia examples/slow.log --schema examples/schema.json --top 3</span>
${reportHtml}
<span class="cmd">$ sia examples/slow.log --schema examples/schema.json --emit-sql add-indexes.sql</span>
${migrationHtml}</pre>
</div>`;

writeFileSync(resolve("demo-terminal.html"), html);

const edge = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const shot = spawnSync(edge, [
  "--headless",
  "--disable-gpu",
  "--hide-scrollbars",
  "--force-device-scale-factor=2",
  `--window-size=1200,${height}`,
  `--screenshot=${resolve("docs/assets/terminal-demo.png")}`,
  `file:///${resolve("demo-terminal.html").replace(/\\/g, "/")}`,
], { encoding: "utf8" });

if (shot.error) throw shot.error;
console.log(`height ${height}px; ${shot.stderr.split("\n").filter(Boolean).slice(-1)[0] ?? "clean"}`);
