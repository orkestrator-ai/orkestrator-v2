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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import {
  Bot,
  ChevronDown,
  Container,
  Globe,
  Laptop,
  Loader2,
  MessageSquareText,
  Network,
  Plus,
  Shield,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { ClaudeIcon, CodexIcon, OpenCodeIcon } from "@/components/icons/AgentIcons";
import { cn } from "@/lib/utils";
import { readImage } from "@/lib/native/clipboard";
import { resizeCanvasIfNeeded } from "@/lib/canvas-utils";
import { createUuid } from "@/lib/uuid";
import { toast } from "sonner";
import type {
  ClaudeMode,
  CodexMode,
  EnvironmentType,
  NetworkAccessMode,
  OpenCodeMode,
  PortMapping,
  PortProtocol,
} from "@/types";
import type { AgentType } from "@/stores";
import { useConfigStore } from "@/stores";
import type { InitialPromptImageAttachment } from "@/lib/initial-prompt-attachments";

// Stable empty array reference to prevent infinite re-renders when no default port mappings are provided
const EMPTY_PORT_MAPPINGS: PortMapping[] = [];

/**
 * Resolves the effective agent defaults by applying project-level overrides
 * over app-level settings, with final fallbacks.
 */
export function resolveAgentDefaults(
  globalConfig: { defaultAgent?: string; claudeMode?: string; opencodeMode?: string; codexMode?: string },
  repoConfig?: { defaultAgent?: string; agentStyle?: string },
) {
  const defaultAgent = repoConfig?.defaultAgent || globalConfig.defaultAgent || "claude";
  const claudeMode = repoConfig?.agentStyle || globalConfig.claudeMode || "terminal";
  const opencodeMode = repoConfig?.agentStyle || globalConfig.opencodeMode || "terminal";
  const codexMode = repoConfig?.agentStyle || globalConfig.codexMode || "native";
  return { defaultAgent, claudeMode, opencodeMode, codexMode } as const;
}

const UNSELECTED_CARD_CLASSES = "border-transparent bg-zinc-900 hover:border-zinc-600";
const MOBILE_TAB_TRIGGER_CLASSES = "h-11 min-w-0 flex-1 flex-col gap-0.5 rounded-lg px-1 py-1 text-[10px] leading-none data-[state=active]:border-primary/40 data-[state=active]:bg-primary/10 data-[state=active]:text-primary data-[state=active]:shadow-none";
const MAX_IMAGE_SIZE = 8 * 1024 * 1024;
const MAX_RGBA_SIZE = 32 * 1024 * 1024;

type MobileSection = "prompt" | "environment" | "agent" | "access" | "ports";

function generateImageFilename(): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .slice(0, 19);
  const random = Math.random().toString(36).substring(2, 8);
  return `initial-prompt-${timestamp}-${random}.png`;
}

export interface ClaudeOptions {
  environmentType: EnvironmentType;
  environmentName: string;
  launchAgent: boolean;
  agentType: AgentType;
  claudeMode: ClaudeMode;
  opencodeMode: OpenCodeMode;
  codexMode: CodexMode;
  initialPrompt: string;
  initialPromptAttachments: InitialPromptImageAttachment[];
  networkAccessMode: NetworkAccessMode;
  portMappings: PortMapping[];
}

interface CreateEnvironmentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (options: ClaudeOptions) => Promise<void>;
  isLoading?: boolean;
  /** Project ID for persisting draft prompt text */
  projectId?: string | null;
  /** Default port mappings from repository settings */
  defaultPortMappings?: PortMapping[];
}

// Persist draft prompt text per project across dialog open/close within the session
const draftPrompts = new Map<string, string>();

export function CreateEnvironmentDialog({
  open,
  onOpenChange,
  onCreate,
  isLoading = false,
  projectId,
  defaultPortMappings = EMPTY_PORT_MAPPINGS,
}: CreateEnvironmentDialogProps) {
  const { config } = useConfigStore();
  const repoConfig = projectId ? config.repositories[projectId] : undefined;

  // Resolve effective defaults: project-level overrides > app-level
  const resolved = resolveAgentDefaults(config.global, repoConfig);
  const configDefaultAgent = resolved.defaultAgent as AgentType;
  const configClaudeMode = resolved.claudeMode as ClaudeMode;
  const configOpencodeMode = resolved.opencodeMode as OpenCodeMode;
  const configCodexMode = resolved.codexMode as CodexMode;
  const configEnvironmentType: EnvironmentType = repoConfig?.lastEnvironmentType ?? "containerized";

  const [environmentType, setEnvironmentType] = useState<EnvironmentType>(configEnvironmentType);
  const [environmentName, setEnvironmentName] = useState("");
  const [launchAgent, setLaunchAgent] = useState(true);
  const [agentType, setAgentType] = useState<AgentType>(configDefaultAgent);
  const [claudeMode, setClaudeMode] = useState<ClaudeMode>(configClaudeMode);
  const [opencodeMode, setOpencodeMode] = useState<OpenCodeMode>(configOpencodeMode);
  const [codexMode, setCodexMode] = useState<CodexMode>(configCodexMode);
  const [initialPrompt, setInitialPrompt] = useState("");
  const [initialPromptAttachments, setInitialPromptAttachments] = useState<InitialPromptImageAttachment[]>([]);
  const [networkAccessMode, setNetworkAccessMode] = useState<NetworkAccessMode>("full");
  const [portMappings, setPortMappings] = useState<PortMapping[]>(defaultPortMappings);
  const [showPortConfig, setShowPortConfig] = useState(defaultPortMappings.length > 0);
  const [mobileSection, setMobileSection] = useState<MobileSection>("prompt");
  const formRef = useRef<HTMLFormElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  // Restore draft prompt when dialog opens, focus the textarea
  useEffect(() => {
    if (open) {
      if (projectId) {
        const draft = draftPrompts.get(projectId);
        if (draft) {
          setInitialPrompt(draft);
        }
      }
      if (launchAgent && mobileSection === "prompt") {
        // Small delay to ensure the dialog is fully rendered
        const timer = setTimeout(() => {
          promptRef.current?.focus();
        }, 50);
        return () => clearTimeout(timer);
      }
    }
  }, [open, launchAgent, mobileSection, projectId]);

  const resetForm = useCallback(() => {
    setEnvironmentType(configEnvironmentType);
    setEnvironmentName("");
    setLaunchAgent(true);
    setAgentType(configDefaultAgent);
    setClaudeMode(configClaudeMode);
    setOpencodeMode(configOpencodeMode);
    setCodexMode(configCodexMode);
    setInitialPrompt("");
    setInitialPromptAttachments([]);
    setNetworkAccessMode("full");
    setPortMappings(defaultPortMappings);
    setShowPortConfig(defaultPortMappings.length > 0);
    setMobileSection("prompt");
  }, [defaultPortMappings, configDefaultAgent, configClaudeMode, configOpencodeMode, configCodexMode, configEnvironmentType]);

  const handlePromptPaste = useCallback(async (event: ClipboardEvent) => {
    if (!open || !launchAgent || document.activeElement !== promptRef.current) return;

    try {
      const image = await readImage();
      const rgba = await image.rgba();
      const { width, height } = await image.size();

      let canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const imageData = new ImageData(new Uint8ClampedArray(rgba), width, height);
      ctx.putImageData(imageData, 0, 0);
      canvas = resizeCanvasIfNeeded(canvas, MAX_RGBA_SIZE);

      const previewUrl = canvas.toDataURL("image/png");
      const base64Data = previewUrl.split(",")[1] || "";
      const estimatedSize = (base64Data.length * 3) / 4;
      if (estimatedSize > MAX_IMAGE_SIZE) {
        toast.error("Image too large", {
          description: `Image is ${(estimatedSize / 1024 / 1024).toFixed(1)}MB. Maximum is 8MB.`,
        });
        return;
      }

      canvas.width = 0;
      canvas.height = 0;
      if (!base64Data) return;

      event.preventDefault();
      event.stopImmediatePropagation();

      setInitialPromptAttachments((prev) => [
        ...prev,
        {
          id: createUuid(),
          name: generateImageFilename(),
          previewUrl,
          base64Data,
        },
      ]);
      toast.success("Image attached");
    } catch {
      // No image in the clipboard; let normal text paste continue.
    }
  }, [launchAgent, open]);

  useEffect(() => {
    if (!open) return;

    const listener = (event: Event) => {
      void handlePromptPaste(event as ClipboardEvent);
    };
    document.addEventListener("paste", listener, { capture: true });
    return () => document.removeEventListener("paste", listener, { capture: true });
  }, [open, handlePromptPaste]);

  const removeInitialPromptAttachment = useCallback((id: string) => {
    setInitialPromptAttachments((prev) => prev.filter((attachment) => attachment.id !== id));
  }, []);

  // Sync defaults when dialog opens
  // This ensures the dialog always starts with the latest defaults, since the component
  // may have been mounted before the defaults were available (e.g., config loaded async)
  useEffect(() => {
    if (open) {
      setMobileSection("prompt");
      setPortMappings(defaultPortMappings);
      setShowPortConfig(defaultPortMappings.length > 0);
      setEnvironmentType(configEnvironmentType);
      setAgentType(configDefaultAgent);
      setClaudeMode(configClaudeMode);
      setOpencodeMode(configOpencodeMode);
      setCodexMode(configCodexMode);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally omit defaultPortMappings and configDefaultAgent:
    // we read the current value at dialog-open time, not re-sync when defaults change mid-dialog
  }, [open]);

  useEffect(() => {
    if (!launchAgent && mobileSection === "prompt") {
      setMobileSection("agent");
    } else if (
      environmentType === "local" &&
      (mobileSection === "access" || mobileSection === "ports")
    ) {
      setMobileSection("environment");
    }
  }, [environmentType, launchAgent, mobileSection]);

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
        // Save draft prompt before resetting, so it can be restored next time
        if (projectId) {
          const trimmed = initialPrompt.trim();
          if (trimmed) {
            draftPrompts.set(projectId, trimmed);
          } else {
            draftPrompts.delete(projectId);
          }
        }
        resetForm();
      }
      onOpenChange(isOpen);
    },
    [onOpenChange, resetForm, projectId, initialPrompt]
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
          codexMode,
          initialPrompt: initialPrompt.trim(),
          initialPromptAttachments,
          networkAccessMode,
          portMappings,
        });
        // Clear the draft on successful creation and close directly
        // (bypass handleOpenChange which would re-save the draft)
        if (projectId) {
          draftPrompts.delete(projectId);
        }
        resetForm();
        onOpenChange(false);
      } catch (err) {
        console.error("Failed to create environment:", err);
      }
    },
    [environmentType, environmentName, launchAgent, agentType, claudeMode, opencodeMode, codexMode, initialPrompt, initialPromptAttachments, networkAccessMode, portMappings, onCreate, resetForm, onOpenChange, projectId, validatePortMappings]
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
        className="flex max-h-[calc(100dvh-1rem)] flex-col sm:max-h-[85vh] sm:max-w-[700px]"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Create Ork (Environment)</DialogTitle>
          <DialogDescription>
            Configure a new Ork environment with an optional initial prompt.
          </DialogDescription>
        </DialogHeader>

        <form ref={formRef} onSubmit={handleSubmit} className="min-h-0 flex-1 overflow-y-auto pr-1">
          <Tabs
            value={mobileSection}
            onValueChange={(value) => setMobileSection(value as MobileSection)}
            className="min-h-0 gap-4 sm:grid sm:grid-cols-2 sm:items-start"
          >
            <TabsList
              aria-label="Environment configuration sections"
              className="sticky top-0 z-10 flex h-auto w-full shrink-0 rounded-xl border border-border/80 bg-zinc-950/95 p-1 shadow-lg shadow-black/15 backdrop-blur sm:hidden"
            >
              <TabsTrigger
                value="prompt"
                disabled={!launchAgent}
                className={MOBILE_TAB_TRIGGER_CLASSES}
              >
                <MessageSquareText className="h-4 w-4" />
                <span>Prompt</span>
              </TabsTrigger>
              <TabsTrigger
                value="environment"
                className={MOBILE_TAB_TRIGGER_CLASSES}
              >
                <Container className="h-4 w-4" />
                <span>Setup</span>
              </TabsTrigger>
              <TabsTrigger
                value="agent"
                className={MOBILE_TAB_TRIGGER_CLASSES}
              >
                <Bot className="h-4 w-4" />
                <span>Agent</span>
              </TabsTrigger>
              {environmentType === "containerized" && (
                <>
                  <TabsTrigger
                    value="access"
                    className={MOBILE_TAB_TRIGGER_CLASSES}
                  >
                    <Shield className="h-4 w-4" />
                    <span>Access</span>
                  </TabsTrigger>
                  <TabsTrigger
                    value="ports"
                    className={MOBILE_TAB_TRIGGER_CLASSES}
                  >
                    <Network className="h-4 w-4" />
                    <span>Ports</span>
                  </TabsTrigger>
                </>
              )}
            </TabsList>

            <TabsContent
              value="environment"
              forceMount
              className="mt-0 space-y-4 data-[state=inactive]:hidden sm:!contents"
            >
          {/* Environment Type Selector */}
          <div className="space-y-2 sm:col-span-2">
            <Label>Environment Type</Label>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
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
            </TabsContent>

            {/* Network Access Mode - only for containerized environments */}
            {environmentType === "containerized" && (
              <TabsContent
                value="access"
                forceMount
                className="mt-0 space-y-4 data-[state=inactive]:hidden sm:!contents"
              >
            {/* Network Access Mode - only for containerized environments */}
              <div className="space-y-2">
                <Label>Network Access</Label>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
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
              </TabsContent>
            )}

            <TabsContent
              value="agent"
              forceMount
              className="mt-0 space-y-4 data-[state=inactive]:hidden sm:!contents"
            >
          {/* Startup + mode row */}
          <div className="space-y-2">
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
              <div className="grid w-full grid-cols-1 gap-2 sm:grid-cols-2">
                <>
                  <button
                    type="button"
                    onClick={() => {
                      if (agentType === "claude") {
                        setClaudeMode("terminal");
                      } else if (agentType === "opencode") {
                        setOpencodeMode("terminal");
                      } else {
                        setCodexMode("terminal");
                      }
                    }}
                    disabled={isLoading || !launchAgent}
                    className={cn(
                      "p-2 rounded-lg border-2 text-left transition-colors",
                      (agentType === "claude"
                        ? claudeMode
                        : agentType === "opencode"
                          ? opencodeMode
                          : codexMode) === "terminal"
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
                      } else if (agentType === "opencode") {
                        setOpencodeMode("native");
                      } else {
                        setCodexMode("native");
                      }
                    }}
                    disabled={isLoading || !launchAgent}
                    className={cn(
                      "p-2 rounded-lg border-2 text-left transition-colors",
                      (agentType === "claude"
                        ? claudeMode
                        : agentType === "opencode"
                          ? opencodeMode
                          : codexMode) === "native"
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
              </div>
            </div>

          {/* Full-width Default Agent Selector */}
          <div className={cn(
            "space-y-2",
            !launchAgent && "opacity-50",
            "sm:col-span-2"
          )}>
            <Label className="text-sm">Default Agent</Label>
            <div className="grid w-full grid-cols-1 gap-2 sm:grid-cols-3">
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
            </TabsContent>

          {/* Port Configuration - only for containerized environments */}
          {environmentType === "containerized" && (
          <TabsContent
            value="ports"
            forceMount
            className="mt-0 data-[state=inactive]:hidden sm:col-span-2 sm:!block"
          >
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
                <div className="-mb-1 hidden items-center gap-2 sm:flex">
                  <div className="grid flex-1 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto] items-center gap-2 sm:grid-cols-[1fr_auto_1fr_auto_auto]">
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
                  <div className="grid flex-1 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto] items-center gap-2 sm:grid-cols-[1fr_auto_1fr_auto_auto]">
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
                      <SelectTrigger className="col-span-3 col-start-1 w-full sm:col-span-1 sm:col-start-auto sm:w-20">
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
                      className="col-start-4 row-start-2 h-8 w-8 sm:col-start-auto sm:row-start-auto"
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
          </TabsContent>
          )}

          <TabsContent
            value="prompt"
            forceMount
            className="mt-0 data-[state=inactive]:hidden sm:col-span-2 sm:!block"
          >
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
                className="resize-y max-h-[calc(15*theme(lineHeight.normal)*1em)] overflow-y-auto"
              />
              {initialPromptAttachments.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {initialPromptAttachments.map((attachment) => (
                    <div
                      key={attachment.id}
                      className="group relative h-16 w-16 overflow-hidden rounded-md border border-border bg-muted"
                    >
                      <img
                        src={attachment.previewUrl}
                        alt={attachment.name}
                        className="h-full w-full object-cover"
                      />
                      <button
                        type="button"
                        onClick={() => removeInitialPromptAttachment(attachment.id)}
                        disabled={isLoading}
                        className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-background/90 opacity-0 shadow-sm transition-opacity group-hover:opacity-100"
                        aria-label={`Remove ${attachment.name}`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          </TabsContent>

          </Tabs>
        </form>

        <DialogFooter className="grid grid-cols-2 sm:flex sm:flex-row">
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={isLoading}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => formRef.current?.requestSubmit()}
            disabled={isLoading || (environmentType === "containerized" && !validatePortMappings())}
          >
            {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Create Environment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
