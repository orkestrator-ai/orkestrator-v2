import { beforeEach, describe, expect, test } from "bun:test";
import {
  LOOPED_REVIEW_WORKFLOW_VERSION,
  isLoopedReviewActivePhase,
  isLoopedReviewTerminalPhase,
  isLoopedReviewWorkflow,
  nextReviewAllowance,
  normalizeReviewAllowance,
  useLoopedReviewStore,
} from "./loopedReviewStore";
import { loopedReviewFixture } from "@/test/looped-review-fixture";

describe("loopedReviewStore backend projection", () => {
  beforeEach(() => {
    useLoopedReviewStore.setState({ workflows: new Map() });
  });

  test("installs an authoritative version-2 snapshot", () => {
    const workflow = loopedReviewFixture({ backendRevision: 4, phase: "discovering" });
    useLoopedReviewStore.getState().replaceWorkflow(workflow);
    expect(useLoopedReviewStore.getState().workflows.get(workflow.id)).toEqual(workflow);
    expect(workflow.version).toBe(LOOPED_REVIEW_WORKFLOW_VERSION);
    expect(workflow.controller).toBe("backend");
  });

  test("does not let an older hydration overwrite a newer projection", () => {
    const current = loopedReviewFixture({ backendRevision: 7, phase: "fixing" });
    useLoopedReviewStore.getState().replaceWorkflow(current);
    useLoopedReviewStore.getState().replaceWorkflow({
      ...current,
      backendRevision: 6,
      phase: "preparing",
    });
    expect(useLoopedReviewStore.getState().workflows.get(current.id)?.phase).toBe("fixing");
  });

  test("an equal-revision backend snapshot replaces renderer memory", () => {
    const current = loopedReviewFixture({ backendRevision: 7, phase: "fixing" });
    useLoopedReviewStore.getState().replaceWorkflow(current);
    useLoopedReviewStore.getState().replaceWorkflow({
      ...current,
      phase: "paused",
      pausedFromPhase: "fixing",
    });
    expect(useLoopedReviewStore.getState().workflows.get(current.id)?.phase).toBe("paused");
  });

  test("removes projections without changing backend state", () => {
    const workflow = loopedReviewFixture();
    useLoopedReviewStore.getState().replaceWorkflow(workflow);
    useLoopedReviewStore.getState().removeWorkflow(workflow.id);
    expect(useLoopedReviewStore.getState().workflows.has(workflow.id)).toBe(false);
  });

  test("exposes no renderer phase-advancement methods", () => {
    const state = useLoopedReviewStore.getState() as unknown as Record<string, unknown>;
    for (const method of [
      "createWorkflow", "setPhase", "addSession", "recordReport",
      "recordReconciliation", "completeFix", "claimDispatch", "completePr",
      "pauseWorkflow", "resumeWorkflow", "retryWorkflow", "cancelWorkflow",
    ]) {
      expect(state[method]).toBeUndefined();
    }
  });
});
describe("looped review shared bounds and validation", () => {
  test("normalizes allowance and converges toward one", () => {
    expect(normalizeReviewAllowance(undefined)).toBe(6);
    expect(normalizeReviewAllowance(0)).toBe(1);
    expect(normalizeReviewAllowance(99)).toBe(10);
    expect(nextReviewAllowance(10)).toBe(5);
    expect(nextReviewAllowance(2)).toBe(1);
  });

  test("recognizes active and terminal phases", () => {
    expect(isLoopedReviewActivePhase("preparing")).toBe(true);
    expect(isLoopedReviewActivePhase("paused")).toBe(false);
    expect(isLoopedReviewTerminalPhase("completed")).toBe(true);
    expect(isLoopedReviewTerminalPhase("failed")).toBe(false);
  });

  test("accepts complete backend snapshots and rejects legacy snapshots", () => {
    const workflow = loopedReviewFixture();
    expect(isLoopedReviewWorkflow(workflow)).toBe(true);
    expect(isLoopedReviewWorkflow({ ...workflow, version: 1 })).toBe(false);
    expect(isLoopedReviewWorkflow({ ...workflow, controller: undefined })).toBe(false);
  });
});
