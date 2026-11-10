import { describe, expect, test } from "bun:test";
import {
  PLATFORM_SANDBOX_EXPECTATIONS,
  providerSandboxLiveGate,
} from "./claude-provider-sandbox.live-probe.js";

// The live provider-sandbox check (`claude-provider-sandbox.live.test.ts`)
// decides where it runs and what each OS's refusal looks like from these.
describe("providerSandboxLiveGate", () => {
  const neverProbed = () => {
    throw new Error("probed");
  };

  test("macOS always runs, without probing", () => {
    expect(providerSandboxLiveGate("darwin", neverProbed)).toEqual({ run: true });
  });

  test("Linux runs only where bubblewrap can nest the CLI's namespace", () => {
    expect(providerSandboxLiveGate("linux", () => ({ available: true }))).toEqual({ run: true });
    const reason = "Claude's command sandbox cannot run commands on this host: AppArmor";
    expect(providerSandboxLiveGate("linux", () => ({ available: false, reason }))).toEqual({
      run: false,
      reason,
    });
  });

  test("Linux without a probe reason still says why it skipped", () => {
    const gate = providerSandboxLiveGate("linux", () => ({ available: false }));
    expect(gate.run).toBe(false);
    expect(gate.run ? "" : gate.reason).toContain("probe failed");
  });

  test("other platforms skip, without probing", () => {
    const gate = providerSandboxLiveGate("win32", neverProbed);
    expect(gate).toEqual({ run: false, reason: "no Claude command sandbox is qualified on win32" });
  });
});

describe("PLATFORM_SANDBOX_EXPECTATIONS", () => {
  test("every platform the gate can run has expectations", () => {
    expect(PLATFORM_SANDBOX_EXPECTATIONS.darwin).toBeDefined();
    expect(PLATFORM_SANDBOX_EXPECTATIONS.linux).toBeDefined();
  });

  test("records where the two sandboxes differ", () => {
    // Seatbelt denies the open(); bubblewrap binds the path read-only.
    expect(PLATFORM_SANDBOX_EXPECTATIONS.darwin!.outsideWriteRefusal).toBe(
      "operation not permitted",
    );
    expect(PLATFORM_SANDBOX_EXPECTATIONS.linux!.outsideWriteRefusal).toBe("Read-only file system");
    // `allowLocalBinding` is macOS-only; bubblewrap isolates the network namespace.
    expect(PLATFORM_SANDBOX_EXPECTATIONS.darwin!.directLoopbackWithFullNetwork).toBe(true);
    expect(PLATFORM_SANDBOX_EXPECTATIONS.linux!.directLoopbackWithFullNetwork).toBe(false);
  });
});
