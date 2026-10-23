/**
 * The shared execution-policy conformance suite (`tests/conformance/execution-policy`)
 * over the ACP bridge running Grok.
 *
 * What Grok receives is its command line and environment (`providerArgv` and
 * `providerEnv` over Grok's built-in configuration, from the turn's policy as
 * `AcpProcess` builds it) and the bridge's answers to its permission requests. The answers are observed by attaching a fake child
 * and handing the bridge's real `onPermission` handler a shell command. The
 * reported policy is `publicSession`'s, which Agent Info renders.
 */
import "./testing/unit-test-env.js";
import { expect } from "bun:test";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  policyQualificationCli,
  policyCliOutput,
  withPolicyCliFixture,
} from "../../../tests/conformance/execution-policy/vendor-cli.js";
import { RuntimeHealthRecorder } from "@orkestrator/protocol/runtime-health";
import { PINNED_TOOLCHAIN_VERSIONS } from "../../../packages/toolchain/src/manifest.js";
import {
  runExecutionPolicyConformance,
  type AdapterEffects,
} from "../../../tests/conformance/execution-policy/suite.js";
import { sessions } from "./acp-context.js";
import { effectiveExecutionPolicy, effectiveTurnExecutionPolicy } from "./acp-policy.js";
import { loadAcpProviderConfig, providerArgv, providerEnv } from "./acp-provider-config.js";
import { publicSession } from "./acp-public.js";
import { attachChild, clearApprovals } from "./acp-session.js";

// The process-wide provider is the unit-test fixture; Grok's command line is
// built from its own built-in configuration, as its launcher's would be.
const grokExecutable = policyQualificationCli("grok");
const grok = loadAcpProviderConfig({ ACP_PROVIDER: "grok", ACP_AGENT_PATH: "/opt/grok/bin/grok" });
type AcpSession = Parameters<typeof publicSession>[0];

/** Hand the bridge a shell command Grok asks permission for. */
function permissionAnswer(state: AcpSession) {
  const responses: unknown[] = [];
  const child = {
    respond: (_id: number, result: unknown) => responses.push(result),
  } as unknown as Parameters<typeof attachChild>[1];
  attachChild(state, child);
  child.onPermission(1, {
    sessionId: state.acpSessionId,
    toolCall: { toolCallId: "conformance", kind: "execute", title: "curl https://example.com" },
    options: [
      { optionId: "allow", kind: "allow_once", name: "Allow" },
      { optionId: "reject", kind: "reject_once", name: "Reject" },
    ],
  });
  if (state.approvals.size > 0) {
    clearApprovals(state);
    return "ask" as const;
  }
  const outcome = (responses[0] as { outcome: { outcome: string; optionId?: string } }).outcome;
  return outcome.outcome === "selected" && outcome.optionId === "allow"
    ? ("auto-approve" as const)
    : ("deny" as const);
}

runExecutionPolicyConformance(
  {
    platform: "grok",
    async apply(shape) {
      return withPolicyCliFixture(async (fixture) => {
        // Every environment is a git checkout. Grok trusts a folder outside git,
        // or one with nothing its gate holds back, without asking, so only a
        // repository with instructions and a command exercises the gate.
        expect(Bun.spawnSync(["git", "init", "-q"], { cwd: fixture.cwd }).exitCode).toBe(0);
        await mkdir(join(fixture.cwd, ".grok", "commands"), { recursive: true });
        await writeFile(join(fixture.cwd, ".grok", "config.toml"), 'model = "policy-probe"\n');
        await writeFile(join(fixture.cwd, "AGENTS.md"), "Policy probe instructions.\n");
        await writeFile(join(fixture.cwd, ".grok", "commands", "policy-probe.md"), "Probe.\n");
        const state = {
          id: `conformance-${shape.id}`,
          acpSessionId: "vendor-session",
          status: "running",
          // What the create route stores.
          policy: effectiveExecutionPolicy(shape.policy),
          messages: [],
          approvals: new Map(),
          interactions: new Map(),
          revision: 0,
          sessionConfig: { composer: {} },
          health: new RuntimeHealthRecorder(),
        } as unknown as AcpSession;
        sessions.set(state.id, state);
        try {
          const policy = effectiveTurnExecutionPolicy(state);
          // As `AcpProcess` decides it.
          const trustProject = policy?.projectResources === true;
          const argv = providerArgv(grok, { approvals: policy?.approvals, trustProject });
          if (!trustProject) {
            // Grok then decides by its own folder trust. Observe a user who
            // trusted this repository in Grok, the case the reported "on"
            // must cover; an untrusted checkout loads less.
            await mkdir(join(fixture.env.HOME!, ".grok"));
            await writeFile(
              join(fixture.env.HOME!, ".grok", "trusted_folders.toml"),
              `[folders."${await realpath(fixture.cwd)}"]\ntrusted = true\n`,
            );
          }
          const launched = {
            cwd: fixture.cwd,
            env: providerEnv(grok, { trustProject }, fixture.env) as Record<string, string>,
          };
          // With `--always-approve` Grok runs its tools without asking at all;
          // otherwise each request reaches the bridge, which answers it.
          const approvals: AdapterEffects["approvals"] = argv.includes("--always-approve")
            ? "auto-approve"
            : permissionAnswer(state);
          // Inspect the pinned CLI's actual project discovery, in an empty home
          // and the environment the bridge launches Grok with.
          expect(await policyCliOutput(grokExecutable!, ["--version"], fixture)).toContain(
            PINNED_TOOLCHAIN_VERSIONS.grok,
          );
          const inspection = JSON.parse(
            await policyCliOutput(grokExecutable!, ["inspect", "--json"], launched),
          );
          const projectResources =
            inspection.projectTrusted === true &&
            inspection.configSources.layers.some(
              (layer: { role: string; path: string }) =>
                layer.role === "project" && layer.path.endsWith("/.grok/config.toml"),
            ) &&
            inspection.projectInstructions.length > 0 &&
            inspection.skills.some((skill: { name: string }) => skill.name === "policy-probe");
          expect(projectResources).toBe(true);
          // Decode the emitted launch arguments: no profile or tool removal means
          // commands retain their default filesystem and network access. The
          // permission handler above is exercised even for deny policies.
          const providerSandbox = argv.some(
            (arg) => arg === "--sandbox" || arg.startsWith("--sandbox="),
          );
          expect(argv).not.toContain("--tools");
          expect(argv).not.toContain("--disallowed-tools");
          return {
            reported: publicSession(state).policy as never,
            observed: {
              // Grok is given no sandbox or network option. Project configuration
              // loads by Grok's folder trust, which the bridge turns off when the
              // policy turns project resources on.
              providerSandbox,
              approvals,
              projectResources,
              // A tool that does not ask is never stopped, so even `deny` holds
              // nothing off the network.
              restrictsNetwork: providerSandbox,
            },
          };
        } finally {
          sessions.delete(state.id);
        }
      });
    },
  },
  {
    timeoutMs: 20_000,
    skipReason: grokExecutable
      ? undefined
      : "install the pinned Grok CLI for offline qualification",
  },
);
