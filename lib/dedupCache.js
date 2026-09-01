import fs from 'node:fs';
import path from 'node:path';
import { log } from './util.js';

// This is a small, portable seen-URL store — not the Obsidian vault itself.
// On a local machine, the real vault is the source of truth for dedup. On
// GitHub Actions, the vault file doesn't exist on the runner, so this file
// (persisted between runs via actions/cache, never committed to the repo)
// fills the same role: "don't re-surface an article we already searched
// before," without ever storing or exposing actual vault/research content.

export function loadDedupCache(cachePath, lookbackWeeks) {
  if (!fs.existsSync(cachePath)) {
    log(`Dedup cache: no cache file at ${cachePath} yet — starting empty (expected on first run)`, 'muted');
    return {};
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  } catch {
    log(`Dedup cache: file at ${cachePath} was unreadable/corrupt — starting empty`, 'warn');
    return {};
  }
  const cutoff = Date.now() - lookbackWeeks * 7 * 24 * 60 * 60 * 1000;
  const pruned = {};
  let kept = 0, dropped = 0;
  for (const [url, seenAtIso] of Object.entries(data)) {
    const t = Date.parse(seenAtIso);
    if (!isNaN(t) && t >= cutoff) {
      pruned[url] = seenAtIso;
      kept++;
    } else {
      dropped++;
    }
  }
  log(`Dedup cache: loaded ${kept} URL(s) from cache (dropped ${dropped} older than ${lookbackWeeks}wk lookback)`, 'info');
  return pruned;
}

export function recordAndSaveDedupCache(cachePath, existingCache, newUrls) {
  const now = new Date().toISOString();
  const merged = { ...existingCache };
  for (const url of newUrls) {
    if (url) merged[url] = now;
  }
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(merged, null, 2), 'utf8');
  log(`Dedup cache: saved ${Object.keys(merged).length} URL(s) to ${cachePath}`, 'info');
}
