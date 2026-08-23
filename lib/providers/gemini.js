import { requireEnv, withTimeout } from './shared.js';

// Flash is the free-tier-eligible model and is plenty for curation/matching
// style JSON-out tasks. Swap here if you want Pro for a specific run.
const GEMINI_MODEL = 'gemini-3.6-flash';

// Plain text-in, text-out call — used for curation and matching when a
// lane/profile's llmProvider is set to "gemini". Not wired into the search
// stage — Gemini's search-grounding tool has a different shape to Claude's
// web_search and Tavily/Exa's plain search API, and is out of scope for
// this pass (see README roadmap).
export async function callGemini(systemPrompt, userMessage, maxTokens = 4096, timeoutMs = 60000) {
  const apiKey = requireEnv('GEMINI_API_KEY');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const fetchPromise = fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userMessage }] }],
      generationConfig: {
        maxOutputTokens: maxTokens,
        // Gemini 3.x replaced the legacy numeric thinkingBudget with a
        // thinkingLevel enum — sending thinkingBudget on a 3.x model is a
        // hard error ("invalid argument"). "minimal" is Google's documented
        // recommendation for high-volume classification/extraction tasks
        // like curation and matching, where we want fast structured JSON
        // output rather than deep reasoning eating the output token budget.
        thinkingConfig: { thinkingLevel: 'minimal' }
      }
    })
  });
  const response = await withTimeout(fetchPromise, timeoutMs, 'Gemini request');
  const data = await response.json();
  if (data.error) throw new Error(data.error.message || 'Gemini API error');

  const candidate = (data.candidates || [])[0];
  if (!candidate) throw new Error('Empty response from Gemini (no candidates — check finishReason/safety ratings if this recurs)');
  const text = (candidate.content?.parts || []).map(p => p.text || '').join('');
  if (!text) throw new Error(`Empty text from Gemini (finishReason: ${candidate.finishReason || 'unknown'})`);
  return text;
}
