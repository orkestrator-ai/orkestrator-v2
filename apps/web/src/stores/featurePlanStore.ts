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
  featureId: string;
  storyId?: string;
  startedAt: string;
  phase: "dispatching" | "running";
}

interface FeaturePlanState {
  features: FeaturePlan[];
  isLoading: boolean;
  currentProjectId: string | null;
  chatDrafts: Map<string, string>;
  /**
   * Renderer cache of feature sessions known to be working.
   *
   * The Codex bridge remains authoritative. FeaturesView rehydrates this map
   * from persisted unanswered messages plus `/session/:id/status` whenever it
   * mounts again after an environment switch.
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
  ) => Promise<FeaturePlan | undefined>;
  appendStoryMessage: (
    featureId: string,
    storyId: string,
    role: FeaturePlanMessage["role"],
    content: string,
  ) => Promise<FeaturePlan | undefined>;
  setChatDraft: (chatId: string, text: string) => void;
  getChatDraft: (chatId: string) => string;
  setConversationActive: (conversation: ActiveFeatureConversation) => void;
  setConversationSettled: (featureId: string) => void;
}

function upsertFeature(features: FeaturePlan[], updated: FeaturePlan): FeaturePlan[] {
  const next = features.some((feature) => feature.id === updated.id)
    ? features.map((feature) => (feature.id === updated.id ? updated : feature))
    : [...features, updated];
  return next.sort((a, b) => a.order - b.order);
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

  appendMessage: async (featureId, role, content) => {
    try {
      const feature = await appendFeaturePlanMessage(featureId, role, content);
      set((state) => ({ features: upsertFeature(state.features, feature) }));
      return feature;
    } catch (error) {
      console.error("[FeaturePlanStore] Failed to append feature message:", error);
      return undefined;
    }
  },

  appendStoryMessage: async (featureId, storyId, role, content) => {
    try {
      const feature = await appendFeatureStoryMessage(featureId, storyId, role, content);
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

  setConversationActive: (conversation) =>
    set((state) => {
      const current = state.activeConversations.get(conversation.featureId);
      if (
        current?.storyId === conversation.storyId
        && current?.startedAt === conversation.startedAt
        && current?.phase === conversation.phase
      ) {
        return state;
      }
      const activeConversations = new Map(state.activeConversations);
      activeConversations.set(conversation.featureId, conversation);
      return { activeConversations };
    }),

  setConversationSettled: (featureId) =>
    set((state) => {
      if (!state.activeConversations.has(featureId)) return state;
      const activeConversations = new Map(state.activeConversations);
      activeConversations.delete(featureId);
      return { activeConversations };
    }),
}));
