/** Opt-in paired qualification on the same disposable Ubuntu runner, before/after remediation. */
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { release } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  APPARMOR_BWRAP_PROFILE,
  probeClaudeLinuxSandbox,
  setClaudeLinuxSandboxStatusForTests,
} from "@orkestrator/protocol/node/claude-linux-sandbox";
import { PINNED_TOOLCHAIN_VERSIONS } from "../../../packages/toolchain/src/manifest.js";
import { withPolicyCliFixture } from "../../../tests/conformance/execution-policy/vendor-cli.js";
import {
  HOOK_ONLY_ADVERSARIAL_SCENARIOS,
  qualifyCoordinatorSandbox,
} from "../test-fixtures/coordinator-sandbox-qualification.js";

const phase = process.env.ORKESTRATOR_CLAUDE_APPARMOR_PHASE;

afterEach(() => setClaudeLinuxSandboxStatusForTests({ available: true }));

test.skipIf(!phase)(
  "probe, coordinator tier and pinned CLI agree with the required AppArmor phase",
  async () => {
    expect(["restricted", "remediated"]).toContain(phase);
    expect(process.platform).toBe("linux");
    const restricted = phase === "restricted";
    const os = await readFile("/etc/os-release", "utf8");
    expect(os).toMatch(/^ID=ubuntu$/m);
    expect(await readFile("/sys/module/apparmor/parameters/enabled", "utf8")).toMatch(/^Y/);
    expect(existsSync(APPARMOR_BWRAP_PROFILE)).toBe(true);

    // Never use the test preload's optimistic pin or accept either outcome.
    setClaudeLinuxSandboxStatusForTests(undefined);
    const probe = probeClaudeLinuxSandbox();
    if (restricted) {
      expect(probe).toMatchObject({ available: false, failure: "nested-user-namespace" });
      if (probe.available) throw new Error("Expected stock AppArmor restriction");
      expect(probe.reason).toContain("bwrap-userns-restrict");
    } else {
      expect(probe).toEqual({ available: true });
    }

    // The backend runs in its own Bun process, with no test preload or bridge mocks.
    const providers = fileURLToPath(
      new URL("../../../apps/backend/src/core/coordinator-providers.ts", import.meta.url),
    );
    const backend = spawnSync(
      process.execPath,
      [
        "-e",
        `import { coordinatorProviderQualification } from ${JSON.stringify(providers)};
        console.log(JSON.stringify({
          normal: coordinatorProviderQualification("claude"),
          strict: coordinatorProviderQualification("claude", { tierSetting: "enforced" })
        }));`,
      ],
      { encoding: "utf8", timeout: 15_000, maxBuffer: 64 * 1024 },
    );
    expect(backend.error).toBeUndefined();
    expect(backend.status).toBe(0);
    const tiers = JSON.parse(backend.stdout);
    expect(tiers.normal).toMatchObject({
      tier: restricted ? "provider-configured" : "enforced",
      available: true,
    });
    expect(tiers.strict.available).toBe(!restricted);
    if (restricted) expect(tiers.normal.reason).toContain("bwrap-userns-restrict");

    // Force every query to the very binary whose pinned version we check.
    const cli = process.env.ORKESTRATOR_POLICY_CLAUDE_PATH;
    expect(cli).toBeTruthy();
    const version = spawnSync(cli!, ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toBe(`${PINNED_TOOLCHAIN_VERSIONS.claude} (Claude Code)`);
    const results = [];
    if (restricted) {
      // Bypass the bridge refusal once to demonstrate the CLI's actual failure.
      results.push(await qualifyCoordinatorSandbox("apparmor-sandbox-reads", cli));
      results.push(await qualifyCoordinatorSandbox("unavailable-hook-reads", cli));
      results.push(await qualifyCoordinatorSandbox("unavailable-hook-refuses-quoted", cli));
      // Review turns use the ordinary bridge resolver on this same restricted
      // host, and the new attacks must be denied with the sandbox disabled.
      results.push(await qualifyCoordinatorSandbox("read-only-unavailable-reads", cli));
      results.push(await qualifyCoordinatorSandbox("read-only-unavailable-hook-refuses", cli));
      for (const scenario of HOOK_ONLY_ADVERSARIAL_SCENARIOS) {
        results.push(await qualifyCoordinatorSandbox(scenario, cli));
      }

      // Exercise the real HTTP prompt route and real session, without SDK mocks.
      await withPolicyCliFixture(async (fixture) => {
        const { setClaudeHomeForTesting } = await import("./services/claude-home.js");
        const { createSession, sessions } = await import("./services/session-manager-core.js");
        const { default: routes } = await import("./routes/session.js");
        setClaudeHomeForTesting(fixture.root);
        const session = createSession("AppArmor provider refusal");
        try {
          session.executionPolicy = {
            id: "interactive-host",
            sandbox: "provider",
            approvals: "auto-approve",
            projectResources: true,
            networkAccess: "full",
          };
          const response = await routes.request(`/${session.id}/prompt`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt: "List files", requestId: "apparmor-provider" }),
          });
          expect(response.status).toBe(422);
          expect(await response.json()).toEqual({
            kind: "sandbox-unavailable",
            error: probe.available ? "" : probe.reason,
          });
          expect(session.dispatchedRequestIds?.has("apparmor-provider") ?? false).toBe(false);
          expect(session.claudeRuntime).toBeUndefined();
          expect(session.messages).toHaveLength(0);
        } finally {
          sessions.delete(session.id);
          setClaudeHomeForTesting(null);
        }
      });
    } else {
      results.push(await qualifyCoordinatorSandbox("default-sandbox-writes", cli));
      results.push(await qualifyCoordinatorSandbox("coordinator-sandbox-reads", cli));
      results.push(await qualifyCoordinatorSandbox("coordinator-sandbox-refuses", cli));
    }

    // Successful phase evidence survives test:logged's deletion of passing logs.
    // No prompts, tool output, user files or credentials are recorded.
    const directory = process.env.ORKESTRATOR_CLAUDE_APPARMOR_EVIDENCE;
    if (directory) {
      const path = join(directory, `${phase}.json`);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(
        path,
        JSON.stringify(
          {
            phase,
            kernel: release(),
            os,
            cliVersion: version.stdout.trim(),
            probe,
            tiers,
            results,
            providerPromptRefused: restricted,
            revision: process.env.GITHUB_SHA ?? null,
            runId: process.env.GITHUB_RUN_ID ?? null,
          },
          null,
          2,
        ) + "\n",
      );
    }
  },
  180_000,
);
