import { toast } from "sonner";
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
  if (failed && url) {
    // Delayed window.open may be blocked after transient activation expires.
    // Keep a user-activated escape route even when automatic opening resolves.
    toast.error("Could not load the pull request", {
      duration: Infinity,
      action: {
        label: "Open on GitHub",
        onClick: () => {
          void openInBrowser(url).catch(() => toast.error("Could not open the link"));
        },
      },
    });
    return openInBrowser(url);
  }
  return Promise.resolve();
}
