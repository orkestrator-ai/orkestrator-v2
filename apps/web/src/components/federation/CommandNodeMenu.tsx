import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, Loader2, Settings2 } from "lucide-react";
import { toast } from "sonner";
import type { NodeListResult } from "@orkestrator/protocol/command-nodes";
import type { ConnectionList } from "@orkestrator/protocol/connections";
import type { BackendId } from "@orkestrator/protocol/federation";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { requestCommandHandover } from "@/lib/command-handover";
import { subscribeToConnections } from "@/lib/connections";
import { NO_ARGS, portalNodesApi } from "@/lib/node-scope/domains/nodes";
import { requestGlobalSettings } from "@/lib/settings-navigation";
import { cn } from "@/lib/utils";
import { MachineColorDot, MachineRoleIcon } from "./MachineDot";
import { useCommandNode, type CommandNodeIdentity } from "./useCommandNode";
import { useMachineViews } from "./useMachineViews";

type ConnectionsApi = NonNullable<NonNullable<Window["orkestrator"]>["connections"]>;

function connectionsApi(): ConnectionsApi | null {
  return window.orkestrator?.connections ?? null;
}

/** A machine this client can use as its command node. */
export interface SwitchTarget {
  id: string;
  name: string;
  address: string | null;
  /** The command node this client is connected to now. */
  current: boolean;
  requiresToken: boolean;
  nodeId?: BackendId;
  colorToken?: string;
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
    ...(connection.profile?.colorToken ? { colorToken: connection.profile.colorToken } : {}),
  }));
}

/**
 * A browser tab is served by its command node, so another command node is
 * another address: the machines this one controls that have a web address.
 */
export function targetsFromNodes(
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
            ...(node.colorToken ? { colorToken: node.colorToken } : {}),
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
      ...(commandNode.nodeId ? { nodeId: commandNode.nodeId } : {}),
      colorToken: commandNode.colorToken,
    },
    ...others,
  ];
}

/**
 * The machines this client can connect to as its command node, loaded while
 * `open`: the saved connections on the desktop and iOS (kept current by their
 * snapshots), else the command node's machines with a web address.
 */
function useSwitchTargets(
  commandNode: CommandNodeIdentity | null,
  open: boolean,
): SwitchTarget[] | null {
  const api = connectionsApi();
  const [connections, setConnections] = useState<ConnectionList | null>(null);
  const [nodes, setNodes] = useState<NodeListResult["nodes"] | null>(null);

  useEffect(() => {
    if (!api) return;
    let active = true;
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
  }, [api]);

  useEffect(() => {
    if (api || !open) return;
    let active = true;
    void portalNodesApi()
      .list_nodes(NO_ARGS)
      .then((list) => {
        if (active) setNodes(list.nodes);
      })
      .catch(() => {
        if (active) setNodes([]);
      });
    return () => {
      active = false;
    };
  }, [api, open]);

  if (!commandNode) return null;
  if (api) return connections && targetsFromConnections(connections);
  return nodes && targetsFromNodes(commandNode, nodes);
}

/**
 * Makes `target` the command node, as Machines settings does: another
 * machine takes over this one's machines (the user chooses which in
 * `CommandHandoverDialog`) and the window follows it. A machine whose token
 * is not saved here is sent to Machines settings to enter it first.
 */
function switchCommandNode(target: SwitchTarget, viaConnections: boolean) {
  if (target.current) return;
  if (target.requiresToken) {
    toast.info(`Enter ${target.name}'s token first`, {
      description: "Its token is not saved on this device.",
    });
    requestGlobalSettings("machines");
    return;
  }
  requestCommandHandover(
    viaConnections
      ? { name: target.name, connectionId: target.id }
      : {
          name: target.name,
          ...(target.nodeId ? { nodeId: target.nodeId } : {}),
          address: target.address,
        },
  );
}

/**
 * The title bar's command-node switcher: the name and colour of the command
 * node this client is connected to, marked with the command-node home. Its
 * menu is a direct choice of which machine to connect to — the command node
 * with its home, every other machine with a leaf — then Manage machines….
 * It never filters the sidebar (the machine tiles do that), and opening an
 * environment on another machine never changes the command node.
 */
export function CommandNodeSwitcher({ compact = false }: { compact?: boolean }) {
  const commandNode = useCommandNode();
  const [open, setOpen] = useState(false);
  const targets = useSwitchTargets(commandNode, open);
  const machines = useMachineViews();
  const colorOf = useMemo(() => {
    const byNode = new Map(machines.map((machine) => [machine.backendId, machine.colorToken]));
    return (target: SwitchTarget) =>
      target.colorToken ?? (target.nodeId ? byNode.get(target.nodeId) : undefined);
  }, [machines]);
  if (!commandNode) return null;
  const viaConnections = connectionsApi() !== null;
  const label = `Command node: ${commandNode.name}. Switch command node`;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          data-testid="command-node-switcher"
          aria-label={label}
          title={compact ? label : "Switch command node"}
          className={cn(
            "min-w-0 gap-1.5 text-muted-foreground hover:text-foreground",
            compact
              ? "h-9 w-9 justify-center px-0"
              : "h-6 max-w-[14rem] px-1.5 text-xs font-medium",
          )}
        >
          <MachineColorDot colorToken={commandNode.colorToken} />
          <MachineRoleIcon role="command" className="text-current" />
          {compact ? null : (
            <>
              <span className="min-w-0 truncate text-foreground" data-testid="command-node-name">
                {commandNode.name}
              </span>
              <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
            </>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72" data-testid="command-node-menu">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          Connect to
        </DropdownMenuLabel>
        {targets === null ? (
          <div className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            Loading…
          </div>
        ) : (
          targets.map((target) => (
            <DropdownMenuItem
              key={target.id}
              role="menuitemradio"
              aria-checked={target.current}
              data-testid="command-node-target"
              className="items-start"
              onSelect={() => switchCommandNode(target, viaConnections)}
              aria-label={`${target.name}, ${
                target.current ? "command node, connected" : "leaf"
              }${target.requiresToken ? ", token required" : ""}`}
            >
              <span className="flex h-5 shrink-0 items-center gap-1.5">
                <MachineColorDot colorToken={colorOf(target)} />
                <MachineRoleIcon role={target.current ? "command" : "leaf"} />
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
              <span className="flex h-5 w-4 shrink-0 items-center justify-center">
                {target.current ? <Check className="size-3.5" aria-hidden="true" /> : null}
              </span>
            </DropdownMenuItem>
          ))
        )}
        {!viaConnections && targets !== null && targets.length === 1 ? (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">
            No other machine has a web address this tab can open.
          </p>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => requestGlobalSettings("machines")}>
          <Settings2 className="size-3.5" aria-hidden="true" />
          Manage machines…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
