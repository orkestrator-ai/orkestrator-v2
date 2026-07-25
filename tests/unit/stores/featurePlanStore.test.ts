import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { FeaturePlan, FeaturePlanMessage } from "@/lib/backend";

// In-memory backing store the mocked backend wrappers operate on.
let backing: FeaturePlan[] = [];

function makeMessage(role: FeaturePlanMessage["role"], content: string): FeaturePlanMessage {
  return { id: `m-${content}`, role, content, createdAt: "2026-01-01T00:00:00.000Z" };
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
const mockAppendFeaturePlanMessage = mock(async (featureId: string, role: FeaturePlanMessage["role"], content: string) => {
  const feature = backing.find((candidate) => candidate.id === featureId);
  if (!feature) throw new Error(`Feature plan not found: ${featureId}`);
  feature.messages = [...feature.messages, makeMessage(role, content)];
  return { ...feature };
});
const mockAppendFeatureStoryMessage = mock(
  async (featureId: string, storyId: string, role: FeaturePlanMessage["role"], content: string) => {
    const feature = backing.find((candidate) => candidate.id === featureId);
    if (!feature) throw new Error(`Feature plan not found: ${featureId}`);
    const story = feature.stories.find((candidate) => candidate.id === storyId);
    if (!story) throw new Error(`Feature story not found: ${storyId}`);
    story.messages = [...story.messages, makeMessage(role, content)];
    return { ...feature };
  },
);

// Snapshot the real module before mocking so we can restore it for other suites.
import * as realBackend from "@/lib/backend";
const realBackendSnapshot = { ...realBackend };

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  getFeaturePlans: mockGetFeaturePlans,
  createFeaturePlan: mockCreateFeaturePlan,
  updateFeaturePlan: mockUpdateFeaturePlan,
  appendFeaturePlanMessage: mockAppendFeaturePlanMessage,
  appendFeatureStoryMessage: mockAppendFeatureStoryMessage,
}));

afterAll(() => {
  mock.module("@/lib/backend", () => realBackendSnapshot);
});

const { useFeaturePlanStore } = await import("@/stores/featurePlanStore");

describe("featurePlanStore", () => {
  beforeEach(() => {
    backing = [];
    mockGetFeaturePlans.mockClear();
    mockGetFeaturePlans.mockImplementation(async (projectId: string) =>
      backing.filter((feature) => feature.projectId === projectId).sort((a, b) => a.order - b.order),
    );
    mockCreateFeaturePlan.mockClear();
    mockUpdateFeaturePlan.mockClear();
    mockAppendFeaturePlanMessage.mockClear();
    mockAppendFeatureStoryMessage.mockClear();
    useFeaturePlanStore.setState({
      features: [],
      isLoading: false,
      currentProjectId: null,
      chatDrafts: new Map(),
      activeConversations: new Map(),
    });
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

  test("keeps active feature conversations outside the mounted view until they settle", () => {
    const store = useFeaturePlanStore.getState();
    store.setConversationActive({
      featureId: "feature-1",
      storyId: "story-1",
      startedAt: "2026-01-01T00:00:00.000Z",
      phase: "dispatching",
    });

    expect(useFeaturePlanStore.getState().activeConversations.get("feature-1")).toEqual({
      featureId: "feature-1",
      storyId: "story-1",
      startedAt: "2026-01-01T00:00:00.000Z",
      phase: "dispatching",
    });

    store.setConversationActive({
      featureId: "feature-1",
      storyId: "story-1",
      startedAt: "2026-01-01T00:00:00.000Z",
      phase: "running",
    });
    expect(useFeaturePlanStore.getState().activeConversations.get("feature-1")?.phase).toBe("running");

    useFeaturePlanStore.getState().setConversationSettled("feature-1");
    useFeaturePlanStore.getState().setConversationSettled("feature-1");

    expect(useFeaturePlanStore.getState().activeConversations.has("feature-1")).toBe(false);
  });

  test("loadFeatures populates features and tracks the current project", async () => {
    backing = [
      makeFeature({ id: "a", projectId: "project-1", order: 1 }),
      makeFeature({ id: "b", projectId: "project-1", order: 0 }),
    ];

    await useFeaturePlanStore.getState().loadFeatures("project-1");

    const state = useFeaturePlanStore.getState();
    expect(state.currentProjectId).toBe("project-1");
    expect(state.isLoading).toBe(false);
    expect(state.features.map((feature) => feature.id)).toEqual(["b", "a"]);
  });

  test("loadFeatures preserves existing features and clears loading when the backend rejects", async () => {
    const existing = makeFeature({ id: "existing", projectId: "project-previous" });
    useFeaturePlanStore.setState({ features: [existing] });
    mockGetFeaturePlans.mockImplementationOnce(async () => {
      throw new Error("backend down");
    });

    await useFeaturePlanStore.getState().loadFeatures("project-1");

    const state = useFeaturePlanStore.getState();
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
    await firstPromise;

    expect(useFeaturePlanStore.getState()).toMatchObject({
      currentProjectId: "project-2",
      isLoading: true,
      features: [],
    });

    secondLoad.resolve([makeFeature({ id: "current", projectId: "project-2" })]);
    await secondPromise;

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
    await firstPromise;

    expect(useFeaturePlanStore.getState()).toMatchObject({
      currentProjectId: "project-2",
      isLoading: true,
      features: [existing],
    });

    secondLoad.resolve([makeFeature({ id: "current", projectId: "project-2" })]);
    await secondPromise;

    expect(useFeaturePlanStore.getState()).toMatchObject({
      currentProjectId: "project-2",
      isLoading: false,
    });
    expect(useFeaturePlanStore.getState().features.map((feature) => feature.id)).toEqual(["current"]);
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

  test("appendMessage adds the message to the stored feature", async () => {
    const created = await useFeaturePlanStore.getState().createFeature("project-1");

    await useFeaturePlanStore.getState().appendMessage(created!, "user", "Add saved filters");

    const stored = useFeaturePlanStore.getState().features.find((feature) => feature.id === created);
    expect(stored?.messages.at(-1)).toMatchObject({ role: "user", content: "Add saved filters" });
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

    await useFeaturePlanStore.getState().appendStoryMessage(created!, "story-1", "assistant", "What to refine?");

    const stored = useFeaturePlanStore.getState().features.find((feature) => feature.id === created);
    expect(stored?.stories[0]?.messages.at(-1)).toMatchObject({ role: "assistant", content: "What to refine?" });
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
