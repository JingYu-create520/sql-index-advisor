# sql-index-advisor

[![CI](https://img.shields.io/github/actions/workflow/status/JingYu-create520/sql-index-advisor/ci.yml?branch=main&label=CI)](https://github.com/JingYu-create520/sql-index-advisor/actions/workflows/ci.yml) [![release v0.1.0](https://img.shields.io/github/v/tag/JingYu-create520/sql-index-advisor?label=release)](https://github.com/JingYu-create520/sql-index-advisor/releases/tag/v0.1.0) [![license MIT](https://img.shields.io/github/license/JingYu-create520/sql-index-advisor)](LICENSE)

**面向 MySQL / MyBatis 的离线索引顾问。慢查询日志进，索引建议 + 迁移 SQL 出。**

![终端输出：三条建议带规则号、证据 SQL、改写语句，以及生成的迁移文件](docs/assets/terminal-demo.png)

所有结论由确定性规则产生——可复现、可单测、**无需 API key**。LLM 只是可选的文案润色层，它无法新增、删除或重排任何一条建议。

<details>
<summary>同样内容的纯文本版（方便复制）</summary>

```console
$ sia examples/slow.log --schema examples/schema.json

6 条建议  4 error  2 warn  0 info  · 覆盖 5 个查询指纹

 1 [error] SIA004 索引列上使用函数或运算 orders · examples/slow.log:26 · 7.441s · 4,120,933 rows
   证据 SELECT id, user_id, amount FROM orders WHERE DATE(create_time) = '2026-09-17' LIMIT 100…
   改写 create_time >= '2026-09-17 00:00:00' AND create_time < '2026-09-18 00:00:00'
   DDL     ALTER TABLE `orders` ADD INDEX `idx_orders_create_time` ((DATE(create_time)));

 2 [error] SIA001 缺失索引候选 user_address · examples/slow.log:36 · 5.001s · 2,881,004 rows
   证据 SELECT u.id, u.name, u.mobile FROM users u LEFT JOIN user_address a ON a.user_id = u.id…
   DDL     ALTER TABLE `user_address` ADD INDEX `idx_user_address_city_user_id` (`city`, `user_id`);

建议需人工评审后再执行；本工具永不自动改动数据库。

$ sia examples/slow.log --schema examples/schema.json --emit-sql add-indexes.sql
-- SIA001 缺失索引候选 · error · 扫描 903,112 行
ALTER TABLE `order_item` ADD INDEX `idx_order_item_order_id` (`order_id`);
-- SIA004 索引列上使用函数或运算 · error · 扫描 4,120,933 行
ALTER TABLE `orders` ADD INDEX `idx_orders_create_time` ((DATE(create_time)));
-- SIA001 缺失索引候选 · error · 扫描 1,330,921 行
ALTER TABLE `orders` ADD INDEX `idx_orders_shop_id_create_time` (`shop_id`, `create_time`);
-- SIA001 缺失索引候选 · warn · 命中 2 次 · 扫描 1,842,930 行
ALTER TABLE `orders` ADD INDEX `idx_orders_user_id_status_create_time` (`user_id`, `status`, `create_time`);
```

</details>

上面每一行都带**规则 ID**、**证据 SQL** 和**可直接阅读的 DDL**。这就是它的设计前提：不是黑箱。

English docs: [README.md](README.md)。

---

## 为什么不直接问大模型

因为你无法评审一个你无法复现的东西。

| | 直接问模型 | sql-index-advisor |
|---|---|---|
| 知道你现有索引吗 | 不知道 | 知道（给 `schema.json`） |
| 同输入同输出 | 不保证 | 保证，且被测试锁死 |
| 无网络 / 无 key 能跑 | 不能 | 能，这就是默认状态 |
| 每条建议可追溯 | "相信我" | 规则 ID + 证据 + DDL |
| 能进 CI 门禁 | 不能 | 能，退出码 + PR 行级注解 |

接上 `--llm` 之后，端点只负责改写解释文案。有一条测试断言：开不开 `--llm`，findings 集合逐字节相同。

## 安装

直接走 GitHub 安装，没有 npm 包。

```bash
# 装一次，命令名是 sia
npm i -g github:JingYu-create520/sql-index-advisor

# 或者不装，一次性执行
npx --yes --package github:JingYu-create520/sql-index-advisor sia -- --help
```

需要 Node.js ≥ 18，运行时依赖 4 个，无原生编译。从 GitHub 安装时 npm 会执行 `prepare` 现场构建，所以仓库只需要打 tag，不需要提交构建产物。

## 30 秒上手

```bash
# 1. 慢查询日志，按真实耗时排序
sia /var/log/mysql/slow.log

# 2. 上线前先看一条 SQL
sia query "SELECT * FROM orders WHERE user_id=1 ORDER BY create_time DESC LIMIT 20"

# 3. 整个 MyBatis 项目，并产出可评审的迁移文件
sia mapper src/main/resources/mapper --emit-sql migrations.sql

# 4. 给 agent 或脚本用
sia examples/slow.log --format json
```

### 搞一个 `schema.json`（精度就靠它）

工具**不连数据库**。用一条纯 `information_schema` 查询自己导出（已在真实 MySQL 8.0.46 上跑通）：

```bash
mysql --database=your_db --raw --skip-column-names < examples/schema-dump.sql > schema.json
sia slow.log --schema schema.json
```

没有它，依赖现有索引的规则（`SIA002` / `SIA003` / `SIA005` / `SIA007`）会保持沉默，而且报告会明确告诉你它们为什么沉默。**沉默永远不会被报告成"没问题"。**

### 想看完整闭环？

`examples/seed-schema.sql` 会建一个"故意少建索引"的库（20 万订单、40 万订单明细），让建议有真实靶子：

```bash
docker run -d --name sia-mysql -e MYSQL_ROOT_PASSWORD=sia -e MYSQL_DATABASE=demo -p 13307:3306 mysql:8.0
docker exec -i sia-mysql mysql -uroot -psia demo < examples/seed-schema.sql
docker exec -i sia-mysql mysql --raw --skip-column-names -uroot -psia demo < examples/schema-dump.sql > schema.json

sia query "SELECT * FROM orders WHERE user_id=42 AND status='PAID' ORDER BY create_time DESC LIMIT 20" \
    --schema schema.json --emit-sql add-indexes.sql
docker exec -i sia-mysql mysql -uroot -psia demo < add-indexes.sql
docker exec sia-mysql mysql -uroot -psia demo -e "EXPLAIN SELECT * FROM orders WHERE user_id=42 AND status='PAID' ORDER BY create_time DESC LIMIT 20\G"
```

最后一条就是回报。改之前 `EXPLAIN` 只能退到不完整的 `idx_user_pay`，估算扫 23 行且带 `Using filesort`；用上推荐的 `(user_id, status, create_time)` 之后估算 **1 行**，filesort 消失。

## 规则

| ID | 名称 | 依赖 | 抓什么 |
|---|---|---|---|
| SIA001 | 缺失索引候选 | — | 访问路径无可用索引；列顺序按**等值 → 排序/GROUP BY → 范围** |
| SIA002 | 前缀索引 | schema | 过长的 `VARCHAR` / `TEXT` 进入谓词；阈值按**字节**算，不是 utf8mb3 时代的"255" |
| SIA003 | 最左前缀违反 | schema | 跳过复合索引中间列——`EXPLAIN` 的 `key` 看不出来，`key_len` 才看得出来 |
| SIA004 | 索引列上使用函数 | — | `DATE(create_time) = ?` → 左闭右开区间改写；8.0 另给函数索引方案 |
| SIA005 | 隐式类型转换 | schema | `varchar列 = 123`（只有这个方向真的会让索引失效） |
| SIA006 | 深分页 | — | 字面量 `LIMIT 100000, 20` → 延迟关联 + 游标两种改写 |
| SIA007 | 覆盖索引机会 | schema + 慢日志 | 扫描行数高但投影窄 → 扩展索引消除回表 |

每条规则的完整判定依据、误报边界和示例：**[docs/rules.md](docs/rules.md)**。

## 输出形态

| 参数 | 用途 |
|---|---|
| `--format table` | 终端可读输出（`--lang en\|zh\|auto`） |
| `--format json` | 结构稳定，给 agent 和脚本 |
| `--format github` | workflow 注解，直接变成 PR 行级评论 |
| `--emit-sql migrations.sql` | 去重后的 `ALTER TABLE ... ADD INDEX`，按表分组 |

其他参数：`--min-severity warn` · `--fail-on error` · `--top 20` · `--mysql-version 5.7` · `--prefix-bytes 3072` · `--deep-offset 10000` · `--rules SIA001,SIA004` · `--llm`。

**退出码**：`0` 没有达到 `--fail-on` 的问题 · `1` 有 · `2` 运行错误。默认 `--fail-on error`，所以第一次接到老项目上不会立刻把构建搞红。

## 接到 AI 编码助手里

**MCP server** —— 写进 `claude_desktop_config.json`、Qoder 的 MCP 配置或 `.cursor/mcp.json`：

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

四个工具：`analyze_sql`、`analyze_slow_log`、`analyze_mapper`、`explain_rules`。不想到处全局安装就用 `command: "npx"` + `args: ["--yes", "--package", "github:JingYu-create520/sql-index-advisor", "sia", "--", "mcp"]`；本地仓库则用 `command: "node"` + `args: ["dist/mcp.js"]`（或 `sia-mcp`）。每个工具都接受内联 `schema`（JSON 文本或路径都行），所以没有文件系统的 agent 也能拿到基于现有索引的精确建议。

**Agent Skill** —— `skills/sql-index-advisor/SKILL.md` 教会 agent 什么时候调用、怎么读 `Finding`、以及必须守住的红线（不代为执行 DDL、建议必须带规则号、必须把 `skipped` 说出来）。

**GitHub Action** —— 在改动的行上直接评论：

```yaml
- uses: JingYu-create520/sql-index-advisor@v0
  with:
    path: src/main/resources/mapper
    schema: schema.json        # 可选，但精度差别很大
    min-severity: warn
    fail-on: "off"             # error => 变成 PR 门禁
```

完整示例工作流：[`examples/github-action/pr-review.yml`](examples/github-action/pr-review.yml)。

## LLM 层（可选，且不参与决策）

```bash
export SIA_LLM_BASE_URL=https://api.openai.com/v1   # 任意 OpenAI 兼容端点
export SIA_LLM_API_KEY=sk-...
export SIA_LLM_MODEL=gpt-4o-mini
sia slow.log --llm
```

默认关闭：不需要 key、不联网、文案确定。开启后端点只被要求补充运维提示（"加索引前先确认这张表的写入频率"），结果落在 `finding.llmNote`。超时或 5xx 会退回内置模板，所以端点抖动不可能弄坏 CI 门禁。

## 这个工具刻意不做的事

- **不连数据库。** 没有 `EXPLAIN`，没有实时统计。只读文件分析，因此能放进沙箱化的 CI job。（`--explain` 模式排在 v2。）
- **不执行任何东西。** 只把 `ALTER TABLE` 文本写进文件交人评审，永不生成 `DROP`。
- **不自动建索引。** 建索引是带业务上下文的写放大决策，这个决策留在你手上。
- **只支持 MySQL**，不做 PostgreSQL 和其他方言。
- **宁可沉默也不猜。** 已知边界全部写在这里，不打补丁式遮掩：
  - Mapper 里的 `LIMIT #{offset}, #{size}` 没有静态值 → SIA006 判不了。这种情况请把慢日志喂进来。
  - `mobile = ?` 绑的是 Java `Long` → SIA005 看不见参数类型。
  - 相关子查询不展开；SIA006 会降级成只给模板，也不敢给出可能改变结果集的改写。

支持的 SQL 子集：单条 `SELECT` / `INSERT` / `UPDATE` / `DELETE`，ANSI JOIN 与逗号 JOIN，`WHERE` 中的 `=`、`IN`、范围、`BETWEEN`、前缀 `LIKE`、`IS NULL`，以及 `GROUP BY`、`ORDER BY`、`LIMIT`。超出这个范围的语句会被跳过并给出 `info` 提示——不会崩，也不会编造建议。

## 它答错过的地方

下面每一条都是本工具在真实 SQL 上真给出过的建议，而且每一条都是错的。把它们写出来，比让你自己撞见便宜。

**一条索引能覆盖的事，报了两次。** `WHERE sku_id = ?` 和另一条 `WHERE sku_id = ? AND warehouse_id = ?`，曾经会在同一张表上同时产出 `(sku_id)` 和 `(sku_id, warehouse_id)`。窄的是宽的最左前缀，建了不多覆盖任何东西，只多一份写放大。现在引擎在排序后跑一轮前缀冗余消除：窄的那条被丢掉，活下来的那条会说明自己吞掉了谁（`该索引同时覆盖另外 N 条查询的条件，无需重复建。`）。对应测试是 `tests/engine.test.ts` 里的 `drops a narrower index that the wider one already serves`，另外语料层还断言了"同一次运行里不可能有两条建议互为前缀"。

**给布尔标志位建索引。** `WHERE enabled = 0` 曾经会产出 `ADD INDEX (enabled)`。几百万行、两个取值的列，优化器根本不会选它——这种建议正是"索引顾问"被卸载的原因。现在单列标志位（类型是 `tinyint`/`bit`/`bool`，或者列名匹配 `is_`、`has_`、`enabled`、`deleted`、`synced`、`status`、`type` 等）依然会报，因为"极少为真且很热"的标志位确实该建，但它被压到 `info`，并且附带要先跑的验证语句：

```sql
SELECT COUNT(DISTINCT enabled) / COUNT(*) FROM stock;
```

复合索引里的标志位不扣分：`(sku_id, synced)` 是好索引，区分度由 `sku_id` 承担。这两面都被测试钉住了。

**给一个不存在的列建索引。** `SELECT SUM(amount) AS gmv ... ORDER BY gmv` 曾经要给 `gmv` 建索引，而它是输出别名，压根不是列。另一条 `WHERE amount > 1e999` 会给一个叫 `e999` 的列建索引，因为分词器把科学计数法字面量读成了"数字 + 标识符"。两处都已修复；`e999` 那个是生成语料发现的，不是手写用例发现的——这就是语料存在的理由。

**同一条查询被算成两条。** 带符号字面量当年没被归一化，`-1` 和 `1` 会把一个查询模式裂成两个指纹，于是它的 `Rows_examined` 被对半砍、排名也往后掉——工具把自己最该报的那条藏了起来。现在"跨字面量、跨正负号、跨 `IN (...)` 长度的指纹稳定性"是被断言的性质。

**两种语言互相矛盾。** 中文文案会写"已有索引只覆盖前缀，新索引可用后评估是否下线旧索引"，而英文字段在同一分支下却直接断言"no existing index serves this access path"。少翻译了一个分支，而读 `messageEn` 的 JSON / MCP 使用者拿到的是一句错误的"没问题"。现在英文与中文走同样三个分支，并有测试钉住"前缀警告必须同时出现在两边"：

```
warn  SIA001  Candidate index for orders (user_id, shop_id), ordered equality -> group/order -> range;
      only a contiguous run from the first column can be used. Existing index idx_user(user_id, pay_time)
      covers only a left prefix of the proposed one; evaluate dropping it once the new index is live.
```

**这些修复解决不了的。** 标志位判定读的是列名和类型，不是数据。40 个取值的 `status` 和只有 2 个取值的 `status` 拿到同样的警告；真正偏斜到只有一行为真的列，也拿到同样的警告。要知道真相就得统计信息，而那就意味着连你的数据库——见上一节。这个缺口不是待办，只能由建议旁边那条验证 SQL 来补。

## 尚未验证的部分

- `examples/schema-dump.sql` 只在真实 MySQL **8.0.46** 上跑通过。5.7 从未执行过；`--mysql-version 5.7` 改的是本工具输出的 DDL 文本，不构成对 5.7 服务器的任何证据。
- GitHub Action 的注解字符串只在本地断言过。这个 Action 还没有在任何人的 PR 上作为状态检查跑过。
- MCP server 在测试里完成了真实的 stdio `initialize` → `tools/list` → `tools/call` 握手，但没有在某个具体桌面客户端里配置过。

如果你撞上以上任何一条，一条带你实际执行命令的 issue，比一个 star 对这个项目更有用。

## 开发

```bash
npm ci
npm run typecheck     # tsc --noEmit，strict + noUncheckedIndexedAccess
npm test              # vitest：解析器、7 条规则、引擎、报告、MCP（含真实 stdio 握手）
npm run build         # tsup -> dist/
node dist/cli.js examples/slow.log
```

207 个测试。除了手写用例，`tests/fuzz.test.ts` 会生成约 1200 条语句再加一批刻意畸形的输入，断言那些"对任何输入都必须成立"的性质：不崩、不给不存在的列建索引、不推荐已被覆盖的索引、重复运行输出逐字节一致。这个套件抓到过两个真 bug：分词器把 `1e999` 读成 `1` 加一个名叫 `e999` 的列，以及带符号字面量把同一个查询模式裂成两个指纹。`tests/fixtures/` 里是真实形态的 MySQL 8.0 慢日志，包含一份"脏"的：有 administrator command、多行语句和一条没闭合的尾部语句。

## 许可

MIT —— 见 [LICENSE](LICENSE)。

## 同一作者的其他项目

- **spring-review** —— 同样的思路用在 Spring 事务失效、N+1 和 MyBatis XML 里的 `${}` 注入。
