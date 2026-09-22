import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Ask a real MySQL whether the rewrites this tool prints are the same predicate.
 *
 * A unit test can prove the emitted text has the right shape; only a server can
 * prove `create_time >= '2026-09-17' AND create_time < '2026-09-18'` selects the
 * rows `DATE(create_time) = '2026-09-17'` selects. Two defects were found this way
 * and neither was visible in the suite: SIA006's deferred join failed to parse at
 * all (ambiguous `ON id`), and SIA004 turned `LEFT(code, 3) = 123` into
 * `code LIKE '2%'` by cutting quote characters from something that had none - that
 * one ran, and quietly returned different rows.
 *
 *   docker run -d --name sia-mysql -e MYSQL_ROOT_PASSWORD=sia -e MYSQL_DATABASE=demo mysql:8.0
 *   node scripts/verify-rewrites.mjs
 *
 * Exits non-zero when a rewrite is not row-equivalent, so it can be run as a check.
 * It writes nothing outside the scratch database `sia_rewrite_check`.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTAINER = process.env.SIA_CONTAINER ?? "sia-mysql";
const MYSQL_USER = process.env.SIA_MYSQL_USER ?? "-uroot";
const MYSQL_PASSWORD = process.env.SIA_MYSQL_PASSWORD ?? "-psia";
const CLI = join(HERE, "..", "dist", "cli.js");
const FIXTURE = join(HERE, "verify-rewrites.sql");

/** Predicates SIA004 is supposed to reason about, each on the scratch table. */
const CASES = [
  "DATE(create_time) = '2026-09-17'",
  "DATE(create_time) = '2026-09-17 13:00:00'",
  "YEAR(create_time) = 2026",
  "YEAR(create_time) = '2026'",
  "DATE(create_time) = code2",
  "YEAR(create_time) = 'not-a-year'",
  "LEFT(code, 3) = '123'",
  "LEFT(code, 2) = 'a%'",
  "LEFT(code, 3) = 123",
  "LEFT(code, 3) = code2",
  "amount + 1 = 5",
  "amount - 2 > 10",
  "amount + 1 != 5",
];

const DB = "sia_rewrite_check";

/** `database: null` runs without a selected database, for CREATE/DROP and the fixture. */
function mysql(sql, database = DB) {
  return execFileSync(
    "docker",
    [
      "exec", "-i", CONTAINER, "mysql", MYSQL_USER, MYSQL_PASSWORD,
      ...(database ? [`--database=${database}`] : []),
      "--skip-column-names",
    ],
    { encoding: "utf8", input: sql },
  );
}

function rewriteFor(predicate) {
  const sql = `SELECT k FROM t WHERE ${predicate}`;
  let stdout = "";
  try {
    stdout = execFileSync(process.execPath, [CLI, "query", sql, "--format", "json"], { encoding: "utf8" });
  } catch (err) {
    // exit 1 means "there are findings", which is the normal case here
    stdout = String(err.stdout ?? "");
  }
  const report = JSON.parse(stdout.slice(stdout.indexOf("{")));
  return report.findings.find((f) => f.rule === "SIA004")?.rewrite;
}

/**
 * `lost` and `gained` count rows one side takes and the other does not. COALESCE
 * is load-bearing: with a NULL predicate, `NOT (…)` is NULL rather than TRUE, and
 * the difference would be invisible.
 */
function comparison(left, right) {
  return `SELECT COUNT(*) FROM (SELECT k FROM t WHERE (${left})) AS a
            WHERE NOT EXISTS (SELECT 1 FROM (SELECT k FROM t WHERE (${right})) AS b WHERE b.k = a.k);`;
}

const rows = [];
mysql(`CREATE DATABASE IF NOT EXISTS ${DB};`, null);
mysql(readFileSync(FIXTURE, "utf8"), null);

for (const predicate of CASES) {
  let rewrite;
  try {
    rewrite = rewriteFor(predicate);
  } catch (err) {
    rows.push({ predicate, rewrite: "(unreadable report)", verdict: `FAILED: ${String(err.message).split("\n")[0]}` });
    continue;
  }
  if (typeof rewrite !== "string") {
    rows.push({ predicate, rewrite: "(no rewrite)", verdict: "skipped: nothing to execute" });
    continue;
  }
  // A template containing `?` is for a human to bind, not for a server to run.
  if (rewrite.includes("?")) {
    rows.push({ predicate, rewrite, verdict: "skipped: parameterised template" });
    continue;
  }
  try {
    // Row identity, not row count: two predicates can return the same number of
    // rows and not the same rows.
    const lost = Number(mysql(comparison(predicate, rewrite)).trim());
    const gained = Number(mysql(comparison(rewrite, predicate)).trim());
    rows.push({
      predicate,
      rewrite,
      verdict: lost === 0 && gained === 0 ? "equivalent" : `DIFFERENT: ${lost} row(s) lost, ${gained} gained`,
    });
  } catch (err) {
    rows.push({ predicate, rewrite, verdict: `FAILED on the server: ${String(err.stderr ?? err.message).split("\n")[0]}` });
  }
}

const width = Math.max(...rows.map((r) => r.predicate.length));
for (const row of rows) {
  console.log(`${row.predicate.padEnd(width)}  ->  ${row.rewrite}`);
  console.log(`${" ".repeat(width)}      ${row.verdict}`);
}

const bad = rows.filter((r) => /^(DIFFERENT|FAILED)/.test(r.verdict));
mysql(`DROP DATABASE IF EXISTS ${DB};`, null);
if (bad.length > 0) {
  console.log(`\n${bad.length} rewrite(s) are not equivalent on this server.`);
  process.exit(1);
}
console.log(`\n${rows.length} predicates checked against a live server, none changed the result set.`);
