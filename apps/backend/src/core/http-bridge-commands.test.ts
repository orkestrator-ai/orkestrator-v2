import { describe, expect, test } from "bun:test";
import { commandBindingRevision } from "@orkestrator/protocol/agent-command-catalogue";
import { withSessionActionSlashCommands } from "@orkestrator/protocol/agent-slash-commands";
import {
  nativeAgentCapabilities,
  type NativeAgentCommandIntent,
} from "@orkestrator/protocol/native-agent";
import type { BridgeConnection, NativeAgentRuntimeProvider } from "./agent-provider-contract.js";
import { PromptRejectedError } from "./native-agent-provider.js";
import {
  claudeConnection,
  codexConnection,
  cursorConnection,
  grokConnection,
  httpProvider,
  piConnection,
  type RequestRecord,
} from "./agent-provider-test-support.js";
import type { HttpBridgeAgent } from "./http-bridge-catalog.js";
import {
  NativeAgentCommandCatalogueCache,
  commandCatalogueKey,
} from "./native-agent-command-catalogue.js";
import { planCommandDispatch } from "./native-agent-command-dispatch.js";

/** Command catalogue and command-selection transport for HTTP bridges. */
describe("HTTP bridge command transport", () => {
  test("reads an enhanced catalogue with its status, revision and identities", async () => {
    const { provider } = httpProvider((url) =>
      url.endsWith("/session/session-1/commands")
        ? Response.json({
            catalogueVersion: 1,
            status: "ready",
            revision: 7,
            generation: "g-2",
            freshness: "push",
            commands: [
              {
                name: "/review",
                id: "claude:/review",
                executionKind: "provider-prompt",
                source: "project",
                bindingRevision: "b1",
              },
              // Enhanced rows without identity are dropped, never guessed.
              { name: "/anonymous", source: "project" },
            ],
          })
        : new Response(null, { status: 404 }),
    );
    const catalogue = await provider.commandCatalogue!("session-1");
    expect(catalogue).toMatchObject({
      enhanced: true,
      status: "ready",
      revision: 7,
      generation: "g-2",
      freshness: "push",
      truncated: true,
    });
    expect(catalogue.commands.map((command) => command.id)).toEqual(["claude:/review"]);
  });

  test("never seeds hard-coded Claude rows into a successful empty list", async () => {
    const { provider } = httpProvider((url) =>
      url.endsWith("/session/session-1/commands")
        ? Response.json({ catalogueVersion: 1, status: "ready", commands: [] })
        : new Response(null, { status: 404 }),
    );
    await expect(provider.commandCatalogue!("session-1")).resolves.toMatchObject({
      status: "ready",
      commands: [],
    });
    await expect(provider.slashCommands!("session-1")).resolves.toEqual([]);
  });

  test("an in-band missing session never falls back to a global list", async () => {
    const { provider, requests } = httpProvider((url) =>
      url.endsWith("/session/session-1/commands")
        ? Response.json({ catalogueVersion: 1, status: "missing", commands: [] })
        : Response.json({ commands: [{ name: "/global-only" }] }),
    );
    await expect(provider.commandCatalogue!("session-1")).resolves.toMatchObject({
      status: "missing",
      commands: [],
    });
    expect(requests).toHaveLength(1);
  });

  test("a 404 from a bridge predating the route falls back to its legacy list", async () => {
    const { provider } = httpProvider((url) => {
      if (url.endsWith("/session/session-1/commands")) return new Response(null, { status: 404 });
      if (url.endsWith("/global/slash-commands")) {
        return Response.json({ commands: [{ name: "/legacy", source: "builtin" }] });
      }
      return new Response(null, { status: 404 });
    }, codexConnection);
    const catalogue = await provider.commandCatalogue!("session-1");
    expect(catalogue).toMatchObject({ enhanced: false, status: "ready" });
    expect(catalogue.commands[0]).toMatchObject({ id: "legacy:/legacy" });
  });

  test("a malformed list is an error, not an empty catalogue", async () => {
    const { provider } = httpProvider(() => Response.json({ commands: "nope" }));
    await expect(provider.commandCatalogue!("session-1")).rejects.toThrow("malformed");
  });

  test("an explicit refresh reports the bridge's own outcome, or a re-read for older bridges", async () => {
    const current = httpProvider((url) =>
      url.endsWith("/session/session-1/commands/refresh")
        ? Response.json({ outcome: "deferred", message: "Will reload when idle" })
        : new Response(null, { status: 404 }),
    );
    await expect(current.provider.refreshCommands!("session-1")).resolves.toEqual({
      outcome: "deferred",
      message: "Will reload when idle",
    });
    expect(current.requests[0]!.init.method).toBe("POST");
    const legacy = httpProvider(() => new Response(null, { status: 404 }));
    await expect(legacy.provider.refreshCommands!("session-1")).resolves.toEqual({
      outcome: "reread",
    });
    const garbled = httpProvider(() => Response.json({ outcome: "teleported" }));
    await expect(garbled.provider.refreshCommands!("session-1")).resolves.toEqual({
      outcome: "failed",
    });
  });

  test("sends literal intent and the resolved command in the prompt body", async () => {
    const { provider, requests } = httpProvider(
      () => Response.json({ status: "processing" }),
      claudeConnection,
    );
    const command = {
      id: "claude:/review",
      name: "/review",
      executionKind: "provider-prompt" as const,
      bindingRevision: "b1",
      arguments: "line one\nline two ",
    };
    await provider.send("session-1", "/review line one\nline two ", {
      requestId: "r-1",
      allowProviderCommands: true,
      command,
    });
    await provider.send("session-1", "/review as text", {
      requestId: "r-2",
      allowProviderCommands: false,
    });
    const first = JSON.parse(String(requests[0]!.init.body));
    expect(first).toMatchObject({ allowProviderCommands: true, command });
    const second = JSON.parse(String(requests[1]!.init.body));
    expect(second.allowProviderCommands).toBe(false);
    expect(second.command).toBeUndefined();
  });

  test("a bridge's refusal of an id an earlier process claimed is a lost outcome", async () => {
    const { provider } = httpProvider(
      () =>
        Response.json(
          {
            error: "Claude prompt outcome is no longer available; resubmit with a new requestId",
            kind: "dispatch-outcome-lost",
          },
          { status: 410 },
        ),
      claudeConnection,
    );
    const failure = provider.send("session-1", "/deploy", { requestId: "r-1" });
    await expect(failure).rejects.toMatchObject({ requestIdRetired: true });
    // In the user's terms, not the bridge's request-id wording.
    await expect(failure).rejects.toThrow(
      /^Claude Code could not confirm this message, so it may not have run\. Check the conversation and send it again if it did not\.$/,
    );

    // Any other 410 is still a plain rejection.
    const { provider: other } = httpProvider(
      () => Response.json({ error: "cannot reload" }, { status: 410 }),
      claudeConnection,
    );
    const plain = other.send("session-1", "hi", { requestId: "r-2" });
    await expect(plain).rejects.toBeInstanceOf(PromptRejectedError);
    await expect(plain).rejects.toMatchObject({ requestIdRetired: false });
  });

  test("a bridge refusing a selected command is a plain rejection with its own message", async () => {
    const { provider } = httpProvider(
      () =>
        Response.json(
          { error: "/review is no longer available.", kind: "command-unavailable" },
          { status: 422 },
        ),
      cursorConnection,
    );
    const failure = provider.send("session-1", "/review", { requestId: "r-1" });
    await expect(failure).rejects.toBeInstanceOf(PromptRejectedError);
    await expect(failure).rejects.toThrow(/^\/review is no longer available\.$/);
  });
});

/*
 * Mixed-version matrix, new backend against an older bridge.
 *
 * The shapes are the ones bridges actually served before the version-1
 * catalogue landed in ff4026b4e (#827); read them with
 * `git show 'ff4026b4e^:<path>'`:
 *
 * - every bridge served `GET /session/:id/commands` as `{ commands: [...] }`
 *   with no `catalogueVersion` (the route came in 5df7dec67, #599), had no
 *   `POST /session/:id/commands/refresh` and no `commandRevision` on its
 *   session snapshot;
 * - the legacy global routes: Claude `/plugins/commands` as
 *   `{ commands: string[] }` of `"/name - description"`, Codex
 *   `/global/slash-commands` as `{ commands: [records], cwd }`, Cursor
 *   `/global/slash-commands` as `{ commands: [] }`, Pi `/plugins/commands` as
 *   `{ commands: [{ name: "/compact", … }] }`, and nothing on the ACP bridge;
 * - an old Codex bridge answered an unknown session on the session route with
 *   a 404, which is why a 404 alone cannot tell "old bridge" from "unknown
 *   session".
 *
 * Every assertion runs the real HTTP provider, the real catalogue cache, the
 * real dispatch planner and the real prompt-body builder over a fetch fake.
 */
interface OldBridge {
  agent: HttpBridgeAgent;
  connection: BridgeConnection;
  legacyRoute: "/plugins/commands" | "/global/slash-commands" | null;
  /** What the bridge's session route answered before #827. */
  legacySessionRows: unknown[];
  /** What its legacy global route answered before #827 (null: no route). */
  legacyGlobalBody: Record<string, unknown> | null;
}

const OLD_BRIDGES: readonly OldBridge[] = [
  {
    agent: "claude",
    connection: claudeConnection,
    legacyRoute: "/plugins/commands",
    // `normalizeCommands` over the SDK's `supportedCommands()`.
    legacySessionRows: [
      { name: "/review", description: "Review changes", argumentHint: "<path>", source: "project" },
      { name: "/clear", description: "Clear conversation history", source: "builtin" },
    ],
    // `discoverSlashCommands`: a filesystem scan plus `BUILTIN_COMMANDS`.
    legacyGlobalBody: {
      commands: ["/clear - Clear conversation history", "/deploy", "/review - Review changes"],
    },
  },
  {
    agent: "codex",
    connection: codexConnection,
    legacyRoute: "/global/slash-commands",
    legacySessionRows: [
      { name: "/prompts:review", description: "Review", source: "template", scope: "global" },
      { name: "/skill:lint", description: "Lint", source: "skill", scope: "session" },
    ],
    legacyGlobalBody: {
      commands: [{ name: "/prompts:review", description: "Review", source: "template" }],
      cwd: "/workspace",
    },
  },
  {
    agent: "cursor",
    connection: cursorConnection,
    legacyRoute: "/global/slash-commands",
    legacySessionRows: [],
    legacyGlobalBody: { commands: [] },
  },
  {
    agent: "grok",
    connection: grokConnection,
    // The ACP bridge never served a global list.
    legacyRoute: null,
    // `available_commands_update`, normalized by the bridge.
    legacySessionRows: [
      {
        name: "/review",
        description: "Review",
        source: "builtin",
        scope: "session",
        argumentHint: "<path>",
      },
    ],
    legacyGlobalBody: null,
  },
  {
    agent: "pi",
    connection: piConnection,
    legacyRoute: "/plugins/commands",
    legacySessionRows: [
      { name: "/review", description: "Review", source: "template", argumentHint: "<path>" },
      { name: "/skill:lint", description: "Lint", source: "skill" },
    ],
    legacyGlobalBody: {
      commands: [{ name: "/compact", description: "Summarize the conversation to free context" }],
    },
  },
];

const GLOBAL_ROUTES = ["/plugins/commands", "/global/slash-commands"];

/**
 * A bridge fake: `routes` maps a path suffix to its answer; any route not
 * named answers 404, exactly as an older bridge does, except the prompt route,
 * which accepts.
 */
function oldBridgeProvider(
  bridge: OldBridge,
  routes: Record<string, () => Response>,
): { provider: NativeAgentRuntimeProvider; requests: RequestRecord[] } {
  return httpProvider((url, init) => {
    const path = new URL(url).pathname;
    const route = routes[path];
    if (route) return route();
    if (path === "/session/session-1/prompt" && init.method === "POST") {
      return Response.json({ status: "processing" });
    }
    return new Response(null, { status: 404 });
  }, bridge.connection);
}

/** Read the catalogue the way a projection or dispatch does, then report its cached answer. */
async function readCatalogue(bridge: OldBridge, provider: NativeAgentRuntimeProvider) {
  const cache = new NativeAgentCommandCatalogueCache({ now: () => 1_000, announce: () => {} });
  const key = commandCatalogueKey("env-1", bridge.agent, "session-1");
  await cache.readForDispatch(key, "env-1", provider, "session-1", true);
  const snapshot = cache.peek(key)!;
  // What the picker is handed: provider rows merged with Orkestrator's actions.
  const picker = withSessionActionSlashCommands(
    snapshot.commands,
    nativeAgentCapabilities(bridge.agent),
  );
  return { cache, key, snapshot, picker };
}

/** Plan a submission against the cached catalogue and send it like the service does. */
async function dispatch(
  bridge: OldBridge,
  read: Awaited<ReturnType<typeof readCatalogue>>,
  provider: NativeAgentRuntimeProvider,
  requests: RequestRecord[],
  prompt: string,
  intent: NativeAgentCommandIntent,
) {
  const plan = planCommandDispatch({
    platform: bridge.agent,
    agentLabel: bridge.agent,
    prompt,
    intent,
    commands: read.picker,
    catalogue: read.snapshot.state,
    structuredOutput: false,
    attachments: [],
  });
  if (plan.kind !== "prompt") return { plan, body: undefined };
  await provider.send("session-1", prompt, {
    requestId: `r-${requests.length}`,
    allowProviderCommands: plan.allowProviderCommands,
    ...(plan.command ? { command: plan.command } : {}),
  });
  const sent = requests.filter((request) => request.url.endsWith("/session/session-1/prompt"));
  return { plan, body: JSON.parse(String(sent.at(-1)!.init.body)) as Record<string, unknown> };
}

function providerRows(read: Awaited<ReturnType<typeof readCatalogue>>) {
  return read.snapshot.commands.map(({ id, name, executionKind, bindingRevision }) => ({
    id,
    name,
    executionKind,
    bindingRevision,
  }));
}

describe("mixed-version: new backend, old bridge", () => {
  for (const bridge of OLD_BRIDGES) {
    describe(bridge.agent, () => {
      test("a pre-catalogue session route is read as legacy rows that run as typed text", async () => {
        const { provider, requests } = oldBridgeProvider(bridge, {
          "/session/session-1/commands": () =>
            Response.json({ commands: bridge.legacySessionRows }),
          ...(bridge.legacyGlobalBody
            ? { [bridge.legacyRoute!]: () => Response.json(bridge.legacyGlobalBody) }
            : {}),
        });
        const read = await readCatalogue(bridge, provider);

        // The session route answered, so the global list is never consulted.
        expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
          "/session/session-1/commands",
        ]);
        expect(read.snapshot.state).toMatchObject({
          status: "ready",
          enhanced: false,
          freshness: "ttl",
        });
        expect(read.snapshot.state.error).toBeUndefined();
        expect(providerRows(read)).toEqual(
          (bridge.legacySessionRows as Array<{ name: string }>).map(({ name }) => ({
            id: `legacy:${name}`,
            name,
            executionKind: "provider-prompt",
            bindingRevision: "legacy",
          })),
        );

        // No refresh route: an explicit refresh is honestly a re-read.
        await expect(read.cache.refresh(read.key, "env-1", provider, "session-1")).resolves.toEqual(
          { outcome: "reread" },
        );
        expect(read.cache.peek(read.key)!.state.lastRefresh?.outcome).toBe("reread");

        const [first] = read.snapshot.commands;
        if (!first) return;
        // Choosing a legacy row from the picker sends the text, never a selection
        // the old bridge would silently ignore.
        const chosen = await dispatch(bridge, read, provider, requests, `${first.name} src/a.ts`, {
          kind: "selected",
          commandId: first.id!,
          bindingRevision: first.bindingRevision!,
        });
        expect(chosen.plan).toMatchObject({ kind: "prompt", allowProviderCommands: true });
        expect(chosen.body).toMatchObject({
          prompt: `${first.name} src/a.ts`,
          allowProviderCommands: true,
        });
        expect(chosen.body && "command" in chosen.body).toBe(false);

        // A selection naming an enhanced identity the old bridge never minted
        // cannot be matched, so nothing is sent.
        const sentBefore = requests.length;
        const guessed = await dispatch(bridge, read, provider, requests, `${first.name} x`, {
          kind: "selected",
          commandId: `${bridge.agent}:${first.name}`,
        });
        expect(guessed.plan).toMatchObject({ kind: "rejected", staleSelection: true });
        expect(requests).toHaveLength(sentBefore);
      });

      test("a session-route 404 falls back to the legacy global route per read, never stickily", async () => {
        const { provider, requests } = oldBridgeProvider(
          bridge,
          bridge.legacyGlobalBody
            ? { [bridge.legacyRoute!]: () => Response.json(bridge.legacyGlobalBody) }
            : {},
        );
        const read = await readCatalogue(bridge, provider);
        const paths = () => requests.map((request) => new URL(request.url).pathname);

        if (!bridge.legacyRoute) {
          // ACP: no global route either. A failure with nothing retained is
          // `unavailable` — not `unsupported`, and never an empty ready list.
          expect(paths()).toEqual(["/session/session-1/commands", "/plugins/commands"]);
          expect(read.snapshot.state).toMatchObject({
            status: "unavailable",
            enhanced: false,
            error: { code: "provider-error" },
          });
          expect(read.snapshot.commands).toEqual([]);
        } else {
          expect(paths()).toEqual(["/session/session-1/commands", bridge.legacyRoute]);
          expect(read.snapshot.state).toMatchObject({ status: "ready", enhanced: false });
          // A 404 is not read as "this session is missing" either.
          expect(read.snapshot.state.error).toBeUndefined();
          expect(read.snapshot.commands.every((command) => command.id!.startsWith("legacy:"))).toBe(
            true,
          );
        }
        // Only Orkestrator's own actions carry a non-legacy identity in the picker.
        expect(
          read.picker
            .filter((command) => command.executionKind !== "session-action")
            .every((command) => command.id!.startsWith("legacy:")),
        ).toBe(true);

        // The fallback is decided per read: the next read asks the session
        // route again, so a bridge upgraded in place is picked up at once.
        await read.cache.readForDispatch(read.key, "env-1", provider, "session-1", true);
        expect(paths().filter((path) => path === "/session/session-1/commands")).toHaveLength(2);
        expect(paths().filter((path) => GLOBAL_ROUTES.includes(path))).toHaveLength(2);
      });

      test("a version-1 catalogue without its optional fields is enhanced and executes as a selection", async () => {
        const id = `${bridge.agent}:/review`;
        const { provider, requests } = oldBridgeProvider(bridge, {
          // No status, revision, generation, freshness, truncated; rows with no
          // source, binding revision, availability or input policy.
          "/session/session-1/commands": () =>
            Response.json({
              catalogueVersion: 1,
              commands: [{ name: "/review", id, executionKind: "provider-prompt" }],
            }),
        });
        const read = await readCatalogue(bridge, provider);
        expect(read.snapshot.state).toMatchObject({
          status: "ready",
          enhanced: true,
          freshness: "ttl",
        });
        expect(read.snapshot.state.truncated).toBeUndefined();
        expect(read.snapshot.commands).toEqual([
          {
            name: "/review",
            source: "unknown",
            id,
            executionKind: "provider-prompt",
            bindingRevision: commandBindingRevision([id]),
          },
        ]);

        // Without a bridge-reported revision there is nothing for a snapshot's
        // `commandRevision` to differ from, so no push revalidation starts.
        const reads = requests.length;
        read.cache.observeProviderRevision(read.key, "env-1", provider, "session-1", 9);
        await read.cache.settle();
        expect(requests).toHaveLength(reads);

        const sent = await dispatch(bridge, read, provider, requests, "/review  a\n b ", {
          kind: "selected",
          commandId: id,
          bindingRevision: commandBindingRevision([id]),
        });
        expect(sent.body?.command).toEqual({
          id,
          name: "/review",
          executionKind: "provider-prompt",
          bindingRevision: commandBindingRevision([id]),
          arguments: "a\n b ",
        });
      });

      test("a version-1 row with an availability state this backend does not know is never run", async () => {
        const id = `${bridge.agent}:/deploy`;
        const { provider, requests } = oldBridgeProvider(bridge, {
          "/session/session-1/commands": () =>
            Response.json({
              catalogueVersion: 1,
              status: "ready",
              commands: [
                {
                  name: "/deploy",
                  id,
                  executionKind: "provider-prompt",
                  availability: { state: "requires-confirmation", message: "Confirm first" },
                },
              ],
            }),
        });
        const read = await readCatalogue(bridge, provider);
        expect(read.snapshot.commands[0]!.availability).toEqual({
          state: "unavailable",
          reason: "unsupported",
          message: "Confirm first",
        });
        const sentBefore = requests.length;
        for (const intent of [
          { kind: "typed" } as const,
          {
            kind: "selected",
            commandId: id,
            bindingRevision: commandBindingRevision([id]),
          } as const,
        ]) {
          expect(
            (await dispatch(bridge, read, provider, requests, "/deploy now", intent)).plan,
          ).toMatchObject({ kind: "rejected" });
        }
        expect(requests).toHaveLength(sentBefore);
      });

      test("an unknown future catalogue version degrades to display rows that run as typed text", async () => {
        const id = `${bridge.agent}:/deploy`;
        const { provider, requests } = oldBridgeProvider(bridge, {
          "/session/session-1/commands": () =>
            Response.json({
              catalogueVersion: 2,
              status: "ready",
              commands: [
                { name: "/deploy", id, executionKind: "structured-skill", source: "skill" },
                {
                  name: "/clear",
                  id: `${bridge.agent}:/clear`,
                  executionKind: "provider-prompt",
                  availability: { state: "unavailable", reason: "session-changing" },
                },
              ],
            }),
        });
        const read = await readCatalogue(bridge, provider);
        // Version 1 is the only contract this backend can execute against.
        expect(read.snapshot.state).toMatchObject({ status: "ready", enhanced: false });
        expect(providerRows(read)).toEqual([
          {
            id: "legacy:/deploy",
            name: "/deploy",
            executionKind: "provider-prompt",
            bindingRevision: "legacy",
          },
          {
            id: "legacy:/clear",
            name: "/clear",
            executionKind: "provider-prompt",
            bindingRevision: "legacy",
          },
        ]);
        // Unavailability survives the downgrade: it is never read as permission.
        expect(read.snapshot.commands[1]!.availability).toEqual({
          state: "unavailable",
          reason: "session-changing",
        });

        const typed = await dispatch(bridge, read, provider, requests, "/deploy now", {
          kind: "selected",
          commandId: "legacy:/deploy",
          bindingRevision: "legacy",
        });
        expect(typed.body).toMatchObject({ prompt: "/deploy now", allowProviderCommands: true });
        expect(typed.body && "command" in typed.body).toBe(false);

        const sentBefore = requests.length;
        // The bridge's own (future) identity is not one this backend can bind.
        expect(
          (
            await dispatch(bridge, read, provider, requests, "/deploy now", {
              kind: "selected",
              commandId: id,
            })
          ).plan,
        ).toMatchObject({ kind: "rejected", staleSelection: true });
        expect(
          (await dispatch(bridge, read, provider, requests, "/clear", { kind: "typed" })).plan,
        ).toMatchObject({ kind: "rejected" });
        expect(requests).toHaveLength(sentBefore);
      });

      test("a malformed body fails the read instead of becoming an empty ready list", async () => {
        const bodies: Array<{ label: string; response: () => Response; code: string }> = [
          {
            label: "not JSON",
            response: () => new Response("<html>proxy error</html>", { status: 200 }),
            // Reported as a generic provider error today, not "malformed".
            code: "provider-error",
          },
          { label: "an array", response: () => Response.json([]), code: "malformed" },
          {
            label: "commands is not a list",
            response: () => Response.json({ catalogueVersion: 1, commands: "nope" }),
            code: "malformed",
          },
        ];
        for (const { label, response, code } of bodies) {
          const { provider } = oldBridgeProvider(bridge, {
            "/session/session-1/commands": response,
          });
          const read = await readCatalogue(bridge, provider);
          expect({
            label,
            state: read.snapshot.state.status,
            commands: read.snapshot.commands,
          }).toEqual({ label, state: "unavailable", commands: [] });
          expect(read.snapshot.state.error?.code).toBe(code as never);
        }

        // With a list already retained, the same failure keeps it as stale.
        let healthy = true;
        const { provider } = oldBridgeProvider(bridge, {
          "/session/session-1/commands": () =>
            healthy
              ? Response.json({ commands: [{ name: "/review", source: "project" }] })
              : Response.json({ commands: { not: "a list" } }),
        });
        const read = await readCatalogue(bridge, provider);
        healthy = false;
        await read.cache.readForDispatch(read.key, "env-1", provider, "session-1", true);
        expect(read.cache.peek(read.key)).toMatchObject({
          commands: [{ id: "legacy:/review" }],
          state: { status: "stale", error: { code: "malformed" } },
        });
      });

      test("a session snapshot without commandRevision reports no catalogue revision", async () => {
        const snapshotFor = async (extra: Record<string, unknown>) => {
          const { provider } = httpProvider((url) => {
            const path = new URL(url).pathname;
            if (path.endsWith("/messages")) return Response.json({ messages: [] });
            if (path.endsWith("/runtime-health")) return new Response(null, { status: 404 });
            // The fields each bridge's snapshot already carried before #827.
            return Response.json({
              status: "idle",
              revision: 1,
              composer: { models: [], modes: [], fastModeEnabled: null, fastModeAvailable: false },
              ...extra,
            });
          }, bridge.connection);
          return provider.interactiveSnapshot!("session-1");
        };
        expect((await snapshotFor({})).commandCatalogueRevision).toBeUndefined();
        // A bridge that does publish it is read as the push signal.
        expect((await snapshotFor({ commandRevision: 4 })).commandCatalogueRevision).toBe(4);
        // Anything that is not a safe integer is ignored, never a revision.
        expect(
          (await snapshotFor({ commandRevision: "4" })).commandCatalogueRevision,
        ).toBeUndefined();
      });
    });
  }

  test("old Claude global rows keep only bare names; described and guessed built-ins are dropped", async () => {
    // Reached only when the session route 404s (a bridge older than #599) or
    // for a sessionless read. `"/name - description"` is not a command name,
    // so every `BUILTIN_COMMANDS` row is rejected rather than guessed.
    const bridge = OLD_BRIDGES[0]!;
    const { provider } = oldBridgeProvider(bridge, {
      "/plugins/commands": () => Response.json(bridge.legacyGlobalBody),
    });
    const read = await readCatalogue(bridge, provider);
    expect(read.snapshot.state).toMatchObject({
      status: "ready",
      enhanced: false,
      truncated: true,
    });
    expect(providerRows(read)).toEqual([
      {
        id: "legacy:/deploy",
        name: "/deploy",
        executionKind: "provider-prompt",
        bindingRevision: "legacy",
      },
    ]);
  });

  test("an old Codex bridge's 404 for an unknown session yields legacy rows, never a selection", async () => {
    // Before #827 Codex answered an unknown session with 404, which the
    // backend cannot tell from a route that predates the contract.
    const bridge = OLD_BRIDGES[1]!;
    const { provider, requests } = oldBridgeProvider(bridge, {
      "/session/session-1/commands": () =>
        Response.json({ error: "Session not found" }, { status: 404 }),
      "/global/slash-commands": () => Response.json(bridge.legacyGlobalBody),
    });
    const read = await readCatalogue(bridge, provider);
    expect(read.snapshot.state).toMatchObject({ status: "ready", enhanced: false });
    expect(read.snapshot.commands.map((command) => command.id)).toEqual(["legacy:/prompts:review"]);
    const sent = await dispatch(bridge, read, provider, requests, "/prompts:review x", {
      kind: "selected",
      commandId: "legacy:/prompts:review",
      bindingRevision: "legacy",
    });
    expect(sent.body && "command" in sent.body).toBe(false);
  });
});
