/**
 * MCP source scope and configuration revision on the real prompt path.
 *
 * Kept out of `session-manager-prompt.test.ts`, which is already past the
 * repository's file-size limit. Uses the shared harness, so `query()` and the
 * MCP loader are the harness doubles and every assertion is about what the
 * prompt path asks for and records.
 */
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COORDINATOR_COMMAND_SANDBOX_ENV } from "@orkestrator/protocol/coordinator";
import { claudeExecutionSandbox } from "./claude-execution-sandbox.js";
import { describe, expect, test } from "bun:test";
import {
  MOCK_MCP_CONFIG_REVISION,
  createSession,
  getSession,
  mockGetMcpRuntimeConfig,
  mockGetMcpServerNames,
  mockGetMcpServersForSdk,
  nextQueryCall,
  sendPrompt,
  track,
} from "./session-manager-test-harness.js";
import { coordinatorProcessPolicy } from "./read-only-policy.js";
import { sessionRuntimeHealthBody } from "../routes/runtime-health-body.js";

const cwd = () => process.env.CWD || process.cwd();

describe("sendPrompt MCP source scope", () => {
  test("a coordinator session asks for no configured MCP sources", async () => {
    const session = createSession("coordinator mcp");
    track(session.id);
    session.executionPolicy = coordinatorProcessPolicy();
    mockGetMcpServersForSdk.mockImplementationOnce(async () => ({
      orkestrator: { type: "http", url: "http://127.0.0.1:4567/mcp" },
    }));
    mockGetMcpServerNames.mockImplementationOnce(async () => new Set(["orkestrator"]));

    const prompt = sendPrompt(session.id, "Plan the work");
    const call = await nextQueryCall();

    expect(mockGetMcpRuntimeConfig).toHaveBeenLastCalledWith(cwd(), process.env, undefined, "none");
    // The CLI loads nothing itself for a coordinator, so the inline set is the
    // whole MCP surface.
    expect(call.options.settingSources).toEqual([]);
    expect(Object.keys(call.options.mcpServers ?? {})).toEqual(["orkestrator"]);
    call.push({ type: "result", subtype: "success" });
    call.finish();
    await prompt;
  });

  test("a read-only prompt is a coordinator turn for MCP too", async () => {
    const session = createSession("read-only mcp");
    track(session.id);
    const prompt = sendPrompt(session.id, "Just look", { readOnly: true });
    const call = await nextQueryCall();

    expect(mockGetMcpRuntimeConfig).toHaveBeenLastCalledWith(cwd(), process.env, undefined, "none");
    call.push({ type: "result", subtype: "success" });
    call.finish();
    await prompt;
  });

  test("an unrestricted session asks for every source", async () => {
    const session = createSession("all sources");
    track(session.id);
    const prompt = sendPrompt(session.id, "Work normally");
    const call = await nextQueryCall();

    expect(mockGetMcpRuntimeConfig).toHaveBeenLastCalledWith(cwd(), process.env, undefined, "all");
    call.push({ type: "result", subtype: "success" });
    call.finish();
    await prompt;
  });
});

describe("sendPrompt MCP configuration revision", () => {
  test("records the revision once the query starts and serves it from runtime health", async () => {
    const session = createSession("revision");
    track(session.id);
    expect(getSession(session.id)?.mcpConfigRevision).toBeUndefined();
    expect(sessionRuntimeHealthBody(getSession(session.id))).not.toHaveProperty("mcpConfig");

    const prompt = sendPrompt(session.id, "First");
    const call = await nextQueryCall();
    const recorded = getSession(session.id)?.mcpConfigRevision;
    expect(recorded).toMatchObject(MOCK_MCP_CONFIG_REVISION);
    expect(Number.isNaN(Date.parse(recorded?.queryStartedAt ?? ""))).toBe(false);
    expect(sessionRuntimeHealthBody(getSession(session.id))).toMatchObject({
      mcpConfig: { fingerprint: MOCK_MCP_CONFIG_REVISION.fingerprint },
    });
    call.push({ type: "result", subtype: "success" });
    call.finish();
    await prompt;
  });

  test("a save between queries shows up only when the next query starts", async () => {
    const session = createSession("revision advance");
    track(session.id);
    const first = sendPrompt(session.id, "First");
    const firstCall = await nextQueryCall();
    firstCall.push({ type: "result", subtype: "success" });
    firstCall.finish();
    await first;
    expect(getSession(session.id)?.mcpConfigRevision?.fingerprint).toBe(
      MOCK_MCP_CONFIG_REVISION.fingerprint,
    );

    const saved = {
      fingerprint: "after-save",
      sources: { user: "sha256:saved", project: "absent" },
      scope: "all" as const,
    };
    mockGetMcpRuntimeConfig.mockImplementationOnce(async () => ({
      servers: {},
      names: new Set<string>(),
      revision: saved,
    }));
    const second = sendPrompt(session.id, "Second");
    const secondCall = await nextQueryCall();
    expect(getSession(session.id)?.mcpConfigRevision).toMatchObject(saved);
    secondCall.push({ type: "result", subtype: "success" });
    secondCall.finish();
    await second;
  });
});

describe("coordinator query wiring", () => {
  test("passes the cwd, realpath, unavailable authority and read-only instructions to the SDK", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-coordinator-query-"));
    const cwd = join(root, "checkout");
    await symlink(root, cwd);
    const previousCwd = process.env.CWD;
    const previousSandbox = process.env[COORDINATOR_COMMAND_SANDBOX_ENV];
    try {
      process.env.CWD = cwd;
      process.env[COORDINATOR_COMMAND_SANDBOX_ENV] = "unavailable";
      const session = createSession("coordinator sandbox");
      track(session.id);
      session.executionPolicy = coordinatorProcessPolicy();
      const prompt = sendPrompt(session.id, "Inspect the checkout");
      const call = await nextQueryCall();
      expect(call.options.cwd).toBe(cwd);
      expect(call.options.sandbox).toMatchObject({
        enabled: false,
        failIfUnavailable: false,
        filesystem: { denyWrite: [cwd, await realpath(cwd)] },
      });
      const append = (call.options.systemPrompt as { append: string }).append;
      expect(append).toContain("read-only coordinator");
      expect(append).toContain("Delegate all mutations");
      expect(append).not.toMatch(
        /before editing|Write tools|docs\/|save the file|background command/i,
      );
      call.push({ type: "result", subtype: "success" });
      call.finish();
      await prompt;
      for (const value of [undefined, "", "unknown"]) {
        if (value === undefined) delete process.env[COORDINATOR_COMMAND_SANDBOX_ENV];
        else process.env[COORDINATOR_COMMAND_SANDBOX_ENV] = value;
        expect(
          claudeExecutionSandbox(coordinatorProcessPolicy(), false, { cwd })?.failIfUnavailable,
        ).toBe(true);
      }
    } finally {
      if (previousCwd === undefined) delete process.env.CWD;
      else process.env.CWD = previousCwd;
      if (previousSandbox === undefined) delete process.env[COORDINATOR_COMMAND_SANDBOX_ENV];
      else process.env[COORDINATOR_COMMAND_SANDBOX_ENV] = previousSandbox;
      await rm(root, { recursive: true, force: true });
    }
  });
});
