/**
 * The `native-sessions` commands are registered with their definitions (plan
 * item 7001): the registry holds each definition, advertises the domain in
 * the hello, keeps every key the handlers read (a defined command drops the
 * keys it does not declare), drops unknown ones and refuses an unknown
 * critical key.
 */
import { expect, mock, test } from "bun:test";
import { NATIVE_SESSIONS_COMMANDS } from "@orkestrator/protocol/contract/domains/native-sessions";
import { createCommandRegistry, type CommandContext } from "./commands.js";

const identity = { environmentId: "env-1", agent: "codex", logicalSessionKey: "tab-1" };

test("registers every native-sessions command with its definition", () => {
  const registry = createCommandRegistry();
  for (const def of NATIVE_SESSIONS_COMMANDS) {
    expect({ name: def.name, defined: registry.contracts.get(def.name) === def }).toEqual({
      name: def.name,
      defined: true,
    });
  }
  expect(registry.helloDomains()["native-sessions"]).toEqual({ min: 1, max: 1 });
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
        version: 2,
      }))(),
  ).rejects.toMatchObject({ code: "unsupported-version" });
});
