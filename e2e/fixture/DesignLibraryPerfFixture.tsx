import { useEffect } from "react";
import { DesignLaunchButton } from "../../apps/web/src/components/design/DesignLaunchButton";
import { useEnvironmentStore } from "../../apps/web/src/stores/environmentStore";
import { usePaneLayoutStore } from "../../apps/web/src/stores/paneLayoutStore";
import type { Environment } from "../../apps/web/src/types";

/**
 * The design workspace dialog (and its Saved designs library) against a real
 * design service, for `e2e/perf/design-canvas-perf.ts`. Every backend command
 * goes through `window.designInvoke`, which the harness binds to the hosted
 * command registry (`e2e/design-service-host.ts`).
 */
export function DesignLibraryPerfFixture() {
  useEffect(() => {
    window.orkestrator = {
      invoke: (command: string, args: unknown) =>
        (
          window as unknown as {
            designInvoke: (command: string, args: unknown) => Promise<unknown>;
          }
        ).designInvoke(command, args),
      listen: () => () => undefined,
    } as unknown as typeof window.orkestrator;
    useEnvironmentStore.setState({
      environments: [
        {
          id: "design-fixture",
          environmentType: "local",
          status: "running",
          containerId: null,
          worktreePath: "/tmp/design-fixture",
        } as Environment,
      ],
    });
    usePaneLayoutStore.setState((state) => ({
      hydration: new Map(state.hydration).set("design-fixture", "done"),
    }));
  }, []);
  return (
    <main className="min-h-screen bg-background p-4 text-foreground">
      <DesignLaunchButton
        environmentId="design-fixture"
        disabled={false}
        tabCount={0}
        createTab={() => true}
      />
    </main>
  );
}
