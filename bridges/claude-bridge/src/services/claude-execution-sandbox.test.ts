import { describe, expect, test } from "bun:test";
import type { ClaudeLinuxSandboxStatus } from "@orkestrator/protocol/node/claude-linux-sandbox";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import {
  claudeExecutionSandbox,
  claudeReadOnlyCommandSandbox,
  claudeSandboxRefusal,
} from "./claude-execution-sandbox.js";
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

  test("a read-only review turn in an ordinary bridge is never refused (todo 0190)", () => {
    // It runs on the hook alone instead; see `claudeReadOnlyCommandSandbox`.
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

describe("read-only command sandbox (todo 0190)", () => {
  const ordinary = { commandSandbox: undefined, coordinatorProcess: false } as const;

  test("an ordinary bridge on Linux follows the probe, with its reason", () => {
    expect(
      claudeReadOnlyCommandSandbox({ ...ordinary, platform: "linux", linuxSandbox: refused }),
    ).toEqual({ commandSandbox: "unavailable", reason: REASON });
    expect(
      claudeReadOnlyCommandSandbox({ ...ordinary, platform: "linux", linuxSandbox: works }),
    ).toEqual({ commandSandbox: "required" });
  });

  test("macOS always asks for Seatbelt, and a platform without a sandbox never does", () => {
    let probed = false;
    const probe = () => {
      probed = true;
      return refused();
    };
    expect(
      claudeReadOnlyCommandSandbox({ ...ordinary, platform: "darwin", linuxSandbox: probe }),
    ).toEqual({ commandSandbox: "required" });
    const windows = claudeReadOnlyCommandSandbox({
      ...ordinary,
      platform: "win32",
      linuxSandbox: probe,
    });
    expect(windows.commandSandbox).toBe("unavailable");
    expect(windows.reason).toContain("Claude's command sandbox cannot run commands on this host");
    expect(probed).toBe(false);
  });

  test("a launcher's answer stands, and a coordinator without one stays required", () => {
    let probed = false;
    const probe = () => {
      probed = true;
      return refused();
    };
    for (const [commandSandbox, expected] of [
      ["required", "required"],
      ["unknown", "required"],
      ["unavailable", "unavailable"],
    ] as const) {
      expect(
        claudeReadOnlyCommandSandbox({
          commandSandbox,
          coordinatorProcess: true,
          platform: "linux",
          linuxSandbox: probe,
        }),
      ).toEqual({ commandSandbox: expected });
    }
    // An older launcher that sets no answer must not turn a missing sandbox
    // into an unsandboxed coordinator: the CLI must require its sandbox.
    expect(
      claudeReadOnlyCommandSandbox({
        commandSandbox: undefined,
        coordinatorProcess: true,
        platform: "linux",
        linuxSandbox: probe,
      }),
    ).toEqual({ commandSandbox: "required" });
    expect(probed).toBe(false);
    // No explicit launcher qualification means no early Linux refusal. The
    // required SDK sandbox above is what fails closed on this older launcher.
    expect(
      claudeSandboxRefusal(coordinatorProcessPolicy(), {
        commandSandbox: undefined,
        platform: "linux",
        linuxSandbox: refused,
      }),
    ).toBeUndefined();
  });

  test("without the sandbox, a read-only turn keeps every other part of its boundary", () => {
    const cwd = "/work/checkout";
    const on = claudeExecutionSandbox(READ_ONLY_TURN_POLICY, false, {
      cwd,
      commandSandbox: "required",
    });
    const off = claudeExecutionSandbox(READ_ONLY_TURN_POLICY, false, {
      cwd,
      commandSandbox: "unavailable",
    });
    expect(on).toMatchObject({ enabled: true, failIfUnavailable: true });
    expect(off).toMatchObject({ enabled: false, failIfUnavailable: false });
    // Only the two switches differ: the escape hatch stays closed and the
    // write denial and network allowlist keep their intent.
    expect({ ...off, enabled: true, failIfUnavailable: true }).toEqual(on!);
    expect(off).toMatchObject({
      allowUnsandboxedCommands: false,
      filesystem: { denyWrite: [cwd] },
      network: { strictAllowlist: true, allowedDomains: [] },
    });
  });
});
