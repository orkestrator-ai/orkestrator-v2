/**
 * The `git` domain client (plan item 7006; §11.2 "Client adapters", §11.4):
 * one function per command (`commandApi`), keyed by command name
 * (`api.changes_get_view({ resourceKey })`). The web binds it per
 * `lib/backend` client (`apps/web/src/lib/node-scope/domains/git.ts`).
 *
 * - **Version 2** (a node whose hello advertises `git`): calls carry the
 *   envelope (`pathIds` on `changes_prepare_restore` is critical) and results
 *   are decoded with the command's schema.
 *
 * **Capability.** `changes_get_capabilities` gated the Changes surfaces on
 * the `change-tracking-v1` protocol. Version 1 and later include that
 * protocol and its fixed features ({@link GIT_CHANGE_TRACKING_PROTOCOL}: history, git
 * scopes, operation volume), so a caller that only needs to know the
 * protocol exists reads the version. The answer's `restore`,
 * `strictCheckpoints` and `policyVersion` are the backend's change-tracking
 * policy, which a version cannot say, so the command stays (typed) in the
 * API and is still asked for them; a backend without change tracking answers
 * it with an error, which callers read as "unavailable".
 *
 * Only the current version has an adapter: the older ones went with the
 * one-time support floor v2.39.1-beta (to-do 8304 (retired), 2026-11-26), so a node
 * that advertises no range for the domain is refused with
 * `unsupported-version`. Later bumps keep an adapter for every version a
 * release in the 60-day window speaks.
 *
 * Browser-safe.
 */
import { CHANGE_TRACKING_PROTOCOL_CAPABILITY } from "../../../change-resources.js";
import { domainClient, type CommandCall } from "../../client.js";
import { commandApi, type CommandApi } from "../command-api.js";
import { GIT_COMMANDS } from "./commands.js";
import { gitDomain } from "./domain.js";

export type GitApi = CommandApi<typeof GIT_COMMANDS>;

/** The change-tracking protocol and fixed features every `git` node from version 1 speaks. */
export const GIT_CHANGE_TRACKING_PROTOCOL = Object.freeze({
  capability: CHANGE_TRACKING_PROTOCOL_CAPABILITY,
  history: true,
  gitScopes: true,
  operationVolume: true,
});

const gitApi = (call: CommandCall): GitApi => commandApi(call, GIT_COMMANDS);

export const gitClient = domainClient(gitDomain, {
  2: gitApi,
});
