# sql-index-advisor 项目规划书

> 版本 v1.2 · 2026-09-20 · 状态:**M1~M5 已完成**，M6（发布与分发）待人工执行
> 本文档是施工依据,内容自洽。v1.1 由 `docs/PLAN-sql-index-advisor.md` 复制进仓库,并按第 0 节的审查结论修订。
>
> **进度**：M1 解析层 ✅ · M2 规则引擎 SIA001~007 ✅ · M3 输出层 + LLM 适配 ✅ ·
> M4 CLI + MCP + Skill + Action ✅ · M5 双语 README + docs/rules.md + CHANGELOG ✅ ·
> M6 发布周 ⏳（npm 发包 / HN / 掘金 / registry 收录都需要账号与对外动作，不在本地自动执行）
>
> **验收状态**：`npm run typecheck` 无错 · `npm test` 184/184 通过（含真实 stdio JSON-RPC 握手）·
> `npm run build` 成功 · 三种输入 × 四种输出 × 退出码全部实跑验证。
>
> **唯一未验证项**：`examples/schema-dump.sql` 没在真实 MySQL 上跑过（本机无数据库）。
> 发布前需人工执行一次，确认 5.7 / 8.0 都能产出合法 JSON。

---

## 0. v1.2 修订记录(开工前审查结论)

| # | 问题 | 严重度 | 修订 |
|---|---|---|---|
| R1 | 原文 SIA001 建索引顺序写"等值→范围→排序",会导致 filesort 的错误建议 | **阻断** | 改为 **等值 → 排序/GROUP BY → 范围**。索引遇范围谓词后,后续列不可用于等值与排序 |
| R2 | 缺 SQL 指纹归一化与聚合,真实慢日志同 pattern 数百条会淹没报告、排序失效 | **阻断** | 新增 `fingerprint.ts`(字面量→`?`)+ 慢日志按指纹聚合 `count/totalQueryTime/maxRowsExamined`(M1 落地) |
| R3 | 未说明 `schema.json` 如何产生,用户拿不到则 SIA002/003/005 全部退化 | **高** | 提供 `examples/schema-dump.sql`(纯 `information_schema` 查询,不连库),README 必须带 |
| R4 | `LIMIT #{offset}, #{size}` 归一化后静态不可判,Mapper 上判深分页必误报 | **高** | SIA006 **只对字面量 offset 生效**;慢日志与写死数字的 XML 才触发 |
| R5 | "需要 schema?"一列混淆了 schema 依赖与慢日志指标依赖 | 中 | `Finding` 拆 `needsSchema` / `needsMetrics` 两个标记;引擎按输入可用性门控规则 |
| R6 | "1=有发现"让 CI 首次接入即红 | 中 | 退出码改为 `0=无发现 / 1=达到 --fail-on(默认 error) / 2=运行错误`;Action 默认不硬失败 |
| R7 | `VARCHAR>255` 是 767 字节时代遗留;缺 MySQL 版本维度 | 中 | SIA002 阈值按**字节**计算且可配;新增 `--mysql-version`(默认 8.0),`schema.json` 携带版本;SIA004 额外给函数索引出路 |
| R8 | Action 要发行级评论,但 M1 未要求解析器保留行号 | 中 | `mapper.ts` / `slowlog.ts` 从 M1 起就输出 `source.line` |
| R9 | 排期乐观,自研 SQL 解析器是真实消耗点 | 提示 | M4 收窄为 **CLI + MCP 必做**,Skill + Action 移入 M6 发布周 |
| R10 | 原计划把 CLI 发到 npm（`npx sql-index-advisor`），但发布要账号且长期多一道维护面 | 决策 | **不发 npm，只走 GitHub 直装**：`npm i -g github:JingYu-create520/sql-index-advisor`，配 `prepare` 钩子现场构建。全文命令统一为 `sia`。副作用：MCP 官方 registry 这类要求 npm 包名的收录渠道走不通，届时再单独评估 |

---

## 1. 一句话定位

**面向 MySQL / MyBatis 生态的 AI 索引顾问:慢查询日志进,索引建议 + 迁移 SQL 出。核心规则引擎 100% 离线可跑、无需 API key,LLM 只是可选增强层。**

## 2. 目标用户与使用场景

| 用户 | 场景 | 入口形态 |
|---|---|---|
| Java/Spring 后端(主力) | 上线前对 Mapper XML 做索引体检 | GitHub Action / CLI |
| DBA / 性能负责人 | 每周消化慢查询日志 | CLI |
| AI 编码助手用户 | 让 Claude/Qoder/Cursor 写 SQL 时顺手要索引建议 | Agent Skill / MCP server |

## 3. 竞品与差异化(已调研,2026-09)

| 对手 | 现状 | 我们的位置 |
|---|---|---|
| 美团 SQLAdvisor | 2016 年开源,规则型、无 LLM、基本停更 | 现代规则 + LLM 增强 + 活跃维护 |
| pgAnalyze / Datadog 等 SaaS | 闭源、付费、托管 | 开源自托管、本地跑、数据不出内网 |
| 通用 LLM 直接问 ChatGPT | 无 schema 感知、结果不可复现 | 确定性规则引擎先行,LLM 只做解释润色,结果可单测可复现 |

**护城河声明(写进 README)**:每条建议都有规则 ID、证据(SQL 片段)和可验证的 DDL,不是黑箱。

## 4. 成功指标

- 北极星:发布后 30 天 ≥ 100 star(诚实目标,不画大饼)
- 过程指标:npm 周安装 ≥ 200;MCP 注册表收录;Skill 市场收录;HN/掘金至少一次单日 >50 赞的讨论

## 5. 范围

### 5.1 MVP 必须有(M1~M6 覆盖)

- 输入三件套:MySQL 慢查询日志、裸 SQL 文件/字符串、MyBatis Mapper XML
- 可选输入:`schema.json`(表结构 + 现有索引),提供后启用增强规则
- **SQL 指纹归一化 + 按指纹聚合**(R2)
- 7 条核心规则(SIA001~SIA007)
- 输出:终端报告 / `--format json` / `--emit-sql` 迁移文件
- 四形态:CLI(`npx sql-index-advisor`)、MCP server、Agent Skill、GitHub Action
- LLM 适配层:默认 Mock(离线),`--llm` 接任意 OpenAI 兼容端点
- 测试:每规则 ≥1 正 1 负用例 + 解析器快照测试

### 5.2 明确不做(v2 再说)

- 直连数据库执行 EXPLAIN(v2 加 `--explain` 模式)
- PostgreSQL / 其他方言
- Web UI / 可视化 dashboard
- 索引成本模型(写放大、存储空间估算)
- 自动创建索引(永远只生成 SQL,人来执行)

## 6. 规则清单(MVP)

统一标记两个输入依赖维度(R5):`S` = 需要 schema,`M` = 需要慢日志指标。**引擎在依赖缺失时跳过规则并在报告里注明原因,不静默、不误报。**

| ID | 名称 | 触发条件 | 输出 | 依赖 |
|---|---|---|---|---|
| SIA001 | 索引候选生成 | WHERE/JOIN/ORDER BY 列组合无可用索引 | 复合索引 DDL,顺序 **等值→排序/GROUP BY→范围**(R1)+ 最左前缀解释 | —(有 S 更准;无 S 时降级为"候选"措辞) |
| SIA002 | 前缀索引 | 参与等值的列**索引字节数**超阈值(默认按 utf8mb4 8.0=3072B/5.7=767B 反推字符数,R7) | `ALTER TABLE ... ADD INDEX idx(col(N))` | S |
| SIA003 | 最左前缀违反 | 查询条件跳过现有复合索引前缀列 | 改写建议或新索引 DDL | S |
| SIA004 | 索引列上使用函数/运算 | 如 `DATE(create_time)=...` | 改写为范围查询的等价 SQL;8.0 另给函数索引方案(R7) | — |
| SIA005 | 隐式类型转换 | **字符串列 = 数字字面量**(仅此方向索引失效;数字列 = 字符串常量转换发生在常量侧,不报) | 加引号改写 + 索引失效原理 | S |
| SIA006 | 深分页 | **字面量** `LIMIT 100000, 20` 大偏移(R4) | 延迟关联/游标改写 SQL | — |
| SIA007 | 覆盖索引机会 | SELECT 列 ⊆ 可建索引列 且 `Rows_examined` 高;`SELECT *` 不触发 | 覆盖索引 DDL | S, M |

每条规则输出统一结构(Finding):

```ts
interface Finding {
  rule: string;           // "SIA001"
  severity: "error" | "warn" | "info";
  sql: string;            // 证据 SQL(截断到 200 字符)
  fingerprint: string;    // 归一化指纹,用于聚合与去重
  source?: { file: string; line: number };  // 行级评论依赖(R8)
  queryTime?: number;     // 来自慢日志,用于按收益排序
  rowsExamined?: number;
  occurrences?: number;   // 该指纹命中次数(R2)
  message: string;        // 中文说明
  messageEn: string;      // 英文摘要
  suggestedDDL: string[]; // ALTER TABLE ... ADD INDEX ...
  rewrite?: string;       // 改写后的 SQL(SIA004/005/006)
  needsSchema: boolean;   // R5
  needsMetrics: boolean;  // R5
}
```

## 7. 架构与模块

```
sql-index-advisor/
├── src/
│   ├── core/
│   │   ├── types.ts      # QueryRecord / ParsedQuery / Finding / Schema 模型
│   │   └── input.ts      # 输入类型探测与装载
│   ├── parsers/
│   │   ├── token.ts      # 括号/引号感知的词法层(解析器共用)
│   │   ├── fingerprint.ts # 字面量归一化 + 空白折叠(R2)
│   │   ├── slowlog.ts    # 慢日志解析 + 按指纹聚合
│   │   ├── sql.ts        # 轻量SQL解析:表/WHERE等值列/IN/范围/ORDER BY/LIMIT/SELECT列
│   │   └── mapper.ts     # MyBatis XML:<select>提取,#{}→? 归一化,保留行号
│   ├── schema/
│   │   └── loader.ts     # schema.json 读取与校验(zod)
│   ├── rules/
│   │   ├── engine.ts     # 规则注册表 + 输入依赖门控 + 执行管线
│   │   └── sia001.ts ... sia007.ts
│   ├── llm/
│   │   ├── provider.ts   # interface LlmProvider { complete(prompt): Promise<string> }
│   │   ├── mock.ts       # 离线模板文案
│   │   └── openaiCompat.ts # fetch 实现,读 SIA_LLM_BASE_URL / SIA_LLM_API_KEY / SIA_LLM_MODEL
│   ├── report/
│   │   ├── terminal.ts   # 彩色表格,按 queryTime*rowsExamined 收益降序
│   │   ├── json.ts
│   │   └── migration.ts  # --emit-sql 汇总去重后的 DDL
│   ├── cli.ts            # commander,bin: sia
│   └── mcp/index.ts      # stdio MCP server
├── skills/sql-index-advisor/SKILL.md
├── action.yml
├── .github/workflows/ci.yml
├── examples/
│   ├── slow.log
│   ├── schema.json
│   ├── schema-dump.sql   # information_schema 导出脚本(R3)
│   └── mapper/UserMapper.xml
├── tests/                # vitest,每规则一文件 + 快照
├── README.md             # 英文
└── README.zh-CN.md
```

技术选型:TypeScript strict + tsup 构建 + vitest + commander + zod。运行时依赖 ≤ 6 个。SQL 解析自己写(正则 + 小状态机),不引 sqlparser 重型库——够用且包体小。

## 8. 接口设计

### CLI

```bash
npx sql-index-advisor slow.log --format table
npx sql-index-advisor query "SELECT * FROM orders WHERE user_id=1 ORDER BY create_time DESC LIMIT 20" --schema schema.json
npx sql-index-advisor mapper src/main/resources/mapper/ --emit-sql migrations.sql
# 通用 flag: --llm --format table|json|github --min-severity warn --fail-on error --top 20
#            --mysql-version 8.0 --prefix-bytes 3072
```

退出码(R6):`0` = 无发现或低于 `--fail-on`;`1` = 有达到 `--fail-on` 严重度的发现;`2` = 运行错误。

### MCP 工具面

| 工具 | 入参 | 用途 |
|---|---|---|
| `analyze_sql` | sql, schema?(内联或路径) | 单条 SQL 体检 |
| `analyze_slow_log` | path 或 content | 批量,输出按收益排序的 Top N |
| `analyze_mapper` | path(glob) | MyBatis 项目扫描 |
| `explain_rules` | ruleId? | 返回规则文档,供 agent 引用解释 |

README 提供 Claude/Qoder/Cursor 的 `mcpServers` 一行配置 JSON。

### Agent Skill

`skills/sql-index-advisor/SKILL.md`:frontmatter 写明触发条件("用户写 SQL、改 Mapper、贴慢日志时"),正文教 agent 调 `npx sql-index-advisor ... --format json` 并解读 Finding 字段。

### GitHub Action

`action.yml`(composite):checkout → `npx sql-index-advisor mapper ./ --format github` → 对变更 Mapper 文件发行级评论(依赖 `source.line`)。附 `pr-review.yml` 示例。默认不硬失败。

## 9. 里程碑与排期

> 前提:每周投入 10~15 小时。总计 2 周开发 + 1 周发布。**按 R9,真实预期为 1.5~2 倍,超出部分从 M4 尾部扣减。**

### M1 · 骨架与解析层(D1~D3)

- 仓库初始化、tsconfig/tsup/vitest、CI 空跑绿
- `core/types.ts` + `fingerprint.ts`(R2)
- slowlog.ts + 3 个真实格式 fixture + 按指纹聚合
- sql.ts 解析器:表、等值列、IN、范围、ORDER BY、LIMIT(字面量/占位符区分)、SELECT 列
- mapper.ts:`<select>` 提取 + `#{}` 归一化 + **行号** + 动态标签策略
- **验收**:`npm test` 解析器快照测试全绿;CLI 能列出输入文件里的所有 SQL 与行号

### M2 · 规则引擎 SIA001~007(D4~D7)

- engine.ts 管线(含 needsSchema/needsMetrics 门控)+ 7 条规则逐条实现(先 001/004/006,再 002/003/005,最后 007)
- schema.json 模型与 loader
- **验收**:每规则正/负用例通过;对 examples/slow.log 输出合理报告

### M3 · 输出层 + LLM 适配(D8~D9)

- terminal/json/github/migration 四种输出;按预估收益排序
- LlmProvider 三件套;`--llm` 只增强 message 文案,不改变规则结论
- **验收**:同输入下 `--llm` 开关不改变 findings 集合(测试锁定)

### M4 · 分发(D10~D12)【按 R9 收窄】

- **必做**:MCP server(先读 @modelcontextprotocol/sdk 真实类型再写,不猜 API)、npm 发包(账号需 2FA,提前注册)
- **可顺延到 M6**:SKILL.md、action.yml + pr-review.yml 示例
- **验收**:Claude/Qoder 里配 MCP 跑通一次 `analyze_sql`

### M5 · 文档与发布素材(D13~D14)

- README 双语:首屏一句话 + GIF + 30 秒 quickstart + 规则表 + "为什么不是直接问 ChatGPT" + **schema-dump.sql 用法**
- 录 demo GIF(asciinema 终端录制)
- 发布文章《我为什么给 MyBatis 项目写了个离线索引顾问》(掘金 + 英文版 dev.to)
- **验收**:README 首屏在 GitHub 暗色模式下 5 秒内能看懂它是干嘛的

### M6 · 发布周(D15~D21)

- Action + Skill 收尾并在测试仓库跑通
- 周二/周三 UTC 上午发 HN(Show HN);同步掘金/V2EX/Reddit r/mysql、r/java
- 提交收录:MCP 官方 registry、skills.sh、awesome-mysql、awesome-spring
- 48 小时内响应每条评论和 issue

## 10. 测试策略

- 单元:每规则 1 正 1 负;解析器 fixture 快照
- 金样例:`tests/golden/` 存 3 个端到端场景(慢日志/裸SQL/Mapper)的期望 JSON,diff 即失败
- 属性测试(可选):对 sql.ts 随机生成合法 SQL 不 crash
- **降级测试**:畸形/超子集 SQL 必须产出 `unsupported` 记录而非抛异常
- 明确声明:规则判定"宁可漏报不误报",误报是这类工具口碑杀手

## 11. 风险

| 风险 | 缓解 |
|---|---|
| 自研 SQL 解析器边界情况多 | 解析失败降级为"跳过该条 + info 提示",绝不 crash;文档声明支持的子集 |
| 建议质量被 DBA 挑战 | 每条 finding 附原理说明;README 明确"建议需人工评审,永不自动执行" |
| 发布后无人用 | M6 整周分发;与 spring-review 互链形成系列 |
| npm 名被占 | 注册前 `npm view sql-index-advisor` 检查,备选 `sia-cli` |

## 12. 验收清单(项目完成 = 全部勾选)

- [x] `npm install && npm run build && npm test` 全绿（206 测试，CI 在 Node 18/20/22 矩阵通过）
- [x] `sia examples/slow.log` 输出可读报告（中英两种语言实跑过）
- [x] `--emit-sql` 生成的迁移文件已去重、只含 ADD INDEX（CI smoke 机器校验；SQL 语法仍需人工评审）
- [x] MCP server 真 stdio JSON-RPC 握手实测通过（本机 + CI runner 各一次）
- [ ] MCP 在 Claude / Qoder 客户端里配置跑通一次（协议层已验证，客户端侧未测）
- [ ] GitHub Action 在靶子仓库发出行级评论
- [x] 双语 README + CHANGELOG + LICENSE(MIT)；demo 用真实终端输出，GIF 待录
- [x] ~~npm 已发布 0.1.0~~ → 按 R10 改为 GitHub 直装，已打 tag `v0.1.0` / `v0`
- [x] `examples/schema-dump.sql` 在真实 MySQL 8.0.46（Docker）上执行验证 ✅，产出合法 JSON 且被 loader 接受；5.7 仍未验证
- [x] **端到端实证**：推荐的 `(user_id, status, create_time)` 在真库执行成功，`EXPLAIN` 从 `idx_user_pay` + `Using filesort`（估 23 行）变成新索引（估 1 行、无 filesort）
- [ ] HN + 掘金 + V2EX 分发完成

## 13. 双项目总纪律(与 spring-review 共用)

### 13.1 铁律

1. 两个项目做完后**禁止开第三个新坑**,剩余精力全部投入分发。
2. 与 spring-review **错开发布 3~4 周**,本项目先发。
3. 本项目开工前,先把现有三仓库补到及格线(见 13.3)。

### 13.2 六周总时间线(每周 10~15 小时)

| 周次 | 主线 | 副线 |
|---|---|---|
| W0(本周) | 现有仓库补漏 + 账号资源准备(13.3) | 同左,合计约 1 天 |
| W1~W2 | **本项目 M1~M5 开发** | — |
| W3 | **本项目 M6 发布周** | — |
| W4~W5 | spring-review 开发(复用本项目基建) | 处理本项目 issue/反馈 |
| W6 | spring-review 发布周 | — |
| W7+ | 两个项目维护 + 长尾分发 | — |

### 13.3 W0 开工前检查清单

- [ ] **vredis 加 LICENSE 文件**、README 补"为什么造它 + 局限性"
- [ ] mcp-tool-gateway / agent-regression:README 首屏一句话定位 + 使用示例 + demo 截图;三仓库补 Topics 和 About
- [ ] GitHub 个人主页仓库写"Java 系 AI 工具集"导航
- [ ] npm 账号注册 + 开启 2FA;`npm view sql-index-advisor` 确认包名未占用(备选 `sia-cli`)
- [ ] GitHub 创建两个新仓库(先 private,发布日切 public)
- [ ] 装 asciinema 或 terminalizer
- [ ] 建"靶子 demo 仓库":埋事务失效 + N+1 + `${}` 注入的 Spring Boot 小项目,两个工具共用
- [ ] 掘金/V2EX/Reddit 账号提前几天活跃

### 13.4 已定技术决策(不再摇摆)

| 决策 | 结论 | 理由 |
|---|---|---|
| 语言 | 核心用 TypeScript | Skill/Action/MCP 生态在 node 侧最顺;Java 背景体现在"规则针对 Java 生态" |
| 仓库结构 | 两个独立仓库,不做 monorepo | 单独可安装、可收录;README 底部互链 |
| LLM 定位 | 规则引擎出结论,LLM 只润色解释 | 可复现、可单测、离线可用是差异化卖点 |
| 公共代码 | 先复制不抽包;第三个工具出现时再抽 `@jingyu/ai-cli-core` | 避免过早抽象 |
| 版本策略 | 首发 0.1.0,规则稳定后 1.0.0 | 诚实 semver,不装 1.0 |

### 13.5 发布周标准动作清单(两个项目通用)

- [ ] Show HN 标题格式:`Show HN: <一句话,离线/无需 API key 是钩子>`
- [ ] 掘金发"为什么造它"文章,文末放仓库链接;英文版发 dev.to
- [ ] Reddit:r/mysql、r/java,"我遇到 X 问题所以写了 Y"口吻
- [ ] 提交收录:MCP 官方 registry、skills.sh、awesome-mysql / awesome-spring / awesome-mcp
- [ ] 发布后 48 小时在线响应每条评论和 issue
- [ ] README 底部 "More from this author" 互链
