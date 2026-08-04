import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { FeaturePlan, FeaturePlanMessage } from "@/lib/backend";
import type { FeaturePlanningRecord } from "@orkestrator/protocol/feature-planning";

// In-memory backing store the mocked backend wrappers operate on.
let backing: FeaturePlan[] = [];

function makeMessage(
  role: FeaturePlanMessage["role"],
  content: string,
  stateApplication?: FeaturePlanMessage["stateApplication"],
): FeaturePlanMessage {
  return {
    id: `m-${content}`,
    role,
    content,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...(stateApplication ? { stateApplication } : {}),
  };
}

function makeFeature(overrides: Partial<FeaturePlan> = {}): FeaturePlan {
  return {
    id: "feature-1",
    projectId: "project-1",
    title: "new feature",
    status: "collecting",
    summary: "",
    messages: [makeMessage("assistant", "Tell me about the new feature")],
    stories: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    order: 0,
    ...overrides,
  };
}

function makePlanning(
  overrides: Partial<FeaturePlanningRecord> = {},
): FeaturePlanningRecord {
  return {
    version: 1,
    operationId: "operation-1",
    featureId: "feature-1",
    projectId: "project-1",
    kind: "feature",
    userMessage: "plan this",
    phase: "running",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    backendRevision: 1,
    ...overrides,
  };
}

async function waitForProjection(
  predicate: () => boolean,
  attempts = 50,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Projection did not converge");
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const mockGetFeaturePlans = mock(async (projectId: string) =>
  backing.filter((feature) => feature.projectId === projectId).sort((a, b) => a.order - b.order),
);
const mockCreateFeaturePlan = mock(async (projectId: string) => {
  const feature = makeFeature({ id: `feature-${backing.length + 1}`, projectId, order: backing.length });
  backing.push(feature);
  return feature;
});
const mockUpdateFeaturePlan = mock(async (featureId: string, updates: Partial<FeaturePlan>) => {
  const feature = backing.find((candidate) => candidate.id === featureId);
  if (!feature) throw new Error(`Feature plan not found: ${featureId}`);
  Object.assign(feature, updates);
  return { ...feature };
});
const mockClaimFeaturePlanBuild = mock(async (featureId: string, taskId: string) => {
  const feature = backing.find((candidate) => candidate.id === featureId);
  if (!feature) throw new Error(`Feature plan not found: ${featureId}`);
  if (feature.status === "building" || feature.buildTaskId || feature.buildPipelineId) {
    return { claimed: false, feature: { ...feature } };
  }
  feature.status = "building";
  feature.buildTaskId = taskId;
  return { claimed: true, feature: { ...feature } };
});
const mockAppendFeaturePlanMessage = mock(async (
  featureId: string,
  role: FeaturePlanMessage["role"],
  content: string,
  stateApplication?: FeaturePlanMessage["stateApplication"],
  modelId?: string,
) => {
  const feature = backing.find((candidate) => candidate.id === featureId);
  if (!feature) throw new Error(`Feature plan not found: ${featureId}`);
  feature.messages = [...feature.messages, {
    ...makeMessage(role, content, stateApplication),
    ...(modelId ? { modelId } : {}),
  }];
  return { ...feature };
});
const mockAppendFeatureStoryMessage = mock(
  async (
    featureId: string,
    storyId: string,
    role: FeaturePlanMessage["role"],
    content: string,
    stateApplication?: FeaturePlanMessage["stateApplication"],
    modelId?: string,
  ) => {
    const feature = backing.find((candidate) => candidate.id === featureId);
    if (!feature) throw new Error(`Feature plan not found: ${featureId}`);
    const story = feature.stories.find((candidate) => candidate.id === storyId);
    if (!story) throw new Error(`Feature story not found: ${storyId}`);
    story.messages = [...story.messages, {
      ...makeMessage(role, content, stateApplication),
      ...(modelId ? { modelId } : {}),
    }];
    return { ...feature };
  },
);

const mockStartFeaturePlanning = mock(async (
  featureId: string,
  kind: "feature" | "story",
  userMessage: string,
  storyId?: string,
) => {
  const feature = backing.find((candidate) => candidate.id === featureId);
  if (!feature) throw new Error(`Feature plan not found: ${featureId}`);
  if (feature.planning && feature.planning.phase !== "complete" && feature.planning.phase !== "failed") {
    throw new Error("A planning request is already running for this feature");
  }
  feature.planning = makePlanning({
    featureId,
    kind,
    userMessage,
    ...(storyId ? { storyId } : {}),
  });
  return feature.planning;
});
const mockRetryFeaturePlanning = mock(async (featureId: string) => {
  const feature = backing.find((candidate) => candidate.id === featureId);
  if (!feature?.planning) throw new Error("There is no planning request to retry");
  feature.planning = { ...feature.planning, phase: "dispatching", backendRevision: feature.planning.backendRevision + 1 };
  return feature.planning;
});
const mockCancelFeaturePlanning = mock(async (featureId: string) => {
  const feature = backing.find((candidate) => candidate.id === featureId);
  if (feature) delete feature.planning;
});

// Snapshot the real module before mocking so we can restore it for other suites.
import * as realBackend from "@/lib/backend";
const realBackendSnapshot = { ...realBackend };

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  getFeaturePlans: mockGetFeaturePlans,
  createFeaturePlan: mockCreateFeaturePlan,
  updateFeaturePlan: mockUpdateFeaturePlan,
  claimFeaturePlanBuild: mockClaimFeaturePlanBuild,
  appendFeaturePlanMessage: mockAppendFeaturePlanMessage,
  appendFeatureStoryMessage: mockAppendFeatureStoryMessage,
  startFeaturePlanning: mockStartFeaturePlanning,
  retryFeaturePlanning: mockRetryFeaturePlanning,
  cancelFeaturePlanning: mockCancelFeaturePlanning,
}));

afterAll(() => {
  mock.module("@/lib/backend", () => realBackendSnapshot);
});

const { activeFeaturePlanning, useFeaturePlanStore } = await import("@/stores/featurePlanStore");

describe("featurePlanStore", () => {
  beforeEach(() => {
    backing = [];
    mockGetFeaturePlans.mockClear();
    mockGetFeaturePlans.mockImplementation(async (projectId: string) =>
      backing.filter((feature) => feature.projectId === projectId).sort((a, b) => a.order - b.order),
    );
    mockCreateFeaturePlan.mockClear();
    mockUpdateFeaturePlan.mockClear();
    mockClaimFeaturePlanBuild.mockClear();
    mockClaimFeaturePlanBuild.mockImplementation(async (featureId, taskId) => {
      const feature = backing.find((candidate) => candidate.id === featureId);
      if (!feature) throw new Error(`Feature plan not found: ${featureId}`);
      if (feature.status === "building" || feature.buildTaskId || feature.buildPipelineId) {
        return { claimed: false, feature: { ...feature } };
      }
      feature.status = "building";
      feature.buildTaskId = taskId;
      return { claimed: true, feature: { ...feature } };
    });
    mockAppendFeaturePlanMessage.mockClear();
    mockAppendFeatureStoryMessage.mockClear();
    useFeaturePlanStore.setState({
      features: [],
      isLoading: false,
      currentProjectId: null,
      chatDrafts: new Map(),
    });
    mockStartFeaturePlanning.mockClear();
    mockRetryFeaturePlanning.mockClear();
    mockCancelFeaturePlanning.mockClear();
  });

  test("stores chat drafts by id and removes them when cleared", () => {
    const store = useFeaturePlanStore.getState();

    store.setChatDraft("feature:feature-1", "unfinished message");
    store.setChatDraft("feature:feature-2", "another message");

    expect(useFeaturePlanStore.getState().getChatDraft("feature:feature-1")).toBe("unfinished message");
    expect(useFeaturePlanStore.getState().getChatDraft("feature:feature-2")).toBe("another message");

    useFeaturePlanStore.getState().setChatDraft("feature:feature-1", "");

    expect(useFeaturePlanStore.getState().getChatDraft("feature:feature-1")).toBe("");
    expect(useFeaturePlanStore.getState().chatDrafts.has("feature:feature-1")).toBe(false);
  });

  test("preserves whitespace-only drafts and safely clears a missing draft repeatedly", () => {
    const store = useFeaturePlanStore.getState();

    store.setChatDraft("feature:feature-1", "   ");
    store.setChatDraft("feature:missing", "");
    store.setChatDraft("feature:missing", "");

    const state = useFeaturePlanStore.getState();
    expect(state.getChatDraft("feature:feature-1")).toBe("   ");
    expect(state.chatDrafts.has("feature:feature-1")).toBe(true);
    expect(state.chatDrafts.has("feature:missing")).toBe(false);
  });

  test("startPlanning hands the message to the backend and refreshes the projection", async () => {
    backing = [makeFeature({ id: "feature-1", projectId: "project-1" })];
    await useFeaturePlanStore.getState().loadFeatures("project-1");

    const record = await useFeaturePlanStore.getState()
      .startPlanning("feature-1", "feature", "plan this");

    expect(record?.phase).toBe("running");
    expect(mockStartFeaturePlanning).toHaveBeenCalledWith(
      "feature-1",
      "feature",
      "plan this",
      undefined,
    );
    await waitForProjection(() =>
      useFeaturePlanStore.getState().features[0]?.planning?.phase === "running"
    );
  });

  test("startPlanning forwards a story target to the backend", async () => {
    backing = [makeFeature({ id: "feature-1", projectId: "project-1" })];
    await useFeaturePlanStore.getState().loadFeatures("project-1");

    await useFeaturePlanStore.getState()
      .startPlanning("feature-1", "story", "tighten the criteria", "story-7");

    expect(mockStartFeaturePlanning).toHaveBeenCalledWith(
      "feature-1",
      "story",
      "tighten the criteria",
      "story-7",
    );
  });

  test("planning actions do not refresh without a current project", async () => {
    backing = [makeFeature({
      id: "feature-1",
      projectId: "project-1",
      planning: makePlanning({ phase: "failed" }),
    })];
    useFeaturePlanStore.setState({ currentProjectId: null });

    expect(await useFeaturePlanStore.getState()
      .startPlanning("feature-1", "feature", "plan this")).toBeDefined();
    expect(await useFeaturePlanStore.getState().retryPlanning("feature-1")).toBeDefined();
    expect(await useFeaturePlanStore.getState().cancelPlanning("feature-1")).toBe(true);

    expect(mockGetFeaturePlans).not.toHaveBeenCalled();
  });

  test("startPlanning reports the backend's refusal of a second concurrent turn", async () => {
    backing = [makeFeature({
      id: "feature-1",
      projectId: "project-1",
      planning: makePlanning(),
    })];
    await useFeaturePlanStore.getState().loadFeatures("project-1");

    const record = await useFeaturePlanStore.getState()
      .startPlanning("feature-1", "feature", "plan this too");

    expect(record).toBeUndefined();
  });

  test("cancelPlanning detaches the record from the projection", async () => {
    backing = [makeFeature({
      id: "feature-1",
      projectId: "project-1",
      planning: makePlanning(),
    })];
    await useFeaturePlanStore.getState().loadFeatures("project-1");

    expect(await useFeaturePlanStore.getState().cancelPlanning("feature-1")).toBe(true);
    await waitForProjection(() =>
      useFeaturePlanStore.getState().features[0]?.planning === undefined
    );
  });

  test("retryPlanning re-enters the dispatching phase", async () => {
    backing = [makeFeature({
      id: "feature-1",
      projectId: "project-1",
      planning: makePlanning({ phase: "failed" }),
    })];
    await useFeaturePlanStore.getState().loadFeatures("project-1");

    const record = await useFeaturePlanStore.getState().retryPlanning("feature-1");

    expect(record?.phase).toBe("dispatching");
  });

  test("retryPlanning and cancelPlanning report backend failures", async () => {
    mockRetryFeaturePlanning.mockRejectedValueOnce(new Error("retry unavailable"));
    mockCancelFeaturePlanning.mockRejectedValueOnce(new Error("cancel unavailable"));

    expect(await useFeaturePlanStore.getState().retryPlanning("feature-1"))
      .toBeUndefined();
    expect(await useFeaturePlanStore.getState().cancelPlanning("feature-1"))
      .toBe(false);
    expect(mockGetFeaturePlans).not.toHaveBeenCalled();
  });

  test("activeFeaturePlanning returns only non-terminal records", () => {
    expect(activeFeaturePlanning(undefined)).toBeUndefined();
    expect(activeFeaturePlanning(makeFeature())).toBeUndefined();

    const running = makePlanning({ phase: "persisting" });
    expect(activeFeaturePlanning(makeFeature({ planning: running }))).toBe(running);
    expect(activeFeaturePlanning(makeFeature({
      planning: makePlanning({ phase: "complete" }),
    }))).toBeUndefined();
    expect(activeFeaturePlanning(makeFeature({
      planning: makePlanning({ phase: "failed" }),
    }))).toBeUndefined();
  });

  test("a single-feature response cannot move a planning record backwards", async () => {
    const stale = makePlanning({ backendRevision: 1, phase: "dispatching" });
    backing = [makeFeature({ id: "feature-1", projectId: "project-1", planning: stale })];
    await useFeaturePlanStore.getState().loadFeatures("project-1");
    // The projection has since seen a newer revision of the same exchange.
    useFeaturePlanStore.setState({
      features: [{
        ...useFeaturePlanStore.getState().features[0]!,
        planning: { ...stale, phase: "persisting", backendRevision: 4 },
      }],
    });

    // updateFeature returns the plan as the backend had it before that bump.
    await useFeaturePlanStore.getState().updateFeature("feature-1", { title: "renamed" });

    const projected = useFeaturePlanStore.getState().features[0];
    expect(projected?.title).toBe("renamed");
    expect(projected?.planning?.phase).toBe("persisting");
    expect(projected?.planning?.backendRevision).toBe(4);
  });

  test("a record for a different exchange replaces the projection regardless of revision", async () => {
    backing = [makeFeature({
      id: "feature-1",
      projectId: "project-1",
      planning: makePlanning({ operationId: "operation-2", backendRevision: 0 }),
    })];
    await useFeaturePlanStore.getState().loadFeatures("project-1");
    useFeaturePlanStore.setState({
      features: [{
        ...useFeaturePlanStore.getState().features[0]!,
        planning: makePlanning({ operationId: "operation-1", backendRevision: 9 }),
      }],
    });

    await useFeaturePlanStore.getState().updateFeature("feature-1", { title: "renamed" });

    expect(useFeaturePlanStore.getState().features[0]?.planning?.operationId)
      .toBe("operation-2");
  });

  test("loadFeatures populates features and tracks the current project", async () => {
    backing = [
      makeFeature({ id: "a", projectId: "project-1", order: 1 }),
      makeFeature({ id: "b", projectId: "project-1", order: 0 }),
    ];

    const loaded = await useFeaturePlanStore.getState().loadFeatures("project-1");

    const state = useFeaturePlanStore.getState();
    expect(loaded).toBe(true);
    expect(state.currentProjectId).toBe("project-1");
    expect(state.isLoading).toBe(false);
    expect(state.features.map((feature) => feature.id)).toEqual(["b", "a"]);
  });

  test("loadFeatures carries the backend planning record into the projection", async () => {
    const planning = makePlanning();
    backing = [makeFeature({ id: "feature-1", projectId: "project-1", planning })];

    const loaded = await useFeaturePlanStore.getState().loadFeatures("project-1");

    expect(loaded).toBe(true);
    expect(useFeaturePlanStore.getState().features[0]?.planning).toEqual(planning);
  });

  test("loadFeatures preserves existing features and clears loading when the backend rejects", async () => {
    const existing = makeFeature({ id: "existing", projectId: "project-previous" });
    useFeaturePlanStore.setState({ features: [existing] });
    mockGetFeaturePlans.mockImplementationOnce(async () => {
      throw new Error("backend down");
    });

    const loaded = await useFeaturePlanStore.getState().loadFeatures("project-1");

    const state = useFeaturePlanStore.getState();
    expect(loaded).toBe(false);
    expect(state.currentProjectId).toBe("project-1");
    expect(state.isLoading).toBe(false);
    expect(state.features).toEqual([existing]);
  });

  test("ignores a stale successful load after a newer project load starts", async () => {
    const firstLoad = deferred<FeaturePlan[]>();
    const secondLoad = deferred<FeaturePlan[]>();
    mockGetFeaturePlans.mockImplementation((projectId: string) =>
      projectId === "project-1" ? firstLoad.promise : secondLoad.promise,
    );

    const firstPromise = useFeaturePlanStore.getState().loadFeatures("project-1");
    const secondPromise = useFeaturePlanStore.getState().loadFeatures("project-2");
    firstLoad.resolve([makeFeature({ id: "stale", projectId: "project-1" })]);
    expect(await firstPromise).toBe(false);

    expect(useFeaturePlanStore.getState()).toMatchObject({
      currentProjectId: "project-2",
      isLoading: true,
      features: [],
    });

    secondLoad.resolve([makeFeature({ id: "current", projectId: "project-2" })]);
    expect(await secondPromise).toBe(true);

    expect(useFeaturePlanStore.getState()).toMatchObject({
      currentProjectId: "project-2",
      isLoading: false,
    });
    expect(useFeaturePlanStore.getState().features.map((feature) => feature.id)).toEqual(["current"]);
  });

  test("ignores a stale failed load while a newer project load is pending", async () => {
    const firstLoad = deferred<FeaturePlan[]>();
    const secondLoad = deferred<FeaturePlan[]>();
    const existing = makeFeature({ id: "existing", projectId: "project-previous" });
    useFeaturePlanStore.setState({ features: [existing] });
    mockGetFeaturePlans.mockImplementation((projectId: string) =>
      projectId === "project-1" ? firstLoad.promise : secondLoad.promise,
    );

    const firstPromise = useFeaturePlanStore.getState().loadFeatures("project-1");
    const secondPromise = useFeaturePlanStore.getState().loadFeatures("project-2");
    firstLoad.reject(new Error("stale failure"));
    expect(await firstPromise).toBe(false);

    expect(useFeaturePlanStore.getState()).toMatchObject({
      currentProjectId: "project-2",
      isLoading: true,
      features: [existing],
    });

    secondLoad.resolve([makeFeature({ id: "current", projectId: "project-2" })]);
    expect(await secondPromise).toBe(true);

    expect(useFeaturePlanStore.getState()).toMatchObject({
      currentProjectId: "project-2",
      isLoading: false,
    });
    expect(useFeaturePlanStore.getState().features.map((feature) => feature.id)).toEqual(["current"]);
  });

  test("ignores an older same-project snapshot that resolves after a newer load", async () => {
    const olderLoad = deferred<FeaturePlan[]>();
    const newerLoad = deferred<FeaturePlan[]>();
    mockGetFeaturePlans
      .mockImplementationOnce(() => olderLoad.promise)
      .mockImplementationOnce(() => newerLoad.promise);

    const olderPromise = useFeaturePlanStore.getState().loadFeatures("project-1");
    const newerPromise = useFeaturePlanStore.getState().loadFeatures("project-1");
    newerLoad.resolve([makeFeature({ id: "newest", title: "Current snapshot" })]);
    expect(await newerPromise).toBe(true);
    olderLoad.resolve([makeFeature({ id: "stale", title: "Old snapshot" })]);
    expect(await olderPromise).toBe(false);

    expect(useFeaturePlanStore.getState()).toMatchObject({
      currentProjectId: "project-1",
      isLoading: false,
    });
    expect(useFeaturePlanStore.getState().features.map((feature) => feature.id))
      .toEqual(["newest"]);
  });

  test("createFeature returns the new id and inserts the feature sorted by order", async () => {
    useFeaturePlanStore.setState({ features: [makeFeature({ id: "existing", order: 5 })] });

    const id = await useFeaturePlanStore.getState().createFeature("project-1");

    expect(id).toBeTruthy();
    const features = useFeaturePlanStore.getState().features;
    expect(features.map((feature) => feature.order)).toEqual([0, 5]);
    expect(features.some((feature) => feature.id === id)).toBe(true);
  });

  test("updateFeature replaces a matching feature once and restores order", async () => {
    const original = makeFeature({ id: "target", order: 2, title: "Original" });
    const other = makeFeature({ id: "other", order: 1 });
    useFeaturePlanStore.setState({ features: [original, other] });
    mockUpdateFeaturePlan.mockImplementationOnce(async () =>
      makeFeature({ id: "target", order: 0, title: "Renamed", status: "stories" }),
    );

    const updated = await useFeaturePlanStore.getState().updateFeature("target", {
      title: "Renamed",
      status: "stories",
    });

    expect(updated).toMatchObject({ title: "Renamed", status: "stories" });
    const features = useFeaturePlanStore.getState().features;
    expect(features.map((feature) => feature.id)).toEqual(["target", "other"]);
    expect(features.filter((feature) => feature.id === "target")).toHaveLength(1);
    const stored = features.find((feature) => feature.id === "target");
    expect(stored).toMatchObject({ title: "Renamed", status: "stories" });
  });

  test("updateFeature returns undefined and leaves state unchanged when the backend rejects", async () => {
    const existing = makeFeature({ id: "existing", title: "Original" });
    useFeaturePlanStore.setState({ features: [existing] });
    mockUpdateFeaturePlan.mockImplementationOnce(async () => {
      throw new Error("backend down");
    });

    const result = await useFeaturePlanStore.getState().updateFeature("existing", { title: "Renamed" });

    expect(result).toBeUndefined();
    expect(useFeaturePlanStore.getState().features).toEqual([existing]);
  });

  test("claimFeatureBuild installs the backend's atomic reservation result", async () => {
    const existing = makeFeature({ id: "existing", status: "stories" });
    backing = [existing];
    useFeaturePlanStore.setState({ features: [existing] });

    const result = await useFeaturePlanStore.getState()
      .claimFeatureBuild("existing", "task-1");

    expect(result?.claimed).toBe(true);
    expect(mockClaimFeaturePlanBuild).toHaveBeenCalledWith("existing", "task-1");
    expect(useFeaturePlanStore.getState().features[0]).toMatchObject({
      id: "existing",
      status: "building",
      buildTaskId: "task-1",
    });
  });

  test("claimFeatureBuild installs an authoritative losing reservation", async () => {
    const projected = makeFeature({ id: "existing", status: "stories" });
    backing = [makeFeature({
      id: "existing",
      status: "building",
      buildTaskId: "task-winner",
    })];
    useFeaturePlanStore.setState({ features: [projected] });

    const result = await useFeaturePlanStore.getState()
      .claimFeatureBuild("existing", "task-loser");

    expect(result?.claimed).toBe(false);
    expect(useFeaturePlanStore.getState().features[0]).toMatchObject({
      status: "building",
      buildTaskId: "task-winner",
    });
  });

  test("claimFeatureBuild returns undefined and preserves state when the backend rejects", async () => {
    const existing = makeFeature({ id: "existing", status: "stories" });
    useFeaturePlanStore.setState({ features: [existing] });
    mockClaimFeaturePlanBuild.mockRejectedValueOnce(new Error("claim unavailable"));

    expect(await useFeaturePlanStore.getState()
      .claimFeatureBuild("existing", "task-1")).toBeUndefined();
    expect(useFeaturePlanStore.getState().features).toEqual([existing]);
  });

  test("appendMessage adds the message to the stored feature", async () => {
    const created = await useFeaturePlanStore.getState().createFeature("project-1");

    await useFeaturePlanStore.getState().appendMessage(
      created!,
      "assistant",
      "Add saved filters",
      "pending",
      "gpt-5.3-codex",
    );

    const stored = useFeaturePlanStore.getState().features.find((feature) => feature.id === created);
    expect(stored?.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "Add saved filters",
      stateApplication: "pending",
      modelId: "gpt-5.3-codex",
    });
    expect(mockAppendFeaturePlanMessage).toHaveBeenLastCalledWith(
      created,
      "assistant",
      "Add saved filters",
      "pending",
      "gpt-5.3-codex",
    );
  });

  test("appendMessage returns undefined and leaves state unchanged when the backend rejects", async () => {
    const existing = makeFeature({ id: "existing" });
    useFeaturePlanStore.setState({ features: [existing] });
    mockAppendFeaturePlanMessage.mockImplementationOnce(async () => {
      throw new Error("backend down");
    });

    const result = await useFeaturePlanStore.getState().appendMessage("existing", "user", "Do not append");

    expect(result).toBeUndefined();
    expect(useFeaturePlanStore.getState().features).toEqual([existing]);
  });

  test("appendStoryMessage adds a message to the targeted story", async () => {
    const created = await useFeaturePlanStore.getState().createFeature("project-1");
    await useFeaturePlanStore.getState().updateFeature(created!, {
      stories: [{
        id: "story-1",
        title: "Story",
        description: "desc",
        acceptanceCriteria: [],
        messages: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }],
    });

    await useFeaturePlanStore.getState().appendStoryMessage(
      created!,
      "story-1",
      "assistant",
      "What to refine?",
      "applied",
      "gpt-5.3-codex",
    );

    const stored = useFeaturePlanStore.getState().features.find((feature) => feature.id === created);
    expect(stored?.stories[0]?.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "What to refine?",
      stateApplication: "applied",
      modelId: "gpt-5.3-codex",
    });
    expect(mockAppendFeatureStoryMessage).toHaveBeenLastCalledWith(
      created,
      "story-1",
      "assistant",
      "What to refine?",
      "applied",
      "gpt-5.3-codex",
    );
  });

  test("returns undefined and leaves state intact when the backend rejects", async () => {
    mockCreateFeaturePlan.mockImplementationOnce(async () => {
      throw new Error("backend down");
    });

    const id = await useFeaturePlanStore.getState().createFeature("project-1");

    expect(id).toBeUndefined();
    expect(useFeaturePlanStore.getState().features).toEqual([]);
  });

  test("appendStoryMessage returns undefined for an unknown story", async () => {
    const created = await useFeaturePlanStore.getState().createFeature("project-1");

    const result = await useFeaturePlanStore.getState().appendStoryMessage(created!, "missing", "user", "hi");

    expect(result).toBeUndefined();
  });
});
