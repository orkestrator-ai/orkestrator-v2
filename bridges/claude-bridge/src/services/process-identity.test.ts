import { afterEach, describe, expect, test } from "bun:test";
import {
  BRIDGE_INSTANCE_ID,
  currentIdentityFields,
  currentProcessIdentity,
  parseIdentityFields,
  parsePsStartTime,
  recordedOwnerState,
  resetProcessIdentityCacheForTesting,
} from "./process-identity.js";
import {
  exitedChildPid,
  HAS_PROC,
  HAS_PS,
  recordedIdentity,
  spawnLiveOwner,
  stopLiveOwners,
} from "./process-identity-test-harness.js";

const HOUR_MS = 3_600_000;

describe("process identity", () => {
  afterEach(async () => {
    resetProcessIdentityCacheForTesting();
    await stopLiveOwners();
  });

  test("records this process's instance and start, and on Linux its proc start and boot", () => {
    const identity = currentProcessIdentity();
    expect(identity.pid).toBe(process.pid);
    expect(identity.instance).toBe(BRIDGE_INSTANCE_ID);
    expect(identity.processStartedAt).toBe(Math.round(performance.timeOrigin));
    if (HAS_PROC) {
      expect(identity.procStart).toMatch(/^\d+$/);
      expect(identity.bootId).toBeTruthy();
    } else {
      expect(identity.procStart).toBeUndefined();
      expect(identity.bootId).toBeUndefined();
    }
    expect(currentIdentityFields()).not.toHaveProperty("pid");
    expect(currentIdentityFields()).not.toHaveProperty("instance");
  });

  test("parses ps lstart output in UTC", () => {
    expect(parsePsStartTime("Wed Oct 28 02:27:14 2026\n")).toBe(Date.UTC(2026, 9, 28, 2, 27, 14));
    expect(parsePsStartTime("Mon Jan  5 09:03:07 2026")).toBe(Date.UTC(2026, 0, 5, 9, 3, 7));
    expect(parsePsStartTime("")).toBeUndefined();
    expect(parsePsStartTime("Wed Foo 28 02:27:14 2026")).toBeUndefined();
  });

  test("drops malformed identity fields one by one", () => {
    expect(
      parseIdentityFields({ procStart: "12x", bootId: "", processStartedAt: Number.NaN }),
    ).toEqual({});
    expect(parseIdentityFields({ procStart: "12", bootId: "b", processStartedAt: 5 })).toEqual({
      procStart: "12",
      bootId: "b",
      processStartedAt: 5,
    });
  });

  test("an owner under this process's instance is this process", () => {
    expect(
      recordedOwnerState({ pid: process.pid, instance: BRIDGE_INSTANCE_ID }, { slowPath: true }),
    ).toBe("current");
  });

  test("this process's pid under another instance, or none, is a dead predecessor", () => {
    expect(
      recordedOwnerState({ pid: process.pid, instance: "a-bridge-that-died" }, { slowPath: false }),
    ).toBe("dead");
    expect(recordedOwnerState({ pid: process.pid }, { slowPath: false })).toBe("dead");
  });

  test("a free pid is dead", async () => {
    expect(recordedOwnerState({ pid: await exitedChildPid() }, { slowPath: false })).toBe("dead");
  });

  test("a live pid with nothing to compare stays unverified", () => {
    const owner = spawnLiveOwner();
    expect(recordedOwnerState({ pid: owner.pid }, { slowPath: true })).toBe("unverified");
    expect(recordedOwnerState({ pid: owner.pid, instance: "other" }, { slowPath: true })).toBe(
      "unverified",
    );
  });

  test.skipIf(!HAS_PROC)("on Linux a live pid with another proc start or boot is dead", () => {
    const owner = spawnLiveOwner();
    const identity = { pid: owner.pid, instance: "other", ...recordedIdentity(owner) };
    expect(recordedOwnerState(identity, { slowPath: false })).toBe("alive");
    expect(recordedOwnerState({ ...identity, procStart: "1" }, { slowPath: false })).toBe("dead");
    expect(recordedOwnerState({ ...identity, bootId: "another-boot" }, { slowPath: false })).toBe(
      "dead",
    );
  });

  test.skipIf(!HAS_PS)("without a proc start, ps decides on the slow path only", () => {
    const owner = spawnLiveOwner();
    const matching = { pid: owner.pid, instance: "other", processStartedAt: owner.startedAt };
    const reused = { ...matching, processStartedAt: owner.startedAt - HOUR_MS };
    expect(recordedOwnerState(reused, { slowPath: false })).toBe("unverified");
    expect(recordedOwnerState(reused, { slowPath: true })).toBe("dead");
    expect(recordedOwnerState(matching, { slowPath: true })).toBe("alive");
  });
});
