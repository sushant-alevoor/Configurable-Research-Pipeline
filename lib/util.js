const HBR_DOMAINS = ['hbr.org', 'strategy-business.com', 'mckinsey.com/quarterly'];

export function isPaywalled(article) {
  const url = (article.url || '').toLowerCase();
  const source = (article.source || '').toLowerCase();
  return HBR_DOMAINS.some(d => url.includes(d) || source.includes(d.replace('.org', '')));
}

const COLORS = {
  info: '\x1b[36m',
  ok: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  muted: '\x1b[90m',
  reset: '\x1b[0m'
};

export function log(msg, cls = 'info') {
  const ts = new Date().toLocaleTimeString('en-GB');
  const color = COLORS[cls] || '';
  console.log(`${color}[${ts}] ${msg}${COLORS.reset}`);
}
