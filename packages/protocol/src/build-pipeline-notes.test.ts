import { describe, expect, test } from "bun:test";
import { emptyKeyInformation } from "./build-pipeline-key-information.js";
import { pipelineFollowUps } from "./build-pipeline-notes.js";
import type { BuildPipeline, PipelineSession } from "./build-pipeline.js";

const AT = "2026-11-04T00:00:00.000Z";

function verifySession(
  results: PipelineSession["acceptanceCriteriaResults"],
  overrides: Partial<PipelineSession> = {},
): PipelineSession {
  return {
    phase: "verify",
    iteration: 0,
    sessionKey: "verify-1",
    sdkSessionId: "verify-1-session",
    status: "idle",
    startedAt: AT,
    label: "Verify",
    acceptanceCriteriaResults: results,
    ...overrides,
  } as PipelineSession;
}

const taskSnapshot = {
  title: "Ticket",
  description: "",
  acceptanceCriteriaItems: [
    { id: "ac-1", text: "Works on a real phone" },
    { id: "ac-2", text: "Has tests" },
  ],
} as unknown as BuildPipeline["taskSnapshot"];

describe("pipelineFollowUps", () => {
  test("a record with nothing outstanding has no follow-ups", () => {
    expect(pipelineFollowUps({ sessions: [], taskSnapshot, keyInformation: undefined })).toEqual(
      [],
    );
  });

  test("lists not-checked criteria by their text, and leaves passed ones out", () => {
    const followUps = pipelineFollowUps({
      sessions: [
        verifySession([
          { id: "ac-1", status: "not-checked", evidence: "Needs a phone." },
          { id: "ac-2", status: "passed", evidence: "Ran the tests." },
        ]),
      ],
      taskSnapshot,
      keyInformation: undefined,
    });
    expect(followUps).toEqual([
      { kind: "not-checked", text: "Works on a real phone", detail: "Needs a phone." },
    ]);
  });

  test("reads only the newest live verdict", () => {
    const followUps = pipelineFollowUps({
      sessions: [
        verifySession([{ id: "ac-1", status: "not-checked", evidence: "Round one." }]),
        verifySession([{ id: "ac-1", status: "passed", evidence: "Round two." }], {
          sessionKey: "verify-2",
        }),
        verifySession([{ id: "ac-2", status: "not-checked", evidence: "A restart replaced me." }], {
          sessionKey: "verify-3",
          supersededBy: "rewind-1",
        }),
      ],
      taskSnapshot,
      keyInformation: undefined,
    });
    expect(followUps).toEqual([]);
  });

  test("adds what the brief records as outstanding, and nothing it records as handled", () => {
    const followUps = pipelineFollowUps({
      sessions: [],
      taskSnapshot,
      keyInformation: {
        ...emptyKeyInformation(AT),
        notDone: ["Cold-cache run"],
        issues: [
          { round: 0, issue: "Open issue", resolution: "", status: "open" },
          {
            round: 0,
            issue: "Half done",
            resolution: "Desktop only",
            status: "partially-resolved",
          },
          { round: 0, issue: "Fixed issue", resolution: "Fixed", status: "resolved" },
          { round: 0, issue: "Declined issue", resolution: "By design", status: "wont-fix" },
        ],
        tests: [
          { name: "mise run test", result: "passed" },
          { name: "mise run lint", result: "failed", details: "One finding" },
          { name: "mise run test:browser", result: "not-run" },
        ],
      },
    });
    expect(followUps).toEqual([
      { kind: "not-done", text: "Cold-cache run" },
      { kind: "open-issue", text: "Open issue" },
      { kind: "open-issue", text: "Half done", detail: "Desktop only" },
      { kind: "test", text: "mise run lint", detail: "failed: One finding" },
      { kind: "test", text: "mise run test:browser", detail: "not-run" },
    ]);
  });
});
