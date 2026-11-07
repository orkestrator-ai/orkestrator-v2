/**
 * The `pull-requests` domain on a `lib/backend` factory's client (plan item
 * 7006): `pullRequests(client).get_github_pull_request({ owner, repo,
 * number })`. See `./domain-api.ts` for the adapter choice: a node that
 * advertises `pull-requests` gets version 1 (the envelope travels with the
 * call, results are decoded with the command's schema); any other node, or a
 * client without negotiation, gets version 0, today's call.
 * `lib/backend/github-pull-requests.ts`, `lib/backend/config-integrations.ts`
 * and `lib/backend/files-sessions.ts` call it.
 */
import {
  pullRequestsClient,
  type PullRequestsApi,
} from "@orkestrator/protocol/contract/domains/pull-requests";
import type { BackendClient } from "@/lib/backend/client";
import { domainApi } from "./domain-api";

export type { PullRequestsApi } from "@orkestrator/protocol/contract/domains/pull-requests";

export function pullRequests(client: BackendClient): PullRequestsApi {
  return domainApi(client, pullRequestsClient);
}
