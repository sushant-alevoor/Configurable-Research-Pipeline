// Ported directly from the artifact's parseJsonArrayLenient — same
// truncation-recovery and trailing-comma handling for LLM output.
export function parseJsonArrayLenient(rawText, stageLabel, log) {
  const firstBracket = rawText.indexOf('[');
  const text = firstBracket === -1 ? rawText : rawText.slice(firstBracket);

  const stripTrailingCommas = (s) => s.replace(/,(\s*[}\]])/g, '$1');

  try {
    return JSON.parse(text);
  } catch (e1) {
    try {
      return JSON.parse(stripTrailingCommas(text));
    } catch (e2) {
      const cleaned = stripTrailingCommas(text);
      const lastComplete = cleaned.lastIndexOf('},');
      if (lastComplete === -1) throw e2;
      const salvaged = cleaned.slice(0, lastComplete + 1) + ']';
      const result = JSON.parse(stripTrailingCommas(salvaged));
      if (log) log(`${stageLabel}: response was truncated — recovered the items found before the cutoff`, 'warn');
      return result;
    }
  }
}
