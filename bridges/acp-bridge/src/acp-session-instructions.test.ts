import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentSystemInstructions } from "@orkestrator/protocol/agent-system-instructions";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import { loadAcpProviderConfig, sessionInstructionsMeta } from "./acp-provider-config.js";
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

describe("sessionInstructionsMeta", () => {
  test("Grok takes them as session/new `_meta.rules`", () => {
    const grok = loadAcpProviderConfig({ ACP_PROVIDER: "grok", ACP_AGENT_PATH: "/bin/grok" });
    expect(sessionInstructionsMeta(grok, "rules text")).toEqual({ _meta: { rules: "rules text" } });
    expect(sessionInstructionsMeta(grok, undefined)).toEqual({});
  });

  test("a provider with no known field gets none", () => {
    const generic = loadAcpProviderConfig({
      ACP_PROVIDER_CONFIG: JSON.stringify({ id: "gemini", executable: "gemini", argv: ["--acp"] }),
    });
    expect(sessionInstructionsMeta(generic, "rules text")).toEqual({});
  });
});
