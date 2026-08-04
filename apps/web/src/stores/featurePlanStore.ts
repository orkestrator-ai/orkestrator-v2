import { create } from "zustand";
import {
  appendFeaturePlanMessage,
  appendFeatureStoryMessage,
  cancelFeaturePlanning,
  claimFeaturePlanBuild,
  createFeaturePlan,
  getFeaturePlans,
  retryFeaturePlanning,
  startFeaturePlanning,
  updateFeaturePlan,
  type FeaturePlan,
  type FeaturePlanMessage,
  type FeaturePlanStatus,
  type FeatureStoryCard,
} from "@/lib/backend";
import {
  isTerminalFeaturePlanningPhase,
  type FeaturePlanningKind,
  type FeaturePlanningRecord,
} from "@orkestrator/protocol/feature-planning";

export type {
  FeaturePlan,
  FeaturePlanMessage,
  FeaturePlanStatus,
  FeatureStoryCard,
};

export type {
  FeaturePlanningKind,
  FeaturePlanningPhase,
  FeaturePlanningRecord,
} from "@orkestrator/protocol/feature-planning";

export {
  isActiveFeaturePlanningPhase,
  isTerminalFeaturePlanningPhase,
} from "@orkestrator/protocol/feature-planning";

interface FeaturePlanState {
  features: FeaturePlan[];
  isLoading: boolean;
  currentProjectId: string | null;
  chatDrafts: Map<string, string>;

  loadFeatures: (projectId: string) => Promise<boolean>;
  createFeature: (projectId: string) => Promise<string | undefined>;
  updateFeature: (
    featureId: string,
    updates: Partial<Pick<
      FeaturePlan,
      | "title"
      | "status"
      | "summary"
      | "messages"
      | "stories"
      | "codexEnvironmentId"
      | "codexSessionId"
      | "buildTaskId"
      | "buildPipelineId"
    >>,
  ) => Promise<FeaturePlan | undefined>;
  claimFeatureBuild: (
    featureId: string,
    taskId: string,
  ) => Promise<{ claimed: boolean; feature: FeaturePlan } | undefined>;
  appendMessage: (
    featureId: string,
    role: FeaturePlanMessage["role"],
    content: string,
    stateApplication?: FeaturePlanMessage["stateApplication"],
    modelId?: string,
  ) => Promise<FeaturePlan | undefined>;
  appendStoryMessage: (
    featureId: string,
    storyId: string,
    role: FeaturePlanMessage["role"],
    content: string,
    stateApplication?: FeaturePlanMessage["stateApplication"],
    modelId?: string,
  ) => Promise<FeaturePlan | undefined>;
  setChatDraft: (chatId: string, text: string) => void;
  getChatDraft: (chatId: string) => string;
  /** Ask the backend to run a planning turn. It owns everything after this. */
  startPlanning: (
    featureId: string,
    kind: FeaturePlanningKind,
    userMessage: string,
    storyId?: string,
  ) => Promise<FeaturePlanningRecord | undefined>;
  retryPlanning: (featureId: string) => Promise<FeaturePlanningRecord | undefined>;
  cancelPlanning: (featureId: string) => Promise<boolean>;
}

/**
 * Merges an authoritative plan, refusing to move a planning record backwards.
 *
 * Single-feature command responses and full-collection refetches race: a
 * response captured before a backend transition would otherwise reinstate the
 * phase the user has already been shown moving on from.
 */
function upsertFeature(features: FeaturePlan[], updated: FeaturePlan): FeaturePlan[] {
  const existing = features.find((feature) => feature.id === updated.id);
  const merged = staleFeaturePlanning(existing?.planning, updated.planning)
    ? { ...updated, planning: existing!.planning }
    : updated;
  const next = existing
    ? features.map((feature) => (feature.id === merged.id ? merged : feature))
    : [...features, merged];
  return next.sort((a, b) => a.order - b.order);
}

function staleFeaturePlanning(
  current: FeaturePlanningRecord | undefined,
  incoming: FeaturePlanningRecord | undefined,
): boolean {
  if (!current) return false;
  // An exchange that finished is detached, which is not a stale write.
  if (!incoming) return false;
  if (incoming.operationId !== current.operationId) return false;
  return incoming.backendRevision < current.backendRevision;
}

/** The planning exchange attached to a plan, if the backend is still running one. */
export function activeFeaturePlanning(
  feature: FeaturePlan | undefined,
): FeaturePlanningRecord | undefined {
  const record = feature?.planning;
  if (!record || isTerminalFeaturePlanningPhase(record.phase)) return undefined;
  return record;
}

let nextFeatureLoadRequestId = 0;
const latestFeatureLoadRequestByProject = new Map<string, number>();

export const useFeaturePlanStore = create<FeaturePlanState>()((set, get) => ({
  features: [],
  isLoading: false,
  currentProjectId: null,
  chatDrafts: new Map(),

  loadFeatures: async (projectId) => {
    const requestId = ++nextFeatureLoadRequestId;
    latestFeatureLoadRequestByProject.set(projectId, requestId);
    set({ isLoading: true, currentProjectId: projectId });
    try {
      const features = await getFeaturePlans(projectId);
      if (
        get().currentProjectId === projectId
        && latestFeatureLoadRequestByProject.get(projectId) === requestId
      ) {
        set({ features, isLoading: false });
        return true;
      }
      return false;
    } catch (error) {
      console.error("[FeaturePlanStore] Failed to load features:", error);
      if (
        get().currentProjectId === projectId
        && latestFeatureLoadRequestByProject.get(projectId) === requestId
      ) {
        set({ isLoading: false });
      }
      return false;
    }
  },

  createFeature: async (projectId) => {
    try {
      const feature = await createFeaturePlan(projectId);
      set((state) => ({ features: upsertFeature(state.features, feature) }));
      return feature.id;
    } catch (error) {
      console.error("[FeaturePlanStore] Failed to create feature:", error);
      return undefined;
    }
  },

  updateFeature: async (featureId, updates) => {
    try {
      const feature = await updateFeaturePlan(featureId, updates);
      set((state) => ({ features: upsertFeature(state.features, feature) }));
      return feature;
    } catch (error) {
      console.error("[FeaturePlanStore] Failed to update feature:", error);
      return undefined;
    }
  },

  claimFeatureBuild: async (featureId, taskId) => {
    try {
      const result = await claimFeaturePlanBuild(featureId, taskId);
      set((state) => ({
        features: upsertFeature(state.features, result.feature),
      }));
      return result;
    } catch (error) {
      console.error("[FeaturePlanStore] Failed to claim feature build:", error);
      return undefined;
    }
  },

  appendMessage: async (featureId, role, content, stateApplication, modelId) => {
    try {
      const feature = await appendFeaturePlanMessage(
        featureId,
        role,
        content,
        stateApplication,
        modelId,
      );
      set((state) => ({ features: upsertFeature(state.features, feature) }));
      return feature;
    } catch (error) {
      console.error("[FeaturePlanStore] Failed to append feature message:", error);
      return undefined;
    }
  },

  appendStoryMessage: async (featureId, storyId, role, content, stateApplication, modelId) => {
    try {
      const feature = await appendFeatureStoryMessage(
        featureId,
        storyId,
        role,
        content,
        stateApplication,
        modelId,
      );
      set((state) => ({ features: upsertFeature(state.features, feature) }));
      return feature;
    } catch (error) {
      console.error("[FeaturePlanStore] Failed to append story message:", error);
      return undefined;
    }
  },

  setChatDraft: (chatId, text) =>
    set((state) => {
      const chatDrafts = new Map(state.chatDrafts);
      if (text.length > 0) {
        chatDrafts.set(chatId, text);
      } else {
        chatDrafts.delete(chatId);
      }
      return { chatDrafts };
    }),

  getChatDraft: (chatId) => get().chatDrafts.get(chatId) ?? "",

  startPlanning: async (featureId, kind, userMessage, storyId) => {
    try {
      const record = await startFeaturePlanning(featureId, kind, userMessage, storyId);
      // The backend persists the user message as part of accepting the
      // request, so refresh rather than guessing what it wrote.
      const projectId = get().currentProjectId;
      if (projectId) void get().loadFeatures(projectId);
      return record;
    } catch (error) {
      console.error("[FeaturePlanStore] Failed to start feature planning:", error);
      return undefined;
    }
  },

  retryPlanning: async (featureId) => {
    try {
      const record = await retryFeaturePlanning(featureId);
      const projectId = get().currentProjectId;
      if (projectId) void get().loadFeatures(projectId);
      return record;
    } catch (error) {
      console.error("[FeaturePlanStore] Failed to retry feature planning:", error);
      return undefined;
    }
  },

  cancelPlanning: async (featureId) => {
    try {
      await cancelFeaturePlanning(featureId);
      const projectId = get().currentProjectId;
      if (projectId) void get().loadFeatures(projectId);
      return true;
    } catch (error) {
      console.error("[FeaturePlanStore] Failed to cancel feature planning:", error);
      return false;
    }
  },
}));
