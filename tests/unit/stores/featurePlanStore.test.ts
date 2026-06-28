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
    useFeaturePlanStore.setState({ features: [], isLoading: false, currentProjectId: null });
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

  test("createFeature returns the new id and inserts the feature sorted by order", async () => {
    useFeaturePlanStore.setState({ features: [makeFeature({ id: "existing", order: 5 })] });

    const id = await useFeaturePlanStore.getState().createFeature("project-1");

    expect(id).toBeTruthy();
    const features = useFeaturePlanStore.getState().features;
    expect(features.map((feature) => feature.order)).toEqual([0, 5]);
    expect(features.some((feature) => feature.id === id)).toBe(true);
  });

  test("updateFeature replaces the matching feature in place", async () => {
    const created = await useFeaturePlanStore.getState().createFeature("project-1");

    const updated = await useFeaturePlanStore.getState().updateFeature(created!, { title: "Renamed", status: "stories" });

    expect(updated).toMatchObject({ title: "Renamed", status: "stories" });
    const stored = useFeaturePlanStore.getState().features.find((feature) => feature.id === created);
    expect(stored).toMatchObject({ title: "Renamed", status: "stories" });
  });

  test("appendMessage adds the message to the stored feature", async () => {
    const created = await useFeaturePlanStore.getState().createFeature("project-1");

    await useFeaturePlanStore.getState().appendMessage(created!, "user", "Add saved filters");

    const stored = useFeaturePlanStore.getState().features.find((feature) => feature.id === created);
    expect(stored?.messages.at(-1)).toMatchObject({ role: "user", content: "Add saved filters" });
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
