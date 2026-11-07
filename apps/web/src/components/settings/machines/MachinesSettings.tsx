import {
  type CSSProperties,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useState,
} from "react";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Modifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  AppWindow,
  Download,
  GripVertical,
  Loader2,
  Plus,
  RefreshCw,
  Settings2,
  ShieldAlert,
} from "lucide-react";
import { toast } from "sonner";
import { isActiveHostUpdateJob } from "@orkestrator/protocol/host-maintenance";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { discardNodeDetach, nodeErrorText } from "@/lib/backend/command-nodes";
import { requestCommandHandover } from "@/lib/command-handover";
import { arrangeMachines } from "@/lib/federation/sidebar-layout";
import { updatePortalLayout } from "@/lib/portal/portal-layout";
import {
  onMachineUpdateRequest,
  onMachineUpdatesRequest,
  takeMachineUpdateRequest,
  takeMachineUpdatesRequest,
} from "@/lib/settings-navigation";
import { cn } from "@/lib/utils";
import { useMachineBulkUpdateStore, type BulkUpdateOutcome } from "@/stores/machineBulkUpdateStore";
import { describeHostUpdateJob } from "../HostUpdatesPanel";
import { AddMachineDialog } from "./AddMachineDialog";
import { BulkUpdateDialog, type BulkUpdateChoice } from "./BulkUpdateDialog";
import { summarizeBulkUpdate, updateMachinesToLatest } from "./bulk-update";
import { machineMaintenanceClient } from "./machine-access";
import { ClientOptions } from "./ClientOptions";
import { FleetUpdatePolicySection } from "./FleetUpdatePolicySection";
import { MachineSettingsDialog } from "./MachineSettingsDialog";
import { MachineUpdatesDialog } from "./MachineUpdatesDialog";
import { maintenanceIssues, type MachineEntry } from "./machine-list";
import { MachineStatusDot, errorText, formatMachineTime } from "./machine-ui";
import { useMachines, type ConnectionsApi } from "./useMachines";
import { useMaintenanceSummaries, type MaintenanceSummary } from "./useMaintenanceSummaries";
import { MachineAgentAccountsSection } from "./MachineAgentAccountsSection";
import { SETTINGS_CARD_CLASS, SettingsPageLayout } from "../SettingsPageLayout";

/** A row only moves up and down; sideways it would be clipped by the table's frame. */
const verticalOnly: Modifier = ({ transform }) => ({ ...transform, x: 0 });

/**
 * Every machine this client works with, in one list: the machine it is
 * connected to, the machines that one controls, and (on the desktop) the
 * machines saved on this device. Each has its settings, a window of its own
 * and its updates.
 *
 * The command node stays at the top. The machines it controls are dragged into
 * the order it keeps for them, which the sidebar and the title bar's CPU
 * readings follow too.
 */
export function MachinesSettings() {
  const machines = useMachines();
  const { api, entries, layout, status, nodes, nodesError, connections, connectionsError, loaded } =
    machines;
  const { summaries, record } = useMaintenanceSummaries(entries);
  const [adding, setAdding] = useState(false);
  const [settingsKey, setSettingsKey] = useState<string | null>(null);
  const [updatesKey, setUpdatesKey] = useState<string | null>(null);
  const [wantsCurrentUpdates, setWantsCurrentUpdates] = useState(takeMachineUpdatesRequest);
  const [openingWindow, setOpeningWindow] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [confirmingBulk, setConfirmingBulk] = useState(false);
  // A skewed machine's header or a typed incompatibility error asked to update one machine.
  const [wantsUpdateOf, setWantsUpdateOf] = useState(takeMachineUpdateRequest);
  const [singleUpdateKey, setSingleUpdateKey] = useState<string | null>(null);
  const bulkOutcomes = useMachineBulkUpdateStore((state) => state.outcomes);
  const bulkSnapshots = useMachineBulkUpdateStore((state) => state.snapshots);
  const bulkRunning = useMachineBulkUpdateStore((state) => state.running);

  useEffect(
    () =>
      onMachineUpdatesRequest(() => {
        if (takeMachineUpdatesRequest()) setWantsCurrentUpdates(true);
      }),
    [],
  );
  useEffect(
    () =>
      onMachineUpdateRequest(() => {
        const nodeId = takeMachineUpdateRequest();
        if (nodeId) setWantsUpdateOf(nodeId);
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
  const selfEntry = entries.find((entry) => entry.role === "self") ?? null;
  const knownAddresses = [
    ...(nodes?.nodes ?? []).flatMap((node) =>
      node.routes.flatMap((route) => (route.kind === "https" ? [route.origin] : [])),
    ),
    ...(connections?.connections ?? []).flatMap((connection) =>
      connection.address ? [connection.address] : [],
    ),
  ];

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const movable = entries.flatMap((entry) =>
    entry.role === "node" && entry.nodeId ? [{ connectionId: entry.nodeId }] : [],
  );
  // A leaf's own machines are suspended and its command node's to manage.
  const reorderable = !leaf && movable.length > 1;
  const moveMachine = ({ active, over }: DragEndEvent) => {
    if (!over) return;
    const selfId = selfEntry?.nodeId ?? null;
    const machineOrder = arrangeMachines(
      selfId ? [{ connectionId: selfId }, ...movable] : movable,
      movable,
      layout,
      selfId,
      String(active.id),
      String(over.id),
    );
    if (!machineOrder) return;
    updatePortalLayout({ machineOrder }).catch((error: unknown) =>
      toast.error("Could not save the machine order", { description: errorText(error) }),
    );
  };

  // A machine that stops being updatable drops out of the selection.
  const updatable = entries.filter((entry) => updateBlocker(entry, summaries[entry.key]) === null);
  if (Array.from(selected).some((key) => !updatable.some((entry) => entry.key === key))) {
    setSelected(
      new Set(updatable.filter((entry) => selected.has(entry.key)).map((entry) => entry.key)),
    );
  }
  const selectedMachines = updatable.filter((entry) => selected.has(entry.key));
  const toggleSelected = (key: string, checked: boolean) =>
    setSelected((previous) => {
      const next = new Set(previous);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  const allSelected = updatable.length > 0 && selectedMachines.length === updatable.length;

  // The requested machine's update, once it is listed: the confirmation when it
  // can update from here, otherwise its updates, which say why it cannot.
  const requestedEntry = wantsUpdateOf
    ? (entries.find((entry) => entry.role !== "device" && entry.nodeId === wantsUpdateOf) ?? null)
    : null;
  if (requestedEntry) {
    setWantsUpdateOf(null);
    if (updateBlocker(requestedEntry, summaries[requestedEntry.key]) === null) {
      setSingleUpdateKey(requestedEntry.key);
    } else {
      setUpdatesKey(requestedEntry.key);
    }
  }
  const singleUpdateMachine = entries.find((entry) => entry.key === singleUpdateKey) ?? null;

  const startBulkUpdate = (choice: BulkUpdateChoice) => {
    setConfirmingBulk(false);
    setSelected(new Set());
    runUpdates(selectedMachines, choice);
  };

  const runUpdates = (machinesToUpdate: readonly MachineEntry[], choice: BulkUpdateChoice) => {
    const targets = machinesToUpdate.flatMap((entry) => {
      const client = machineMaintenanceClient(entry);
      return client ? [{ key: entry.key, client, last: entry.role === "self" }] : [];
    });
    if (targets.length === 0) return;
    const store = useMachineBulkUpdateStore.getState();
    store.start(targets.map((target) => target.key));
    // Not tied to this page: closing Settings does not stop the requests.
    void updateMachinesToLatest(
      targets,
      choice.whenIdle ? { drain: "when-idle", maxWaitSeconds: choice.maxWaitSeconds } : {},
      (key, outcome, snapshot) => {
        useMachineBulkUpdateStore.getState().report(key, outcome, snapshot);
      },
    )
      .then((outcomes) => {
        const results = [...outcomes.values()];
        const summary = summarizeBulkUpdate(results);
        if (results.every((outcome) => outcome.state === "failed")) toast.error(summary);
        else if (results.some((outcome) => outcome.state === "failed")) toast.warning(summary);
        else toast.success(summary);
      })
      .finally(() => useMachineBulkUpdateStore.getState().finish());
  };

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
    // The query container spans the whole settings pane, so the agent accounts
    // table can grow past the page's width to fit its columns.
    <div className="@container">
      <SettingsPageLayout
        width="wide"
        data-testid="machines-settings"
        title="Machines"
        description="Every machine runs its own backend and keeps its own work. The machine you are connected to reaches the others, so they show in one place."
        actions={
          <Button type="button" onClick={() => setAdding(true)} className="w-fit gap-2">
            <Plus className="h-4 w-4" />
            Add machine
          </Button>
        }
      >
        {leaf && status ? (
          <div
            data-testid="leaf-mode-notice"
            className="flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-100"
          >
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <p className="flex-1">
              This machine is controlled by{" "}
              {status.controllers.map((controller) => controller.displayName).join(", ")}, so its
              own control of other machines is paused
              {status.suspendedSubordinateCount > 0
                ? ` (${status.suspendedSubordinateCount} kept, not controlled)`
                : ""}
              . Coordination happens there.
            </p>
            {api?.handOverCommand && connections && selfEntry ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="shrink-0"
                onClick={() =>
                  requestCommandHandover({
                    name: selfEntry.name,
                    connectionId: connections.activeConnectionId,
                  })
                }
              >
                Make it the command node
              </Button>
            ) : null}
          </div>
        ) : null}

        {nodesError && loaded ? (
          <div className={cn(SETTINGS_CARD_CLASS, "px-4 py-3 text-xs text-zinc-400")}>
            Machine discovery is unavailable ({nodesError}). You can still manage this machine’s
            updates.
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => void refresh()}
            >
              Retry machine discovery
            </Button>
          </div>
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
          // The context sits outside the table: it renders its live region as a <div>.
          <>
            <div
              className="flex flex-wrap items-center justify-between gap-2"
              data-testid="bulk-update-bar"
            >
              <p className="text-xs text-zinc-500" aria-live="polite">
                {bulkRunning
                  ? "Updating the machines you picked…"
                  : selectedMachines.length > 0
                    ? `${selectedMachines.length} of ${updatable.length} selected`
                    : "Tick machines to update them together"}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1.5"
                disabled={selectedMachines.length === 0 || bulkRunning}
                onClick={() => setConfirmingBulk(true)}
              >
                {bulkRunning ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download className="h-3.5 w-3.5" />
                )}
                Update app to latest
              </Button>
            </div>
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              modifiers={[verticalOnly]}
              onDragEnd={moveMachine}
            >
              <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950/30">
                <table className="w-full table-fixed text-sm" data-testid="machine-list">
                  <thead className="border-b border-zinc-800 bg-zinc-900/55 text-left text-xs text-zinc-500">
                    <tr>
                      <th className="w-10 py-2.5 pr-0 pl-4 font-medium">
                        <Checkbox
                          aria-label="Select every machine that can update"
                          className="align-middle"
                          checked={
                            allSelected
                              ? true
                              : selectedMachines.length > 0
                                ? "indeterminate"
                                : false
                          }
                          disabled={updatable.length === 0 || bulkRunning}
                          onCheckedChange={(checked) =>
                            setSelected(
                              new Set(checked === true ? updatable.map((entry) => entry.key) : []),
                            )
                          }
                        />
                      </th>
                      <th className="py-2.5 pr-4 pl-3 font-medium">Machine</th>
                      <th className="hidden w-28 px-4 py-2.5 font-medium md:table-cell">
                        Orkestrator
                      </th>
                      <th className="w-[8.5rem] px-3 py-2.5 text-right font-medium sm:w-[15rem] sm:px-4">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/80">
                    <SortableContext
                      items={movable.map((machine) => machine.connectionId)}
                      strategy={verticalListSortingStrategy}
                    >
                      {entries.map((entry) => {
                        const row: MachineRowProps = {
                          entry,
                          api,
                          summary: summaries[entry.key],
                          openingWindow: openingWindow === entry.key,
                          onSettings: () => setSettingsKey(entry.key),
                          onUpdates: () => setUpdatesKey(entry.key),
                          onOpenWindow: () => void openWindow(entry),
                          leaf,
                          selection: {
                            checked: selected.has(entry.key),
                            blocker: updateBlocker(entry, summaries[entry.key]),
                            locked: bulkRunning,
                            onChange: (checked) => toggleSelected(entry.key, checked),
                          },
                          bulkOutcome: bulkOutcomes[entry.key],
                          bulkSnapshot: bulkSnapshots[entry.key],
                        };
                        return reorderable && entry.role === "node" && entry.nodeId ? (
                          <SortableMachineRow key={entry.key} sortableId={entry.nodeId} {...row} />
                        ) : (
                          <MachineRow
                            key={entry.key}
                            {...row}
                            // Reserves the grip's width so the dots line up.
                            grip={
                              reorderable ? (
                                <span aria-hidden="true" className={MACHINE_GRIP_SLOT_CLASS} />
                              ) : null
                            }
                          />
                        );
                      })}
                    </SortableContext>
                    {entries.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="px-4 py-8 text-center text-sm text-zinc-500">
                          No machines yet.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </DndContext>
            {!leaf && status && (nodes?.nodes.length ?? 0) > 0 ? (
              <FleetUpdatePolicySection />
            ) : null}
          </>
        )}

        {leaf ? (
          // A leaf's own window: its machines are its command node's to manage,
          // so only its own logins are listed here.
          <MachineAgentAccountsSection key="leaf-self" selfOnly wide />
        ) : (
          <MachineAgentAccountsSection
            key={(nodes?.nodes ?? [])
              .filter((node) => node.enabled && !node.detachPending)
              .map((node) => node.nodeId)
              .sort()
              .join(",")}
            wide
          />
        )}

        {nodes && nodes.pendingDetaches.length > 0 ? (
          <PendingDetaches entries={nodes.pendingDetaches} onChanged={changed} />
        ) : null}

        {api && connections ? <ClientOptions list={connections} /> : null}

        {confirmingBulk ? (
          <BulkUpdateDialog
            machines={selectedMachines}
            open
            onOpenChange={setConfirmingBulk}
            onConfirm={startBulkUpdate}
          />
        ) : null}
        {singleUpdateMachine && !confirmingBulk ? (
          <BulkUpdateDialog
            machines={[singleUpdateMachine]}
            open
            onOpenChange={(open) => !open && setSingleUpdateKey(null)}
            onConfirm={(choice) => {
              setSingleUpdateKey(null);
              runUpdates([singleUpdateMachine], choice);
            }}
          />
        ) : null}
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
      </SettingsPageLayout>
    </div>
  );
}

const MACHINE_GRIP_SLOT_CLASS = "-mr-1.5 -ml-1.5 h-5 w-4 shrink-0";

interface MachineRowProps {
  entry: MachineEntry;
  api: ConnectionsApi | null;
  summary: MaintenanceSummary | undefined;
  openingWindow: boolean;
  onSettings: () => void;
  onUpdates: () => void;
  onOpenWindow: () => void;
  /** The connected machine is controlled by another, so it is not the command node. */
  leaf: boolean;
  selection: {
    checked: boolean;
    /** Why it cannot be ticked, or null. */
    blocker: string | null;
    /** A bulk update is running. */
    locked: boolean;
    onChange: (checked: boolean) => void;
  };
  bulkOutcome: BulkUpdateOutcome | undefined;
  bulkSnapshot: MaintenanceSummary["snapshot"] | undefined;
}

/** Why "Update app to latest" cannot include this machine, or null when it can. */
function updateBlocker(
  entry: MachineEntry,
  summary: MaintenanceSummary | undefined,
): string | null {
  if (!entry.maintenance) {
    return entry.role === "device"
      ? "Only machines the command node controls can be updated from here"
      : "Connect to this machine to update it";
  }
  const updater = summary?.snapshot?.updater;
  if (updater && !updater.available) {
    return updater.reason ?? "This machine cannot update Orkestrator itself";
  }
  return null;
}

/** What the row says about an update: the host's own job, else where the bulk update got to. */
function updateStatusText(
  snapshot: MaintenanceSummary["snapshot"],
  outcome: BulkUpdateOutcome | undefined,
  observed: MaintenanceSummary["snapshot"] | undefined,
): { text: string; tone: "muted" | "active" | "good" | "bad" } | null {
  const job = snapshot?.job ?? null;
  if (job && isActiveHostUpdateJob(job)) {
    const secondsLeft =
      job.state === "awaiting-restart" && job.restartAt
        ? Math.max(0, Math.ceil((Date.parse(job.restartAt) - Date.now()) / 1000))
        : null;
    return { text: describeHostUpdateJob(job, secondsLeft), tone: "active" };
  }
  // Outcomes describe the state observed by this batch. A later job, check or
  // installed version supersedes that message, including failures and skips.
  const changed =
    snapshot &&
    observed &&
    (snapshot.version !== observed.version ||
      snapshot.job?.id !== observed.job?.id ||
      snapshot.job?.state !== observed.job?.state ||
      snapshot.updater.checkedAt !== observed.updater.checkedAt ||
      snapshot.updater.available !== observed.updater.available);
  if (
    outcome?.state !== "checking" &&
    (changed || outcome?.state === "requested" || outcome?.state === "busy") &&
    job
  ) {
    return {
      text: describeHostUpdateJob(job, null),
      tone: job.state === "succeeded" ? "good" : job.state === "failed" ? "bad" : "muted",
    };
  }
  if (changed && outcome?.state !== "checking") return null;
  switch (outcome?.state) {
    case undefined:
      return null;
    case "checking":
      return { text: "Checking for the newest release…", tone: "active" };
    case "requested":
      return { text: "Update requested", tone: "active" };
    case "current":
      return { text: `Already on the newest release (${outcome.version})`, tone: "good" };
    case "busy":
      return { text: "An update was already in progress", tone: "muted" };
    case "skipped":
      return { text: outcome.reason, tone: "muted" };
    case "failed":
      return { text: `Could not update: ${outcome.error}`, tone: "bad" };
  }
}

const STATUS_TONE_CLASS = {
  muted: "text-zinc-500",
  active: "text-sky-300",
  good: "text-emerald-300",
  bad: "text-red-300",
} as const;

/** A machine the command node controls, moved by its grip. */
function SortableMachineRow({ sortableId, ...row }: MachineRowProps & { sortableId: string }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: sortableId });
  return (
    <MachineRow
      {...row}
      rowRef={setNodeRef}
      rowStyle={{ transform: CSS.Translate.toString(transform), transition }}
      dragging={isDragging}
      grip={
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          aria-label={`Reorder ${row.entry.name}`}
          title="Drag to reorder"
          className={cn(
            MACHINE_GRIP_SLOT_CLASS,
            "flex cursor-grab touch-none items-center justify-center rounded text-zinc-600 hover:text-zinc-300 focus-hairline focus-hairline-outset active:cursor-grabbing",
          )}
        >
          <GripVertical className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      }
    />
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
  leaf,
  selection,
  bulkOutcome,
  bulkSnapshot,
  grip,
  rowRef,
  rowStyle,
  dragging = false,
}: MachineRowProps & {
  grip?: ReactNode;
  rowRef?: Ref<HTMLTableRowElement>;
  rowStyle?: CSSProperties;
  dragging?: boolean;
}) {
  const snapshot = summary?.snapshot ?? null;
  const issues = snapshot ? maintenanceIssues(snapshot) : [];
  const outdated = issues.length > 0;
  const updateStatus = updateStatusText(snapshot, bulkOutcome, bulkSnapshot);
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
      ref={rowRef}
      style={rowStyle}
      data-testid="machine-row"
      data-machine={entry.key}
      className={cn(
        entry.current && "bg-emerald-500/[0.035]",
        dragging && "relative z-10 bg-zinc-900 shadow-lg",
      )}
    >
      <td className="py-3.5 pr-0 pl-4 align-top">
        <Checkbox
          aria-label={`Select ${entry.name}`}
          title={selection.blocker ?? `Include ${entry.name} in Update app to latest`}
          className="mt-[3px]"
          checked={selection.checked && selection.blocker === null}
          disabled={selection.blocker !== null || selection.locked}
          onCheckedChange={(checked) => selection.onChange(checked === true)}
        />
      </td>
      <td className="py-3.5 pr-2 pl-3 align-top sm:pr-4">
        <div className="flex min-w-0 gap-3">
          {grip}
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
              {entry.role === "self" ? (
                leaf ? (
                  <Badge className="border-amber-500/25 bg-amber-500/10 text-amber-300">
                    Controlled by another machine
                  </Badge>
                ) : (
                  <Badge className="border-sky-500/25 bg-sky-500/10 text-sky-300">
                    Command node
                  </Badge>
                )
              ) : null}
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
            {updateStatus ? (
              <p
                role="status"
                data-testid="machine-update-status"
                className={cn("mt-1 text-xs", STATUS_TONE_CLASS[updateStatus.tone])}
              >
                {updateStatus.tone === "active" ? (
                  <Loader2
                    className="mr-1 inline h-3 w-3 animate-spin align-[-2px]"
                    aria-hidden="true"
                  />
                ) : null}
                {updateStatus.text}
              </p>
            ) : null}
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
