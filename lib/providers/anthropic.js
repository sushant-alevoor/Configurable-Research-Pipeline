import { requireEnv, withTimeout } from './shared.js';

const ANTHROPIC_MODEL = 'claude-sonnet-5';
const ANTHROPIC_VERSION = '2023-06-01';

// Plain text-in, text-out call — used for curation and matching when a
// lane/profile's llmProvider is set to "anthropic".
export async function callClaude(systemPrompt, userMessage, maxTokens = 4096, timeoutMs = 60000) {
  const apiKey = requireEnv('ANTHROPIC_API_KEY');
  const fetchPromise = fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }]
    })
  });
  const response = await withTimeout(fetchPromise, timeoutMs, 'Claude request');
  const data = await response.json();
  if (data.error) throw new Error(data.error.message || 'Claude API error');
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  if (!text) throw new Error('Empty response from model');
  return text;
}

// Claude call using the built-in web_search tool — used for the search
// stage when a lane's searchProvider is set to "claude".
export async function callClaudeWithWebSearch(systemPrompt, userMessage, maxTokens = 8192, timeoutMs = 180000) {
  const apiKey = requireEnv('ANTHROPIC_API_KEY');
  const fetchPromise = fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }]
    })
  });
  const response = await withTimeout(fetchPromise, timeoutMs, 'Claude web_search request');
  const data = await response.json();
  if (data.error) throw new Error(data.error.message || 'Claude API error');

  const realResults = [];
  for (const block of data.content || []) {
    if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
      for (const r of block.content) {
        if (r.type === 'web_search_result') realResults.push({ title: r.title, url: r.url });
      }
    }
  }

  const textBlocks = (data.content || []).filter(b => b.type === 'text');
  const text = textBlocks.length ? textBlocks[textBlocks.length - 1].text : '';
  return { text, realResults };
}
