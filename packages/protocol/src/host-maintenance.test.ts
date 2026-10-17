import { describe, expect, test } from "bun:test";
import { isHostVersion, parseHostUpdaterReport } from "./host-maintenance.js";

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
