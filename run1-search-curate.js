import 'dotenv/config';
import path from 'node:path';
import { log } from './lib/util.js';
import { __dirname, loadConfig, loadDedupSet, runSearchLane, runCuratorLane } from './lib/pipelineCore.js';
import { loadDedupCache, recordAndSaveDedupCache } from './lib/dedupCache.js';
import { createIssue } from './lib/github.js';
import { buildIssueBody } from './lib/issueFormat.js';

const DEDUP_CACHE_PATH = path.join(__dirname, '.dedup-cache', 'seen-urls.json');

/* ============================================================
   RUN 1 — SEARCH + CURATE
   Runs Stages 1-2 only (Search, Curate), then opens a GitHub Issue
   formatted as a review checklist instead of proceeding straight to
   Match/Table generation. A human reviews and edits the checkboxes,
   then closes the Issue — which triggers run2-match-table.js via the
   issues:closed workflow.
   Usage: node run1-search-curate.js <profile-name>
============================================================ */
async function main() {
  const { config, profileName } = loadConfig();
  log(`Run1 (Search + Curate) started — profile: ${profileName}`, 'info');

  const lookbackWeeks = config.dedupLookbackWeeks || 4;
  const vaultDedupUrls = loadDedupSet(config);
  const urlCache = loadDedupCache(DEDUP_CACHE_PATH, lookbackWeeks);
  const dedupSeenUrls = new Set([...vaultDedupUrls, ...Object.keys(urlCache)]);

  const [opSearch, csSearch] = await Promise.all([
    runSearchLane('opinion', config.lanes.opinion, dedupSeenUrls),
    runSearchLane('caseStudy', config.lanes.caseStudy, dedupSeenUrls)
  ]);

  // Record every URL surfaced by this search (regardless of later curation
  // decision) so a future run — local or CI — won't resurface it. Done
  // right after search, not after curation, so this still happens even if
  // curation later fails on one lane.
  recordAndSaveDedupCache(DEDUP_CACHE_PATH, urlCache, [...opSearch, ...csSearch].map(r => r.url));

  const settled = await Promise.allSettled([
    runCuratorLane(config.lanes.opinion, opSearch),
    runCuratorLane(config.lanes.caseStudy, csSearch)
  ]);

  const laneNames = ['Opinion', 'Case Study'];
  const [opResult, csResult] = settled;
  settled.forEach((r, i) => {
    if (r.status === 'rejected') {
      log(`Run1: ${laneNames[i]} lane failed after retries and will be skipped this run — ${r.reason?.message || r.reason}`, 'error');
    }
  });
  const opCurated = opResult.status === 'fulfilled' ? opResult.value : [];
  const csCurated = csResult.status === 'fulfilled' ? csResult.value : [];
  const bothFailed = opResult.status === 'rejected' && csResult.status === 'rejected';

  if (bothFailed) {
    throw new Error('Both lanes failed during curation — nothing to review, aborting without opening an Issue.');
  }

  if (opCurated.length === 0 && csCurated.length === 0) {
    log('Run1: nothing found in either lane — skipping Issue creation this run', 'warn');
    return;
  }

  const body = buildIssueBody({ profileName, opCurated, csCurated });
  const stamp = new Date().toISOString().slice(0, 10);
  const failedLane = opResult.status === 'rejected' ? 'Opinion' : (csResult.status === 'rejected' ? 'Case Study' : null);
  const title = failedLane
    ? `Research review — ${profileName} — ${stamp} (${failedLane} lane failed — partial run)`
    : `Research review — ${profileName} — ${stamp}`;

  const issue = await createIssue({ title, body, labels: ['pending-review'] });
  log(`Run1 complete — review and close Issue #${issue.number} to trigger Match + Table generation.`, 'ok');
}

main().catch(err => {
  log(`Run1 failed: ${err.message}`, 'error');
  process.exitCode = 1;
});
