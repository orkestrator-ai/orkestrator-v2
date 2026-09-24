import { describe, expect, test } from "bun:test";
import { PromptRejectedError } from "./native-agent-provider.js";
import {
  claudeConnection,
  codexConnection,
  cursorConnection,
  httpProvider,
} from "./agent-provider-test-support.js";

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
