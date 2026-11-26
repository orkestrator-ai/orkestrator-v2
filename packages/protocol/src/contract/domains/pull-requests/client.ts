/**
 * The `pull-requests` domain client (plan item 7006; §11.2 "Client
 * adapters", §11.4): one function per command (`commandApi`), keyed by
 * command name (`api.get_github_pull_request({ owner, repo, number })`). The
 * web binds it per `lib/backend` client
 * (`apps/web/src/lib/node-scope/domains/pull-requests.ts`).
 *
 * - **Versions 4 and 3** (a node whose hello advertises `pull-requests`):
 *   calls carry the envelope (the merge destination guards, `deleteBranch` and `method`, the
 *   review's `comments` and `commitId`, the review package's `expectedHead`,
 *   `validationPlan` and `additionalLimitations` are critical) and results
 *   are decoded with the command's schema.
 *
 * Adapters below version 3 went with the one-time support floor v2.39.1-beta
 * (to-do 8304 (retired), 2026-11-26), so a node that advertises no range for the
 * domain is refused with `unsupported-version`; over a transport without
 * negotiation, a destination-guarded merge is refused before it is sent.
 * Adapter 3 stays while a
 * release in the 60-day window speaks version 3: it goes when the support
 * floor passes the first Stable release with version 4.
 *
 * Browser-safe.
 */
import { domainClient, type CommandCall, type DomainAdapterContext } from "../../client.js";
import { commandApi, type CommandApi } from "../command-api.js";
import { PULL_REQUESTS_COMMANDS } from "./commands.js";
import { pullRequestsDomain } from "./domain.js";

export type PullRequestsApi = CommandApi<typeof PULL_REQUESTS_COMMANDS>;

const commands = (call: CommandCall): PullRequestsApi => commandApi(call, PULL_REQUESTS_COMMANDS);

// Without an envelope a node cannot refuse the destination guard as an
// unknown critical key, so a call that carries it is refused before it is
// sent rather than merged unchecked.
function refuseUnguardedDestination(args: { expectedBaseRef?: string }) {
  if (args.expectedBaseRef !== undefined) {
    throw new Error("Update the backend to verify the pull request destination before merging.");
  }
}

function pullRequestsApi(call: CommandCall, context: DomainAdapterContext): PullRequestsApi {
  const api = commands(call);
  if (!context.unnegotiated) return api;
  return Object.freeze({
    ...api,
    async merge_environment_pr(args) {
      refuseUnguardedDestination(args);
      return api.merge_environment_pr(args);
    },
    async merge_github_pull_request(args) {
      refuseUnguardedDestination(args);
      return api.merge_github_pull_request(args);
    },
    async set_environment_auto_merge(args) {
      refuseUnguardedDestination(args);
      return api.set_environment_auto_merge(args);
    },
  } satisfies PullRequestsApi);
}

export const pullRequestsClient = domainClient(pullRequestsDomain, {
  4: pullRequestsApi,
  3: pullRequestsApi,
});
