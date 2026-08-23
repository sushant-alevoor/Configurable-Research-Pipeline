export function requireEnv(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

export async function withTimeout(promise, timeoutMs, label) {
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs / 1000}s`)), timeoutMs)
  );
  return Promise.race([promise, timeoutPromise]);
}

// Truncates at a word boundary rather than mid-word, and marks that it was
// cut off. Used for raw search snippets, which are only ever a fallback
// display value (the curator's own written "reason" is preferred wherever
// this snippet is shown) — but a fallback should still read cleanly if it
// does get used.
export function truncateAtWord(text, maxLen = 160) {
  if (!text || text.length <= maxLen) return text || '';
  const cut = text.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trim() + '…';
}

const TRANSIENT_PATTERNS = /high demand|overloaded|rate limit|429|503|temporarily unavailable|try again later|quota|exceeded/i;

function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

// Providers often include a concrete suggested delay in their error
// message — honor that directly when present instead of guessing with our
// own backoff schedule, since it reflects the actual quota window. Phrasing
// varies by provider: Gemini says "retry in N.NNs", Groq says "try again in
// N.NNs" — match both.
function extractSuggestedDelayMs(message) {
  const match = /(?:retry|try again) in\s+([\d.]+)s/i.exec(message || '');
  return match ? Math.ceil(parseFloat(match[1]) * 1000) : null;
}

// Retries a provider call on transient errors (server overload, rate
// limits, quota exhaustion) with exponential backoff — or the provider's
// own suggested delay, when it gives one. Non-transient errors (bad
// request, auth failure, malformed JSON) fail immediately — no point
// retrying those.
export async function withRetry(fn, { retries = 4, baseDelayMs = 2000, label = 'request' } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const isTransient = TRANSIENT_PATTERNS.test(err.message || '');
      if (!isTransient || attempt === retries) throw err;
      const suggested = extractSuggestedDelayMs(err.message);
      const delay = suggested != null ? suggested + 1000 : baseDelayMs * Math.pow(2, attempt);
      console.log(`  ↳ ${label}: transient error ("${err.message}") — retrying in ${(delay / 1000).toFixed(1)}s (attempt ${attempt + 1}/${retries})`);
      await sleep(delay);
    }
  }
  throw lastErr;
}
