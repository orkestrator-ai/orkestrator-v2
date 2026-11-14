import { describe, expect, test } from "bun:test";
import {
  BUILD_PIPELINE_DETAIL_FIELDS,
  BUILD_PIPELINE_SESSION_DETAIL_FIELDS,
  extractBuildPipelineDetail,
  mergeBuildPipelineDetail,
  omitBuildPipelineDetail,
} from "./build-pipeline-detail";

function snapshot() {
  return {
    id: "p1",
    phase: "reviewing",
    currentSessionIndex: 1,
    taskSnapshot: { title: "Task", description: "x".repeat(200) },
    structuredReview: { summary: "ok", issues: [{ id: "i1" }] },
    keyInformation: { summary: "brief" },
    sessions: [
      {
        sessionKey: "build",
        messageRevision: 3,
        interactionPolicy: { mode: "unattended" },
        fixResult: { summary: "fixed" },
      },
      { sessionKey: "review", messageRevision: 1 },
      {
        sessionKey: "verify",
        reviewReport: { verdict: "pass" },
        acceptanceCriteriaResults: [{ id: "c1", status: "pass" }],
      },
    ],
  };
}

describe("build pipeline detail", () => {
  test("omitting and merging back reproduces the snapshot exactly", () => {
    const full = snapshot();
    const detail = extractBuildPipelineDetail(full);
    expect(detail).not.toBeNull();
    const bare = omitBuildPipelineDetail(full);
    for (const key of BUILD_PIPELINE_DETAIL_FIELDS) expect(key in bare).toBe(false);
    for (const session of bare.sessions) {
      for (const key of BUILD_PIPELINE_SESSION_DETAIL_FIELDS) expect(key in session).toBe(false);
    }
    // The input is untouched.
    expect(full).toEqual(snapshot());
    expect(mergeBuildPipelineDetail(bare, detail!)).toEqual(full);
  });

  test("the detail names each session by key, so moving a field between sessions changes it", () => {
    const moved = snapshot();
    const fixResult = moved.sessions[0]!.fixResult;
    delete (moved.sessions[0] as { fixResult?: unknown }).fixResult;
    (moved.sessions[1] as Record<string, unknown>).fixResult = fixResult;
    expect(JSON.stringify(extractBuildPipelineDetail(moved))).not.toBe(
      JSON.stringify(extractBuildPipelineDetail(snapshot())),
    );
  });

  test("a snapshot whose sessions share a key has no detail and is never omitted", () => {
    const duplicated = snapshot();
    duplicated.sessions[1]!.sessionKey = "build";
    expect(extractBuildPipelineDetail(duplicated)).toBeNull();
    expect(extractBuildPipelineDetail(null)).toBeNull();
    expect(extractBuildPipelineDetail({ sessions: "nope" })).toBeNull();
  });

  test("a held detail naming a session the snapshot lacks does not merge", () => {
    const detail = extractBuildPipelineDetail(snapshot())!;
    const bare = omitBuildPipelineDetail(snapshot());
    bare.sessions = bare.sessions.filter((session) => session.sessionKey !== "verify");
    expect(mergeBuildPipelineDetail(bare, detail)).toBeNull();
  });

  test("a snapshot without detail fields keeps its sessions' identity when omitted", () => {
    const plain = { id: "p1", sessions: [{ sessionKey: "a", messageRevision: 1 }] };
    const bare = omitBuildPipelineDetail(plain);
    expect(bare.sessions[0]).toBe(plain.sessions[0]);
    expect(extractBuildPipelineDetail(plain)).toEqual({ fields: {}, sessions: [] });
  });
});
