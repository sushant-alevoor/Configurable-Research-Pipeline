// The Issue body is the single source of truth passed between run1 and
// run2 — no separate file or Actions artifact needed. It has two parts:
//   1. A human-facing checklist (one checkbox per curated article, grouped
//      by lane) — this is what the reviewer actually edits before closing
//      the Issue.
//   2. A hidden <details> block containing the full curated article data
//      (title, url, snippet, score, reason, etc.) as JSON — the checklist
//      alone only carries checkbox state, not the article data itself, so
//      run2 needs this to reconstruct the full objects.
// Each checklist line carries an HTML comment (invisible when rendered)
// encoding "lane:id" so run2 can map checkbox state back to a specific
// article regardless of how the reviewer reorders or edits surrounding text.

const RAW_DATA_MARKER_START = '<!-- PIPELINE_RAW_DATA_START';
const RAW_DATA_MARKER_END = 'PIPELINE_RAW_DATA_END -->';
const REASON_MAX_CHARS = 180;
// GitHub caps Issue bodies at 65,536 characters. Excluded articles (the
// large majority most weeks — e.g. 38/49 or 70/80 in a typical run) don't
// need a human decision, so they're dropped from both the checklist and
// the raw data entirely and rolled into a one-line count instead. Only
// Include/Flag articles get full detail, and text fields are truncated
// to keep the embedded JSON lean.
function truncate(s, max) {
  if (!s) return '';
  const clean = s.replace(/\n/g, ' ').trim();
  return clean.length > max ? clean.slice(0, max - 1) + '…' : clean;
}

function slimArticle(r) {
  return {
    id: r.id,
    lane: r.lane,
    title: truncate(r.title, 200),
    url: r.url,
    decision: r.decision,
    score: r.score,
    reason: truncate(r.reason || r.snippet, REASON_MAX_CHARS)
  };
}

function checklistLine(r) {
  const checked = r.decision === 'Include' ? 'x' : ' ';
  const score = r.score !== undefined ? `${r.score}/10` : 'n/a';
  return `- [${checked}] **${truncate(r.title, 200) || 'untitled'}** (${r.decision}, score ${score}) — ${truncate(r.reason || r.snippet, REASON_MAX_CHARS)} [link](${r.url}) <!-- id:${r.lane}:${r.id} -->`;
}

function laneSection(curated) {
  const reviewable = curated.filter(r => r.decision === 'Include' || r.decision === 'Flag');
  const excludedCount = curated.length - reviewable.length;
  const lines = reviewable.map(checklistLine).join('\n') || '_(nothing to review)_';
  const note = excludedCount > 0 ? `\n\n_${excludedCount} article(s) the curator Excluded are omitted here — not shown, not editable._` : '';
  return { lines: lines + note, reviewable };
}

export function buildIssueBody({ profileName, opCurated, csCurated }) {
  const op = laneSection(opCurated);
  const cs = laneSection(csCurated);

  // Raw data only carries reviewable (Include/Flag) articles, slimmed —
  // run2 only ever matches/tables Included articles, so nothing is lost
  // by dropping Excluded ones here.
  const rawData = JSON.stringify({
    profileName,
    opCurated: op.reviewable.map(slimArticle),
    csCurated: cs.reviewable.map(slimArticle)
  });

  return `## Weekly research review — ${profileName}

Check the box for every article you want **included** in this week's draft (matched pairs + digest tables). Uncheck anything you want excluded, regardless of the curator's original decision. Articles the curator already Excluded aren't shown — only Include/Flag candidates need your review. **Close this Issue** when you're done — that triggers Stage 3 (Match) and Stage 4 (Table generation) automatically.

### Opinion
${op.lines}

### Case Study
${cs.lines}

---
<sub>Do not edit anything below this line — it's the raw data run2 needs to rebuild the article set.</sub>

${RAW_DATA_MARKER_START}
\`\`\`json
${rawData}
\`\`\`
${RAW_DATA_MARKER_END}
`;
}

export function parseIssueBody(body) {
  const startIdx = body.indexOf(RAW_DATA_MARKER_START);
  const endIdx = body.indexOf(RAW_DATA_MARKER_END);
  if (startIdx === -1 || endIdx === -1) {
    throw new Error('Could not find raw data block in Issue body — was it edited below the marker line?');
  }
  const block = body.slice(startIdx, endIdx);
  const jsonMatch = block.match(/```json\s*([\s\S]*?)\s*```/);
  if (!jsonMatch) {
    throw new Error('Could not find JSON fenced block inside raw data marker');
  }
  const { profileName, opCurated, csCurated } = JSON.parse(jsonMatch[1]);

  // Checkbox state is the source of truth for the final decision — parse
  // every "- [x]" / "- [ ]" line and its trailing "<!-- id:lane:id -->"
  // marker, then apply that back onto the raw article objects.
  const checkboxState = {}; // "lane:id" -> boolean
  const lineRe = /- \[( |x|X)\][^\n]*<!--\s*id:(opinion|caseStudy):(\d+)\s*-->/g;
  let m;
  while ((m = lineRe.exec(body)) !== null) {
    const checked = m[1].toLowerCase() === 'x';
    checkboxState[`${m[2]}:${m[3]}`] = checked;
  }

  function applyDecisions(curated, laneKey) {
    return curated.map(r => {
      const key = `${laneKey}:${r.id}`;
      if (key in checkboxState) {
        return { ...r, decision: checkboxState[key] ? 'Include' : 'Exclude' };
      }
      return r; // line wasn't found (shouldn't happen) — keep curator's original decision
    });
  }

  return {
    profileName,
    opCurated: applyDecisions(opCurated, 'opinion'),
    csCurated: applyDecisions(csCurated, 'caseStudy')
  };
}
