import type { EnvironmentPaneState } from "@/stores/paneLayoutStore";
import { isAgentPlatform, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  boundBrowserHistory,
  sanitizeBrowserHistoryForPersistence,
} from "@/lib/browser-history";
import {
  isGitFileStatus,
  LEGACY_PANE_LAYOUT_VERSION,
  MAX_SPLIT_DEPTH,
  PANE_LAYOUT_VERSION,
  PROVIDER_NATIVE_PANE_LAYOUT_VERSION,
  type PaneLeaf,
  type PaneNode,
  type PaneSplit,
  type PersistedPaneLayout,
  type TabInfo,
} from "@/types/paneLayout";

export interface PaneLayoutRestoreContext {
  environmentId: string;
  containerId: string | null;
  isLocal: boolean;
  worktreePath?: string;
  hasBuildPipeline?: (pipelineId: string) => boolean;
  hasLoopedReview?: (workflowId: string) => boolean;
  hasMultiReview?: (workflowId: string) => boolean;
}

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function restoreNativeAgentData(
  value: JsonObject,
  context: PaneLayoutRestoreContext,
  legacyPlatform?: AgentPlatform,
  legacyField?: string,
) {
  const canonical = isRecord(value.nativeAgentData)
    ? value.nativeAgentData
    : undefined;
  const legacy = legacyField && isRecord(value[legacyField])
    ? value[legacyField] as JsonObject
    : undefined;
  if (!canonical && !legacy) return null;

  const platformValue = canonical?.platform ?? legacyPlatform;
  if (platformValue !== undefined && !isAgentPlatform(platformValue)) return null;
  const source = canonical ?? legacy ?? {};
  return {
    platform: platformValue,
    containerId: context.containerId ?? undefined,
    environmentId: context.environmentId,
    sessionId: nonEmptyString(source.sessionId) ?? undefined,
    isLocal: context.isLocal,
  };
}

function sanitizeSizes(value: unknown): [number, number] {
  if (
    !Array.isArray(value)
    || value.length !== 2
    || value.some((item) => typeof item !== "number" || !Number.isFinite(item) || item <= 0)
  ) {
    return [50, 50];
  }

  const total = value[0] + value[1];
  if (total <= 0) return [50, 50];
  const first = Math.min(90, Math.max(10, (value[0] / total) * 100));
  return [first, 100 - first];
}

function sanitizeTab(value: unknown, context: PaneLayoutRestoreContext): TabInfo | null {
  if (!isRecord(value)) return null;
  const id = nonEmptyString(value.id);
  const type = nonEmptyString(value.type);
  if (!id || !type) return null;

  // `initialAgentModel`/`initialReasoningEffort` are one-shot launch options that
  // `sanitizeTab` in pane-layout-persistence deliberately keeps on disk. Reading
  // them back is what makes the tab itself the durable carrier of the user's
  // create-dialog choice: a renderer reload before the agent surface applied the
  // model rehydrates the tab with it instead of silently falling back to the
  // configured default. The consumer clears them via `clearTabInitialAgentOptions`
  // once applied, so a restored value is by definition still unconsumed.
  const initialConversationMode: "plan" | "build" | undefined =
    value.initialConversationMode === "plan" || value.initialConversationMode === "build"
      ? value.initialConversationMode
      : undefined;
  const common = {
    id,
    displayTitle: optionalString(value.displayTitle),
    isReviewTab: optionalBoolean(value.isReviewTab),
    initialAgentModel: optionalString(value.initialAgentModel),
    initialReasoningEffort: optionalString(value.initialReasoningEffort),
    initialConversationMode,
    initialFastMode: optionalBoolean(value.initialFastMode),
    agentHandoffId: nonEmptyString(value.agentHandoffId) ?? undefined,
    consumedAgentHandoffId: nonEmptyString(value.consumedAgentHandoffId) ?? undefined,
  };

  if (value.isSetupTab === true) {
    // Setup commands are deliberately removed by pane-layout persistence, but
    // the marker is durable identity rather than a command replay request.
    // Keeping it lets a fresh renderer rebind this tab to the backend-owned
    // `<environmentId>:setup` PTY instead of creating a second ordinary shell.
    return { ...common, type: "plain", isSetupTab: true };
  }

  if (type === "plain" || type === "claude" || type === "opencode" || type === "codex" || type === "cursor" || type === "grok" || type === "root") {
    return { ...common, type };
  }

  if (type === "browser") {
    if (!isRecord(value.browserData)) return null;
    const url = optionalString(value.browserData.url) ?? "";
    const rawHistory = Array.isArray(value.browserData.history)
      && value.browserData.history.every((entry) => typeof entry === "string")
      ? value.browserData.history as string[]
      : undefined;
    const rawHistoryIndex = Number.isSafeInteger(value.browserData.historyIndex)
      ? value.browserData.historyIndex as number
      : undefined;
    // No stored history means there is nothing for a cursor to address, so
    // `boundBrowserHistory` drops it rather than restoring an unvalidated index.
    const { history, historyIndex } = boundBrowserHistory(
      rawHistory ? sanitizeBrowserHistoryForPersistence(rawHistory) : undefined,
      rawHistoryIndex,
    );
    return {
      ...common,
      type,
      browserData: {
        url,
        ...(history ? { history } : {}),
        ...(historyIndex !== undefined ? { historyIndex } : {}),
      },
    };
  }

  if (type === "file") {
    if (!isRecord(value.fileData)) return null;
    const filePath = nonEmptyString(value.fileData.filePath);
    if (!filePath) return null;
    return {
      ...common,
      type,
      fileData: {
        filePath,
        containerId: context.containerId ?? undefined,
        worktreePath: context.isLocal ? context.worktreePath : undefined,
        isLocalEnvironment: context.isLocal,
        language: optionalString(value.fileData.language),
        isDiff: optionalBoolean(value.fileData.isDiff),
        gitStatus: isGitFileStatus(value.fileData.gitStatus) ? value.fileData.gitStatus : undefined,
        baseBranch: optionalString(value.fileData.baseBranch),
      },
    };
  }

  const legacyNativeSpec: Record<string, { platform: AgentPlatform; field: string }> = {
    "claude-native": { platform: "claude", field: "claudeNativeData" },
    "codex-native": { platform: "codex", field: "codexNativeData" },
    "opencode-native": { platform: "opencode", field: "openCodeNativeData" },
    "cursor-native": { platform: "cursor", field: "acpNativeData" },
    "grok-native": { platform: "grok", field: "acpNativeData" },
  };
  const legacySpec = legacyNativeSpec[type];
  if (type === "agent-native" || legacySpec) {
    const nativeAgentData = restoreNativeAgentData(
      value,
      context,
      legacySpec?.platform,
      legacySpec?.field,
    );
    if (!nativeAgentData) return null;
    return { ...common, type: "agent-native", nativeAgentData };
  }

  if (type === "claude-tmux") {
    if (!isRecord(value.claudeTmuxData)) return null;
    return {
      ...common,
      type,
      claudeTmuxData: {
        containerId: context.containerId ?? undefined,
        environmentId: context.environmentId,
        isLocal: context.isLocal,
      },
    };
  }

  if (type === "claude-build") {
    if (!isRecord(value.buildTabData)) return null;
    const pipelineId = nonEmptyString(value.buildTabData.pipelineId);
    const taskId = nonEmptyString(value.buildTabData.taskId);
    if (!pipelineId || !taskId || !context.hasBuildPipeline?.(pipelineId)) return null;
    return {
      ...common,
      type,
      buildTabData: {
        environmentId: context.environmentId,
        pipelineId,
        taskId,
        isLocal: context.isLocal,
      },
    };
  }

  if (type === "looped-review") {
    if (!isRecord(value.loopedReviewTabData)) return null;
    const workflowId = nonEmptyString(value.loopedReviewTabData.workflowId);
    if (!workflowId || !context.hasLoopedReview?.(workflowId)) return null;
    return {
      ...common,
      type,
      loopedReviewTabData: {
        environmentId: context.environmentId,
        workflowId,
        isLocal: context.isLocal,
      },
    };
  }

  if (type === "multi-review") {
    if (!isRecord(value.multiReviewTabData)) return null;
    const workflowId = nonEmptyString(value.multiReviewTabData.workflowId);
    const reviewerId = value.multiReviewTabData.reviewerId === undefined
      ? undefined
      : nonEmptyString(value.multiReviewTabData.reviewerId);
    if (value.multiReviewTabData.reviewerId !== undefined && !reviewerId) return null;
    if (!workflowId || !context.hasMultiReview?.(workflowId)) return null;
    return {
      ...common,
      type,
      multiReviewTabData: {
        environmentId: context.environmentId,
        workflowId,
        ...(reviewerId ? { reviewerId } : {}),
        isLocal: context.isLocal,
      },
    };
  }

  return null;
}

export function reconcilePersistedLayout(
  saved: PersistedPaneLayout | null,
  context: PaneLayoutRestoreContext,
): EnvironmentPaneState | null {
  if (
    !saved
    || (
      saved.version !== PANE_LAYOUT_VERSION
      && saved.version !== PROVIDER_NATIVE_PANE_LAYOUT_VERSION
      && saved.version !== LEGACY_PANE_LAYOUT_VERSION
    )
    || saved.environmentId !== context.environmentId
    || saved.containerId !== context.containerId
  ) {
    return null;
  }

  const nodeIds = new Set<string>();
  const tabIds = new Set<string>();
  let malformed = false;

  const visit = (value: unknown, splitDepth: number): PaneNode | null => {
    if (!isRecord(value)) {
      malformed = true;
      return null;
    }

    const id = nonEmptyString(value.id);
    if (!id || nodeIds.has(id)) {
      malformed = true;
      return null;
    }
    nodeIds.add(id);

    if (value.kind === "leaf") {
      if (!Array.isArray(value.tabs)) {
        malformed = true;
        return null;
      }

      const tabs: TabInfo[] = [];
      for (const rawTab of value.tabs) {
        const tab = sanitizeTab(rawTab, context);
        if (!tab || tabIds.has(tab.id)) continue;
        tabIds.add(tab.id);
        tabs.push(tab);
      }
      if (tabs.length === 0) return null;

      const requestedActiveTabId = nonEmptyString(value.activeTabId);
      const activeTabId = requestedActiveTabId && tabs.some((tab) => tab.id === requestedActiveTabId)
        ? requestedActiveTabId
        : tabs[0]!.id;
      const leaf: PaneLeaf = { kind: "leaf", id, tabs, activeTabId };
      return leaf;
    }

    if (value.kind !== "split" || splitDepth >= MAX_SPLIT_DEPTH) {
      malformed = true;
      return null;
    }
    if (
      (value.direction !== "horizontal" && value.direction !== "vertical")
      || !Array.isArray(value.children)
      || value.children.length !== 2
    ) {
      malformed = true;
      return null;
    }

    const first = visit(value.children[0], splitDepth + 1);
    const second = visit(value.children[1], splitDepth + 1);
    if (malformed) return null;
    if (!first) return second;
    if (!second) return first;

    const split: PaneSplit = {
      kind: "split",
      id,
      direction: value.direction,
      children: [first, second],
      sizes: sanitizeSizes(value.sizes),
      depth: splitDepth + 1,
    };
    return split;
  };

  const root = visit(saved.root, 0);
  if (malformed || !root) return null;

  const leaves: PaneLeaf[] = [];
  const collectLeaves = (node: PaneNode) => {
    if (node.kind === "leaf") leaves.push(node);
    else node.children.forEach(collectLeaves);
  };
  collectLeaves(root);
  const activePaneId = leaves.some((leaf) => leaf.id === saved.activePaneId)
    ? saved.activePaneId
    : leaves[0]!.id;

  return {
    root,
    activePaneId,
    containerId: context.containerId,
    backendRevision: saved.revision,
  };
}

function preserveRendererLocalTabFields(
  authoritative: TabInfo,
  current: TabInfo | undefined,
): TabInfo {
  if (!current || current.type !== authoritative.type) return authoritative;
  const preserved: TabInfo = {
    ...authoritative,
    ...(current.initialPrompt !== undefined
      ? { initialPrompt: current.initialPrompt }
      : {}),
    ...(current.initialCommands !== undefined
      ? { initialCommands: [...current.initialCommands] }
      : {}),
  };
  const currentHostPort = current.nativeAgentData?.hostPort;
  if (authoritative.nativeAgentData && currentHostPort !== undefined) {
    preserved.nativeAgentData = {
      ...authoritative.nativeAgentData,
      hostPort: currentHostPort,
    };
  }
  return preserved;
}

/**
 * Keeps connection details that only exist in this renderer while accepting
 * pane and tab selection from the backend snapshot.
 */
export function preserveRendererLocalPaneFields(
  authoritative: EnvironmentPaneState,
  current: EnvironmentPaneState,
): EnvironmentPaneState {
  const currentTabs = new Map<string, TabInfo>();
  const collectCurrentTabs = (node: PaneNode): void => {
    if (node.kind === "leaf") {
      for (const tab of node.tabs) currentTabs.set(tab.id, tab);
      return;
    }
    node.children.forEach(collectCurrentTabs);
  };
  collectCurrentTabs(current.root);

  const preserveTabFields = (node: PaneNode): PaneNode => {
    if (node.kind === "leaf") {
      return {
        ...node,
        tabs: node.tabs.map((tab) =>
          preserveRendererLocalTabFields(tab, currentTabs.get(tab.id))
        ),
      };
    }
    return {
      ...node,
      children: [
        preserveTabFields(node.children[0]),
        preserveTabFields(node.children[1]),
      ],
    };
  };

  return { ...authoritative, root: preserveTabFields(authoritative.root) };
}

/**
 * Installs a legacy v1 backend snapshot without adopting its canonical focus
 * placeholders. Kept only for the bounded v1 migration/refresh window.
 */
export function preserveClientPaneSelection(
  authoritative: EnvironmentPaneState,
  current: EnvironmentPaneState,
): EnvironmentPaneState {
  const currentLeaves = new Map<string, PaneLeaf>();
  const currentTabs = new Map<string, TabInfo>();
  const collectCurrentLeaves = (node: PaneNode): void => {
    if (node.kind === "leaf") {
      currentLeaves.set(node.id, node);
      for (const tab of node.tabs) currentTabs.set(tab.id, tab);
      return;
    }
    node.children.forEach(collectCurrentLeaves);
  };
  collectCurrentLeaves(current.root);

  const preserveLeafSelection = (node: PaneNode): PaneNode => {
    if (node.kind === "leaf") {
      const currentLeaf = currentLeaves.get(node.id);
      const currentActiveTabId = currentLeaf?.activeTabId;
      return {
        ...node,
        tabs: node.tabs.map((tab) =>
          preserveRendererLocalTabFields(tab, currentTabs.get(tab.id))
        ),
        activeTabId:
          currentActiveTabId
          && node.tabs.some((tab) => tab.id === currentActiveTabId)
            ? currentActiveTabId
            : node.activeTabId,
      };
    }
    return {
      ...node,
      children: [
        preserveLeafSelection(node.children[0]),
        preserveLeafSelection(node.children[1]),
      ],
    };
  };

  const root = preserveLeafSelection(authoritative.root);
  const authoritativePaneIds = new Set<string>();
  const collectPaneIds = (node: PaneNode): void => {
    if (node.kind === "leaf") {
      authoritativePaneIds.add(node.id);
      return;
    }
    node.children.forEach(collectPaneIds);
  };
  collectPaneIds(root);

  return {
    ...authoritative,
    root,
    activePaneId: authoritativePaneIds.has(current.activePaneId)
      ? current.activePaneId
      : authoritative.activePaneId,
  };
}
