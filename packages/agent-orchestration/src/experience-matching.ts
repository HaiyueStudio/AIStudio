import type { AgentExperienceDraftV1 } from '@haiyue/ai-studio-contracts';

const normalize = (value: string) => value.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu,' ');
const word = /[\p{Script=Latin}\p{N}_]/u;
interface Hit { start: number; end: number; keyword: string }

/** Deterministic request matching, shared by live selection and release validation.
 * Natural-language condition text is explanatory; only structured rules are enforced.
 * Negation is deliberately limited to explicit local Chinese/English forms.
 */
export function matchExperience(experience: AgentExperienceDraftV1, request: string) {
  const query = request.split('\n').map(normalize).join('\n'), rules = experience.matching;
  const occurrences = (keyword: string): Hit[] => {
    const term = normalize(keyword), result: Hit[] = [];
    for (let start = query.indexOf(term); start >= 0; start = query.indexOf(term,start+term.length)) {
      const end = start+term.length;
      // Bounded local context avoids quadratic scans for long, repetitive requests.
      // The prefix prevents an artificial word boundary at a truncated word.
      const before = (start > 256 ? 'x' : '')+query.slice(Math.max(0,start-256),start), after = query.slice(end,end+64);
      // Latin words/phrases and dotted tool identifiers must not match larger identifiers.
      if (word.test(term[0]!) && (word.test(before.at(-1) ?? '') || /[.-][\p{Script=Latin}\p{N}_]*$/u.test(before))) continue;
      if (word.test(term.at(-1)!) && (word.test(after[0] ?? '') || /^[.-][\p{Script=Latin}\p{N}_]/u.test(after))) continue;
      const clause = before.split(/[，,。.!?！？;；\n]|\b(?:but|however|instead)\b|但是|但要|只要|改为|而是/iu).at(-1) ?? '';
      const negated = /(?:不要(?!忘)|不用|无需|不需要|不必|禁止|避免|排除|不使用|不采用)[^，。；!?]{0,16}$/u.test(clause)
        || /\b(?:no|not(?!\s+(?:only|forget)\b)|never|without|avoid|exclude|don't(?!\s+forget\b)|do not(?!\s+forget\b))\s+(?:[\p{L}\p{N}_'-]+\s+){0,4}$/u.test(clause);
      // “棋盘不需要修改” is also an explicit exclusion; “棋盘不能旋转” remains a problem report.
      if (negated || /^\s*(?:不需要|不用|无需)(?:修改|创建|添加|生成|使用)/u.test(after)) continue;
      result.push({start,end,keyword});
    }
    return result;
  };
  if (rules?.excludedKeywords.some(k => occurrences(k).length)) return null;
  const unique = [...new Map(experience.keywords.map(k => [normalize(k),k])).values()];
  const hits = unique.flatMap(occurrences), matchedKeywords = unique.filter(k => hits.some(h => h.keyword === k));
  if (!matchedKeywords.length || rules?.requiredKeywords.some(k => !matchedKeywords.some(m => normalize(m) === normalize(k)))) return null;
  // Nested synonyms at the same location are one signal, never multiple votes.
  const independent: Hit[] = [];
  for (const hit of hits.sort((a,b) => (b.end-b.start)-(a.end-a.start) || a.start-b.start)) {
    if (!independent.some(h => normalize(h.keyword) === normalize(hit.keyword) || hit.start < h.end && h.start < hit.end)) independent.push(hit);
  }
  if (independent.length < (rules?.minimumMatches ?? 1)) return null;
  const specificity = independent.reduce((n,h) => n+Math.min(40,h.end-h.start),0)/Math.sqrt(unique.length);
  return {matchedKeywords,coverage:independent.length/unique.length,specificity};
}
