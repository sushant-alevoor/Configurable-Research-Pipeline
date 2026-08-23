import { requireEnv, withTimeout, truncateAtWord } from './shared.js';

export async function callTavilySearch(keyword, timeoutMs = 30000) {
  const apiKey = requireEnv('TAVILY_API_KEY');
  const fetchPromise = fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query: keyword,
      max_results: 5,
      search_depth: 'basic'
    })
  });
  const response = await withTimeout(fetchPromise, timeoutMs, 'Tavily request');
  const data = await response.json();
  if (data.detail || data.error) {
    throw new Error((data.detail && data.detail.error) || data.error || 'Tavily API error');
  }
  return (data.results || []).map(r => ({
    title: r.title || '(untitled)',
    url: r.url,
    source: (() => { try { return new URL(r.url).hostname.replace(/^www\./, ''); } catch { return ''; } })(),
    snippet: truncateAtWord(r.content, 160),
    date: r.published_date || 'unknown'
  }));
}

export async function runTavilySearchLane(keywords, log, label) {
  const settled = await Promise.allSettled(keywords.map(kw => callTavilySearch(kw)));
  const merged = [];
  const seenUrls = new Set();
  settled.forEach((res, i) => {
    if (res.status === 'rejected') {
      log(`${label}: Tavily query failed for "${keywords[i]}" — ${res.reason.message}`, 'warn');
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
