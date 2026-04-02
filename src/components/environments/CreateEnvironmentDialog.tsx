import { useState, useCallback, useRef, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Shield, Globe, Network, Plus, Trash2, ChevronDown, Container, Laptop, Terminal, Bot } from "lucide-react";
import { ClaudeIcon, CodexIcon, OpenCodeIcon } from "@/components/icons/AgentIcons";
import { cn } from "@/lib/utils";
import type {
  ClaudeMode,
  EnvironmentType,
  NetworkAccessMode,
  OpenCodeMode,
  PortMapping,
  PortProtocol,
} from "@/types";
import type { AgentType } from "@/stores";
import { useConfigStore } from "@/stores";

// Stable empty array reference to prevent infinite re-renders when no default port mappings are provided
const EMPTY_PORT_MAPPINGS: PortMapping[] = [];

const UNSELECTED_CARD_CLASSES = "border-transparent bg-zinc-900 hover:border-zinc-600";

export interface ClaudeOptions {
  environmentType: EnvironmentType;
  environmentName: string;
  launchAgent: boolean;
  agentType: AgentType;
  claudeMode: ClaudeMode;
  opencodeMode: OpenCodeMode;
  initialPrompt: string;
  networkAccessMode: NetworkAccessMode;
  portMappings: PortMapping[];
}

interface CreateEnvironmentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (options: ClaudeOptions) => Promise<void>;
  isLoading?: boolean;
  /** Default port mappings from repository settings */
  defaultPortMappings?: PortMapping[];
}

export function CreateEnvironmentDialog({
  open,
  onOpenChange,
  onCreate,
  isLoading = false,
  defaultPortMappings = EMPTY_PORT_MAPPINGS,
}: CreateEnvironmentDialogProps) {
  const { config } = useConfigStore();
  const configDefaultAgent = config.global.defaultAgent || "claude";

  const [environmentType, setEnvironmentType] = useState<EnvironmentType>("containerized");
  const [environmentName, setEnvironmentName] = useState("");
  const [launchAgent, setLaunchAgent] = useState(true);
  const [agentType, setAgentType] = useState<AgentType>(configDefaultAgent);
  const [claudeMode, setClaudeMode] = useState<ClaudeMode>(
    config.global.claudeMode || "terminal",
  );
  const [opencodeMode, setOpencodeMode] = useState<OpenCodeMode>(
    config.global.opencodeMode || "terminal",
  );
  const [initialPrompt, setInitialPrompt] = useState("");
  const [networkAccessMode, setNetworkAccessMode] = useState<NetworkAccessMode>("full");
  const [portMappings, setPortMappings] = useState<PortMapping[]>(defaultPortMappings);
  const [showPortConfig, setShowPortConfig] = useState(defaultPortMappings.length > 0);
  const formRef = useRef<HTMLFormElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  // Focus the initial prompt textarea when dialog opens
  useEffect(() => {
    if (open && launchAgent) {
      // Small delay to ensure the dialog is fully rendered
      const timer = setTimeout(() => {
        promptRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [open, launchAgent]);

  const resetForm = useCallback(() => {
    setEnvironmentType("containerized");
    setEnvironmentName("");
    setLaunchAgent(true);
    setAgentType(configDefaultAgent);
    setClaudeMode(config.global.claudeMode || "terminal");
    setOpencodeMode(config.global.opencodeMode || "terminal");
    setInitialPrompt("");
    setNetworkAccessMode("full");
    setPortMappings(defaultPortMappings);
    setShowPortConfig(defaultPortMappings.length > 0);
  }, [defaultPortMappings, configDefaultAgent]);

  // Sync defaults when dialog opens
  // This ensures the dialog always starts with the latest defaults, since the component
  // may have been mounted before the defaults were available (e.g., config loaded async)
  useEffect(() => {
    if (open) {
      setPortMappings(defaultPortMappings);
      setShowPortConfig(defaultPortMappings.length > 0);
      setAgentType(configDefaultAgent);
      setClaudeMode(config.global.claudeMode || "terminal");
      setOpencodeMode(config.global.opencodeMode || "terminal");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally omit defaultPortMappings and configDefaultAgent:
    // we read the current value at dialog-open time, not re-sync when defaults change mid-dialog
  }, [open]);

  const addPortMapping = useCallback(() => {
    setPortMappings((prev) => [
      ...prev,
      { containerPort: 3000, hostPort: 3000, protocol: "tcp" as PortProtocol },
    ]);
  }, []);

  const removePortMapping = useCallback((index: number) => {
    setPortMappings((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const updatePortMapping = useCallback(
    (index: number, updates: Partial<PortMapping>) => {
      setPortMappings((prev) =>
        prev.map((m, i) => (i === index ? { ...m, ...updates } : m))
      );
    },
    []
  );

  const handleOpenChange = useCallback(
    (isOpen: boolean) => {
      if (!isOpen) {
        resetForm();
      }
      onOpenChange(isOpen);
    },
    [onOpenChange, resetForm]
  );

  // Validate port mappings - returns true if all valid
  const validatePortMappings = useCallback((): boolean => {
    for (const mapping of portMappings) {
      if (mapping.containerPort < 1 || mapping.containerPort > 65535) {
        return false;
      }
      if (mapping.hostPort < 1 || mapping.hostPort > 65535) {
        return false;
      }
    }
    return true;
  }, [portMappings]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();

      // Validate port mappings before submission
      if (!validatePortMappings()) {
        console.error("Invalid port mappings: ports must be between 1 and 65535");
        return;
      }

      try {
        await onCreate({
          environmentType,
          environmentName: environmentName.trim(),
          launchAgent,
          agentType,
          claudeMode,
          opencodeMode,
          initialPrompt: initialPrompt.trim(),
          networkAccessMode,
          portMappings,
        });
        handleOpenChange(false);
      } catch (err) {
        console.error("Failed to create environment:", err);
      }
    },
    [environmentType, environmentName, launchAgent, agentType, claudeMode, opencodeMode, initialPrompt, networkAccessMode, portMappings, onCreate, handleOpenChange, validatePortMappings]
  );

  const handlePromptKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Only handle plain Enter (no modifier keys) to submit the form
      // Shift+Enter allows normal newline behavior
      // Cmd/Ctrl+key combinations (copy, paste, etc.) pass through normally
      if (
        e.key === "Enter" &&
        !e.shiftKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !isLoading
      ) {
        e.preventDefault();
        formRef.current?.requestSubmit();
      }
    },
    [isLoading]
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="sm:max-w-[700px]"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Create Ork (Environment)</DialogTitle>
          <DialogDescription>
            Configure a new Ork environment with an optional initial prompt.
          </DialogDescription>
        </DialogHeader>

        <form ref={formRef} onSubmit={handleSubmit} className="space-y-4">
          {/* Environment Type Selector */}
          <div className="space-y-2">
            <Label>Environment Type</Label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setEnvironmentType("containerized")}
                disabled={isLoading}
                className={cn(
                  "p-3 rounded-lg border-2 text-left transition-colors",
                  environmentType === "containerized"
                    ? "border-primary bg-primary/5"
                    : UNSELECTED_CARD_CLASSES,
                  isLoading && "opacity-50 cursor-not-allowed"
                )}
              >
                <div className="flex items-center gap-2">
                  <Container className="h-4 w-4" />
                  <div>
                    <div className="font-medium text-sm">Containerized</div>
                    <div className="text-xs text-muted-foreground">Isolated Docker environment</div>
                  </div>
                </div>
              </button>

              <button
                type="button"
                onClick={() => setEnvironmentType("local")}
                disabled={isLoading}
                className={cn(
                  "p-3 rounded-lg border-2 text-left transition-colors",
                  environmentType === "local"
                    ? "border-primary bg-primary/5"
                    : UNSELECTED_CARD_CLASSES,
                  isLoading && "opacity-50 cursor-not-allowed"
                )}
              >
                <div className="flex items-center gap-2">
                  <Laptop className="h-4 w-4" />
                  <div>
                    <div className="font-medium text-sm">Local</div>
                    <div className="text-xs text-muted-foreground">Git worktree on your machine</div>
                  </div>
                </div>
              </button>
            </div>
          </div>

          {/* Top row: Environment Name and Network Access */}
          <div className={cn(
            "grid gap-4",
            environmentType === "containerized" ? "grid-cols-2" : "grid-cols-1"
          )}>
            {/* Environment Name */}
            <div className="space-y-2">
              <Label htmlFor="environment-name">
                Environment Name <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="environment-name"
                placeholder="e.g., feature-dark-mode"
                value={environmentName}
                onChange={(e) => setEnvironmentName(e.target.value)}
                disabled={isLoading}
              />
              <p className="text-xs text-muted-foreground">
                Also used as the git branch name.
              </p>
            </div>

            {/* Network Access Mode - only for containerized environments */}
            {environmentType === "containerized" && (
              <div className="space-y-2">
                <Label>Network Access</Label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setNetworkAccessMode("restricted")}
                    disabled={isLoading}
                    className={cn(
                      "p-2 rounded-lg border-2 text-left transition-colors",
                      networkAccessMode === "restricted"
                        ? "border-primary bg-primary/5"
                        : UNSELECTED_CARD_CLASSES,
                      isLoading && "opacity-50 cursor-not-allowed"
                    )}
                  >
                    <div className="flex items-center gap-1.5 font-medium text-sm">
                      <Shield className="h-3.5 w-3.5" />
                      Restricted
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setNetworkAccessMode("full")}
                    disabled={isLoading}
                    className={cn(
                      "p-2 rounded-lg border-2 text-left transition-colors",
                      networkAccessMode === "full"
                        ? "border-primary bg-primary/5"
                        : UNSELECTED_CARD_CLASSES,
                      isLoading && "opacity-50 cursor-not-allowed"
                    )}
                  >
                    <div className="flex items-center gap-1.5 font-medium text-sm">
                      <Globe className="h-3.5 w-3.5" />
                      Full Access
                    </div>
                  </button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {networkAccessMode === "restricted"
                    ? "Only GitHub, npm, Anthropic API allowed."
                    : "Unrestricted internet access."}
                </p>
              </div>
            )}
          </div>

          {/* Startup + mode row */}
          <div className="grid grid-cols-2 gap-4">
            {/* Launch Agent Toggle */}
            <div className="space-y-2">
              <Label className="text-sm">Container Startup</Label>
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label htmlFor="launch-agent" className="text-sm">Launch Agent</Label>
                <p className="text-xs text-muted-foreground">
                  Auto-start when ready
                </p>
              </div>
              <Switch
                id="launch-agent"
                checked={launchAgent}
                onCheckedChange={setLaunchAgent}
                disabled={isLoading}
              />
              </div>
            </div>

            {/* Agent Mode Selector */}
            <div className={cn(
              "space-y-2",
              !launchAgent && "opacity-50"
            )}>
              <Label className="text-sm">
                {agentType === "claude"
                  ? "Claude Mode"
                  : agentType === "opencode"
                    ? "OpenCode Mode"
                    : "Codex Mode"}
              </Label>
              <div className="grid grid-cols-2 gap-2 w-full">
                {agentType === "codex" ? (
                  <div className="col-span-2 rounded-lg border border-muted px-3 py-2 text-sm text-muted-foreground">
                    Codex runs in native mode.
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        if (agentType === "claude") {
                          setClaudeMode("terminal");
                        } else {
                          setOpencodeMode("terminal");
                        }
                      }}
                      disabled={isLoading || !launchAgent}
                      className={cn(
                        "p-2 rounded-lg border-2 text-left transition-colors",
                        (agentType === "claude" ? claudeMode : opencodeMode) === "terminal"
                          ? "border-primary bg-primary/5"
                          : UNSELECTED_CARD_CLASSES,
                        (isLoading || !launchAgent) && "opacity-50 cursor-not-allowed"
                      )}
                    >
                      <div className="flex items-center gap-2 text-sm font-medium">
                        <Terminal className="h-3.5 w-3.5" />
                        Terminal
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        if (agentType === "claude") {
                          setClaudeMode("native");
                        } else {
                          setOpencodeMode("native");
                        }
                      }}
                      disabled={isLoading || !launchAgent}
                      className={cn(
                        "p-2 rounded-lg border-2 text-left transition-colors",
                        (agentType === "claude" ? claudeMode : opencodeMode) === "native"
                          ? "border-primary bg-primary/5"
                          : UNSELECTED_CARD_CLASSES,
                        (isLoading || !launchAgent) && "opacity-50 cursor-not-allowed"
                      )}
                    >
                      <div className="flex items-center gap-2 text-sm font-medium">
                        <Bot className="h-3.5 w-3.5" />
                        Native
                      </div>
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Full-width Default Agent Selector */}
          <div className={cn(
            "space-y-2",
            !launchAgent && "opacity-50"
          )}>
            <Label className="text-sm">Default Agent</Label>
            <div className="grid grid-cols-3 gap-2 w-full">
              <button
                type="button"
                onClick={() => setAgentType("claude")}
                disabled={isLoading || !launchAgent}
                className={cn(
                  "p-3 rounded-lg border-2 text-left transition-colors",
                  agentType === "claude"
                    ? "border-primary bg-primary/5"
                    : UNSELECTED_CARD_CLASSES,
                  (isLoading || !launchAgent) && "opacity-50 cursor-not-allowed"
                )}
              >
                <div className="flex items-center gap-2 font-medium text-sm">
                  <ClaudeIcon className="h-4 w-4" />
                  Claude
                </div>
              </button>

              <button
                type="button"
                onClick={() => setAgentType("opencode")}
                disabled={isLoading || !launchAgent}
                className={cn(
                  "p-3 rounded-lg border-2 text-left transition-colors",
                  agentType === "opencode"
                    ? "border-primary bg-primary/5"
                    : UNSELECTED_CARD_CLASSES,
                  (isLoading || !launchAgent) && "opacity-50 cursor-not-allowed"
                )}
              >
                <div className="flex items-center gap-2 font-medium text-sm">
                  <OpenCodeIcon className="h-4 w-4 shrink-0" />
                  OpenCode
                </div>
              </button>

              <button
                type="button"
                onClick={() => setAgentType("codex")}
                disabled={isLoading || !launchAgent}
                className={cn(
                  "p-3 rounded-lg border-2 text-left transition-colors",
                  agentType === "codex"
                    ? "border-primary bg-primary/5"
                    : UNSELECTED_CARD_CLASSES,
                  (isLoading || !launchAgent) && "opacity-50 cursor-not-allowed"
                )}
              >
                <div className="flex items-center gap-2 font-medium text-sm">
                  <CodexIcon className="h-4 w-4 text-foreground" />
                  Codex
                </div>
              </button>
            </div>
          </div>

          {/* Port Configuration - only for containerized environments */}
          {environmentType === "containerized" && (
          <Collapsible open={showPortConfig} onOpenChange={setShowPortConfig}>
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                className="w-full justify-between p-3 h-auto rounded-lg border border-input bg-muted/30 hover:bg-muted/50"
                disabled={isLoading}
              >
                <div className="flex items-center gap-2">
                  <Network className="h-4 w-4" />
                  <span className="text-sm font-medium">Port Configuration</span>
                  {portMappings.length > 0 && (
                    <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                      {portMappings.length} port{portMappings.length !== 1 ? "s" : ""}
                    </span>
                  )}
                </div>
                <ChevronDown
                  className={cn(
                    "h-4 w-4 transition-transform duration-200",
                    showPortConfig && "rotate-180"
                  )}
                />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-3 space-y-3">
              <p className="text-xs text-muted-foreground">
                Expose container ports to the host machine. These are set at container creation.
              </p>
              {portMappings.length > 0 && (
                <div className="flex items-center gap-2 -mb-1">
                  <div className="flex-1 grid grid-cols-[1fr_auto_1fr_auto_auto] items-center gap-2">
                    <span className="text-xs text-muted-foreground">Container</span>
                    <span></span>
                    <span className="text-xs text-muted-foreground">Host</span>
                    <span className="w-20"></span>
                    <span className="h-8 w-8"></span>
                  </div>
                </div>
              )}
              {portMappings.map((mapping, index) => (
                <div key={index} className="flex items-center gap-2">
                  <div className="flex-1 grid grid-cols-[1fr_auto_1fr_auto_auto] items-center gap-2">
                    <Input
                      type="number"
                      placeholder="Container"
                      value={mapping.containerPort}
                      onChange={(e) =>
                        updatePortMapping(index, {
                          containerPort: parseInt(e.target.value) || 0,
                        })
                      }
                      className="text-sm"
                      min={1}
                      max={65535}
                      disabled={isLoading}
                    />
                    <span className="text-muted-foreground">:</span>
                    <Input
                      type="number"
                      placeholder="Host"
                      value={mapping.hostPort}
                      onChange={(e) =>
                        updatePortMapping(index, {
                          hostPort: parseInt(e.target.value) || 0,
                        })
                      }
                      className="text-sm"
                      min={1}
                      max={65535}
                      disabled={isLoading}
                    />
                    <Select
                      value={mapping.protocol}
                      onValueChange={(value: PortProtocol) =>
                        updatePortMapping(index, { protocol: value })
                      }
                      disabled={isLoading}
                    >
                      <SelectTrigger className="w-20">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="tcp">TCP</SelectItem>
                        <SelectItem value="udp">UDP</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => removePortMapping(index)}
                      disabled={isLoading}
                      className="h-8 w-8"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addPortMapping}
                disabled={isLoading}
                className="w-full"
              >
                <Plus className="h-4 w-4 mr-2" />
                Add Port Mapping
              </Button>
            </CollapsibleContent>
          </Collapsible>
          )}

          {/* Initial Prompt */}
          {launchAgent && (
            <div className="space-y-2">
              <Label htmlFor="initial-prompt">
                Initial Prompt <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Textarea
                ref={promptRef}
                id="initial-prompt"
                placeholder={
                  agentType === "claude"
                    ? "Enter a task for Claude to work on..."
                    : agentType === "codex"
                      ? "Enter a task for Codex to work on..."
                      : "Enter a task for OpenCode to work on..."
                }
                value={initialPrompt}
                onChange={(e) => setInitialPrompt(e.target.value)}
                onKeyDown={handlePromptKeyDown}
                disabled={isLoading}
                rows={3}
                className="resize-none"
              />
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={isLoading}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isLoading || (environmentType === "containerized" && !validatePortMappings())}>
              {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Create Environment
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
