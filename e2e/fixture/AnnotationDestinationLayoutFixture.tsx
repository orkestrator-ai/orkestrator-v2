import { useLayoutEffect } from "react";
import {
  WEB_ANNOTATION_COMMANDS,
  WEB_ANNOTATION_LIMITS,
  type WebAnnotationDestinationOption,
} from "@orkestrator/protocol/web-annotations";
import { RequestComposer } from "../../apps/web/src/components/browser/annotations/RequestComposer";
import {
  AnnotationPanelContext,
  type AnnotationPanelContextValue,
} from "../../apps/web/src/components/browser/annotations/panel-context";
import { NO_WEB_ANNOTATION_FEATURES } from "../../apps/web/src/lib/web-annotations/client";

const options: WebAnnotationDestinationOption[] = [
  "Agent",
  "Investigate annotation destination layout and improve narrow sidebar readability ".repeat(3),
  "destination_".repeat(20),
  `https://example.com/${"a".repeat(180)}`,
  `/workspace/${"nested_directory/".repeat(15)}`,
].map((title, index) => ({
  destination: {
    environmentId: "layout-env",
    tabId: `agent-${index}`,
    logicalSessionKey: `layout-session-${index}`,
    agent: "codex",
  },
  title: title.slice(0, WEB_ANNOTATION_LIMITS.titleChars),
  model: null,
  activity: "idle",
  images: true,
  planMode: false,
  resultTools: true,
  holds: [],
  isDefault: index === 0,
}));

const context: AnnotationPanelContextValue = {
  environmentId: "layout-env",
  tabId: "browser-layout",
  features: { ...NO_WEB_ANNOTATION_FEATURES, dispatch: true },
  get capture(): AnnotationPanelContextValue["capture"] {
    throw new Error("The request composer must not use desktop capture");
  },
  captureMode: "element",
  setCaptureMode: () => {},
  supportedModes: [],
  currentPage: null,
  announce: () => {},
  selectAnnotation: () => {},
  navigateToPage: () => ({ ok: true }),
  showOnPage: async () => ({ status: "unavailable", reason: "Layout fixture" }),
  pinResults: new Map(),
};

export function AnnotationDestinationLayoutFixture() {
  useLayoutEffect(() => {
    const previous = window.orkestrator;
    window.orkestrator = {
      invoke: async <T,>(command: string) => {
        if (command === WEB_ANNOTATION_COMMANDS.destinations) return { options } as T;
        throw new Error(`Unexpected annotation layout command: ${command}`);
      },
    } as Window["orkestrator"];
    return () => {
      window.orkestrator = previous;
    };
  }, []);

  return (
    <main className="bg-background text-foreground">
      <aside aria-label="Page annotations" style={{ width: 280 }}>
        <AnnotationPanelContext.Provider value={context}>
          <RequestComposer items={[]} onClose={() => {}} onSent={() => {}} />
        </AnnotationPanelContext.Provider>
      </aside>
    </main>
  );
}
