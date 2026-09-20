---
name: sql-index-advisor
description: 为 MySQL / MyBatis 项目做索引体检。当用户写 SQL、改 Mapper XML、贴出慢查询日志、问到索引/最左前缀/建索引建议、或说"这条查询很慢"时使用；产出规则 ID、证据 SQL、可执行的 ALTER TABLE 与改写语句。
---

# SQL Index Advisor

一个离线、确定性的索引顾问：慢查询日志 / 裸 SQL / MyBatis Mapper 进，索引建议 + 迁移 SQL 出。结论由 7 条规则产生，可复现、可单测，**不连接数据库，不执行任何 DDL**。

## 什么时候用

- 用户贴了一条 SQL 并问"要建什么索引"
- 用户改了 MyBatis mapper XML，上线前想体检
- 用户贴了慢查询日志片段或 `.log` 文件路径
- 用户问最左前缀、前缀索引、深分页、隐式类型转换、覆盖索引

## 怎么调用

优先用 MCP 工具（若已配置）：

| 工具 | 何时用 |
|---|---|
| `analyze_sql` | 单条 / 多条 SQL |
| `analyze_slow_log` | 慢日志文件或内容（会按 SQL 指纹聚合） |
| `analyze_mapper` | mapper XML 文件或目录（返回行号，可做 PR 行级评论） |
| `explain_rules` | 需要向用户解释某条规则的判定依据时 |

没有 MCP 时用 CLI：

```bash
sia query "SELECT * FROM orders WHERE user_id=1 ORDER BY create_time DESC LIMIT 20" --format json
sia /path/to/slow.log --schema schema.json --format json
sia mapper src/main/resources/mapper --emit-sql migrations.sql --format json
```

始终带 `--format json` 再自己解读，不要解析彩色表格。

## 怎么读结果

每个 `finding` 都有固定字段：

- `rule` — SIA001~SIA007，向用户报建议时**带上规则号**，这是可追溯性的来源
- `sql` — 证据 SQL 片段
- `suggestedDDL` — 可直接评审的 `ALTER TABLE ... ADD INDEX`；空数组表示这条只需要改 SQL
- `rewrite` — 改写后的 SQL 或改写后的谓词（SIA004/005/006 才有）
- `message` / `messageEn` — 原理说明，转述给用户时保留原理，不要只给结论
- `source.line` — 来自哪个文件的第几行
- `skipped` — **哪些规则因为缺输入没参与判定**。非空时必须告诉用户"加 `--schema` 能覆盖更多规则"，不能说"没发现问题"

## 必须遵守

1. 建议给人评审，**永远不要代替用户执行 DDL**，也不要写进自动迁移流程。
2. 只报告工具真实产出的内容。工具没说的原理不要自己补——它的说服力恰恰来自每条建议都能追溯到规则号和证据 SQL。
3. 没有 `schema.json` 时精度会下降（SIA002/003/005/007 依赖它），要明说是"候选"而不是"结论"，并提示用 `examples/schema-dump.sql` 导出。
4. 用户要 SQL 改写时，把 `rewrite` 原文给出，不要自己臆造等价的日期边界或表连接改法。
5. 深分页只有在 `LIMIT` 是**字面量**时才会报（MyBatis 里的 `#{offset}` 静态判不了），工具沉默不等于没问题——需要时提醒用户拿慢日志来看。
