# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Fixed

- **GitHub Action gate step**: exit code `2` (the tool could not run — bad path,
  unreadable input) was reported exactly like `1` (findings at or above
  `--fail-on`), and because Actions executes `run:` blocks under `bash -e` the
  explanatory `::error::` line never reached the log. Each case now prints its
  own reason. Verified against the built CLI: `0` quiet, `1` findings, `2`
  missing file.
- **Action install snippet** in both READMEs and `examples/github-action/`
  referenced a repository owner that does not exist, so the documented
  `uses: …@v0` line could not resolve.

### Added

- README: "Where it got it wrong" — the four concrete false positives this tool
  emitted during development (prefix-redundant pairs, single-column indexes on
  boolean flags, a `SELECT` alias indexed as a column, one query pattern split
  into two fingerprints), what each one does now, and which test pins it. Plus
  "What has not been verified", listing MySQL 5.7, the Action on a real PR, and
  MCP inside a client.

## 0.1.0 — 2026-09-20

First release. Core premise: index advice you can verify — every finding carries
a rule ID, the evidence SQL, and a DDL a human can read before running it.

### Added

- **Parsers** (hand-written, no SQL-parser dependency):
  - `slowlog` — MySQL 5.7/8.0 slow query log reader that aggregates events by SQL
    fingerprint, so a pattern repeated 400 times ranks as one item by total cost
    instead of flooding the report.
  - `sql` — statement analyser for the documented subset: tables and aliases,
    ANSI/comma joins with `ON` predicates, `WHERE` equality / `IN` / ranges /
    `BETWEEN` / prefix `LIKE` / `IS NULL`, `GROUP BY`, `ORDER BY` with direction,
    `LIMIT` (literal vs placeholder), projections and `SELECT` aliases.
  - `mapper` — MyBatis XML reader keeping `<select id>` **line numbers**, with
    `#{}`/`${}` normalisation, `<include>` inlining, `<foreach>` collapsing,
    `<where>/<set>/<trim>` handling, `&lt;` entities, CDATA, and recursive
    `<choose>` expansion into statement variants.
  - `fingerprint` — comment stripping, literal masking, `IN (…)` list folding.
- **Rules SIA001–SIA007**: missing index candidate, prefix index, leftmost-prefix
  violation, function/expression on an indexed column, implicit type conversion,
  deep pagination, covering index opportunity. Composite index order is
  equality → group/order → range, because a range predicate stops later columns
  from serving equality lookups or sorting.
- **Rule engine** with input-dependency gating: rules declare `needsSchema` and
  `needsMetrics`, and every skipped rule is reported with the reason — silence is
  never rendered as "all clear". A throwing rule is contained and surfaced.
- **Reports**: coloured terminal table (`--lang auto|zh|en`), stable JSON, GitHub
  workflow annotations with `file`/`line`/`title`, and `--emit-sql` migration
  output that deduplicates identical DDL and never emits `DROP`.
- **LLM layer** (`--llm`): default offline `mock` provider plus any
  OpenAI-compatible endpoint via `SIA_LLM_BASE_URL` / `SIA_LLM_API_KEY` /
  `SIA_LLM_MODEL`. Endpoint failures fall back to offline text. Tests lock that
  enabling it cannot change the finding set.
- **Four delivery forms**: CLI (`sia`), MCP stdio server (`sia mcp`, `sia-mcp`)
  exposing `analyze_sql` / `analyze_slow_log` / `analyze_mapper` /
  `explain_rules`, an Agent Skill, and a composite GitHub Action.
- **Exit codes**: `0` clean, `1` findings at or above `--fail-on` (default
  `error`), `2` runtime error — so first-time adoption does not turn a green
  build red.
- `examples/schema-dump.sql` — pure `information_schema` query to produce
  `schema.json` without the tool ever connecting to a database.
- Test suite: 206 tests, including an adversarial corpus (~1,200 generated statements plus malformed input) asserting the invariants that must hold for any input: no crash, no index on a non-existent column, no prefix-redundant advice, byte-identical output on repeat runs. Covering parser snapshots, one positive and one negative
  case per rule, degradation on malformed input, report formats, and a real
  stdio JSON-RPC handshake against the built MCP bundle.
- Docs: bilingual README and `docs/rules.md` recording each rule's trigger,
  reasoning and known false-positive boundary.

### Fixed

- **SIA001 recommended redundant indexes.** Run against a second, real codebase, six
  suggestions came back of which two were strictly narrower than others on the same
  table (`(sku_id)` alongside `(sku_id, warehouse_id)`). The engine now drops a
  proposal that is a left prefix of another and records the coverage on the survivor.
- **SIA001 treated a lone boolean/flag column as ordinary advice** — the classic
  low-selectivity index. Such suggestions are capped at `info` and carry the
  distinct-value query to run first.
- **`schema-dump.sql` emitted invalid JSON**: `CAST(... AS JSON)` sat inside a
  `CONCAT`, so it was concatenated as literal text instead of evaluated. Found by
  running the query against MySQL 8.0.46.
- **The loader rejected the output of its own dump script.** `information_schema`
  returns explicit `null` for `length` / `charset` on non-string columns, and
  `.optional()` accepts a missing key but not a null one. Optional metadata now
  accepts both, and the live dump is kept as a test fixture.
- `workspaceRelative` treated a backslash as a separator on every platform, breaking
  workspace-relative PR annotations on Linux runners.
- The tokenizer split `1e999` into the number `1` plus a word token `e999`, so the
  parser read `e999` as a column name and could propose indexing it. Scientific
  notation without a sign is now consumed as one number.
- Signed literals were not folded into a single placeholder: `a = -3` masked to
  `a=-?` while `a = 3` gave `a=?`, splitting one query pattern across two
  fingerprints and weakening exactly the aggregation the slow-log report depends
  on. `+7` had the same defect.
- The CI smoke step inherited the runner's `bash -e`, so the CLI's legitimate exit
  code 1 killed the step before it could be judged — and its assertions lacked
  `|| exit 1`, so a broken check could have passed silently.

### Verified against a live database

MySQL 8.0.46 in Docker, seeded with `examples/seed-schema.sql`: the dump produces a
valid `schema.json`; the recommended `(user_id, status, create_time)` executes as
written; and `EXPLAIN` for the target query goes from the partial `idx_user_pay`
with `Using filesort` and 23 estimated rows, to the new index with **1 estimated row
and no filesort**. Verified on 8.0 only — 5.7 remains uninspected.

### Known limitations

- No live `EXPLAIN` (planned as `--explain` in v2); MySQL only.
- Deep pagination needs a **literal** `LIMIT` offset, so `LIMIT #{offset}, #{size}`
  in a Mapper is not judged.
- Implicit conversion needs a literal; a `Long` bound to a `VARCHAR` column via
  `#{}` is invisible statically.
- Statements outside the documented SQL subset are skipped with an `info` note
  rather than guessed at.
