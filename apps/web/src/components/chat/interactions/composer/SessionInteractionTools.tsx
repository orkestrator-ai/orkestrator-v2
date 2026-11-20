import { useState } from "react";
import { Layers, Mic, PanelsTopLeft, Video } from "lucide-react";
import type { RichAnchor } from "@orkestrator/protocol/rich-interactions";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { contextTrayKey, useContextTrayStore } from "@/stores/contextTrayStore";
import { ContextTrayPanel } from "./ContextTrayPanel";
import { DeliverablesPanel } from "./DeliverablesPanel";
import { DemonstrationRecorder } from "./DemonstrationRecorder";
import { PointAndTalk } from "./PointAndTalk";

type Panel = "tray" | "talk" | "deliverables" | "demo";

const TITLES: Record<Panel, { title: string; description: string }> = {
  tray: { title: "Context tray", description: "References for your next request. Nothing is sent until you send it." },
  talk: { title: "Point and talk", description: "Speak (or type) a request about what you are pointing at." },
  deliverables: { title: "Session deliverables", description: "Published outputs, comment threads and interactions waiting for you." },
  demo: { title: "Record a demonstration", description: "Show the agent a workflow in a preview, then review and send it." },
};

/**
 * The composer's entry points to the person-originated interactions: the
 * context tray (15), point-and-talk (19), the deliverables panel (13, with
 * comment threads, 6) and demonstrations (20). Each opens in a side sheet so
 * it survives transcript scrolling and virtualization; closing a sheet stops
 * nothing (a recording stops only on its own Stop).
 */
export function SessionInteractionTools({ environmentId, logicalSessionKey, disabled }: { environmentId: string; logicalSessionKey: string; disabled?: boolean }) {
  const [panel, setPanel] = useState<Panel | null>(null);
  const trayCount = useContextTrayStore((state) => state.trays.get(contextTrayKey(environmentId, logicalSessionKey))?.filter((item) => item.included).length ?? 0);
  const trayItems = useContextTrayStore((state) => state.trays.get(contextTrayKey(environmentId, logicalSessionKey)));
  const targets: RichAnchor[] = (trayItems ?? []).filter((item) => item.included).map((item) => ({ source: item.source, location: item.location ?? { kind: "whole" } }));
  const button = (id: Panel, label: string, icon: React.ReactNode, badge?: number) => (
    <Button
      key={id}
      type="button"
      size="icon"
      variant="ghost"
      className={cn("relative size-8", panel === id && "bg-elevated text-foreground")}
      aria-label={badge ? `${label} (${badge})` : label}
      title={label}
      disabled={disabled}
      onClick={() => setPanel(panel === id ? null : id)}
    >
      {icon}
      {badge ? <span className="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-primary-fill px-1 text-[10px] leading-4 text-primary-foreground">{badge}</span> : null}
    </Button>
  );
  return (
    <>
      <div className="flex items-center" data-testid="session-interaction-tools">
        {button("tray", "Context tray", <Layers className="size-4" />, trayCount)}
        {button("talk", "Point and talk", <Mic className="size-4" />)}
        {button("deliverables", "Session deliverables", <PanelsTopLeft className="size-4" />)}
        {button("demo", "Record a demonstration", <Video className="size-4" />)}
      </div>
      <Sheet open={panel !== null} onOpenChange={(open) => !open && setPanel(null)} modal={false}>
        <SheetContent className="w-full max-w-none overflow-y-auto px-4 py-4 sm:max-w-xl" onInteractOutside={(event) => event.preventDefault()}>
          {panel ? (
            <>
              <SheetTitle>{TITLES[panel].title}</SheetTitle>
              <SheetDescription>{TITLES[panel].description}</SheetDescription>
              <div className="mt-4">
                {panel === "tray" ? <ContextTrayPanel environmentId={environmentId} logicalSessionKey={logicalSessionKey} onSent={() => setPanel(null)} /> : null}
                {panel === "talk" ? <PointAndTalk environmentId={environmentId} logicalSessionKey={logicalSessionKey} targets={targets} onSent={() => setPanel(null)} /> : null}
                {panel === "deliverables" ? <DeliverablesPanel environmentId={environmentId} logicalSessionKey={logicalSessionKey} /> : null}
                {panel === "demo" ? <DemonstrationRecorder environmentId={environmentId} logicalSessionKey={logicalSessionKey} onSent={() => setPanel(null)} /> : null}
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  );
}
