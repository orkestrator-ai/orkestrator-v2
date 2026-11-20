import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AGENT_INTERACTION_KINDS } from "@orkestrator/protocol/agent-interactions";
import type { PushKeyChange } from "@orkestrator/protocol/push-client";
import { ENVIRONMENT_PUSH_TOPIC, PUSH_RECOVERY_POLL_MS } from "@orkestrator/protocol/push-events";
import { pushClientFor, usePushSubscription } from "@/lib/push/push-subscriptions";
import { appCommandScope } from "@/lib/node-scope-slots";
import type {
  AgentPendingInteractionSummary,
  AgentRegistryEntry,
  AgentRegistryEnvironmentSummary,
} from "@orkestrator/protocol/agent-registry";
import type { AgentSummarySource } from "./EnvironmentAgentSummary";

/** Coalesces a burst of activity edges into one registry read. */
const REFRESH_DEBOUNCE_MS = 250;

const RETRY_DELAYS_MS = [1_000, 3_000, 10_000] as const;
/** A pending request is re-read this often without push (some providers announce no change). */
export const PENDING_REFRESH_MS = 15_000;

type Entry = Pick<
  AgentRegistryEntry,
  "environmentId" | "ownerKind" | "tabId" | "tabOrdinal" | "kind" | "state" | "pending"
>;
export interface RegistryRead {
  entries: Entry[];
  environments: AgentRegistryEnvironmentSummary[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPending(value: unknown): value is AgentPendingInteractionSummary {
  return (
    isRecord(value) &&
    typeof value.interactionId === "string" &&
    value.interactionId.length > 0 &&
    AGENT_INTERACTION_KINDS.some((kind) => kind === value.kind) &&
    typeof value.label === "string" &&
    value.label.length > 0 &&
    (value.detail === undefined || typeof value.detail === "string") &&
    isCount(value.since) &&
    isCount(value.count) &&
    value.count > 0
  );
}

/** The legacy route returns untyped data. Decode only fields the sidebar consumes. */
function decodeRegistryRead(value: unknown): RegistryRead | null {
  if (!isRecord(value) || !Array.isArray(value.entries) || !Array.isArray(value.environments)) {
    return null;
  }
  const entries: Entry[] = [];
  for (const entry of value.entries) {
    if (
      !isRecord(entry) ||
      typeof entry.environmentId !== "string" ||
      typeof entry.tabId !== "string" ||
      !isCount(entry.tabOrdinal) ||
      entry.ownerKind !== "environment" ||
      entry.kind !== "native" ||
      entry.state !== "waiting"
    )
      continue;
    const pending = isPending(entry.pending) ? entry.pending : undefined;
    entries.push({
      environmentId: entry.environmentId,
      tabId: entry.tabId,
      tabOrdinal: entry.tabOrdinal,
      ownerKind: entry.ownerKind,
      kind: entry.kind,
      state: entry.state,
      // Older nodes may still send the form's provider title.
      pending:
        pending?.kind === "mcp-form"
          ? { ...pending, label: "Needs input", detail: undefined }
          : pending,
    });
  }
  const environments: AgentRegistryEnvironmentSummary[] = [];
  for (const item of value.environments) {
    if (!isRecord(item) || typeof item.environmentId !== "string") continue;
    const { environmentId, tabs, working, waiting, idle, stopped, unknown } = item;
    if (
      isCount(tabs) &&
      isCount(working) &&
      isCount(waiting) &&
      isCount(idle) &&
      isCount(stopped) &&
      isCount(unknown)
    ) {
      environments.push({ environmentId, tabs, working, waiting, idle, stopped, unknown });
    }
  }
  return { entries, environments };
}

function sameRead(left: RegistryRead | null, right: RegistryRead | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * One environment's registry, refreshed by the owning node while the view is open.
 *
 * With a source that names a push scope, the view also subscribes to the
 * environment's `environment` push key (docs/architecture/push-events.md).
 * While that subscription is healthy it reads when a frame names `attention`
 * or `sessions` instead of on every event `subscribe` hears, and a pending
 * request is re-read on the 30 s recovery poll instead of every 15 s (the
 * backend's observer re-reads it for every view). While it is not healthy the
 * view keeps its events and its 15 s cadence.
 */
export function useAgentRegistryRead(
  environmentId: string,
  open: boolean,
  source: AgentSummarySource,
  options: { includePending?: boolean } = {},
): RegistryRead | null {
  const includePending = options.includePending === true;
  const [result, setResult] = useState<{
    environmentId: string;
    source: AgentSummarySource;
    includePending: boolean;
    snapshot: RegistryRead | null;
  }>();

  const pushScope = source.pushScope?.() ?? null;
  const refreshRef = useRef<((immediate?: boolean) => void) | null>(null);
  const onPushChange = useCallback((change: PushKeyChange) => {
    if (
      change.parts === null ||
      change.parts.length === 0 ||
      change.parts.includes("attention") ||
      change.parts.includes("sessions")
    ) {
      refreshRef.current?.(true);
    }
  }, []);
  const pushState = usePushSubscription(
    pushScope ?? appCommandScope(),
    ENVIRONMENT_PUSH_TOPIC,
    environmentId,
    open && pushScope !== null,
    onPushChange,
  );
  const pushHealthy = pushState === "healthy";
  const pushHealthyRef = useRef(pushHealthy);
  useLayoutEffect(() => {
    const wasHealthy = pushHealthyRef.current;
    pushHealthyRef.current = pushHealthy;
    // Frames may have been lost while the subscription went unhealthy, and the
    // pending timer may be on the slow cadence: read now, then the old cadence.
    if (wasHealthy && !pushHealthy) refreshRef.current?.();
  }, [pushHealthy]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let latest = 0;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let previous: RegistryRead | null = null;
    const read = async (recovery = false) => {
      const request = ++latest;
      const snapshot = await Promise.resolve()
        .then(() => source.read(environmentId, includePending ? { includePending } : undefined))
        .then(decodeRegistryRead, () => null);
      if (cancelled || request !== latest) return;
      // A recovery-poll read under a healthy subscription that finds a change
      // found one no frame announced (design D8).
      if (recovery && pushScope && snapshot && previous && !sameRead(previous, snapshot)) {
        pushClientFor(pushScope).noteRecoveryReadFoundChange(ENVIRONMENT_PUSH_TOPIC);
      }
      if (snapshot) previous = snapshot;
      setResult({ environmentId, source, includePending, snapshot });
      // A backend deadline may have returned a partial snapshot while its
      // cached provider read is still in progress.
      const missing = !snapshot || snapshot.entries.some((entry) => !entry.pending);
      if (!includePending) return;
      const hasPending = snapshot?.entries.some((entry) => entry.pending);
      const retry = missing ? RETRY_DELAYS_MS[attempt++] : undefined;
      const healthy = pushHealthyRef.current;
      const delay =
        retry ?? (hasPending ? (healthy ? PUSH_RECOVERY_POLL_MS : PENDING_REFRESH_MS) : undefined);
      if (!missing) attempt = 0;
      // Some older providers publish no same-activity revision. Refresh an
      // existing summary on a slow cadence so it cannot stay stale all turn.
      if (delay !== undefined) {
        timer = setTimeout(() => void read(retry === undefined && healthy), delay);
      }
    };
    const refresh = (immediate = false) => {
      latest++;
      attempt = 0;
      if (timer) clearTimeout(timer);
      if (immediate) void read();
      else timer = setTimeout(() => void read(), REFRESH_DEBOUNCE_MS);
    };
    refreshRef.current = refresh;
    // Events still arrive while push is healthy; its frames already name what
    // moved, so only a subscription resync (`immediate`) reads then.
    const stop = source.subscribe(environmentId, (immediate) => {
      if (pushHealthyRef.current && !immediate) return;
      refresh(immediate);
    });
    if (!source.resyncOnSubscribe) void read();
    return () => {
      cancelled = true;
      if (refreshRef.current === refresh) refreshRef.current = null;
      if (timer) clearTimeout(timer);
      stop();
    };
  }, [environmentId, open, source, includePending, pushScope]);

  return open &&
    result?.environmentId === environmentId &&
    result.source === source &&
    result.includePending === includePending
    ? result.snapshot
    : null;
}
