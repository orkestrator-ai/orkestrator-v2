/**
 * The `native-sessions` commands are registered with their definitions (plan
 * item 7001): the registry holds each definition, advertises the domain in
 * the hello, keeps every key the handlers read (a defined command drops the
 * keys it does not declare), drops unknown ones and refuses an unknown
 * critical key.
 */
import { expect, mock, test } from "bun:test";
import { NATIVE_SESSIONS_COMMANDS } from "@orkestrator/protocol/contract/domains/native-sessions";
import { createCommandRegistry } from "./registry.js";
import type { CommandContext } from "./context.js";

const identity = { environmentId: "env-1", agent: "codex", logicalSessionKey: "tab-1" };

test("registers every native-sessions command with its definition", () => {
  const registry = createCommandRegistry();
  for (const def of NATIVE_SESSIONS_COMMANDS) {
    expect({ name: def.name, defined: registry.contracts.get(def.name) === def }).toEqual({
      name: def.name,
      defined: true,
    });
  }
  expect(registry.helloDomains()["native-sessions"]).toEqual({ min: 1, max: 6 });
});

test("a dispatch reaches the service with every key the parser reads", async () => {
  const dispatchIntent = mock(async () => ({ outcome: "accepted", requestId: "r1" }));
  const context = {
    nativeAgents: { dispatchIntent },
    storage: { resetAgentMailBudgetForSession: mock(async () => undefined) },
  } as unknown as CommandContext;
  const command = createCommandRegistry().get("dispatch_native_agent_intent")!;
  const args = {
    ...identity,
    prompt: "Build it",
    requestId: "r1",
    title: "Tab",
    model: "gpt",
    modelSource: "default",
    reasoningEffort: "high",
    phase: "build",
    sessionMode: "build",
    executionProfileId: "profile-1",
    approvalMode: "on-request",
    mode: "build",
    fastMode: true,
    parameterValues: { verbosity: "low" },
    subAgent: "reviewer",
    executionAgent: "codex",
    includeLocalSettings: true,
    promptSuggestions: false,
    schema: { type: "object" },
    clientTimeZone: "Europe/London",
    command: { kind: "literal" },
    unknownKey: "dropped",
  };
  await command(args, context);
  const input = (dispatchIntent.mock.calls[0] as unknown as [Record<string, unknown>])[0];
  expect(input).toMatchObject({
    ...identity,
    prompt: "Build it",
    requestId: "r1",
    title: "Tab",
    model: "gpt",
    modelSource: "default",
    reasoningEffort: "high",
    phase: "build",
    sessionMode: "build",
    executionProfileId: "profile-1",
    approvalMode: "on-request",
    mode: "build",
    fastMode: true,
    parameterValues: { verbosity: "low" },
    subAgent: "reviewer",
    executionAgent: "codex",
    includeLocalSettings: true,
    promptSuggestions: false,
    schema: { type: "object" },
    clientTimeZone: "Europe/London",
    command: { kind: "literal" },
  });
  expect(input).not.toHaveProperty("unknownKey");
});

test("an unknown critical key is refused before the handler runs", async () => {
  const getSession = mock(async () => null);
  const context = { storage: { getSession } } as unknown as CommandContext;
  const command = createCommandRegistry().get("get_session")!;
  await expect(
    (async () =>
      command({ sessionId: "s1", future: true }, context, {
        domain: "native-sessions",
        version: 1,
        critical: ["future"],
      }))(),
  ).rejects.toMatchObject({ code: "unsupported-field" });
  expect(getSession).not.toHaveBeenCalled();
  // A key the definition declares may be critical.
  await command({ sessionId: "s1" }, context, {
    domain: "native-sessions",
    version: 1,
    critical: ["sessionId"],
  });
  expect(getSession).toHaveBeenCalledWith("s1");
});

test("a native-sessions version outside the range is refused", async () => {
  const command = createCommandRegistry().get("get_session")!;
  await expect(
    (async () =>
      command({ sessionId: "s1" }, {} as CommandContext, {
        domain: "native-sessions",
        version: 999,
      }))(),
  ).rejects.toMatchObject({ code: "unsupported-version" });
});

test("session activity lists the environment's in-flight turns from the observer alone", async () => {
  const sessions = [
    { environmentId: "env-1", agent: "codex", logicalSessionKey: "env-env-1:busy" },
    { environmentId: "env-1", agent: "claude", logicalSessionKey: "env-env-1:asking" },
    { environmentId: "env-1", agent: "claude", logicalSessionKey: "env-env-1:idle" },
    { environmentId: "env-1", agent: "pi", logicalSessionKey: "env-env-1:unseen" },
    { environmentId: "env-2", agent: "codex", logicalSessionKey: "env-env-2:busy" },
  ];
  const states: Record<string, string> = {
    "env-env-1:busy": "working",
    "env-env-1:asking": "waiting",
    "env-env-1:idle": "idle",
    "env-env-1:unseen": "unknown",
    "env-env-2:busy": "working",
  };
  const sessionTurnActivitySnapshot = mock(
    (_environmentId: string, _agent: string, key: string) => states[key],
  );
  const context = {
    nativeAgents: { sessionTurnActivitySnapshot },
    storage: { readNativeAgentSessionsSnapshot: mock(async () => sessions) },
  } as unknown as CommandContext;
  const command = createCommandRegistry().get("list_native_agent_session_activity")!;
  expect(await command({ environmentId: "env-1" }, context)).toEqual({
    sessions: { "env-env-1:busy": "working", "env-env-1:asking": "waiting" },
  });
  expect(sessionTurnActivitySnapshot).toHaveBeenCalledTimes(4);
  // Without the native agent service nothing is in flight.
  expect(
    await command({ environmentId: "env-1" }, {
      storage: context.storage,
    } as unknown as CommandContext),
  ).toEqual({ sessions: {} });
});
