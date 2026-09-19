/** Conservative lexical hints, not a general natural-language parser or execution authority.
 * Keep the original clauses so unsupported requirements remain visible to the planner. */
export function requestRouting(request: string): Readonly<{ readOnly: boolean; prohibitEdits: boolean; noCreate: boolean; appearance: boolean; constraints: readonly string[] }> {
  const clauses = request.split(/[，。；;\n]|,(?!\d)/u).map(s => s.trim()).filter(Boolean);
  const negative = /(?:不要|禁止|不得|不能|别|不允许|do not|don't|never|must not)\s*/iu;
  const create = /创建|生成|新增|搭建|\b(?:create|build|spawn|add)\b/iu;
  const inspect = /^(?:请|先|只|仅|一下|帮我|please\s+|only\s+|just\s+)*(?:解释|说明|检查|查看|分析|explain\b|inspect\b|describe\b|review\b|check\b)/iu;
  const mutate = /修改|改成|改为|设置|创建|生成|新增|删除|移动|旋转|搭建|应用|执行|修复|配置|\b(?:change|modify|set|create|build|delete|move|rotate|implement|apply|update|configure|author|remove|clone|instantiate|repair|fix|make)\b/iu;
  const active = clauses.filter(s => !negative.test(s));
  const explanation = /^(?:请|先|只|仅|帮我|please\s+|only\s+|just\s+)*(?:解释|说明|explain\b|describe\b)/iu;
  // An unknown second clause is not evidence of a read-only request. Fall back to
  // normal planning instead of prohibiting an intended action we did not recognize.
  const readOnly = active.length > 0 && active.every(s => inspect.test(s) && (!mutate.test(s) || explanation.test(s) && !/然后|接着|\bthen\b/iu.test(s)));
  // Inspection is a routing hint; only an explicit restriction survives plan approval.
  // Keep a short source span instead of duplicating a long inspection goal.
  const explicitReadOnly = /^(?:请|please\s+)*(?:(?:只|仅)(?:解释|说明|检查|查看|分析)|(?:only|just)\s+(?:explain|inspect|describe|review|check)\b|只读|read[- ]only\b)/iu;
  const readOnlySources = clauses.flatMap(s => explicitReadOnly.exec(s)?.[0] ?? []);
  return Object.freeze({ readOnly: readOnly || readOnlySources.length > 0, prohibitEdits: readOnlySources.length > 0, noCreate: clauses.some(s => negative.test(s) && create.test(s)),
    appearance: /颜色|改色|红色|蓝色|绿色|材质|\b(?:colou?r|red|blue|green|material)\b/iu.test(request),
    constraints: Object.freeze(clauses.flatMap(s => negative.test(s) || /保持|保留|不变|\b(?:preserve|unchanged|keep)\b/iu.test(s) ? [s] : explicitReadOnly.exec(s)?.[0] ?? [])),
  });
}
