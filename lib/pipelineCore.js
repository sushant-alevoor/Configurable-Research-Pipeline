import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log, isPaywalled } from './util.js';
import { buildDedupSeenSet, loadVaultFile } from './dedup.js';
import { callLLM, runSearch } from './providerRouter.js';
import { parseJsonArrayLenient } from './parseJson.js';

// This file lives in lib/, so the repo root (matching what pipeline.js's
// own __dirname used to resolve to, since pipeline.js sat at the repo root)
// is one directory up from here.
const __libDirname = path.dirname(fileURLToPath(import.meta.url));
export const __dirname = path.dirname(__libDirname);

/* ============================================================
   CONFIG LOADING
============================================================ */
export function loadConfig() {
  const profileName = process.argv[2] || process.env.CONFIG_PROFILE;
  if (!profileName) {
    throw new Error('No config profile given. Usage: node run1-search-curate.js <profile-name> (matches a file in config/<profile-name>.json)');
  }
  const configPath = path.join(__dirname, 'config', `${profileName}.json`);
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config profile not found: ${configPath}`);
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  return { config, profileName };
}

export function loadDedupSet(config) {
  const vaultPath = config.obsidianVaultPath ? path.resolve(__dirname, config.obsidianVaultPath) : null;
  const vaultText = loadVaultFile(vaultPath);
  let dedupSeenUrls = new Set();
  if (vaultText) {
    const { seen, keptBuckets, totalBuckets } = buildDedupSeenSet(vaultText, config.dedupLookbackWeeks || 0);
    dedupSeenUrls = seen;
    log(`Dedup: loaded ${seen.size} already-covered URL(s) from ${keptBuckets}/${totalBuckets} dated section(s) (last ${config.dedupLookbackWeeks}wk)`, 'info');
  } else {
    log(`Dedup: no vault file found at ${vaultPath || '(none configured)'} — skipping dedup filter this run`, 'muted');
  }
  return dedupSeenUrls;
}

function buildSearchSystemPrompt() {
  return `You are a web research agent. Use the web_search tool to search for each of the given keywords/phrases. Run enough searches to cover all the keyword clusters, but do not exceed one search per keyword.

PRIORITIZE RECENTLY PUBLISHED MATERIAL: when multiple relevant results exist for a keyword, prefer the most recently published ones over older material — recency is a factor alongside relevance to the keywords, not an afterthought.

After searching, compile a JSON array of AT MOST 15 of the most relevant articles you found — quality over quantity. Each object must have:
- title: the article's real title from the search result
- url: the EXACT url returned by web_search — never alter, guess, or construct a url
- source: publication/domain name
- snippet: ONE short sentence (max ~20 words) based on the actual search result content
- date: the article's date if known, else "unknown"

CRITICAL: only include articles that came from an actual web_search tool result. Do not invent, guess, or hallucinate any article, title, or URL. If you are unsure a URL is real, leave it out. Keep snippets short so the full JSON array fits comfortably in your response.

After you finish searching, respond with ONLY the JSON array as your final message — no markdown, no preamble.`;
}

/* ============================================================
   STAGE 1 — SEARCH
============================================================ */
export async function runSearchLane(laneKey, laneConfig, dedupSeenUrls) {
  const label = `Search (${laneConfig.label})`;
  const searchProvider = laneConfig.searchProvider || 'claude';
  let results;

  if (searchProvider === 'mock') {
    log(`${label}: using MOCK search fixture — no real search API called`, 'warn');
    const fixturePath = path.join(__dirname, 'lib', 'fixtures', 'mockSearchResults.json');
    const fixtures = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    results = fixtures[laneKey] || [];
    log(`${label}: loaded ${results.length} mock candidate(s)`, 'ok');
  } else if (searchProvider === 'tavily' || searchProvider === 'exa') {
    const providerName = searchProvider[0].toUpperCase() + searchProvider.slice(1);
    log(`${label}: querying ${providerName} directly for ${laneConfig.keywords.length} keyword(s) — no LLM tokens used for search`, 'info');
    const { results: r } = await runSearch(searchProvider, { keywords: laneConfig.keywords, log, label });
    results = r;
    log(`${label}: ${providerName} returned ${results.length} unique candidate(s) across all keywords`, 'ok');
  } else {
    log(`${label}: querying ${laneConfig.keywords.length} keyword clusters via Claude web_search`, 'info');
    const userMsg = `Keywords to search: ${laneConfig.keywords.join(', ')}
Excluded topics (skip articles primarily about these): ${(laneConfig.excludedTopics || []).join(', ')}
Focus on recent, credible sources (consulting firms, academic institutions, business publications).
Return at most 15 articles total, not per keyword.`;

    const { text, realResults } = await runSearch('claude', {
      claudeSystemPrompt: buildSearchSystemPrompt(),
      claudeUserMessage: userMsg
    });
    const clean = text.replace(/```json|```/g, '').trim();
    let parsed = parseJsonArrayLenient(clean, label, log);

    const realUrls = new Set(realResults.map(r => r.url));
    const before = parsed.length;
    parsed = parsed.filter(r => realUrls.has(r.url));
    const dropped = before - parsed.length;
    if (dropped > 0) log(`${label}: dropped ${dropped} article(s) with unverified URLs`, 'warn');
    results = parsed;
  }

  if (dedupSeenUrls.size > 0) {
    const before = results.length;
    results = results.filter(r => !dedupSeenUrls.has(r.url));
    const dropped = before - results.length;
    if (dropped > 0) log(`${label}: dropped ${dropped} already-covered article(s)`, 'warn');
  }

  results = results.map((r, i) => ({ ...r, id: i, lane: laneKey }));
  log(`${label}: found ${results.length} candidate articles`, 'ok');
  return results;
}

/* ============================================================
   STAGE 2 — CURATE
============================================================ */
export async function runCuratorLane(laneConfig, searchResults) {
  const label = `Curator (${laneConfig.label})`;
  log(`${label}: evaluating ${searchResults.length} articles against criteria`, 'info');

  if (searchResults.length === 0) return [];

  const batchSize = laneConfig.curatorBatchSize || 20;
  const batches = [];
  for (let i = 0; i < searchResults.length; i += batchSize) {
    batches.push(searchResults.slice(i, i + batchSize));
  }
  if (batches.length > 1) {
    log(`${label}: splitting ${searchResults.length} articles into ${batches.length} batches of up to ${batchSize}`, 'info');
  }

  const todayStr = new Date().toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' });
  const bySearchId = {};
  searchResults.forEach(r => { bySearchId[r.id] = r; });

  let curated = [];
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const articlesJson = JSON.stringify(batch.map(r => ({
      id: r.id, title: r.title, source: r.source, snippet: r.snippet, url: r.url, date: r.date || 'unknown'
    })));

    const userMsg = `Evaluate these articles. Relevance threshold is ${laneConfig.threshold}/10 — articles scoring below this should be Excluded unless they warrant a Flag.

Today's date is ${todayStr}. Recency cutoff for this lane is ${laneConfig.recencyCutoffMonths} month(s) — score down articles older than this per the RECENCY guidance in your system prompt (soft signal, not automatic exclusion). Articles with date "unknown" get a mild penalty too.

Articles:
${articlesJson}

Return a JSON array with one object per article (same order), each with: id, decision, score, reason, tier.`;

    const raw = await callLLM(laneConfig.llmProvider || 'anthropic', laneConfig.curatorPrompt, userMsg, 8192);
    const clean = raw.replace(/```json|```/g, '').trim();
    const batchLabel = batches.length > 1 ? `${label} (batch ${b + 1}/${batches.length})` : label;
    const assessments = parseJsonArrayLenient(clean, batchLabel, log);
    curated.push(...assessments.filter(a => bySearchId[a.id]).map(a => ({ ...bySearchId[a.id], ...a })));
  }

  curated = curated.map(r => ({ ...r, paywalled: isPaywalled(r) }));

  // Optional hard age-limit backstop filter, applied after LLM scoring.
  if (laneConfig.hardAgeLimitMonths) {
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - laneConfig.hardAgeLimitMonths);
    const before = curated.length;
    curated = curated.filter(r => {
      if (!r.date || r.date === 'unknown') return true;
      const d = new Date(r.date);
      if (isNaN(d)) return true;
      return d >= cutoff;
    });
    const dropped = before - curated.length;
    if (dropped > 0) log(`${label}: hard age-limit backstop dropped ${dropped} article(s) older than ${laneConfig.hardAgeLimitMonths}mo`, 'warn');
  }

  const included = curated.filter(r => r.decision === 'Include').length;
  const flagged = curated.filter(r => r.decision === 'Flag').length;
  const excluded = curated.filter(r => r.decision === 'Exclude').length;
  log(`${label}: ${included} included, ${flagged} flagged, ${excluded} excluded`, 'ok');
  return curated;
}

/* ============================================================
   STAGE 3 — MATCH
============================================================ */
export async function runMatcher(matcherPrompt, matcherLlmProvider, opInclude, csInclude) {
  log(`Matcher Agent: comparing ${opInclude.length} opinion articles against ${csInclude.length} case studies`, 'info');

  if (opInclude.length === 0 || csInclude.length === 0) {
    log('Matcher Agent: nothing to pair — one or both lanes have no Included articles', 'warn');
    return [];
  }

  const opJson = JSON.stringify(opInclude.map(r => ({ id: r.id, title: r.title, reason: r.reason, snippet: r.snippet })));
  const csJson = JSON.stringify(csInclude.map(r => ({ id: r.id, title: r.title, reason: r.reason, snippet: r.snippet })));

  const userMsg = `Opinion articles:
${opJson}

Case study articles:
${csJson}

Propose loose thematic pairings per the rules in your system prompt.`;

  const raw = await callLLM(matcherLlmProvider || 'anthropic', matcherPrompt, userMsg, 4096);
  const clean = raw.replace(/```json|```/g, '').trim();
  let proposed = parseJsonArrayLenient(clean, 'Matcher Agent', log);

  const seenOp = new Set(), seenCs = new Set();
  proposed = proposed.filter(m => {
    if (seenOp.has(m.opinion_id) || seenCs.has(m.case_study_id)) return false;
    seenOp.add(m.opinion_id); seenCs.add(m.case_study_id);
    return true;
  });

  log(`Matcher Agent: proposed ${proposed.length} pairing(s)`, 'ok');
  return proposed;
}

/* ============================================================
   TABLE GENERATION
============================================================ */
function linkFor(r) {
  const label = (r.source || 'Link') + (r.paywalled ? ' (paywalled)' : '');
  return `[${label}](${r.url})`;
}

export function buildMarkdownTables({ matches, opInclude, csInclude, opCurated, csCurated, opMax, csMax }) {
  const findOp = (id) => opCurated.find(r => r.id === id);
  const findCs = (id) => csCurated.find(r => r.id === id);
  const now = new Date().toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const opIncludeIds = new Set(opInclude.map(r => r.id));
  const csIncludeIds = new Set(csInclude.map(r => r.id));
  const validMatches = matches.filter(m => {
    const ok = opIncludeIds.has(m.opinion_id) && csIncludeIds.has(m.case_study_id);
    if (!ok) log(`Matcher Agent: dropped a proposed pairing referencing an id outside the Included set (opinion_id=${m.opinion_id}, case_study_id=${m.case_study_id})`, 'warn');
    return ok;
  });

  const matchedOpIds = new Set(validMatches.map(m => m.opinion_id));
  const matchedCsIds = new Set(validMatches.map(m => m.case_study_id));

  const opUnmatched = opInclude.filter(r => !matchedOpIds.has(r.id)).slice(0, opMax);
  const csUnmatched = csInclude.filter(r => !matchedCsIds.has(r.id)).slice(0, csMax);

  const matchedRows = validMatches.map(m => {
    const op = findOp(m.opinion_id), cs = findCs(m.case_study_id);
    if (!op || !cs) return null;
    const opTitle = (op.title || '').replace(/\|/g, '/');
    const csTitle = (cs.title || '').replace(/\|/g, '/');
    const why = (m.rationale || '').replace(/\|/g, '/').trim();
    return `| ${opTitle} | ${csTitle} | ${why} | ${linkFor(op)} · ${linkFor(cs)} |`;
  }).filter(Boolean);
  const matchedTable = ["| Opinion Article | Case Study Article | Why They're Linked | Links |", '|---|---|---|---|', ...matchedRows].join('\n');
  const matchedMd = `# Matched Pairs — ${now}\n\n${matchedTable}\n`;

  const opRows = opUnmatched.map((r, i) => `| ${i + 1} | ${(r.reason || r.snippet || '').replace(/\|/g, '/').trim()} | ${linkFor(r)} |`);
  const opTable = ['| Article # | Why You Should Read This | Link |', '|---|---|---|', ...opRows].join('\n');
  const opMd = `# Opinion Digest (Unmatched) — ${now}\n\n${opTable}\n`;

  const csRows = csUnmatched.map((r, i) => `| ${i + 1} | ${(r.reason || r.snippet || '').replace(/\|/g, '/').trim()} | ${linkFor(r)} |`);
  const csTable = ['| Article # | Why You Should Read This | Link |', '|---|---|---|', ...csRows].join('\n');
  const csMd = `# Case Study Digest (Unmatched) — ${now}\n\n${csTable}\n`;

  return { matchedMd, opMd, csMd, counts: { matched: matchedRows.length, opinion: opRows.length, caseStudy: csRows.length } };
}
