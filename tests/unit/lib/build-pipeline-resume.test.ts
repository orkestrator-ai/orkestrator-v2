import { beforeEach, describe, expect, mock, test } from "bun:test";
import { invoke } from "@/lib/native/backend";
import { getBuildPipeline, resumeBuildPipeline } from "../../../apps/web/src/lib/backend";

const invokeMock = invoke as ReturnType<typeof mock>;

describe("backend-owned build pipeline resume", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  test("delegates resume to the authoritative backend state machine", async () => {
    const resumed = {
      id: "pipeline-1",
      phase: "building",
      controller: "backend",
      backendRevision: 4,
    };
    invokeMock.mockResolvedValueOnce(resumed);

    await expect(resumeBuildPipeline("pipeline-1")).resolves.toBe(resumed);
    expect(invokeMock).toHaveBeenCalledWith("resume_build_pipeline", {
      pipelineId: "pipeline-1",
    });
  });

  test("does not synthesize a client resume snapshot when the backend rejects", async () => {
    invokeMock.mockRejectedValueOnce(new Error("Pipeline is not paused"));

    await expect(resumeBuildPipeline("pipeline-1")).rejects.toThrow("Pipeline is not paused");
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  test("reads the authoritative snapshot independently of resume", async () => {
    const snapshot = {
      id: "pipeline-1",
      phase: "paused",
      pausedFromPhase: "verifying",
      controller: "backend",
      backendRevision: 3,
    };
    invokeMock.mockResolvedValueOnce(snapshot);

    await expect(getBuildPipeline("pipeline-1")).resolves.toBe(snapshot);
    expect(invokeMock).toHaveBeenCalledWith("get_build_pipeline", {
      pipelineId: "pipeline-1",
    });
  });
});
