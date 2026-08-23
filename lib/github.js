import { log } from './util.js';

const API = 'https://api.github.com';

function headers() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN env var is required to talk to the GitHub Issues API');
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json'
  };
}

// repo comes from GITHUB_REPOSITORY (auto-set inside GitHub Actions as
// "owner/repo"), or GITHUB_REPO env var for local testing.
function repoSlug() {
  const repo = process.env.GITHUB_REPOSITORY || process.env.GITHUB_REPO;
  if (!repo) throw new Error('GITHUB_REPOSITORY or GITHUB_REPO env var is required (format: owner/repo)');
  return repo;
}

async function ghFetch(pathSuffix, options = {}) {
  const url = `${API}/repos/${repoSlug()}${pathSuffix}`;
  const res = await fetch(url, { ...options, headers: headers() });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub API ${options.method || 'GET'} ${pathSuffix} failed: ${res.status} ${res.statusText} — ${body.slice(0, 300)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

export async function createIssue({ title, body, labels }) {
  const issue = await ghFetch('/issues', {
    method: 'POST',
    body: JSON.stringify({ title, body, labels })
  });
  log(`GitHub: opened Issue #${issue.number} — ${issue.html_url}`, 'ok');
  return issue;
}

export async function getIssue(issueNumber) {
  return ghFetch(`/issues/${issueNumber}`);
}

// Used by run2 when triggered by the issues:closed webhook — the event
// payload's issue number is passed in via GITHUB_ISSUE_NUMBER (set by the
// Actions workflow from github.event.issue.number).
export function issueNumberFromEnv() {
  const n = process.env.GITHUB_ISSUE_NUMBER;
  if (!n) throw new Error('GITHUB_ISSUE_NUMBER env var is required for run2 (set by the Actions workflow from github.event.issue.number)');
  return Number(n);
}
