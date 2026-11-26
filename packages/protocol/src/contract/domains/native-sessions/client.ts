/**
 * The `native-sessions` domain client (plan item 7001; §11.2 "Client
 * adapters", §11.4): what a renderer calls on a node for native agent
 * sessions, terminal sessions, pane layouts, prompt queues, drafts and
 * handoffs. The web binds it per `lib/backend` client
 * (`apps/web/src/lib/node-scope/domains/native-sessions.ts`).
 *
 * The API has one function per command, keyed by the command's name
 * (`api.get_native_agent_session(args)`), plus the domain's two capability
 * reads:
 *
 * **Versions 6, 5, 4 and 3** (a node whose hello advertises
 * `native-sessions`): calls are typed by their definitions, carry the
 * envelope (version and the critical keys the arguments hold), and results
 * are decoded with the command's schema. The two retired capability commands
 * (`get_agent_handoff_capabilities`, `get_native_agent_sync_capabilities`)
 * are folded into the domain: every build that advertises it builds,
 * delivers and prunes handoffs, and speaks the sync protocols this build
 * knows ({@link NATIVE_SESSIONS_SYNC_CAPABILITIES}), so neither is asked.
 *
 * Adapters below version 3 went with the one-time support floor v2.39.1-beta
 * (to-do 8304 (retired), 2026-11-26), so a node that advertises no range for the
 * domain is refused with `unsupported-version`. Adapters 3 to 5 stay while a
 * release in the 60-day window speaks those versions (version-compatibility.md,
 * Register).
 *
 * Browser-safe.
 */
import { NATIVE_AGENT_LIVE_UPDATE_VERSION } from "../../../native-agent.js";
import { NATIVE_AGENT_OBSERVATION_EVENT_VERSION } from "../../../native-agent-observation.js";
import { NATIVE_AGENT_TRANSCRIPT_PATCH_VERSION } from "../../../native-agent-transcript-patch.js";
import { domainClient, type CommandCall } from "../../client.js";
import type { ArgsOf, ResultOf } from "../../command.js";
import { UnsupportedFieldError } from "../../errors.js";
import { NATIVE_SESSIONS_COMMANDS } from "./commands.js";
import { nativeSessionsDomain } from "./domain.js";

/** Every `native-sessions` command definition. */
export type NativeSessionsCommand = (typeof NATIVE_SESSIONS_COMMANDS)[number];

/** One function per command, keyed by the command's name. */
export type NativeSessionsCommandApi = {
  readonly [C in NativeSessionsCommand as C["name"]]: (args: ArgsOf<C>) => Promise<ResultOf<C>>;
};

/** What a node does with "Continue in…" handoffs on its own. */
export interface NativeSessionsHandoffCapabilities {
  /** `create_agent_handoff` builds handoffs from the authoritative transcript. */
  readonly create: boolean;
  /** The first dispatch to a destination tab carries its pending handoff. */
  readonly delivery: boolean;
  /** Unreferenced handoffs are pruned by the backend. */
  readonly pruning: boolean;
}

/** What every `native-sessions` node does with handoffs: all of it. */
export const NATIVE_SESSIONS_HANDOFF_CAPABILITIES: NativeSessionsHandoffCapabilities =
  Object.freeze({ create: true, delivery: true, pruning: true });

/**
 * The sync protocols every `native-sessions` node speaks: the versions this
 * build knows (history paging 1, progressive views 1, stamped activity
 * events, part-level transcript patches, the combined live update).
 */
export const NATIVE_SESSIONS_SYNC_CAPABILITIES = Object.freeze({
  historyPagingVersions: Object.freeze([1]),
  progressiveViewVersions: Object.freeze([1]),
  observationEventVersions: Object.freeze([NATIVE_AGENT_OBSERVATION_EVENT_VERSION]),
  transcriptPatchVersions: Object.freeze([NATIVE_AGENT_TRANSCRIPT_PATCH_VERSION]),
  liveUpdateVersions: Object.freeze([NATIVE_AGENT_LIVE_UPDATE_VERSION]),
});

export interface NativeSessionsApi extends NativeSessionsCommandApi {
  /** What the node does with handoffs on its own. */
  handoffCapabilities(): Promise<NativeSessionsHandoffCapabilities>;
  /** The node's sync protocols: this build's (the caller validates it). */
  syncCapabilities(): Promise<unknown>;
}

function commandApi(
  run: (command: NativeSessionsCommand, args: unknown) => Promise<unknown>,
): NativeSessionsCommandApi {
  const api: Record<string, (args: unknown) => Promise<unknown>> = {};
  for (const command of NATIVE_SESSIONS_COMMANDS) {
    api[command.name] = (args) => run(command, args);
  }
  return api as NativeSessionsCommandApi;
}

function checkFailureRetry(args: unknown): void {
  if (
    args &&
    typeof args === "object" &&
    "failureSessionId" in args &&
    args.failureSessionId !== undefined
  ) {
    throw new UnsupportedFieldError({
      message: "This machine needs an update before it can retry a failed turn.",
      domain: nativeSessionsDomain.name,
      field: "failureSessionId",
    });
  }
}

function checkToolOutputOccurrence(args: unknown): void {
  if (args && typeof args === "object" && "messageId" in args && args.messageId !== undefined) {
    throw new UnsupportedFieldError({
      message: "This machine needs an update before it can follow a tool output occurrence.",
      domain: nativeSessionsDomain.name,
      field: "messageId",
    });
  }
}

function currentApi(
  call: CommandCall,
  guardedFailureRetry = false,
  toolOutputOccurrence = false,
): NativeSessionsApi {
  return Object.freeze({
    ...commandApi(async (command, args) => {
      if (!guardedFailureRetry) checkFailureRetry(args);
      if (!toolOutputOccurrence && command.name === "get_native_agent_tool_output") {
        checkToolOutputOccurrence(args);
      }
      return call(command, args as ArgsOf<typeof command>);
    }),
    handoffCapabilities: async () => NATIVE_SESSIONS_HANDOFF_CAPABILITIES,
    syncCapabilities: async () => NATIVE_SESSIONS_SYNC_CAPABILITIES,
  });
}

export const nativeSessionsClient = domainClient(nativeSessionsDomain, {
  6: (call) => currentApi(call, true, true),
  5: (call) => currentApi(call, true),
  // Older peers cannot verify that the requested failure is still current.
  4: (call) => currentApi(call),
  // Version 4 only removed `get_native_agent_projection_update`, which no
  // client called once joined history paging retired (2026-11-16), and the
  // `projectionSyncVersions` capability no version-1-or-later client reads,
  // so version 3 peers take the same API. Adapter 3 goes when the support
  // floor passes the first Stable release with version 4.
  3: (call) => currentApi(call),
});
