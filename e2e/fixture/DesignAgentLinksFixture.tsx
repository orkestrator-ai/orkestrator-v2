import { useEffect, useState, type ReactNode } from "react";
import type {
  DesignContextReference,
  DesignSessionLink,
  DesignWorkspaceMeta,
} from "@orkestrator/protocol/design-operations";
import { DesignAgentDialog } from "../../apps/web/src/components/design/DesignAgentDialog";
import {
  TerminalProvider,
  useTerminalContext,
  type CreatableTabType,
  type CreateTabOptions,
} from "../../apps/web/src/contexts/TerminalContext";
import { emptyProjection, type DesignProjection } from "../../apps/web/src/stores/designStore";
import { useEnvironmentStore } from "../../apps/web/src/stores/environmentStore";
import { usePaneLayoutStore } from "../../apps/web/src/stores/paneLayoutStore";
import { appCommandStore } from "../../apps/web/src/test/app-command-store";
import type { TabInfo } from "../../apps/web/src/types/paneLayout";

const ENVIRONMENT = "design-links-fixture";

/**
 * Closed design links in each state the backend can report (to-do 0038):
 * one that can be resumed, one whose conversation the agent archived, and one
 * that never started. The backend's answers are fixed here; the spec reads the
 * resume requests the dialog sends from `window.__designLinkRequests`.
 */
const LINKS: DesignSessionLink[] = [
  {
    id: "resumable",
    tabId: "closed-resumable",
    sessionId: "thread-live",
    platform: "codex",
    role: "design",
    label: "Hero layout",
    createdAt: "2026-11-11T09:00:00Z",
  },
  {
    id: "archived",
    tabId: "closed-archived",
    sessionId: "thread-archived",
    platform: "codex",
    role: "design",
    label: "Pricing copy",
    createdAt: "2026-11-11T09:10:00Z",
  },
  {
    id: "missing",
    tabId: "closed-missing",
    platform: "claude",
    role: "implementation",
    label: "Implement design",
    createdAt: "2026-11-11T09:20:00Z",
  },
];

const CONTEXT: DesignContextReference = {
  version: 1,
  canvasId: "canvas-links",
  canvasName: "Landing",
  environmentId: ENVIRONMENT,
  frameId: "frame-1",
  frameName: "Hero",
  canvasRevision: 7,
  frameRevision: 3,
  scope: "discuss",
};

const PROJECTION: DesignProjection = {
  ...emptyProjection("design-links", ENVIRONMENT, CONTEXT.canvasId),
  snapshot: "current",
  revision: 7,
  canvas: {
    format: "orkdes",
    version: 1,
    id: CONTEXT.canvasId,
    environmentId: ENVIRONMENT,
    name: "Landing",
    revision: 7,
    frames: [
      {
        id: "frame-1",
        name: "Hero",
        x: 0,
        y: 0,
        width: 1280,
        height: 800,
        html: "<h1>Hero</h1>",
        revision: 3,
      },
    ],
  },
  workspace: { sessions: LINKS } as unknown as DesignWorkspaceMeta,
};

type Requests = { resume: Array<Record<string, unknown>> };

export function installDesignAgentLinksFixture() {
  const requests: Requests = { resume: [] };
  (window as unknown as { __designLinkRequests: Requests }).__designLinkRequests = requests;
  const ok = <T,>(value: unknown) => ({ ok: true, value }) as T;
  window.orkestrator = {
    invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
      if (command === "design_session_link_states")
        return ok<T>({
          sessions: LINKS,
          states: [
            { linkId: "resumable", session: "missing" },
            { linkId: "archived", session: "missing", archived: true },
            { linkId: "missing", session: "missing" },
          ],
        });
      if (command === "design_session_resume") {
        requests.resume.push({ ...args });
        const link = LINKS.find((candidate) => candidate.id === args?.linkId)!;
        return ok<T>({
          link: { ...link, tabId: String(args?.tabId) },
          providerSessionId: `live-${link.id}`,
        });
      }
      throw new Error(`Unknown backend command: ${command}`);
    },
    listen: () => () => {},
  } as unknown as Window["orkestrator"];
}

function agentTab(id: string): TabInfo {
  return {
    id,
    type: "agent-native",
    nativeAgentData: { environmentId: ENVIRONMENT },
  } as TabInfo;
}

/** Opens a resumed conversation's tab in the fixture's one pane. */
function RegisterCreateTab({ children }: { children: ReactNode }) {
  const { setCreateTab } = useTerminalContext();
  useEffect(() => {
    setCreateTab((_type: CreatableTabType, options?: CreateTabOptions) => {
      appCommandStore(usePaneLayoutStore.def)
        .getState()
        .addTab("links-pane", agentTab(options!.tabId!), ENVIRONMENT);
      return true;
    });
    return () => setCreateTab(null);
  }, [setCreateTab]);
  return <>{children}</>;
}

export function DesignAgentLinksFixture() {
  const [open, setOpen] = useState(true);
  // The dialog re-renders from these stores once they are seeded.
  useEffect(() => {
    appCommandStore(useEnvironmentStore.def).setState({
      environments: [
        {
          id: ENVIRONMENT,
          environmentType: "local",
          status: "running",
          containerId: null,
          worktreePath: "/tmp/design-links-fixture",
        } as import("../../apps/web/src/types").Environment,
      ],
    });
    appCommandStore(usePaneLayoutStore.def).setState({
      activeEnvironmentId: ENVIRONMENT,
      hydration: new Map([[ENVIRONMENT, "done"]]),
      environments: new Map([
        [
          ENVIRONMENT,
          {
            root: { kind: "leaf", id: "links-pane", tabs: [], activeTabId: null },
            activePaneId: "links-pane",
          },
        ],
      ]),
    } as never);
  }, []);

  return (
    <main className="min-h-screen bg-background p-4 text-foreground">
      <TerminalProvider>
        <RegisterCreateTab>
          <button type="button" onClick={() => setOpen(true)}>
            Ask agent
          </button>
          <DesignAgentDialog
            context={open ? CONTEXT : null}
            projection={PROJECTION}
            onOpenChange={setOpen}
          />
        </RegisterCreateTab>
      </TerminalProvider>
    </main>
  );
}
