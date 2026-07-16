import type { EnvironmentPaneState } from "@/stores/paneLayoutStore";
import {
  isGitFileStatus,
  MAX_SPLIT_DEPTH,
  PANE_LAYOUT_VERSION,
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

  const common = {
    id,
    displayTitle: optionalString(value.displayTitle),
    isReviewTab: optionalBoolean(value.isReviewTab),
  };

  if (value.isSetupTab === true) {
    return { ...common, type: "plain" };
  }

  if (type === "plain" || type === "claude" || type === "opencode" || type === "codex" || type === "root") {
    return { ...common, type };
  }

  if (type === "browser") {
    if (!isRecord(value.browserData)) return null;
    return {
      ...common,
      type,
      browserData: { url: optionalString(value.browserData.url) ?? "" },
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

  if (type === "claude-native") {
    if (!isRecord(value.claudeNativeData)) return null;
    return {
      ...common,
      type,
      claudeNativeData: {
        containerId: context.containerId ?? undefined,
        environmentId: context.environmentId,
        sessionId: nonEmptyString(value.claudeNativeData.sessionId) ?? undefined,
        isLocal: context.isLocal,
      },
    };
  }

  if (type === "codex-native") {
    if (!isRecord(value.codexNativeData)) return null;
    return {
      ...common,
      type,
      codexNativeData: {
        containerId: context.containerId ?? undefined,
        environmentId: context.environmentId,
        sessionId: nonEmptyString(value.codexNativeData.sessionId) ?? undefined,
        isLocal: context.isLocal,
      },
    };
  }

  if (type === "opencode-native") {
    if (!isRecord(value.openCodeNativeData)) return null;
    return {
      ...common,
      type,
      openCodeNativeData: {
        containerId: context.containerId ?? undefined,
        environmentId: context.environmentId,
        sessionId: nonEmptyString(value.openCodeNativeData.sessionId) ?? undefined,
        isLocal: context.isLocal,
      },
    };
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

  return null;
}

export function reconcilePersistedLayout(
  saved: PersistedPaneLayout | null,
  context: PaneLayoutRestoreContext,
): EnvironmentPaneState | null {
  if (
    !saved
    || saved.version !== PANE_LAYOUT_VERSION
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
  };
}
