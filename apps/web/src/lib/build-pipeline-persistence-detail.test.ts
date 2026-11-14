import { beforeEach, describe, expect, mock, test } from "bun:test";
import { UNATTENDED_AGENT_INTERACTION_POLICY } from "@orkestrator/protocol/agent-interactions";
import { omitBuildPipelineDetail } from "@orkestrator/protocol/build-pipeline-detail";
import { invoke } from "@/lib/native/backend";
import {
  heldBuildPipelineDetailFingerprintForTests,
  hydrateBuildPipeline,
  isBuildPipelineKnownUnavailable,
  resetBuildPipelineUnavailableMarkersForTests,
} from "./build-pipeline-persistence";
import {
  BUILD_PIPELINE_VERSION,
  type BuildPipeline,
  buildPipelineStore,
} from "@/stores/buildPipelineStore";
import type { PersistedBuildPipeline } from "@/types";
import { appCommandStore } from "@/test/app-command-store";

/**
 * The renderer half of the detail fingerprint (`@orkestrator/protocol/build-pipeline-detail`):
 * point reads name the detail they hold, merge it back into an answer that
 * left it out, and fall back to the whole record whenever they cannot.
 */

const invokeMock = invoke as ReturnType<typeof mock>;

function pipeline(id: string, overrides: Partial<BuildPipeline> = {}): BuildPipeline {
  return {
    id,
    taskId: "task-1",
    projectId: "project-1",
    environmentId: "env-1",
    environmentType: "local",
    agentType: "codex",
    phase: "building",
    sessions: [
      {
        phase: "build",
        iteration: 0,
        sessionKey: "build",
        sdkSessionId: "sdk-build",
        status: "running",
        startedAt: "2026-11-14T00:00:00.000Z",
        label: "Build",
        messageRevision: 1,
        origin: "build-pipeline",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      },
      {
        phase: "verify",
        iteration: 0,
        sessionKey: "verify",
        sdkSessionId: "sdk-verify",
        status: "idle",
        startedAt: "2026-11-14T00:00:00.000Z",
        label: "Verify",
        verificationResult: "fail",
        verificationFeedback: "needs another pass",
      },
    ],
    currentSessionIndex: 0,
    iteration: 0,
    maxIterations: 3,
    createdAt: "2026-11-14T00:00:00.000Z",
    taskTitle: "Task",
    taskSnapshot: {
      title: "Task",
      description: "d".repeat(500),
      acceptanceCriteria: "",
      comments: [],
      images: [],
    },
    backendRevision: 0,
    controller: "backend",
    ...overrides,
  };
}

/** A pipeline as a wire snapshot (`toSnapshot` replaces its backend revision). */
function wire(value: BuildPipeline): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function record(
  snapshot: Record<string, unknown>,
  id: string,
  revision: number,
): PersistedBuildPipeline<BuildPipeline> {
  return {
    version: BUILD_PIPELINE_VERSION,
    id,
    projectId: "project-1",
    environmentId: "env-1",
    snapshot: snapshot as unknown as BuildPipeline,
    revision,
    updatedAt: "2026-11-14T00:00:00.000Z",
  };
}

function answer(
  snapshot: Record<string, unknown>,
  id: string,
  revision: number,
  detail: { fingerprint?: string; omitted?: boolean } = {},
) {
  return {
    unchanged: false,
    record: record(detail.omitted ? omitBuildPipelineDetail(snapshot) : snapshot, id, revision),
    messagePatches: [],
    ...(detail.fingerprint ? { detailFingerprint: detail.fingerprint } : {}),
    ...(detail.omitted ? { detailOmitted: true } : {}),
  };
}

function stored(id: string) {
  return appCommandStore(buildPipelineStore).getState().pipelines.get(id);
}

function lastArgs(): Record<string, unknown> {
  return invokeMock.mock.calls.at(-1)?.[1] as Record<string, unknown>;
}

describe("build pipeline point reads and the held detail", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    resetBuildPipelineUnavailableMarkersForTests();
    appCommandStore(buildPipelineStore).setState({
      pipelines: new Map(),
      buildEnvironmentIds: new Set(),
    });
  });

  test("an unchanged heavy part is merged back into an identical, complete pipeline", async () => {
    const id = "detail-unchanged";
    invokeMock.mockResolvedValueOnce(answer(wire(pipeline(id)), id, 1, { fingerprint: "d1-a" }));
    await hydrateBuildPipeline(id);
    expect(lastArgs()).toEqual({ pipelineId: id, knownDetailFingerprint: "" });
    expect(heldBuildPipelineDetailFingerprintForTests(id)).toBe("d1-a");

    // A transcript-only change: the cursor moved, the detail did not.
    const next = pipeline(id, {
      sessions: [{ ...pipeline(id).sessions[0]!, messageRevision: 2 }, pipeline(id).sessions[1]!],
    });
    invokeMock.mockResolvedValueOnce(
      answer(wire(next), id, 2, { fingerprint: "d1-a", omitted: true }),
    );
    const restored = await hydrateBuildPipeline(id);
    expect(lastArgs()).toEqual({
      pipelineId: id,
      knownRevision: 1,
      knownDetailFingerprint: "d1-a",
    });
    expect(invokeMock).toHaveBeenCalledTimes(2);
    const expected = { ...next, backendRevision: 2 };
    expect(restored).toEqual(expected);
    expect(stored(id)).toEqual(expected);
    expect(stored(id)?.taskSnapshot.description).toHaveLength(500);
  });

  test("a changed heavy part replaces the held detail", async () => {
    const id = "detail-changed";
    invokeMock.mockResolvedValueOnce(answer(wire(pipeline(id)), id, 1, { fingerprint: "d1-a" }));
    await hydrateBuildPipeline(id);
    const changed = pipeline(id, {
      taskSnapshot: { ...pipeline(id).taskSnapshot, title: "Renamed" },
    });
    invokeMock.mockResolvedValueOnce(answer(wire(changed), id, 2, { fingerprint: "d1-b" }));
    await hydrateBuildPipeline(id);
    expect(stored(id)?.taskSnapshot.title).toBe("Renamed");
    expect(heldBuildPipelineDetailFingerprintForTests(id)).toBe("d1-b");

    // The next omitted answer merges the new detail, not the first one.
    invokeMock.mockResolvedValueOnce(
      answer(wire(changed), id, 3, { fingerprint: "d1-b", omitted: true }),
    );
    await hydrateBuildPipeline(id);
    expect(lastArgs().knownDetailFingerprint).toBe("d1-b");
    expect(stored(id)).toEqual({ ...changed, backendRevision: 3 });
  });

  test("an omitted answer for a fingerprint not held asks again for the whole record", async () => {
    const id = "detail-stale";
    invokeMock.mockResolvedValueOnce(answer(wire(pipeline(id)), id, 1, { fingerprint: "d1-a" }));
    await hydrateBuildPipeline(id);
    const changed = pipeline(id, {
      taskSnapshot: { ...pipeline(id).taskSnapshot, title: "Other" },
    });
    invokeMock
      .mockResolvedValueOnce(answer(wire(changed), id, 2, { fingerprint: "d1-z", omitted: true }))
      .mockResolvedValueOnce(answer(wire(changed), id, 2, { fingerprint: "d1-z" }));
    await hydrateBuildPipeline(id);
    expect(invokeMock).toHaveBeenCalledTimes(3);
    expect(lastArgs().knownDetailFingerprint).toBe("");
    expect(stored(id)).toEqual({ ...changed, backendRevision: 2 });
    expect(heldBuildPipelineDetailFingerprintForTests(id)).toBe("d1-z");
  });

  test("an older backend that ignores the fingerprint still fills the store", async () => {
    const id = "detail-older-backend";
    const full = pipeline(id);
    invokeMock.mockResolvedValueOnce(record(wire(full), id, 1));
    await hydrateBuildPipeline(id);
    expect(lastArgs()).toEqual({ pipelineId: id, knownDetailFingerprint: "" });
    expect(stored(id)).toEqual({ ...full, backendRevision: 1 });
    expect(heldBuildPipelineDetailFingerprintForTests(id)).toBeUndefined();

    invokeMock.mockResolvedValueOnce(record(wire(full), id, 2));
    await hydrateBuildPipeline(id);
    expect(lastArgs().knownDetailFingerprint).toBe("");
    expect(stored(id)).toEqual({ ...full, backendRevision: 2 });

    // Transcript reads too.
    invokeMock.mockResolvedValueOnce({
      unchanged: false,
      record: record(wire(full), id, 3),
      messagePatches: [],
    });
    await hydrateBuildPipeline(id, undefined, { transcripts: true, prioritySessionKey: "build" });
    expect(lastArgs()).toMatchObject({ knownSessions: {}, knownDetailFingerprint: "" });
    expect(stored(id)).toEqual({ ...full, backendRevision: 3 });
  });

  test("a transcript read merges the held detail and applies its patches", async () => {
    const id = "detail-transcripts";
    invokeMock.mockResolvedValueOnce(answer(wire(pipeline(id)), id, 1, { fingerprint: "d1-a" }));
    await hydrateBuildPipeline(id);
    const next = pipeline(id, {
      sessions: [{ ...pipeline(id).sessions[0]!, messageRevision: 2 }, pipeline(id).sessions[1]!],
    });
    const body = [{ id: "m1", role: "assistant", content: "hi" }];
    invokeMock.mockResolvedValueOnce({
      ...answer(wire(next), id, 2, { fingerprint: "d1-a", omitted: true }),
      messagePatches: [{ sessionKey: "build", startIndex: 0, revision: 2, messages: body }],
    });
    await hydrateBuildPipeline(id, undefined, { transcripts: true, prioritySessionKey: "build" });
    expect(lastArgs().knownDetailFingerprint).toBe("d1-a");
    expect(stored(id)).toMatchObject({ ...next, backendRevision: 2 });
    expect(stored(id)?.sessions[0]?.messages).toEqual(body);
    expect(stored(id)?.sessions[0]?.interactionPolicy).toEqual(UNATTENDED_AGENT_INTERACTION_POLICY);
    expect(stored(id)?.sessions[1]?.verificationFeedback).toBe("needs another pass");
  });

  test("a deleted pipeline is marked unavailable and its held detail dropped", async () => {
    const id = "detail-deleted";
    invokeMock.mockResolvedValueOnce(answer(wire(pipeline(id)), id, 1, { fingerprint: "d1-a" }));
    await hydrateBuildPipeline(id);
    invokeMock.mockResolvedValueOnce(null);
    expect(await hydrateBuildPipeline(id)).toBeNull();
    expect(lastArgs().knownDetailFingerprint).toBe("d1-a");
    expect(isBuildPipelineKnownUnavailable(id)).toBe(true);
    expect(heldBuildPipelineDetailFingerprintForTests(id)).toBeUndefined();
  });
});
