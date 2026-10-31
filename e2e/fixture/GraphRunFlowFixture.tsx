import { useLayoutEffect, useState } from "react";
import { GraphRunTab } from "../../apps/web/src/components/graph-run/GraphRunTab";
import { act, runOf } from "../../apps/web/src/components/graph-run/graph-run.test-fixtures";
import { useGraphRunStore } from "../../apps/web/src/stores/graphRunStore";

/** Real run view and renderer; only snapshot transport is replaced. */
export function GraphRunFlowFixture() {
  const [isActive, setIsActive] = useState(true);
  const [initialRun] = useState(() =>
    runOf("multi-review", {
      activations: [act({ nodeId: "plan" }, { state: "running" })],
    }),
  );
  useLayoutEffect(() => {
    const original = window.orkestrator;
    window.orkestrator = {
      invoke: async <T,>(command: string) => {
        if (command === "graph_run_get") {
          return {
            status: "changed",
            run: useGraphRunStore.getState().runs.get(initialRun.id)?.run ?? initialRun,
          } as T;
        }
        return undefined as T;
      },
      listen: () => () => undefined,
    } as unknown as Window["orkestrator"];
    return () => {
      window.orkestrator = original;
    };
  }, [initialRun]);
  return (
    <main className="flex h-screen flex-col bg-background text-foreground">
      <div className="shrink-0">
        <button onClick={() => setIsActive(!isActive)}>
          {isActive ? "Activate other pane" : "Activate graph pane"}
        </button>
        <button
          onClick={() =>
            useGraphRunStore.getState().applyRun({
              ...initialRun,
              revision: initialRun.revision + 1,
              activations: [
                act({ nodeId: "plan" }),
                act({ nodeId: "package" }),
                act({ nodeId: "review", branchKey: "panel.1" }),
                act({ nodeId: "review", branchKey: "panel.2" }),
                act({ nodeId: "consolidate" }, { state: "running" }),
              ],
            })
          }
        >
          Advance graph run
        </button>
      </div>
      <div hidden={!isActive} className="relative flex min-h-0 flex-1 flex-col">
        <GraphRunTab
          environmentId="env-1"
          data={{ runId: initialRun.id, title: "Multi Review" }}
          isActive={isActive}
        />
      </div>
    </main>
  );
}
