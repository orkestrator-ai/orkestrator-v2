import { describe, expect, test } from "bun:test";
import { DEFAULT_AGENT_MESSAGING_SETTINGS } from "@orkestrator/protocol/agent-mail";
import type { DelegationMailMessage } from "./coordinator-live-delegation.js";
import type { CoordinatorLiveCheck, CoordinatorTurnProjection } from "./coordinator-live.js";
import {
  PEER_DONE_MARKER,
  PEER_MESSAGE_COUNT,
  PEER_TAB_ID,
  PeerSignInError,
  createPeerWatch,
  evaluatePeerScenario,
  peerBody,
  peerEnvironmentInput,
  peerExchangeFinished,
  peerOpenerPrompt,
  peerResponderPrompt,
  type PeerProbe,
  type PeerScenarioInput,
} from "./coordinator-live-peer.js";

const probe: PeerProbe = { platform: "codex", token: "a1b2c3" };
const OPENER = "opener-env";
const RESPONDER = "responder-env";
const at = (seconds: number) => new Date(Date.UTC(2026, 9, 22, 0, 0, seconds)).toISOString();

/** The ten messages of a clean exchange, each created two seconds after the last was delivered. */
function exchange(): DelegationMailMessage[] {
  return Array.from({ length: PEER_MESSAGE_COUNT }, (_, offset) => {
    const index = offset + 1;
    const [from, to] = index % 2 === 1 ? [OPENER, RESPONDER] : [RESPONDER, OPENER];
    return {
      id: `message-${index}`,
      createdAt: at(index * 10),
      ...(index > 1 ? { replyToMessageId: `message-${index - 1}` } : {}),
      injectedAt: at(index * 10 + 2),
      from: { kind: "tab", environmentId: from, tabId: PEER_TAB_ID },
      toEnvironmentId: to,
      toTabId: PEER_TAB_ID,
      placement: "injected",
      route: "peer",
      body: peerBody(probe, index),
    };
  });
}

const row = (role: string, content: string) => ({ role, content });
const carrier = (id: string) =>
  row("user", `<orkestrator-peer-message>{"id":"${id}"}</orkestrator-peer-message>`);

function input(overrides: Partial<PeerScenarioInput> = {}): PeerScenarioInput {
  return {
    probe,
    opener: { environmentId: OPENER },
    responder: { environmentId: RESPONDER },
    settings: { ...DEFAULT_AGENT_MESSAGING_SETTINGS, wakePeers: true },
    defaults: DEFAULT_AGENT_MESSAGING_SETTINGS,
    mail: exchange(),
    transcripts: {
      [OPENER]: [row("user", "startup"), carrier("message-2"), row("assistant", PEER_DONE_MARKER)],
      [RESPONDER]: [row("user", "startup"), row("assistant", "ready"), carrier("message-1")],
    },
    escapedInteractions: [],
    harnessPrompts: 0,
    ...overrides,
  };
}

function failed(checks: readonly CoordinatorLiveCheck[]): string[] {
  return checks.filter((item) => !item.passed).map((item) => item.name);
}

describe("peer prompts", () => {
  test("the opener addresses the responder by environment id; both share the answer rule", () => {
    const opener = peerOpenerPrompt(probe, RESPONDER);
    expect(opener).toContain(`toEnvironmentId "${RESPONDER}" (no toTabId)`);
    expect(opener).toContain(peerBody(probe, 1));
    const responder = peerResponderPrompt(probe);
    expect(responder).toContain("Do not use any tools in this turn");
    for (const prompt of [opener, responder]) {
      expect(prompt).toContain("reply_message");
      expect(prompt).toContain(peerBody(probe, PEER_MESSAGE_COUNT));
      expect(prompt).toContain(PEER_DONE_MARKER);
      expect(prompt).toContain("Never wait, sleep, poll or read messages");
    }
  });

  test("a peer is an ordinary local environment whose startup agent runs in build mode", () => {
    const created = peerEnvironmentInput({
      projectId: "project",
      name: "peer",
      platform: "cursor",
      prompt: "hello",
    });
    expect(created).toMatchObject({
      projectId: "project",
      environmentType: "local",
      initialPrompt: "hello",
      pendingAgentLaunch: true,
      initialAgentPlatform: "cursor",
      initialConversationMode: "build",
      agentSettings: { defaultAgent: "cursor", platforms: { cursor: { mode: "native" } } },
    });
    // No coordinator delegation: a delegated environment would be a worker,
    // and worker-to-anyone-else mail is isolated rather than peer.
    expect(created).not.toHaveProperty("delegationBaseCommit");
    expect(created).not.toHaveProperty("controlRequestId");
  });

  test("bodies are distinct: one message's body is never part of another's", () => {
    const bodies = Array.from({ length: PEER_MESSAGE_COUNT }, (_, index) =>
      peerBody(probe, index + 1),
    );
    for (const body of bodies) {
      expect(bodies.filter((other) => other.includes(body))).toEqual([body]);
    }
  });
});

describe("peer scenario", () => {
  test("a clean unattended exchange passes every check", () => {
    expect(failed(evaluatePeerScenario(input()))).toEqual([]);
  });

  test("Wake peers off, or another default changed, fails the setting check", () => {
    expect(
      failed(evaluatePeerScenario(input({ settings: { ...DEFAULT_AGENT_MESSAGING_SETTINGS } }))),
    ).toContain("wake-peers-on");
    expect(
      failed(
        evaluatePeerScenario(
          input({
            settings: {
              ...DEFAULT_AGENT_MESSAGING_SETTINGS,
              wakePeers: true,
              defaultInjectPolicy: "idle",
            },
          }),
        ),
      ),
    ).toContain("wake-peers-on");
  });

  test("mail that was stored rather than woken fails delivery and the exchange", () => {
    const mail = exchange();
    mail[4] = { ...mail[4]!, placement: "stored", placementReason: "inject-policy-off" };
    const result = failed(evaluatePeerScenario(input({ mail })));
    expect(result).toContain("every-message-woke");
    expect(result).toContain("ten-alternating");
  });

  test("a message on another route is not the peer route", () => {
    const mail = exchange();
    mail[0] = { ...mail[0]!, route: "isolated" };
    expect(failed(evaluatePeerScenario(input({ mail })))).toContain("routed-as-peer");
  });

  test("the wrong sender, a reply before its parent or an extra message fail alternation", () => {
    const swapped = exchange();
    swapped[2] = {
      ...swapped[2]!,
      from: { kind: "tab", environmentId: RESPONDER },
      toEnvironmentId: OPENER,
    };
    expect(failed(evaluatePeerScenario(input({ mail: swapped })))).toContain("ten-alternating");

    const early = exchange();
    // A reply cannot predate the message it answers.
    early[5] = { ...early[5]!, createdAt: at(49) };
    expect(failed(evaluatePeerScenario(input({ mail: early })))).toContain("ten-alternating");

    const extra: DelegationMailMessage = {
      ...exchange()[0]!,
      id: "chatter",
      body: "thanks",
      createdAt: at(200),
    };
    expect(failed(evaluatePeerScenario(input({ mail: [...exchange(), extra] })))).toContain(
      "ten-alternating",
    );
  });

  test("late dispatch confirmation does not invalidate a reply to the delivered parent", () => {
    const mail = exchange();
    // Dispatch happened at t=12; the reply at t=20 preceded reconciliation at t=25.
    mail[0] = { ...mail[0]!, injectedAt: at(25) };
    expect(failed(evaluatePeerScenario(input({ mail })))).toEqual([]);
  });

  test("a reply without the earlier parent, or with the wrong parent, fails", () => {
    for (const replyToMessageId of [undefined, "message-8"]) {
      const mail = exchange();
      mail[1] = { ...mail[1]!, replyToMessageId };
      expect(failed(evaluatePeerScenario(input({ mail })))).toContain("ten-alternating");
    }
  });

  test.each([
    ["mcp__orkestrator__read_messages", {}],
    ["orkestrator_get_message_status", {}],
    ["list_environments", {}],
    ["exec_command", { cmd: "sleep 2" }],
    ["clock__sleep", { duration_ms: 100 }],
    ["wait_agent", {}],
    ["Monitor", {}],
    ["ScheduleWakeup", {}],
    ["CronCreate", {}],
    ["exec", { code: "await tools.mcp__orkestrator__read_messages({})" }],
    ["exec", { code: "await tools.clock__sleep({duration_ms: 1000})" }],
  ])("forbidden waiting or polling via %s fails conformance", (toolName, toolArgs) => {
    const transcripts = input().transcripts;
    expect(
      failed(
        evaluatePeerScenario(
          input({
            transcripts: {
              ...transcripts,
              [RESPONDER]: [
                ...transcripts[RESPONDER]!,
                {
                  role: "assistant",
                  parts: [{ type: "tool", toolName, toolArgs, toolState: "completed" }],
                },
              ],
            },
          }),
        ),
      ),
    ).toContain("no-wait-or-poll");
  });

  test("send and reply tool arguments mentioning waiting are not waits", () => {
    const transcripts = input().transcripts;
    expect(
      failed(
        evaluatePeerScenario(
          input({
            transcripts: {
              ...transcripts,
              [RESPONDER]: [
                {
                  role: "assistant",
                  parts: [
                    {
                      type: "tool",
                      toolName: "mcp__orkestrator__reply_message",
                      toolArgs: { body: "sleep 2" },
                      toolState: "completed",
                    },
                  ],
                },
              ],
            },
          }),
        ),
      ),
    ).toEqual([]);
  });

  test("a short exchange or a missing done line fails", () => {
    expect(failed(evaluatePeerScenario(input({ mail: exchange().slice(0, 9) })))).toContain(
      "ten-alternating",
    );
    expect(
      failed(
        evaluatePeerScenario(
          input({
            transcripts: { [OPENER]: [row("user", "startup")], [RESPONDER]: [] },
          }),
        ),
      ),
    ).toContain("ten-alternating");
  });

  test("an escaped approval, a harness prompt or an extra user row is a user action", () => {
    expect(
      failed(evaluatePeerScenario(input({ escapedInteractions: ["command-approval"] }))),
    ).toContain("no-user-action");
    expect(failed(evaluatePeerScenario(input({ harnessPrompts: 1 })))).toContain("no-user-action");
    expect(
      failed(
        evaluatePeerScenario(
          input({
            transcripts: {
              ...input().transcripts,
              [RESPONDER]: [row("user", "startup"), row("user", "keep going")],
            },
          }),
        ),
      ),
    ).toContain("no-user-action");
  });

  test("a missing peer fails without throwing", () => {
    const result = failed(evaluatePeerScenario(input({ opener: undefined })));
    expect(result).toContain("both-peers-started");
    expect(result).toContain("ten-alternating");
  });

  test("the exchange is finished only when the done line is written, both are idle and nothing waits", () => {
    const observation = {
      at: 0,
      phases: { [OPENER]: "idle", [RESPONDER]: "idle" },
      mail: exchange(),
    };
    const done = [row("assistant", PEER_DONE_MARKER)];
    expect(peerExchangeFinished(observation, done)).toBe(true);
    expect(peerExchangeFinished(observation, [])).toBe(false);
    expect(
      peerExchangeFinished(
        { ...observation, phases: { ...observation.phases, [RESPONDER]: "running" } },
        done,
      ),
    ).toBe(false);
    expect(
      peerExchangeFinished(
        {
          ...observation,
          mail: [...exchange(), { ...exchange()[0]!, id: "late", placement: "pending-inject" }],
        },
        done,
      ),
    ).toBe(false);
  });
  test("an early done marker cannot finish a short exchange or a later acknowledgement", () => {
    const observation = {
      at: 0,
      phases: { [OPENER]: "idle", [RESPONDER]: "idle" },
      mail: exchange(),
    };
    const early = [row("assistant", PEER_DONE_MARKER), row("assistant", "ready")];
    expect(peerExchangeFinished({ ...observation, mail: exchange().slice(0, 1) }, early)).toBe(
      false,
    );
    expect(
      peerExchangeFinished({ ...observation, mail: exchange().slice(0, 1) }, early.slice(0, 1)),
    ).toBe(false);
    expect(peerExchangeFinished(observation, early)).toBe(false);
    expect(
      peerExchangeFinished(observation, [row("assistant", `I will write ${PEER_DONE_MARKER}`)]),
    ).toBe(false);
    expect(
      failed(
        evaluatePeerScenario(input({ transcripts: { ...input().transcripts, [OPENER]: early } })),
      ),
    ).toContain("ten-alternating");
  });
});

describe("peer watch", () => {
  function backend(
    phases: Record<string, string>,
    errors: Record<string, string> = {},
    auth: Record<string, string> = {},
  ) {
    const commands: Array<{ command: string; args: Record<string, unknown> }> = [];
    const invoke = async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
      commands.push({ command, args });
      const environmentId = String(args.environmentId);
      switch (command) {
        case "get_agent_mail_mailbox":
          return {
            messages: exchange()
              .filter((message) => message.toEnvironmentId === environmentId)
              .map((message) => ({ ...message, body: undefined })),
          } as T;
        case "get_native_agent_projection":
          return {
            turn: { phase: phases[environmentId] ?? "idle", error: errors[environmentId] },
            messages: [],
            interactions:
              environmentId === RESPONDER
                ? [{ id: "ask", kind: "command-approval", state: "pending", sessionId: "s" }]
                : [],
          } satisfies CoordinatorTurnProjection as T;
        case "get_native_agent_auth_status":
          return (auth[environmentId] ? { state: auth[environmentId] } : null) as T;
        case "get_agent_mail_message":
          return { body: `body of ${String(args.messageId)}` } as T;
        default:
          return null as T;
      }
    };
    return { invoke, commands };
  }

  test("reads both peers' startup tabs, denies an escaped approval once, and fetches bodies", async () => {
    const { invoke, commands } = backend({});
    const watch = createPeerWatch({
      invoke,
      platform: "codex",
      peers: [{ environmentId: RESPONDER }],
      pollIntervalMs: 1,
    });
    watch.add({ environmentId: OPENER });
    watch.add({ environmentId: OPENER });
    const observation = await watch.observe();
    await watch.observe();
    expect(Object.keys(observation.phases).toSorted()).toEqual([OPENER, RESPONDER].toSorted());
    expect(observation.mail).toHaveLength(PEER_MESSAGE_COUNT);
    expect(observation.mail.every((message) => message.body === undefined)).toBe(true);
    const projections = commands.filter((item) => item.command === "get_native_agent_projection");
    expect(projections[0]!.args).toMatchObject({
      environmentId: RESPONDER,
      logicalSessionKey: `env-${RESPONDER}:${PEER_TAB_ID}`,
    });
    const denials = commands.filter((item) => item.command === "resolve_native_agent_interaction");
    expect(denials).toHaveLength(1);
    expect(denials[0]!.args).toMatchObject({
      environmentId: RESPONDER,
      interactionId: "ask",
      resolution: { action: "deny" },
    });
    expect(watch.escaped()).toEqual(["command-approval"]);
    const mail = await watch.mailWithBodies();
    expect(mail[0]!.body).toBe(`body of ${mail[0]!.id}`);
  });

  test("a peer turn failing on sign-in is a skip; any other failure is not", async () => {
    const signedOut = createPeerWatch({
      invoke: backend({ [OPENER]: "error" }, { [OPENER]: "401: Grok Build isn't signed in" })
        .invoke,
      platform: "grok",
      peers: [{ environmentId: OPENER }],
      pollIntervalMs: 1,
    });
    await expect(signedOut.until("anything", () => false, 1_000)).rejects.toBeInstanceOf(
      PeerSignInError,
    );
    const broken = createPeerWatch({
      invoke: backend({ [OPENER]: "error" }, { [OPENER]: "model crashed" }).invoke,
      platform: "codex",
      peers: [{ environmentId: OPENER }],
      pollIntervalMs: 1,
    });
    const error = await broken.until("anything", () => false, 1_000).catch((caught) => caught);
    expect(error).not.toBeInstanceOf(PeerSignInError);
    expect(String(error)).toContain("model crashed");
  });

  test("a signed-out session is a skip even when its turn never starts", async () => {
    const watch = createPeerWatch({
      invoke: backend({ [RESPONDER]: "idle" }, {}, { [RESPONDER]: "needs-auth" }).invoke,
      platform: "grok",
      peers: [{ environmentId: RESPONDER }],
      pollIntervalMs: 1,
    });
    const error = await watch
      .until("the startup turn", () => false, 1_000)
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(PeerSignInError);
    expect(String(error)).toContain("needs-auth");
    const signedIn = createPeerWatch({
      invoke: backend({ [RESPONDER]: "running" }, {}, { [RESPONDER]: "signed-in" }).invoke,
      platform: "codex",
      peers: [{ environmentId: RESPONDER }],
      pollIntervalMs: 1,
    });
    await expect(signedIn.until("the startup turn", () => false, 5)).rejects.toThrow(/timed out/);
  });

  test("a throwing auth read classifies sign-in or unavailable even without a startup turn", async () => {
    for (const reason of ["authentication required", "bridge unreachable"]) {
      const base = backend({ [RESPONDER]: "idle" });
      const watch = createPeerWatch({
        invoke: async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
          if (command === "get_native_agent_auth_status") throw new Error(reason);
          return base.invoke<T>(command, args);
        },
        platform: "codex",
        peers: [{ environmentId: RESPONDER }],
        pollIntervalMs: 1,
      });
      const error = await watch
        .until("startup", () => true, 1_000)
        .catch((caught: unknown) => caught);
      if (reason === "authentication required") expect(error).toBeInstanceOf(PeerSignInError);
      else {
        expect(error).not.toBeInstanceOf(PeerSignInError);
        expect(String(error)).toContain("authentication status unavailable");
      }
    }
  });

  test("the wait times out with the label and the peers' phases", async () => {
    const watch = createPeerWatch({
      invoke: backend({ [OPENER]: "running" }).invoke,
      platform: "codex",
      peers: [{ environmentId: OPENER }],
      pollIntervalMs: 1,
    });
    await expect(watch.until("the exchange", () => false, 5)).rejects.toThrow(
      /timed out .* waiting for the exchange \(peers running\)/,
    );
  });
});
