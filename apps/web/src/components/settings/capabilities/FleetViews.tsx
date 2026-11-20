import { useState } from "react";
import { Download, Loader2, Plus, RefreshCw, Trash2, Upload } from "lucide-react";

import {
  CAPABILITY_UPDATE_POLICIES,
  MY_SETUP_ID,
  type CapabilityDriftEntry,
  type CapabilityMachineSummary,
  type CapabilityOperationSnapshot,
  type CapabilitySetup,
  type CapabilityUpdatePolicy,
} from "@orkestrator/protocol/capability-resources";
import type {
  CapabilityExport,
  CapabilityImportPreview,
} from "@orkestrator/protocol/capability-resources-api";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { capabilitiesApi } from "@/lib/backend/capabilities";

import {
  describeError,
  kindLabel,
  Pill,
  providerLabel,
  shortDigest,
  StatusBadge,
} from "./capability-format";
import { ChangePreview } from "./ChangePreview";
import { AdminPolicySection } from "./AdminPolicySection";
import { AdoptLocalChangesDialog, MergeLocalChangesDialog } from "./LocalChangesDialogs";
import { ManifestSignatureNote } from "./ManifestSignatureNote";
import { RegistriesSection } from "./RegistriesSection";
import { useCapabilityResource } from "./useCapabilityResource";

const POLICY_LABEL: Record<CapabilityUpdatePolicy, string> = {
  approve: "Ask before updating",
  "trusted-auto": "Auto-update trusted sources (new risk still asks)",
  pinned: "Never update (pinned)",
};

function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (actionError) {
      setError(describeError(actionError));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

/** My setup and named toolkits: what they hold, where they apply, how they update; export and import. */
export function SetupsView({
  setups,
  machines,
  reload,
}: {
  setups: CapabilitySetup[];
  machines: CapabilityMachineSummary[];
  reload: () => void;
}) {
  const { busy, error, run } = useAction();
  const [name, setName] = useState("");
  const [fleetPreview, setFleetPreview] = useState<CapabilityOperationSnapshot | null>(null);
  const [exported, setExported] = useState<CapabilityExport | null>(null);
  const [importIntent, setImportIntent] = useState("");
  const [importLock, setImportLock] = useState("");
  const [importPreview, setImportPreview] = useState<CapabilityImportPreview | null>(null);
  const [signExports, setSignExports] = useState(false);
  const previewImport = () =>
    run(async () =>
      setImportPreview(
        await capabilitiesApi.previewCapabilityImport({ intent: importIntent, lock: importLock }),
      ),
    );

  return (
    <div className="space-y-6" data-testid="capability-setups">
      {fleetPreview ? (
        <ChangePreview
          key={fleetPreview.id}
          operation={fleetPreview}
          machineNames={Object.fromEntries(
            machines.map((machine) => [machine.nodeId, machine.name]),
          )}
          componentNames={{}}
          onApplied={() => {
            setFleetPreview(null);
            reload();
          }}
          onCancel={() =>
            void run(async () => {
              await capabilitiesApi.cancelCapabilityOperation(fleetPreview.id);
              setFleetPreview(null);
            })
          }
        />
      ) : null}
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor="toolkit-name" className="text-xs">
            New toolkit
          </Label>
          <Input
            id="toolkit-name"
            placeholder="Frontend"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <Button
          size="sm"
          disabled={busy || name.trim().length === 0}
          onClick={() =>
            void run(async () => {
              await capabilitiesApi.setCapabilitySetup({
                name: name.trim(),
                // A new toolkit applies only where it is assigned (a project,
                // environment, graph node or session) until the user turns on
                // "Use on every enrolled machine".
                machineSelectors: [],
              });
              setName("");
              reload();
            })
          }
        >
          <Plus className="h-3.5 w-3.5" /> Create
        </Button>
        <label className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={signExports}
            onChange={(event) => setSignExports(event.target.checked)}
          />
          Sign exports with this installation's key
        </label>
      </div>
      {error ? (
        <p className="text-xs text-rose-300" role="alert">
          {error}
        </p>
      ) : null}
      <ul className="space-y-3">
        {setups.map((setup) => (
          <li key={setup.id} className="space-y-2 rounded-lg border border-zinc-800 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-foreground">{setup.name}</span>
              {setup.builtIn ? <Pill>Built in</Pill> : null}
              <span className="text-xs text-muted-foreground">
                {setup.packageSelections.length} package(s) · revision {setup.revision}
              </span>
              <div className="ml-auto flex flex-wrap gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void run(async () =>
                      setExported(
                        await capabilitiesApi.exportCapabilitySetup(
                          [setup.id],
                          undefined,
                          undefined,
                          signExports,
                        ),
                      ),
                    )
                  }
                >
                  <Download className="h-3.5 w-3.5" /> Export
                </Button>
                {!setup.builtIn ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    aria-label={`Delete ${setup.name}`}
                    onClick={() =>
                      void run(async () => {
                        await capabilitiesApi.deleteCapabilitySetup(setup.id, setup.revision);
                        reload();
                      })
                    }
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                ) : null}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Label htmlFor={`policy-${setup.id}`} className="text-xs text-muted-foreground">
                Updates
              </Label>
              <NativeSelect
                id={`policy-${setup.id}`}
                value={setup.updatePolicy}
                onChange={(event) =>
                  void run(async () => {
                    await capabilitiesApi.setCapabilityUpdatePolicy(
                      setup.id,
                      event.target.value as CapabilityUpdatePolicy,
                    );
                    reload();
                  })
                }
              >
                {CAPABILITY_UPDATE_POLICIES.map((policy) => (
                  <option key={policy} value={policy}>
                    {POLICY_LABEL[policy]}
                  </option>
                ))}
              </NativeSelect>
              {setup.id !== MY_SETUP_ID ? (
                <>
                  <label className="flex items-center gap-1.5 text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={setup.machineSelectors.length > 0}
                      disabled={busy || fleetPreview !== null}
                      onChange={(event) => {
                        const enabled = event.target.checked;
                        void run(async () => {
                          if (enabled) {
                            const result = await capabilitiesApi.previewCapabilityChange({
                              kind: "use-toolkit-on-fleet",
                              setupId: setup.id,
                              expectedRevision: setup.revision,
                            });
                            setFleetPreview(result.operation);
                            return;
                          }
                          await capabilitiesApi.setCapabilitySetup(
                            {
                              id: setup.id,
                              name: setup.name,
                              machineSelectors: [],
                            },
                            setup.revision,
                          );
                          reload();
                        });
                      }}
                    />
                    Use on every enrolled machine
                  </label>
                  <span className="text-muted-foreground">
                    Applies to{" "}
                    {setup.machineSelectors.length === 0
                      ? "the projects, environments, graph nodes and sessions it is assigned to"
                      : setup.machineSelectors.includes("*")
                        ? "every enrolled machine"
                        : setup.machineSelectors.join(", ")}
                    {setup.providerSelectors.length > 0
                      ? ` · ${setup.providerSelectors.map((selector) => providerLabel(selector.replace("provider:", ""))).join(", ")}`
                      : ""}
                  </span>
                </>
              ) : (
                <span className="text-muted-foreground">Follows every enrolled machine</span>
              )}
            </div>
            {setup.exclusions.length > 0 ? (
              <div className="flex flex-wrap gap-1 text-[11px]">
                {setup.exclusions.map((exclusion) => (
                  <button
                    key={exclusion}
                    type="button"
                    className="rounded border border-zinc-700 px-1.5 py-0.5 text-muted-foreground hover:text-foreground"
                    title="Remove this exception"
                    onClick={() =>
                      void run(async () => {
                        await capabilitiesApi.manageCapabilityException(
                          setup.id,
                          exclusion,
                          "remove",
                          setup.revision,
                        );
                        reload();
                      })
                    }
                  >
                    Except {exclusion.replace("|", " · ").replace(/#.*$/, "")} ×
                  </button>
                ))}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {exported ? (
        <section className="space-y-2">
          <h4 className="text-sm font-medium text-foreground">Export</h4>
          <p className="text-xs text-muted-foreground">
            Commit both files to the project's repository. They name packages and pinned revisions
            only: no machine, no credential and no host path.
          </p>
          {exported.signed || exported.formatVersion === 2 ? (
            <p className="text-xs text-muted-foreground" data-testid="capability-export-format">
              Lockfile format {exported.formatVersion ?? 1}
              {exported.signed
                ? ` · signed with key ${exported.signed.fingerprint}`
                : " (setups pin different revisions of a package)"}
            </p>
          ) : null}
          <Label htmlFor="capability-export-intent" className="text-xs">
            {exported.intentFile}
          </Label>
          <Textarea
            id="capability-export-intent"
            readOnly
            rows={8}
            value={exported.intent}
            className="font-mono text-[11px]"
          />
          <Label htmlFor="capability-export-lock" className="text-xs">
            {exported.lockFile}
          </Label>
          <Textarea
            id="capability-export-lock"
            readOnly
            rows={6}
            value={exported.lock}
            className="font-mono text-[11px]"
          />
        </section>
      ) : null}
      <section className="space-y-2">
        <h4 className="text-sm font-medium text-foreground">Import</h4>
        <Label htmlFor="capability-import-intent" className="text-xs">
          Intent file (orkestrator.capabilities.yaml)
        </Label>
        <Textarea
          id="capability-import-intent"
          rows={4}
          placeholder="orkestrator.capabilities.yaml"
          value={importIntent}
          onChange={(event) => setImportIntent(event.target.value)}
          className="font-mono text-[11px]"
        />
        <Label htmlFor="capability-import-lock" className="text-xs">
          Lockfile (orkestrator.capabilities.lock.json)
        </Label>
        <Textarea
          id="capability-import-lock"
          rows={4}
          placeholder="orkestrator.capabilities.lock.json"
          value={importLock}
          onChange={(event) => setImportLock(event.target.value)}
          className="font-mono text-[11px]"
        />
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !importIntent || !importLock}
            onClick={() => void previewImport()}
          >
            <Upload className="h-3.5 w-3.5" /> Preview import
          </Button>
          {importPreview?.valid ? (
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await capabilitiesApi.importCapabilitySetup(importPreview.previewId);
                  setImportPreview(null);
                  reload();
                })
              }
            >
              Import
            </Button>
          ) : null}
        </div>
        {importPreview ? (
          <div className="space-y-1 rounded-md border border-zinc-800 p-3 text-xs">
            {importPreview.signature ? (
              <ManifestSignatureNote
                signature={importPreview.signature}
                required={importPreview.requireSignedManifests === true}
                onTrusted={() => void previewImport()}
              />
            ) : null}
            {importPreview.issues.map((issue) => (
              <p key={`${issue.path}:${issue.message}`} className="text-rose-300">
                {issue.path}: {issue.message}
              </p>
            ))}
            {importPreview.setups.map((setup) => (
              <p key={setup.name}>
                Setup <strong>{setup.name}</strong>: {setup.action} ({setup.packages} packages)
              </p>
            ))}
            {importPreview.packages.map((pkg) => (
              <p
                key={`${pkg.packageId}@${pkg.artifactDigest}`}
                className={pkg.action === "conflict" ? "text-amber-300" : undefined}
              >
                {pkg.packageId} at {shortDigest(pkg.artifactDigest)}: {pkg.action}
                {pkg.reason ? ` (${pkg.reason})` : ""}
              </p>
            ))}
            {importPreview.approvalReasons.map((reason) => (
              <p key={reason} className="text-amber-200">
                {reason}
              </p>
            ))}
          </div>
        ) : null}
      </section>
      <RegistriesSection />
      <AdminPolicySection />
    </div>
  );
}

/** Every machine: enrolment, groups, what it reports and its local changes. */
export function MachinesView({
  machines,
  reload,
}: {
  machines: CapabilityMachineSummary[];
  reload: () => void;
}) {
  const { busy, error, run } = useAction();
  const [adopting, setAdopting] = useState<CapabilityDriftEntry | null>(null);
  const [merging, setMerging] = useState<CapabilityDriftEntry | null>(null);
  const drift = useCapabilityResource(() => capabilitiesApi.listCapabilityDrift(), []);
  const machineNames = Object.fromEntries(
    machines.map((machine) => [machine.nodeId, machine.name]),
  );
  const decide = (entry: CapabilityDriftEntry, decision: "keep-local" | "replace") =>
    run(async () => {
      await capabilitiesApi.resolveCapabilityDrift(entry.id, decision);
      drift.reload();
    });
  const settled = () => {
    setAdopting(null);
    setMerging(null);
    drift.reload();
    reload();
  };
  const [groupDraft, setGroupDraft] = useState<Record<string, string>>({});
  const open = (drift.state.data?.drift ?? []).filter((entry) => entry.state === "open");
  return (
    <div className="space-y-6" data-testid="capability-machines">
      {error ? (
        <p className="text-xs text-rose-300" role="alert">
          {error}
        </p>
      ) : null}
      <ul className="divide-y divide-zinc-900 rounded-lg border border-zinc-800">
        {machines.map((machine) => {
          const inSync =
            machine.appliedManifestDigest &&
            machine.appliedManifestDigest === machine.desiredManifestDigest;
          return (
            <li key={machine.nodeId} className="space-y-2 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-foreground">{machine.name}</span>
                <Pill>
                  {machine.connection === "self"
                    ? "This machine"
                    : machine.connection === "connected"
                      ? "Connected"
                      : "Offline"}
                </Pill>
                {machine.os ? (
                  <span className="text-xs text-muted-foreground">{machine.os}</span>
                ) : null}
                <span className="text-xs text-muted-foreground">
                  {machine.enrolled
                    ? inSync
                      ? "Has the latest setup"
                      : machine.connection === "offline"
                        ? "Will apply the latest setup when it reconnects"
                        : "Applying the latest setup"
                    : "Not enrolled"}
                </span>
                <label className="ml-auto flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={machine.enrolled}
                    disabled={busy}
                    onChange={(event) =>
                      void run(async () => {
                        await capabilitiesApi.setCapabilityMachineEnrollment(machine.nodeId, {
                          enrolled: event.target.checked,
                        });
                        reload();
                      })
                    }
                  />
                  Follows My setup
                </label>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-muted-foreground">Groups</span>
                <Input
                  aria-label={`Groups for ${machine.name}`}
                  className="h-7 w-48 text-xs"
                  placeholder="development, laptops"
                  value={groupDraft[machine.nodeId] ?? machine.groups.join(", ")}
                  onChange={(event) =>
                    setGroupDraft({ ...groupDraft, [machine.nodeId]: event.target.value })
                  }
                  onBlur={() => {
                    const draft = groupDraft[machine.nodeId];
                    if (draft === undefined) return;
                    void run(async () => {
                      await capabilitiesApi.setCapabilityMachineEnrollment(machine.nodeId, {
                        groups: draft
                          .split(",")
                          .map((group) => group.trim().toLowerCase())
                          .filter(Boolean),
                      });
                      reload();
                    });
                  }}
                />
                {machine.providers.map((provider) => (
                  <span
                    key={provider.provider}
                    className={provider.available ? "text-zinc-300" : "text-zinc-600"}
                  >
                    {providerLabel(provider.provider)}
                  </span>
                ))}
                {Object.entries(machine.counts).map(([status, count]) => (
                  <span key={status} className="inline-flex items-center gap-1">
                    <StatusBadge status={status} /> {count}
                  </span>
                ))}
              </div>
            </li>
          );
        })}
      </ul>
      <section className="space-y-2">
        <h4 className="text-sm font-medium text-foreground">Local changes</h4>
        {open.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No machine has changed a managed capability by hand.
          </p>
        ) : (
          <ul className="space-y-2">
            {open.map((entry) => (
              <li
                key={entry.id}
                className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/30 p-2 text-xs"
              >
                <span className="text-foreground">{entry.name}</span>
                <span className="text-muted-foreground">
                  {entry.kind === "modified"
                    ? "edited"
                    : entry.kind === "removed"
                      ? "deleted"
                      : "not managed by Orkestrator"}{" "}
                  on{" "}
                  {machines.find((machine) => machine.nodeId === entry.nodeId)?.name ??
                    entry.nodeId}
                </span>
                <div className="ml-auto flex flex-wrap gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void decide(entry, "keep-local")}
                  >
                    Keep local
                  </Button>
                  {entry.kind !== "unmanaged" && entry.packageId ? (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => setAdopting(entry)}
                      >
                        Adopt
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => setMerging(entry)}
                        aria-label={`Merge local changes to ${entry.name}`}
                      >
                        Merge
                      </Button>
                    </>
                  ) : null}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void decide(entry, "replace")}
                  >
                    Replace
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <AdoptLocalChangesDialog
        entry={adopting}
        machineNames={machineNames}
        onClose={() => setAdopting(null)}
        onApplied={settled}
      />
      <MergeLocalChangesDialog
        entry={merging}
        machineNames={machineNames}
        onClose={() => setMerging(null)}
        onApplied={settled}
        onFallback={(entry, decision) => {
          setMerging(null);
          if (decision === "adopt") setAdopting(entry);
          else void decide(entry, decision);
        }}
      />
    </div>
  );
}

/** The update inbox: what changed in each new revision, and approval. */
export function UpdatesView({ onPreview }: { onPreview: (updateId: string) => void }) {
  const { busy, error, run } = useAction();
  const { state, reload } = useCapabilityResource(
    () => capabilitiesApi.listCapabilityUpdates(),
    [],
  );
  const updates = state.data?.updates ?? [];
  const pending = updates.filter((update) => update.state === "pending");
  return (
    <div className="space-y-4" data-testid="capability-updates">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await capabilitiesApi.refreshCapabilityUpdates();
              reload();
            })
          }
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}{" "}
          Check now
        </Button>
        <span className="text-xs text-muted-foreground">
          {state.data?.lastCheckedAt
            ? `Last checked ${new Date(state.data.lastCheckedAt).toLocaleString()}`
            : "Checked automatically every six hours"}
        </span>
      </div>
      {error ? (
        <p className="text-xs text-rose-300" role="alert">
          {error}
        </p>
      ) : null}
      {pending.length === 0 ? (
        <p className="text-sm text-muted-foreground">Everything is up to date.</p>
      ) : null}
      <ul className="space-y-2">
        {pending.map((update) => (
          <li key={update.id} className="space-y-1 rounded-lg border border-zinc-800 p-3 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-foreground">{update.packageId}</span>
              <span className="text-muted-foreground">
                {update.fromRevision.slice(0, 10)} → {update.toRevision.slice(0, 10)}
              </span>
              {update.requiresApproval ? <StatusBadge status="needs-approval" /> : null}
              {update.diverged ? (
                <Pill className="border-amber-500/40 text-amber-200">Diverged from upstream</Pill>
              ) : null}
              <div className="ml-auto flex gap-1">
                <Button size="sm" onClick={() => onPreview(update.id)}>
                  Review
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await capabilitiesApi.dismissCapabilityUpdate(update.id);
                      reload();
                    })
                  }
                >
                  Dismiss
                </Button>
              </div>
            </div>
            {update.reasons.map((reason) => (
              <p key={reason} className="text-amber-200">
                {reason}
              </p>
            ))}
            <ul className="text-muted-foreground">
              {update.changes.map((change) => (
                <li key={change.componentId}>
                  {change.change} {kindLabel(change.kind).toLowerCase()}{" "}
                  {change.componentId.split(":").pop()}
                  {change.escalation ? (
                    <span className="text-amber-300"> · {change.escalation}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Who changed what, and every operation's machine-by-machine outcome. */
export function ActivityView({
  packageId,
  onClearFilter,
}: {
  packageId?: string;
  onClearFilter: () => void;
}) {
  const activity = useCapabilityResource(
    () => capabilitiesApi.listCapabilityActivity(packageId),
    [packageId],
  );
  const operations = useCapabilityResource(() => capabilitiesApi.listCapabilityOperations(), []);
  return (
    <div className="space-y-6" data-testid="capability-activity">
      {packageId ? (
        <button type="button" className="text-xs text-sky-300" onClick={onClearFilter}>
          Showing one package · show everything
        </button>
      ) : null}
      <section className="space-y-2">
        <h4 className="text-sm font-medium text-foreground">Operations</h4>
        <ul className="space-y-1 text-xs">
          {(operations.state.data?.operations ?? []).slice(0, 20).map((operation) => (
            <li key={operation.id} className="flex flex-wrap items-center gap-2">
              <Pill>{operation.kind}</Pill>
              <span className="text-foreground">{operation.state}</span>
              {Object.entries(operation.summary.byStatus).map(([status, count]) => (
                <span key={status} className="inline-flex items-center gap-1">
                  <StatusBadge status={status} /> {count}
                </span>
              ))}
              <span className="text-muted-foreground">
                {new Date(operation.updatedAt).toLocaleString()} · ref {operation.correlationId}
              </span>
            </li>
          ))}
        </ul>
      </section>
      <section className="space-y-2">
        <h4 className="text-sm font-medium text-foreground">Activity</h4>
        <ul className="space-y-1 text-xs">
          {(activity.state.data?.entries ?? []).map((entry) => (
            <li key={entry.id} className="flex flex-wrap gap-2">
              <span className="text-muted-foreground">{new Date(entry.at).toLocaleString()}</span>
              <span className="text-foreground">{entry.summary}</span>
              {entry.actor ? <span className="text-muted-foreground">by {entry.actor}</span> : null}
            </li>
          ))}
          {(activity.state.data?.entries ?? []).length === 0 ? (
            <li className="text-muted-foreground">Nothing yet.</li>
          ) : null}
        </ul>
      </section>
    </div>
  );
}
