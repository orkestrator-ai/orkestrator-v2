import { useState } from "react";
import { DesignCanvasTab } from "../../apps/web/src/components/design/DesignCanvasTab";

export function DesignCanvasFixture() {
  const [active, setActive] = useState(true);
  const canvasId = new URLSearchParams(window.location.search).get("canvasId")!;
  window.orkestrator = {
    invoke: (command: string, args: unknown) =>
      (
        window as unknown as { designInvoke: (command: string, args: unknown) => Promise<unknown> }
      ).designInvoke(command, args),
    listen: (event: string, handler: (payload: unknown) => void) => {
      const eventName = `orkestrator-fixture:${event}`;
      const listener = (value: Event) => handler((value as CustomEvent).detail);
      window.addEventListener(eventName, listener);
      return () => window.removeEventListener(eventName, listener);
    },
  } as unknown as typeof window.orkestrator;
  return (
    <div className="h-screen bg-background text-foreground">
      <button onClick={() => setActive((value) => !value)}>Switch tab</button>
      <div className="absolute inset-x-0 bottom-0 top-8">
        <DesignCanvasTab
          canvasId={canvasId}
          environmentId="design-fixture"
          isActive={active}
          ownsGlobalShortcuts={active}
        />
      </div>
    </div>
  );
}
