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
  RotateCw,
  Server,
} from "lucide-react";
import { toast } from "sonner";
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
import { Input } from "@/components/ui/input";
import { Z_FULLSCREEN_DIALOG } from "@/constants/z-index";
import { useTimedCopyFeedback } from "@/hooks";
import * as backend from "@/lib/backend";
import { cn } from "@/lib/utils";

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

export function McpSettings() {
  const [settings, setSettings] = useState<backend.ControlMcpSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [rotating, setRotating] = useState(false);
  const { copied: urlCopied, copy: copyUrl } = useTimedCopyFeedback();
  const { copied: tokenCopied, copy: copyToken } = useTimedCopyFeedback();

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setSettings(await backend.getControlMcpSettings());
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rotateToken = useCallback(async () => {
    setRotating(true);
    try {
      const next = await backend.rotateControlMcpToken();
      setSettings(next);
      setShowToken(true);
      toast.success("MCP token rotated");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not rotate the MCP token");
    } finally {
      setRotating(false);
    }
  }, []);

  const codexSetup = useMemo(() => {
    if (!settings) return "";
    return `[mcp_servers.orkestrator]\nurl = "${settings.url}"\nhttp_headers = { Authorization = "Bearer ${settings.token}" }`;
  }, [settings]);
  const claudeSetup = useMemo(() => {
    if (!settings) return "";
    return `claude mcp add --scope user --transport http orkestrator ${settings.url} --header "Authorization: Bearer ${settings.token}"`;
  }, [settings]);

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
            <Button variant="outline" size="sm" onClick={() => void load()}>
              Try again
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const available = settings.enabled && settings.running && !settings.error;
  const maskToken = (value: string) =>
    settings.token ? value.replace(settings.token, "••••••••••••") : value;

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
              ? "Copy one setup block below. The address and token stay the same across app restarts."
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
          <div className="grid gap-4 sm:grid-cols-2">
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

            <div className="rounded-lg border border-white/10 bg-zinc-900/45 p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                  <KeyRound className="h-3.5 w-3.5" />
                  Access token
                </div>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 gap-1.5 px-2 text-xs"
                      disabled={rotating}
                    >
                      <RotateCw className={cn("h-3 w-3", rotating && "animate-spin")} />
                      Rotate
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent
                    className={Z_FULLSCREEN_DIALOG}
                    overlayClassName={Z_FULLSCREEN_DIALOG}
                  >
                    <AlertDialogHeader>
                      <AlertDialogTitle>Rotate the MCP token?</AlertDialogTitle>
                      <AlertDialogDescription>
                        Codex and Claude Code will stop connecting until you copy their updated
                        setup. The server URL will not change.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={() => void rotateToken()}>
                        Rotate token
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
              <div className="flex gap-2">
                <Input
                  value={settings.token}
                  readOnly
                  type={showToken ? "text" : "password"}
                  className="font-mono text-xs"
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
                  onClick={() => void copyToken(settings.token)}
                >
                  {tokenCopied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
            </div>
          </div>

          <div className="space-y-3">
            <SetupRecipe
              icon={<CodexIcon className="h-4 w-4 text-emerald-400" />}
              title="Codex"
              description="Paste into ~/.codex/config.toml"
              value={codexSetup}
              displayValue={maskToken(codexSetup)}
            />
            <SetupRecipe
              icon={<ClaudeIcon className="h-4 w-4" />}
              title="Claude Code"
              description="Paste once into a terminal"
              value={claudeSetup}
              displayValue={maskToken(claudeSetup)}
            />
          </div>
        </>
      ) : (
        <div className="rounded-lg border border-white/10 bg-zinc-900/45 p-4 text-sm text-muted-foreground">
          {settings.enabled
            ? "The local MCP server is not running. Resolve the startup error above and try again."
            : "The local MCP server is disabled for this installation."}
        </div>
      )}

      <p className="text-xs leading-5 text-muted-foreground">
        The server only listens on this computer. Treat the token like a password: it can create
        environments, launch jobs, read transcripts, and update tickets.
      </p>
    </div>
  );
}
