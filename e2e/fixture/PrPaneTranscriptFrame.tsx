import { useLayoutEffect, type ReactNode } from "react";
import { FilesPanelPullRequests } from "../../apps/web/src/components/files-panel/FilesPanelPullRequests";
import { useFilesPanelStore } from "../../apps/web/src/stores/filesPanelStore";
import { useUIStore } from "../../apps/web/src/stores/uiStore";
import { usePaneLayoutStore } from "../../apps/web/src/stores/paneLayoutStore";

/** Real transcript and panel hosts; only the unavailable GitHub endpoint is fake. */
export function PrPaneTranscriptFrame({ children }: { children: ReactNode }) {
  const isOpen = useFilesPanelStore((state) => state.isOpen);
  useLayoutEffect(() => {
    useUIStore.setState({ selectedEnvironmentId: "transcript-env" });
    const layout = usePaneLayoutStore.getState();
    layout.initialize(null, "transcript-env");
    const owner = usePaneLayoutStore.getState().environments.get("transcript-env")!;
    layout.addTab(
      owner.activePaneId,
      { id: "conversation", type: "plain", displayTitle: "Conversation" },
      "transcript-env",
    );
    window.orkestrator = {
      invoke: async (command: string) => {
        if (command === "open_in_browser") return;
        throw new Error("Fixture repository unavailable");
      },
      listen: () => () => undefined,
    } as unknown as Window["orkestrator"];
    window.prPaneSelection = () => ({
      environment: useUIStore.getState().selectedEnvironmentId,
      tab: usePaneLayoutStore.getState().findPaneWithTab("conversation", "transcript-env")
        ?.activeTabId,
    });
  }, []);
  return (
    <div style={{ display: "flex", width: "100%" }}>
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
      {isOpen && (
        <aside
          style={{
            position: "fixed",
            right: 0,
            top: 0,
            width: 360,
            height: 800,
            zIndex: 10,
            background: "#18181b",
          }}
        >
          <button onClick={() => useFilesPanelStore.setState({ isOpen: false })}>
            Close PR pane
          </button>
          <FilesPanelPullRequests targetId="transcript-env" />
        </aside>
      )}
    </div>
  );
}

declare global {
  interface Window {
    prPaneSelection?: () => { environment: string | null; tab: string | null | undefined };
  }
}
