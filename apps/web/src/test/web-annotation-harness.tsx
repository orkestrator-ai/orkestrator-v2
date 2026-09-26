/**
 * Renders the real browser annotation controller, button, and panel against
 * the fakes in `web-annotation-fakes.ts`. Test-only.
 */
import { afterEach, beforeEach, mock, setDefaultTimeout } from "bun:test";
import { act, configure, getConfig } from "@testing-library/react";
import {
  AnnotatedPreviewArea,
  AnnotationsButton,
} from "@/components/browser/annotations/BrowserAnnotationsLayout";
import { currentPageForManualUrl } from "@/components/browser/annotations/format";
import { useBrowserAnnotations } from "@/components/browser/annotations/useBrowserAnnotations";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import type { BrowserAnnotationPanelState, TabInfo } from "@/types/paneLayout";

export const PAGE_URL = "http://localhost:5173/settings?tab=profile";

/** Per-test and per-wait headroom for the full panel harness (see flake 0161). */
export const ANNOTATION_UI_TEST_TIMEOUT_MS = 10_000;
export const ANNOTATION_UI_WAIT_TIMEOUT_MS = 2_000;

/**
 * Call at the top of a panel-harness test file. This is headroom, not a fix:
 * every harness interaction is a chain of fake backend promises and React
 * renders, and an aggregate run can starve them past Testing Library's 1 s
 * wait. Flake 0161's actual causes were a lost keystroke in
 * `useAnnotationDraft` and a ~30 s event-loop stall from Bun formatting a
 * failing `expect(node).toBe(otherNode)` (fixed in `tests/register-dom.ts`);
 * with both fixed the panel suites pass under heavy CPU load at the default
 * budgets. Keep this modest so a real stall still fails quickly. The wait
 * budget is scoped to each test and restored afterwards; the test budget is
 * file-scoped because `--parallel` isolates files.
 */
export function useAnnotationUiTestBudget() {
  setDefaultTimeout(ANNOTATION_UI_TEST_TIMEOUT_MS);
  let previous = getConfig().asyncUtilTimeout;
  beforeEach(() => {
    previous = getConfig().asyncUtilTimeout;
    configure({ asyncUtilTimeout: ANNOTATION_UI_WAIT_TIMEOUT_MS });
  });
  afterEach(() => {
    configure({ asyncUtilTimeout: previous });
  });
}

export function seedBrowserLayout(
  annotationPanel: BrowserAnnotationPanelState | undefined = { open: true },
  extraTabs: TabInfo[] = [],
  environmentId = "env-1",
) {
  usePaneLayoutStore.setState({
    activeEnvironmentId: environmentId,
    environments: new Map([
      [
        environmentId,
        {
          root: {
            kind: "leaf",
            id: "pane-1",
            tabs: [
              {
                id: "browser-1",
                type: "browser",
                browserData: { url: PAGE_URL, ...(annotationPanel ? { annotationPanel } : {}) },
              },
              ...extraTabs,
            ],
            activeTabId: "browser-1",
          },
          activePaneId: "pane-1",
          containerId: null,
        },
      ],
    ]),
  });
}

export function panelState(environmentId = "env-1"): BrowserAnnotationPanelState | undefined {
  const tab = usePaneLayoutStore
    .getState()
    .getAllTabs(environmentId)
    .find((candidate) => candidate.id === "browser-1");
  return tab?.browserData?.annotationPanel;
}

export const navigateToPageMock = mock(() => ({ ok: true }));

export function AnnotationHarness({
  environmentId = "env-1",
  isActive = true,
  previewAttached = true,
}: {
  environmentId?: string;
  isActive?: boolean;
  previewAttached?: boolean;
}) {
  const data = usePaneLayoutStore((state) =>
    state.environments.get(environmentId)?.root.kind === "leaf"
      ? (state.environments.get(environmentId)!.root as { tabs: TabInfo[] }).tabs.find(
          (tab) => tab.id === "browser-1",
        )?.browserData
      : undefined,
  ) ?? { url: PAGE_URL };
  const currentPage = currentPageForManualUrl(data.url);
  const annotations = useBrowserAnnotations({
    tabId: "browser-1",
    environmentId,
    isActive,
    data,
    currentPage,
    previewAttached,
    navigateToPage: navigateToPageMock,
  });
  return (
    <div className="@container/browser flex h-[800px] w-[1200px] flex-col">
      <AnnotationsButton annotations={annotations} />
      <AnnotatedPreviewArea annotations={annotations}>
        <div data-testid="preview-host" />
      </AnnotatedPreviewArea>
    </div>
  );
}

export async function flush(times = 8) {
  for (let index = 0; index < times; index++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}
