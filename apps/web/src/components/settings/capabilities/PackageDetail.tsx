import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ExternalLink,
  FlaskConical,
  Loader2,
  Pause,
  Pin,
  Play,
  PinOff,
  RotateCcw,
} from "lucide-react";

import { AGENT_PLATFORMS, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  capabilityStatusNeedsAttention,
  type CapabilityAvailabilityCell,
  type CapabilityMachineSummary,
  type CapabilityOperationSnapshot,
  type CapabilitySetup,
} from "@orkestrator/protocol/capability-resources";
import type { CapabilityVerification } from "@orkestrator/protocol/capability-resources-api";

import { Z_FULLSCREEN_DIALOG } from "@/constants/z-index";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { capabilitiesApi } from "@/lib/backend/capabilities";
import { requestGlobalSettings } from "@/lib/settings-navigation";
import { cn } from "@/lib/utils";

import { ChangePreview } from "./ChangePreview";
import {
  describeError,
  kindLabel,
  Pill,
  providerLabel,
  RiskLabel,
  shortDigest,
  StatusBadge,
  statusLabel,
  useDialogFocusReturn,
  verificationLabel,
} from "./capability-format";
import { useCapabilityResource } from "./useCapabilityResource";

const STATUS_RANK = [
  "failed",
  "blocked-policy",
  "drifted",
  "needs-auth",
  "needs-approval",
  "restart-required",
  "outcome-unknown",
  "offline",
  "pending",
  "queued-until-idle",
  "installed-next-session",
  "ready",
  "unsupported",
];

/** A name the authoring command accepts: lower-case letters, digits and dashes. */
function authoredName(...candidates: string[]): string {
  for (const candidate of candidates) {
    const name = candidate
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64);
    if (/^[a-z0-9][a-z0-9-]*$/.test(name)) return name;
  }
  return "package";
}

function worst(cells: CapabilityAvailabilityCell[]): CapabilityAvailabilityCell | undefined {
  return [...cells].sort(
    (a, b) => STATUS_RANK.indexOf(a.status) - STATUS_RANK.indexOf(b.status),
  )[0];
}

/**
 * One package: its contents, where it is available (machine by agent, each
 * gap with its reason and the safe correction), and the actions it supports.
 */
export function PackageDetail({
  packageId,
  machines,
  setups,
  onBack,
  onShowActivity,
  onShowInstalled,
}: {
  packageId: string;
  machines: CapabilityMachineSummary[];
  setups: CapabilitySetup[];
  onBack: () => void;
  onShowActivity: (packageId: string) => void;
  onShowInstalled: () => void;
}) {
  const { state, reload } = useCapabilityResource(
    () => capabilitiesApi.getCapabilityPackage(packageId),
    [packageId],
  );
  const [selectedCell, setSelectedCell] = useState<string | null>(null);
  const [preview, setPreview] = useState<CapabilityOperationSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testOpen, setTestOpen] = useState(false);
  const [testProvider, setTestProvider] = useState<AgentPlatform>("claude");
  const [testResult, setTestResult] = useState<CapabilityVerification | null>(null);
  const [useOnSetup, setUseOnSetup] = useState("");
  const [file, setFile] = useState<{ path: string; content: string } | null>(null);
  const [editing, setEditing] = useState<{
    path: string;
    content: string;
    basisDigest: string;
  } | null>(null);
  const detail = state.data;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const cellDetailsId = useId();
  const previewFocusReturn = useDialogFocusReturn();
  const testFocusReturn = useDialogFocusReturn();
  const loaded = detail !== null;
  // Opening a package replaces the library row that had focus: move focus to
  // the package's heading so keyboard and screen-reader users land on it.
  useEffect(() => {
    if (loaded) headingRef.current?.focus();
  }, [loaded, packageId]);

  const machineNames = useMemo(
    () => Object.fromEntries(machines.map((machine) => [machine.nodeId, machine.name])),
    [machines],
  );
  const componentNames = useMemo(
    () =>
      Object.fromEntries(
        (detail?.components ?? []).map((component) => [component.id, component.name]),
      ),
    [detail],
  );
  // A worktree's project copies and an account's private copies are rows of their own.
  const rowLabels = useMemo(() => {
    const labels = new Map<string, string>();
    for (const cell of detail?.availability ?? []) {
      const id = availabilityRowId(cell);
      if (!labels.has(id)) {
        labels.set(
          id,
          id === cell.target.nodeId
            ? (machineNames[cell.target.nodeId] ?? cell.target.nodeId)
            : (cell.nodeName ?? id),
        );
      }
    }
    return labels;
  }, [detail, machineNames]);
  const matrix = useMemo(() => {
    const rows = new Map<string, Map<string, CapabilityAvailabilityCell[]>>();
    for (const cell of detail?.availability ?? []) {
      const id = availabilityRowId(cell);
      const row = rows.get(id) ?? new Map<string, CapabilityAvailabilityCell[]>();
      const cells = row.get(cell.target.provider) ?? [];
      cells.push(cell);
      row.set(cell.target.provider, cells);
      rows.set(id, row);
    }
    return rows;
  }, [detail]);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      reload();
    } catch (actionError) {
      setError(describeError(actionError));
    } finally {
      setBusy(false);
    }
  };

  if (!detail) {
    return (
      <div className="space-y-3">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="h-3.5 w-3.5" /> My library
        </Button>
        {state.status === "error" ? (
          <p className="text-sm text-rose-300" role="alert">
            {state.message}
          </p>
        ) : (
          <Loader2
            className="h-4 w-4 animate-spin"
            role="status"
            aria-hidden={false}
            aria-label="Loading the package"
          />
        )}
      </div>
    );
  }

  const pkg = detail.package;
  const assignedSetups = setups.filter((setup) => pkg.assignedSetupIds.includes(setup.id));
  const otherSetups = setups.filter((setup) => !pkg.assignedSetupIds.includes(setup.id));
  const selected = selectedCell
    ? detail.availability.filter(
        (cell) => `${availabilityRowId(cell)}|${cell.target.provider}` === selectedCell,
      )
    : [];
  const hasMcp = pkg.kinds.includes("mcp-server");
  // Authored single-file packages are edited here; the edit is a new revision of the same package.
  const editable =
    pkg.source.kind === "managed" &&
    detail.files.length === 1 &&
    detail.components.length === 1 &&
    ["skill", "command", "prompt", "subagent"].includes(detail.components[0]!.kind);

  return (
    <div className="space-y-6" data-testid="capability-package-detail">
      <div className="space-y-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="h-3.5 w-3.5" /> My library
        </Button>
        <div className="flex flex-wrap items-center gap-2">
          <h3
            ref={headingRef}
            tabIndex={-1}
            className="text-lg font-semibold text-foreground focus-visible:outline-none"
          >
            {pkg.displayName}
          </h3>
          {pkg.kinds.map((kind) => (
            <Pill key={kind}>{kindLabel(kind)}</Pill>
          ))}
          <RiskLabel risk={pkg.risk} />
          {pkg.pinned ? <Pill>Pinned</Pill> : null}
          {pkg.paused ? <Pill className="text-amber-300">Paused</Pill> : null}
        </div>
        {pkg.description ? (
          <p className="text-sm text-muted-foreground">{pkg.description}</p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          {pkg.sourceLabel} · revision {pkg.revision.slice(0, 12)} ·{" "}
          {shortDigest(pkg.artifactDigest)} · {pkg.provenance}
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <div className="flex items-center gap-1">
          <NativeSelect
            aria-label="Use on a setup"
            value={useOnSetup}
            onChange={(event) => setUseOnSetup(event.target.value)}
            disabled={otherSetups.length === 0}
          >
            <option value="">Use on…</option>
            {otherSetups.map((setup) => (
              <option key={setup.id} value={setup.id}>
                {setup.name}
              </option>
            ))}
          </NativeSelect>
          <Button
            variant="outline"
            size="sm"
            disabled={!useOnSetup || busy}
            onClick={() =>
              void run(async () => {
                const result = await capabilitiesApi.previewCapabilityChange({
                  kind: "add-to-setup",
                  packageId,
                  setupId: useOnSetup,
                });
                setPreview(result.operation);
                setUseOnSetup("");
              })
            }
          >
            Add
          </Button>
        </div>
        {pkg.updateAvailable ? (
          <Pill className="text-sky-300">Update available in Updates</Pill>
        ) : null}
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() =>
            void run(() =>
              capabilitiesApi.setCapabilityPackageState(packageId, { pinned: !pkg.pinned }),
            )
          }
        >
          {pkg.pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
          {pkg.pinned ? "Unpin" : "Pin"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() =>
            void run(() =>
              capabilitiesApi.setCapabilityPackageState(packageId, { paused: !pkg.paused }),
            )
          }
        >
          {pkg.paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
          {pkg.paused ? "Resume" : "Pause"}
        </Button>
        {assignedSetups.map((setup) => (
          <Button
            key={setup.id}
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const result = await capabilitiesApi.previewCapabilityChange({
                  kind: "remove-from-setup",
                  packageId,
                  setupId: setup.id,
                });
                setPreview(result.operation);
              })
            }
          >
            Remove from {setup.name}
          </Button>
        ))}
        {detail.previousRevisions[0] ? (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            title={`Roll back to ${detail.previousRevisions[0].revision.slice(0, 12)}`}
            onClick={() =>
              void run(async () => {
                const result = await capabilitiesApi.rollbackCapabilityPackage(
                  packageId,
                  detail.previousRevisions[0]!.revision,
                );
                setPreview(result.operation);
              })
            }
          >
            <RotateCcw className="h-3.5 w-3.5" /> Roll back
          </Button>
        ) : null}
        <Button variant="outline" size="sm" onClick={() => setTestOpen(true)}>
          <FlaskConical className="h-3.5 w-3.5" /> Test
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => (hasMcp ? requestGlobalSettings("mcp-servers") : onShowInstalled())}
        >
          <ExternalLink className="h-3.5 w-3.5" /> Open native configuration
        </Button>
        <Button variant="ghost" size="sm" onClick={() => onShowActivity(packageId)}>
          View activity
        </Button>
      </div>
      {editable ? (
        <div className="space-y-2">
          {editing ? (
            <>
              <Textarea
                aria-label={`Edit ${editing.path}`}
                rows={10}
                className="font-mono text-[11px]"
                value={editing.content}
                onChange={(event) => setEditing({ ...editing, content: event.target.value })}
              />
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => setEditing(null)} disabled={busy}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const component = detail.components[0]!;
                      const inspection = await capabilitiesApi.authorCapabilityPackage({
                        managedId: (pkg.source as { managedId: string }).managedId,
                        kind: component.kind as "skill" | "command" | "prompt" | "subagent",
                        name: authoredName(pkg.displayName, component.name),
                        ...(pkg.description ? { description: pkg.description } : {}),
                        content: editing.content,
                      });
                      const result = await capabilitiesApi.previewCapabilityChange({
                        kind: "add-to-setup",
                        inspectionId: inspection.inspectionId,
                        expectedArtifactDigest: editing.basisDigest,
                        setupId: pkg.assignedSetupIds[0] ?? "my-setup",
                      });
                      setEditing(null);
                      setPreview(result.operation);
                    })
                  }
                >
                  Preview the new revision
                </Button>
              </div>
            </>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const source = await capabilitiesApi.readCapabilityFile(
                    packageId,
                    detail.files[0]!.path,
                  );
                  if (source.truncated) {
                    throw new Error("This source exceeds the editor's preview limit.");
                  }
                  setEditing({
                    path: source.path,
                    content: source.content,
                    basisDigest: pkg.artifactDigest,
                  });
                })
              }
            >
              Edit source
            </Button>
          )}
        </div>
      ) : null}
      {error ? (
        <p className="text-xs text-rose-300" role="alert">
          {error}
        </p>
      ) : null}

      <section className="space-y-2" aria-labelledby={`${cellDetailsId}-where`}>
        <h4 id={`${cellDetailsId}-where`} className="text-sm font-medium text-foreground">
          Where available
        </h4>
        {matrix.size === 0 ? (
          <p className="text-xs text-muted-foreground">
            Not assigned to any setup, so no machine has it.
          </p>
        ) : (
          // A narrow window scrolls the matrix sideways: the region takes focus
          // so a keyboard can scroll it too.
          <div
            className="focus-hairline overflow-x-auto rounded-md border border-zinc-800"
            role="region"
            aria-label="Availability by machine and agent"
            tabIndex={0}
          >
            <table className="w-full text-left text-xs" data-testid="capability-availability">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="px-2 py-1.5 font-medium">Machine</th>
                  {AGENT_PLATFORMS.map((provider) => (
                    <th key={provider} className="px-2 py-1.5 font-medium">
                      {providerLabel(provider)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-900">
                {[...matrix.entries()].map(([rowId, row]) => (
                  <tr key={rowId}>
                    <td className="px-2 py-1.5 text-foreground">{rowLabels.get(rowId) ?? rowId}</td>
                    {AGENT_PLATFORMS.map((provider) => {
                      const cells = row.get(provider) ?? [];
                      const cell = worst(cells);
                      const key = `${rowId}|${provider}`;
                      const machineName = rowLabels.get(rowId) ?? rowId;
                      return (
                        <td key={provider} className="px-2 py-1.5">
                          {cell ? (
                            <button
                              type="button"
                              className={cn(
                                "rounded",
                                selectedCell === key && "ring-1 ring-zinc-500",
                              )}
                              onClick={() => setSelectedCell(selectedCell === key ? null : key)}
                              aria-label={`${providerLabel(provider)} on ${machineName}: ${statusLabel(cell.status)}`}
                              aria-expanded={selectedCell === key}
                              aria-controls={selectedCell === key ? cellDetailsId : undefined}
                            >
                              <StatusBadge status={cell.status} title={cell.reason} />
                            </button>
                          ) : (
                            <span className="text-muted-foreground">
                              <span aria-hidden>—</span>
                              <span className="sr-only">Not assigned</span>
                            </span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {selected.length > 0 ? (
          <div
            id={cellDetailsId}
            role="region"
            aria-label={`${providerLabel(selected[0]!.target.provider)} on ${machineNames[selected[0]!.target.nodeId] ?? selected[0]!.target.nodeId}`}
            className="space-y-2 rounded-md border border-zinc-800 p-3 text-xs"
          >
            {selected.map((cell) => (
              <div key={cell.componentId} className="space-y-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-foreground">
                    {componentNames[cell.componentId] ?? cell.componentId}
                  </span>
                  <StatusBadge status={cell.status} />
                  <span className="text-muted-foreground">
                    {verificationLabel(cell.verification)}
                  </span>
                  {cell.installedDigest ? (
                    <span className="text-muted-foreground">
                      installed {shortDigest(cell.installedDigest)}
                    </span>
                  ) : null}
                  {cell.lastVerifiedAt ? (
                    <span className="text-muted-foreground">
                      checked {new Date(cell.lastVerifiedAt).toLocaleString()}
                    </span>
                  ) : null}
                </div>
                {cell.alsoVisibleTo?.length ? (
                  <p className="text-muted-foreground">
                    Shared directory: {cell.alsoVisibleTo.map(providerLabel).join(", ")} also see
                    it. Exclusion cannot be enforced for those agents.
                  </p>
                ) : null}
                {cell.reason ? <p className="text-muted-foreground">{cell.reason}</p> : null}
                {cell.remedy && capabilityStatusNeedsAttention(cell.status) ? (
                  <p className="text-sky-300">{cell.remedy}</p>
                ) : cell.remedy ? (
                  <p className="text-muted-foreground">{cell.remedy}</p>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </section>

      <section className="space-y-2" aria-labelledby={`${cellDetailsId}-contents`}>
        <h4 id={`${cellDetailsId}-contents`} className="text-sm font-medium text-foreground">
          Contents
        </h4>
        <ul className="space-y-1 text-xs">
          {detail.components.map((component) => (
            <li key={component.id} className="flex flex-wrap items-center gap-2">
              <Pill>{kindLabel(component.kind)}</Pill>
              <span className="text-foreground">{component.name}</span>
              <RiskLabel risk={component.risk} />
              {component.executes?.length ? (
                <code className="text-[11px] text-amber-200">
                  runs {component.executes.slice(0, 3).join(", ")}
                </code>
              ) : null}
              {component.requirements.envRefs?.length ? (
                <span className="text-[11px] text-muted-foreground">
                  needs {component.requirements.envRefs.join(", ")} per machine
                </span>
              ) : null}
            </li>
          ))}
        </ul>
        {detail.files.length > 0 ? (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">
              {detail.files.length} files
            </summary>
            <ul className="mt-1 space-y-0.5">
              {detail.files.map((entry) => (
                <li key={entry.path}>
                  <button
                    type="button"
                    className="text-left text-muted-foreground hover:text-foreground"
                    onClick={() =>
                      void capabilitiesApi
                        .readCapabilityFile(packageId, entry.path)
                        .then((result) => setFile({ path: result.path, content: result.content }))
                        .catch((readError: unknown) => setError(describeError(readError)))
                    }
                  >
                    {entry.path} {entry.executable ? "(executable)" : ""} · {entry.bytes} B
                  </button>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        {file ? (
          <pre
            tabIndex={0}
            aria-label={file.path}
            className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-zinc-800 bg-zinc-950 p-2 text-[11px] text-zinc-300"
          >
            {file.path}
            {"\n\n"}
            {file.content}
          </pre>
        ) : null}
      </section>

      <Dialog open={preview !== null} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent
          size="3xl"
          className={`${Z_FULLSCREEN_DIALOG}`}
          overlayClassName={Z_FULLSCREEN_DIALOG}
          {...previewFocusReturn}
        >
          <DialogHeader>
            <DialogTitle>Review the plan</DialogTitle>
            <DialogDescription>Copies another setup still uses are kept.</DialogDescription>
          </DialogHeader>
          {preview ? (
            <ChangePreview
              operation={preview}
              machineNames={machineNames}
              componentNames={componentNames}
              onCancel={() => setPreview(null)}
              onApplied={() => {
                setPreview(null);
                reload();
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog
        open={testOpen}
        onOpenChange={(open) => {
          setTestOpen(open);
          if (!open) setTestResult(null);
        }}
      >
        <DialogContent
          size="xl"
          className={`${Z_FULLSCREEN_DIALOG}`}
          overlayClassName={Z_FULLSCREEN_DIALOG}
          {...testFocusReturn}
        >
          <DialogHeader>
            <DialogTitle>Test {pkg.displayName}</DialogTitle>
            <DialogDescription>
              Reads this machine's configuration and checks the installed files. It never starts a
              server, runs a script or touches a session.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <NativeSelect
              aria-label="Agent"
              value={testProvider}
              onChange={(event) => setTestProvider(event.target.value as AgentPlatform)}
            >
              {AGENT_PLATFORMS.map((provider) => (
                <option key={provider} value={provider}>
                  {providerLabel(provider)}
                </option>
              ))}
            </NativeSelect>
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void run(async () =>
                  setTestResult(
                    await capabilitiesApi.verifyAgentCapability(
                      { provider: testProvider },
                      detail.components.map((component) => component.id),
                    ),
                  ),
                )
              }
            >
              Run the check
            </Button>
          </div>
          {testResult ? (
            <ul className="space-y-1 text-xs">
              {testResult.checks.map((check, index) => (
                <li
                  key={`${check.componentId}-${index}`}
                  className="flex flex-wrap items-center gap-2"
                >
                  <span className="text-foreground">
                    {componentNames[check.componentId] ?? check.componentId}
                  </span>
                  <StatusBadge status={check.status} />
                  <span className="text-muted-foreground">{check.detail}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** One matrix row: the machine, or one of its worktrees or added accounts. */
function availabilityRowId(cell: CapabilityAvailabilityCell): string {
  if (cell.target.environmentId) return `${cell.target.nodeId}|env:${cell.target.environmentId}`;
  if (cell.target.accountHomeId)
    return `${cell.target.nodeId}|account:${cell.target.accountHomeId}`;
  return cell.target.nodeId;
}
