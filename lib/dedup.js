import fs from 'node:fs';

/* ============================================================
   DEDUP — Obsidian vault parsing (deterministic, no LLM)
   Ported directly from the browser artifact's logic. Splits the running
   markdown file on H1 headings of the form "# <Table Name> — <date>",
   buckets content by heading, and extracts every URL from headings that
   fall within the configured lookback window.
============================================================ */

export function tryParseDate(str) {
  if (!str) return null;
  const s = String(str).trim();
  if (!s || /unknown/i.test(s)) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function parseHeadingDate(headingLine) {
  const dashIdx = headingLine.indexOf('—');
  if (dashIdx === -1) return null;
  let dateStr = headingLine.slice(dashIdx + 1).trim();
  const commaIdx = dateStr.indexOf(',');
  if (commaIdx !== -1) dateStr = dateStr.slice(commaIdx + 1).trim();
  return tryParseDate(dateStr);
}

function extractUrls(content) {
  const urls = new Set();
  const re = /\]\((https?:\/\/[^\s)]+)\)/g;
  let m;
  while ((m = re.exec(content))) urls.add(m[1]);
  return urls;
}

export function parseDatedHeadingSections(text) {
  const headingRegex = /^#\s+.+?—.+$/gm;
  const matches = [...text.matchAll(headingRegex)];
  const buckets = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    buckets.push({
      date: parseHeadingDate(matches[i][0]),
      content: text.slice(start, end)
    });
  }
  return buckets;
}

export function buildDedupSeenSet(vaultText, lookbackWeeks) {
  const empty = { seen: new Set(), keptBuckets: 0, totalBuckets: 0 };
  if (!vaultText || !lookbackWeeks) return empty;
  const buckets = parseDatedHeadingSections(vaultText);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - lookbackWeeks * 7);
  const seen = new Set();
  let keptBuckets = 0;
  for (const b of buckets) {
    if (!b.date || b.date < cutoff) continue;
    keptBuckets++;
    extractUrls(b.content).forEach(u => seen.add(u));
  }
  return { seen, keptBuckets, totalBuckets: buckets.length };
}

// Reads the vault file from disk if it exists; returns null (not a throw)
// if the path is missing, since a first-ever run won't have a vault yet.
export function loadVaultFile(path) {
  if (!path || !fs.existsSync(path)) return null;
  return fs.readFileSync(path, 'utf8');
}
