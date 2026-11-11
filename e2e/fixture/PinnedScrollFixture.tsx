import { useEffect } from "react";
import { MobileAppShellLayout } from "../../apps/web/src/components/layout/MobileAppShellLayout";
import { ResizablePanel, ResizablePanelGroup } from "../../apps/web/src/components/ui/resizable";
import { pinLayoutRootScroll, pinnedScroll } from "../../apps/web/src/lib/pinned-scroll";

/** Lines in the log box, enough to overflow it several times over. */
export const PINNED_SCROLL_LOG_LINES = 200;

/**
 * Content taller than the shell's `main`, so `scrollIntoView` and `focus()`
 * on its lower half scroll every `overflow: hidden` ancestor, as a container's
 * initialization log did. The log box is the one scroller that is meant to
 * move.
 */
function OverflowingContent() {
  return (
    <div className="flex flex-col" style={{ height: 2400 }} data-testid="pinned-content">
      <div
        data-testid="pinned-log"
        className="h-40 shrink-0 overflow-auto border border-border p-2 font-mono text-xs"
      >
        {Array.from({ length: PINNED_SCROLL_LOG_LINES }, (_, index) => (
          <div key={index} data-testid={`pinned-log-line-${index}`}>
            log line {index}
          </div>
        ))}
      </div>
      <div className="flex-1" />
      <input aria-label="Late input" className="h-8 shrink-0 border border-border" />
      <div data-testid="pinned-target" className="h-8 shrink-0">
        Bottom of the content
      </div>
    </div>
  );
}

/**
 * The window's layout roots as the app draws them: `html`, `body` and `#root`
 * from the real stylesheet, a pinned frame as `AppShell` draws it, and below it
 * either the real mobile shell or the desktop shell's real panel group and
 * pinned `main`. `?unpinned` skips the listener `App` installs, so the spec can
 * show the fixture reproduces the shift it guards against.
 */
export function PinnedScrollFixture() {
  const params = new URLSearchParams(window.location.search);
  const pinned = !params.has("unpinned");
  const mobile = params.get("layout") === "mobile";
  useEffect(() => (pinned ? pinLayoutRootScroll(document) : undefined), [pinned]);

  return (
    <div
      className="flex h-full w-full flex-col overflow-hidden bg-background text-foreground"
      data-testid="pinned-frame"
      {...pinnedScroll}
    >
      {mobile ? (
        <MobileAppShellLayout
          selectedProjectId="project-1"
          selectedEnvironmentId="environment-1"
          title="Pinned scroll"
          filesPanelOpen={false}
          centralPanelStyle={{}}
          actionBar={<button type="button">Action</button>}
          agentInfoButton={<button type="button" aria-label="Agent info" />}
          sidebar={<div>Projects</div>}
          filesPanel={<div>Files</div>}
          initialSidebarOpen={false}
          onTitleBarMouseDown={() => undefined}
        >
          <OverflowingContent />
        </MobileAppShellLayout>
      ) : (
        <>
          <div data-testid="pinned-title-bar" className="h-8 shrink-0 border-b border-border">
            Pinned scroll
          </div>
          <ResizablePanelGroup
            orientation="horizontal"
            className="min-h-0 flex-1"
            {...pinnedScroll}
          >
            <ResizablePanel defaultSize={100}>
              <div className="flex h-full flex-col">
                <main className="flex-1 overflow-hidden bg-background" {...pinnedScroll}>
                  <OverflowingContent />
                </main>
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        </>
      )}
    </div>
  );
}
