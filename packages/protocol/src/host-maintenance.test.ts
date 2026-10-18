import { describe, expect, test } from "bun:test";
import {
  hostUpdateChannelOfVersion,
  hostUpdateChannelsReceived,
  isHostVersion,
  parseHostUpdaterReport,
} from "./host-maintenance.js";

describe("parseHostUpdaterReport", () => {
  test("accepts each report the executor sends", () => {
    expect(parseHostUpdaterReport({ type: "ready" })).toEqual({ type: "ready" });
    expect(
      parseHostUpdaterReport({
        type: "check",
        latestVersion: "2.22.0",
        updateAvailable: true,
        checkedAt: "2026-10-16T12:00:00.000Z",
        error: null,
        checkRequestId: "hostupd-1",
      }),
    ).toMatchObject({ type: "check", latestVersion: "2.22.0", checkRequestId: "hostupd-1" });
    expect(
      parseHostUpdaterReport({
        type: "job",
        jobId: "hostupd-2",
        state: "downloading",
        progressPercent: 140.4,
      }),
    ).toEqual({ type: "job", jobId: "hostupd-2", state: "downloading", progressPercent: 100 });
  });

  test("refuses states only the backend may set and malformed fields", () => {
    expect(parseHostUpdaterReport({ type: "job", jobId: "j", state: "succeeded" })).toBeNull();
    expect(parseHostUpdaterReport({ type: "job", jobId: "j", state: "requested" })).toBeNull();
    expect(parseHostUpdaterReport({ type: "job", jobId: "bad id!", state: "failed" })).toBeNull();
    expect(
      parseHostUpdaterReport({ type: "job", jobId: "j", state: "failed", targetVersion: "latest" }),
    ).toBeNull();
    expect(
      parseHostUpdaterReport({
        type: "check",
        latestVersion: null,
        updateAvailable: null,
        checkedAt: "yesterday",
        error: null,
      }),
    ).toBeNull();
    expect(parseHostUpdaterReport({ type: "install" })).toBeNull();
    expect(parseHostUpdaterReport(null)).toBeNull();
  });

  test("bounds error text", () => {
    const report = parseHostUpdaterReport({
      type: "job",
      jobId: "j",
      state: "failed",
      error: "x".repeat(2_000),
    });
    expect(report?.type === "job" && report.error?.length).toBe(500);
  });
});

test("isHostVersion accepts release names only", () => {
  expect(isHostVersion("2.22.0")).toBe(true);
  expect(isHostVersion("2.22.0-rc.1")).toBe(true);
  expect(isHostVersion("v2.22.0")).toBe(false);
  expect(isHostVersion("latest")).toBe(false);
});

test("a release's channel comes from its version suffix", () => {
  expect(hostUpdateChannelOfVersion("2.23.0")).toBe("stable");
  expect(hostUpdateChannelOfVersion("v2.23.0")).toBe("stable");
  expect(hostUpdateChannelOfVersion("2.23.0-beta")).toBe("beta");
  expect(hostUpdateChannelOfVersion("2.23.0-beta.2")).toBe("beta");
  expect(hostUpdateChannelOfVersion("v2.24.0-alpha")).toBe("unstable");
  expect(hostUpdateChannelOfVersion("2.24.0-alpha.3")).toBe("unstable");
  for (const version of ["2.23.0-rc.1", "2.23.0-unstable", "2.23.0-beta-2", "2.23", "beta"]) {
    expect(hostUpdateChannelOfVersion(version)).toBeNull();
  }
});

test("a channel receives its own releases and every more stable channel's", () => {
  expect(hostUpdateChannelsReceived("stable")).toEqual(["stable"]);
  expect(hostUpdateChannelsReceived("beta")).toEqual(["stable", "beta"]);
  expect(hostUpdateChannelsReceived("unstable")).toEqual(["stable", "beta", "unstable"]);
});

test("check reports preserve a valid channel and reject an unknown one", () => {
  const report = {
    type: "check",
    latestVersion: "2.23.0",
    updateAvailable: true,
    checkedAt: "2026-10-16T12:00:00.000Z",
    error: null,
    channel: "beta",
  } as const;
  expect(parseHostUpdaterReport(report)).toEqual(report);
  expect(parseHostUpdaterReport({ ...report, channel: "canary" })).toBeNull();
});
