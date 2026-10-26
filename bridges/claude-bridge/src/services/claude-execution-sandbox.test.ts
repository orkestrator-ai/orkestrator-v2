import { describe, expect, test } from "bun:test";
import type { ClaudeLinuxSandboxStatus } from "@orkestrator/protocol/node/claude-linux-sandbox";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import { claudeSandboxRefusal } from "./claude-execution-sandbox.js";
import { READ_ONLY_TURN_POLICY } from "./claude-query-config.js";
import { coordinatorProcessPolicy } from "./read-only-policy.js";

const REASON =
  "Claude's command sandbox cannot run commands on this host: bubblewrap starts, but AppArmor's bwrap-userns-restrict profile strips capabilities from the user namespace the Claude CLI nests inside it.";

const refused = (): ClaudeLinuxSandboxStatus => ({
  available: false,
  failure: "nested-user-namespace",
  reason: REASON,
});
const works = (): ClaudeLinuxSandboxStatus => ({ available: true });

const providerPolicy: NativeAgentExecutionPolicy = {
  id: "interactive-host",
  sandbox: "provider",
  approvals: "auto-approve",
  projectResources: true,
  networkAccess: "full",
};

describe("Claude sandbox refusal", () => {
  test("a provider-sandbox turn on a Linux host that cannot nest namespaces is refused", () => {
    expect(claudeSandboxRefusal(providerPolicy, { platform: "linux", linuxSandbox: refused })).toBe(
      REASON,
    );
    expect(
      claudeSandboxRefusal(providerPolicy, { platform: "linux", linuxSandbox: works }),
    ).toBeUndefined();
  });

  test("a turn that does not ask for the provider sandbox is never refused", () => {
    let probed = false;
    const probe = () => {
      probed = true;
      return refused();
    };
    for (const sandbox of ["none", "container"] as const) {
      expect(
        claudeSandboxRefusal(
          { ...providerPolicy, sandbox },
          { platform: "linux", linuxSandbox: probe },
        ),
      ).toBeUndefined();
    }
    expect(claudeSandboxRefusal(undefined, { platform: "linux", linuxSandbox: probe })).toBe(
      undefined,
    );
    // No probe runs for a turn that does not need it.
    expect(probed).toBe(false);
  });

  test("a coordinator follows its launcher's answer", () => {
    const coordinator = coordinatorProcessPolicy();
    // Qualified on the sandbox (a malformed value reads the same way): refuse
    // rather than fail every command.
    for (const commandSandbox of ["required", "unknown"]) {
      expect(
        claudeSandboxRefusal(coordinator, {
          platform: "linux",
          commandSandbox,
          linuxSandbox: refused,
        }),
      ).toBe(REASON);
    }
    // Qualified without it: the hook is the boundary, so the turn runs.
    expect(
      claudeSandboxRefusal(coordinator, {
        platform: "linux",
        commandSandbox: "unavailable",
        linuxSandbox: refused,
      }),
    ).toBeUndefined();
  });

  test("a read-only review turn in an ordinary bridge is left as it was (todo 0190)", () => {
    for (const policy of [coordinatorProcessPolicy(), READ_ONLY_TURN_POLICY]) {
      expect(
        claudeSandboxRefusal(policy, {
          platform: "linux",
          commandSandbox: undefined,
          linuxSandbox: refused,
        }),
      ).toBeUndefined();
    }
  });

  test("only Linux is probed", () => {
    for (const platform of ["darwin", "win32"] as const) {
      expect(
        claudeSandboxRefusal(providerPolicy, { platform, linuxSandbox: refused }),
      ).toBeUndefined();
    }
  });
});
