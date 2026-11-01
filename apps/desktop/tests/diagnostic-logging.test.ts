import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { captureLogs, type LogCapture } from "@orkestrator/protocol/testing/log-capture";
import type {
  ArtifactHostBlockReason,
  ArtifactHostRejectReason,
} from "../electron/artifact-host-session.js";
import {
  artifactHostDiagnosticFields,
  reportArtifactHostDiagnostics,
  reportMainThreadStall,
} from "../electron/diagnostic-logging.js";

let capture: LogCapture;
beforeEach(() => {
  capture = captureLogs();
});
afterEach(() => capture.restore());

describe("desktop diagnostic logging", () => {
  test("maps a main-thread stall and removes diagnostic suffix prefixes", () => {
    const describeStall = mock(() => "; dialog=confirm openMs=1200");
    reportMainThreadStall(
      {
        lagMs: 1200,
        endedAt: "2026-11-01T12:00:00.000Z",
        intervalMs: 500,
        folded: "; 2 shorter stall(s) since the last report, longest 1100 ms",
      },
      describeStall,
    );
    expect(describeStall).toHaveBeenCalledWith(1200);
    expect(capture.records()).toEqual([
      expect.objectContaining({
        level: "warn",
        area: "desktop",
        event: "main-thread.stalled",
        fields: {
          lagMs: 1200,
          endedAt: "2026-11-01T12:00:00.000Z",
          intervalMs: 500,
          openDialog: "dialog=confirm openMs=1200",
          folded: "2 shorter stall(s) since the last report, longest 1100 ms",
        },
      }),
    ]);
  });

  test("omits empty dialog and folded-stall fields", () => {
    reportMainThreadStall({ lagMs: 1000, endedAt: "t", intervalMs: 500, folded: "" }, () => "");
    expect(capture.records()[0]?.fields).toEqual({ lagMs: 1000, endedAt: "t", intervalMs: 500 });
  });

  test("keeps every artifact reason as an accepted scalar field", () => {
    // Exhaustive records make a new reason require checking its field name
    // and the logger's field budget here.
    const blocked: Record<ArtifactHostBlockReason, number> = {
      "shell-reload": 1,
      "shell-wrong-request": 2,
      "content-reload": 3,
      "content-wrong-request": 4,
      websocket: 5,
      navigation: 6,
      subresource: 7,
      "foreign-request": 8,
      "invalid-url": 9,
      redirect: 10,
      "main-frame-navigation": 11,
      "frame-navigation": 12,
      "nested-frame-navigation": 13,
      "content-unavailable": 14,
      "load-failed": 15,
      "shell-load-failed": 16,
      "shell-unreachable": 17,
      "client-certificate": 18,
      "network-policy-failed": 19,
    };
    const rejected: Record<ArtifactHostRejectReason, number> = {
      "not-object": 20,
      "wrong-channel": 21,
      "wrong-version": 22,
      "unknown-type": 23,
      "bad-shape": 24,
      "identity-mismatch": 25,
      "too-large": 26,
      "rate-limited": 27,
      "nonce-mismatch": 28,
      "duplicate-ready": 29,
      "bad-batch": 30,
      "shell-dropped": 31,
      "theme-identity-mismatch": 32,
    };
    const diagnostics = { blocked, rejected };
    const expected = Object.fromEntries([
      ...Object.entries(blocked).map(([reason, count]) => [`blocked.${reason}`, count]),
      ...Object.entries(rejected).map(([reason, count]) => [`rejected.${reason}`, count]),
    ]);
    expect(artifactHostDiagnosticFields(diagnostics)).toEqual(expected);
    reportArtifactHostDiagnostics(diagnostics);
    const [record] = capture.records();
    // Comparing the actual sanitized output proves every name satisfies the
    // logger's grammar and count bound, without duplicating that grammar.
    expect(record).toMatchObject({
      level: "info",
      area: "artifact-host",
      event: "host.ended",
      fields: expected,
    });
    expect(record?.fields).toEqual(expected);
    expect(Object.keys(record!.fields!)).toHaveLength(32);
  });

  test("an empty artifact diagnostic has no fields", () => {
    reportArtifactHostDiagnostics({ blocked: {}, rejected: {} });
    expect(capture.records()[0]?.fields).toBeUndefined();
  });
});
