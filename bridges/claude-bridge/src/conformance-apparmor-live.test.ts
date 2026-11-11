/**
 * Opt-in paired qualification on the same disposable Ubuntu runner, before/after remediation.
 *
 * Phases (`ORKESTRATOR_CLAUDE_APPARMOR_PHASE`):
 * - `restricted`: the host must refuse the nested namespace under Ubuntu's
 *   `bwrap-userns-restrict` profile (CI's 26.04 runner, before remediation).
 * - `stock`: whatever the host's stock policy answers, the backend tier and
 *   the pinned CLI must agree with the probe (Ubuntu 24.04, whose answer was
 *   unknown; to-do 0145 task 3). A probe that says `available` while the CLI
 *   fails, or the reverse, fails the phase.
 * - `remediated`: after the runner's profile removal the sandbox must work.
 */
import { afterEach, describe, expect, test } from "bun:test";
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
  type ClaudeLinuxSandboxStatus,
} from "@orkestrator/protocol/node/claude-linux-sandbox";
import { PINNED_TOOLCHAIN_VERSIONS } from "../../../packages/toolchain/src/manifest.js";
import { withPolicyCliFixture } from "../../../tests/conformance/execution-policy/vendor-cli.js";
import {
  HOOK_ONLY_ADVERSARIAL_SCENARIOS,
  qualifyCoordinatorSandbox,
} from "../test-fixtures/coordinator-sandbox-qualification.js";

const phase = process.env.ORKESTRATOR_CLAUDE_APPARMOR_PHASE;

type ApparmorPhase = "restricted" | "stock" | "remediated";

/**
 * What the rest of the run must show for this phase and probe answer:
 * `available` (the CLI's sandbox works), `nested-refused` (bubblewrap starts
 * but the CLI's nested namespace is refused) or `outer-refused` (bubblewrap
 * cannot create its own namespace, so the CLI's own check refuses too).
 * `restricted` and `remediated` require one answer; `stock` takes the host's,
 * and any answer that is not about namespaces means the runner is missing a
 * program, which is a setup failure, never evidence.
 */
function apparmorPhaseExpectation(
  requested: string | undefined,
  probe: ClaudeLinuxSandboxStatus,
): "available" | "nested-refused" | "outer-refused" {
  if (requested !== "restricted" && requested !== "stock" && requested !== "remediated") {
    throw new Error(`Unknown AppArmor phase: ${String(requested)}`);
  }
  const answer = probe.available
    ? "available"
    : probe.failure === "nested-user-namespace"
      ? "nested-refused"
      : probe.failure === "user-namespace"
        ? "outer-refused"
        : undefined;
  if (!answer) {
    throw new Error(`The runner cannot be qualified: ${probe.available ? "" : probe.reason}`);
  }
  const required: Record<ApparmorPhase, string | undefined> = {
    restricted: "nested-refused",
    remediated: "available",
    stock: undefined,
  };
  const want = required[requested];
  if (want && want !== answer) {
    throw new Error(`Phase ${requested} requires ${want}, but the probe answered ${answer}`);
  }
  return answer;
}

/** A sysctl's value, or null where the kernel has no such setting. */
async function sysctl(name: string): Promise<string | null> {
  try {
    return (await readFile(`/proc/sys/kernel/${name}`, "utf8")).trim();
  } catch {
    return null;
  }
}

afterEach(() => setClaudeLinuxSandboxStatusForTests({ available: true }));

describe("AppArmor phase expectations", () => {
  const nested = {
    available: false,
    failure: "nested-user-namespace",
    reason: "nested",
  } as const;
  const outer = { available: false, failure: "user-namespace", reason: "outer" } as const;
  const missing = { available: false, failure: "missing-programs", reason: "no bwrap" } as const;

  test("restricted and remediated each accept exactly one probe answer", () => {
    expect(apparmorPhaseExpectation("restricted", nested)).toBe("nested-refused");
    expect(() => apparmorPhaseExpectation("restricted", outer)).toThrow(/requires nested-refused/);
    expect(() => apparmorPhaseExpectation("restricted", { available: true })).toThrow();
    expect(apparmorPhaseExpectation("remediated", { available: true })).toBe("available");
    expect(() => apparmorPhaseExpectation("remediated", nested)).toThrow(/requires available/);
  });

  test("stock takes the host's namespace answer but never a setup failure", () => {
    expect(apparmorPhaseExpectation("stock", { available: true })).toBe("available");
    expect(apparmorPhaseExpectation("stock", nested)).toBe("nested-refused");
    expect(apparmorPhaseExpectation("stock", outer)).toBe("outer-refused");
    for (const requested of ["stock", "restricted", "remediated"]) {
      expect(() => apparmorPhaseExpectation(requested, missing)).toThrow(/no bwrap/);
    }
    expect(() => apparmorPhaseExpectation("other", { available: true })).toThrow(/Unknown/);
  });
});

test.skipIf(!phase)(
  "probe, coordinator tier and pinned CLI agree with the required AppArmor phase",
  async () => {
    expect(process.platform).toBe("linux");
    const os = await readFile("/etc/os-release", "utf8");
    expect(os).toMatch(/^ID=ubuntu$/m);
    expect(await readFile("/sys/module/apparmor/parameters/enabled", "utf8")).toMatch(/^Y/);
    const appArmorBwrapProfile = existsSync(APPARMOR_BWRAP_PROFILE);
    if (phase === "restricted") expect(appArmorBwrapProfile).toBe(true);
    const sysctls = {
      apparmor_restrict_unprivileged_userns: await sysctl("apparmor_restrict_unprivileged_userns"),
      apparmor_restrict_unprivileged_unconfined: await sysctl(
        "apparmor_restrict_unprivileged_unconfined",
      ),
    };

    // Never use the test preload's optimistic pin or accept either outcome.
    setClaudeLinuxSandboxStatusForTests(undefined);
    const probe = probeClaudeLinuxSandbox();
    const expectation = apparmorPhaseExpectation(phase, probe);
    const restricted = expectation !== "available";
    // The CLI fails with apply-seccomp's setgroups error only under Ubuntu's
    // bwrap profile; scenarios that assert that error or name the profile
    // run only there.
    const profileRefusal = expectation === "nested-refused" && appArmorBwrapProfile;
    if (profileRefusal && !probe.available) {
      expect(probe.reason).toContain("bwrap-userns-restrict");
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
    // The backend's own probe ran in another process and must name the same
    // cause. Only the stem is compared: the parenthesised stderr detail is the
    // kernel's wording, not Orkestrator's.
    if (!probe.available) expect(tiers.normal.reason).toContain(probe.reason.split(" (")[0]!);
    if (profileRefusal) expect(tiers.normal.reason).toContain("bwrap-userns-restrict");

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
      if (profileRefusal) {
        // Bypass the bridge refusal once to demonstrate the CLI's actual failure.
        results.push(await qualifyCoordinatorSandbox("apparmor-sandbox-reads", cli));
      }
      results.push(await qualifyCoordinatorSandbox("unavailable-hook-reads", cli));
      results.push(await qualifyCoordinatorSandbox("unavailable-hook-refuses-quoted", cli));
      if (profileRefusal) {
        // Review turns use the ordinary bridge resolver on this same restricted
        // host, and the new attacks must be denied with the sandbox disabled.
        results.push(await qualifyCoordinatorSandbox("read-only-host-reads", cli));
        results.push(await qualifyCoordinatorSandbox("read-only-host-hook-refuses", cli));
      }
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
            expectation,
            kernel: release(),
            os,
            appArmorBwrapProfile,
            sysctls,
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
