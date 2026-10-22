import { type ReactNode, useCallback, useEffect, useState } from "react";
import {
  AppWindow,
  Download,
  Loader2,
  Plus,
  RefreshCw,
  Settings2,
  ShieldAlert,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { discardNodeDetach, nodeErrorText } from "@/lib/backend/command-nodes";
import { onMachineUpdatesRequest, takeMachineUpdatesRequest } from "@/lib/settings-navigation";
import { cn } from "@/lib/utils";
import { AddMachineDialog } from "./AddMachineDialog";
import { ClientOptions } from "./ClientOptions";
import { MachineSettingsDialog } from "./MachineSettingsDialog";
import { MachineUpdatesDialog } from "./MachineUpdatesDialog";
import { maintenanceIssues, type MachineEntry } from "./machine-list";
import { MachineStatusDot, errorText, formatMachineTime } from "./machine-ui";
import { useMachines, type ConnectionsApi } from "./useMachines";
import { useMaintenanceSummaries, type MaintenanceSummary } from "./useMaintenanceSummaries";

/**
 * Every machine this client works with, in one list: the machine it is
 * connected to, the machines that one controls, and (on the desktop) the
 * machines saved on this device. Each has its settings, a window of its own
 * and its updates.
 */
export function MachinesSettings() {
  const machines = useMachines();
  const { api, entries, status, nodes, nodesError, connections, connectionsError, loaded } =
    machines;
  const { summaries, record } = useMaintenanceSummaries(entries);
  const [adding, setAdding] = useState(false);
  const [settingsKey, setSettingsKey] = useState<string | null>(null);
  const [updatesKey, setUpdatesKey] = useState<string | null>(null);
  const [wantsCurrentUpdates, setWantsCurrentUpdates] = useState(takeMachineUpdatesRequest);
  const [openingWindow, setOpeningWindow] = useState<string | null>(null);

  useEffect(
    () =>
      onMachineUpdatesRequest(() => {
        if (takeMachineUpdatesRequest()) setWantsCurrentUpdates(true);
      }),
    [],
  );
  // A banner's request opens the current machine's updates once it is listed.
  const currentKey = entries.find((entry) => entry.current)?.key ?? null;
  const openUpdatesKey = updatesKey ?? (wantsCurrentUpdates ? currentKey : null);

  const refresh = machines.refresh;
  const changed = useCallback(() => void refresh(), [refresh]);
  const settingsMachine = entries.find((entry) => entry.key === settingsKey) ?? null;
  const updatesMachine = entries.find((entry) => entry.key === openUpdatesKey) ?? null;
  const leaf = status?.mode === "leaf";
  const knownAddresses = [
    ...(nodes?.nodes ?? []).flatMap((node) =>
      node.routes.flatMap((route) => (route.kind === "https" ? [route.origin] : [])),
    ),
    ...(connections?.connections ?? []).flatMap((connection) =>
      connection.address ? [connection.address] : [],
    ),
  ];

  const openWindow = async (entry: MachineEntry) => {
    if (!api?.openWindow || !entry.connection) return;
    setOpeningWindow(entry.key);
    try {
      await api.openWindow(entry.connection.id);
    } catch (error) {
      toast.error("Could not open a new window", { description: errorText(error) });
    } finally {
      setOpeningWindow(null);
    }
  };

  return (
    <div className="max-w-4xl space-y-6" data-testid="machines-settings">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="text-base font-semibold text-foreground">Machines</h3>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Every machine runs its own backend and keeps its own work. The machine you are connected
            to reaches the others, so they show in one place.
          </p>
        </div>
        <Button type="button" onClick={() => setAdding(true)} className="w-fit gap-2">
          <Plus className="h-4 w-4" />
          Add machine
        </Button>
      </div>

      {leaf && status ? (
        <div
          data-testid="leaf-mode-notice"
          className="flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-100"
        >
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            This machine is controlled by{" "}
            {status.controllers.map((controller) => controller.displayName).join(", ")}, so its own
            control of other machines is paused
            {status.suspendedSubordinateCount > 0
              ? ` (${status.suspendedSubordinateCount} kept, not controlled)`
              : ""}
            . Coordination happens there.
          </p>
        </div>
      ) : null}

      {nodesError && !status && loaded ? (
        <p className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-4 py-3 text-xs text-zinc-400">
          The machine you are connected to cannot control other machines yet ({nodesError}).
          {api ? " Machines are saved on this device only." : ""}
        </p>
      ) : null}

      {connectionsError ? (
        <div className="rounded-lg border border-red-500/25 bg-red-500/[0.07] p-4" role="alert">
          <p className="text-sm text-red-300">{connectionsError}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => void refresh()}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Try again
          </Button>
        </div>
      ) : null}

      {!loaded ? (
        <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading machines…
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950/30">
          <table className="w-full table-fixed text-sm" data-testid="machine-list">
            <thead className="border-b border-zinc-800 bg-zinc-900/55 text-left text-xs text-zinc-500">
              <tr>
                <th className="px-4 py-2.5 font-medium">Machine</th>
                <th className="hidden w-28 px-4 py-2.5 font-medium md:table-cell">Orkestrator</th>
                <th className="w-[8.5rem] px-3 py-2.5 text-right font-medium sm:w-[15rem] sm:px-4">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/80">
              {entries.map((entry) => (
                <MachineRow
                  key={entry.key}
                  entry={entry}
                  api={api}
                  summary={summaries[entry.key]}
                  openingWindow={openingWindow === entry.key}
                  onSettings={() => setSettingsKey(entry.key)}
                  onUpdates={() => setUpdatesKey(entry.key)}
                  onOpenWindow={() => void openWindow(entry)}
                />
              ))}
              {entries.length === 0 ? (
                <tr>
                  <td colSpan={3} className="px-4 py-8 text-center text-sm text-zinc-500">
                    No machines yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      )}

      {nodes && nodes.pendingDetaches.length > 0 ? (
        <PendingDetaches entries={nodes.pendingDetaches} onChanged={changed} />
      ) : null}

      {api && connections ? <ClientOptions list={connections} /> : null}

      <AddMachineDialog
        open={adding}
        onOpenChange={setAdding}
        status={status}
        api={api}
        knownAddresses={knownAddresses}
        onAdded={changed}
      />
      {settingsMachine ? (
        <MachineSettingsDialog
          key={settingsMachine.key}
          machine={settingsMachine}
          open
          onOpenChange={(open) => !open && setSettingsKey(null)}
          api={api}
          status={status}
          snapshot={summaries[settingsMachine.key]?.snapshot ?? null}
          onChanged={changed}
        />
      ) : null}
      {updatesMachine ? (
        <MachineUpdatesDialog
          key={updatesMachine.key}
          machine={updatesMachine}
          open
          onOpenChange={(open) => {
            if (open) return;
            setUpdatesKey(null);
            setWantsCurrentUpdates(false);
          }}
          initial={summaries[updatesMachine.key]?.snapshot ?? null}
          onSnapshot={record}
        />
      ) : null}
    </div>
  );
}

function MachineRow({
  entry,
  api,
  summary,
  openingWindow,
  onSettings,
  onUpdates,
  onOpenWindow,
}: {
  entry: MachineEntry;
  api: ConnectionsApi | null;
  summary: MaintenanceSummary | undefined;
  openingWindow: boolean;
  onSettings: () => void;
  onUpdates: () => void;
  onOpenWindow: () => void;
}) {
  const snapshot = summary?.snapshot ?? null;
  const issues = snapshot ? maintenanceIssues(snapshot) : [];
  const outdated = issues.length > 0;
  const lastConnected = formatMachineTime(entry.lastConnectedAt);
  const windowReason = !api?.openWindow
    ? "Only the desktop app opens machines in their own windows"
    : !entry.connection
      ? "Save this machine on this device (in its settings) to open it in its own window"
      : entry.connection.requiresToken
        ? "Enter its token on this device first"
        : null;
  const updatesTitle = !entry.maintenance
    ? entry.role === "device"
      ? "Only machines the command node controls can be updated from here"
      : "Connect to this machine to see its updates"
    : outdated
      ? issues.join("\n")
      : snapshot
        ? "Everything is up to date"
        : "Updates";

  return (
    <tr
      data-testid="machine-row"
      data-machine={entry.key}
      className={cn(entry.current && "bg-emerald-500/[0.035]")}
    >
      <td className="py-3.5 pr-2 pl-3 align-top sm:px-4">
        <div className="flex min-w-0 gap-3">
          <MachineStatusDot
            colorToken={entry.colorToken}
            connected={entry.connected}
            label={`${entry.name}: ${entry.statusText}`}
            className="mt-1.5"
          />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 truncate font-medium text-zinc-100">{entry.name}</span>
              {entry.current ? (
                <Badge className="border-emerald-500/25 bg-emerald-500/10 text-emerald-300">
                  This window
                </Badge>
              ) : null}
              {entry.role === "self" && !entry.current ? <Badge>Command node</Badge> : null}
              {entry.role === "device" ? <Badge>This device only</Badge> : null}
            </div>
            <p className="mt-0.5 truncate font-mono text-xs text-zinc-400">
              {entry.address ?? "No address"}
            </p>
            <p className="mt-0.5 text-xs text-zinc-500" data-testid="machine-connection">
              {entry.via} · {entry.statusText}
            </p>
            <p className="mt-0.5 text-[11px] text-zinc-600">
              {entry.role === "self" && entry.connected
                ? "Connected now"
                : lastConnected
                  ? `Last connected ${lastConnected}`
                  : "Never connected"}
            </p>
          </div>
        </div>
      </td>
      <td className="hidden px-4 py-3.5 align-top font-mono text-xs text-zinc-400 md:table-cell">
        {snapshot?.version ?? "—"}
      </td>
      <td className="py-3.5 pr-3 pl-0 align-top sm:px-4">
        <div className="flex items-center justify-end gap-1 sm:gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-zinc-400 hover:text-zinc-100"
            onClick={onSettings}
            aria-label={`Settings for ${entry.name}`}
            title="Settings"
          >
            <Settings2 className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-zinc-400 hover:text-zinc-100"
            onClick={onOpenWindow}
            disabled={windowReason !== null || openingWindow}
            aria-label={`Open ${entry.name} in a new window`}
            title={windowReason ?? "Open in a new window"}
          >
            {openingWindow ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <AppWindow className="h-4 w-4" />
            )}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn(
              "gap-1.5",
              outdated &&
                "border-red-500/50 bg-red-500/10 text-red-300 hover:bg-red-500/20 hover:text-red-200",
            )}
            onClick={onUpdates}
            disabled={!entry.maintenance}
            aria-label={
              outdated
                ? `Updates for ${entry.name}: ${issues.length} out of date`
                : `Updates for ${entry.name}`
            }
            title={updatesTitle}
            data-outdated={outdated ? "true" : "false"}
          >
            <Download className="h-3.5 w-3.5" />
            <span className="sr-only sm:not-sr-only">Updates</span>
            {outdated ? (
              <span className="rounded-full bg-red-500/80 px-1.5 text-[10px] leading-4 font-semibold text-white">
                {issues.length}
              </span>
            ) : null}
          </Button>
        </div>
      </td>
    </tr>
  );
}

function Badge({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "rounded-full border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-400",
        className,
      )}
    >
      {children}
    </span>
  );
}

function PendingDetaches({
  entries,
  onChanged,
}: {
  entries: Array<{ nodeId: string; displayName: string; forgottenAt: string }>;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <div className="rounded-lg border border-zinc-800 p-3 text-xs text-muted-foreground">
      <p className="font-medium text-foreground">Waiting to detach</p>
      {entries.map((entry) => (
        <div key={entry.nodeId} className="mt-1 flex items-center justify-between gap-2">
          <span>
            {entry.displayName} was removed {formatMachineTime(entry.forgottenAt) ?? ""}; it is told
            when it is reachable.
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy !== null}
            onClick={() => {
              setBusy(entry.nodeId);
              void discardNodeDetach(entry.nodeId)
                .then(onChanged, (error: unknown) => toast.error(nodeErrorText(error)))
                .finally(() => setBusy(null));
            }}
          >
            Stop waiting
          </Button>
        </div>
      ))}
    </div>
  );
}
