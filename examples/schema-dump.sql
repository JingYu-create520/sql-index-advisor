-- sql-index-advisor: dump schema.json from information_schema
--
-- The tool never connects to your database (docs/DESIGN-NOTES.md D3). You run this
-- one query with your own client and save the JSON blob as schema.json:
--
--   mysql --database=your_db --raw --skip-column-names < examples/schema-dump.sql > schema.json
--
-- Reads only `information_schema`, needs no privileges beyond SELECT on it, and does
-- not touch your data. It is one statement on purpose: that is what makes the pipe
-- above produce exactly one JSON document.
--
-- Runs on MySQL 5.7 and 8.0. Executed against live servers of both (5.7.44 and
-- 8.0.46) on a real 76-table schema. The shape is 5.7-driven on purpose: every
-- derived table here filters on `DATABASE()` instead of referencing an outer
-- column, because a derived table that does is LATERAL, which 5.7 does not have.
--
-- GROUP_CONCAT rather than JSON_ARRAYAGG: JSON_ARRAYAGG takes no ORDER BY, and
-- index column order is the whole point of the file.
--
-- An index key part that is an expression comes back as `columns: [null]`, because
-- MySQL stores functional and multi-valued parts with COLUMN_NAME = NULL. That is
-- the truth, and the loader accepts it. The expression text itself is deliberately
-- not dumped: it lives in STATISTICS.EXPRESSION, which does not exist on 5.7, and
-- this file has to run on both. SIA004 therefore recognises an already-created
-- functional index by its name, and its message says that match is by name.

SET SESSION group_concat_max_len = 67108864;

SELECT CONCAT(
    '{"mysqlVersion":"', SUBSTRING_INDEX(VERSION(), '-', 1),
    '","tables":',
    IFNULL((
        SELECT CONCAT('[', GROUP_CONCAT(t.doc ORDER BY t.TABLE_NAME SEPARATOR ','), ']')
        FROM (
            SELECT
                tab.TABLE_NAME,
                CONCAT(
                    '{"name":', JSON_QUOTE(tab.TABLE_NAME),
                    ',"engine":"', IFNULL(tab.ENGINE, ''),
                    '","charset":"', IFNULL(SUBSTRING_INDEX(tab.TABLE_COLLATION, '_', 1), ''),
                    '","rowCountEstimate":', IFNULL(tab.TABLE_ROWS, 0),
                    ',"columns":',
                    IFNULL((
                        SELECT CONCAT('[', GROUP_CONCAT(
                            JSON_OBJECT(
                                'name', col.COLUMN_NAME,
                                'type', col.DATA_TYPE,
                                'length', col.CHARACTER_MAXIMUM_LENGTH,
                                'nullable', col.IS_NULLABLE = 'YES',
                                'charset', col.CHARACTER_SET_NAME
                            )
                            ORDER BY col.ORDINAL_POSITION SEPARATOR ','), ']')
                        FROM information_schema.COLUMNS col
                        WHERE col.TABLE_SCHEMA = DATABASE()
                          AND col.TABLE_NAME = tab.TABLE_NAME
                    ), '[]'),
                    ',"indexes":', IFNULL(idx.docs, '[]'),
                    '}') AS doc
            FROM information_schema.TABLES tab
            LEFT JOIN (
                SELECT
                    one.TABLE_NAME AS table_name,
                    CONCAT('[', GROUP_CONCAT(one.idoc ORDER BY one.INDEX_NAME SEPARATOR ','), ']') AS docs
                FROM (
                    SELECT
                        s.TABLE_NAME,
                        s.INDEX_NAME,
                        CONCAT(
                            '{"name":', JSON_QUOTE(s.INDEX_NAME),
                            ',"unique":', IF(MIN(s.NON_UNIQUE) = 0, 'true', 'false'),
                            ',"primary":', IF(s.INDEX_NAME = 'PRIMARY', 'true', 'false'),
                            ',"columns":',
                            CONCAT('[', GROUP_CONCAT(
                                IFNULL(JSON_QUOTE(s.COLUMN_NAME), 'null')
                                ORDER BY s.SEQ_IN_INDEX SEPARATOR ','), ']'),
                            ',"subParts":',
                            CONCAT('[', GROUP_CONCAT(
                                IFNULL(s.SUB_PART, 'null')
                                ORDER BY s.SEQ_IN_INDEX SEPARATOR ','), ']'),
                            '}') AS idoc
                    FROM information_schema.STATISTICS s
                    WHERE s.TABLE_SCHEMA = DATABASE()
                    GROUP BY s.TABLE_NAME, s.INDEX_NAME
                ) one
                GROUP BY one.TABLE_NAME
            ) idx ON idx.table_name = tab.TABLE_NAME
            WHERE tab.TABLE_SCHEMA = DATABASE()
              AND tab.TABLE_TYPE = 'BASE TABLE'
        ) t
    ), '[]'),
    '}') AS schema_json;
