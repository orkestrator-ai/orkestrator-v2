import { CompactRepositoryList } from "@/components/sidebar/CompactRepositoryList";
import { FederationProvider } from "@/components/federation/FederationProvider";
import type { Project } from "@/types";
import { useEffect, useState } from "react";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { useSidebarPanelMotion } from "@/components/layout/useSidebarPanelMotion";
import { sidebarPanelConstraints, type SidebarPanelMode } from "@/lib/sidebar-width";
import { useUIStore } from "@/stores/uiStore";
import { useUIChromeStore } from "@/stores/uiChromeStore";

/** Real panels with the shell's pinning and constraints, without backend dependencies. */
export function SidebarMotionFixture() {
  const [mode, setMode] = useState<SidebarPanelMode>("full");
  const [sidebar, setSidebar] = useState<HTMLDivElement | null>(null);
  const [main, setMain] = useState<HTMLDivElement | null>(null);
  const [reduced, setReduced] = useState(false);
  const selected = useUIStore((state) => state.selectedProjectId);
  const [resizes, setResizes] = useState(0);
  const motion = useSidebarPanelMotion({
    mode,
    reducedMotion: reduced,
    sidebarElement: sidebar,
    mainElement: main,
  });
  useEffect(() => {
    useUIChromeStore.setState({ sidebarWidth: 344 });
    const onResize = () => setResizes((value) => value + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <div>
        {(["full", "compact", "hidden"] as const).map((value) => (
          <button className="m-2 border p-2" key={value} onClick={() => setMode(value)}>
            {value}
          </button>
        ))}
        <button onClick={() => setReduced(!reduced)}>Reduced motion: {String(reduced)}</button>
        <output data-testid="resizes">{resizes}</output>
        <output data-testid="selected">{selected}</output>
      </div>
      <ResizablePanelGroup
        orientation="horizontal"
        className="flex-1"
        data-sidebar-width-animating={motion.animating || undefined}
        onPointerDownCapture={(event) => {
          if ((event.target as Element).closest("[data-separator]")) motion.settleNow();
        }}
      >
        <ResizablePanel
          defaultSize={
            new URLSearchParams(window.location.search).has("shellDefault") ? 28 : "344px"
          }
          {...sidebarPanelConstraints(mode)}
          panelRef={motion.panelRef}
          elementRef={setSidebar}
        >
          <div
            data-testid="sidebar-content"
            className="h-full bg-sidebar p-2"
            style={motion.pins ? { width: motion.pins.sidebar } : undefined}
          >
            {mode === "compact" ? (
              <FederationProvider>
                <CompactRepositoryList
                  machines={[]}
                  localProjects={[{ id: "fixture", name: "Example repository" } as Project]}
                  environments={[]}
                  loading={false}
                  onAddProject={() => {}}
                />
              </FederationProvider>
            ) : (
              "Repositories"
            )}
          </div>
        </ResizablePanel>
        {/* As in the shell: hidden unmounts it, and remounting it re-lays out the group. */}
        {motion.contentShown ? <ResizableHandle disabled={mode !== "full"} /> : null}
        <ResizablePanel minSize="0px">
          <div
            ref={setMain}
            data-testid="main-content"
            className="h-full bg-muted p-4"
            style={motion.pins ? { width: motion.pins.main } : undefined}
          >
            Workspace
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
