import { callClaude, callClaudeWithWebSearch } from './providers/anthropic.js';
import { callGemini } from './providers/gemini.js';
import { callGroq } from './providers/groq.js';
import { runTavilySearchLane } from './providers/tavily.js';
import { runExaSearchLane } from './providers/exa.js';
import { withRetry } from './providers/shared.js';

const SUPPORTED_LLM_PROVIDERS = ['anthropic', 'gemini', 'groq'];
const SUPPORTED_SEARCH_PROVIDERS = ['claude', 'tavily', 'exa'];

// Simple per-request-count spacing (protects against RPM-style limits).
const MIN_GAP_MS = { anthropic: 300, gemini: 3500, groq: 500 };
const providerQueues = {};

function gapThrottle(providerKey, fn) {
  const minGap = MIN_GAP_MS[providerKey] || 500;
  const prev = providerQueues[providerKey] || Promise.resolve();
  const next = prev.then(async () => {
    await new Promise(res => setTimeout(res, minGap));
    return fn();
  });
  providerQueues[providerKey] = next.catch(() => {});
  return next;
}

// Some free-tier providers (Groq specifically) are bound far more tightly
// by TOKENS-per-minute than by request count — e.g. Groq's free tier is
// 8,000 TPM but 30 RPM, and a single curator call can request 3,000-5,000
// tokens. At that size, only 1-2 calls fit in any 60s window regardless of
// how far apart in time they're spaced by request count alone — a fixed
// per-request gap was fixing the wrong constraint. This tracks actual
// requested tokens in a trailing 60s window per provider, and makes a call
// wait until there's genuinely enough budget, rather than guessing a delay.
const TPM_BUDGET = { groq: 7500 }; // small safety margin under Groq's 8000
const tokenWindows = {};

async function waitForTokenBudget(providerKey, estimatedTokens) {
  const budget = TPM_BUDGET[providerKey];
  if (!budget) return; // no TPM constraint tracked for this provider
  if (!tokenWindows[providerKey]) tokenWindows[providerKey] = [];
  const WINDOW_MS = 61000; // slightly over 60s for safety margin

  // Serialize budget-checks per provider too, so concurrent callers don't
  // all read the same "current usage" and all decide they have room.
  const prev = providerQueues[`${providerKey}:tpm`] || Promise.resolve();
  const next = prev.then(async () => {
    for (;;) {
      const now = Date.now();
      const entries = tokenWindows[providerKey].filter(e => now - e.time < WINDOW_MS);
      tokenWindows[providerKey] = entries;
      const used = entries.reduce((sum, e) => sum + e.tokens, 0);
      if (used + estimatedTokens <= budget) {
        tokenWindows[providerKey].push({ time: now, tokens: estimatedTokens });
        return;
      }
      const oldest = entries[0];
      const waitMs = Math.max(1000, WINDOW_MS - (now - oldest.time) + 200);
      console.log(`  ↳ ${providerKey}: pacing for TPM budget (${used}/${budget} used in trailing 60s) — waiting ${(waitMs / 1000).toFixed(1)}s`);
      await new Promise(res => setTimeout(res, waitMs));
    }
  });
  providerQueues[`${providerKey}:tpm`] = next.catch(() => {});
  return next;
}

// Rough token estimate for pacing purposes only (not billing-accurate) —
// ~4 chars per token is a standard approximation, plus the requested
// output ceiling since that's what counts against TPM regardless of how
// much is actually used.
function estimateTokens(systemPrompt, userMessage, maxTokens) {
  const inputChars = (systemPrompt || '').length + (userMessage || '').length;
  return Math.ceil(inputChars / 4) + maxTokens;
}

// Some providers count the *requested* max_tokens against a tokens-per-
// minute budget, not just actual usage — Groq's free tier TPM cap (8,000)
// is lower than the 8192 some call sites request, so asking for the full
// amount alone can exceed the budget before input tokens are even counted.
// Cap what we actually request per-provider as a safety ceiling.
const MAX_TOKENS_CAP = { groq: 2000 };

function cappedTokens(llmProvider, requested) {
  const cap = MAX_TOKENS_CAP[llmProvider];
  return cap ? Math.min(requested, cap) : requested;
}

// Reasoning call (curation, matching) — routes on llmProvider.
// All providers return plain text; callers parse JSON out of it themselves.
// Paced by both a request-count gap and a token-budget waiter (the second
// matters far more for Groq specifically), then wrapped in retry-with-
// backoff for whatever transient errors still slip through.
export async function callLLM(llmProvider, systemPrompt, userMessage, maxTokens = 4096) {
  const cappedMaxTokens = cappedTokens(llmProvider, maxTokens);
  await waitForTokenBudget(llmProvider, estimateTokens(systemPrompt, userMessage, cappedMaxTokens));
  return gapThrottle(llmProvider, () => withRetry(() => {
    switch (llmProvider) {
      case 'anthropic':
        return callClaude(systemPrompt, userMessage, cappedMaxTokens);
      case 'gemini':
        return callGemini(systemPrompt, userMessage, cappedMaxTokens);
      case 'groq':
        return callGroq(systemPrompt, userMessage, cappedMaxTokens);
      default:
        throw new Error(`Unknown llmProvider "${llmProvider}" — must be one of: ${SUPPORTED_LLM_PROVIDERS.join(', ')}`);
    }
  }, { label: `${llmProvider} call` }));
}

// Search call — routes on searchProvider. "claude" is a special case since
// it isn't a plain search API — it's a Claude call using the web_search
// tool, so it returns { text, realResults } for the caller to parse and
// verify, rather than an already-structured results array like Tavily/Exa.
export async function runSearch(searchProvider, { keywords, log, label, claudeSystemPrompt, claudeUserMessage }) {
  switch (searchProvider) {
    case 'tavily':
      return { kind: 'structured', results: await runTavilySearchLane(keywords, log, label) };
    case 'exa':
      return { kind: 'structured', results: await runExaSearchLane(keywords, log, label) };
    case 'claude': {
      const { text, realResults } = await callClaudeWithWebSearch(claudeSystemPrompt, claudeUserMessage, 8192);
      return { kind: 'claude-raw', text, realResults };
    }
    default:
      throw new Error(`Unknown searchProvider "${searchProvider}" — must be one of: ${SUPPORTED_SEARCH_PROVIDERS.join(', ')}`);
  }
}

export { SUPPORTED_LLM_PROVIDERS, SUPPORTED_SEARCH_PROVIDERS };
