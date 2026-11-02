import {
  gitHubPullRequestKey,
  type GitHubPullRequestRef,
} from "@orkestrator/protocol/github-pull-requests";
import { openInBrowser } from "@/lib/backend";

// Only explicit link opens arm a fallback. Polling and retries never re-arm it.
// Bound abandoned opens too (for example when the panel closes before loading).
const pending = new Map<string, string>();
export function armPullRequestFallback(
  ref: GitHubPullRequestRef,
  url = `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`,
) {
  const key = gitHubPullRequestKey(ref);
  pending.delete(key);
  pending.set(key, url);
  while (pending.size > 100) pending.delete(pending.keys().next().value!);
}

export function settlePullRequestFallback(ref: GitHubPullRequestRef, failed: boolean) {
  const key = gitHubPullRequestKey(ref);
  const url = pending.get(key);
  pending.delete(key);
  if (failed && url) return openInBrowser(url);
  return Promise.resolve();
}
