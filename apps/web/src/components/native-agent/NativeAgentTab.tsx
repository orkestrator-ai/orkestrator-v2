import { lazy, memo, Suspense, useMemo } from "react";
import { getNativeAgentAdapter, type NativeAgentTabProps } from "./adapter";

const controllerCache = new Map<
  NativeAgentTabProps["data"]["platform"],
  ReturnType<typeof lazy>
>();

function controllerFor(platform: NativeAgentTabProps["data"]["platform"]) {
  const cached = controllerCache.get(platform);
  if (cached) return cached;
  const Controller = lazy(async () => ({
    default: await getNativeAgentAdapter(platform).loadController(),
  }));
  controllerCache.set(platform, Controller);
  return Controller;
}

/**
 * The only pane-level native agent tab. Provider controllers are selected by
 * the adapter registry and remain below this stable presentation boundary.
 */
export const NativeAgentTab = memo(function NativeAgentTab(
  props: NativeAgentTabProps,
) {
  const Controller = useMemo(
    () => controllerFor(props.data.platform),
    [props.data.platform],
  );
  return (
    <Suspense
      fallback={(
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          Connecting to {getNativeAgentAdapter(props.data.platform).label}…
        </div>
      )}
    >
      <Controller {...props} />
    </Suspense>
  );
});

