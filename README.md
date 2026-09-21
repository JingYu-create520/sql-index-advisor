# sql-index-advisor

[![CI](https://img.shields.io/github/actions/workflow/status/JingYu-create520/sql-index-advisor/ci.yml?branch=main&label=CI)](https://github.com/JingYu-create520/sql-index-advisor/actions/workflows/ci.yml) [![release v0.1.1](https://img.shields.io/github/v/tag/JingYu-create520/sql-index-advisor?label=release)](https://github.com/JingYu-create520/sql-index-advisor/releases/tag/v0.1.1) [![license MIT](https://img.shields.io/github/license/JingYu-create520/sql-index-advisor)](LICENSE)

**Offline index advisor for MySQL / MyBatis. Slow query log in, index recommendations and migration SQL out.**

![Terminal output: three findings with rule IDs, evidence SQL, a rewrite and the emitted migration file](docs/assets/terminal-demo.png)

Every conclusion comes from a deterministic rule: reproducible, unit-tested, no API key. The LLM is an optional layer over the explanation text only. It cannot add, remove or re-rank a finding.

<details>
<summary>Same output as text (copy-pasteable)</summary>

```console
$ sia examples/slow.log --schema examples/schema.json

6 suggestions  4 error  2 warn  0 info  · 5 query fingerprints covered

 1 [error] SIA004 Function or expression on an indexed column orders · examples/slow.log:26 · 7.441s · 4,120,933 rows
   evidence SELECT id, user_id, amount FROM orders WHERE DATE(create_time) = '2026-09-17' LIMIT 100…
   rewrite create_time >= '2026-09-17 00:00:00' AND create_time < '2026-09-18 00:00:00'
   DDL     ALTER TABLE `orders` ADD INDEX `idx_orders_create_time` ((DATE(create_time)));

 2 [error] SIA001 Missing index candidate user_address · examples/slow.log:36 · 5.001s · 2,881,004 rows
   evidence SELECT u.id, u.name, u.mobile FROM users u LEFT JOIN user_address a ON a.user_id = u.id…
   DDL     ALTER TABLE `user_address` ADD INDEX `idx_user_address_city_user_id` (`city`, `user_id`);

Review every suggestion before running it; this tool never touches the database.

$ sia examples/slow.log --schema examples/schema.json --emit-sql add-indexes.sql
-- SIA001 Missing index candidate · error · 903,112 rows scanned
ALTER TABLE `order_item` ADD INDEX `idx_order_item_order_id` (`order_id`);
-- SIA004 Function or expression on an indexed column · error · 4,120,933 rows scanned
ALTER TABLE `orders` ADD INDEX `idx_orders_create_time` ((DATE(create_time)));
-- SIA001 Missing index candidate · error · 1,330,921 rows scanned
ALTER TABLE `orders` ADD INDEX `idx_orders_shop_id_create_time` (`shop_id`, `create_time`);
-- SIA001 Missing index candidate · warn · 2 occurrences · 1,842,930 rows scanned
ALTER TABLE `orders` ADD INDEX `idx_orders_user_id_status_create_time` (`user_id`, `status`, `create_time`);
```

</details>

Each line carries a rule ID, the SQL it was judged from, and a DDL you can read before running it. If you do not like an answer, you can trace which condition produced it.

中文文档见 [README.zh-CN.md](README.zh-CN.md)。

---

## Compared with asking an LLM

Advice you cannot reproduce is advice nobody can sign off on, which is the gap this tool is for.

| | Ask a chat model | sql-index-advisor |
|---|---|---|
| Knows your existing indexes | No | Yes, with `schema.json` |
| Same input → same output | Not guaranteed | Yes, locked by tests |
| Runs with no network / no key | No | Yes, that is the default |
| Verifiable per-suggestion | "trust me" | rule ID + evidence + DDL |
| Fits a CI gate | No | Yes, exit codes + PR annotations |

Put an endpoint behind `--llm` and it rewrites only the explanation prose. A test asserts the finding set is byte-for-byte identical with and without it.

## Install

Distributed straight from GitHub; there is no npm package to install.

```bash
# once, globally; the command is `sia`
npm i -g github:JingYu-create520/sql-index-advisor

# or run without installing
npx --yes --package github:JingYu-create520/sql-index-advisor sia -- --help
```

Requires Node.js ≥ 18. Four runtime dependencies, no native builds. The install
builds the bundle from source via npm's `prepare` hook, so a tagged release is
all the repository has to ship.

## 30-second quickstart

```bash
# 1. A slow query log, ranked by real cost
sia /var/log/mysql/slow.log

# 2. One statement, before you ship it
sia query "SELECT * FROM orders WHERE user_id=1 ORDER BY create_time DESC LIMIT 20"

# 3. Whole MyBatis project, plus a migration file you can review
sia mapper src/main/resources/mapper --emit-sql migrations.sql

# 4. Machine-readable, for an agent or a script
sia examples/slow.log --format json
```

### Getting a `schema.json`

The rules that compare your query against existing indexes are the precise ones, and they need this file. The tool does not connect to your database, so you produce it with one query over `information_schema` (verified against a live MySQL 8.0.46):

```bash
mysql --database=your_db --raw --skip-column-names < examples/schema-dump.sql > schema.json
sia slow.log --schema schema.json
```

Without it, `SIA002`, `SIA003`, `SIA005` and `SIA007` stay silent and the report says why. Silence is never rendered as all-clear.

### The whole loop, on a real server

`examples/seed-schema.sql` builds a deliberately under-indexed database (200k orders, 400k order items) so the advice has something to bite on:

```bash
docker run -d --name sia-mysql -e MYSQL_ROOT_PASSWORD=sia -e MYSQL_DATABASE=demo \
  -p 13307:3306 mysql:8.0
docker exec -i sia-mysql mysql -uroot -psia demo < examples/seed-schema.sql
docker exec -i sia-mysql mysql --raw --skip-column-names -uroot -psia demo \
  < examples/schema-dump.sql > schema.json

sia query "SELECT * FROM orders WHERE user_id=42 AND status='PAID' ORDER BY create_time DESC LIMIT 20" \
    --schema schema.json --emit-sql add-indexes.sql
docker exec -i sia-mysql mysql -uroot -psia demo < add-indexes.sql
docker exec sia-mysql mysql -uroot -psia demo -e \
  "EXPLAIN SELECT * FROM orders WHERE user_id=42 AND status='PAID' ORDER BY create_time DESC LIMIT 20\G"
```

Before the recommended index, `EXPLAIN` falls back to the partial `idx_user_pay`, estimates 23 rows and reports `Using filesort`. With `(user_id, status, create_time)` it estimates 1 row and the filesort is gone.

## Rules

| ID | Name | Needs | What it catches |
|---|---|---|---|
| SIA001 | Missing index candidate | — | No usable index for the access path; orders columns **equality → sort/group → range** |
| SIA002 | Prefix index | schema | Long `VARCHAR` / `TEXT` in predicates, budget computed **in bytes** (not the utf8mb3-era "255" rule) |
| SIA003 | Leftmost-prefix violation | schema | Query skips an index middle column; invisible in `EXPLAIN`'s `key`, visible in `key_len` |
| SIA004 | Function on an indexed column | — | `DATE(create_time) = ?` → half-open range rewrite, and a functional-index option on 8.0 |
| SIA005 | Implicit type conversion | schema | `varchar_col = 123`, the direction that actually breaks the index |
| SIA006 | Deep pagination | — | Literal `LIMIT 100000, 20` → deferred join and keyset rewrite |
| SIA007 | Covering index opportunity | schema + slow log | High `Rows_examined`, narrow projection → index extension that removes the lookup |

Full reasoning, false-positive boundaries and examples for each: **[docs/rules.md](docs/rules.md)** (中文). The decisions behind the shape of the tool are in [docs/DESIGN-NOTES.md](docs/DESIGN-NOTES.md).

## Output formats

| Flag | Use |
|---|---|
| `--format table` | human terminal output (`--lang en\|zh\|auto`) |
| `--format json` | stable schema for agents and scripts |
| `--format github` | workflow commands, turned into line-level PR annotations |
| `--emit-sql migrations.sql` | deduplicated `ALTER TABLE ... ADD INDEX`, grouped by table |

Other flags: `--min-severity warn` · `--fail-on error` · `--top 20` · `--mysql-version 5.7` · `--prefix-bytes 3072` · `--deep-offset 10000` · `--rules SIA001,SIA004` · `--llm`.

Exit codes: `0` nothing at or above `--fail-on` · `1` findings at or above it · `2` runtime error. `--fail-on` defaults to `error`, so adopting this on day one does not turn your build red.

## Use it from an AI coding agent

**MCP server**: add to `claude_desktop_config.json`, Qoder's MCP settings, or `.cursor/mcp.json`. After the global install above, the short form is:

```json
{
  "mcpServers": {
    "sql-index-advisor": {
      "command": "sia",
      "args": ["mcp"]
    }
  }
}
```

To run it without a global install, use `command: "npx"` with
`args: ["--yes", "--package", "github:JingYu-create520/sql-index-advisor", "sia", "--", "mcp"]`,
or from a checkout: `command: "node"`, `args: ["dist/mcp.js"]`.

Four tools: `analyze_sql`, `analyze_slow_log`, `analyze_mapper`, `explain_rules`. Every tool accepts an inline `schema` (JSON text or a path), so an agent with no filesystem access still gets schema-accurate advice.

**Agent Skill**: `skills/sql-index-advisor/SKILL.md` teaches an agent when to call the CLI, how to read `Finding`, and the rules it must not break: never execute DDL, always carry the rule ID, always surface `skipped`.

**GitHub Action**: annotations on the changed lines:

```yaml
- uses: JingYu-create520/sql-index-advisor@v0
  with:
    path: src/main/resources/mapper
    schema: schema.json        # optional but much more precise
    min-severity: warn
    fail-on: "off"             # error  => gate the PR
```

Full example workflow: [`examples/github-action/pr-review.yml`](examples/github-action/pr-review.yml).

## The LLM layer (optional, no say over conclusions)

```bash
export SIA_LLM_BASE_URL=https://api.openai.com/v1   # any OpenAI-compatible endpoint
export SIA_LLM_API_KEY=sk-...
export SIA_LLM_MODEL=gpt-4o-mini
sia slow.log --llm
```

Off by default: no key, no network, deterministic text. When on, the endpoint is only asked for operational commentary ("verify the write rate before adding this"), which lands in `finding.llmNote`. Timeouts and 5xx errors fall back to the built-in template, so a flaky endpoint cannot break a CI gate.

## What this tool does not do

- It does not connect to your database. No `EXPLAIN`, no live statistics, only file analysis, which is what lets it run in a sandboxed CI job. A `--explain` mode is planned for v2.
- It does not execute anything. It writes `ALTER TABLE` text into a file for a human to review, and it never emits `DROP`.
- It does not decide for you. An index is a write-amplification call with business context attached.
- It does not do PostgreSQL or other dialects.
- It prefers silence to guessing. Known gaps, listed rather than papered over:
  - `LIMIT #{offset}, #{size}` in a Mapper carries no static value, so SIA006 cannot judge it. Feed it a slow log instead.
  - `mobile = ?` bound to a Java `Long`: SIA005 cannot see the parameter type.
  - Correlated subqueries are not expanded. SIA006 degrades to a template rather than risk a rewrite that changes the result set.

Supported SQL subset: single `SELECT` / `INSERT` / `UPDATE` / `DELETE`, ANSI and comma joins, `WHERE` with `=`, `IN`, ranges, `BETWEEN`, prefix `LIKE`, `IS NULL`, `GROUP BY`, `ORDER BY`, `LIMIT`. Anything outside it is skipped with an `info` note. It does not crash, and it does not invent a recommendation.

## Where it got it wrong

Each item below is advice this tool really emitted on real SQL, and each one was wrong. Publishing them is cheaper than letting you find them yourself.

**Two indexes where one covers both.** `WHERE sku_id = ?` in one query and `WHERE sku_id = ? AND warehouse_id = ?` in another used to produce `(sku_id)` and `(sku_id, warehouse_id)` on the same table. The narrow one is a left prefix of the wide one, so it buys no coverage and only adds write cost. The engine now runs a redundancy pass after ranking: the narrower suggestion is dropped and the survivor states what it absorbed (`It also serves 3 other queried access path(s) on this table.`). See `drops a narrower index that the wider one already serves` in `tests/engine.test.ts`, plus a corpus-wide invariant that no two emitted suggestions in a run are prefixes of each other.

**An index on a boolean flag.** `WHERE enabled = 0` used to yield `ADD INDEX (enabled)`. On a two-valued column over millions of rows the optimizer will not consider it, and suggestions like that are the reason people uninstall advisors. A lone flag column (`tinyint`/`bit`/`bool` by type, or a name matching `is_`, `has_`, `enabled`, `deleted`, `synced`, `status`, `type`, and a few more) is still reported, because a rare-and-hot flag is legitimate, but it is capped at `info` and arrives with the check to run first:

```sql
SELECT COUNT(DISTINCT enabled) / COUNT(*) FROM stock;
```

A flag inside a composite is not penalised. `(sku_id, synced)` is a fine index, since `sku_id` carries the selectivity. Both halves of that distinction are pinned by tests.

**A column that does not exist.** `SELECT SUM(amount) AS gmv ... ORDER BY gmv` asked to index `gmv`, which is an output alias and not a column at all. Separately `WHERE amount > 1e999` produced an index on a column named `e999`, because the tokenizer read a scientific-notation literal as a number followed by an identifier. Both fixed; the `e999` one was found by the generated corpus rather than by a hand-written test, which is the argument for the corpus.

**The same query counted twice.** Signed literals were not masked during normalization, so `-1` and `1` split one query pattern into two fingerprints. That halved its recorded `Rows_examined` and pushed it down the ranking, meaning the tool hid its own worst offender. Fingerprint stability across literal values, signs and `IN (...)` lengths is now an asserted property.

**The two languages disagreed.** The Chinese message warns that an existing index covers only a left prefix of the proposed one and should be evaluated for removal; the English field for that same finding said, flatly, "no existing index serves this access path." One branch of the code never got the caveat translated, so JSON and MCP consumers, which read `messageEn`, received a false all-clear. The English text now mirrors the same three branches as the Chinese one, and a test asserts the prefix caveat shows up in both:

```
warn  SIA001  Candidate index for orders (user_id, shop_id), ordered equality -> group/order -> range;
      only a contiguous run from the first column can be used. Existing index idx_user(user_id, pay_time)
      covers only a left prefix of the proposed one; evaluate dropping it once the new index is live.
```

**What none of this fixes.** Flag detection reads names and column types, never data. A `status` column with 40 distinct values gets the same caution as a 2-valued one, and a genuinely skewed 2-valued column gets the same caution as a uniform one. The obvious upgrade, reading the database's own statistics, was measured and rejected: `information_schema.STATISTICS.CARDINALITY` reported 1 for a column with 2 distinct values, both before and after `ANALYZE TABLE`, and 42 for the primary key of a table that had just been loaded with 100,000 rows. It estimates per index prefix, and low-cardinality columns are where it is worst. The only source that gets it right, `information_schema.COLUMN_STATISTICS`, is 8.0-only and empty until someone runs `ANALYZE TABLE ... UPDATE HISTOGRAM` on that specific column. Full numbers in [docs/rules.md](docs/rules.md). So the gap stays, and it is closed per finding by the selectivity query printed next to the suggestion.

## What has not been verified

- `examples/schema-dump.sql` is confirmed against a live MySQL 8.0.46. It has never been run on 5.7; `--mysql-version 5.7` only changes the DDL text this tool emits, it is not evidence about a 5.7 server.
- The GitHub Action's annotation strings are asserted locally. The Action has not run as a status check on anyone's pull request.
- The MCP server answers a real stdio `initialize` → `tools/list` → `tools/call` handshake in tests. It has not been configured inside a specific desktop client.

If you hit one of these, an issue containing the exact command you ran is worth more to this project than a star.

## Development

```bash
npm ci
npm run typecheck     # tsc --noEmit, strict + noUncheckedIndexedAccess
npm test              # vitest: parsers, 7 rules, engine, reports, MCP (incl. a real stdio handshake)
npm run build         # tsup -> dist/
node dist/cli.js examples/slow.log
```

207 tests. Beyond hand-written cases, `tests/fuzz.test.ts` generates about 1,200 statements plus a list of deliberately malformed ones and asserts the properties that must hold for any input: never throw, never index a column that does not exist, never propose an index another already covers, and produce byte-identical output on repeated runs. That suite is what caught the tokenizer reading `1e999` as `1` plus a column named `e999`, and signed literals splitting one query pattern into two fingerprints. Fixtures under `tests/fixtures/` are real-shaped MySQL 8.0 logs, including a messy one with administrator commands, multi-line statements and an unterminated tail.

## License

MIT, see [LICENSE](LICENSE).

## More from this author

- spring-review: the same idea for Spring transaction pitfalls, N+1 and `${}` injection in MyBatis XML.
