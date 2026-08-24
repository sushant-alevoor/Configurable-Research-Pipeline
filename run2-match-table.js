import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { log } from './lib/util.js';
import { __dirname, loadConfig, runMatcher, buildMarkdownTables } from './lib/pipelineCore.js';
import { getIssue, issueNumberFromEnv, commentOnIssue } from './lib/github.js';
import { parseIssueBody } from './lib/issueFormat.js';

/* ============================================================
   RUN 2 — MATCH + TABLE GENERATION
   Triggered by the issues:closed GitHub Actions event (filtered to the
   pending-review label). Recovers the curated article set and the
   reviewer's final Include/Exclude decisions from the closed Issue's
   body, then runs Stages 3-4 (Match, Table generation) and writes the
   draft — exactly as pipeline.js used to do in a single run.
   Requires GITHUB_ISSUE_NUMBER env var (set by the workflow from
   github.event.issue.number). Config profile is read from the Issue
   body itself, not from CLI args, since run1 already resolved it.
============================================================ */
async function main() {
  const issueNumber = issueNumberFromEnv();
  log(`Run2 (Match + Table) started — reading Issue #${issueNumber}`, 'info');

  const issue = await getIssue(issueNumber);
  if (issue.state !== 'closed') {
    log(`Run2: Issue #${issueNumber} is not closed (state: ${issue.state}) — nothing to do`, 'warn');
    return;
  }

  const { profileName, opCurated, csCurated } = parseIssueBody(issue.body || '');
  log(`Run2: recovered ${opCurated.length} opinion + ${csCurated.length} case study articles from Issue #${issueNumber} — profile: ${profileName}`, 'info');

  // Reload the same config profile run1 used, purely for matcherPrompt /
  // matcherLlmProvider / per-lane maxArticles — search/curate config isn't
  // needed again here.
  process.argv[2] = profileName;
  const { config } = loadConfig();

  const opInclude = opCurated.filter(r => r.decision === 'Include');
  const csInclude = csCurated.filter(r => r.decision === 'Include');
  log(`Run2: final decisions — ${opInclude.length} opinion / ${csInclude.length} case study article(s) included after review`, 'info');

  const matches = await runMatcher(config.matcherPrompt, config.matcherLlmProvider, opInclude, csInclude);

  const { matchedMd, opMd, csMd, counts } = buildMarkdownTables({
    matches, opInclude, csInclude, opCurated, csCurated,
    opMax: config.lanes.opinion.maxArticles, csMax: config.lanes.caseStudy.maxArticles
  });

  const outDir = path.join(__dirname, 'output');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const outPath = path.join(outDir, `draft-${profileName}-${stamp}.md`);
  fs.writeFileSync(outPath, `${matchedMd}\n${opMd}\n${csMd}`, 'utf8');

  log(`Tables generated: ${counts.matched} matched, ${counts.opinion} opinion, ${counts.caseStudy} case study.`, 'ok');
  log(`Draft written to ${outPath} — review it, then append into your Obsidian vault manually.`, 'ok');

  const commentBody = `## 📄 Draft ready — ${profileName} — ${stamp}

${matchedMd}
${opMd}
${csMd}`;
  await commentOnIssue(issueNumber, commentBody);
}

main().catch(err => {
  log(`Run2 failed: ${err.message}`, 'error');
  process.exitCode = 1;
});
