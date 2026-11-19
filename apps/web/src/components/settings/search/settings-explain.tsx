/**
 * What every field explanation in one Settings view shares: where the values
 * on screen come from (read once per machine from the backend), the names of
 * the machine and its command node, the shared form's unsaved state, and the
 * reset dialog.
 *
 * The form reports its draft state to a small registry the page owns
 * (`SettingsDraftRegistry`) rather than through React state, so search,
 * navigation and explanations outside the form can read it without the form
 * re-rendering them, and without the form being mounted at all.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import * as backend from "@/lib/backend";
import { useScopesWithCommandFallback } from "@/lib/node-scope/providers";
import { onResourceChanged, onResourceResync } from "@/lib/resource-sync";
import type { SettingSourcesLayers } from "@/lib/portal/command-node-config";
import type { SourceNames, SourcesState } from "@/lib/settings-catalog/provenance";
import type { SettingDescriptor } from "@/lib/settings-catalog/types";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

const log = createLogger("web.settings");

// --- Unsaved state of the shared form -------------------------------------------

export interface SettingsDraftSnapshot {
  /** Stored keys whose edited value has not been saved yet. */
  readonly dirtyKeys: readonly string[];
  readonly saving: boolean;
  readonly unconfirmedKeys?: readonly string[];
  /** A validation failure that holds every save back. */
  readonly blocker: { readonly section: string; readonly message: string } | null;
  /** The last save failed; the edited values are still in the form. */
  readonly errorMessage: string | null;
}

export const EMPTY_DRAFT: SettingsDraftSnapshot = Object.freeze({
  dirtyKeys: [],
  saving: false,
  blocker: null,
  errorMessage: null,
});

export function draftIsClean(draft: SettingsDraftSnapshot): boolean {
  return (
    draft.dirtyKeys.length === 0 && !draft.saving && !draft.blocker && draft.errorMessage === null
  );
}

/** The page's record of the form's unsaved state, and the form's retry. */
export class SettingsDraftRegistry {
  private snapshot: SettingsDraftSnapshot = EMPTY_DRAFT;
  private readonly listeners = new Set<() => void>();
  private discard: (() => void) | null = null;
  private retry: ((useSavedValues: boolean) => void) | null = null;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): SettingsDraftSnapshot => this.snapshot;

  report(next: SettingsDraftSnapshot): void {
    const current = this.snapshot;
    if (
      current.saving === next.saving &&
      current.unconfirmedKeys?.join("\0") === next.unconfirmedKeys?.join("\0") &&
      current.errorMessage === next.errorMessage &&
      current.blocker?.message === next.blocker?.message &&
      current.blocker?.section === next.blocker?.section &&
      current.dirtyKeys.join("\0") === next.dirtyKeys.join("\0")
    ) {
      return;
    }
    this.snapshot = next;
    for (const listener of Array.from(this.listeners)) listener();
  }

  /** The form registers how to retry its last failed save; `null` when it unmounts. */
  setRetry(retry: ((useSavedValues: boolean) => void) | null): void {
    this.retry = retry;
  }

  setDiscard(discard: (() => void) | null): void {
    this.discard = discard;
  }

  discardOnLeave(): void {
    this.discard?.();
  }

  retrySave(useSavedValues = false): boolean {
    if (!this.retry) return false;
    this.retry(useSavedValues);
    return true;
  }
}

const DraftRegistryContext = createContext<SettingsDraftRegistry | null>(null);

export function SettingsDraftProvider({
  registry,
  children,
}: {
  registry: SettingsDraftRegistry;
  children: ReactNode;
}) {
  return <DraftRegistryContext.Provider value={registry}>{children}</DraftRegistryContext.Provider>;
}

export function useSettingsDraftRegistry(): SettingsDraftRegistry | null {
  return useContext(DraftRegistryContext);
}

const NO_REGISTRY_SUBSCRIBE = () => () => undefined;
const NO_REGISTRY_SNAPSHOT = () => EMPTY_DRAFT;

export function useSettingsDraft(): SettingsDraftSnapshot {
  const registry = useContext(DraftRegistryContext);
  return useSyncExternalStore(
    registry?.subscribe ?? NO_REGISTRY_SUBSCRIBE,
    registry?.getSnapshot ?? NO_REGISTRY_SNAPSHOT,
  );
}

// --- Sources and names of the machine on screen -------------------------------------

export interface SettingsExplainValue {
  /** `null` while loading. */
  readonly sources: SourcesState;
  readonly refreshSources: () => void;
  readonly names: SourceNames;
  /** The machine the settings on screen belong to, as `useAccountMachine` names it. */
  readonly machine: string | null | undefined;
  /** Opens the reset preview for a setting. */
  readonly requestReset: (descriptor: SettingDescriptor) => void;
}

const ExplainContext = createContext<SettingsExplainValue | null>(null);

export function useSettingsExplain(): SettingsExplainValue | null {
  return useContext(ExplainContext);
}

const FAILED_SOURCES = (message: string): SettingSourcesLayers => ({
  commandNode: { status: "failed", message },
  node: null,
});

/**
 * Reads where the settings of `machine` come from, and again whenever the
 * config on screen changes (`configRevision`), so a save or reset made here or
 * in another window is reflected. A read that fails stays explicit.
 */
export function SettingsExplainProvider({
  machine,
  names,
  configRevision,
  ready = true,
  requestReset,
  children,
}: {
  machine: string | null | undefined;
  names: SourceNames;
  configRevision: unknown;
  ready?: boolean;
  requestReset: (descriptor: SettingDescriptor) => void;
  children: ReactNode;
}) {
  const { scope } = useScopesWithCommandFallback();
  const [loaded, setLoaded] = useState<{
    sources: SourcesState;
    revision: unknown;
    attempt: number;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const refreshSources = useCallback(() => setAttempt((value) => value + 1), []);

  // A write can change override intent while the effective config compares
  // equal (for example an optimistic sound switch settling, or a save at default).
  useEffect(() => {
    if (!ready) return;
    const stop = onResourceChanged("config", refreshSources, scope);
    const stopResync = onResourceResync(({ resources }) => {
      if (!resources || resources.has("config")) refreshSources();
    }, scope);
    return () => {
      stop();
      stopResync();
    };
  }, [ready, refreshSources, scope]);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    backend.getSettingSources(machine).then(
      (layers) => {
        if (!cancelled) setLoaded({ sources: layers, revision: configRevision, attempt });
      },
      (error: unknown) => {
        log.warn("sources.read-failed", { error: formatLogError(error) });
        if (!cancelled) {
          setLoaded({
            sources: FAILED_SOURCES(error instanceof Error ? error.message : String(error)),
            revision: configRevision,
            attempt,
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [machine, configRevision, attempt, ready]);
  const sources =
    ready && loaded?.revision === configRevision && loaded?.attempt === attempt
      ? loaded.sources
      : null;

  const value = useMemo(
    () => ({ sources, refreshSources, names, machine, requestReset }),
    [sources, refreshSources, names, machine, requestReset],
  );
  return <ExplainContext.Provider value={value}>{children}</ExplainContext.Provider>;
}
