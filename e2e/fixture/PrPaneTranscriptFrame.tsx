import { Toaster } from "../../apps/web/src/components/ui/sonner";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "../../apps/web/src/components/ui/resizable";
import { fixtureDetail } from "./pr-pane-detail";
import { useLayoutEffect, type ReactNode } from "react";
import { FilesPanelPullRequests } from "../../apps/web/src/components/files-panel/FilesPanelPullRequests";
import { useFilesPanelChromeStore } from "../../apps/web/src/stores/filesPanelChromeStore";
import { useUIStore } from "../../apps/web/src/stores/uiStore";
import { usePaneLayoutStore } from "../../apps/web/src/stores/paneLayoutStore";
import { appCommandStore } from "../../apps/web/src/test/app-command-store";

/** Real transcript and panel hosts; only the unavailable GitHub endpoint is fake. */
export function PrPaneTranscriptFrame({ children }: { children: ReactNode }) {
  const isOpen = useFilesPanelChromeStore((state) => state.isOpen);
  useLayoutEffect(() => {
    appCommandStore(useUIStore.def).setState({ selectedEnvironmentId: "transcript-env" });
    const layout = appCommandStore(usePaneLayoutStore.def).getState();
    layout.initialize(null, "transcript-env");
    const owner = appCommandStore(usePaneLayoutStore.def)
      .getState()
      .environments.get("transcript-env")!;
    layout.addTab(
      owner.activePaneId,
      { id: "conversation", type: "plain", displayTitle: "Conversation" },
      "transcript-env",
    );
    window.orkestrator = {
      invoke: async (command: string) => {
        if (command === "open_in_browser") {
          window.open("https://github.com/acme/widget/pull/42", "_blank");
          return;
        }
        if (command === "get_github_pull_request") {
          if (new URLSearchParams(location.search).has("delayedFailure")) {
            await new Promise((resolve) => setTimeout(resolve, 6000));
            throw new Error("Repository unavailable");
          }
          return fixtureDetail;
        }
        throw new Error("Fixture repository unavailable");
      },
      listen: () => () => undefined,
    } as unknown as Window["orkestrator"];
    window.prPaneSelection = () => ({
      environment: appCommandStore(useUIStore.def).getState().selectedEnvironmentId,
      tab: appCommandStore(usePaneLayoutStore.def)
        .getState()
        .findPaneWithTab("conversation", "transcript-env")?.activeTabId,
    });
  }, []);
  return (
    <>
      <Toaster />
      <ResizablePanelGroup orientation="horizontal" style={{ height: 860 }}>
        <ResizablePanel defaultSize={isOpen ? 70 : 100} minSize={30}>
          {children}
        </ResizablePanel>
        {isOpen && (
          <>
            <ResizableHandle />
            <ResizablePanel defaultSize={30} minSize={20}>
              <button onClick={() => useFilesPanelChromeStore.setState({ isOpen: false })}>
                Close PR pane
              </button>
              <FilesPanelPullRequests targetId="transcript-env" />
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
    </>
  );
}

declare global {
  interface Window {
    prPaneSelection?: () => { environment: string | null; tab: string | null | undefined };
  }
}
