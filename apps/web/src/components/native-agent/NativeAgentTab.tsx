import { lazy, memo, Suspense, useMemo } from "react";
import {
  findNativeAgentAdapter,
  type NativeAgentAdapter,
  type NativeAgentTabProps,
} from "./adapter";

const controllerCache = new Map<
  NativeAgentTabProps["data"]["platform"],
  ReturnType<typeof lazy>
>();

function controllerFor(adapter: NativeAgentAdapter) {
  const cached = controllerCache.get(adapter.platform);
  if (cached) return cached;
  const Controller = lazy(async () => ({
    default: await adapter.loadController(),
  }));
  controllerCache.set(adapter.platform, Controller);
  return Controller;
}

/**
 * The only pane-level native agent tab. Provider controllers are selected by
 * the adapter registry and remain below this stable presentation boundary.
 */
export const NativeAgentTab = memo(function NativeAgentTab(
  props: NativeAgentTabProps,
) {
  const adapter = useMemo(
    () => findNativeAgentAdapter(props.data.platform),
    [props.data.platform],
  );
  const Controller = useMemo(
    () => (adapter ? controllerFor(adapter) : null),
    [adapter],
  );

  // A tab whose platform has no adapter is a data problem, not a crash. Render
  // the mismatch instead of throwing out of the pane and taking its siblings
  // down with it.
  if (!adapter || !Controller) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-sm text-muted-foreground">
        This tab refers to an unsupported agent, so it cannot be opened.
      </div>
    );
  }

  return (
    <Suspense
      fallback={(
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          Connecting to {adapter.label}…
        </div>
      )}
    >
      <Controller {...props} />
    </Suspense>
  );
});
