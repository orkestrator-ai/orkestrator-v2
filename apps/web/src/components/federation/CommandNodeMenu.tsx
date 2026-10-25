import { useEffect, useState } from "react";
import { ArrowLeftRight, Check, Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { NodeListResult } from "@orkestrator/protocol/command-nodes";
import type { ConnectionList } from "@orkestrator/protocol/connections";
import type { BackendId } from "@orkestrator/protocol/federation";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { requestCommandHandover } from "@/lib/command-handover";
import { subscribeToConnections } from "@/lib/connections";
import { portalInvoke } from "@/lib/portal/portal-transport";
import { requestGlobalSettings } from "@/lib/settings-navigation";
import { MachineDot } from "./MachineDot";
import { useCommandNode, type CommandNodeIdentity } from "./useCommandNode";

type ConnectionsApi = NonNullable<NonNullable<Window["orkestrator"]>["connections"]>;

function connectionsApi(): ConnectionsApi | null {
  return window.orkestrator?.connections ?? null;
}

/** A machine this client can use as its command node instead. */
interface SwitchTarget {
  id: string;
  name: string;
  address: string | null;
  current: boolean;
  requiresToken: boolean;
  nodeId?: BackendId;
}

/**
 * The desktop's and iOS's saved targets, one per machine: a machine saved
 * twice (say Local and its Tailscale address) is listed once, by the
 * connection the window uses, else the first that needs no token.
 */
export function targetsFromConnections(list: ConnectionList): SwitchTarget[] {
  const byMachine = new Map<string, ConnectionList["connections"][number]>();
  for (const connection of list.connections) {
    const key = connection.backendId ?? `connection:${connection.id}`;
    const existing = byMachine.get(key);
    if (
      !existing ||
      connection.active ||
      (!existing.active && existing.requiresToken && !connection.requiresToken)
    ) {
      byMachine.set(key, connection);
    }
  }
  return [...byMachine.values()].map((connection) => ({
    id: connection.id,
    name: connection.nickname?.trim() || connection.profile?.displayName || connection.name,
    address: connection.kind === "local" ? "This device" : connection.address,
    current: connection.active,
    requiresToken: connection.requiresToken,
    ...(connection.backendId ? { nodeId: connection.backendId } : {}),
  }));
}

/**
 * A browser tab is served by its command node, so another command node is
 * another address: the machines this one controls that have a web address.
 */
function targetsFromNodes(
  commandNode: CommandNodeIdentity,
  nodes: NodeListResult["nodes"],
): SwitchTarget[] {
  const others = nodes.flatMap((node) => {
    const route = node.routes.find((entry) => entry.kind === "https" && entry.enabled);
    return route?.kind === "https"
      ? [
          {
            id: node.nodeId,
            name: node.displayName,
            address: route.origin,
            current: false,
            requiresToken: false,
            nodeId: node.nodeId,
          },
        ]
      : [];
  });
  return [
    {
      id: commandNode.nodeId ?? "current",
      name: commandNode.name,
      address: window.location.origin,
      current: true,
      requiresToken: false,
    },
    ...others,
  ];
}

/**
 * The machines menu's command-node section: a heading, the machine this
 * client is connected to, and a switch to another. Switching makes the other
 * machine the command node: it takes over this one's machines (the user
 * chooses which in `CommandHandoverDialog`) and the window follows it.
 * Opening an environment on another machine never changes the command node.
 */
export function CommandNodeMenuSection() {
  const commandNode = useCommandNode();
  const api = connectionsApi();
  const [connections, setConnections] = useState<ConnectionList | null>(null);
  const [nodes, setNodes] = useState<NodeListResult["nodes"] | null>(null);

  useEffect(() => {
    let active = true;
    if (api) {
      void api
        .list()
        .then((list) => {
          if (active) setConnections(list);
        })
        .catch(() => undefined);
      const stop = subscribeToConnections(setConnections);
      return () => {
        active = false;
        stop();
      };
    }
    void portalInvoke<NodeListResult>("list_nodes")
      .then((list) => {
        if (active) setNodes(list.nodes);
      })
      .catch(() => {
        if (active) setNodes([]);
      });
    return () => {
      active = false;
    };
  }, [api]);

  if (!commandNode) return null;
  const targets = api
    ? connections && targetsFromConnections(connections)
    : nodes && targetsFromNodes(commandNode, nodes);

  const switchTo = (target: SwitchTarget) => {
    if (target.current) return;
    if (target.requiresToken) {
      toast.info(`Enter ${target.name}'s token first`, {
        description: "Its token is not saved on this device.",
      });
      requestGlobalSettings("machines");
      return;
    }
    requestCommandHandover(
      api
        ? { name: target.name, connectionId: target.id }
        : {
            name: target.name,
            ...(target.nodeId ? { nodeId: target.nodeId } : {}),
            address: target.address,
          },
    );
  };

  return (
    <>
      <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
        Command node
      </DropdownMenuLabel>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger
          data-testid="command-node-row"
          aria-label={`Command node: ${commandNode.name}. Switch command node`}
          title="Switch command node"
          indicator={
            <ArrowLeftRight
              className="ml-auto size-3.5 text-muted-foreground"
              aria-hidden="true"
              data-testid="command-node-switch"
            />
          }
        >
          <MachineDot colorToken={commandNode.colorToken} machineName={commandNode.name} />
          <span className="min-w-0 flex-1 truncate" data-testid="command-node-name">
            {commandNode.name}
          </span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="w-64" data-testid="command-node-switcher">
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
            Switch command node
          </DropdownMenuLabel>
          {targets === null ? (
            <div className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading…
            </div>
          ) : (
            targets.map((target) => (
              <DropdownMenuItem
                key={target.id}
                className="items-start"
                onSelect={() => switchTo(target)}
                aria-label={`${target.name}${target.current ? ", current command node" : ""}`}
              >
                <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
                  {target.current ? <Check className="h-3.5 w-3.5" /> : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{target.name}</span>
                  {target.address ? (
                    <span className="block truncate text-xs text-muted-foreground">
                      {target.requiresToken ? "Token required · " : ""}
                      {target.address}
                    </span>
                  ) : null}
                </span>
              </DropdownMenuItem>
            ))
          )}
          {!api && targets !== null && targets.length === 1 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              No other machine has a web address this tab can open.
            </p>
          ) : null}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSeparator />
    </>
  );
}
