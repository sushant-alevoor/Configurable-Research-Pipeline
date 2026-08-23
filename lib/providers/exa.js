import { requireEnv, withTimeout, truncateAtWord } from './shared.js';

// Exa's neural/semantic search can be a stronger fit for keyword clusters
// that are really "find me things like X" rather than exact-match terms.
// Same output shape as Tavily's so runSearchLane can treat them
// interchangeably via the searchProvider config field.
export async function callExaSearch(keyword, timeoutMs = 30000) {
  const apiKey = requireEnv('EXA_API_KEY');
  const fetchPromise = fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey
    },
    body: JSON.stringify({
      query: keyword,
      numResults: 5,
      type: 'neural',
      contents: { text: { maxCharacters: 200 } }
    })
  });
  const response = await withTimeout(fetchPromise, timeoutMs, 'Exa request');
  const data = await response.json();
  if (data.error) throw new Error(data.error || 'Exa API error');
  return (data.results || []).map(r => ({
    title: r.title || '(untitled)',
    url: r.url,
    source: (() => { try { return new URL(r.url).hostname.replace(/^www\./, ''); } catch { return ''; } })(),
    snippet: truncateAtWord(r.text, 160),
    date: r.publishedDate || 'unknown'
  }));
}

export async function runExaSearchLane(keywords, log, label) {
  const settled = await Promise.allSettled(keywords.map(kw => callExaSearch(kw)));
  const merged = [];
  const seenUrls = new Set();
  settled.forEach((res, i) => {
    if (res.status === 'rejected') {
      log(`${label}: Exa query failed for "${keywords[i]}" — ${res.reason.message}`, 'warn');
      return;
    }
    for (const r of res.value) {
      if (r.url && !seenUrls.has(r.url)) {
        seenUrls.add(r.url);
        merged.push(r);
      }
    }
  });
  return merged;
}
