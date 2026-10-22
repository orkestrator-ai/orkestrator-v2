import { AGENT_INTERACTION_CONTRACT_VERSION } from "@orkestrator/protocol/agent-interactions";
import type { AgentInteractionKind } from "@orkestrator/protocol/agent-interactions";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { NativeAgentAuthState } from "@orkestrator/protocol/native-agent";
import {
  createTurnWatch,
  escapedInteractionFailures,
  isSignInError,
  isSignedOut,
  transcriptAssistantText,
  transcriptToolCalls,
  type CoordinatorTranscriptMessage,
  type CoordinatorLiveCheck,
  type CoordinatorTurnProjection,
  type TurnAnswer,
} from "./coordinator-live.js";
import {
  coordinatorWaitCounts,
  orkestratorToolCalls,
  isCarrierText,
  transcriptUserTexts,
  type DelegationMailMessage,
} from "./coordinator-live-delegation.js";
import { coordinatorLiveBudgets } from "./coordinator-live-budgets.js";

/**
 * The live suite's `peer` scenario: two ordinary environments on the fixture
 * project, neither launched by a coordinator, exchange ten alternating
 * messages with **Wake peers** on and nobody touching anything after their
 * startup prompts. It proves the `peer` route wakes a real provider's idle
 * tab, which the in-process `agent-mail-scenarios.test.ts` proves only with
 * fake providers.
 *
 * Shared with the Playwright spec, which runs under Node: no Bun APIs here.
 */

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/** Messages in the exchange: the opener sends the odd ones, the responder the even ones. */
export const PEER_MESSAGE_COUNT = 10;
export const PEER_DONE_MARKER = "PEER_EXCHANGE_DONE";
/** Both peers run their startup agent in this tab. */
export const PEER_TAB_ID = "startup-agent";

export interface PeerProbe {
  platform: AgentPlatform;
  /** Random hex; both environment names and every message body carry it. */
  token: string;
}

export function peerEnvironmentNames(probe: PeerProbe) {
  return { opener: `peer-opener-${probe.token}`, responder: `peer-responder-${probe.token}` };
}

export function peerBody(probe: PeerProbe, index: number): string {
  return `PEER-${index}-${probe.token}`;
}

const PEER_PREAMBLE =
  "This is Orkestrator's peer-mail conformance check, run by its test harness on a disposable fixture project. The user authorises and asks for every step below. Do not ask the user anything, do not edit files and do not run shell commands.";

function answerRule(probe: PeerProbe): string {
  const body = (index: string) => peerBody(probe, 1).replace("-1-", `-${index}-`);
  return [
    `Later you will be woken by messages from another agent. When a message's body is ${body("<n>")} for n below ${PEER_MESSAGE_COUNT}, answer it once with the Orkestrator reply_message tool (replying to that message) with body exactly ${body("<n+1>")}, then end your turn.`,
    `When a message's body is ${peerBody(probe, PEER_MESSAGE_COUNT)}, send nothing and finish that turn with exactly one line: ${PEER_DONE_MARKER}`,
    "Never wait, sleep, poll or read messages; you are woken when there is something to do. Send no other messages.",
  ].join(" ");
}

/** The responder starts first, idle, waiting to be woken. */
export function peerResponderPrompt(probe: PeerProbe): string {
  return [
    PEER_PREAMBLE,
    "",
    "Reply with the single word ready and end your turn. Do not use any tools in this turn.",
    "",
    answerRule(probe),
  ].join("\n");
}

/** The opener sends the first message to the responder by environment id. */
export function peerOpenerPrompt(probe: PeerProbe, responderEnvironmentId: string): string {
  return [
    PEER_PREAMBLE,
    "",
    `Call the Orkestrator send_message tool once with toEnvironmentId "${responderEnvironmentId}" (no toTabId) and body "${peerBody(probe, 1)}". Then end your turn.`,
    "",
    answerRule(probe),
  ].join("\n");
}

/**
 * The `create_environment` arguments of one peer: a local environment whose
 * startup agent receives `prompt` in build mode, the way Control MCP's
 * `launch_environment` creates one, but without a coordinator behind it.
 */
export function peerEnvironmentInput(input: {
  projectId: string;
  name: string;
  platform: AgentPlatform;
  prompt: string;
}): Record<string, unknown> {
  return {
    projectId: input.projectId,
    name: input.name,
    environmentType: "local",
    networkAccessMode: "restricted",
    initialPrompt: input.prompt,
    agentSettings: {
      defaultAgent: input.platform,
      platforms: { [input.platform]: { mode: "native" } },
    },
    pendingAgentLaunch: true,
    initialAgentPlatform: input.platform,
    initialConversationMode: "build",
  };
}

// ---------------------------------------------------------------------------
// Watching

export interface PeerSide {
  environmentId: string;
}

/** What the harness sees each time it looks at both peers. */
export interface PeerObservation {
  at: number;
  phases: Record<string, string>;
  mail: DelegationMailMessage[];
}

export class PeerSignInError extends Error {}

type MailboxPage = { messages?: DelegationMailMessage[] };

/**
 * Watches the peers' turns and mailboxes. Like the delegation watch it
 * answers nothing: an approval or question that reaches the harness is denied
 * (or cancelled) so the turn ends, and its kind is recorded as a failure.
 * The responder is watched from its startup; the opener joins with `add`.
 */
export function createPeerWatch(input: {
  invoke: Invoke;
  platform: AgentPlatform;
  peers: readonly PeerSide[];
  pollIntervalMs?: number;
  log?: (line: string) => void;
}) {
  const { invoke, platform } = input;
  const peers = [...input.peers];
  const pollIntervalMs = input.pollIntervalMs ?? 2_000;
  const log = input.log ?? (() => undefined);
  const turns = new Map(peers.map((peer) => [peer.environmentId, createTurnWatch()]));
  const projections = new Map<string, CoordinatorTurnProjection | null>();
  const errors = new Map<string, string>();
  /** A peer whose session reports no usable login, with that state. */
  const signedOut = new Map<string, NativeAgentAuthState>();
  const observations: PeerObservation[] = [];
  const identity = (environmentId: string) => ({
    environmentId,
    agent: platform,
    logicalSessionKey: `env-${environmentId}:${PEER_TAB_ID}`,
  });
  const answer = async (environmentId: string, answers: TurnAnswer[]) => {
    for (const item of answers) {
      await invoke("resolve_native_agent_interaction", {
        ...identity(environmentId),
        interactionId: item.interactionId,
        resolution: {
          version: AGENT_INTERACTION_CONTRACT_VERSION,
          ...item,
          resolvedAt: Date.now(),
        },
      }).catch(() => undefined);
    }
  };

  const watch = {
    observations,
    identity,
    add(peer: PeerSide): void {
      if (turns.has(peer.environmentId)) return;
      peers.push(peer);
      turns.set(peer.environmentId, createTurnWatch());
    },
    projection: (environmentId: string) => projections.get(environmentId) ?? null,
    escaped: (): AgentInteractionKind[] =>
      [...turns.values()].flatMap((turn) => turn.escapedInteractions()),
    async observe(): Promise<PeerObservation> {
      const reads = await Promise.all(
        peers.map(async ({ environmentId }) => {
          const [page, projection, auth] = await Promise.all([
            invoke<MailboxPage>("get_agent_mail_mailbox", {
              environmentId,
              tabId: PEER_TAB_ID,
              limit: 200,
            }).catch(() => ({ messages: [] }) as MailboxPage),
            invoke<CoordinatorTurnProjection | null>("get_native_agent_projection", {
              ...identity(environmentId),
              messageLimit: 200,
            }).catch(() => null),
            invoke<{ state: NativeAgentAuthState } | null>(
              "get_native_agent_auth_status",
              identity(environmentId),
            ).catch((error: unknown) => {
              const message = error instanceof Error ? error.message : String(error);
              if (isSignInError(message)) throw new PeerSignInError(message);
              throw new Error(`${platform}: peer authentication status unavailable`);
            }),
          ]);
          return { environmentId, mail: page.messages ?? [], projection, auth };
        }),
      );
      const phases: Record<string, string> = {};
      const mail: DelegationMailMessage[] = [];
      for (const read of reads) {
        mail.push(...read.mail.map(({ body: _body, ...summaryOnly }) => summaryOnly));
        projections.set(read.environmentId, read.projection);
        if (isSignedOut(read.auth?.state)) signedOut.set(read.environmentId, read.auth!.state);
        const phase = read.projection?.turn.phase ?? "unknown";
        phases[read.environmentId] = phase;
        if (phase === "error") {
          errors.set(
            read.environmentId,
            (read.projection?.turn.error ?? "no error text").slice(0, 300),
          );
        }
        await answer(
          read.environmentId,
          turns.get(read.environmentId)!.observe(read.projection).answers,
        );
      }
      const observation = { at: Date.now(), phases, mail };
      observations.push(observation);
      return observation;
    },
    /**
     * Observe until `done` holds. A peer whose session reports no usable
     * login, or whose turn failed on a recognised sign-in error, ends the
     * wait with a {@link PeerSignInError} (a skip); any other failed turn
     * ends it as a failure.
     */
    async until(
      label: string,
      done: (observation: PeerObservation) => boolean,
      timeoutMs = coordinatorLiveBudgets().peer,
    ): Promise<PeerObservation> {
      const started = Date.now();
      let nextHeartbeat = started + 60_000;
      for (;;) {
        const observation = await watch.observe();
        const [, state] = [...signedOut][0] ?? [];
        if (state !== undefined) throw new PeerSignInError(state);
        const [failed, error] = [...errors][0] ?? [];
        if (failed !== undefined && error !== undefined) {
          if (isSignInError(error)) throw new PeerSignInError(error);
          throw new Error(
            `${platform}: a peer failed its turn while waiting for ${label}: ${error}`,
          );
        }
        if (done(observation)) return observation;
        const now = Date.now();
        const phases = Object.values(observation.phases).join("/");
        if (now - started >= timeoutMs) {
          throw new Error(
            `${platform}: timed out after ${Math.round((now - started) / 1_000)}s waiting for ${label} (peers ${phases})`,
          );
        }
        if (now >= nextHeartbeat) {
          log(
            `[coordinator-live] ${platform}: waiting for ${label} for ${Math.round((now - started) / 1_000)}s (peers ${phases}, ${observation.mail.length} messages)`,
          );
          nextHeartbeat = now + 60_000;
        }
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
    },
    /** Final mail state with bodies, which the evaluation reads and never records. */
    async mailWithBodies(): Promise<DelegationMailMessage[]> {
      const latest = observations.at(-1)?.mail ?? [];
      return Promise.all(
        latest.map(async (message) => {
          const full = await invoke<{ body?: string } | null>("get_agent_mail_message", {
            environmentId: message.toEnvironmentId,
            tabId: message.toTabId,
            messageId: message.id,
          }).catch(() => null);
          return typeof full?.body === "string" ? { ...message, body: full.body } : message;
        }),
      );
    },
  };
  return watch;
}

/**
 * The exchange is over once the opener has written the done line, both peers
 * are idle, ten peer messages exist, and no mail is waiting to be delivered.
 */
export function peerExchangeFinished(
  observation: PeerObservation,
  openerMessages: readonly CoordinatorTranscriptMessage[],
): boolean {
  const idle = Object.values(observation.phases).every((phase) => phase === "idle");
  const pending = observation.mail.some(
    (message) => message.placement === "pending-inject" || message.placement === "inject-held",
  );
  return (
    observation.mail.filter((message) => message.route === "peer").length === PEER_MESSAGE_COUNT &&
    peerDoneLine(openerMessages) &&
    Object.keys(observation.phases).length === 2 &&
    idle &&
    !pending
  );
}

/** Only the final assistant row can finish the exchange. */
function peerDoneLine(messages: readonly CoordinatorTranscriptMessage[]): boolean {
  const last = messages.findLast((message) => message.role === "assistant");
  return (
    transcriptAssistantText(last ? [last] : [])
      .trim()
      .split("\n")
      .at(-1)
      ?.trim() === PEER_DONE_MARKER
  );
}

// ---------------------------------------------------------------------------
// Evaluation

export interface PeerScenarioInput {
  probe: PeerProbe;
  opener?: PeerSide;
  responder?: PeerSide;
  /** Messaging settings read while the exchange ran. */
  settings: Record<string, unknown>;
  /** The shipped defaults, with which the settings may differ only in `wakePeers`. */
  defaults: Readonly<Record<string, unknown>>;
  /** Final mail state with bodies. */
  mail: readonly DelegationMailMessage[];
  /** Each peer's final transcript, by environment id. */
  transcripts: Readonly<Record<string, CoordinatorTurnProjection["messages"]>>;
  escapedInteractions: readonly AgentInteractionKind[];
  /** Prompts the harness dispatched after the startup prompts: always zero. */
  harnessPrompts: number;
}

function check(name: string, passed: boolean, detail?: string): CoordinatorLiveCheck {
  return { name, passed, ...(detail ? { detail: detail.slice(0, 500) } : {}) };
}

function placements(messages: readonly DelegationMailMessage[]): string {
  const counts = new Map<string, number>();
  for (const message of messages) {
    const key = `${message.placement}${message.placementReason ? ` (${message.placementReason})` : ""}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([placement, count]) => `${placement} x${count}`)
    .join(", ");
}

export function evaluatePeerScenario(input: PeerScenarioInput): CoordinatorLiveCheck[] {
  const checks: CoordinatorLiveCheck[] = [];
  const opener = input.opener?.environmentId ?? "";
  const responder = input.responder?.environmentId ?? "";
  const pair = new Set([opener, responder].filter(Boolean));

  const changed = Object.entries(input.defaults)
    .filter(([key, value]) => key !== "wakePeers" && input.settings[key] !== value)
    .map(([key]) => key);
  checks.push(
    check(
      "wake-peers-on",
      input.settings.wakePeers === true && changed.length === 0,
      `wakePeers ${String(input.settings.wakePeers)}${changed.length > 0 ? `; also changed: ${changed.join(", ")}` : ""}`,
    ),
  );
  checks.push(
    check("both-peers-started", pair.size === 2, `${pair.size} of 2 peer environments found`),
  );

  // Mail between the two peers, in either direction.
  const exchange = input.mail.filter(
    (message) =>
      message.from.kind === "tab" &&
      pair.has(message.toEnvironmentId) &&
      pair.has(message.from.environmentId ?? "") &&
      message.from.environmentId !== message.toEnvironmentId,
  );
  const routes = new Set(exchange.map((message) => message.route ?? "none"));
  checks.push(
    check(
      "routed-as-peer",
      exchange.length > 0 && routes.size === 1 && routes.has("peer"),
      `${exchange.length} messages, routes: ${[...routes].join(", ") || "none"}`,
    ),
  );

  // Each reply must name the previous message as its parent. Confirmation
  // (`injectedAt`) can lag the actual dispatch, even arriving after a reply;
  // it is not a delivery boundary. The stored parent proves the causal link.
  const used = new Set<string>();
  let previous: DelegationMailMessage | undefined;
  let alternatingUpTo = 0;
  for (let index = 1; index <= PEER_MESSAGE_COUNT; index += 1) {
    const body = peerBody(input.probe, index);
    const matches = exchange.filter((message) => (message.body ?? "").includes(body));
    if (matches.length !== 1) break;
    const message = matches[0]!;
    const [from, to] = index % 2 === 1 ? [opener, responder] : [responder, opener];
    const createdAt = Date.parse(message.createdAt);
    const deliveredAt = Date.parse(message.injectedAt ?? "");
    if (
      used.has(message.id) ||
      message.from.environmentId !== from ||
      message.toEnvironmentId !== to ||
      message.placement !== "injected" ||
      !Number.isFinite(createdAt) ||
      !Number.isFinite(deliveredAt) ||
      (previous !== undefined &&
        (message.replyToMessageId !== previous.id || createdAt < Date.parse(previous.createdAt))) ||
      deliveredAt < createdAt
    ) {
      break;
    }
    used.add(message.id);
    previous = message;
    alternatingUpTo = index;
  }
  const doneLine = peerDoneLine(input.transcripts[opener] ?? []);
  checks.push(
    check(
      "ten-alternating",
      alternatingUpTo === PEER_MESSAGE_COUNT && exchange.length === PEER_MESSAGE_COUNT && doneLine,
      `${alternatingUpTo} of ${PEER_MESSAGE_COUNT} in order, each replying to its earlier parent; ${exchange.length} messages between the peers; done line ${doneLine}`,
    ),
  );

  const calls = Object.values(input.transcripts).flatMap((messages) =>
    transcriptToolCalls(messages),
  );
  const messageCalls = new Set(
    ["send_message", "reply_message", "ack_message"].flatMap((tool) =>
      orkestratorToolCalls(calls, tool),
    ),
  );
  const waits = coordinatorWaitCounts(calls.filter((call) => !messageCalls.has(call)));
  const waitingTools = calls.filter(
    (call) =>
      /(?:^|[_.])(wait(?:_agent)?|sleep|poll|monitor|schedule_?wakeup|cron(?:create|list|delete))(?:$|[_.])/i.test(
        call.name,
      ) ||
      (call.name === "exec" &&
        /\b(?:tools|functions)\.[\w.]*(?:read_messages|get_message_status|list_environments|sleep|wait|wait_agent|poll|monitor)\s*\(/i.test(
          call.args,
        )),
  ).length;
  checks.push(
    check(
      "no-wait-or-poll",
      Object.values(waits).every((count) => count === 0) && waitingTools === 0,
      `${waits.sleepCalls} shell waits, ${waitingTools} waiting tools, ${waits.readMessagesCalls} mailbox reads, ${waits.getMessageStatusCalls} status reads, ${waits.listEnvironmentsCalls} environment reads`,
    ),
  );

  const undelivered = exchange.filter((message) => message.placement !== "injected");
  checks.push(
    check(
      "every-message-woke",
      exchange.length > 0 && undelivered.length === 0,
      `${exchange.length} peer messages: ${placements(exchange) || "none"}`,
    ),
  );

  // Nobody acted: no interaction reached the harness, the harness sent
  // nothing after the startup prompts, and each transcript holds at most one
  // user row that is not a mail carrier (its startup prompt).
  const extraUserRows = [opener, responder]
    .filter(Boolean)
    .map(
      (environmentId) =>
        transcriptUserTexts(input.transcripts[environmentId] ?? []).filter(
          (text) => !isCarrierText(text),
        ).length,
    )
    .reduce((total, rows) => total + Math.max(0, rows - 1), 0);
  const actions = [
    ...escapedInteractionFailures(input.escapedInteractions),
    ...(input.harnessPrompts === 0 ? [] : [`the harness sent ${input.harnessPrompts} prompts`]),
    ...(extraUserRows === 0 ? [] : [`${extraUserRows} user rows beyond the startup prompts`]),
  ];
  checks.push(check("no-user-action", actions.length === 0, actions.join("; ")));
  return checks;
}
