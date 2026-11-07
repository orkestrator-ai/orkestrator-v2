/**
 * The `git` domain client (plan item 7006; §11.2 "Client adapters", §11.4):
 * one function per command (`commandApi`), keyed by command name
 * (`api.changes_get_view({ resourceKey })`). The web binds it per
 * `lib/backend` client (`apps/web/src/lib/node-scope/domains/git.ts`).
 *
 * - **Version 1** (a node whose hello advertises `git`): calls carry the
 *   envelope (`pathIds` on `changes_prepare_restore` is critical) and results
 *   are decoded with the command's schema.
 * - **Version 0** (a pre-contract node): today's untyped call, `{ command,
 *   args }`, answered as sent (`legacyCommandApi`). An older node's answers
 *   are the shapes the callers in `lib/backend/changes.ts` and
 *   `lib/backend/files-sessions.ts` already read.
 *
 * **Capability.** `changes_get_capabilities` gated the Changes surfaces on
 * the `change-tracking-v1` protocol. Version 1 includes that protocol and
 * its fixed features ({@link GIT_CHANGE_TRACKING_PROTOCOL}: history, git
 * scopes, operation volume), so a caller that only needs to know the
 * protocol exists reads the version. The answer's `restore`,
 * `strictCheckpoints` and `policyVersion` are the backend's change-tracking
 * policy, which a version cannot say, so the command stays (typed) in the
 * API and is still asked for them; a backend without change tracking answers
 * it with an error, which callers read as "unavailable". The command stays
 * registered for pre-contract clients until its register row retires.
 *
 * Retirement: adapter 0 goes when the support floor passes the first Stable
 * release that advertises the `git` domain.
 *
 * Browser-safe.
 */
import { CHANGE_TRACKING_PROTOCOL_CAPABILITY } from "../../../change-resources.js";
import { domainClient, type CommandCall, type DomainAdapterContext } from "../../client.js";
import { commandApi, legacyCommandApi, type CommandApi } from "../command-api.js";
import { GIT_COMMANDS } from "./commands.js";
import { gitDomain } from "./domain.js";

export type GitApi = CommandApi<typeof GIT_COMMANDS>;

/** The change-tracking protocol and fixed features every `git` version-1 node speaks. */
export const GIT_CHANGE_TRACKING_PROTOCOL = Object.freeze({
  capability: CHANGE_TRACKING_PROTOCOL_CAPABILITY,
  history: true,
  gitScopes: true,
  operationVolume: true,
});

const gitApi = (call: CommandCall): GitApi => commandApi(call, GIT_COMMANDS);
const legacyGitApi = (_call: CommandCall, context: DomainAdapterContext): GitApi =>
  legacyCommandApi(context, GIT_COMMANDS);

export const gitClient = domainClient(gitDomain, {
  1: gitApi,
  0: legacyGitApi,
});
