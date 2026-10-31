import { describe, expect, test } from "bun:test";
import {
  getPrMonitorDetectionRequest,
  parsePrMonitorCheckResponse,
  parsePrMonitorDetectionResponse,
} from "./commands-pr-monitor.js";
import type { PrMonitorTarget } from "./pr-monitor.js";

const target = {
  environmentId: "env-1",
  branch: "feature/login",
  kind: "local",
  worktreePath: "/tmp/project",
  ready: true,
  prUrl: null,
  prState: null,
  hasMergeConflicts: null,
} as PrMonitorTarget;
const own = {
  url: "https://github.com/acme/repo/pull/7",
  state: "OPEN",
  isCrossRepository: false,
  headRefName: "feature/login",
  baseRefName: "main",
};

describe("PR attachment detection", () => {
  test.each(["local", "container"] as const)(
    "%s discovery requests identity and rejects forks",
    (kind) => {
      const request = getPrMonitorDetectionRequest({ ...target, kind });
      expect(request.args.at(-1)).toContain("isCrossRepository");
      expect(
        parsePrMonitorDetectionResponse(
          request,
          JSON.stringify([{ ...own, isCrossRepository: true }]),
        ),
      ).toBeNull();
      expect(
        parsePrMonitorDetectionResponse(
          request,
          JSON.stringify([
            { ...own, url: "https://github.com/acme/repo/pull/8", isCrossRepository: true },
            own,
          ]),
        )?.url,
      ).toBe(own.url);
      expect(
        parsePrMonitorDetectionResponse(
          request,
          JSON.stringify([{ ...own, isCrossRepository: undefined }]),
        ),
      ).toBeNull();
    },
  );

  test("trusted stored attachments still use their exact URL", () => {
    const request = getPrMonitorDetectionRequest({ ...target, prUrl: own.url, prState: "open" });
    expect(request.args).toContain(own.url);
    expect(
      parsePrMonitorDetectionResponse(request, JSON.stringify({ ...own, isCrossRepository: true }))
        ?.url,
    ).toBe(own.url);
  });
});

test("check rollups must describe the same head as the mergeability observation", () => {
  const head = "a".repeat(40);
  expect(() =>
    parsePrMonitorCheckResponse(
      JSON.stringify({ headRefOid: "b".repeat(40), statusCheckRollup: [] }),
      head,
    ),
  ).toThrow("PR head changed");
  expect(
    parsePrMonitorCheckResponse(JSON.stringify({ headRefOid: head, statusCheckRollup: [] }), head),
  ).toEqual({ passed: 0, pending: 0, total: 0 });
});

test("authoritative PR metadata carries the full head SHA", () => {
  const headSha = "a".repeat(40);
  const request = getPrMonitorDetectionRequest({ ...target, prUrl: own.url, prState: "open" });
  expect(request.args.at(-1)).toContain("headRefOid");
  expect(
    parsePrMonitorDetectionResponse(request, JSON.stringify({ ...own, headRefOid: headSha })),
  ).toMatchObject({ headSha });
});
