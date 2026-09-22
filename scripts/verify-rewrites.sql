-- Edge-case rows for scripts/verify-rewrites.mjs.
--
-- Every value here exists to make a *silently wrong* rewrite show up as a
-- difference in row counts. Nothing about this data is realistic; that is the
-- point - a rewrite that is equivalent only on friendly data is not equivalent.
--
--   docker exec -i sia-mysql mysql -uroot -psia < scripts/verify-rewrites.sql
--
-- Run it through the script rather than by hand; the script is what compares the
-- two predicates.

CREATE DATABASE IF NOT EXISTS sia_rewrite_check;
USE sia_rewrite_check;
DROP TABLE IF EXISTS t;

CREATE TABLE t (
  k INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(16) NULL,
  code2 VARCHAR(16) NULL,
  amount DECIMAL(10, 2) NULL,
  create_time DATETIME NULL,
  KEY idx_code (code),
  KEY idx_time (create_time)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

INSERT INTO t (code, code2, amount, create_time) VALUES
  -- numeric-looking prefixes: `LEFT(code, 3) = 123` compares as numbers in MySQL,
  -- so it is not a prefix test and must not be turned into a LIKE pattern
  ('123', '12', 4.00, '2026-09-17 00:00:00'),
  ('12abc', '12', 5.00, '2026-09-17 09:30:00'),
  ('12', '123', 6.00, '2026-09-17 23:59:59'),
  ('1', '12', 3.00, '2026-01-01 00:00:00'),
  -- wildcards inside the compared value, and a column-to-column comparison
  ('a%c', 'a%', 7.00, '2025-12-31 23:59:59'),
  ('ab', NULL, NULL, NULL),
  (NULL, NULL, 1.00, NULL),
  -- the day and year boundaries, on both sides
  ('abc', 'ab', 2.00, '2026-09-18 00:00:00'),
  ('abd', 'ab', 10.00, '2024-02-29 00:00:00'),
  ('zzz', 'zz', NULL, '2026-03-01 12:00:00');
