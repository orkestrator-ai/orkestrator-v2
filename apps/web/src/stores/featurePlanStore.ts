import { create } from "zustand";
import {
  appendFeaturePlanMessage,
  appendFeatureStoryMessage,
  createFeaturePlan,
  getFeaturePlans,
  updateFeaturePlan,
  type FeaturePlan,
  type FeaturePlanMessage,
  type FeaturePlanStatus,
  type FeatureStoryCard,
} from "@/lib/backend";

export type {
  FeaturePlan,
  FeaturePlanMessage,
  FeaturePlanStatus,
  FeatureStoryCard,
};

export interface ActiveFeatureConversation {
  operationId: string;
  featureId: string;
  storyId?: string;
  userMessageId?: string;
  startedAt: string;
  phase: "dispatching" | "running" | "persisting" | "unavailable";
  error?: string;
  responseContent?: string;
  responseModelId?: string;
}

export type FeatureConversationIdentity = Pick<
  ActiveFeatureConversation,
  "featureId" | "operationId"
>;

type FeatureConversationUpdates = Partial<
  Pick<
    ActiveFeatureConversation,
    "userMessageId" | "startedAt" | "phase" | "error" | "responseContent" | "responseModelId"
  >
>;

interface FeaturePlanState {
  features: FeaturePlan[];
  isLoading: boolean;
  currentProjectId: string | null;
  chatDrafts: Map<string, string>;
  /**
   * Renderer cache of feature sessions known to be working.
   *
   * The Codex bridge remains authoritative. FeaturesView rehydrates this map
   * from persisted unanswered messages, pending response-application markers,
   * and `/session/:id/status` whenever it mounts again after an environment
   * switch.
   */
  activeConversations: Map<string, ActiveFeatureConversation>;

  loadFeatures: (projectId: string) => Promise<void>;
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
  startConversation: (conversation: ActiveFeatureConversation) => boolean;
  updateConversation: (
    expected: FeatureConversationIdentity,
    updates: FeatureConversationUpdates,
  ) => boolean;
  markConversationRunning: (expected: FeatureConversationIdentity) => boolean;
  resumeConversation: (expected: FeatureConversationIdentity) => boolean;
  claimConversationPersistence: (
    expected: FeatureConversationIdentity,
    responseContent: string,
    responseModelId?: string,
  ) => boolean;
  settleConversation: (expected: FeatureConversationIdentity) => boolean;
}

function upsertFeature(features: FeaturePlan[], updated: FeaturePlan): FeaturePlan[] {
  const next = features.some((feature) => feature.id === updated.id)
    ? features.map((feature) => (feature.id === updated.id ? updated : feature))
    : [...features, updated];
  return next.sort((a, b) => a.order - b.order);
}

function isSameConversation(
  conversation: ActiveFeatureConversation | undefined,
  expected: FeatureConversationIdentity,
): boolean {
  return (
    conversation?.featureId === expected.featureId
    && conversation.operationId === expected.operationId
  );
}

export const useFeaturePlanStore = create<FeaturePlanState>()((set, get) => ({
  features: [],
  isLoading: false,
  currentProjectId: null,
  chatDrafts: new Map(),
  activeConversations: new Map(),

  loadFeatures: async (projectId) => {
    set({ isLoading: true, currentProjectId: projectId });
    try {
      const features = await getFeaturePlans(projectId);
      if (get().currentProjectId === projectId) {
        set({ features, isLoading: false });
      }
    } catch (error) {
      console.error("[FeaturePlanStore] Failed to load features:", error);
      if (get().currentProjectId === projectId) {
        set({ isLoading: false });
      }
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

  startConversation: (conversation) => {
    let started = false;
    set((state) => {
      if (state.activeConversations.has(conversation.featureId)) return state;
      const activeConversations = new Map(state.activeConversations);
      activeConversations.set(conversation.featureId, conversation);
      started = true;
      return { activeConversations };
    });
    return started;
  },

  updateConversation: (expected, updates) => {
    let updatedMatchingConversation = false;
    set((state) => {
      const current = state.activeConversations.get(expected.featureId);
      if (!current || !isSameConversation(current, expected)) return state;
      updatedMatchingConversation = true;
      const updated = { ...current, ...updates };
      if (
        updated.userMessageId === current.userMessageId
        && updated.startedAt === current.startedAt
        && updated.phase === current.phase
        && updated.error === current.error
        && updated.responseContent === current.responseContent
        && updated.responseModelId === current.responseModelId
      ) {
        return state;
      }
      const activeConversations = new Map(state.activeConversations);
      activeConversations.set(expected.featureId, updated);
      return { activeConversations };
    });
    return updatedMatchingConversation;
  },

  markConversationRunning: (expected) => {
    let marked = false;
    set((state) => {
      const current = state.activeConversations.get(expected.featureId);
      if (
        !current
        || !isSameConversation(current, expected)
        || (
          current.phase !== "dispatching"
          && current.phase !== "running"
        )
      ) {
        return state;
      }
      marked = true;
      if (current.phase === "running" && current.error === undefined) return state;
      const activeConversations = new Map(state.activeConversations);
      activeConversations.set(expected.featureId, {
        ...current,
        phase: "running",
        error: undefined,
      });
      return { activeConversations };
    });
    return marked;
  },

  resumeConversation: (expected) => {
    let resumed = false;
    set((state) => {
      const current = state.activeConversations.get(expected.featureId);
      if (
        !current
        || !isSameConversation(current, expected)
        || current.phase !== "unavailable"
      ) {
        return state;
      }
      const activeConversations = new Map(state.activeConversations);
      activeConversations.set(expected.featureId, {
        ...current,
        phase: "running",
        error: undefined,
      });
      resumed = true;
      return { activeConversations };
    });
    return resumed;
  },

  claimConversationPersistence: (expected, responseContent, responseModelId) => {
    let claimed = false;
    set((state) => {
      const current = state.activeConversations.get(expected.featureId);
      if (
        !current
        || !isSameConversation(current, expected)
        || current.phase !== "running"
      ) {
        return state;
      }
      const activeConversations = new Map(state.activeConversations);
      activeConversations.set(expected.featureId, {
        ...current,
        phase: "persisting",
        error: undefined,
        responseContent,
        responseModelId,
      });
      claimed = true;
      return { activeConversations };
    });
    return claimed;
  },

  settleConversation: (expected) => {
    let settled = false;
    set((state) => {
      const current = state.activeConversations.get(expected.featureId);
      if (!isSameConversation(current, expected)) return state;
      const activeConversations = new Map(state.activeConversations);
      activeConversations.delete(expected.featureId);
      settled = true;
      return { activeConversations };
    });
    return settled;
  },
}));
