-- sql-index-advisor: seed database for end-to-end verification
--
-- Creates a deliberately under-indexed schema so the tool has real work to do,
-- then loads enough rows that MySQL's optimizer makes a genuine choice rather
-- than defaulting to a full scan out of indifference.
--
--   docker run -d --name sia-mysql -e MYSQL_ROOT_PASSWORD=sia -e MYSQL_DATABASE=demo \
--     -p 13307:3306 mysql:8.0
--   docker exec -i sia-mysql mysql -uroot -psia demo < examples/seed-schema.sql
--   mysql -h 127.0.0.1 -P 13307 -uroot -psia demo < examples/schema-dump.sql > schema.json
--   sia examples/slow.log --schema schema.json
--   sia query "SELECT * FROM orders WHERE user_id = 42 AND status = 'PAID' ORDER BY create_time DESC LIMIT 20" \
--       --schema schema.json --emit-sql add-indexes.sql
--   mysql -h 127.0.0.1 -P 13307 -uroot -psia demo < add-indexes.sql
--
-- Then re-run the EXPLAIN block at the bottom: `type` should stop being ALL and
-- `key` should name the index the tool recommended.
--
-- MySQL 8.0 only, and this is the one example file with that requirement. The row
-- generation uses `WITH RECURSIVE` plus `cte_max_recursion_depth`, neither of which
-- exists on 5.7: there it fails with `ERROR 1193 Unknown system variable
-- 'cte_max_recursion_depth'` and then `ERROR 1064 ... near 'RECURSIVE'` on every
-- insert. The tool itself and `schema-dump.sql` work fine against 5.7; if you want
-- the demo on 5.7, load any small schema with a couple of unindexed foreign keys.

-- Must exceed the largest generated table (600k address rows).
SET SESSION cte_max_recursion_depth = 1000000;
SET SESSION sql_mode = 'STRICT_ALL_TABLES,NO_ENGINE_SUBSTITUTION';

DROP TABLE IF EXISTS order_item;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS user_address;
DROP TABLE IF EXISTS users;

-- Only the primary keys and one partial composite index, so SIA001 / SIA003 both
-- have something legitimate to complain about.
CREATE TABLE orders (
  id          BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id     BIGINT       NOT NULL,
  shop_id     BIGINT       NOT NULL,
  order_no    VARCHAR(64)  NOT NULL,
  status      VARCHAR(16)  NOT NULL,
  amount      DECIMAL(12,2) NOT NULL,
  remark      TEXT         NULL,
  create_time DATETIME     NOT NULL,
  pay_time    DATETIME     NULL,
  KEY idx_user_pay (user_id, pay_time)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE order_item (
  id        BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  order_id  BIGINT NOT NULL,
  sku_id    BIGINT NOT NULL,
  quantity  INT    NOT NULL,
  price     DECIMAL(12,2) NOT NULL
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE users (
  id          BIGINT      NOT NULL AUTO_INCREMENT PRIMARY KEY,
  mobile      VARCHAR(20) NOT NULL,
  name        VARCHAR(255) NULL,
  level       INT         NOT NULL,
  create_time DATETIME    NOT NULL,
  UNIQUE KEY uk_mobile (mobile)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE user_address (
  id         BIGINT      NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id    BIGINT      NOT NULL,
  city       VARCHAR(32) NULL,
  detail     VARCHAR(512) NULL,
  is_default TINYINT     NOT NULL,
  KEY idx_user_default (user_id, is_default)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- 200k orders.
INSERT INTO orders (user_id, shop_id, order_no, status, amount, remark, create_time, pay_time)
SELECT 1 + (n % 9000),
       1 + (n % 400),
       CONCAT('NO', LPAD(n, 12, '0')),
       ELT(1 + (n % 3), 'PAID', 'NEW', 'REFUND'),
       10.50 + (n % 900),
       NULL,
       DATE_SUB('2026-09-20 12:00:00', INTERVAL (n % 50000) MINUTE),
       NULL
FROM (
  WITH RECURSIVE s(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM s WHERE n < 199999)
  SELECT n FROM s
) seed;

-- 400k order items, 600k addresses, 20k users.
INSERT INTO order_item (order_id, sku_id, quantity, price)
SELECT 1 + (n % 200000), 1 + (n % 50000), 1 + (n % 5), 9.90 + (n % 300)
FROM (
  WITH RECURSIVE s(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM s WHERE n < 399999)
  SELECT n FROM s
) seed;

INSERT INTO user_address (user_id, city, detail, is_default)
SELECT 1 + (n % 20000),
       ELT(1 + (n % 7), 'Hangzhou', 'Shanghai', 'Beijing', 'Shenzhen', 'Chengdu', 'Suzhou', 'Ningbo'),
       CONCAT('street ', n),
       IF(n % 4 = 0, 1, 0)
FROM (
  WITH RECURSIVE s(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM s WHERE n < 599999)
  SELECT n FROM s
) seed;

INSERT INTO users (mobile, name, level, create_time)
SELECT CONCAT('13', LPAD(n, 9, '0')), CONCAT('user', n), 1 + (n % 5),
       DATE_SUB('2026-09-20 12:00:00', INTERVAL (n % 90000) MINUTE)
FROM (
  WITH RECURSIVE s(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM s WHERE n < 19999)
  SELECT n FROM s
) seed;

ANALYZE TABLE orders, order_item, users, user_address;

-- ---------------------------------------------------------------------------
-- Before / after check. Run these with the tool's recommended index absent, then
-- apply add-indexes.sql and run them again.
-- ---------------------------------------------------------------------------

-- EXPLAIN SELECT * FROM orders WHERE user_id = 42 AND status = 'PAID'
--   ORDER BY create_time DESC LIMIT 20;
--   before: key = idx_user_pay, Extra = Using filesort
--   after : key = idx_orders_user_id_status_create_time, Extra has no filesort

-- EXPLAIN SELECT COUNT(*) FROM order_item WHERE order_id = 12001;
--   before: type = ALL  (full scan of 400k rows)
--   after : type = ref  (key = idx_order_item_order_id)

-- EXPLAIN SELECT o.id FROM orders o JOIN order_item oi ON oi.order_id = o.id
--   WHERE o.user_id = 42;
--   before: oi accessed by full scan
--   after : oi accessed via idx_order_item_order_id
