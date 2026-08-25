import { describe, expect, it } from "bun:test";
import { createTerminalTargetIdentity } from "./terminal-target-identity";

describe("createTerminalTargetIdentity", () => {
  // Pinned deliberately. `useTerminal` tears down an established connection
  // when this identity changes, and `PersistentTerminal` refuses to re-probe a
  // target it already tried. A field added to one side only would either
  // strand a terminal disconnected or re-probe a live session, so adding one
  // here should be a conscious edit rather than a silent widening.
  it("names exactly the fields a terminal target is made of", () => {
    const identity = JSON.parse(createTerminalTargetIdentity({ containerId: "container-1" }));

    expect(Object.keys(identity)).toEqual([
      "kind",
      "containerId",
      "environmentId",
      "terminalKey",
      "attachExistingOnly",
      "replayOutputBuffer",
      "trackEnvironmentActivity",
      "user",
    ]);
  });

  it("applies the same defaults useTerminal destructures", () => {
    expect(JSON.parse(createTerminalTargetIdentity({ containerId: null }))).toEqual({
      kind: "container",
      containerId: null,
      environmentId: null,
      terminalKey: null,
      attachExistingOnly: false,
      replayOutputBuffer: false,
      trackEnvironmentActivity: false,
      user: null,
    });
  });

  const base = {
    containerId: "container-1",
    environmentId: "env-1",
    isLocal: false,
    terminalKey: "tab-1",
    user: undefined,
    replayOutputBuffer: true,
    attachExistingOnly: false,
    trackEnvironmentActivity: false,
  } as const;

  const variants = [
    ["containerId", { ...base, containerId: "container-2" }],
    ["environmentId", { ...base, environmentId: "env-2" }],
    ["isLocal", { ...base, isLocal: true }],
    ["terminalKey", { ...base, terminalKey: "tab-2" }],
    ["user", { ...base, user: "orkroot" }],
    ["replayOutputBuffer", { ...base, replayOutputBuffer: false }],
    ["attachExistingOnly", { ...base, attachExistingOnly: true }],
    ["trackEnvironmentActivity", { ...base, trackEnvironmentActivity: true }],
  ] as const;

  for (const [field, variant] of variants) {
    it(`treats a different ${field} as a different target`, () => {
      expect(createTerminalTargetIdentity(variant)).not.toBe(createTerminalTargetIdentity(base));
    });
  }

  it("is stable for the same target", () => {
    expect(createTerminalTargetIdentity(base)).toBe(createTerminalTargetIdentity({ ...base }));
  });

  it("omits the requested session, which is resolved for a target rather than part of it", () => {
    const identity = createTerminalTargetIdentity(base);

    expect(identity).not.toContain("session");
    expect(Object.keys(JSON.parse(identity))).not.toContain("existingSessionId");
  });
});
