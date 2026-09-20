import type { LlmProvider } from "./provider.js";
import { ruleById } from "../rules/registry.js";

/**
 * Offline "explanations".
 *
 * The default provider is deliberately not a model: the tool must produce the
 * same output on a laptop with no network and in a CI runner with no API key.
 * Templates are keyed by rule so the wording stays useful rather than generic.
 */

const TEMPLATES: Record<string, string> = {
  SIA001: "执行前先确认这张表的写入频率：低频读多写少的表加索引几乎只有收益，高频写入的大表要评估额外索引带来的写放大。",
  SIA002: "前缀长度不要用默认值：先跑结论里那条区分度 SQL，把 N 调到能区分 95% 以上的值为止。",
  SIA003: "优先补条件而不是加索引：能让业务带上被跳过的那一列，现有索引立刻就能用满，成本为零。",
  SIA004: "改写完记得回归测试：区间边界是左闭右开，跨天/跨时区的历史数据最容易在这里出偏差。",
  SIA005: "顺手检查 Java 侧的入参类型：这次是字面量，下次很可能来自一个声明成 Long 的 DTO 字段。",
  SIA006: "延迟关联只解决扫描量，不解决跳页：如果业务允许，把翻页交互改成游标加载，收益比建索引更大。",
  SIA007: "覆盖索引会变宽，务必确认这条 SQL 真的是热点：慢日志里它的总耗时要排在前面，否则不值得为它付写放大。",
};

const GENERIC = "先把这条建议当成假设：用 EXPLAIN 验证一次，再决定要不要落到线上。";

export const mockProvider: LlmProvider = {
  name: "mock",
  async complete(prompt: string): Promise<string> {
    const rule = /^规则：(SIA\d{3})/m.exec(prompt)?.[1];
    const title = rule ? ruleById(rule)?.title : undefined;
    return `${rule ? `${rule} ${title ?? ""}：` : ""}${TEMPLATES[rule ?? ""] ?? GENERIC}`.trim();
  },
};
