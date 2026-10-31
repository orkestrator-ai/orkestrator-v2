import { useCallback, useEffect, useMemo, useState } from "react";
import { FileLock2, Loader2, ShieldCheck, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { AGENT_PLATFORM_LABELS } from "@orkestrator/protocol/agent-platforms";
import {
  describePermissionRule,
  type ExternalPermissionRuleFile,
  type NativeAgentPermissionRule,
} from "@orkestrator/protocol/permission-rules";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Z_FULLSCREEN_DIALOG, Z_FULLSCREEN_DIALOG_POPOVER } from "@/constants/z-index";
import * as backend from "@/lib/backend";
import { onResourceChanged, onViewSafetyCheck } from "@/lib/resource-sync";
import { useEnvironmentStore, useProjectStore } from "@/stores";
import { isWindowMachine, useAccountMachine } from "./account-machine";
import {
  SETTINGS_CARD_CLASS,
  SettingsPageLayout,
  SettingsSectionHeader,
} from "./SettingsPageLayout";
import { cn } from "@/lib/utils";

/**
 * Settings → Permissions: the "always allow" rules Orkestrator keeps and
 * applies itself (todo 0723), per machine. Each rule answers matching agent
 * requests with a one-time approval, so removing it here takes effect on the
 * very next request. Rules are created only from an approval card.
 *
 * Below them, read-only, the rules the providers keep in their own files —
 * listed so they can be found and removed in the provider, never edited here.
 */

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function providerLabel(provider: string): string {
  if (provider === "any") return "Any agent";
  return (AGENT_PLATFORM_LABELS as Record<string, string | undefined>)[provider] ?? provider;
}

function formatTime(epochMs: number | undefined): string {
  return epochMs === undefined ? "Never" : new Date(epochMs).toLocaleString();
}

const KIND_FILTERS = [
  { value: "all", label: "All kinds" },
  { value: "command-prefix", label: "Commands" },
  { value: "file-path", label: "File changes" },
  { value: "network-host", label: "Network hosts" },
  { value: "mcp-tool", label: "MCP tools" },
] as const;

export function PermissionsSettings() {
  const { machine: chosen } = useAccountMachine();
  const machine = isWindowMachine(chosen) ? undefined : chosen;
  const projects = useProjectStore((state) => state.projects);
  const environments = useEnvironmentStore((state) => state.environments);
  const [rules, setRules] = useState<NativeAgentPermissionRule[] | null>(null);
  // When the list was read; expiry is shown against it, not the render clock.
  const [readAt, setReadAt] = useState(0);
  const [external, setExternal] = useState<ExternalPermissionRuleFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [provider, setProvider] = useState("all");
  const [kind, setKind] = useState<string>("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<
    | { kind: "rule"; rule: NativeAgentPermissionRule }
    | { kind: "project"; projectId: string }
    | null
  >(null);

  // State changes only once the read settles, so the mount effect never sets
  // state synchronously.
  const reload = useCallback(
    () =>
      backend.listPermissionRules({}, machine).then(
        (snapshot) => {
          setRules(snapshot.rules);
          setReadAt(Date.now());
          setError(null);
        },
        (cause: unknown) => setError(errorText(cause)),
      ),
    [machine],
  );
  const reloadExternal = useCallback(
    () =>
      backend.listExternalPermissionRules(undefined, machine).then(
        (snapshot) => setExternal(snapshot.files),
        () => setExternal([]),
      ),
    [machine],
  );

  useEffect(() => {
    void reload();
    void reloadExternal();
    const offChange = onResourceChanged("permission-rule", () => void reload());
    const offSafety = onViewSafetyCheck(() => void reload());
    return () => {
      offChange();
      offSafety();
    };
  }, [reload, reloadExternal]);

  const projectName = useCallback(
    (projectId: string) =>
      projects.find((project) => project.id === projectId)?.name ??
      `Project ${projectId.slice(0, 8)}`,
    [projects],
  );
  const environmentName = useCallback(
    (environmentId: string | undefined) =>
      environmentId
        ? (environments.find((environment) => environment.id === environmentId)?.name ??
          `Environment ${environmentId.slice(0, 8)}`)
        : "",
    [environments],
  );

  const grouped = useMemo(() => {
    const groups = new Map<string, NativeAgentPermissionRule[]>();
    for (const rule of rules ?? []) {
      if (provider !== "all" && rule.provider !== provider) continue;
      if (kind !== "all" && rule.kind !== kind) continue;
      const list = groups.get(rule.projectId) ?? [];
      list.push(rule);
      groups.set(rule.projectId, list);
    }
    return [...groups.entries()].sort(([left], [right]) =>
      projectName(left).localeCompare(projectName(right)),
    );
  }, [rules, provider, kind, projectName]);

  const providers = useMemo(
    () => [...new Set((rules ?? []).map((rule) => rule.provider))].sort(),
    [rules],
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

  return (
    <SettingsPageLayout
      title="Permissions"
      description="Rules saved with “Approve and remember” on an approval card. Orkestrator answers a matching request with a one-time approval, so a rule you remove stops applying at the very next request. Rules never apply to coordinators, pipelines, reviews, plan mode or anything an agent's policy denies, and they are kept on this machine only."
    >
      <div className="flex flex-wrap gap-2">
        <Select value={provider} onValueChange={setProvider}>
          <SelectTrigger className="h-8 w-40" aria-label="Filter by agent">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className={Z_FULLSCREEN_DIALOG_POPOVER}>
            <SelectItem value="all">All agents</SelectItem>
            {providers.map((value) => (
              <SelectItem key={value} value={value}>
                {providerLabel(value)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={kind} onValueChange={setKind}>
          <SelectTrigger className="h-8 w-40" aria-label="Filter by kind">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className={Z_FULLSCREEN_DIALOG_POPOVER}>
            {KIND_FILTERS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {error ? (
        <p className="rounded-md border border-red-500/40 p-3 text-sm text-red-300" role="alert">
          {error}
        </p>
      ) : null}

      {rules === null && !error ? (
        <div className="flex justify-center py-10" role="status" aria-label="Loading rules">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : null}

      {rules !== null && grouped.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-800 p-8 text-center text-sm text-muted-foreground">
          <ShieldCheck className="mx-auto mb-2 h-6 w-6" aria-hidden="true" />
          {rules.length === 0
            ? "No rules yet. Use “Approve and remember…” on an approval card to save one."
            : "No rules match these filters."}
        </div>
      ) : null}

      {grouped.map(([projectId, projectRules]) => (
        <section key={projectId} aria-label={`Rules for ${projectName(projectId)}`}>
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="text-sm font-medium">{projectName(projectId)}</h3>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs"
              disabled={busy !== null}
              onClick={() => setConfirm({ kind: "project", projectId })}
            >
              Remove all
            </Button>
          </div>
          <ul className={cn(SETTINGS_CARD_CLASS, "divide-y divide-zinc-800")}>
            {projectRules.map((rule) => {
              const expired = rule.expiresAt !== undefined && rule.expiresAt <= readAt;
              return (
                <li
                  key={rule.id}
                  className="flex flex-wrap items-center gap-3 p-3"
                  data-testid="permission-rule-row"
                >
                  <div className="min-w-0 flex-[1_1_16rem]">
                    <code className="break-all font-mono text-xs">{rule.pattern}</code>
                    <p className="text-xs text-muted-foreground">
                      {describePermissionRule(rule)} · {providerLabel(rule.provider)} ·{" "}
                      {rule.scope === "environment"
                        ? environmentName(rule.environmentId)
                        : "Whole project"}
                      {rule.expiresAt !== undefined
                        ? ` · ${expired ? "Expired" : "Expires"} ${formatTime(rule.expiresAt)}`
                        : ""}
                    </p>
                  </div>
                  <div className="w-44 text-right text-xs">
                    <div className="text-muted-foreground">
                      Used {rule.useCount} {rule.useCount === 1 ? "time" : "times"}
                    </div>
                    <div>Last {formatTime(rule.lastUsedAt)}</div>
                  </div>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    aria-label={`Remove rule ${rule.pattern}`}
                    title="Remove rule"
                    disabled={busy !== null}
                    onClick={() => setConfirm({ kind: "rule", rule })}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      <section aria-label="Rules outside Orkestrator" className="space-y-3">
        <SettingsSectionHeader title="Rules outside Orkestrator">
          Rules the agents keep in their own files: Codex <code>rules/*.rules</code> (including any
          saved by older Orkestrator versions) and Claude <code>permissions.allow</code>.
          Orkestrator does not change these; edit them in the agent.
        </SettingsSectionHeader>
        {external === null ? (
          <div className="flex justify-center py-4" role="status" aria-label="Loading rule files">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : external.length === 0 ? (
          <p className="text-xs text-muted-foreground">None found on this machine.</p>
        ) : (
          <ul className="space-y-2">
            {external.map((file) => (
              <li
                key={`${file.provider}:${file.environmentId ?? ""}:${file.path}`}
                className={cn(SETTINGS_CARD_CLASS, "p-3")}
                data-testid="external-rule-file"
              >
                <div className="flex items-center gap-2 text-xs">
                  <FileLock2 className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                  <span className="font-medium">
                    {providerLabel(file.provider)} · {file.label}
                  </span>
                </div>
                <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                  {file.path}
                </p>
                {file.error ? (
                  <p className="mt-1 text-xs text-amber-300">{file.error}</p>
                ) : (
                  <pre className="mt-2 max-h-48 overflow-auto rounded bg-black/30 p-2 font-mono text-[11px]">
                    {file.entries.join("\n")}
                    {file.truncated ? "\n…" : ""}
                  </pre>
                )}
                <p className="mt-2 text-xs text-muted-foreground">{file.guidance}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent className={Z_FULLSCREEN_DIALOG} overlayClassName={Z_FULLSCREEN_DIALOG}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.kind === "project"
                ? `Remove every rule for ${projectName(confirm.projectId)}?`
                : "Remove this rule?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              Matching requests ask again from the next one on. Nothing an agent already ran is
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const target = confirm;
                setConfirm(null);
                if (target?.kind === "rule") {
                  void act(target.rule.id, "remove the rule", () =>
                    backend.deletePermissionRule(target.rule.id, machine),
                  );
                } else if (target?.kind === "project") {
                  void act(target.projectId, "remove the rules", () =>
                    backend.deleteProjectPermissionRules(target.projectId, machine),
                  );
                }
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsPageLayout>
  );
}
