/**
 * The `git` domain on a `lib/backend` factory's client (plan item 7006):
 * `git(client).changes_get_view({ resourceKey })`. See `./domain-api.ts` for
 * the adapter choice: a node that advertises `git` gets version 1 (the
 * envelope travels with the call, results are decoded with the command's
 * schema); any other node, or a client without negotiation, gets version 0,
 * today's call. `lib/backend/changes.ts` and `lib/backend/files-sessions.ts`
 * call it.
 */
import { gitClient, type GitApi } from "@orkestrator/protocol/contract/domains/git";
import type { BackendClient } from "@/lib/backend/client";
import { domainApi } from "./domain-api";

export type { GitApi } from "@orkestrator/protocol/contract/domains/git";

export function git(client: BackendClient): GitApi {
  return domainApi(client, gitClient);
}
