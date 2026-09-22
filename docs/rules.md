# 规则参考

7 条规则，每条都有固定 ID、触发条件、输入依赖和可验证输出。工具的可信度来自这里：任何一条建议都能追溯到"哪条规则、哪个条件、什么证据"，而不是模型的语气。

两条总原则：

- **宁可漏报，不误报**。报错了建议会烧掉 DBA 对工具的信任，漏报只是少一条提示。
- **永不执行**。只产出 `ALTER TABLE ... ADD INDEX` 文本和改写 SQL，人来评审、人来跑。

输入依赖标记：`S` = 需要 `schema.json`；`M` = 需要慢日志的 `Rows_examined`。依赖缺失时规则被跳过，并在报告 `skipped` 里说明原因——沉默不等于通过。

---

## SIA001 · 缺失索引候选 · —

**触发**：某张表上有等值 / IN / 范围 / 排序条件，但没有任何索引可以服务这个访问路径。

**列顺序：等值 → GROUP BY / ORDER BY → 范围。** 这是本工具最核心的一条，也是最容易被写反的一条：索引一旦在某一列上做范围扫描，它后面的列既不能继续用于等值定位，也不能用于消除排序。所以把范围列排在排序列前面，等于亲手制造一次 `Using filesort`。

```sql
-- WHERE status = ? AND create_time > ? ORDER BY id
-- 反例 (status, create_time, id)：create_time 是范围，id 排序用不上 -> filesort
-- 正解 (status, id, create_time)：等值定位后直接按 id 有序读出
```

**不报的情况**：单列等值已经是主键或唯一键（`WHERE order_no = ? AND status = ?` 走唯一索引就已经是单行定位，再加索引只是写放大）；等值前缀已被现有索引覆盖（交给 SIA003 判断"跳过中间列"的问题，避免同一条建议出两遍）；`SELECT` 里的输出别名（`ORDER BY gmv`，gmv 是 `SUM(amount) AS gmv`，根本不是列）。

**降级但保留**：单列布尔/标志位（类型 `tinyint`/`bit`/`bool`，或列名命中 `is_`、`has_`、`enabled`、`deleted`、`synced`、`status`、`type` 等）不会消失，但被压到 `info`，并附上要先跑的区分度 SQL。判据只有列名和类型——本工具看不到数据，所以 40 个取值的 `status` 和 2 个取值的 `status` 拿到同样的警告，这是能力边界不是待办。复合索引里的标志位不降级，`(sku_id, synced)` 的区分度由 `sku_id` 承担。

**为什么不用统计信息代替列名（2026-09-21 在 MySQL 8.0.46 上实测过）。** 两个"看起来现成"的来源都不够格：

- `information_schema.STATISTICS.CARDINALITY` 是**按索引前缀**的采样估计，不是列自己的 NDV。demo 库里 `user_address` 的复合索引 `(user_id, is_default)` 第 2 列报 20,189，而 `is_default` 真只有 2 个取值。一个 `TINYINT` 列单独建索引后，CARDINALITY 在 `ANALYZE TABLE` 前后都报 **1**（真值 2）；一张刚灌完 10 万行的表，`PRIMARY` 的 CARDINALITY 报 **42**。也就是说：低基数恰好是这条规则要判的场景，而统计信息在这个场景下最不准。
- `information_schema.COLUMN_STATISTICS`（只有 8.0 有）能给出正确答案——`ANALYZE TABLE orders UPDATE HISTOGRAM ON status` 之后是 3 个桶的 singleton 直方图，累计频率 0.33 / 0.67 / 1.0。但它默认**一行都没有**，必须 DBA 显式对那一列跑过 ANALYZE；拿它当依据，等于让建议的准确度取决于"你有没有恰好给这列建过统计"。

所以 SIA001 继续用列名 + 声明类型的启发式，并把该跑的区分度 SQL 印在旁边。真要升级成基于直方图的判定，代价是明确的：`schema.json` 多一个字段、只支持 8.0、并且必须把"这列没有统计信息"和"这列统计显示它就是 2 个值"区分成两种不同输出。

**跨查询去重**：同一次运行里，如果一条建议的列是另一条更宽建议的最左前缀，窄的那条会被引擎丢掉（建了两个索引不多覆盖任何查询，只多一份写放大），存活的那条会在文案里说明自己吞掉了几个指纹。

**没有 schema 时**：降级为 `info` 级别的"候选"，并明说"无法确认是否已有索引覆盖，请提供 `--schema`"。

## SIA002 · 前缀索引 · S

**触发**：参与等值/IN/范围条件的字符串列，整列键长超过索引键预算的一半，或是 `TEXT/BLOB`。

阈值按**字节**算，不按字符数。`VARCHAR > 255` 那条流传很广的经验来自 utf8mb3 + 767 字节的老限制；InnoDB 8.0 DYNAMIC 行格式的下限是 3072 字节，而 utf8mb4 一个字符要 4 字节——所以真正该问的是"这列的字符集下占多少字节"。

```sql
ALTER TABLE `orders` ADD INDEX `idx_orders_remark` (`remark`(64));
```

前缀长度不能拍脑袋。工具会附上区分度验证 SQL，让你自己确认 N 够不够：

```sql
SELECT COUNT(DISTINCT LEFT(remark, 64)) / COUNT(DISTINCT remark) AS ratio FROM orders;
```

建议长度另有一道**实践上限 128 个字符**：比这更长的前缀通常已经越过区分度拐点，而工具看不到数据，所以宁可给短，把"要不要更长"交回给上面那条 SQL。字节预算（8.0 的 3072 / 5.7 的 767，以及你用 `--prefix-bytes` 传进来的值）是硬上限——把它调小会真的缩短建议长度，调大则不会突破 128。

## SIA003 · 最左前缀违反 · S

**触发**：查询用到了复合索引的靠前列，跳过了中间列，却直接用了更靠后的列。

这条规则存在的理由是它在 `EXPLAIN` 里**看起来是好的**：`key` 照样显示那个索引，只有 `key_len` 暴露真实用到的长度。

```sql
-- INDEX (user_id, status, create_time)
WHERE user_id = ? AND create_time > ?     -- status 被跳过：create_time 无法缩小范围
```

**出路两条**：① 业务能补上被跳过列的条件，就补条件，现有索引立刻用满，成本为零；② 补不上就新建 `(user_id, create_time)`。选 ② 时新索引与旧索引存在写放大重叠，上线后要评估下线旧索引。

## SIA004 · 索引列上使用函数或运算 · —

**触发**：谓词左侧的列被函数或算术包住了（`DATE(create_time) = ?`、`YEAR(t) = 2026`、`amount + 1 = ?`、`LEFT(code,3) = ?`）。索引里存的是原值，不是函数结果，所以该列索引完全用不上。

优先改写，因为改写不占存储：

```sql
WHERE DATE(create_time) = '2026-09-17'
-- -> WHERE create_time >= '2026-09-17 00:00:00' AND create_time < '2026-09-18 00:00:00'
```

日期边界一律**左闭右开**。用 `<= '2026-09-17 23:59:59'` 会漏掉那一秒内的多值与更高精度时间，是这类改写最常见的翻车点。

MySQL 8.0 另一条路是函数索引：

```sql
ALTER TABLE `orders` ADD INDEX `idx_orders_create_time` ((DATE(create_time)));
```

注意查询必须写成**完全相同**的表达式才能命中，而且 5.7 不支持——工具会按 `--mysql-version` 决定给不给这条 DDL。

## SIA005 · 隐式类型转换 · S

**触发**：**字符串列** = **数字字面量**。MySQL 的规则是把列侧转成数字再比较，等于对整列套函数，索引直接失效（`type=ALL`）。

方向很重要，反方向不报：`int_col = '123'` 转换发生在常量侧，只做一次，索引照常可用。报它就是误报。

```sql
WHERE mobile = 13800000000    -- -> WHERE mobile = '13800000000'
```

**已知边界**：绑定参数（`mobile = ?`）看不出 Java 侧的实际类型，所以静态判不了。MyBatis 项目里真正危险的是 DTO 把手机号声明成 `Long`——那属于 spring-review 那一类静态检查的活，这里不越界猜测。

## SIA006 · 深分页 · —

**触发**：`LIMIT` 的偏移量是**字面量**且超过阈值（默认 10000）。`LIMIT 100000, 20` 仍要扫描并丢弃前 10 万行。

只判字面量是刻意的：MyBatis 的 `LIMIT #{offset}, #{size}` 归一化成 `?, ?` 之后，静态无从知道 offset 有多大，硬猜就是误报。要看这类语句的实际分页深度，请把慢日志拿进来。

两条出路：

```sql
-- ① 延迟关联：先在索引里翻主键，再回表取整行
SELECT o.* FROM (
  SELECT `id` FROM `orders` WHERE user_id = 1 ORDER BY id DESC LIMIT 100000, 20
) AS page JOIN `orders` o ON o.`id` = page.`id` ORDER BY o.id DESC;

-- ② 游标 / seek：用上一页最后一行的排序键替代偏移量
WHERE (o.`create_time` < ? OR (o.`create_time` = ? AND o.`id` < ?)) ORDER BY o.create_time DESC LIMIT 20;
```

改写语句里的 WHERE / ORDER BY 是从原句**逐字搬过来**的，不是从解析结果重建的——重建会悄悄丢掉解析器无法归类的条件，而"改写后结果集变了"比不改写糟糕得多。遇到含相关子查询的语句，工具降级为只给模板、不给可执行改写。多表 FROM 的深分页同样不做具体改写。

## SIA007 · 覆盖索引机会 · S M

**触发**：慢日志显示扫描行数很高（默认 ≥10000），投影列明确（不是 `SELECT *`），谓词已经有可用索引，但投影列不在索引里——每一行都要回表读聚簇索引。

把投影列并进去，`Extra` 里就会出现 `Using index`，回表的随机 IO 直接消失：

```sql
-- 现有 INDEX (user_id, status, create_time)
SELECT amount FROM orders WHERE user_id = ?
-- -> ALTER TABLE `orders` ADD INDEX ... (`user_id`, `status`, `create_time`, `amount`);
```

这是最贵的一条建议：索引变宽意味着写放大和空间都涨。所以它同时要求 schema 和慢日志指标——只在"真的观测到扫描压力"时才开口，并且明确列出新增列，让你能判断这些列上的更新频率。超过 5 列或含 `TEXT` 一律不报。

---

## 输出结构

```ts
interface Finding {
  rule: string;           // "SIA001"
  severity: "error" | "warn" | "info";
  sql: string;            // 证据 SQL（截断到 200 字符）
  fingerprint: string;    // 归一化指纹，用于聚合与去重
  source?: { file: string; line: number };
  queryTime?: number;
  rowsExamined?: number;
  occurrences?: number;
  message: string;        // 中文原理说明
  messageEn: string;      // 同等信息量的英文文案（不是摘要：两条分支的警告必须两边都在）
  llmNote?: string;       // 仅 --llm 追加，不参与任何判定
  suggestedDDL: string[]; // 只有 ADD INDEX，永不出现 DROP
  rewrite?: string;
  needsSchema: boolean;
  needsMetrics: boolean;
  indexColumns?: string[];      // 建议索引的列顺序；引擎据此做前缀冗余消除
  lowCardinalityRisk?: boolean; // 单列标志位：压到 info，并附区分度验证 SQL
  coveredFingerprints?: string[]; // 因本条更宽而被吞掉的窄建议指纹
}
```

## 排序

终端与 JSON 报告先按严重度，再按预估收益：`总耗时 × 扫描行数 × 命中次数`。慢日志输入下这就是"本周最该修的三条"；没有慢日志指标时退化为按严重度排列。
