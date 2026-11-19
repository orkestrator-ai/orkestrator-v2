import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { KeyRound, Loader2, Pencil, Plus, RefreshCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  CREDENTIAL_LIMITS,
  credentialValueProblem,
  describeCredentialUse,
  normalizeCredentialHosts,
  type CredentialConnection,
  type CredentialOverview,
} from "@orkestrator/protocol/agent-credentials";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CredentialValueInput } from "@/components/ui/credential-value-input";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Z_FULLSCREEN_DIALOG } from "@/constants/z-index";
import * as backend from "@/lib/backend";
import { onResourceChanged, onViewSafetyCheck } from "@/lib/resource-sync";
import { cn } from "@/lib/utils";
import type { Environment, Project } from "@/types";
import { isWindowMachine, useAccountMachine } from "./account-machine";
import {
  SETTINGS_CARD_CLASS,
  SettingsPageLayout,
  SettingsSectionHeader,
} from "./SettingsPageLayout";

/**
 * Settings → Credentials (docs/architecture/agent-credentials.md): saved
 * credentials agents can ask to use, and every grant that is active now.
 *
 * Values are write-only. A form holds a typed value in its own state until it
 * is sent, then clears it; nothing here can show a saved value again. Saving
 * a credential lets no agent use it: each use still needs a person's
 * approval on the agent's request card.
 */

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^[A-Z_]+: /u, "");
}

function formatTime(epochMs: number | undefined): string {
  return epochMs === undefined ? "Never" : new Date(epochMs).toLocaleString();
}

const STORAGE_LABELS: Record<CredentialConnection["storage"], string> = {
  keychain: "System keychain",
  file: "Owner-only file",
  memory: "Memory",
};

interface ConnectionForm {
  mode: "create" | "edit" | "replace";
  connection?: CredentialConnection;
  name: string;
  description: string;
  value: string;
  allProjects: boolean;
  projectIds: string[];
  hosts: string;
}

function emptyForm(): ConnectionForm {
  return {
    mode: "create",
    name: "",
    description: "",
    value: "",
    allProjects: true,
    projectIds: [],
    hosts: "",
  };
}

function formFor(mode: "edit" | "replace", connection: CredentialConnection): ConnectionForm {
  return {
    mode,
    connection,
    name: connection.name,
    description: connection.description ?? "",
    value: "",
    allProjects: connection.projectIds === null,
    projectIds: connection.projectIds ?? [],
    hosts: connection.httpHosts.join("\n"),
  };
}

function parseHosts(text: string): string[] | null {
  const entries = text
    .split(/[\s,]+/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return normalizeCredentialHosts(entries);
}

export function CredentialsSettings() {
  const { machine: chosen } = useAccountMachine();
  const machine = isWindowMachine(chosen) ? undefined : chosen;
  // Keyed by machine, so a list read from another machine is never shown or acted on.
  const [read, setRead] = useState<{
    machine: typeof machine;
    overview: CredentialOverview;
    projects: Project[] | null;
    environments: Environment[];
  } | null>(null);
  const current = read?.machine === machine ? read : null;
  const overview = current?.overview ?? null;
  const projects = current?.projects;
  const environments = current?.environments;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState<ConnectionForm | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<CredentialConnection | null>(null);

  // Answers are applied in order and only for the machine still shown: a late
  // answer from a machine Settings has left must not replace this one.
  const sequence = useRef(0);
  const reload = useCallback(() => {
    const request = ++sequence.current;
    return Promise.all([
      backend.getCredentialOverview(machine),
      backend.getProjects(machine).catch(() => null),
    ])
      .then(async ([overview, projects]) => {
        if (request !== sequence.current) return;
        setRead((previous) => ({
          machine,
          overview,
          projects,
          environments: previous && previous.machine === machine ? previous.environments : [],
        }));
        setError(null);
        const ids = [...new Set(overview.grants.map((grant) => grant.environmentId))];
        const environments = await Promise.all(
          ids.map((id) => backend.getEnvironmentSnapshot(id, machine).catch(() => null)),
        );
        if (request === sequence.current) {
          setRead({
            machine,
            overview,
            projects,
            environments: environments.filter((row): row is Environment => Boolean(row)),
          });
        }
      })
      .catch((cause: unknown) => {
        if (request === sequence.current) setError(errorText(cause));
      });
  }, [machine]);

  useEffect(() => {
    void reload();
    const offChange = onResourceChanged("credential", () => void reload());
    const offSafety = onViewSafetyCheck(() => void reload());
    return () => {
      offChange();
      offSafety();
    };
  }, [reload]);

  const projectName = useCallback(
    (projectId: string) =>
      projects?.find((project) => project.id === projectId)?.name ??
      `Project ${projectId.slice(0, 8)}`,
    [projects],
  );
  const environmentName = useCallback(
    (environmentId: string) =>
      environments?.find((environment) => environment.id === environmentId)?.name ??
      `Environment ${environmentId.slice(0, 8)}`,
    [environments],
  );

  const act = async (key: string, label: string, run: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await run();
      await reload();
    } catch (cause) {
      toast.error(`Could not ${label}`, { description: errorText(cause) });
    } finally {
      setBusy(null);
    }
  };

  const formProblem = useMemo(() => {
    if (!form) return null;
    if (form.mode !== "replace" && !form.name.trim()) return "Give the credential a name.";
    if (form.mode !== "edit") {
      if (!form.value) return "Enter the value.";
      const problem = credentialValueProblem(form.value);
      if (problem) return problem;
    }
    if (form.mode !== "replace") {
      if (!form.allProjects) {
        if (!projects) return "Projects could not be loaded from this machine.";
        if (!form.projectIds.length) return "Choose at least one project.";
        if (form.projectIds.some((id) => !projects.some((project) => project.id === id)))
          return "Remove projects no longer available on this machine.";
      }
      if (parseHosts(form.hosts) === null) {
        return "Hosts are public host names such as api.example.com, at most 16.";
      }
    }
    return null;
  }, [form, projects]);

  const submitForm = async () => {
    if (!form || formProblem) return;
    setBusy("form");
    setFormError(null);
    try {
      const policy = {
        projectIds: form.allProjects ? null : form.projectIds,
        httpHosts: parseHosts(form.hosts) ?? [],
      };
      if (form.mode === "create") {
        await backend.createCredentialConnection(
          {
            name: form.name.trim(),
            ...(form.description.trim() ? { description: form.description.trim() } : {}),
            ...policy,
            value: form.value,
          },
          machine,
        );
      } else if (form.mode === "edit" && form.connection) {
        await backend.updateCredentialConnection(
          {
            id: form.connection.id,
            revision: form.connection.revision,
            name: form.name.trim(),
            description: form.description.trim(),
            ...policy,
          },
          machine,
        );
      } else if (form.mode === "replace" && form.connection) {
        const replaced = await backend.replaceCredentialConnectionValue(
          { id: form.connection.id, value: form.value },
          machine,
        );
        if (replaced.cleanupPending)
          toast.info("Removal of the previous value is pending. Orkestrator will retry.");
      }
      setForm(null);
      await reload();
    } catch (cause) {
      setFormError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

  const vault = overview?.vault;

  return (
    <SettingsPageLayout
      title="Credentials"
      description="Save API keys, tokens, and passwords for agents to request. Each approved grant can be used by any native agent tab in its environment and survives conversation changes until it expires, runs out of uses, or is revoked."
      actions={
        <Button
          size="sm"
          className="gap-1.5"
          disabled={!vault?.canSave || busy !== null}
          onClick={() => {
            setFormError(null);
            setForm(emptyForm());
          }}
        >
          <Plus className="h-3.5 w-3.5" aria-hidden /> Add credential
        </Button>
      }
    >
      {vault ? (
        <p className="text-xs text-muted-foreground" data-testid="credential-vault-status">
          {vault.detail}
        </p>
      ) : null}

      {error ? (
        <p className="rounded-md border border-failure/40 p-3 text-sm text-failure" role="alert">
          {error}
        </p>
      ) : null}

      {overview === null && !error ? (
        <div className="flex justify-center py-10" role="status" aria-label="Loading credentials">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : null}

      {overview ? (
        <section aria-label="Saved credentials" className="space-y-3">
          <SettingsSectionHeader title="Saved credentials">
            Each one lists the projects that may ask for it and the hosts Orkestrator may send it to
            in a trusted HTTPS request. Changing either, or replacing the value, ends every grant
            that uses it.
          </SettingsSectionHeader>
          {overview.connections.length === 0 ? (
            <div className="rounded-lg border border-dashed border-zinc-800 p-8 text-center text-sm text-muted-foreground">
              <KeyRound className="mx-auto mb-2 h-6 w-6" aria-hidden />
              No saved credentials. Add one here, or save a value from an agent's request card.
            </div>
          ) : (
            <ul className={cn(SETTINGS_CARD_CLASS, "divide-y divide-zinc-800")}>
              {overview.connections.map((connection) => (
                <li
                  key={connection.id}
                  className="flex flex-wrap items-center gap-3 p-3"
                  data-testid="credential-connection-row"
                >
                  <div className="min-w-0 flex-[1_1_16rem] space-y-0.5">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{connection.name}</span>
                      {connection.cleanupPending ? (
                        <span className="text-xs text-muted-foreground">
                          Previous value removal pending
                        </span>
                      ) : null}
                      {connection.status !== "ready" ? (
                        <span className="rounded bg-amber-400/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
                          Value unavailable
                        </span>
                      ) : null}
                    </div>
                    {connection.description ? (
                      <p className="text-xs text-muted-foreground">{connection.description}</p>
                    ) : null}
                    <p className="text-xs text-muted-foreground">
                      {connection.projectIds === null
                        ? "Every project"
                        : connection.projectIds.map(projectName).join(", ")}
                      {" · "}
                      {connection.httpHosts.length > 0
                        ? `HTTPS to ${connection.httpHosts.join(", ")}`
                        : "No HTTPS hosts"}
                      {" · "}
                      {STORAGE_LABELS[connection.storage]}
                      {" · "}Last used {formatTime(connection.lastUsedAt)}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      aria-label={`Edit ${connection.name}`}
                      title="Edit"
                      disabled={busy !== null}
                      onClick={() => {
                        setFormError(null);
                        setForm(formFor("edit", connection));
                      }}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      aria-label={`Replace the value of ${connection.name}`}
                      title="Replace value"
                      disabled={busy !== null || !vault?.canSave}
                      onClick={() => {
                        setFormError(null);
                        setForm(formFor("replace", connection));
                      }}
                    >
                      <RefreshCcw className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      aria-label={`Delete ${connection.name}`}
                      title="Delete"
                      disabled={busy !== null}
                      onClick={() => setConfirmDelete(connection)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {overview ? (
        <section aria-label="Active access" className="space-y-3">
          <SettingsSectionHeader title="Active access">
            Grants agents hold right now. Revoking one stops new uses at once and stops its running
            commands. It cannot take back a value a command already read: revoke the credential at
            its provider if that matters.
          </SettingsSectionHeader>
          {overview.grants.length === 0 ? (
            <p className="text-xs text-muted-foreground">No agent holds a credential grant.</p>
          ) : (
            <ul className={cn(SETTINGS_CARD_CLASS, "divide-y divide-zinc-800")}>
              {overview.grants.map((grant) => (
                <li
                  key={grant.id}
                  className="flex flex-wrap items-center gap-3 p-3"
                  data-testid="credential-grant-row"
                >
                  <div className="min-w-0 flex-[1_1_16rem] space-y-0.5">
                    <span className="text-sm font-medium">{grant.label}</span>
                    <p className="text-xs text-muted-foreground">
                      {environmentName(grant.environmentId)} ·{" "}
                      {grant.source.kind === "connection"
                        ? grant.source.connectionName
                        : "Temporary value"}{" "}
                      · {describeCredentialUse(grant)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Until {formatTime(grant.expiresAt)} · used {grant.uses}
                      {grant.maxUses !== null ? ` of ${grant.maxUses}` : ""}{" "}
                      {grant.uses === 1 ? "time" : "times"}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    disabled={busy !== null}
                    onClick={() =>
                      void act(grant.id, "revoke the grant", () =>
                        backend.revokeCredentialGrant(grant.id, machine),
                      )
                    }
                  >
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {overview && overview.operations.length > 0 ? (
        <section aria-label="Recent uses" className="space-y-3">
          <SettingsSectionHeader title="Recent uses">
            The last commands and requests agents ran with a credential. Output is never kept here.
          </SettingsSectionHeader>
          <ul className={cn(SETTINGS_CARD_CLASS, "divide-y divide-zinc-800 text-xs")}>
            {overview.operations.slice(0, 20).map((operation) => (
              <li
                key={operation.id}
                className="flex flex-wrap items-center gap-3 px-3 py-2"
                data-testid="credential-operation-row"
              >
                <code className="min-w-0 flex-[1_1_16rem] truncate font-mono">
                  {operation.summary}
                </code>
                <span className="text-muted-foreground">
                  {environmentName(operation.environmentId)}
                </span>
                <span>{operation.state.replaceAll("_", " ")}</span>
                <span className="text-muted-foreground">{formatTime(operation.createdAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <Dialog open={form !== null} onOpenChange={(open) => !open && setForm(null)}>
        <DialogContent
          size="lg"
          className={Z_FULLSCREEN_DIALOG}
          overlayClassName={Z_FULLSCREEN_DIALOG}
        >
          <DialogHeader>
            <DialogTitle>
              {form?.mode === "create"
                ? "Add a credential"
                : form?.mode === "replace"
                  ? `Replace the value of ${form.connection?.name ?? ""}`
                  : `Edit ${form?.connection?.name ?? ""}`}
            </DialogTitle>
            <DialogDescription>
              {form?.mode === "replace"
                ? "Grants that use the current value end when it is replaced."
                : "Values are stored on this machine only and can never be shown again."}
            </DialogDescription>
          </DialogHeader>
          {form ? (
            <form
              className="space-y-3 text-sm"
              onSubmit={(event) => {
                event.preventDefault();
                void submitForm();
              }}
            >
              {form.mode !== "replace" ? (
                <>
                  <label className="block space-y-1">
                    <span className="text-xs font-medium">Name</span>
                    <Input
                      value={form.name}
                      maxLength={CREDENTIAL_LIMITS.nameMaxChars}
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                    />
                  </label>
                  <label className="block space-y-1">
                    <span className="text-xs font-medium">Description (optional)</span>
                    <Input
                      value={form.description}
                      maxLength={CREDENTIAL_LIMITS.descriptionMaxChars}
                      onChange={(event) => setForm({ ...form, description: event.target.value })}
                    />
                  </label>
                </>
              ) : null}
              {form.mode !== "edit" ? (
                <div className="space-y-1">
                  <span className="text-xs font-medium">Value</span>
                  <CredentialValueInput
                    value={form.value}
                    onValueChange={(value) => setForm({ ...form, value })}
                  />
                  <span className="block text-[11px] text-muted-foreground">
                    Paste multiline values to preserve line breaks. {vault?.detail}
                  </span>
                </div>
              ) : null}
              {form.mode !== "replace" ? (
                <>
                  <fieldset className="space-y-1.5">
                    <legend className="text-xs font-medium">Projects that may ask for it</legend>
                    <label className="flex items-center gap-2 text-xs">
                      <Checkbox
                        checked={form.allProjects}
                        onCheckedChange={(checked) =>
                          setForm({ ...form, allProjects: checked === true })
                        }
                      />
                      Every project on this machine
                    </label>
                    {!form.allProjects ? (
                      <div className="max-h-40 space-y-1 overflow-y-auto rounded border border-zinc-800 p-2">
                        {!projects ? (
                          <p className="text-xs text-muted-foreground">
                            Projects are unavailable on this machine.
                          </p>
                        ) : projects.length === 0 ? (
                          <p className="text-xs text-muted-foreground">
                            This machine has no projects.
                          </p>
                        ) : null}
                        {form.projectIds
                          .filter(
                            (id) => projects && !projects.some((project) => project.id === id),
                          )
                          .map((id) => (
                            <label key={id} className="flex items-center gap-2 text-xs">
                              <Checkbox
                                checked
                                onCheckedChange={() =>
                                  setForm({
                                    ...form,
                                    projectIds: form.projectIds.filter((each) => each !== id),
                                  })
                                }
                              />
                              {projectName(id)} (unavailable)
                            </label>
                          ))}
                        {projects?.map((project) => (
                          <label key={project.id} className="flex items-center gap-2 text-xs">
                            <Checkbox
                              checked={form.projectIds.includes(project.id)}
                              onCheckedChange={(checked) =>
                                setForm({
                                  ...form,
                                  projectIds:
                                    checked === true
                                      ? [...form.projectIds, project.id]
                                      : form.projectIds.filter((id) => id !== project.id),
                                })
                              }
                            />
                            {project.name}
                          </label>
                        ))}
                      </div>
                    ) : null}
                  </fieldset>
                  <label className="block space-y-1">
                    <span className="text-xs font-medium">
                      Hosts for trusted HTTPS requests (optional)
                    </span>
                    <Textarea
                      rows={2}
                      placeholder="api.example.com"
                      value={form.hosts}
                      onChange={(event) => setForm({ ...form, hosts: event.target.value })}
                    />
                    <span className="block text-[11px] text-muted-foreground">
                      One per line. Orkestrator attaches this credential only to HTTPS requests to
                      these hosts. Leave empty to allow commands only.
                    </span>
                  </label>
                </>
              ) : null}
              {formProblem && (form.value || form.mode === "edit") ? (
                <p className="text-xs text-failure">{formProblem}</p>
              ) : null}
              {formError ? (
                <p className="text-xs text-failure" role="alert">
                  {formError}
                </p>
              ) : null}
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setForm(null)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={formProblem !== null || busy !== null}>
                  {form.mode === "create" ? "Save" : form.mode === "replace" ? "Replace" : "Save"}
                </Button>
              </DialogFooter>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={confirmDelete !== null}
        onOpenChange={(open) => !open && setConfirmDelete(null)}
      >
        <AlertDialogContent className={Z_FULLSCREEN_DIALOG} overlayClassName={Z_FULLSCREEN_DIALOG}>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {confirmDelete?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Orkestrator forgets the value and every grant that uses it ends now. The credential
              itself stays valid at its provider; revoke it there too if it may have leaked.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const target = confirmDelete;
                setConfirmDelete(null);
                if (target) {
                  void act(target.id, "delete the credential", async () => {
                    const result = await backend.deleteCredentialConnection(target.id, machine);
                    if (result.cleanupPending)
                      toast.info("Access ended. Orkestrator will retry removing the saved value.");
                  });
                }
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsPageLayout>
  );
}
