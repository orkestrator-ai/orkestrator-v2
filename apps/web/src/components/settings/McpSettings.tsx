import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  CircleDot,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Mic,
  Plus,
  RotateCw,
  Server,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import {
  CONTROL_MCP_GRANTABLE_CAPABILITIES,
  CONTROL_MCP_PROFILES,
  type ControlMcpCredentialSummary,
  type ControlMcpProfile,
} from "@orkestrator/protocol/control-mcp";
import type { PublicCapability } from "@orkestrator/protocol/public-api-inputs";
import { CodexIcon, ClaudeIcon } from "@/components/icons/AgentIcons";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Z_FULLSCREEN_DIALOG, Z_FULLSCREEN_DIALOG_POPOVER } from "@/constants/z-index";
import { useTimedCopyFeedback } from "@/hooks";
import * as backend from "@/lib/backend";
import { listenAuthoritative } from "@/lib/native/authoritative-events";
import { cn } from "@/lib/utils";

const PROFILE_TEXT: Record<ControlMcpProfile, { label: string; description: string }> = {
  voice: {
    label: "Voice",
    description:
      "Twelve tools shaped for spoken requests, short answers, and a spoken confirmation before risky actions. No project, settings, destructive or command-running actions.",
  },
  full: {
    label: "Full",
    description:
      "Every tool, including one per Orkestrator action. For coding agents whose client searches or defers tools.",
  },
  "read-only": {
    label: "Read only",
    description: "Every read tool. Nothing this credential calls can change anything.",
  },
  custom: {
    label: "Custom",
    description: "The full tool set, limited to the capabilities you choose.",
  },
};

const CAPABILITY_TEXT: Record<string, string> = {
  discovery: "Discovery: projects, environments, runs",
  "sessions.read": "Read sessions and transcripts",
  "sessions.control": "Start, prompt, steer and stop sessions",
  interactions: "Answer questions and approvals",
  "environments.lifecycle": "Create, start and stop environments",
  "environments.destructive": "Delete and recreate environments, merge pull requests",
  exec: "Run commands in environments",
  projects: "Add, create and remove projects",
  settings: "Change project and environment settings",
  tickets: "Kanban tickets",
  mail: "Agent mail",
};

function formatLastUsed(value: string | null): string {
  if (!value) return "Never used";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Used" : `Last used ${date.toLocaleString()}`;
}

function SetupRecipe({
  icon,
  title,
  description,
  value,
  displayValue = value,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  value: string;
  displayValue?: string;
}) {
  const { copied, copy } = useTimedCopyFeedback();

  return (
    <section className="overflow-hidden rounded-lg border border-white/10 bg-zinc-950/60">
      <div className="flex items-center justify-between gap-4 border-b border-white/8 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          {icon}
          <div className="min-w-0">
            <h3 className="text-sm font-medium text-foreground">{title}</h3>
            <p className="text-xs text-muted-foreground">{description}</p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="shrink-0 gap-2"
          onClick={() => void copy(value)}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? "Copied" : "Copy setup"}
        </Button>
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap break-all px-4 py-3 font-mono text-xs leading-5 text-zinc-300">
        {displayValue}
      </pre>
    </section>
  );
}

function ConfirmAction({
  trigger,
  title,
  description,
  action,
  onConfirm,
}: {
  trigger: React.ReactNode;
  title: string;
  description: string;
  action: string;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
      <AlertDialogContent className={Z_FULLSCREEN_DIALOG} overlayClassName={Z_FULLSCREEN_DIALOG}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>{action}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function CreateCredentialForm({
  busy,
  onCreate,
}: {
  busy: boolean;
  onCreate: (input: backend.CreateControlMcpCredentialInput) => Promise<void>;
}) {
  const [label, setLabel] = useState("");
  const [profile, setProfile] = useState<ControlMcpProfile>("voice");
  const [capabilities, setCapabilities] = useState<PublicCapability[]>(["discovery"]);
  const canCreate =
    label.trim().length > 0 && (profile !== "custom" || capabilities.length > 0) && !busy;

  return (
    <form
      className="space-y-3 rounded-lg border border-white/10 bg-zinc-900/45 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canCreate) return;
        void onCreate({
          label: label.trim(),
          profile,
          ...(profile === "custom" ? { capabilities } : {}),
        }).then(() => setLabel(""));
      }}
    >
      <h3 className="text-sm font-medium text-foreground">New credential</h3>
      <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
        <div className="space-y-1.5">
          <Label htmlFor="mcp-credential-label">Name</Label>
          <Input
            id="mcp-credential-label"
            value={label}
            placeholder="Voice assistant"
            maxLength={80}
            onChange={(event) => setLabel(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="mcp-credential-profile">Profile</Label>
          <Select value={profile} onValueChange={(value) => setProfile(value as ControlMcpProfile)}>
            <SelectTrigger id="mcp-credential-profile" aria-label="Profile">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className={Z_FULLSCREEN_DIALOG_POPOVER}>
              {CONTROL_MCP_PROFILES.map((option) => (
                <SelectItem key={option} value={option}>
                  {PROFILE_TEXT[option].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <p className="text-xs leading-5 text-muted-foreground">{PROFILE_TEXT[profile].description}</p>
      {profile === "custom" && (
        <fieldset className="grid gap-2 sm:grid-cols-2">
          <legend className="sr-only">Capabilities</legend>
          {CONTROL_MCP_GRANTABLE_CAPABILITIES.map((capability) => {
            const id = `mcp-capability-${capability}`;
            return (
              <div key={capability} className="flex items-center gap-2 text-xs">
                <Checkbox
                  id={id}
                  checked={capabilities.includes(capability)}
                  onCheckedChange={(checked) =>
                    setCapabilities((current) =>
                      checked === true
                        ? [...current, capability]
                        : current.filter((entry) => entry !== capability),
                    )
                  }
                />
                <Label htmlFor={id} className="text-xs font-normal">
                  {CAPABILITY_TEXT[capability] ?? capability}
                </Label>
              </div>
            );
          })}
        </fieldset>
      )}
      <div className="flex justify-end">
        <Button type="submit" size="sm" className="gap-2" disabled={!canCreate}>
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Plus className="h-3.5 w-3.5" />
          )}
          Create credential
        </Button>
      </div>
    </form>
  );
}

export function McpSettings() {
  const [settings, setSettings] = useState<backend.ControlMcpSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const { copied: urlCopied, copy: copyUrl } = useTimedCopyFeedback();
  const { copied: tokenCopied, copy: copyToken } = useTimedCopyFeedback();

  // Fetch only: the initial state is already loading, and Try again resets
  // it itself, so the mount effect never sets state synchronously.
  const fetchSettings = useCallback(
    () =>
      backend
        .getControlMcpSettings()
        .then(
          (loaded) => {
            setSettings(loaded);
            setLoadError(null);
          },
          (error: unknown) => {
            setLoadError(error instanceof Error ? error.message : String(error));
          },
        )
        .finally(() => setLoading(false)),
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    // Subscribe before the snapshot, and refresh after any replay gap.
    void listenAuthoritative("control-mcp-state-changed", fetchSettings, {
      onResync: fetchSettings,
      signal: controller.signal,
      resyncOnSubscribe: true,
    }).catch(() => {
      if (!controller.signal.aborted) void fetchSettings();
    });
    return () => controller.abort();
  }, [fetchSettings]);

  const retry = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    void fetchSettings();
  }, [fetchSettings]);

  const credentials = useMemo(() => settings?.credentials ?? [], [settings]);
  const selected: ControlMcpCredentialSummary | null =
    credentials.find((credential) => credential.id === selectedId) ?? credentials[0] ?? null;

  const change = useCallback(
    async (
      run: () => Promise<backend.ControlMcpSettings>,
      success: string,
      failure: string,
      select?: (next: backend.ControlMcpSettings) => string | null,
    ) => {
      setBusy(true);
      try {
        const next = await run();
        setSettings(next);
        if (select) setSelectedId(select(next));
        toast.success(success);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : failure);
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const recipes = useMemo(() => {
    if (!settings || !selected) return null;
    const { url } = settings;
    const { token } = selected;
    return {
      codex: `[mcp_servers.orkestrator]\nurl = "${url}"\nhttp_headers = { Authorization = "Bearer ${token}" }`,
      claude: `claude mcp add --scope user --transport http orkestrator ${url} --header "Authorization: Bearer ${token}"`,
      other: JSON.stringify(
        { url, transport: "streamable-http", headers: { Authorization: `Bearer ${token}` } },
        null,
        2,
      ),
    };
  }, [settings, selected]);

  if (loading && !settings) {
    return (
      <div
        className="flex items-center justify-center py-16"
        role="status"
        aria-label="Loading MCP settings"
      >
        <Loader2 className="h-7 w-7 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (loadError || !settings) {
    return (
      <div className="mx-auto max-w-3xl rounded-lg border border-red-500/20 bg-red-500/5 p-5">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-400" />
          <div className="space-y-3">
            <div>
              <h2 className="text-sm font-medium text-foreground">MCP settings are unavailable</h2>
              <p className="mt-1 text-sm text-muted-foreground">{loadError}</p>
            </div>
            <Button variant="outline" size="sm" onClick={retry}>
              Try again
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const available = settings.enabled && settings.running && !settings.error;
  const maskToken = (value: string) =>
    selected?.token ? value.replace(selected.token, "••••••••••••") : value;

  return (
    <div className="mx-auto max-w-3xl space-y-6 pb-8">
      <div className="flex flex-col gap-4 border-b border-white/10 pb-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="max-w-2xl">
          <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.16em] text-blue-300">
            <CircleDot className={cn("h-3.5 w-3.5", available && "text-emerald-400")} />
            {available ? "Listening locally" : "Not available"}
          </div>
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            Control Orkestrator from another agent
          </h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            {available
              ? "Give each client its own credential and copy its setup below. Addresses and tokens stay the same across app restarts."
              : "The setup details will appear after the local MCP server is available."}
          </p>
        </div>
      </div>

      {settings.error && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
          <div>
            <p className="font-medium text-foreground">The local MCP server could not start</p>
            <p className="mt-1 text-muted-foreground">{settings.error}</p>
          </div>
        </div>
      )}

      {available ? (
        <>
          <div className="rounded-lg border border-white/10 bg-zinc-900/45 p-4">
            <div className="mb-3 flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <Server className="h-3.5 w-3.5" />
              Server URL
            </div>
            <div className="flex gap-2">
              <Input value={settings.url} readOnly className="font-mono text-xs" />
              <Button
                variant="outline"
                size="icon"
                className="shrink-0"
                aria-label={urlCopied ? "Server URL copied" : "Copy server URL"}
                onClick={() => void copyUrl(settings.url)}
              >
                {urlCopied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
          </div>

          <section className="space-y-3" aria-labelledby="mcp-credentials-heading">
            <div>
              <h2 id="mcp-credentials-heading" className="text-sm font-medium text-foreground">
                Credentials
              </h2>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Each credential has its own token, profile and allowed actions. Rotating or revoking
                one never affects the others.
              </p>
            </div>
            {credentials.length === 0 && (
              <p className="rounded-lg border border-white/10 bg-zinc-900/45 p-4 text-sm text-muted-foreground">
                No credentials. Create one below to connect a client.
              </p>
            )}
            <ul className="space-y-2">
              {credentials.map((credential) => {
                const isSelected = credential.id === selected?.id;
                return (
                  <li
                    key={credential.id}
                    className={cn(
                      "flex flex-col gap-3 rounded-lg border bg-zinc-900/45 p-3 sm:flex-row sm:items-center sm:justify-between",
                      isSelected ? "border-blue-400/40" : "border-white/10",
                    )}
                  >
                    <button
                      type="button"
                      className="min-w-0 text-left"
                      aria-pressed={isSelected}
                      aria-label={`Show setup for ${credential.label}`}
                      onClick={() => {
                        setSelectedId(credential.id);
                        setShowToken(false);
                      }}
                    >
                      <div className="flex items-center gap-2">
                        {credential.profile === "voice" ? (
                          <Mic className="h-3.5 w-3.5 text-blue-300" />
                        ) : (
                          <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
                        )}
                        <span className="truncate text-sm font-medium text-foreground">
                          {credential.label}
                        </span>
                        <span className="rounded border border-white/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                          {PROFILE_TEXT[credential.profile].label}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {credential.capabilities.length} capabilities ·{" "}
                        {formatLastUsed(credential.lastUsedAt)}
                      </p>
                    </button>
                    <div className="flex shrink-0 gap-2">
                      <ConfirmAction
                        trigger={
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 gap-1.5 px-2 text-xs"
                            disabled={busy}
                            aria-label={`Rotate ${credential.label}`}
                          >
                            <RotateCw className="h-3 w-3" />
                            Rotate
                          </Button>
                        }
                        title={`Rotate ${credential.label}'s token?`}
                        description="The client using it stops connecting until you copy its updated setup. Other credentials keep working."
                        action="Rotate token"
                        onConfirm={() =>
                          void change(
                            () => backend.rotateControlMcpCredential(credential.id),
                            "MCP token rotated",
                            "Could not rotate the MCP token",
                            () => credential.id,
                          ).then(() => setShowToken(true))
                        }
                      />
                      <ConfirmAction
                        trigger={
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 gap-1.5 px-2 text-xs text-red-300 hover:text-red-200"
                            disabled={busy}
                            aria-label={`Revoke ${credential.label}`}
                          >
                            <Trash2 className="h-3 w-3" />
                            Revoke
                          </Button>
                        }
                        title={`Revoke ${credential.label}?`}
                        description="The client using it is refused from its next request. This cannot be undone; create a new credential to reconnect it."
                        action="Revoke"
                        onConfirm={() =>
                          void change(
                            () => backend.revokeControlMcpCredential(credential.id),
                            "MCP credential revoked",
                            "Could not revoke the MCP credential",
                            (next) => next.credentials[0]?.id ?? null,
                          )
                        }
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
            <CreateCredentialForm
              busy={busy}
              onCreate={(input) =>
                change(
                  () => backend.createControlMcpCredential(input),
                  "MCP credential created",
                  "Could not create the MCP credential",
                  (next) => next.credentials.at(-1)?.id ?? null,
                )
              }
            />
          </section>

          {selected && recipes && (
            <section className="space-y-3" aria-labelledby="mcp-setup-heading">
              <h2 id="mcp-setup-heading" className="text-sm font-medium text-foreground">
                Set up a client with {selected.label}
              </h2>
              <div className="rounded-lg border border-white/10 bg-zinc-900/45 p-4">
                <div className="mb-3 flex items-center gap-2 text-xs font-medium text-muted-foreground">
                  <KeyRound className="h-3.5 w-3.5" />
                  Access token
                </div>
                <div className="flex gap-2">
                  <Input
                    value={selected.token}
                    readOnly
                    type={showToken ? "text" : "password"}
                    className="font-mono text-xs"
                    aria-label={`${selected.label} access token`}
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    className="shrink-0"
                    aria-label={showToken ? "Hide access token" : "Show access token"}
                    onClick={() => setShowToken((value) => !value)}
                  >
                    {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    className="shrink-0"
                    aria-label={tokenCopied ? "Access token copied" : "Copy access token"}
                    onClick={() => void copyToken(selected.token)}
                  >
                    {tokenCopied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
              </div>
              <SetupRecipe
                icon={<CodexIcon className="h-4 w-4 text-emerald-400" />}
                title="Codex"
                description="Paste into ~/.codex/config.toml"
                value={recipes.codex}
                displayValue={maskToken(recipes.codex)}
              />
              <SetupRecipe
                icon={<ClaudeIcon className="h-4 w-4" />}
                title="Claude Code"
                description="Paste once into a terminal"
                value={recipes.claude}
                displayValue={maskToken(recipes.claude)}
              />
              <SetupRecipe
                icon={<Mic className="h-4 w-4 text-blue-300" />}
                title="Other or voice client"
                description="Streamable HTTP: this URL with this Authorization header"
                value={recipes.other}
                displayValue={maskToken(recipes.other)}
              />
            </section>
          )}
        </>
      ) : (
        <div className="rounded-lg border border-white/10 bg-zinc-900/45 p-4 text-sm text-muted-foreground">
          {settings.enabled
            ? "The local MCP server is not running. Resolve the startup error above and try again."
            : "The local MCP server is disabled for this installation."}
        </div>
      )}

      <p className="text-xs leading-5 text-muted-foreground">
        The server only listens on this computer; a hosted voice platform reaches it through a relay
        you run here. Treat every token like a password: a Full credential can create environments,
        launch jobs, read transcripts and update tickets.
      </p>
    </div>
  );
}
