import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";

import { backendTargetId } from "./targets.js";
import {
  createFixture,
  entry,
  mutation,
  revision,
  targetIdFor,
  type Fixture,
} from "./test-support.js";

let fixture: Fixture;

beforeEach(() => {
  fixture = createFixture({ env: {} });
});

afterEach(() => {
  fixture.cleanup();
});

const USER_SOURCE: Record<AgentPlatform, string> = {
  claude: "claude:user",
  codex: "codex:user",
  opencode: "opencode:user-opencode.json",
  cursor: "cursor:user",
  grok: "grok:user",
  pi: "pi:user",
};

async function addBoth(provider: AgentPlatform) {
  const targetId = await targetIdFor(fixture, provider, "backend");
  const sourceId = USER_SOURCE[provider];
  await fixture.service.mutate(
    mutation(targetId, {
      kind: "add",
      sourceId,
      expectedRevision: null,
      definition: { name: "local", transport: "stdio", command: "run-me", args: ["a"] },
    }),
  );
  let snapshot = await fixture.service.snapshot({ targetId });
  await fixture.service.mutate(
    mutation(targetId, {
      kind: "add",
      sourceId,
      expectedRevision: revision(snapshot, sourceId),
      definition: { name: "remote", transport: "http", url: "https://r.example/mcp" },
    }),
  );
  snapshot = await fixture.service.snapshot({ targetId });
  const update = (name: string, patch: Record<string, unknown>) =>
    fixture.service.mutate(
      mutation(targetId, {
        kind: "update",
        entryId: entry(snapshot, sourceId, name).entryId,
        expectedRevision: revision(snapshot, sourceId)!,
        patch: patch as never,
      }),
    );
  return { targetId, sourceId, update };
}

describe("fields a transport cannot carry are refused, never silently dropped", () => {
  for (const provider of ["claude", "codex", "opencode", "cursor", "grok", "pi"] as const) {
    test(`${provider}: url on stdio and command/args on remote are refused`, async () => {
      const { update } = await addBoth(provider);
      await expect(
        update("local", { url: { kind: "set", value: "https://x.example/mcp" } }),
      ).rejects.toThrow("A stdio server has no URL");
      await expect(update("remote", { command: { kind: "set", value: "run-me" } })).rejects.toThrow(
        "A remote server has no command",
      );
      await expect(update("remote", { args: [{ kind: "set", value: "a" }] })).rejects.toThrow(
        "A remote server has no arguments",
      );
    });
  }

  for (const provider of ["codex", "opencode", "cursor", "grok", "pi"] as const) {
    test(`${provider}: environment on a remote server is refused because the file cannot hold it`, async () => {
      const { update } = await addBoth(provider);
      await expect(
        update("remote", { env: [{ key: "TOKEN", edit: { kind: "set", value: "${TOKEN}" } }] }),
      ).rejects.toThrow("remote servers do not take environment variables");
    });
  }

  test("claude keeps environment on a remote entry, so it is accepted", async () => {
    const { update } = await addBoth("claude");
    await update("remote", { env: [{ key: "TOKEN", edit: { kind: "set", value: "${TOKEN}" } }] });
    expect(JSON.parse(fixture.read("home/.claude.json")).mcpServers.remote.env).toEqual({
      TOKEN: "${TOKEN}",
    });
  });

  test("a working directory on a new remote server is refused", async () => {
    const targetId = await targetIdFor(fixture, "codex", "backend");
    await expect(
      fixture.service.mutate(
        mutation(targetId, {
          kind: "add",
          sourceId: "codex:user",
          expectedRevision: null,
          definition: {
            name: "remote",
            transport: "http",
            url: "https://r.example/mcp",
            cwd: "/tmp",
          },
        }),
      ),
    ).rejects.toThrow("A remote server has no working directory");
  });

  test("a transport switch that names what it discards still works", async () => {
    const { update } = await addBoth("codex");
    await update("local", {
      transport: { to: "http", discard: ["command", "args"] },
      url: { kind: "set", value: "https://now-remote.example/mcp" },
    });
    const parsed = Bun.TOML.parse(fixture.read("home/.codex/config.toml")) as any;
    expect(parsed.mcp_servers.local).toEqual({ url: "https://now-remote.example/mcp" });
  });
});

describe("target ids are bound to this backend", () => {
  test("a backend target id minted by another backend is unknown here", async () => {
    const own = await targetIdFor(fixture, "claude", "backend");
    expect(own).toBe(backendTargetId("claude", "backend-1"));
    await fixture.service.snapshot({ targetId: own });
    for (const foreign of [
      backendTargetId("claude", "backend-2"),
      "mcp1~claude~backend",
      `${own}~extra`,
    ]) {
      await expect(fixture.service.snapshot({ targetId: foreign })).rejects.toThrow(
        "unknown-target",
      );
    }
  });
});
