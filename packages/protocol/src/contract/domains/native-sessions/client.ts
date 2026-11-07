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
 * - **Version 1** (a node whose hello advertises `native-sessions`): calls are
 *   typed by their definitions, carry the envelope (version and the critical
 *   keys the arguments hold), and results are decoded with the command's
 *   schema. Both capability commands are folded into the version: every
 *   build that advertises the domain builds, delivers and prunes handoffs,
 *   and speaks the sync protocols this build knows
 *   ({@link NATIVE_SESSIONS_SYNC_CAPABILITIES}), so neither is asked.
 * - **Version 0** (a pre-contract node): today's calls, by name and without
 *   an envelope, answered as the node sent them (no decoding: an older node
 *   answers older shapes, which each caller already reads). The capability
 *   reads ask `get_agent_handoff_capabilities` (an `unknown-command` answer is
 *   a node that does none of it) and `get_native_agent_sync_capabilities`
 *   (answered as sent, `unknown-command` included) on every call: callers
 *   cache per node and generation themselves.
 *
 * Retirement: adapter 0 goes when the support floor passes the first Stable
 * release that advertises `native-sessions` (version-compatibility.md,
 * Register). The two capability commands stay registered for pre-contract
 * clients until their register row retires.
 *
 * Browser-safe.
 */
import { NATIVE_AGENT_LIVE_UPDATE_VERSION } from "../../../native-agent.js";
import { NATIVE_AGENT_OBSERVATION_EVENT_VERSION } from "../../../native-agent-observation.js";
import { NATIVE_AGENT_TRANSCRIPT_PATCH_VERSION } from "../../../native-agent-transcript-patch.js";
import { domainClient, type CommandCall, type DomainAdapterContext } from "../../client.js";
import type { ArgsOf, ResultOf } from "../../command.js";
import { incompatibility } from "../../errors.js";
import {
  getAgentHandoffCapabilitiesCommand,
  getNativeAgentSyncCapabilitiesCommand,
  NATIVE_SESSIONS_COMMANDS,
} from "./commands.js";
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

/** A node that predates `get_agent_handoff_capabilities`: none of it. */
export const LEGACY_HANDOFF_CAPABILITIES: NativeSessionsHandoffCapabilities = Object.freeze({
  create: false,
  delivery: false,
  pruning: false,
});

/** What `native-sessions` version 1 includes of the handoff capabilities: all of it. */
export const NATIVE_SESSIONS_HANDOFF_CAPABILITIES: NativeSessionsHandoffCapabilities =
  Object.freeze({ create: true, delivery: true, pruning: true });

/**
 * The sync protocols `native-sessions` version 1 includes: the versions of
 * `get_native_agent_sync_capabilities` this build knows (projection sync and
 * history paging 1, progressive views 1, stamped activity events, part-level
 * transcript patches, the combined live update).
 */
export const NATIVE_SESSIONS_SYNC_CAPABILITIES = Object.freeze({
  projectionSyncVersions: Object.freeze([1]),
  historyPagingVersions: Object.freeze([1]),
  progressiveViewVersions: Object.freeze([1]),
  observationEventVersions: Object.freeze([NATIVE_AGENT_OBSERVATION_EVENT_VERSION]),
  transcriptPatchVersions: Object.freeze([NATIVE_AGENT_TRANSCRIPT_PATCH_VERSION]),
  liveUpdateVersions: Object.freeze([NATIVE_AGENT_LIVE_UPDATE_VERSION]),
}) satisfies ResultOf<typeof getNativeAgentSyncCapabilitiesCommand>;

export interface NativeSessionsApi extends NativeSessionsCommandApi {
  /** What the node does with handoffs on its own. */
  handoffCapabilities(): Promise<NativeSessionsHandoffCapabilities>;
  /**
   * The node's sync protocols: this build's for version 1, the node's own
   * answer for version 0 (unchecked: the caller validates it, and reads the
   * `unknown-command` of a node that predates the command).
   */
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

function currentApi(call: CommandCall): NativeSessionsApi {
  return Object.freeze({
    ...commandApi((command, args) => call(command, args as ArgsOf<typeof command>)),
    handoffCapabilities: async () => NATIVE_SESSIONS_HANDOFF_CAPABILITIES,
    syncCapabilities: async () => NATIVE_SESSIONS_SYNC_CAPABILITIES,
  });
}

function isUnknownCommand(error: unknown, command: string): boolean {
  return incompatibility(error, command)?.code === "unknown-command";
}

/** Version 0: today's untyped calls and capability reads for a pre-contract node. */
function legacyApi(_call: CommandCall, context: DomainAdapterContext): NativeSessionsApi {
  return Object.freeze({
    ...commandApi((command, args) =>
      context.invoke(command.name, args as Readonly<Record<string, unknown>> | undefined),
    ),
    handoffCapabilities: async () => {
      const name = getAgentHandoffCapabilitiesCommand.name;
      let response: unknown;
      try {
        response = await context.invoke(name);
      } catch (error) {
        // A node that predates the command builds, delivers and prunes
        // nothing. Any other failure is thrown: guessing "legacy" on a
        // transient error would prepend history the backend also prepends.
        if (isUnknownCommand(error, name)) return LEGACY_HANDOFF_CAPABILITIES;
        throw error;
      }
      if (!response || typeof response !== "object" || Array.isArray(response)) {
        throw new Error("Invalid agent handoff capabilities response");
      }
      const candidate = response as Record<string, unknown>;
      return {
        create: candidate.create === true,
        delivery: candidate.delivery === true,
        pruning: candidate.pruning === true,
      };
    },
    // Answered as the node sends it; a node that predates the command answers
    // `unknown-command`, which the caller reads.
    syncCapabilities: () => context.invoke(getNativeAgentSyncCapabilitiesCommand.name),
  });
}

export const nativeSessionsClient = domainClient(nativeSessionsDomain, {
  1: (call) => currentApi(call),
  0: legacyApi,
});
