import { useEffect, useRef, useState } from "react";
import type { TabInfo } from "@/types/paneLayout";
import { AgentInfoButton, AgentInfoTrigger } from "@/components/layout/AgentInfoButton";
import {
  SYSTEM_USAGE_POLL_INTERVAL_MS,
  SystemUsageIndicator,
  SystemUsageMeters,
} from "@/components/layout/SystemUsageIndicator";
import { SYSTEM_USAGE_STALE_AFTER_MS, useSystemUsage } from "@/hooks/useSystemUsage";
import {
  onShellMessage,
  postToShell,
  type RealmPanel,
  type RealmPanelRequest,
} from "@/lib/federation/workspace-realm";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";

/**
 * The title bar of a window showing another node's workspace looks as it does
 * for its own node: the host meters and the agent-information button sit at
 * its top right. Their readings and popovers belong to the other node, so the
 * realm reports the readings, and draws a popover under the title bar when
 * the window's trigger asks for it.
 */

/** Where a popover sits before the title bar has said: the title bar's own right gutter. */
const DEFAULT_PANEL_INSET = 6;

/** Marks the window's triggers, so pressing one toggles its popover rather than dismissing it. */
const TRIGGER_ATTRIBUTE = "data-realm-panel-trigger";

const OTHER_PANEL: Record<RealmPanel, RealmPanel> = { usage: "agent", agent: "usage" };

/**
 * Realm side: the node's host meters for the window's title bar, and the
 * popovers it opens, placed under that title bar's triggers.
 */
export function RealmTitleBarPanels({ activeTab }: { activeTab: TabInfo | null }) {
  // The same coordinated read the popover's own meters join.
  const usageView = useSystemUsage({ intervalMs: SYSTEM_USAGE_POLL_INTERVAL_MS });
  const [requests, setRequests] = useState<Partial<Record<RealmPanel, RealmPanelRequest>>>({});
  const [openPanel, setOpenPanel] = useState<RealmPanel | null>(null);
  const nextSeq = useRef(1);

  useEffect(
    () =>
      onShellMessage((message) => {
        if (message.type !== "panel") return;
        const seq = nextSeq.current;
        nextSeq.current += 2;
        const other = OTHER_PANEL[message.panel];
        setRequests((current) => ({
          ...current,
          // A closing popover stays where it opened while it fades.
          [message.panel]: {
            seq,
            open: message.open,
            inset: message.open
              ? message.inset
              : (current[message.panel]?.inset ?? DEFAULT_PANEL_INSET),
          },
          // One popover at a time, as in the window's own title bar.
          ...(message.open
            ? {
                [other]: {
                  seq: seq + 1,
                  open: false,
                  inset: current[other]?.inset ?? DEFAULT_PANEL_INSET,
                },
              }
            : {}),
        }));
      }),
    [],
  );

  const usage = usageView.sample;
  const usageStale = usageView.stale;
  useEffect(() => {
    postToShell({ type: "titleBar", usage, usageStale, panel: openPanel });
  }, [openPanel, usage, usageStale]);

  const control = (panel: RealmPanel) => ({
    request: requests[panel] ?? null,
    onOpenChange: (open: boolean) =>
      setOpenPanel((current) => (open ? panel : current === panel ? null : current)),
  });

  return (
    <>
      <div
        className="fixed top-0 z-50"
        style={{ right: requests.usage?.inset ?? DEFAULT_PANEL_INSET }}
      >
        <SystemUsageIndicator remote={control("usage")} />
      </div>
      <div
        className="fixed top-0 z-50"
        style={{ right: requests.agent?.inset ?? DEFAULT_PANEL_INSET }}
      >
        <AgentInfoButton activeTab={activeTab} remote={control("agent")} />
      </div>
    </>
  );
}

/** Window side: what the shown realm last reported, read as stale once it goes quiet. */
function useRealmTitleBar(nodeId: string) {
  const titleBar = useRemoteWorkspaceStore((state) => state.titleBars[nodeId] ?? null);
  const receivedAt = titleBar?.receivedAt ?? null;
  const [quietAfter, setQuietAfter] = useState<number | null>(null);
  useEffect(() => {
    if (receivedAt === null) return;
    const timer = setTimeout(
      () => setQuietAfter(receivedAt),
      Math.max(0, receivedAt + SYSTEM_USAGE_STALE_AFTER_MS - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [receivedAt]);
  return { titleBar, quiet: receivedAt !== null && quietAfter === receivedAt };
}

function toggleRealmPanel(
  nodeId: string,
  panel: RealmPanel,
  open: boolean,
  trigger: HTMLElement | null,
  region: HTMLElement | null,
) {
  const inset =
    trigger && region
      ? Math.max(0, region.getBoundingClientRect().right - trigger.getBoundingClientRect().right)
      : DEFAULT_PANEL_INSET;
  useRemoteWorkspaceStore.getState().requestRealmPanel(nodeId, panel, open, inset);
}

/** Window side: the shown realm's host meters, in the title bar's own place for them. */
export function RealmSystemUsageMeters({
  nodeId,
  region,
}: {
  nodeId: string;
  region: HTMLElement | null;
}) {
  const { titleBar, quiet } = useRealmTitleBar(nodeId);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const open = titleBar?.panel === "usage";
  return (
    <div
      className="relative flex items-center"
      data-testid="realm-system-usage-meters"
      {...{ [TRIGGER_ATTRIBUTE]: "usage" }}
    >
      <SystemUsageMeters
        triggerRef={triggerRef}
        usage={titleBar?.usage ?? null}
        stale={quiet || titleBar?.usageStale === true}
        open={open}
        onToggle={() => toggleRealmPanel(nodeId, "usage", !open, triggerRef.current, region)}
      />
    </div>
  );
}

/** Window side: the shown realm's agent-information trigger. */
export function RealmAgentInfoTrigger({
  nodeId,
  region,
}: {
  nodeId: string;
  region: HTMLElement | null;
}) {
  const { titleBar } = useRealmTitleBar(nodeId);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const open = titleBar?.panel === "agent";
  return (
    <div className="relative h-8 w-8" {...{ [TRIGGER_ATTRIBUTE]: "agent" }}>
      <AgentInfoTrigger
        ref={triggerRef}
        open={open}
        onClick={() => toggleRealmPanel(nodeId, "agent", !open, triggerRef.current, region)}
      />
    </div>
  );
}

/**
 * Window side: a realm's popover closes as the window's own would — on
 * Escape, or a press anywhere else in the window — and when its realm stops
 * being shown. Presses inside the realm are its own to handle.
 */
export function useRealmPanelDismiss(nodeId: string | null): void {
  const panel = useRemoteWorkspaceStore((state) =>
    nodeId ? (state.titleBars[nodeId]?.panel ?? null) : null,
  );

  useEffect(() => {
    if (!nodeId || !panel) return;
    const close = () =>
      useRemoteWorkspaceStore
        .getState()
        .requestRealmPanel(nodeId, panel, false, DEFAULT_PANEL_INSET);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      close();
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest(`[${TRIGGER_ATTRIBUTE}]`)) {
        return;
      }
      close();
    };
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    document.addEventListener("pointerdown", handlePointerDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
      document.removeEventListener("pointerdown", handlePointerDown, { capture: true });
    };
  }, [nodeId, panel]);

  useEffect(() => {
    if (!nodeId) return;
    return () => {
      const open = useRemoteWorkspaceStore.getState().titleBars[nodeId]?.panel;
      if (open) {
        useRemoteWorkspaceStore
          .getState()
          .requestRealmPanel(nodeId, open, false, DEFAULT_PANEL_INSET);
      }
    };
  }, [nodeId]);
}
