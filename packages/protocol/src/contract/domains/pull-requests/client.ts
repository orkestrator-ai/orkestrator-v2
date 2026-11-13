/**
 * The `pull-requests` domain client (plan item 7006; §11.2 "Client
 * adapters", §11.4): one function per command (`commandApi`), keyed by
 * command name (`api.get_github_pull_request({ owner, repo, number })`). The
 * web binds it per `lib/backend` client
 * (`apps/web/src/lib/node-scope/domains/pull-requests.ts`).
 *
 * - **Versions 3, 2 and 1** (a node whose hello advertises `pull-requests`):
 *   calls carry the envelope (the merge guards, `deleteBranch` and `method`, the
 *   review's `comments` and `commitId`, the review package's `expectedHead`,
 *   `validationPlan` and `additionalLimitations` are critical) and results
 *   are decoded with the command's schema.
 * - **Version 0** (a pre-contract node): today's untyped call, `{ command,
 *   args }`, answered as sent (`legacyCommandApi`). No command of this
 *   domain was capability-gated; an older node's answers are the shapes the
 *   callers in `lib/backend/github-pull-requests.ts`,
 *   `lib/backend/config-integrations.ts` and `lib/backend/files-sessions.ts`
 *   already read, and a command it lacks answers `unknown-command`.
 *
 * Retirement: adapter 0 goes when the support floor passes the first Stable
 * release that advertises the `pull-requests` domain.
 *
 * Browser-safe.
 */
import { domainClient, type CommandCall, type DomainAdapterContext } from "../../client.js";
import { commandApi, legacyCommandApi, type CommandApi } from "../command-api.js";
import { PULL_REQUESTS_COMMANDS } from "./commands.js";
import { pullRequestsDomain } from "./domain.js";

export type PullRequestsApi = CommandApi<typeof PULL_REQUESTS_COMMANDS>;

const pullRequestsApi = (call: CommandCall): PullRequestsApi =>
  commandApi(call, PULL_REQUESTS_COMMANDS);
const legacyPullRequestsApi = (
  _call: CommandCall,
  context: DomainAdapterContext,
): PullRequestsApi => legacyCommandApi(context, PULL_REQUESTS_COMMANDS);

export const pullRequestsClient = domainClient(pullRequestsDomain, {
  3: pullRequestsApi,
  // Version 3 only removed `merge_pr_local`, which only tests called
  // (2026-11-13), so version 2 peers take the same API. Adapter 2 goes when
  // the support floor passes the first Stable release with version 3.
  2: pullRequestsApi,
  // Version 2 only removed commands nothing called (2026-11-10), so version 1
  // peers take the same API. Adapter 1 goes when the support floor passes the
  // first Stable release with version 2.
  1: pullRequestsApi,
  0: legacyPullRequestsApi,
});
