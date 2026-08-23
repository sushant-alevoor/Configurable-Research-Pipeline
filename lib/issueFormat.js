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

function checklistLine(r) {
  const checked = r.decision === 'Include' ? 'x' : ' ';
  const score = r.score !== undefined ? `${r.score}/10` : 'n/a';
  const reason = (r.reason || r.snippet || '').replace(/\n/g, ' ').trim();
  return `- [${checked}] **${(r.title || 'untitled').replace(/\n/g, ' ')}** (${r.decision}, score ${score}) — ${reason} [link](${r.url}) <!-- id:${r.lane}:${r.id} -->`;
}

export function buildIssueBody({ profileName, opCurated, csCurated }) {
  const opLines = opCurated.map(checklistLine).join('\n') || '_(no candidates)_';
  const csLines = csCurated.map(checklistLine).join('\n') || '_(no candidates)_';

  const rawData = JSON.stringify({ profileName, opCurated, csCurated });

  return `## Weekly research review — ${profileName}

Check the box for every article you want **included** in this week's draft (matched pairs + digest tables). Uncheck anything you want excluded, regardless of the curator's original decision. **Close this Issue** when you're done — that triggers Stage 3 (Match) and Stage 4 (Table generation) automatically.

### Opinion
${opLines}

### Case Study
${csLines}

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
