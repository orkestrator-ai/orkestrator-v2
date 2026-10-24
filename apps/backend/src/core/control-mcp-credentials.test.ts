import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CONTROL_MCP_PROFILE_CAPABILITIES } from "@orkestrator/protocol/control-mcp";
import { ConfirmTokens } from "./control-mcp-confirm.js";
import { ControlMcpServer, readControlMcpDescriptor } from "./control-mcp-server.js";
import { rpc } from "./control-mcp-test-support.js";
import type { ControlMcpInvoker } from "./control-shared-actions.js";

/** Named operator credentials: migration, independent rotation and revocation, and validation. */

const invoke: ControlMcpInvoker = async <T>(command: string) => {
  if (command === "get_config") return { global: { agentMessaging: { enabled: true } } } as T;
  if (command === "get_project_coordinator") {
    return {
      workspace: {
        id: "coordinator-1",
        lifecycleState: "ready",
        conversations: [
          { id: "conversation-1", tabId: "tab-1", mailboxIncarnationId: "incarnation-1" },
        ],
      },
    } as T;
  }
  throw new Error(`Unexpected command: ${command}`);
};

describe("Control MCP credentials", () => {
  let dataDir: string;
  let server: ControlMcpServer;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "ork-control-mcp-credentials-"));
    server = new ControlMcpServer(dataDir, invoke, { port: 0 });
  });

  afterEach(async () => {
    await server.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a version 1 token becomes the full-profile default credential", async () => {
    const legacyToken = "legacy-token-abcdefghijklmnopqrstuvwxyz012345";
    await writeFile(
      path.join(dataDir, "control-mcp.json"),
      JSON.stringify({ version: 1, url: "http://127.0.0.1:1/mcp", token: legacyToken, pid: 1 }),
      { mode: 0o600 },
    );
    await server.start();
    const descriptorFile = server.getInfo()!.descriptorFile;
    const descriptor = await readControlMcpDescriptor(descriptorFile);
    expect(descriptor.version).toBe(2);
    expect(descriptor.credentials).toEqual([
      {
        id: "default",
        label: "Default",
        profile: "full",
        capabilities: [...CONTROL_MCP_PROFILE_CAPABILITIES.full],
        deniedActions: [],
        token: legacyToken,
        createdAt: expect.any(String),
        lastUsedAt: null,
      },
    ]);
    expect((await stat(descriptorFile)).mode & 0o777).toBe(0o600);
    // Existing Codex and Claude Code setups keep working with the old token.
    const listed = await rpc(server.getInfo()!.url, legacyToken, "tools/list");
    expect(listed.response.status).toBe(200);
    expect(server.getSettings().token).toBe(legacyToken);
  });

  test("credentials rotate and revoke independently and survive restarts", async () => {
    await server.start();
    const url = server.getInfo()!.url;
    const original = server.getSettings().credentials[0]!;
    const voice = (await server.createCredential({ label: "Kitchen speaker", profile: "voice" }))
      .credentials[1]!;
    expect(voice).toMatchObject({
      label: "Kitchen speaker",
      profile: "voice",
      capabilities: [...CONTROL_MCP_PROFILE_CAPABILITIES.voice],
    });
    expect(voice.id).toMatch(/^kitchen-speaker-[0-9a-f]{6}$/);

    const rotated = (await server.rotateCredential(voice.id)).credentials.find(
      (credential) => credential.id === voice.id,
    )!;
    expect(rotated.token).not.toBe(voice.token);
    expect((await rpc(url, voice.token, "tools/list")).response.status).toBe(401);
    expect((await rpc(url, rotated.token, "tools/list")).response.status).toBe(200);
    expect((await rpc(url, original.token, "tools/list")).response.status).toBe(200);

    await server.revokeCredential(original.id);
    expect((await rpc(url, original.token, "tools/list")).response.status).toBe(401);
    expect(server.getSettings().token).toBe("");

    await server.stop();
    await server.start();
    const restarted = server.getSettings().credentials;
    expect(restarted.map((credential) => [credential.id, credential.token])).toEqual([
      [voice.id, rotated.token],
    ]);
    expect((await rpc(server.getInfo()!.url, rotated.token, "tools/list")).response.status).toBe(
      200,
    );

    // Revoking the last credential is not undone by a restart.
    await server.revokeCredential(voice.id);
    await server.stop();
    await server.start();
    expect(server.getSettings().credentials).toEqual([]);
  });

  test("a change before start reads the stored credentials first", async () => {
    await server.start();
    const original = server.getSettings().credentials[0]!;
    await server.stop();
    const fresh = new ControlMcpServer(dataDir, invoke, { port: 0 });
    try {
      await fresh.createCredential({ label: "Early", profile: "read-only" });
      const stored = await readControlMcpDescriptor(path.join(dataDir, "control-mcp.json"));
      expect(stored.credentials.map((credential) => credential.id)).toEqual([
        original.id,
        expect.stringMatching(/^early-/),
      ]);
    } finally {
      await fresh.stop();
    }
  });

  test("a coordinator lists only the tools its capabilities allow", async () => {
    await server.start();
    const side = server.issueCoordinatorCredential({
      role: "coordinator",
      projectId: "project-1",
      coordinatorId: "coordinator-1",
      conversationId: "conversation-1",
      mailboxIncarnationId: "incarnation-1",
      capabilities: ["discovery", "mail"],
    });
    const listed = await rpc(side.url, side.token, "tools/list");
    const names = (listed.body.result?.tools ?? []).map((tool) => tool.name);
    expect(names).toContain("list_projects");
    expect(names).toContain("send_message");
    for (const hidden of [
      "launch_environment",
      "launch_job",
      "create_ticket",
      "start_build_pipeline",
    ]) {
      expect(names).not.toContain(hidden);
    }
    // Operator-only tiers never reach a coordinator.
    expect(names).not.toContain("run_action");
  });

  test("refuses ungrantable capabilities, unknown profiles and empty custom lists", async () => {
    await server.start();
    await expect(
      server.createCredential({ label: "Updater", profile: "custom", capabilities: ["host"] }),
    ).rejects.toThrow("cannot be granted");
    await expect(server.createCredential({ label: "Odd", profile: "admin" })).rejects.toThrow(
      "Unknown MCP credential profile",
    );
    await expect(server.createCredential({ label: "Empty", profile: "custom" })).rejects.toThrow(
      "capability list",
    );
    await expect(
      server.createCredential({ label: "Typo", profile: "voice", deniedActions: ["nope"] }),
    ).rejects.toThrow("deniedActions");
    await expect(server.createCredential({ label: " ", profile: "voice" })).rejects.toThrow(
      "label",
    );
    // A voice credential may opt into exec explicitly.
    const exec = await server.createCredential({
      label: "Voice with exec",
      profile: "voice",
      capabilities: ["discovery", "exec"],
    });
    expect(exec.credentials.at(-1)?.capabilities).toEqual(["discovery", "exec"]);
    expect(server.getSettings().credentials).toHaveLength(2);
  });

  test("drops stored credentials that no longer satisfy the rules", async () => {
    await writeFile(
      path.join(dataDir, "control-mcp.json"),
      JSON.stringify({
        version: 2,
        url: "http://127.0.0.1:1/mcp",
        pid: 1,
        credentials: [
          {
            id: "good",
            label: "Good",
            profile: "read-only",
            capabilities: ["discovery"],
            deniedActions: [],
            token: "good-token-abcdefghijklmnopqrstuvwxyz0123456",
            createdAt: new Date(0).toISOString(),
            lastUsedAt: null,
          },
          {
            id: "escalated",
            label: "Escalated",
            profile: "custom",
            capabilities: ["host"],
            deniedActions: [],
            token: "bad-token-abcdefghijklmnopqrstuvwxyz01234567",
            createdAt: new Date(0).toISOString(),
            lastUsedAt: null,
          },
        ],
      }),
    );
    await server.start();
    expect(server.getSettings().credentials.map((credential) => credential.id)).toEqual(["good"]);
    const written = JSON.parse(await readFile(server.getInfo()!.descriptorFile, "utf8"));
    expect(written.credentials.map((credential: { id: string }) => credential.id)).toEqual([
      "good",
    ]);
  });
});

describe("confirm tokens", () => {
  test("are bound to credential, action, input and expiry", () => {
    let now = 1_000_000;
    const tokens = new ConfirmTokens(Buffer.alloc(32, 7), () => now);
    const input = { environmentId: "env-1" };
    const { token, expiresAt } = tokens.issue("voice-a", "environment.delete", input);
    expect(expiresAt).toBe(new Date(now + 120_000).toISOString());
    expect(tokens.check(token, "voice-a", "environment.delete", input)).toBe("valid");
    // Key order does not matter: the fingerprint is canonical JSON.
    expect(tokens.check(token, "voice-a", "environment.delete", { ...input })).toBe("valid");
    expect(tokens.check(token, "voice-b", "environment.delete", input)).toBe("mismatch");
    expect(tokens.check(token, "voice-a", "environment.stop", input)).toBe("mismatch");
    expect(tokens.check(token, "voice-a", "environment.delete", { environmentId: "env-2" })).toBe(
      "mismatch",
    );
    expect(tokens.check(undefined, "voice-a", "environment.delete", input)).toBe("missing");
    expect(tokens.check("ct1.nope", "voice-a", "environment.delete", input)).toBe("malformed");
    // A forged expiry fails the MAC, not the clock.
    const [, , mac] = token.split(".");
    expect(
      tokens.check(
        `ct1.${(now + 999_999).toString(36)}.${mac}`,
        "voice-a",
        "environment.delete",
        input,
      ),
    ).toBe("mismatch");
    now += 120_000;
    expect(tokens.check(token, "voice-a", "environment.delete", input)).toBe("expired");
    // Another process's secret never validates this one's tokens.
    expect(
      new ConfirmTokens(Buffer.alloc(32, 8), () => 1_000_000).check(
        token,
        "voice-a",
        "environment.delete",
        input,
      ),
    ).toBe("mismatch");
  });
});
