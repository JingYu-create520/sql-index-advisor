# sql-index-advisor

**Offline index advisor for MySQL / MyBatis. Slow query log in, index recommendations and migration SQL out.**

Deterministic rules produce every conclusion — reproducible, unit-tested, and **no API key required**. The LLM is an optional layer that polishes the explanation text; it can never add, remove or re-rank a finding.

```console
$ npx sql-index-advisor examples/slow.log --schema examples/schema.json

6 suggestions  4 error  2 warn  0 info  · 5 query fingerprints covered

 1 [error] SIA004 Function or expression on an indexed column orders · examples/slow.log:26 · 7.441s · 4,120,933 rows
   evidence SELECT id, user_id, amount FROM orders WHERE DATE(create_time) = '2026-09-17' LIMIT 100…
   rewrite create_time >= '2026-09-17 00:00:00' AND create_time < '2026-09-18 00:00:00'
   DDL     ALTER TABLE `orders` ADD INDEX `idx_orders_create_time` ((DATE(create_time)));

 2 [error] SIA001 Missing index candidate user_address · examples/slow.log:36 · 5.001s · 2,881,004 rows
   evidence SELECT u.id, u.name, u.mobile FROM users u LEFT JOIN user_address a ON a.user_id = u.id…
   DDL     ALTER TABLE `user_address` ADD INDEX `idx_user_address_city_user_id` (`city`, `user_id`);

Review every suggestion before running it; this tool never touches the database.
```

Every line above carries a **rule ID**, the **evidence SQL**, and a **DDL you can read and verify**. That is the whole design: no black box.

中文文档见 [README.zh-CN.md](README.zh-CN.md)。

---

## Why not just ask an LLM?

Because you cannot review what you cannot reproduce.

| | Ask a chat model | sql-index-advisor |
|---|---|---|
| Knows your existing indexes | No | Yes, with `schema.json` |
| Same input → same output | Not guaranteed | Yes, locked by tests |
| Runs with no network / no key | No | Yes, that is the default |
| Verifiable per-suggestion | "trust me" | rule ID + evidence + DDL |
| Fits a CI gate | No | Yes, exit codes + PR annotations |

Put an endpoint behind `--llm` and it rewrites only the explanation prose. A test asserts the finding set is byte-for-byte identical with and without it.

## Install

```bash
npx sql-index-advisor examples/slow.log          # no install needed
npm i -g sql-index-advisor                        # or install; binary is `sia`
```

Requires Node.js ≥ 18. Four runtime dependencies, no native builds.

## 30-second quickstart

```bash
# 1. A slow query log, ranked by real cost
npx sql-index-advisor /var/log/mysql/slow.log

# 2. One statement, before you ship it
npx sql-index-advisor query "SELECT * FROM orders WHERE user_id=1 ORDER BY create_time DESC LIMIT 20"

# 3. Whole MyBatis project, plus a migration file you can review
npx sql-index-advisor mapper src/main/resources/mapper --emit-sql migrations.sql

# 4. Machine-readable, for an agent or a script
npx sql-index-advisor examples/slow.log --format json
```

### Get a `schema.json` (this is what unlocks precision)

The tool never connects to your database. Dump the schema yourself with one query — pure `information_schema`, works on MySQL 5.7 and 8.0:

```bash
mysql --database=your_db --raw --skip-column-names < examples/schema-dump.sql > schema.json
npx sql-index-advisor slow.log --schema schema.json
```

Without it, rules that depend on existing indexes (`SIA002`, `SIA003`, `SIA005`, `SIA007`) stay silent and the report tells you so. **Silence is never reported as "all clear."**

## Rules

| ID | Name | Needs | What it catches |
|---|---|---|---|
| SIA001 | Missing index candidate | — | No usable index for the access path; orders columns **equality → sort/group → range** |
| SIA002 | Prefix index | schema | Long `VARCHAR` / `TEXT` in predicates, budget computed **in bytes** (not the utf8mb3-era "255" rule) |
| SIA003 | Leftmost-prefix violation | schema | Query skips an index middle column — invisible in `EXPLAIN`'s `key`, visible in `key_len` |
| SIA004 | Function on an indexed column | — | `DATE(create_time) = ?` → half-open range rewrite; 8.0 also gets a functional-index option |
| SIA005 | Implicit type conversion | schema | `varchar_col = 123` (the direction that actually breaks the index) |
| SIA006 | Deep pagination | — | Literal `LIMIT 100000, 20` → deferred join **and** keyset rewrite |
| SIA007 | Covering index opportunity | schema + slow log | High `Rows_examined`, narrow projection → index extension that removes 回表 |

Full reasoning, false-positive boundaries and examples for each: **[docs/rules.md](docs/rules.md)** (中文).

## Output formats

| Flag | Use |
|---|---|
| `--format table` | human terminal output (`--lang en\|zh\|auto`) |
| `--format json` | stable schema for agents and scripts |
| `--format github` | workflow commands → line-level PR annotations |
| `--emit-sql migrations.sql` | deduplicated `ALTER TABLE ... ADD INDEX`, grouped by table |

Other flags: `--min-severity warn` · `--fail-on error` · `--top 20` · `--mysql-version 5.7` · `--prefix-bytes 3072` · `--deep-offset 10000` · `--rules SIA001,SIA004` · `--llm`.

**Exit codes**: `0` nothing at or above `--fail-on` · `1` findings at or above it · `2` runtime error. Default `--fail-on error`, so adopting this on day one does not turn your build red.

## Use it from an AI coding agent

**MCP server** — add to `claude_desktop_config.json`, Qoder's MCP settings, or `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "sql-index-advisor": {
      "command": "npx",
      "args": ["-y", "sql-index-advisor", "mcp"]
    }
  }
}
```

Four tools: `analyze_sql`, `analyze_slow_log`, `analyze_mapper`, `explain_rules`. From a local checkout, use `command: "node"` with `args: ["dist/mcp/index.js"]` (or the `sia-mcp` bin).

**Agent Skill** — `skills/sql-index-advisor/SKILL.md` teaches an agent when to call the CLI, how to read `Finding`, and the rules it must not break (never execute DDL, always carry the rule ID, always surface `skipped`).

**GitHub Action** — annotations on the changed lines:

```yaml
- uses: JingYu-creates20/sql-index-advisor@v0
  with:
    path: src/main/resources/mapper
    schema: schema.json        # optional but much more precise
    min-severity: warn
    fail-on: "off"             # error  => gate the PR
```

Full example workflow: [`examples/github-action/pr-review.yml`](examples/github-action/pr-review.yml).

## The LLM layer (optional, non-decision-making)

```bash
export SIA_LLM_BASE_URL=https://api.openai.com/v1   # any OpenAI-compatible endpoint
export SIA_LLM_API_KEY=sk-...
export SIA_LLM_MODEL=gpt-4o-mini
npx sql-index-advisor slow.log --llm
```

Off by default: no key, no network, deterministic text. When on, the endpoint is only asked for operational commentary ("verify the write rate before adding this"), which lands in `finding.llmNote`. Timeouts and 5xx errors fall back to the built-in template, so a flaky endpoint cannot break a CI gate.

## What this tool deliberately does not do

- **Never connects to your database.** No `EXPLAIN`, no live statistics. Read-only file analysis, so it can run in a sandboxed CI job. (A `--explain` mode is planned for v2.)
- **Never executes anything.** It writes `ALTER TABLE` text into a file for a human to review. It never emits `DROP`.
- **No auto-indexing.** An index is a write-amplification decision with business context; that decision stays with you.
- **MySQL only.** No PostgreSQL or other dialects.
- **Prefers silence to guessing.** Known gaps, documented rather than papered over:
  - `LIMIT #{offset}, #{size}` in a Mapper carries no static value → SIA006 cannot judge it. Feed it a slow log instead.
  - `mobile = ?` bound to a Java `Long` → SIA005 cannot see the parameter type.
  - Correlated subqueries are not expanded; SIA006 degrades to a template rather than risk a rewrite that changes the result set.

Supported SQL subset: single `SELECT` / `INSERT` / `UPDATE` / `DELETE`, ANSI and comma joins, `WHERE` with `=`, `IN`, ranges, `BETWEEN`, prefix `LIKE`, `IS NULL`, `GROUP BY`, `ORDER BY`, `LIMIT`. Anything outside it is skipped with an `info` note — never a crash, never a fabricated recommendation.

## Development

```bash
npm ci
npm run typecheck     # tsc --noEmit, strict + noUncheckedIndexedAccess
npm test              # vitest: parsers, 7 rules, engine, reports, MCP (incl. a real stdio handshake)
npm run build         # tsup -> dist/
node dist/cli.js examples/slow.log
```

185 tests. Fixtures under `tests/fixtures/` are real-shaped MySQL 8.0 logs, including a messy one with administrator commands, multi-line statements and an unterminated tail.

## License

MIT — see [LICENSE](LICENSE).

## More from this author

- **spring-review** — the same idea for Spring transaction pitfalls, N+1 and `${}` injection in MyBatis XML.
