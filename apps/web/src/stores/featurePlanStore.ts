import * as backend from "@/lib/backend";
import type {
  FeaturePlan,
  FeaturePlanMessage,
  FeaturePlanStatus,
  FeatureStoryCard,
} from "@/lib/backend";
import { backendApiForScope } from "@/lib/backend/client";
import { createKanbanApi } from "@/lib/backend/kanban";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { defineScopedStore } from "@/lib/node-scope/scoped-store";
import { scopedStoreHook } from "@/lib/node-scope/scoped-store";
import {
  isTerminalFeaturePlanningPhase,
  type FeaturePlanningKind,
  type FeaturePlanningRecord,
} from "@orkestrator/protocol/feature-planning";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

const log = createLogger("web.feature-plan");

export type { FeaturePlan, FeaturePlanMessage, FeaturePlanStatus, FeatureStoryCard };

export type {
  FeaturePlanningKind,
  FeaturePlanningPhase,
  FeaturePlanningRecord,
} from "@orkestrator/protocol/feature-planning";

export {
  isActiveFeaturePlanningPhase,
  isTerminalFeaturePlanningPhase,
} from "@orkestrator/protocol/feature-planning";

export interface FeaturePlanState {
  features: FeaturePlan[];
  isLoading: boolean;
  currentProjectId: string | null;
  chatDrafts: Map<string, string>;

  loadFeatures: (projectId: string) => Promise<boolean>;
  createFeature: (projectId: string) => Promise<string | undefined>;
  updateFeature: (
    featureId: string,
    updates: Partial<
      Pick<
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
      >
    >,
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

/**
 * `scope`'s feature-plan commands: the suites' mocked `@/lib/backend` named
 * exports on the app's command scope, otherwise the scope's own node.
 */
function featurePlanApi(scope: NodeScope) {
  return backendApiForScope(scope, createKanbanApi, {
    appendFeaturePlanMessage: backend.appendFeaturePlanMessage,
    appendFeatureStoryMessage: backend.appendFeatureStoryMessage,
    cancelFeaturePlanning: backend.cancelFeaturePlanning,
    claimFeaturePlanBuild: backend.claimFeaturePlanBuild,
    createFeaturePlan: backend.createFeaturePlan,
    getFeaturePlans: backend.getFeaturePlans,
    retryFeaturePlanning: backend.retryFeaturePlanning,
    startFeaturePlanning: backend.startFeaturePlanning,
    updateFeaturePlan: backend.updateFeaturePlan,
  });
}

/**
 * The open project's feature plans and the planning chats' drafts, per node:
 * a plan belongs to the node that holds its project (plan item 3011).
 */
export const featurePlanStore = defineScopedStore<FeaturePlanState>(
  "feature-plan",
  (scope) => (set, get) => {
    /** Read per call, so a suite's module mock installed later is seen. */
    const api = () => featurePlanApi(scope);
    // Load requests per instance: a response for an older one is dropped.
    let nextFeatureLoadRequestId = 0;
    const latestFeatureLoadRequestByProject = new Map<string, number>();
    return {
      features: [],
      isLoading: false,
      currentProjectId: null,
      chatDrafts: new Map(),

      loadFeatures: async (projectId) => {
        const requestId = ++nextFeatureLoadRequestId;
        latestFeatureLoadRequestByProject.set(projectId, requestId);
        set({ isLoading: true, currentProjectId: projectId });
        try {
          const features = await api().getFeaturePlans(projectId);
          if (
            get().currentProjectId === projectId &&
            latestFeatureLoadRequestByProject.get(projectId) === requestId
          ) {
            set({ features, isLoading: false });
            return true;
          }
          return false;
        } catch (error) {
          log.error("features.load-failed", { projectId, error: formatLogError(error) });
          if (
            get().currentProjectId === projectId &&
            latestFeatureLoadRequestByProject.get(projectId) === requestId
          ) {
            set({ isLoading: false });
          }
          return false;
        }
      },

      createFeature: async (projectId) => {
        try {
          const feature = await api().createFeaturePlan(projectId);
          set((state) => ({ features: upsertFeature(state.features, feature) }));
          return feature.id;
        } catch (error) {
          log.error("feature.create-failed", { projectId, error: formatLogError(error) });
          return undefined;
        }
      },

      updateFeature: async (featureId, updates) => {
        try {
          const feature = await api().updateFeaturePlan(featureId, updates);
          set((state) => ({ features: upsertFeature(state.features, feature) }));
          return feature;
        } catch (error) {
          log.error("feature.update-failed", { featureId, error: formatLogError(error) });
          return undefined;
        }
      },

      claimFeatureBuild: async (featureId, taskId) => {
        try {
          const result = await api().claimFeaturePlanBuild(featureId, taskId);
          set((state) => ({
            features: upsertFeature(state.features, result.feature),
          }));
          return result;
        } catch (error) {
          log.error("build.claim-failed", { featureId, taskId, error: formatLogError(error) });
          return undefined;
        }
      },

      appendMessage: async (featureId, role, content, stateApplication, modelId) => {
        try {
          const feature = await api().appendFeaturePlanMessage(
            featureId,
            role,
            content,
            stateApplication,
            modelId,
          );
          set((state) => ({ features: upsertFeature(state.features, feature) }));
          return feature;
        } catch (error) {
          log.error("message.append-failed", { featureId, error: formatLogError(error) });
          return undefined;
        }
      },

      appendStoryMessage: async (featureId, storyId, role, content, stateApplication, modelId) => {
        try {
          const feature = await api().appendFeatureStoryMessage(
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
          log.error("story-message.append-failed", {
            featureId,
            storyId,
            error: formatLogError(error),
          });
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
          const record = await api().startFeaturePlanning(featureId, kind, userMessage, storyId);
          // The backend persists the user message as part of accepting the
          // request, so refresh rather than guessing what it wrote.
          const projectId = get().currentProjectId;
          if (projectId) void get().loadFeatures(projectId);
          return record;
        } catch (error) {
          log.error("planning.start-failed", { featureId, storyId, error: formatLogError(error) });
          return undefined;
        }
      },

      retryPlanning: async (featureId) => {
        try {
          const record = await api().retryFeaturePlanning(featureId);
          const projectId = get().currentProjectId;
          if (projectId) void get().loadFeatures(projectId);
          return record;
        } catch (error) {
          log.error("planning.retry-failed", { featureId, error: formatLogError(error) });
          return undefined;
        }
      },

      cancelPlanning: async (featureId) => {
        try {
          await api().cancelFeaturePlanning(featureId);
          const projectId = get().currentProjectId;
          if (projectId) void get().loadFeatures(projectId);
          return true;
        } catch (error) {
          log.error("planning.cancel-failed", { featureId, error: formatLogError(error) });
          return false;
        }
      },
    };
  },
);

/** Reads the nearest node scope's plans; other code uses `scope.store(featurePlanStore)`. */
export const useFeaturePlanStore = scopedStoreHook(featurePlanStore);
