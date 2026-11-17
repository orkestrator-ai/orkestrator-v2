import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentSystemInstructions } from "@orkestrator/protocol/agent-system-instructions";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import {
  loadAcpProviderConfig,
  sessionInstructionsCarrier,
  sessionInstructionsParams,
} from "./acp-provider-config.js";
import { sessionInstructions } from "./acp-session-instructions.js";

const policy = (overrides: Partial<NativeAgentExecutionPolicy>): NativeAgentExecutionPolicy => ({
  id: "interactive-host",
  sandbox: "none",
  approvals: "auto-approve",
  projectResources: false,
  networkAccess: "full",
  ...overrides,
});

describe("sessionInstructions", () => {
  let workspace: string;
  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "acp-agents-md-"));
    await writeFile(join(workspace, "AGENTS.md"), "Always show visual changes as images.\n");
  });
  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  test("an untrusted session gets the shared instructions, then AGENTS.md", async () => {
    const text = await sessionInstructions(policy({}), workspace);
    expect(text).toStartWith(agentSystemInstructions());
    expect(text).toContain("# Repository instructions (AGENTS.md)");
    expect(text).toContain("Always show visual changes as images.");
  });

  test("a session that trusts the checkout leaves AGENTS.md to the agent", async () => {
    expect(await sessionInstructions(policy({ projectResources: true }), workspace)).toBe(
      agentSystemInstructions(),
    );
  });

  test("a read-only coordinator excludes repository instructions", async () => {
    const text = await sessionInstructions(policy({ id: "coordinator-read-only" }), workspace);
    expect(text).toBeUndefined();
  });
});

describe("session instruction carriers", () => {
  const grok = loadAcpProviderConfig({ ACP_PROVIDER: "grok", ACP_AGENT_PATH: "/bin/grok" });
  const generic = loadAcpProviderConfig({
    ACP_PROVIDER_CONFIG: JSON.stringify({ id: "gemini", executable: "gemini", argv: ["--acp"] }),
  });

  test("Grok takes them as session/new `_meta.rules`, and none on load", () => {
    for (const systemPromptSupported of [false, true]) {
      expect(sessionInstructionsCarrier(grok, { lifecycle: "new", systemPromptSupported })).toBe(
        "rules-meta",
      );
      expect(
        sessionInstructionsCarrier(grok, { lifecycle: "load", systemPromptSupported }),
      ).toBeUndefined();
    }
    expect(sessionInstructionsParams(grok, "rules-meta", "rules text")).toEqual({
      _meta: { rules: "rules text" },
    });
    expect(sessionInstructionsParams(grok, "rules-meta", undefined)).toEqual({});
  });

  test("an agent advertising systemPrompt gets them in append mode on new and load", () => {
    for (const lifecycle of ["new", "load"] as const) {
      expect(sessionInstructionsCarrier(generic, { lifecycle, systemPromptSupported: true })).toBe(
        "system-prompt",
      );
    }
    expect(sessionInstructionsParams(generic, "system-prompt", "rules text")).toEqual({
      systemPrompt: { mode: "append", content: [{ type: "text", text: "rules text" }] },
    });
    expect(sessionInstructionsParams(generic, "system-prompt", undefined)).toEqual({});
  });

  test("a provider with no known field and no capability gets none", () => {
    for (const lifecycle of ["new", "load"] as const) {
      expect(
        sessionInstructionsCarrier(generic, { lifecycle, systemPromptSupported: false }),
      ).toBeUndefined();
    }
    expect(sessionInstructionsParams(generic, undefined, "rules text")).toEqual({});
  });
});
