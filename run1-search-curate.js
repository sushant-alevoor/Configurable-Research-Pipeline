import 'dotenv/config';
import { log } from './lib/util.js';
import { loadConfig, loadDedupSet, runSearchLane, runCuratorLane } from './lib/pipelineCore.js';
import { createIssue } from './lib/github.js';
import { buildIssueBody } from './lib/issueFormat.js';

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

  const dedupSeenUrls = loadDedupSet(config);

  const [opSearch, csSearch] = await Promise.all([
    runSearchLane('opinion', config.lanes.opinion, dedupSeenUrls),
    runSearchLane('caseStudy', config.lanes.caseStudy, dedupSeenUrls)
  ]);

  const [opCurated, csCurated] = await Promise.all([
    runCuratorLane(config.lanes.opinion, opSearch),
    runCuratorLane(config.lanes.caseStudy, csSearch)
  ]);

  if (opCurated.length === 0 && csCurated.length === 0) {
    log('Run1: nothing found in either lane — skipping Issue creation this run', 'warn');
    return;
  }

  const body = buildIssueBody({ profileName, opCurated, csCurated });
  const stamp = new Date().toISOString().slice(0, 10);
  const title = `Research review — ${profileName} — ${stamp}`;

  const issue = await createIssue({ title, body, labels: ['pending-review'] });
  log(`Run1 complete — review and close Issue #${issue.number} to trigger Match + Table generation.`, 'ok');
}

main().catch(err => {
  log(`Run1 failed: ${err.message}`, 'error');
  process.exitCode = 1;
});
