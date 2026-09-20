# sql-index-advisor

[![CI](https://img.shields.io/github/actions/workflow/status/JingYu-create520/sql-index-advisor/ci.yml?branch=main&label=CI)](https://github.com/JingYu-create520/sql-index-advisor/actions/workflows/ci.yml) [![release v0.1.0](https://img.shields.io/github/v/tag/JingYu-create520/sql-index-advisor?label=release)](https://github.com/JingYu-create520/sql-index-advisor/releases/tag/v0.1.0) [![license MIT](https://img.shields.io/github/license/JingYu-create520/sql-index-advisor)](LICENSE)

**面向 MySQL / MyBatis 的离线索引顾问。慢查询日志进，索引建议 + 迁移 SQL 出。**

所有结论由确定性规则产生——可复现、可单测、**无需 API key**。LLM 只是可选的文案润色层，它无法新增、删除或重排任何一条建议。

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
```

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

工具**不连数据库**。用一条纯 `information_schema` 查询自己导出。这条脚本只经过人工审阅，还没在真实服务端跑过，如果你的版本报错请开 issue：

```bash
mysql --database=your_db --raw --skip-column-names < examples/schema-dump.sql > schema.json
sia slow.log --schema schema.json
```

没有它，依赖现有索引的规则（`SIA002` / `SIA003` / `SIA005` / `SIA007`）会保持沉默，而且报告会明确告诉你它们为什么沉默。**沉默永远不会被报告成"没问题"。**

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
- uses: JingYu-creates20/sql-index-advisor@v0
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

## 开发

```bash
npm ci
npm run typecheck     # tsc --noEmit，strict + noUncheckedIndexedAccess
npm test              # vitest：解析器、7 条规则、引擎、报告、MCP（含真实 stdio 握手）
npm run build         # tsup -> dist/
node dist/cli.js examples/slow.log
```

185 个测试。`tests/fixtures/` 里是真实形态的 MySQL 8.0 慢日志，包含一份"脏"的：有 administrator command、多行语句和一条没闭合的尾部语句。

## 许可

MIT —— 见 [LICENSE](LICENSE)。

## 同一作者的其他项目

- **spring-review** —— 同样的思路用在 Spring 事务失效、N+1 和 MyBatis XML 里的 `${}` 注入。
