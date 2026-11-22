import { useEffect, useState, type ComponentProps, type ReactNode } from "react";
import { LazyLoadBoundary } from "@/components/LazyLoadBoundary";
import type { LaunchPromptPending } from "./LaunchPromptPending";
import { loadAgentNativeTab } from "./LazyAgentNativeTab";
import { importLaunchPromptPending } from "./launch-view-imports";

type LaunchPromptPendingComponent = typeof LaunchPromptPending;

let loadedView: LaunchPromptPendingComponent | undefined;
let loadingView: Promise<LaunchPromptPendingComponent> | undefined;

function loadLaunchPromptPending(): Promise<LaunchPromptPendingComponent> {
  loadingView ??= importLaunchPromptPending()
    .then((view) => (loadedView = view))
    .catch((error: unknown) => {
      loadingView = undefined;
      throw error;
    });
  return loadingView;
}

/**
 * Fetch the views a new environment's launch shows, ahead of the launch.
 *
 * Called while the create dialog is open: the person is still typing, so both
 * chunks are in hand before the environment exists and neither view has to
 * stand in a loading skeleton between the click and the prompt.
 */
export function preloadLaunchViews(): void {
  void loadLaunchPromptPending().catch(() => undefined);
  void loadAgentNativeTab().catch(() => undefined);
}

/**
 * A new environment's opening prompt before its agent tab exists, loaded on
 * demand: it renders a transcript message, which must stay out of the startup
 * bundle (see `LazyAgentNativeTab`). Mounting it also fetches the agent tab, so
 * the tab that replaces this view is ready when the backend publishes it rather
 * than showing a loading skeleton first. Once preloaded it renders directly,
 * without a first suspended render (see `LazyAgentNativeTab` for why).
 */
export function LazyLaunchPromptPending({
  fallback,
  ...props
}: ComponentProps<LaunchPromptPendingComponent> & { fallback: ReactNode }) {
  const [Loaded, setLoaded] = useState(() => loadedView);
  useEffect(() => {
    void loadAgentNativeTab().catch(() => undefined);
    if (Loaded) return;
    let mounted = true;
    void loadLaunchPromptPending().then(
      (view) => {
        if (mounted) setLoaded(() => view);
      },
      // The creation progress or logs remain usable if this optional view
      // cannot load. A subsequent mount can request the chunk again.
      () => undefined,
    );
    return () => {
      mounted = false;
    };
  }, [Loaded]);
  if (!Loaded) return fallback;
  return (
    <LazyLoadBoundary loadingFallback={fallback} renderError={() => fallback}>
      <Loaded {...props} />
    </LazyLoadBoundary>
  );
}
