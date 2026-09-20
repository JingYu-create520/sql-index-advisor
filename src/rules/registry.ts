import type { Rule } from "../core/types.js";

import { sia001 } from "./sia001.js";
import { sia002 } from "./sia002.js";
import { sia003 } from "./sia003.js";
import { sia004 } from "./sia004.js";
import { sia005 } from "./sia005.js";
import { sia006 } from "./sia006.js";
import { sia007 } from "./sia007.js";

/** Order matters only for the rule catalogue; findings are sorted by payoff. */
export const ALL_RULES: Rule[] = [sia001, sia002, sia003, sia004, sia005, sia006, sia007];

export function ruleById(id: string): Rule | undefined {
  return ALL_RULES.find((rule) => rule.id.toLowerCase() === id.toLowerCase());
}

export interface RuleDoc {
  id: string;
  title: string;
  titleEn: string;
  needsSchema: boolean;
  needsMetrics: boolean;
}

export function ruleCatalogue(): RuleDoc[] {
  return ALL_RULES.map((rule) => ({
    id: rule.id,
    title: rule.title,
    titleEn: rule.titleEn,
    needsSchema: rule.needsSchema,
    needsMetrics: rule.needsMetrics,
  }));
}
