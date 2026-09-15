/** Comparison only: displayed content still uses the safe Markdown renderer. */
function comparable(value: string): string {
  return value.replace(/^\s{0,3}#{1,6}\s+/gmu, '').replace(/(\*\*|__|`)(.*?)\1/gu, '$2')
    .replace(/[（(](?:失败|已取消|待确认|待核验|failed|cancelled)[）)]/gu, '')
    .replace(/[\s:：]+/gu, '');
}

export function detailTextIncluded(container: string | null | undefined, value: string | null | undefined): boolean {
  if (!container || !value) return false;
  const needle = comparable(value);
  return needle.length > 0 && comparable(container).includes(needle);
}
