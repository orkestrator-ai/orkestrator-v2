import { lazy, Suspense, useEffect, useState, type ComponentProps, type ReactNode } from "react";
import type { LaunchPromptPending } from "./LaunchPromptPending";
import { loadAgentNativeTab } from "./LazyAgentNativeTab";

type LaunchPromptPendingComponent = typeof LaunchPromptPending;

let loadedView: LaunchPromptPendingComponent | undefined;
let loadingView: Promise<LaunchPromptPendingComponent> | undefined;

function loadLaunchPromptPending(): Promise<LaunchPromptPendingComponent> {
  loadingView ??= import("./LaunchPromptPending").then(
    (module) => (loadedView = module.LaunchPromptPending),
    (error: unknown) => {
      loadingView = undefined;
      throw error;
    },
  );
  return loadingView;
}

const SuspendingView = lazy(async () => ({ default: await loadLaunchPromptPending() }));

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
  useEffect(() => preloadLaunchViews(), []);
  const [Loaded] = useState(() => loadedView);
  if (Loaded) return <Loaded {...props} />;
  return (
    <Suspense fallback={fallback}>
      <SuspendingView {...props} />
    </Suspense>
  );
}
