# 规则参考

7 条规则，每条都有固定 ID、触发条件、输入依赖和可验证输出。工具的可信度来自这里：任何一条建议都能追溯到"哪条规则、哪个条件、什么证据"，而不是模型的语气。

两条总原则：

- **宁可漏报，不误报**。报错了建议会烧掉 DBA 对工具的信任，漏报只是少一条提示。
- **永不执行**。只产出 `ALTER TABLE ... ADD INDEX` 文本和改写 SQL，人来评审、人来跑。

输入依赖标记：`S` = 需要 `schema.json`；`M` = 需要慢日志的 `Rows_examined`。依赖缺失时规则被跳过，并在报告 `skipped` 里说明原因——沉默不等于通过。

---

## 括号里的 SELECT 算谁的一句话

`SELECT` 出现在括号里就是另一条查询了：`IN (SELECT ...)` 的列表、`EXISTS (SELECT ...)`、`FROM (SELECT ...) d` 的派生表，以及写成 `... UNION (SELECT ...)` 的带括号分支。这些形状里要建索引的是**内层那张表**，所以解析器把任意深度的 `( SELECT ... )` 提成一条独立语句，和外层平级地送进规则（`parseSqlAll` + `core/subqueries.ts`）。内层继承父句的重量：出现次数、`Query_time`、`Rows_examined`，因为父句每跑一次它至少跟着跑一次——慢日志里的内层查询慢，本来就是因为外层一直在触发它。同一份输入里出现两遍的内层查询按指纹合成一条，不会把建议刷两遍。

这么做的代价是刻意放弃一处判定：**内层 `=` 右边那个不带表名限定的列不当作索引候选**。MySQL 解析这种名字是由内向外找列的，`WHERE child_id = parent_id` 既可能是同表两列比较、也可能是外层那一行的值，静态分不出来，也就会给出一个这张表根本没有的列。带表名限定的不用特殊处理，`resolveTable` 本来就会把没 JOIN 过的限定名丢掉。

三处仍然没覆盖，且都会写在报告里：按派生表别名过滤的条件（`WHERE d.total > 10`）对不上物理表；不带括号的 `UNION` 后续分支（结尾的 `ORDER BY`/`LIMIT` 属于整个 UNION 的结果，硬挂到最后一段查询上就是错的位置）；`WITH` 语句整体仍按不支持处理，只有 CTE 定义体里那张表会被看到。

四个开源 MyBatis 项目的实测数字：378 个 mapper XML、1666 条语句记录里，带这种内层查询的有 17 条。不算多，但集中在这几类地方——权限（`permission_id IN (SELECT ... WHERE user_id = ?)`）、关联表 EXISTS（`column_article`）、报表分页（`count(*) FROM (SELECT ...)`）——恰好是最容易缺索引又最少被人重新审的表。

## SIA001 · 缺失索引候选 · —

**触发**：某张表上有等值 / IN / 范围 / 排序条件，但没有任何索引可以服务这个访问路径。

**列顺序：等值 → GROUP BY / ORDER BY → 范围。** 这是本工具最核心的一条，也是最容易被写反的一条：索引一旦在某一列上做范围扫描，它后面的列既不能继续用于等值定位，也不能用于消除排序。所以把范围列排在排序列前面，等于亲手制造一次 `Using filesort`。

```sql
-- WHERE status = ? AND create_time > ? ORDER BY id
-- 反例 (status, create_time, id)：create_time 是范围，id 排序用不上 -> filesort
-- 正解 (status, id, create_time)：等值定位后直接按 id 有序读出
```

**不报的情况**：单列等值已经是主键或唯一键（`WHERE order_no = ? AND status = ?` 走唯一索引就已经是单行定位，再加索引只是写放大）；等值前缀已被现有索引覆盖（交给 SIA003 判断"跳过中间列"的问题，避免同一条建议出两遍）；`SELECT` 里的输出别名（`ORDER BY gmv`，gmv 是 `SUM(amount) AS gmv`，根本不是列）。

**降级但保留**：建议列**全部**是布尔/标志位（类型 `tinyint`/`bit`/`bool`，或列名命中 `is_`、`has_`、`enabled`、`deleted`、`synced`、`status`、`type` 等）时不会消失，但被压到 `info`，并附上要先跑的区分度 SQL。判据只有列名和类型——本工具看不到数据，所以 40 个取值的 `status` 和 2 个取值的 `status` 拿到同样的警告，这是能力边界不是待办。混合的复合索引不降级，`(sku_id, synced)` 的区分度由 `sku_id` 承担；`(user_type, deleted)` 这种两个都是标志位的组合会降级，因为组合起来也可能只剩几个桶。

**为什么不用统计信息代替列名（2026-09-21 在 MySQL 8.0.46 上实测过）。** 两个"看起来现成"的来源都不够格：

- `information_schema.STATISTICS.CARDINALITY` 是**按索引前缀**的采样估计，不是列自己的 NDV。demo 库里 `user_address` 的复合索引 `(user_id, is_default)` 第 2 列报 20,189，而 `is_default` 真只有 2 个取值。一个 `TINYINT` 列单独建索引后，CARDINALITY 在 `ANALYZE TABLE` 前后都报 **1**（真值 2）；一张刚灌完 10 万行的表，`PRIMARY` 的 CARDINALITY 报 **42**。也就是说：低基数恰好是这条规则要判的场景，而统计信息在这个场景下最不准。
- `information_schema.COLUMN_STATISTICS`（只有 8.0 有）能给出正确答案——`ANALYZE TABLE orders UPDATE HISTOGRAM ON status` 之后是 3 个桶的 singleton 直方图，累计频率 0.33 / 0.67 / 1.0。但它默认**一行都没有**，必须 DBA 显式对那一列跑过 ANALYZE；拿它当依据，等于让建议的准确度取决于"你有没有恰好给这列建过统计"。

所以 SIA001 继续用列名 + 声明类型的启发式，并把该跑的区分度 SQL 印在旁边。真要升级成基于直方图的判定，代价是明确的：`schema.json` 多一个字段、只支持 8.0、并且必须把"这列没有统计信息"和"这列统计显示它就是 2 个值"区分成两种不同输出。

**跨查询去重**：同一次运行里，如果一条建议的列是另一条更宽建议的最左前缀，窄的那条会被引擎丢掉（建了两个索引不多覆盖任何查询，只多一份写放大），存活的那条会在文案里说明自己吞掉了几个指纹。

**JOIN 的键只算内表那一侧。** `ON d.order_id = o.id` 给 `d` 的 `order_id` 是真过滤条件（内表要按它定位），给 `o` 的 `id` 只是驱动表交给内表的值，不缩小 `o` 的范围。所以三处判定都只看 `WHERE`：候选列构造、"主键/唯一定位不需要索引"、"等值列已被现有索引覆盖"。把驱动表侧的 JOIN 键算进去会连错三次——白占一个索引位置（InnoDB 本来就给每个二级索引附加主键）、把按主键 JOIN 的表误判成不需要索引、又把真正的 `WHERE` 条件误判成已被覆盖。

**OR 分两种，只有一种能建索引。** `status = 1 OR status = 2` 就是一个 IN 列表，照常参与候选列（`(shop_id, status)` 这种）。`a = 1 OR b = 2` 跨了列，一条复合索引救不了它：优化器要么给每个分支各用一个索引做 index merge，要么全扫。所以这种情况只出一条 `info`，**不给 DDL**，并写明两条出路（每个分支列各建索引后在 EXPLAIN 里确认 `Using union`；或者改写成 UNION ALL）。以前它会被当成 `a = 1` 处理，于是给出 `(a)` 这条错误建议，而 `sku_id` 那半边直接消失。

**括号里的条件组现在会拆开看。** `(a = 1 AND b = 2)` 是合取，`(status = 1 OR status = 2)` 是 IN 列表，都能正常参与判定。以前括号内的 token 深度是 1，拆分助手看不见里面的 AND/OR，于是 MyBatis `<where>` 里最常见的 `AND (${...} OR ...)` 整块被当成"无法识别的谓词"丢掉。

**范围条件自己就是一条访问路径。** `WHERE create_time >= ?` 没有排序、没有等值，也该给出 `(create_time)`。以前"范围之后不能排序"那条守卫被写成了"没有排序就不要范围"，于是所有只做日期/金额范围过滤的查询全部静默——这是审计真实项目时发现的最大一处漏报。

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

注意查询必须写成**完全相同**的表达式才能命中，而且 5.7 不支持——工具会按 `--mysql-version` 决定给不给这条 DDL。两个语言的文案都受这个开关控制：以前只把中文那条改了版本分支，英文字段照旧推荐函数索引，读 JSON 和 `--lang en` 的人于是被告知去做服务器根本做不到的事。

**建过的函数索引不会被再次推荐。** 表达式型的索引键在 `information_schema.STATISTICS` 里 `COLUMN_NAME` 是 NULL，表达式正文放在 `EXPRESSION` 这一列——而 5.7 根本没有这一列，所以共用的一份 dump 读不到它。能对齐的只有名字：如果这张表上已经存在一个与本条建议同名（`idx_orders_create_time`）的索引，就只降为 `warn`、不再给 DDL，并且文案里说清"这是按名字对齐，不是证明"，让人用 `SHOW INDEX` 自己确认一次。不做这件事的代价很具体：把建议执行完之后重跑一次，同一份迁移文件里会出现两条同名 `ADD INDEX`，第二条直接 `ERROR 1061`。

**同一条规则还负责一种情况：以 `%` 开头的 `LIKE`。** 它不是"列上套了函数"，但它和函数一样让 B+ 树失去定位能力——既不能 seek 也不能缩小范围，只能在别的条件筛出的行上逐行比对。所以工具明确报一条 `info`、并且**不给 DDL**，因为任何索引都救不了它。真正能改的只有三条：改成右锚定 `LIKE 'abc%'`、给该列上全文索引用 `MATCH AGAINST`、或者业务侧强制要求前缀。这条存在的理由是本项目的底线：**沉默必须归因，不能被读成"没问题"**——一个必然大范围扫描的查询过去会得到 `✓ nothing to report`。

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
