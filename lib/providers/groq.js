import { requireEnv, withTimeout } from './shared.js';

// llama-3.3-70b-versatile was deprecated by Groq (June 2026) — this is
// their documented recommended replacement for general reasoning/
// classification tasks like curation and matching.
const GROQ_MODEL = 'openai/gpt-oss-120b';

// Plain text-in, text-out call — used for curation and matching when a
// lane/profile's llmProvider is set to "groq". Note: Groq's free tier caps
// at 6,000 tokens/minute (TPM), tighter than its 30 requests/minute limit —
// keep curatorBatchSize modest (e.g. 10-12) when using this provider, since
// a large batch's input+output can approach that ceiling in one call.
export async function callGroq(systemPrompt, userMessage, maxTokens = 4096, timeoutMs = 60000) {
  const apiKey = requireEnv('GROQ_API_KEY');
  const fetchPromise = fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ]
    })
  });
  const response = await withTimeout(fetchPromise, timeoutMs, 'Groq request');
  const data = await response.json();
  if (data.error) throw new Error(data.error.message || 'Groq API error');

  const choice = (data.choices || [])[0];
  if (!choice) throw new Error('Empty response from Groq (no choices returned)');
  const text = choice.message?.content || '';
  if (!text) throw new Error(`Empty text from Groq (finish_reason: ${choice.finish_reason || 'unknown'})`);
  return text;
}
