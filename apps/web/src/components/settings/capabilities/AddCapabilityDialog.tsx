import { useEffect, useMemo, useState } from "react";
import { FileWarning, Loader2, Search } from "lucide-react";

import { AGENT_PLATFORMS, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type {
  CapabilityInventory,
  CapabilitySourceInspection,
} from "@orkestrator/protocol/capability-resources-api";
import type {
  CapabilityMachineSummary,
  CapabilityOperationSnapshot,
  CapabilitySetup,
} from "@orkestrator/protocol/capability-resources";

import { Z_FULLSCREEN_DIALOG } from "@/constants/z-index";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { capabilitiesApi, type AuthoredCapabilityInput } from "@/lib/backend/capabilities";
import { cn } from "@/lib/utils";

import { ChangePreview } from "./ChangePreview";
import { describeError, kindLabel, Pill, providerLabel, RiskLabel } from "./capability-format";

type SourceMode = "repository" | "marketplace" | "installed" | "upload" | "create";

const MODES: Array<{ id: SourceMode; label: string }> = [
  { id: "repository", label: "Repository" },
  { id: "marketplace", label: "Claude marketplace" },
  { id: "installed", label: "Already installed" },
  { id: "upload", label: "Upload" },
  { id: "create", label: "Create new" },
];

const AUTHORED_KINDS: Array<{ id: AuthoredCapabilityInput["kind"]; label: string }> = [
  { id: "skill", label: "Skill" },
  { id: "command", label: "Command" },
  { id: "prompt", label: "Prompt" },
  { id: "subagent", label: "Subagent" },
  { id: "hook", label: "Hook" },
  { id: "mcp-server", label: "MCP server" },
];

const HOOK_TRIGGERS = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
  "SessionStart",
  "SessionEnd",
  "Notification",
];

async function readUploadedFiles(list: FileList): Promise<AuthoredCapabilityInput["files"]> {
  const files: NonNullable<AuthoredCapabilityInput["files"]> = [];
  for (const file of Array.from(list).slice(0, 2_000)) {
    const relative =
      (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    const buffer = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let index = 0; index < buffer.length; index += 1)
      binary += String.fromCharCode(buffer[index]!);
    files.push({ path: relative, content: btoa(binary), encoding: "base64" });
  }
  return files;
}

/**
 * Add once: inspect a source before anything is enabled, choose where to use
 * it (every compatible agent on every enrolled machine by default), preview
 * the exact plan, then approve it.
 */
export function AddCapabilityDialog({
  open,
  onOpenChange,
  machines,
  setups,
  initialSetupId,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  machines: CapabilityMachineSummary[];
  setups: CapabilitySetup[];
  initialSetupId?: string;
  onDone: (operation: CapabilityOperationSnapshot) => void;
}) {
  const [mode, setMode] = useState<SourceMode>("repository");
  const [repo, setRepo] = useState("");
  const [subpath, setSubpath] = useState("");
  const [channel, setChannel] = useState("");
  const [qualifiedId, setQualifiedId] = useState("");
  const [inventory, setInventory] = useState<CapabilityInventory | null>(null);
  const [itemId, setItemId] = useState("");
  const [uploaded, setUploaded] = useState<AuthoredCapabilityInput["files"]>(undefined);
  const [authored, setAuthored] = useState<AuthoredCapabilityInput>({
    kind: "skill",
    name: "",
    description: "",
    content: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inspection, setInspection] = useState<CapabilitySourceInspection | null>(null);
  const [providers, setProviders] = useState<Set<AgentPlatform>>(new Set());
  const [machineIds, setMachineIds] = useState<Set<string>>(new Set());
  const [setupId, setSetupId] = useState(initialSetupId ?? "my-setup");
  const [pin, setPin] = useState(false);
  const [required, setRequired] = useState(false);
  const [preview, setPreview] = useState<CapabilityOperationSnapshot | null>(null);

  // Closing starts the next "Add" from the beginning.
  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setInspection(null);
      setPreview(null);
      setError(null);
    }
    onOpenChange(next);
  };

  useEffect(() => {
    if (!open || mode !== "installed" || inventory) return;
    capabilitiesApi
      .getCapabilityInventory()
      .then(setInventory)
      .catch((loadError: unknown) => setError(describeError(loadError)));
  }, [open, mode, inventory]);

  const enrolled = useMemo(() => machines.filter((machine) => machine.enrolled), [machines]);
  const externalItems = useMemo(
    () =>
      (inventory?.items ?? []).filter(
        (item) =>
          item.ownership === "external" &&
          item.locationId !== "mcp" &&
          item.locationId !== "plugin",
      ),
    [inventory],
  );

  const inspect = async () => {
    setBusy(true);
    setError(null);
    try {
      let result: CapabilitySourceInspection;
      if (mode === "repository") {
        result = await capabilitiesApi.inspectCapabilitySource({
          kind: "git",
          repo: repo.trim(),
          subpath: subpath.trim(),
          ...(channel.trim() ? { channel: channel.trim() } : {}),
        });
      } else if (mode === "marketplace") {
        result = await capabilitiesApi.inspectCapabilitySource({
          kind: "provider-marketplace",
          provider: "claude",
          qualifiedId: qualifiedId.trim(),
        });
      } else if (mode === "installed") {
        result = await capabilitiesApi.adoptExternalCapability(itemId);
      } else if (mode === "upload") {
        result = await capabilitiesApi.authorCapabilityPackage({
          kind: "upload",
          name: authored.name || "uploaded",
          files: uploaded ?? [],
        });
      } else {
        result = await capabilitiesApi.authorCapabilityPackage(authored);
      }
      setInspection(result);
      setProviders(new Set(result.compatibleProviders));
      setMachineIds(new Set(enrolled.map((machine) => machine.nodeId)));
    } catch (inspectError) {
      setError(describeError(inspectError));
    } finally {
      setBusy(false);
    }
  };

  const previewChange = async () => {
    if (!inspection) return;
    setBusy(true);
    setError(null);
    try {
      const result = await capabilitiesApi.previewCapabilityChange(
        mode === "installed"
          ? { kind: "adopt", inspectionId: inspection.inspectionId, setupId }
          : {
              kind: "add-to-setup",
              inspectionId: inspection.inspectionId,
              setupId,
              excludedProviders: AGENT_PLATFORMS.filter((provider) => !providers.has(provider)),
              excludedMachines: enrolled
                .map((machine) => machine.nodeId)
                .filter((id) => !machineIds.has(id)),
              ...(pin ? { pin: true } : {}),
              ...(required ? { required: true } : {}),
            },
      );
      setPreview(result.operation);
    } catch (previewError) {
      setError(describeError(previewError));
    } finally {
      setBusy(false);
    }
  };

  const canInspect =
    (mode === "repository" && repo.trim().length > 0) ||
    (mode === "marketplace" && /.+@.+/.test(qualifiedId.trim())) ||
    (mode === "installed" && itemId.length > 0) ||
    (mode === "upload" && (uploaded?.length ?? 0) > 0) ||
    (mode === "create" && /^[a-z0-9][a-z0-9-]*$/.test(authored.name));

  const machineNames = Object.fromEntries(
    machines.map((machine) => [machine.nodeId, machine.name]),
  );
  const componentNames = Object.fromEntries(
    (inspection?.components ?? []).map((component) => [component.id, component.name]),
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        size="3xl"
        className={`max-h-[90vh] overflow-y-auto ${Z_FULLSCREEN_DIALOG}`}
        overlayClassName={Z_FULLSCREEN_DIALOG}
        data-testid="add-capability-dialog"
      >
        <DialogHeader>
          <DialogTitle>
            {preview
              ? "Review the plan"
              : inspection
                ? "Choose where to use it"
                : "Add a capability"}
          </DialogTitle>
          <DialogDescription>
            {preview
              ? "Exactly what changes on each machine and agent. Nothing is written until you apply."
              : inspection
                ? "Every compatible agent on every enrolled machine is selected. Clear what you do not want; it is kept as an exception."
                : "Orkestrator inspects the source first. Nothing runs and nothing is enabled until you approve."}
          </DialogDescription>
        </DialogHeader>

        {preview ? (
          <ChangePreview
            operation={preview}
            machineNames={machineNames}
            componentNames={componentNames}
            onCancel={() => setPreview(null)}
            onApplied={(operation) => {
              onDone(operation);
              handleOpenChange(false);
            }}
          />
        ) : inspection ? (
          <div className="space-y-4">
            <div className="rounded-md border border-zinc-800 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-foreground">{inspection.displayName}</span>
                <RiskLabel risk={inspection.risk} />
                {inspection.existing ? <Pill>Already in your library</Pill> : null}
              </div>
              {inspection.description ? (
                <p className="mt-1 text-xs text-muted-foreground">{inspection.description}</p>
              ) : null}
              <p className="mt-1 text-[11px] text-muted-foreground">
                Revision {inspection.revision.slice(0, 12)} · {inspection.files.length} files ·{" "}
                {Math.ceil(inspection.totalBytes / 1024)} KiB
                {inspection.publisher ? ` · ${inspection.publisher}` : ""}
              </p>
              <ul className="mt-2 space-y-1 text-xs">
                {inspection.components.map((component) => (
                  <li key={component.id} className="flex flex-wrap items-center gap-2">
                    <Pill>{kindLabel(component.kind)}</Pill>
                    <span className="text-foreground">{component.name}</span>
                    <RiskLabel risk={component.risk} />
                    {component.executes?.length ? (
                      <code className="text-[11px] text-amber-200">
                        runs {component.executes.slice(0, 3).join(", ")}
                      </code>
                    ) : null}
                    {component.triggers?.length ? (
                      <span className="text-[11px] text-rose-200">
                        on {component.triggers.join(", ")}
                      </span>
                    ) : null}
                    {component.endpoints?.length ? (
                      <span className="text-[11px] text-sky-200">
                        connects to {component.endpoints.join(", ")}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
            {inspection.secretsFound.length > 0 ? (
              <div
                className="flex items-start gap-2 rounded-md border border-rose-500/40 bg-rose-500/5 p-3 text-xs text-rose-200"
                role="alert"
              >
                <FileWarning className="mt-0.5 h-4 w-4" />
                This source contains what looks like a {inspection.secretsFound.join(", ")}. Remove
                it before adding the package; credentials never travel between machines.
              </div>
            ) : null}
            {inspection.warnings.length > 0 ? (
              <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                {inspection.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            ) : null}
            <div className="grid gap-4 sm:grid-cols-2">
              <fieldset className="space-y-1.5">
                <legend className="mb-1 text-xs font-medium text-foreground">Agents</legend>
                {AGENT_PLATFORMS.map((provider) => {
                  const compatible = inspection.compatibleProviders.includes(provider);
                  const reasons = inspection.unsupported.filter(
                    (entry) => entry.provider === provider,
                  );
                  return (
                    <label
                      key={provider}
                      className={cn("flex items-start gap-2 text-xs", !compatible && "opacity-60")}
                    >
                      <input
                        type="checkbox"
                        disabled={!compatible}
                        checked={providers.has(provider)}
                        onChange={(event) => {
                          const next = new Set(providers);
                          if (event.target.checked) next.add(provider);
                          else next.delete(provider);
                          setProviders(next);
                        }}
                      />
                      <span>
                        {providerLabel(provider)}
                        {reasons.length > 0 ? (
                          <span className="block text-[11px] text-muted-foreground">
                            {compatible ? "Partly: " : ""}
                            {reasons[0]!.reason}
                          </span>
                        ) : null}
                      </span>
                    </label>
                  );
                })}
              </fieldset>
              <fieldset className="space-y-1.5">
                <legend className="mb-1 text-xs font-medium text-foreground">Machines</legend>
                {enrolled.map((machine) => (
                  <label key={machine.nodeId} className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={machineIds.has(machine.nodeId)}
                      onChange={(event) => {
                        const next = new Set(machineIds);
                        if (event.target.checked) next.add(machine.nodeId);
                        else next.delete(machine.nodeId);
                        setMachineIds(next);
                      }}
                    />
                    {machine.name}
                    {machine.connection === "offline" ? (
                      <span className="text-muted-foreground">(waiting to connect)</span>
                    ) : null}
                  </label>
                ))}
                {enrolled.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No machine is enrolled in My setup.
                  </p>
                ) : null}
              </fieldset>
            </div>
            <div className="flex flex-wrap items-end gap-4">
              <div className="space-y-1">
                <Label htmlFor="capability-setup" className="text-xs">
                  Add to
                </Label>
                <NativeSelect
                  id="capability-setup"
                  value={setupId}
                  onChange={(event) => setSetupId(event.target.value)}
                >
                  {setups.map((setup) => (
                    <option key={setup.id} value={setup.id}>
                      {setup.name}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={pin}
                  onChange={(event) => setPin(event.target.checked)}
                />{" "}
                Pin this revision
              </label>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={required}
                  onChange={(event) => setRequired(event.target.checked)}
                />{" "}
                Required (block a session that cannot have it)
              </label>
            </div>
            {error ? (
              <p className="text-xs text-rose-300" role="alert">
                {error}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setInspection(null)} disabled={busy}>
                Back
              </Button>
              <Button
                size="sm"
                onClick={() => void previewChange()}
                disabled={
                  busy ||
                  inspection.secretsFound.length > 0 ||
                  (mode !== "installed" &&
                    inspection.compatibleProviders.length > 0 &&
                    providers.size === 0)
                }
                data-testid="capability-preview"
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                Preview
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-1" role="tablist" aria-label="Source">
              {MODES.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  role="tab"
                  aria-selected={mode === entry.id}
                  onClick={() => setMode(entry.id)}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-xs",
                    mode === entry.id
                      ? "bg-elevated text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {entry.label}
                </button>
              ))}
            </div>
            {mode === "repository" ? (
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-1 sm:col-span-3">
                  <Label htmlFor="capability-repo" className="text-xs">
                    Repository
                  </Label>
                  <Input
                    id="capability-repo"
                    placeholder="https://github.com/org/agent-tools"
                    value={repo}
                    onChange={(event) => setRepo(event.target.value)}
                  />
                </div>
                <div className="space-y-1 sm:col-span-2">
                  <Label htmlFor="capability-subpath" className="text-xs">
                    Folder (optional)
                  </Label>
                  <Input
                    id="capability-subpath"
                    placeholder="skills/frontend"
                    value={subpath}
                    onChange={(event) => setSubpath(event.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="capability-ref" className="text-xs">
                    Branch, tag or commit
                  </Label>
                  <Input
                    id="capability-ref"
                    placeholder="default branch"
                    value={channel}
                    onChange={(event) => setChannel(event.target.value)}
                  />
                </div>
                <p className="text-[11px] text-muted-foreground sm:col-span-3">
                  Fetched with hooks and install scripts off; only the folder is read. The exact
                  commit is pinned.
                </p>
              </div>
            ) : mode === "marketplace" ? (
              <div className="space-y-1">
                <Label htmlFor="capability-plugin" className="text-xs">
                  Plugin
                </Label>
                <Input
                  id="capability-plugin"
                  placeholder="review@claude-plugins-official"
                  value={qualifiedId}
                  onChange={(event) => setQualifiedId(event.target.value)}
                />
                <p className="text-[11px] text-muted-foreground">
                  Claude resolves marketplace plugins itself, so their hooks and commands cannot be
                  shown before install. Other agents' plugins are installed through those agents.
                </p>
              </div>
            ) : mode === "installed" ? (
              <div className="max-h-64 space-y-1 overflow-y-auto">
                {inventory === null ? (
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                ) : externalItems.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    Everything on this machine is already managed.
                  </p>
                ) : (
                  externalItems.map((item) => (
                    <label key={item.id} className="flex items-center gap-2 text-xs">
                      <input
                        type="radio"
                        name="capability-item"
                        checked={itemId === item.id}
                        onChange={() => setItemId(item.id)}
                      />
                      <Pill>{kindLabel(item.kind)}</Pill>
                      <span className="text-foreground">{item.name}</span>
                      <span className="text-muted-foreground">{item.locationLabel}</span>
                    </label>
                  ))
                )}
              </div>
            ) : mode === "upload" ? (
              <div className="space-y-2">
                <Label htmlFor="capability-upload" className="text-xs">
                  A skill folder, plugin folder or Markdown file
                </Label>
                <input
                  id="capability-upload"
                  type="file"
                  multiple
                  // @ts-expect-error -- non-standard attribute for folder uploads
                  webkitdirectory=""
                  className="block text-xs"
                  onChange={(event) => {
                    if (event.target.files)
                      void readUploadedFiles(event.target.files).then(setUploaded);
                  }}
                />
                {uploaded?.length ? (
                  <p className="text-[11px] text-muted-foreground">
                    {uploaded.length} files ready to inspect.
                  </p>
                ) : null}
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex flex-wrap gap-3">
                  <div className="space-y-1">
                    <Label htmlFor="capability-kind" className="text-xs">
                      Kind
                    </Label>
                    <NativeSelect
                      id="capability-kind"
                      value={authored.kind}
                      onChange={(event) =>
                        setAuthored({
                          ...authored,
                          kind: event.target.value as AuthoredCapabilityInput["kind"],
                        })
                      }
                    >
                      {AUTHORED_KINDS.map((kind) => (
                        <option key={kind.id} value={kind.id}>
                          {kind.label}
                        </option>
                      ))}
                    </NativeSelect>
                  </div>
                  <div className="flex-1 space-y-1">
                    <Label htmlFor="capability-name" className="text-xs">
                      Name
                    </Label>
                    <Input
                      id="capability-name"
                      placeholder="frontend-review"
                      value={authored.name}
                      onChange={(event) =>
                        setAuthored({ ...authored, name: event.target.value.toLowerCase() })
                      }
                    />
                  </div>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="capability-description" className="text-xs">
                    Description
                  </Label>
                  <Input
                    id="capability-description"
                    value={authored.description ?? ""}
                    onChange={(event) =>
                      setAuthored({ ...authored, description: event.target.value })
                    }
                  />
                </div>
                {authored.kind === "hook" ? (
                  <div className="grid gap-3 sm:grid-cols-3">
                    <div className="space-y-1">
                      <Label htmlFor="capability-trigger" className="text-xs">
                        Trigger
                      </Label>
                      <NativeSelect
                        id="capability-trigger"
                        value={authored.hook?.trigger ?? "PreToolUse"}
                        onChange={(event) =>
                          setAuthored({
                            ...authored,
                            hook: {
                              command: authored.hook?.command ?? "",
                              trigger: event.target.value,
                            },
                          })
                        }
                      >
                        {HOOK_TRIGGERS.map((trigger) => (
                          <option key={trigger}>{trigger}</option>
                        ))}
                      </NativeSelect>
                    </div>
                    <div className="space-y-1 sm:col-span-2">
                      <Label htmlFor="capability-hook-command" className="text-xs">
                        Command it runs
                      </Label>
                      <Input
                        id="capability-hook-command"
                        value={authored.hook?.command ?? ""}
                        onChange={(event) =>
                          setAuthored({
                            ...authored,
                            hook: {
                              trigger: authored.hook?.trigger ?? "PreToolUse",
                              command: event.target.value,
                            },
                          })
                        }
                      />
                    </div>
                  </div>
                ) : authored.kind === "mcp-server" ? (
                  <div className="grid gap-3 sm:grid-cols-3">
                    <div className="space-y-1">
                      <Label htmlFor="capability-transport" className="text-xs">
                        Transport
                      </Label>
                      <NativeSelect
                        id="capability-transport"
                        value={authored.mcp?.transport ?? "stdio"}
                        onChange={(event) =>
                          setAuthored({
                            ...authored,
                            mcp: {
                              ...authored.mcp,
                              transport: event.target.value as "stdio" | "http" | "sse",
                            },
                          })
                        }
                      >
                        <option value="stdio">Local program</option>
                        <option value="http">HTTP</option>
                        <option value="sse">SSE</option>
                      </NativeSelect>
                    </div>
                    <div className="space-y-1 sm:col-span-2">
                      <Label htmlFor="capability-mcp-target" className="text-xs">
                        {(authored.mcp?.transport ?? "stdio") === "stdio" ? "Command" : "Address"}
                      </Label>
                      <Input
                        id="capability-mcp-target"
                        value={
                          (authored.mcp?.transport ?? "stdio") === "stdio"
                            ? (authored.mcp?.command ?? "")
                            : (authored.mcp?.url ?? "")
                        }
                        onChange={(event) => {
                          const transport = authored.mcp?.transport ?? "stdio";
                          setAuthored({
                            ...authored,
                            mcp:
                              transport === "stdio"
                                ? { transport, command: event.target.value }
                                : { transport, url: event.target.value },
                          });
                        }}
                      />
                    </div>
                    <p className="text-[11px] text-muted-foreground sm:col-span-3">
                      Credentials are never stored here; each machine adds its own in MCP servers
                      settings.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-1">
                    <Label htmlFor="capability-content" className="text-xs">
                      Instructions
                    </Label>
                    <Textarea
                      id="capability-content"
                      rows={8}
                      value={authored.content ?? ""}
                      onChange={(event) =>
                        setAuthored({ ...authored, content: event.target.value })
                      }
                      placeholder={
                        authored.kind === "skill"
                          ? "When reviewing frontend changes, check…"
                          : "The prompt or command body"
                      }
                    />
                  </div>
                )}
              </div>
            )}
            {error ? (
              <p className="text-xs text-rose-300" role="alert">
                {error}
              </p>
            ) : null}
            <div className="flex justify-end">
              <Button
                size="sm"
                onClick={() => void inspect()}
                disabled={busy || !canInspect}
                data-testid="capability-inspect"
              >
                {busy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Search className="h-3.5 w-3.5" />
                )}
                Inspect
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
