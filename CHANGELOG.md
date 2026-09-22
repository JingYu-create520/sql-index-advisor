# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.16 — 2026-09-22

### Fixed

- **`LEFT(col, n) = <not a string literal>` produced a LIKE pattern out of thin air.**
  The value was cut with `slice(1, -1)` on the assumption that its first and last
  characters were quotes. `LEFT(code, 3) = 123` therefore became `code LIKE '2%'`
  (the number lost its first digit) and `LEFT(code, 3) = remark` became
  `code LIKE 'emar%'`. Both execute cleanly and select different rows than the
  original, which is the failure mode this project rates worst. A rewrite now
  requires a genuine single-quoted (or double-quoted) literal; a number, a column
  reference or anything unreadable gets no rewrite at all. A numeric comparison is
  not prefix semantics in MySQL either - both sides are cast to a number - so it is
  not merely hard to rewrite, it should not be rewritten.
- **A day window built from a datetime literal was anchored at the wrong hour.**
  `DATE(create_time) = '2026-09-17 13:00:00'` produced
  `create_time >= '2026-09-17 13:00:00' AND create_time < '2026-09-18 13:00:00'`.
  Measured on 8.0.46, the original predicate returns **no rows at all** - `DATE()` is
  midnight and the comparison runs against the whole literal - so no time-carrying
  window can be equivalent. The rewrite is withdrawn for that shape and the finding
  says what is actually wrong: the predicate can never be true, with the day window
  it probably meant. A midnight literal keeps the ordinary (correct) range.
- **The bound-parameter date template assumed a date-only value.** It is now
  `col >= DATE(?) AND col < DATE(?) + INTERVAL 1 DAY`, which keeps day semantics
  whatever the parameter carries. The same template is only offered when the right
  side really is a parameter, never for an arbitrary value.

### Added

- `scripts/verify-rewrites.mjs` + `scripts/verify-rewrites.sql`: asks a live MySQL
  whether each rewrite the tool emits selects exactly the same rows as the original,
  comparing primary-key sets rather than row counts, and exits non-zero when any
  differs. Both defects above were found by it; neither was visible to an assertion
  about the emitted text.

### Verified

13 predicates run through the new check against MySQL 8.0.46 - every emitted rewrite
is equivalent, every withdrawn one is skipped with a reason. 299 tests pass, both
example runs unchanged at 6 and 9 suggestions.

## 0.1.15 — 2026-09-22

### Fixed

- **SIA006's deferred-join rewrite did not run.** For a deep page on a table the
  query did not alias — `SELECT id, user_id, amount FROM orders WHERE … LIMIT 100000, 20` —
  the emitted SQL was
  `SELECT * FROM (SELECT `id` FROM `orders` … ) AS page JOIN orders ON `id` = page.`id``,
  and MySQL answered `ERROR 1052 (23000): Column 'id' in on clause is ambiguous`:
  the derived table exposes `id` too. The same statement also turned a three-column
  projection into `SELECT *`, so even if it had run it would have handed the caller
  columns nothing asked for. Found by executing the tool's own output against a live
  8.0.46, which is now the standard way this project audits a rewrite.
  The rewrite always introduces its own alias (`t`) and qualifies the join, the
  projection and the outer sort through it.
- **A rewrite that cannot be faithful is withdrawn instead of approximated.** The
  projection is rebuilt column by column only when it *is* a column list: `SELECT *`
  becomes `t.*`; a computed value, an `AS` rename, a bare `x y` rename, `DISTINCT`
  or a sort key that cannot be re-qualified all produce no `rewrite` field, with the
  template and the reason in the message (both languages). `SELECT amount + 0` was
  the case that made this a parse-level flag rather than a guess: the column inside
  the expression was being collected as if the projection were that column, which
  would have quietly changed a returned value.

### Added

- `ParsedQuery.selectPlain` / `selectDistinct`, so a rule can tell "a list of columns
  I can carry over" from "a projection I must not rebuild".

### Verified

`CREATE TEMPORARY TABLE … AS <rewrite>` against the live 8.0.46 demo database: the
rewrite runs, returns the same 20 rows and the same three columns as the original,
and the outer `ORDER BY` is preserved. Re-running the whole pipeline after applying
the generated migration produced no repeated DDL. 290 tests pass.

## 0.1.14 — 2026-09-22

Found by doing the one thing the tool tells you to do: create the functional index
it recommended, re-export the schema, and run it again. Verified on a live MySQL
8.0.46.

### Fixed

- **One functional index made the whole `schema.json` unreadable.** MySQL reports
  `COLUMN_NAME = NULL` for an expression key part — a functional index
  (`(DATE(create_time))`), a multi-valued JSON index, or the second part of
  `(user_id, UPPER(status))` — so `examples/schema-dump.sql` legitimately emits
  `"columns": [null]`, and the loader's `z.array(z.string())` rejected it. Because
  validation is all-or-nothing, that single index cost every schema-gated rule: the
  output was `schema 校验失败` and nothing else. This is the second time the same
  mistake bit the same file — the first was `.optional()` rejecting the nulls
  `information_schema` produces for length and charset, which 0.1.x already fixed.
  `null` is now a valid key part, and rules treat it as what it is: a part with no
  column name, which cannot serve a plain-column lookup and cannot be named in DDL.
  SIA003 and SIA007 stay out of such indexes, and SIA001 prints one as
  `〈表达式〉` / `(expression)` rather than as the word `null`.
- **SIA004 recommended the same index after you had created it.** With
  `idx_orders_create_time` in place, the rule still emitted
  `ALTER TABLE orders ADD INDEX idx_orders_create_time ((DATE(create_time)))`, so
  following the advice produced a second run that repeated itself and a migration
  file that fails on duplicate key name. The advice is now suppressed when the table
  already carries an index with the name this advice would use, the finding drops to
  `warn`, and the message says plainly that a name match is not proof — an
  expression key part has no readable text in `information_schema` for a dump that
  still has to run on 5.7, where the `EXPRESSION` column does not exist at all.
  Confirm with `SHOW INDEX`, which the message says too.

### Added

- `tests/fixtures/schema-functional.json` — a dump taken from the live 8.0.46 probe
  database, containing a functional index, a multi-valued JSON index, a mixed
  (column, expression) index, a FULLTEXT index, and the index this tool's own advice
  creates after that advice has been applied. `tests/functional-index.test.ts` and
  three new SIA004 cases pin the behaviour. The reason this class of defect keeps
  being found late is fixtures: a hand-written schema never contains the shapes the
  author did not think of.

### Verified

`node dist/cli.js query … --schema <live dump>` over the 8.0.46 dump before and after
the fix (before: rejected; after: one `warn`, no repeated DDL), the same statement run
against `--mysql-version 5.7` (no functional DDL either way), and both example runs
unchanged at 6 and 9 suggestions. 283 tests pass.

## 0.1.13 — 2026-09-22

Closes the one miss the previous release documented instead of fixing: a table that
only appears inside parentheses was never examined.

### Added

- **A `SELECT` inside parentheses is analysed as a statement of its own**, at any
  nesting depth: the list of an `IN (SELECT ...)`, the body of an
  `EXISTS (SELECT ...)`, the derived table behind `FROM (SELECT ...) d`, and a
  bracketed `UNION` branch. Each one runs against its own tables and needs its own
  indexes, so the outer statement's parse could not stand in for it. They enter the
  run as sibling records (`src/core/subqueries.ts`), inheriting the parent's
  occurrences and cost, and identical bodies fold into one record by fingerprint.
  Measured over four open-source MyBatis projects — 378 mapper XML files, 1,666
  statement records — which hold 17 such bodies between them, and every one of them
  produced advice: `paicoding`'s `EXISTS (SELECT 1 FROM column_article ca WHERE
  ca.article_id = a.id AND ca.column_id = ?)`, `zheng`'s `upms_user_role`, whose DDL
  has no secondary index at all, and `mall`'s two bracketed `UNION` branches. Cost
  on the 908-record `mall` run: +40 ms.
- **A skip now says how much of the run it covers.** `skipped` was a per-rule
  summary, so a `WITH` statement — outer query with no resolvable table, inner body
  with a real access path — printed "not evaluated: SIA001" underneath the
  suggestion SIA001 had just produced. The footer, the CI annotation and the
  migration header now read `no table could be identified, on 1 of 2 statements`,
  and stay unqualified when the skip really is the whole run.

### Fixed

- **Inside a subquery, a bare column on the right of `=` is no longer an index
  candidate.** MySQL resolves such a name inner-first, so `WHERE child_id =
  parent_id` may be testing the *outer* query's column, and an unqualified name
  that `order_item` does not have would have been written into `ALTER TABLE
  order_item`. Qualified names needed no new rule — an unknown qualifier was
  already dropped. Pinned both ways in `tests/subquery.test.ts`.
- **The `WITH` caveat reached an English report half in Chinese**
  (`不支持的语句类型, skipped（支持 …）`). The reason map now covers that note and
  the two new ones, and a test asserts the caveats added for known gaps contain no
  untranslated Chinese when `--lang en` is asked for.

### What this still does not do

A filter on a derived table's alias (`WHERE d.total > 10`) names no physical table
and is reported rather than guessed at; an unbracketed `UNION` branch is still not
analysed, because a trailing `ORDER BY` / `LIMIT` belongs to the union result
rather than to the last query; and no cost model is applied to the correlation
itself (a correlated body is weighted as one execution per parent execution, which
understates a per-row probe and overstates a one-shot `IN` list).

## 0.1.12 — 2026-09-22

Found by auditing three more projects with different styles (`zheng`, `novel-plus`,
`paicoding`): 421, 277 and 45 statements. This round is about **misses**, not wrong
advice.

### Fixed

- **Range-only predicates produced no advice at all.** The guard that keeps a sort
  from being placed behind a range had been written as "drop the range when there
  is nothing to sort", so `WHERE create_time >= ?` on an un-indexed date column was
  silent in every one of those projects. A range is an access path on its own.
- **A bracketed condition group was opaque.** Tokens inside `( ... )` sit at depth
  1 while the AND/OR splitters match depth 0, so `AND (a = 1 OR b = 2)`, the most
  common shape in a MyBatis `<where>` block, was dropped as an unrecognised
  predicate. Groups are now unwrapped and their contents relifted before
  classification.
- **An OR across different columns drew an index on one side.** `a = 1 OR b = 2`
  was classified as `a = 1`, so the tool proposed `(a)` at error severity for an
  index the optimizer cannot use alone, and `b` disappeared. OR over one column now
  folds into an IN list (indexable, and it was previously missed entirely); OR over
  different columns gets an `info` finding with no DDL and the two rewrites that do
  work (index each branch and confirm `Using union`, or UNION ALL).
- **Redundancy elimination could lose advice without a trace.** With a chain
  `(a) -> (a,b) -> (a,b,c)` the narrow suggestion was absorbed by a middle one that
  was itself dropped, so the survivor claimed to cover one other query when it
  covered two, and the first one's fingerprint was gone. Candidates are now
  processed narrowest-first and each drop carries what it had already absorbed.
- **A bound `LIMIT ?, ?` offset was an unexplained absence.** SIA006 cannot judge
  pagination depth statically, which is fine, but 50+ statements per project came
  back with nothing said about why. It is now an attributed skip reason.
- **The "these statements were not judgeable" note blamed `${}` for everything.**
  It counted INSERTs and subquery notes under one sentence about text
  substitution. Notes are now grouped by their actual reason with per-reason
  counts, in both languages.

### Added

- Tables inside `IN (SELECT ...)` are still not analysed, but they now say so:
  the parser records the reason per statement and the report carries it out.

## 0.1.11 — 2026-09-22

### Fixed

- **The two formats that matter most in CI still swallowed the caveats.** 0.1.10
  threaded loader notes through the terminal, JSON and MCP outputs, but not
  `--format github` or `--emit-sql`, which are exactly what the Action and a DBA
  consume. A workflow pointed at the wrong directory emitted zero workflow
  commands, so the check went green having reviewed nothing; a migration file read
  as a complete list with no statement of which rules never saw the queries. Both
  now carry the notes, plus one line naming the rules that stayed silent and why
  (`not evaluated: SIA002 (needs --schema …), …`), and the migration comments can
  never be mistaken for executable statements.

## 0.1.10 — 2026-09-22

### Fixed

- **An empty report could claim a pass.** The loader already knew things worth
  saying: the directory holds no `<mapper>` XML at all, a statement's predicate is
  a `${}` text substitution that only exists at runtime, event blocks were ignored
  while parsing, a schema file was handed over as if it were a query. Those notes
  were computed and then dropped, so `sia mapper <wrong path>` printed
  `✓ nothing to report`. Notes are now part of the analysis result, printed by the
  terminal (with a distinct wording: no green check when the run learned nothing),
  carried in the JSON report, and returned through the MCP tools. A real project
  with 205 generated Example-criteria statements now says so instead of going quiet.
- **The README showed an excerpt as if it were the whole output.** The collapsible
  text block omits the per-finding `why` paragraphs; it now says so. The screenshot
  had also drifted from current output (it was captured before the SIA004 wording
  changed) and has been regenerated from a live run.

## 0.1.9 — 2026-09-22

### Fixed

- **The Action reddened a build it was only supposed to comment on.** The annotate
  step turned `set -e` back on and then ran the JSON pass, which exits 1 whenever
  there are findings, so a review with `fail-on: off` still failed the job once the
  rest of the plumbing worked. Both passes now run under the same rule: exit 1 means
  findings and is not an error, anything above 1 means the tool could not run and
  fails loudly. An empty report after a clean run is also treated as a failure.
- The resolve step refuses to continue when the checkout path contains a space,
  with a message saying what to pass as `cli`, instead of letting Node fail on a
  half-split module path.

Proved on this repository's own pull request, which is the only place this class of
bug can be seen: attempt 1 died in the install, attempt 2 reported green while doing
nothing, attempt 3 produced 8 annotations and still failed the job, attempt 4 is
green with the annotations.

## 0.1.8 — 2026-09-22

### Fixed

- **The committed bundle was not self-contained, so the Action still could not run
  it.** tsup externalises dependencies by default, which is correct for the library
  entry and wrong for a binary: `dist/cli.js` still reached for `zod` and
  `commander` in `node_modules`, and a runner holding only the checkout answered
  with `ERR_MODULE_NOT_FOUND`. Both binaries now vendor their runtime dependencies,
  and since those are CommonJS they get a `createRequire(import.meta.url)` shim in
  the banner; without it Node refuses to start the file at all
  (`Dynamic require of "events" is not supported`).
- Verified the way the runner does it: copy `dist/` and `package.json` into a
  directory with no `node_modules` anywhere, then run the CLI and the MCP
  handshake from there. The MCP server's ready banner was also confirmed to go to
  stderr, so the stdio channel stays clean protocol.

## 0.1.7 — 2026-09-22

### Fixed

- **The GitHub Action could report green while doing nothing.** It installed the
  package globally with `npm i -g github:…` and then called `sia`; on a runner that
  install extracted nothing onto PATH, so the next step died with
  `sia: command not found` (exit 127), and because that step carried
  `continue-on-error: true` the check still passed. The Action now runs the bundle
  it ships (`node "$GITHUB_ACTION_PATH/dist/cli.js"`), which removes the install,
  the PATH dependency and the npm extraction failure in one move.
  `continue-on-error` is gone: an exit above 1 fails the step loudly, while
  findings at or above `--fail-on` remain the only thing that can redden a build.
  It also exposes a `cli` output, so a later step in the caller's job reuses the
  same binary instead of assuming a global `sia` exists.

Caught by opening a real pull request against this repository, which is the only
way that class of bug shows up.

## 0.1.6 — 2026-09-22

Six findings from two sources: running the tool over other people's projects
(`YunaiV/ruoyi-vue-pro`, 95 suggestions over 111 statements; `xubinux/xbin-store`,
15 tables) and the repository's own Action reporting on its own pull request.

### Fixed

- **`npm i github:JingYu-create520/sql-index-advisor` could fail on a clean
  environment.** npm prepares a git dependency inside a throwaway clone, and there
  `prepare` ran `tsup`, which was not installed: `sh: 1: tsup: not found`, exit 127,
  install aborted. This is the command in the README, and it was caught by the
  repository's own review workflow, not by any local test. The built bundle is now
  committed, `prepare` only rebuilds when the toolchain is actually present, and CI
  fails if `dist/` drifts from `src/`.
- **SIA004 reported functions that were never in the WHERE.** A
  `DATE_FORMAT(feedback_time, '%Y-%m-%d')` in the projection or the GROUP BY, with a
  perfectly sargable range in the WHERE, was answered with "no index on that column
  can serve this predicate". An expression only matters where the column is being
  tested.
- **DDL for a table that does not exist as named.** `device_message_${deviceId}`
  collapsed to `device_message_?`, and the emitted migration file failed on import
  with `Table 'demo.crm_business' doesn't exist`. A runtime-built table name now
  gets an explanation with no DDL, because there is no single physical table to
  index.
- **"Pass --schema" was shown to people who had passed one.** When the table was
  simply not in the supplied `schema.json`, the advice was right and the sentence
  beside it was wrong. The two cases read differently now, in both languages.
- **The same column set could be proposed twice in a different order.**
  `(deleted, biz_type, post_owner_user_id, pre_owner_user_id)` and the same set with
  the last two swapped, from two statements, into one migration file. They are one
  index; the survivor says how many other access paths it serves.
- **A composite of nothing but flag columns was presented as confident advice.**
  `(user_type, deleted)` on a real table was `error` severity with "no existing
  index serves this access path". Six combinations over a large table is not an
  access path, so an all-flag suggestion is capped at `info` with the ratio query,
  the same treatment a single flag column already got.

### Added

- Two invariants over the generated corpus: no two suggestions share a column set
  in a different order, and no suggestion that is a left prefix of another. The
  first one failed on the first run, which is why it is in the list.

## 0.1.5 — 2026-09-22

### Fixed

- **A join condition was treated as a filter on the driving table.** For
  `FROM demo_order o JOIN demo_order_detail d ON d.order_id = o.id WHERE o.shop_id = ?
  AND o.delete_status = 0 ORDER BY o.create_time`, the `o.id` that the join hands to
  the inner table was counted three times over: it took a slot in the proposed
  composite (`(shop_id, delete_status, id, create_time)`, and InnoDB appends the
  primary key to every secondary index anyway), it made a table joined on its
  primary key look like a unique lookup that needs no index, and it made the real
  `WHERE` columns look already indexed. All three checks now read the `WHERE`
  clause only, and the suggestion becomes `(shop_id, delete_status, create_time)`
  with the sort column back in the position that matters.

### Added

- `examples/pr-demo/`: a deliberately imperfect mapper plus the tiny
  `schema.json` it is judged against, used by `.github/workflows/index-review.yml`
  so this repository reviews its own pull requests with its own Action. That
  workflow is the end-to-end proof that `uses: …@v0` resolves and that a
  contributor gets advice on the line they touched without installing anything.

## 0.1.4 — 2026-09-22

### Fixed

- **A leading-wildcard `LIKE '%x%'` used to produce an empty report.** No B-tree
  index can use that predicate for a seek or a range narrowing, so there is
  nothing to recommend, but printing `nothing to report` over a query that is
  guaranteed to scan is the one thing this tool promised not to do: silence has to
  be attributable. SIA004 now emits an `info` finding naming the predicate,
  carrying no DDL, and listing the three actual ways out (right-anchored LIKE,
  fulltext with `MATCH AGAINST`, or requiring a prefix from the caller). A
  right-anchored `LIKE 'abc%'` is still treated as indexable and stays quiet.
  Found while reviewing the same real project's search queries.

## 0.1.3 — 2026-09-22

Found by running the tool against somebody else's project instead of our own
fixtures: `macrozheng/mall`, 104 hand-written MyBatis DAO files, with its
production schema loaded into a live server.

### Fixed

- **`examples/schema-dump.sql` did not run on MySQL 5.7**, which is what its own
  header comment claimed. The index block used a derived table referencing a column
  of the outer query, and that is `LATERAL`, which 5.7 does not have:
  `ERROR 1054 (42S22) at line 15: Unknown column 'tab.TABLE_SCHEMA' in 'where clause'`.
  Every derived table in the file now filters on `DATABASE()` on its own, so nothing
  is correlated. Verified on live 5.7.44 and 8.0.46 against the same 76-table schema:
  both produce valid JSON, the table, column and index lists match between versions,
  and `loadSchema` accepts either. Index and table names now go through `JSON_QUOTE`,
  so a name containing a quote can no longer corrupt the document.
- **SIA001 proposed an index for a primary key `IN` list.** A batch update of the
  shape `WHERE id IN ( ? ) AND status = 1` drew `ADD INDEX (status, id)`. Reading the
  primary key for that list is what the engine does anyway, and the remaining
  predicates filter rows already in hand, so the second structure would cost writes
  and never be chosen. `IN (subquery)` is still reported: there the list has no
  static bound.
- **SIA004 recommended a functional index to 5.7 users in English.** The DDL was
  correctly withheld under `--mysql-version 5.7` and the Chinese text said why, but
  `messageEn` was one fixed sentence ending "rewrite as a range or add a functional
  index". The explanation of why each rewrite is equivalent also existed only in
  Chinese; it is in both languages now.

### Changed

- `examples/seed-schema.sql` is documented as 8.0 only, with the errors it produces
  on 5.7 (`Unknown system variable 'cte_max_recursion_depth'`, then a syntax error on
  every `WITH RECURSIVE`). It is the demo data that needs 8.0, not the tool.
- The 128-character asking price on a suggested prefix index is now a named constant
  with a reason attached, instead of an unnamed literal silently overriding the byte
  budget it claims to respect. `--prefix-bytes` shrinks the suggestion; raising it
  past the ceiling still does not, and `docs/rules.md` says so.

## 0.1.2 — 2026-09-22

### Fixed

- **A MyBatis bind parameter truncated the statement.** `#{userId}` was read as
  the start of a MySQL `#` comment, so everything after it to the end of the line
  disappeared before the parser saw the SQL. `sia query "SELECT id FROM orders
  WHERE user_id = #{userId} AND status = 'PAID'"` reported the evidence as
  `WHERE user_id =` and proposed `(user_id)` for what is really a
  `(user_id, status)` access path. It affected the inline path and the MCP
  `analyze_sql` tool, in `stripComments` (fingerprints and evidence) and, once
  0.1.1 added it, in `splitStatements` too. Both now treat `#{` as what the
  tokenizer already treats it as: an opaque parameter. Mapper XML was never
  affected, because it reaches the parser through its own path.
- **The `v0` tag was missing from the repository**, while both READMEs and the
  example workflow tell people to write `uses: JingYu-create520/sql-index-advisor@v0`.
  That reference does not resolve, so the documented Action setup failed at the
  first line. `v0` is published again, pointing at the newest release, and
  `docs/DESIGN-NOTES.md` now lists moving it as part of cutting a release.

### Added

- `tests/merged.test.ts` covers the bind-parameter cases, including one where the
  placeholder sits in the middle of an `UPDATE ... WHERE`.

## 0.1.1 — 2026-09-21

### Fixed

- **`--version` lied.** The version was a literal in `src/cli.ts` and again in
  `src/mcp/tools.ts`, so after the manifest moved on the CLI still printed the
  previous release, and so did the MCP `initialize` handshake. Both now read
  `src/version.ts`, which resolves the package.json beside the built module, and a
  test asserts the two agree.
- **Merged statements produced cross-table DDL.** A `.sql` file whose
  statements end at a newline instead of `;` was parsed as one statement: the first
  `FROM` set the table and a later `WHERE` set the columns, so
  `SELECT count(*) FROM semantic_cache` plus `SELECT count(*) FROM outbox WHERE
  aggregate_id = 'x'` emitted
  `ALTER TABLE `semantic_cache` ADD INDEX (aggregate_id)` — a column belonging to
  another table, straight into the file `--emit-sql` writes. `parseSql` now refuses
  input with a second top-level statement keyword after the FROM (UNION and friends
  excluded) and names the reason; the engine reports it as its own skip cause instead
  of the vague "no table could be identified". Related: `analyze_sql` documents
  "可用 ; 分隔多条" but the inline path never split on `;` either — it does now,
  quote-, comment- and paren-aware. Pinned by `tests/merged.test.ts` (11 cases).
- **SIA001 said different things in the two languages.** The Chinese message
  warns that an existing index covers only a left prefix of the proposed one and
  should be evaluated for removal; `messageEn` skipped that branch and asserted
  "no existing index serves this access path" instead. Consumers reading JSON,
  `--lang en`, or the MCP tools got a false all-clear on a `warn` finding. The
  English text now mirrors the same three branches (no schema / prefix covered /
  nothing serving), keeps the oversized-column caveat, and a test asserts the
  prefix warning appears in both languages. Reproduced on the bundled example:
  `SELECT id FROM orders WHERE user_id = 1 AND shop_id = 2` against
  `examples/schema.json` now names `idx_user(user_id, pay_time)`.
- **GitHub Action gate step**: exit code `2` (the tool could not run, bad path,
  unreadable input) was reported exactly like `1` (findings at or above
  `--fail-on`), and because Actions executes `run:` blocks under `bash -e` the
  explanatory `::error::` line never reached the log. Each case now prints its
  own reason. Verified against the built CLI: `0` quiet, `1` findings, `2`
  missing file.
- **Action install snippet** in both READMEs and `examples/github-action/`
  referenced a repository owner that does not exist, so the documented
  `uses: …@v0` line could not resolve.

### Added

- README: "Where it got it wrong": the four concrete false positives this tool
  emitted during development (prefix-redundant pairs, single-column indexes on
  boolean flags, a `SELECT` alias indexed as a column, one query pattern split
  into two fingerprints), what each one does now, and which test pins it. Plus
  "What has not been verified", listing MySQL 5.7, the Action on a real PR, and
  MCP inside a client.

### Changed

- `LICENSE`, `package.json` and `action.yml` named an author handle that is not
  a GitHub account; the repository lives under `JingYu-create520`, so the
  copyright line now does too.
- Replaced a guess in the docs with a measurement: `information_schema` was
  probed on a live MySQL 8.0.46 to see whether index statistics could drive the
  flag-column decision in SIA001 instead of column names. They cannot.
  `STATISTICS.CARDINALITY` reported 1 for a 2-valued `TINYINT` column before and
  after `ANALYZE TABLE`, and 42 for the primary key of a table loaded with
  100,000 rows, because it estimates per index *prefix*. `docs/rules.md` now
  carries those numbers and the reason `COLUMN_STATISTICS` histograms were also
  rejected (8.0-only, and empty until a DBA analyzes that exact column).

## 0.1.0 — 2026-09-20

First release. Core premise: index advice you can verify. Every finding carries
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
  `needsMetrics`, and every skipped rule is reported with the reason: silence is
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
  `error`), `2` runtime error, so first-time adoption does not turn a green
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
- **SIA001 treated a lone boolean/flag column as ordinary advice**: the classic
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
  code 1 killed the step before it could be judged, and its assertions lacked
  `|| exit 1`, so a broken check could have passed silently.

### Verified against a live database

MySQL 8.0.46 in Docker, seeded with `examples/seed-schema.sql`: the dump produces a
valid `schema.json`; the recommended `(user_id, status, create_time)` executes as
written; and `EXPLAIN` for the target query goes from the partial `idx_user_pay`
with `Using filesort` and 23 estimated rows, to the new index with **1 estimated row
and no filesort**. Verified on 8.0 only; 5.7 remains uninspected.

### Known limitations

- No live `EXPLAIN` (planned as `--explain` in v2); MySQL only.
- Deep pagination needs a **literal** `LIMIT` offset, so `LIMIT #{offset}, #{size}`
  in a Mapper is not judged.
- Implicit conversion needs a literal; a `Long` bound to a `VARCHAR` column via
  `#{}` is invisible statically.
- Statements outside the documented SQL subset are skipped with an `info` note
  rather than guessed at.

### Tag note

The entry above describes the state of the tool when the milestones finished, not
the tree inside the `v0.1.0` tag. That tag was cut a day earlier, at the commit
where installation moved to GitHub: it has 17 test files and 186 cases, and it
does not contain `tests/fuzz.test.ts`, the README screenshot, or `--lang` on
`--emit-sql`. Those landed afterwards and are in the `0.1.1` and `0.1.2` trees.
Pin `v0.1.2`, or use the floating `v0`, rather than `v0.1.0`.
