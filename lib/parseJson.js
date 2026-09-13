// Ported directly from the artifact's parseJsonArrayLenient — same
// truncation-recovery and trailing-comma handling for LLM output.

// Scans forward from `startIdx` (which must point at a '[') and returns
// the substring up to and including the matching closing ']', tracking
// string content so brackets inside quoted text don't throw off the
// depth count. Returns null if the brackets never balance (i.e. the
// response was genuinely truncated mid-array) — callers fall back to
// the existing truncation-recovery logic in that case.
function extractBalancedArray(text, startIdx) {
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') { inString = true; continue; }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return text.slice(startIdx, i + 1);
    }
  }

  return null;
}

export function parseJsonArrayLenient(rawText, stageLabel, log) {
  const firstBracket = rawText.indexOf('[');
  const text = firstBracket === -1 ? rawText : rawText.slice(firstBracket);

  const stripTrailingCommas = (s) => s.replace(/,(\s*[}\]])/g, '$1');

  // Preferred path: pull out exactly the balanced array span, so any
  // trailing prose the model appended after the closing bracket (e.g.
  // a caveat sentence when it didn't fully follow the "JSON only"
  // instruction) doesn't get handed to JSON.parse along with it.
  if (firstBracket !== -1) {
    const balanced = extractBalancedArray(rawText, firstBracket);
    if (balanced !== null) {
      try {
        return JSON.parse(balanced);
      } catch (eBalanced) {
        try {
          return JSON.parse(stripTrailingCommas(balanced));
        } catch (eBalanced2) {
          // Balanced but still malformed inside (e.g. a stray comma
          // pattern the strip regex doesn't catch) — fall through to
          // the existing recovery path below rather than give up here.
        }
      }
    }
    // balanced === null means depth never returned to 0: the response
    // was cut off mid-array. Fall through to the truncation-recovery
    // logic below, which handles exactly that case.
  }

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
