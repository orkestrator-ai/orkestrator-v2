export interface PaneLayoutTab { id: string; type: string }
export interface PaneLayoutLeaf {
  kind: "leaf";
  id: string;
  tabs: PaneLayoutTab[];
  activeTabId: string | null;
}
export interface PaneLayoutSplit {
  kind: "split";
  id: string;
  direction: string;
  sizes: [number, number];
  children: [PaneLayoutNode, PaneLayoutNode];
}
export type PaneLayoutNode = PaneLayoutLeaf | PaneLayoutSplit;
export interface PaneLayoutMergeInput {
  version: number;
  containerId: string | null;
  activePaneId: string;
  root: PaneLayoutNode;
}
type PaneLeaf = PaneLayoutLeaf;
type PaneNode = PaneLayoutNode;
type PersistedPaneLayoutInput = PaneLayoutMergeInput;
type TabInfo = PaneLayoutTab;

interface NativeAgentTabIdentity {
  platform: string;
  environmentId?: unknown;
  containerId?: unknown;
  hostPort?: unknown;
  sessionId?: unknown;
  isLocal?: unknown;
}

interface NativeAgentTabSpec {
  platform: string;
  legacyField: string;
  acp: boolean;
}

const NATIVE_AGENT_TAB_SPECS: Readonly<Record<string, NativeAgentTabSpec>> = {
  "claude-native": {
    platform: "claude",
    legacyField: "claudeNativeData",
    acp: false,
  },
  "codex-native": {
    platform: "codex",
    legacyField: "codexNativeData",
    acp: false,
  },
  "opencode-native": {
    platform: "opencode",
    legacyField: "openCodeNativeData",
    acp: false,
  },
  "cursor-native": {
    platform: "cursor",
    legacyField: "acpNativeData",
    acp: true,
  },
  "grok-native": {
    platform: "grok",
    legacyField: "acpNativeData",
    acp: true,
  },
};

const NATIVE_AGENT_IDENTITY_FIELDS = [
  "environmentId",
  "containerId",
  "hostPort",
  "sessionId",
  "isLocal",
] as const;

interface TabLocation {
  paneId: string;
}

export interface PaneLayoutSelectionIntent {
  activePaneId?: string;
  activeTabIds?: Record<string, string | null>;
}

export interface PaneLayoutMergeOptions {
  selectionIntent?: PaneLayoutSelectionIntent;
}

function clone<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function serialized(value: unknown): string {
  return JSON.stringify(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value
    && typeof value === "object"
    && !Array.isArray(value);
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => valuesEqual(value, right[index]));
  }
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) =>
      key === rightKeys[index]
      && valuesEqual(left[key], right[key])
    );
}

function mergeChangedFields(
  base: unknown,
  local: unknown,
  remote: unknown,
): unknown {
  if (valuesEqual(local, base)) return clone(remote);
  if (valuesEqual(remote, base) || valuesEqual(local, remote)) {
    return clone(local);
  }
  if (
    isPlainObject(base)
    && isPlainObject(local)
    && isPlainObject(remote)
  ) {
    const merged: Record<string, unknown> = {};
    const keys = new Set([
      ...Object.keys(base),
      ...Object.keys(local),
      ...Object.keys(remote),
    ]);
    for (const key of keys) {
      const value = mergeChangedFields(base[key], local[key], remote[key]);
      if (value !== undefined) merged[key] = value;
    }
    return merged;
  }
  // Both clients changed the same scalar/array incompatibly. The renderer
  // performing the retry owns this tie-break, matching the prior behavior.
  return clone(local);
}

function nativeAgentIdentity(
  tab: TabInfo,
  spec: NativeAgentTabSpec,
): NativeAgentTabIdentity | null {
  const record = tab as unknown as Record<string, unknown>;
  let candidate: Record<string, unknown> | null = null;
  if (
    isPlainObject(record.nativeAgentData)
    && record.nativeAgentData.platform === spec.platform
  ) {
    candidate = record.nativeAgentData;
  } else {
    const legacyCandidate = record[spec.legacyField];
    if (isPlainObject(legacyCandidate)) candidate = legacyCandidate;
  }
  if (!candidate) return null;

  const identity: NativeAgentTabIdentity = { platform: spec.platform };
  for (const field of NATIVE_AGENT_IDENTITY_FIELDS) {
    if (candidate[field] !== undefined) identity[field] = candidate[field];
  }
  return identity;
}

function hasCanonicalNativeAgentIdentity(
  tab: TabInfo,
  spec: NativeAgentTabSpec,
): boolean {
  const record = tab as unknown as Record<string, unknown>;
  return isPlainObject(record.nativeAgentData)
    && record.nativeAgentData.platform === spec.platform;
}

function selectNativeAgentIdentity(
  base: NativeAgentTabIdentity | null,
  local: NativeAgentTabIdentity | null,
  remote: NativeAgentTabIdentity | null,
): NativeAgentTabIdentity | null {
  if (valuesEqual(local, base)) return clone(remote);
  if (valuesEqual(remote, base) || valuesEqual(local, remote)) {
    return clone(local);
  }
  // Match `mergeChangedFields`: when both writers changed the same logical
  // identity, the renderer performing the retry owns the tie-break.
  return clone(local);
}

/**
 * Native tabs temporarily persist the same identity in a canonical field and
 * a provider-specific compatibility field. Treat those fields as one merge
 * unit so an older writer changing only the legacy projection cannot be paired
 * with a stale canonical session id from a concurrent newer writer.
 */
function mergeNativeAgentIdentity(
  base: TabInfo,
  local: TabInfo,
  remote: TabInfo,
  merged: TabInfo,
): TabInfo {
  // Own-property lookup only: tab types come from persisted layouts, and
  // `"constructor"` or `"toString"` would otherwise resolve through
  // `Object.prototype` to a value that is not a spec at all.
  const spec = Object.prototype.hasOwnProperty.call(
    NATIVE_AGENT_TAB_SPECS,
    merged.type,
  )
    ? NATIVE_AGENT_TAB_SPECS[merged.type]
    : undefined;
  if (!spec) return merged;

  const baseIdentity = nativeAgentIdentity(base, spec);
  const localIdentity = nativeAgentIdentity(local, spec);
  const remoteIdentity = nativeAgentIdentity(remote, spec);
  if (!baseIdentity && !localIdentity && !remoteIdentity) return merged;
  const hasCanonicalProjection =
    hasCanonicalNativeAgentIdentity(base, spec)
    || hasCanonicalNativeAgentIdentity(local, spec)
    || hasCanonicalNativeAgentIdentity(remote, spec);

  const selected = selectNativeAgentIdentity(
    baseIdentity,
    localIdentity,
    remoteIdentity,
  );
  const synchronized = { ...merged } as Record<string, unknown>;
  delete synchronized.nativeAgentData;
  delete synchronized[spec.legacyField];
  if (!selected) return synchronized as unknown as TabInfo;

  if (hasCanonicalProjection) synchronized.nativeAgentData = selected;
  const { platform: _platform, ...legacyIdentity } = selected;
  synchronized[spec.legacyField] = spec.acp
    ? { provider: spec.platform, ...legacyIdentity }
    : legacyIdentity;
  return synchronized as unknown as TabInfo;
}

function collectLeaves(node: PaneNode, leaves: PaneLeaf[] = []): PaneLeaf[] {
  if (node.kind === "leaf") {
    leaves.push(node);
  } else {
    collectLeaves(node.children[0], leaves);
    collectLeaves(node.children[1], leaves);
  }
  return leaves;
}

function collectTabs(node: PaneNode): {
  tabs: Map<string, TabInfo>;
  locations: Map<string, TabLocation>;
} {
  const tabs = new Map<string, TabInfo>();
  const locations = new Map<string, TabLocation>();
  for (const leaf of collectLeaves(node)) {
    leaf.tabs.forEach((tab) => {
      tabs.set(tab.id, tab);
      locations.set(tab.id, { paneId: leaf.id });
    });
  }
  return { tabs, locations };
}

function topology(node: PaneNode): unknown {
  if (node.kind === "leaf") return { kind: node.kind, id: node.id };
  return {
    kind: node.kind,
    id: node.id,
    direction: node.direction,
    sizes: node.sizes,
    children: [topology(node.children[0]), topology(node.children[1])],
  };
}

/**
 * Returns one longest common subsequence for two unique-id sequences.
 *
 * Mapping the right side to indexes turns LCS into a longest-increasing-
 * subsequence problem, keeping reorder detection O(n log n) even for a layout
 * near the persisted byte limit.
 */
function stableSequenceIds(left: string[], right: string[]): Set<string> {
  const rightIndexes = new Map(right.map((id, index) => [id, index]));
  const sequence = left.flatMap((id) => {
    const index = rightIndexes.get(id);
    return index === undefined ? [] : [{ id, index }];
  });
  const tails: number[] = [];
  const previous = new Array<number>(sequence.length).fill(-1);
  for (let index = 0; index < sequence.length; index += 1) {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (sequence[tails[middle]!]!.index < sequence[index]!.index) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    if (low > 0) previous[index] = tails[low - 1]!;
    tails[low] = index;
  }
  const stable = new Set<string>();
  let cursor = tails.at(-1) ?? -1;
  while (cursor >= 0) {
    stable.add(sequence[cursor]!.id);
    cursor = previous[cursor]!;
  }
  return stable;
}

function explicitlyMovedTabIds(
  base: PaneNode,
  local: PaneNode,
): Set<string> {
  const baseState = collectTabs(base);
  const localState = collectTabs(local);
  const moved = new Set<string>();
  const paneIds = new Set<string>();
  for (const [id, baseLocation] of baseState.locations) {
    const localLocation = localState.locations.get(id);
    if (!localLocation) continue;
    if (localLocation.paneId !== baseLocation.paneId) {
      moved.add(id);
    } else {
      paneIds.add(baseLocation.paneId);
    }
  }
  const baseLeaves = new Map(
    collectLeaves(base).map((leaf) => [leaf.id, leaf]),
  );
  const localLeaves = new Map(
    collectLeaves(local).map((leaf) => [leaf.id, leaf]),
  );
  for (const paneId of paneIds) {
    const baseOrder = (baseLeaves.get(paneId)?.tabs ?? [])
      .map(({ id }) => id)
      .filter((id) => localState.locations.get(id)?.paneId === paneId);
    const localOrder = (localLeaves.get(paneId)?.tabs ?? [])
      .map(({ id }) => id)
      .filter((id) => baseState.locations.get(id)?.paneId === paneId);
    const stable = stableSequenceIds(baseOrder, localOrder);
    for (const id of baseOrder) {
      if (!stable.has(id)) moved.add(id);
    }
  }
  return moved;
}

function firstLeaf(node: PaneNode): PaneLeaf {
  return node.kind === "leaf" ? node : firstLeaf(node.children[0]);
}

function insertUsingLocalAnchors(
  order: string[],
  localOrder: string[],
  idsToPlace: Set<string>,
): void {
  for (const id of idsToPlace) {
    const existingIndex = order.indexOf(id);
    if (existingIndex >= 0) order.splice(existingIndex, 1);
  }
  for (let index = 0; index < localOrder.length; index += 1) {
    const id = localOrder[index]!;
    if (!idsToPlace.has(id)) continue;
    const nextAnchor = localOrder
      .slice(index + 1)
      .find((candidate) => order.includes(candidate));
    if (nextAnchor) {
      order.splice(order.indexOf(nextAnchor), 0, id);
    } else {
      order.push(id);
    }
  }
}

function isTab(value: unknown): value is TabInfo {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const tab = value as { id?: unknown; type?: unknown };
  return typeof tab.id === "string" && typeof tab.type === "string";
}

export function isPaneNode(value: unknown, depth = 0): value is PaneNode {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || depth > 10
  ) {
    return false;
  }
  const node = value as {
    kind?: unknown;
    id?: unknown;
    tabs?: unknown;
    activeTabId?: unknown;
    direction?: unknown;
    children?: unknown;
    sizes?: unknown;
    depth?: unknown;
  };
  if (typeof node.id !== "string" || node.id.length === 0) return false;
  if (node.kind === "leaf") {
    return Array.isArray(node.tabs)
      && node.tabs.every(isTab)
      && (node.activeTabId === null || typeof node.activeTabId === "string");
  }
  return node.kind === "split"
    && (node.direction === "horizontal" || node.direction === "vertical")
    && Array.isArray(node.children)
    && node.children.length === 2
    && isPaneNode(node.children[0], depth + 1)
    && isPaneNode(node.children[1], depth + 1)
    && Array.isArray(node.sizes)
    && node.sizes.length === 2
    && node.sizes.every((size) => typeof size === "number" && Number.isFinite(size));
}

/**
 * Three-way pane-layout merge used after a compare-and-swap conflict.
 *
 * Tab deletion wins over concurrent edits so a closed tab is never resurrected.
 * Distinct additions are unioned. For a retained tab, local metadata wins only
 * when it changed from the common base; otherwise the remote update is kept.
 * Local moves are replayed over the remote tree, while unrelated remote moves
 * remain in place. Concurrent topology edits use the local topology and graft
 * every surviving remote tab into the nearest still-existing pane.
 */
export function mergePersistedPaneLayouts<T extends PersistedPaneLayoutInput>(
  base: T,
  local: T,
  remote: T,
  options: PaneLayoutMergeOptions = {},
): T {
  if (!isPaneNode(base.root) || !isPaneNode(local.root) || !isPaneNode(remote.root)) {
    throw new Error("Cannot merge malformed pane layout");
  }
  if (
    serialized(local) === serialized(base)
    && !options.selectionIntent
  ) return clone(remote);
  // Selection intent is an operation in its own right. Even when no remote
  // structural change exists, returning the local snapshot here would silently
  // discard an explicitly queued focus change.
  if (
    serialized(remote) === serialized(base)
    && !options.selectionIntent
  ) return clone(local);

  const baseState = collectTabs(base.root);
  const localState = collectTabs(local.root);
  const remoteState = collectTabs(remote.root);
  const baseLeaves = new Map(
    collectLeaves(base.root).map((leaf) => [leaf.id, leaf]),
  );
  const localLeaves = new Map(
    collectLeaves(local.root).map((leaf) => [leaf.id, leaf]),
  );
  const remoteLeaves = new Map(
    collectLeaves(remote.root).map((leaf) => [leaf.id, leaf]),
  );
  const localMovedTabIds = explicitlyMovedTabIds(base.root, local.root);
  const localTopologyChanged =
    serialized(topology(local.root)) !== serialized(topology(base.root));
  const remoteTopologyChanged =
    serialized(topology(remote.root)) !== serialized(topology(base.root));
  const root = clone(
    !localTopologyChanged && remoteTopologyChanged ? remote.root : local.root,
  );

  const finalTabs = new Map<string, TabInfo>();
  const allIds = new Set([
    ...baseState.tabs.keys(),
    ...localState.tabs.keys(),
    ...remoteState.tabs.keys(),
  ]);
  for (const id of allIds) {
    const baseTab = baseState.tabs.get(id);
    const localTab = localState.tabs.get(id);
    const remoteTab = remoteState.tabs.get(id);
    if (baseTab && (!localTab || !remoteTab)) continue;
    if (!baseTab) {
      if (localTab) finalTabs.set(id, localTab);
      else if (remoteTab) finalTabs.set(id, remoteTab);
      continue;
    }
    if (!localTab || !remoteTab) continue;
    const mergedTab = mergeChangedFields(
      baseTab,
      localTab,
      remoteTab,
    ) as TabInfo;
    finalTabs.set(
      id,
      mergeNativeAgentIdentity(baseTab, localTab, remoteTab, mergedTab),
    );
  }

  const leaves = collectLeaves(root);
  const leafIds = new Set(leaves.map(({ id }) => id));
  const fallbackPaneId = firstLeaf(root).id;
  const targetPaneIds = new Map<string, string>();
  for (const id of finalTabs.keys()) {
    const baseLocation = baseState.locations.get(id);
    const localLocation = localState.locations.get(id);
    const remoteLocation = remoteState.locations.get(id);
    const preferredLocation =
      baseLocation && localMovedTabIds.has(id)
        ? localLocation
        : remoteLocation ?? localLocation;
    targetPaneIds.set(
      id,
      preferredLocation && leafIds.has(preferredLocation.paneId)
        ? preferredLocation.paneId
        : fallbackPaneId,
    );
  }

  const orders = new Map(leaves.map((leaf) => [leaf.id, [] as string[]]));
  for (const remoteLeaf of collectLeaves(remote.root)) {
    for (const { id } of remoteLeaf.tabs) {
      const targetPaneId = targetPaneIds.get(id);
      if (!targetPaneId) continue;
      orders.get(targetPaneId)!.push(id);
    }
  }

  const localPlacementIds = new Set<string>();
  for (const id of finalTabs.keys()) {
    if (
      localState.locations.has(id)
      && (
        localMovedTabIds.has(id)
        || !remoteState.locations.has(id)
      )
    ) {
      localPlacementIds.add(id);
    }
  }
  const localOrdersByTarget = new Map<string, string[]>();
  for (const localLeaf of collectLeaves(local.root)) {
    for (const { id } of localLeaf.tabs) {
      const targetPaneId = targetPaneIds.get(id);
      if (!targetPaneId) continue;
      const localOrder = localOrdersByTarget.get(targetPaneId) ?? [];
      localOrder.push(id);
      localOrdersByTarget.set(targetPaneId, localOrder);
    }
  }
  for (const leaf of leaves) {
    const order = orders.get(leaf.id)!;
    const idsToPlace = new Set(
      [...localPlacementIds].filter((id) => targetPaneIds.get(id) === leaf.id),
    );
    insertUsingLocalAnchors(
      order,
      localOrdersByTarget.get(leaf.id) ?? [],
      idsToPlace,
    );
  }

  const placedIds = new Set([...orders.values()].flat());
  for (const id of finalTabs.keys()) {
    if (placedIds.has(id)) continue;
    orders.get(targetPaneIds.get(id) ?? fallbackPaneId)!.push(id);
  }

  // A topology edit can replace every pane id even though the same tabs
  // survive. Carry a local tab-selection change through the tab placement map
  // so it still applies to the pane that now owns that tab.
  const localActiveTabsByTargetPane = new Map<string, string | null>();
  for (const localLeaf of localLeaves.values()) {
    const activeTabId = localLeaf.activeTabId;
    if (
      typeof activeTabId !== "string"
      || activeTabId === baseLeaves.get(localLeaf.id)?.activeTabId
    ) {
      continue;
    }
    const targetPaneId = targetPaneIds.get(activeTabId);
    if (
      targetPaneId
      && (targetPaneId === localLeaf.id || !leafIds.has(localLeaf.id))
    ) {
      localActiveTabsByTargetPane.set(targetPaneId, activeTabId);
    }
  }
  for (const [paneId, activeTabId] of Object.entries(
    options.selectionIntent?.activeTabIds ?? {},
  )) {
    // A stale intent for a pane that this local snapshot already removed must
    // not select a tab in whichever surviving pane now owns that id.
    const sourcePaneSurvives = leafIds.has(paneId);
    if (typeof activeTabId === "string") {
      const targetPaneId = targetPaneIds.get(activeTabId);
      if (
        targetPaneId
        && (targetPaneId === paneId || !sourcePaneSurvives)
        && (sourcePaneSurvives || localLeaves.has(paneId))
      ) {
        localActiveTabsByTargetPane.set(targetPaneId, activeTabId);
      }
    } else if (sourcePaneSurvives) {
      localActiveTabsByTargetPane.set(paneId, null);
    }
  }
  for (const leaf of leaves) {
    leaf.tabs = orders.get(leaf.id)!.map((id) => clone(finalTabs.get(id)!));
    const mergedActiveTabId = mergeChangedFields(
      baseLeaves.get(leaf.id)?.activeTabId,
      localLeaves.get(leaf.id)?.activeTabId,
      remoteLeaves.get(leaf.id)?.activeTabId,
    );
    const validTabIds = new Set(leaf.tabs.map(({ id }) => id));
    const hasMappedLocalActiveTab = localActiveTabsByTargetPane.has(leaf.id);
    const mappedLocalActiveTabId = localActiveTabsByTargetPane.get(leaf.id);
    leaf.activeTabId =
      mappedLocalActiveTabId && validTabIds.has(mappedLocalActiveTabId)
        ? mappedLocalActiveTabId
        : hasMappedLocalActiveTab
          && mappedLocalActiveTabId === null
          && leaf.tabs.length === 0
          ? null
        : typeof mergedActiveTabId === "string" && validTabIds.has(mergedActiveTabId)
        ? mergedActiveTabId
        : [
          remoteLeaves.get(leaf.id)?.activeTabId,
          localLeaves.get(leaf.id)?.activeTabId,
        ].find((id): id is string => typeof id === "string" && validTabIds.has(id))
          ?? leaf.tabs[0]?.id
          ?? null;
  }

  const validPaneIds = new Set(leaves.map(({ id }) => id));
  const mergedActivePaneId = mergeChangedFields(
    base.activePaneId,
    local.activePaneId,
    remote.activePaneId,
  );
  const baseFocusedTabId = baseLeaves.get(base.activePaneId)?.activeTabId;
  const localFocusedTabId = localLeaves.get(local.activePaneId)?.activeTabId;
  const intendedActivePaneId =
    options.selectionIntent?.activePaneId ?? local.activePaneId;
  const hasFocusedPaneTabIntent = Object.prototype.hasOwnProperty.call(
    options.selectionIntent?.activeTabIds ?? {},
    intendedActivePaneId,
  );
  const localFocusChanged =
    options.selectionIntent?.activePaneId !== undefined
    || hasFocusedPaneTabIntent
    || local.activePaneId !== base.activePaneId
    || localFocusedTabId !== baseFocusedTabId;
  const intendedFocusedTabId =
    options.selectionIntent?.activeTabIds?.[intendedActivePaneId]
    ?? localLeaves.get(intendedActivePaneId)?.activeTabId
    ?? localFocusedTabId;
  const mappedLocalActivePaneId = localFocusChanged
    ? (
      validPaneIds.has(intendedActivePaneId)
        ? intendedActivePaneId
        : typeof intendedFocusedTabId === "string"
          ? targetPaneIds.get(intendedFocusedTabId)
          : undefined
    )
    : undefined;
  const activePaneId =
    mappedLocalActivePaneId && validPaneIds.has(mappedLocalActivePaneId)
      ? mappedLocalActivePaneId
      : typeof mergedActivePaneId === "string" && validPaneIds.has(mergedActivePaneId)
      ? mergedActivePaneId
      : [remote.activePaneId, local.activePaneId]
        .find((id) => validPaneIds.has(id))
        ?? firstLeaf(root).id;

  return {
    version: local.version,
    containerId: local.containerId,
    activePaneId,
    root,
  } as T;
}
