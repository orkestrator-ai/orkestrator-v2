import { useState } from "react";
import { PanelsTopLeft, Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { DeliverablesPanel } from "./DeliverablesPanel";
import { DemonstrationRecorder } from "./DemonstrationRecorder";

type Panel = "deliverables" | "demo";

const TITLES: Record<Panel, { title: string; description: string }> = {
  deliverables: {
    title: "Session deliverables",
    description: "Published outputs, comment threads and interactions waiting for you.",
  },
  demo: {
    title: "Record a demonstration",
    description: "Show the agent a workflow in a preview, then review and send it.",
  },
};

/**
 * The composer's entry points to the person-originated interactions: the
 * deliverables panel (13, with comment threads, 6) and demonstrations (20).
 * Each opens in a side sheet so it survives transcript scrolling and
 * virtualization; closing a sheet stops nothing (a recording stops only on
 * its own Stop).
 */
export function SessionInteractionTools({
  environmentId,
  logicalSessionKey,
  disabled,
}: {
  environmentId: string;
  logicalSessionKey: string;
  disabled?: boolean;
}) {
  const [panel, setPanel] = useState<Panel | null>(null);
  const button = (id: Panel, label: string, icon: React.ReactNode) => (
    <Button
      key={id}
      type="button"
      size="icon"
      variant="ghost"
      className={cn("relative size-8", panel === id && "bg-elevated text-foreground")}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => setPanel(panel === id ? null : id)}
    >
      {icon}
    </Button>
  );
  return (
    <>
      <div className="flex items-center" data-testid="session-interaction-tools">
        {button("deliverables", "Session deliverables", <PanelsTopLeft className="size-4" />)}
        {button("demo", "Record a demonstration", <Video className="size-4" />)}
      </div>
      <Sheet open={panel !== null} onOpenChange={(open) => !open && setPanel(null)} modal={false}>
        <SheetContent
          className="w-full max-w-none overflow-y-auto px-4 py-4 sm:max-w-xl"
          onInteractOutside={(event) => event.preventDefault()}
        >
          {panel ? (
            <>
              <SheetTitle>{TITLES[panel].title}</SheetTitle>
              <SheetDescription>{TITLES[panel].description}</SheetDescription>
              <div className="mt-4">
                {panel === "deliverables" ? (
                  <DeliverablesPanel
                    environmentId={environmentId}
                    logicalSessionKey={logicalSessionKey}
                  />
                ) : null}
                {panel === "demo" ? (
                  <DemonstrationRecorder
                    environmentId={environmentId}
                    logicalSessionKey={logicalSessionKey}
                    onSent={() => setPanel(null)}
                  />
                ) : null}
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  );
}
