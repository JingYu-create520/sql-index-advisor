-- sql-index-advisor: dump schema.json from information_schema
--
-- No DB connection is made by the tool itself (docs/PLAN.md 5.2). You run these
-- queries with your own client and save the JSON blob as schema.json, then:
--
--   mysql --database=your_db --raw --skip-column-names < examples/schema-dump.sql > schema.json
--
-- Written against MySQL 5.7 and 8.0 (JSON functions + GROUP_CONCAT with ORDER BY),
-- but NOT yet executed on a live server: review before running, and open an issue if it errors.
-- GROUP_CONCAT is used instead of JSON_ARRAYAGG because MySQL's JSON_ARRAYAGG
-- does not accept ORDER BY, and index column order is the whole point.

SET SESSION group_concat_max_len = 67108864;

SELECT CONCAT(
    '{"mysqlVersion":"', SUBSTRING_INDEX(VERSION(), '-', 1),
    '","tables":', IFNULL((
        SELECT CONCAT('[', GROUP_CONCAT(tbl.doc ORDER BY tbl.TABLE_NAME SEPARATOR ','), ']')
        FROM (
            SELECT
                tab.TABLE_SCHEMA,
                tab.TABLE_NAME,
                CONCAT(
                    '{"name":"', tab.TABLE_NAME,
                    '","engine":"', IFNULL(tab.ENGINE, ''),
                    '","charset":"', IFNULL(SUBSTRING_INDEX(tab.TABLE_COLLATION, '_', 1), ''),
                    '","rowCountEstimate":', IFNULL(tab.TABLE_ROWS, 0),
                    ',"columns":', IFNULL((
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
                        WHERE col.TABLE_SCHEMA = tab.TABLE_SCHEMA
                          AND col.TABLE_NAME = tab.TABLE_NAME
                    ), '[]'),
                    ',"indexes":', IFNULL((
                        SELECT CONCAT('[', GROUP_CONCAT(idx.doc ORDER BY idx.INDEX_NAME, idx.SEQ SEPARATOR ','), ']')
                        FROM (
                            SELECT
                                idx2.INDEX_NAME,
                                MIN(idx2.SEQ_IN_INDEX) AS SEQ,
                                CONCAT(
                                    '{"name":"', idx2.INDEX_NAME,
                                    '","unique":', IF(idx2.NON_UNIQUE = 0, 'true', 'false'),
                                    ',"primary":', IF(idx2.INDEX_NAME = 'PRIMARY', 'true', 'false'),
                                    ',"columns":CAST(',
                                    QUOTE(CONCAT('[', GROUP_CONCAT(
                                        IFNULL(CONCAT('"', idx2.COLUMN_NAME, '"'), 'null')
                                        ORDER BY idx2.SEQ_IN_INDEX SEPARATOR ','), ']')),
                                    ' AS JSON)',
                                    ',"subParts":CAST(',
                                    QUOTE(CONCAT('[', GROUP_CONCAT(
                                        IFNULL(idx2.SUB_PART, 'null')
                                        ORDER BY idx2.SEQ_IN_INDEX SEPARATOR ','), ']')),
                                    ' AS JSON)}'
                                ) AS doc
                            FROM information_schema.STATISTICS idx2
                            WHERE idx2.TABLE_SCHEMA = tab.TABLE_SCHEMA
                              AND idx2.TABLE_NAME = tab.TABLE_NAME
                            GROUP BY idx2.INDEX_NAME, idx2.NON_UNIQUE
                        ) idx
                    ), '[]'),
                    '}') AS doc
            FROM information_schema.TABLES tab
            WHERE tab.TABLE_SCHEMA = DATABASE()
              AND tab.TABLE_TYPE = 'BASE TABLE'
            GROUP BY tab.TABLE_SCHEMA, tab.TABLE_NAME, tab.ENGINE, tab.TABLE_COLLATION, tab.TABLE_ROWS
        ) tbl
    ), '[]'),
    '}') AS schema_json;
