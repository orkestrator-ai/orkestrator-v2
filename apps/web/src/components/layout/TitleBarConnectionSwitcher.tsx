import { CommandNodeSwitcher } from "@/components/federation/CommandNodeMenu";
import { useFederation } from "@/components/federation/FederationProvider";
import { ServerConnectionSwitcher } from "@/components/sidebar/ServerConnectionSwitcher";
import { cn } from "@/lib/utils";

/**
 * The machine this client is connected to, left of the title bar's meters:
 * the command node and its switcher when federation is on, else the saved
 * server connection. A window with neither (a browser tab on a lone server)
 * shows nothing, and the slot collapses with its separator (`empty:hidden`).
 */
export function TitleBarConnectionSwitcher({ compact = false }: { compact?: boolean }) {
  const { enabled } = useFederation();
  return (
    <div
      data-testid="title-bar-connection"
      className={cn(
        "flex min-w-0 items-center empty:hidden",
        !compact &&
          "after:mx-2 after:h-3 after:w-px after:shrink-0 after:self-center after:bg-border/50 after:content-['']",
      )}
    >
      {enabled ? (
        <CommandNodeSwitcher compact={compact} />
      ) : (
        <ServerConnectionSwitcher compact={compact} />
      )}
    </div>
  );
}
