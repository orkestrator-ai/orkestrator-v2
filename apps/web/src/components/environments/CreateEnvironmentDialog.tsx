import { useState, useCallback, useRef, useEffect, useMemo } from "react";
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
import { Checkbox } from "@/components/ui/checkbox";
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
  Trash2,
  X,
} from "lucide-react";
import { ClaudeIcon, CodexIcon, CursorAgentIcon, GrokBuildIcon, OpenCodeIcon } from "@/components/icons/AgentIcons";
import { AgentModelPicker } from "@/components/chat/AgentModelPicker";
import { useAgentModelFavorites } from "@/hooks/useAgentModelFavorites";
import { cn } from "@/lib/utils";
import { readImage } from "@/lib/native/clipboard";
import {
  encodeCanvasAsPngWithinSize,
  MAX_IMAGE_DIMENSION,
  resizeCanvasIfNeeded,
  resizeCanvasToMaxDimension,
} from "@/lib/canvas-utils";
import { createUuid } from "@/lib/uuid";
import { getPastedImageBlob } from "@/lib/clipboard-event";
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
import {
  useCodexStore,
  useConfigStore,
} from "@/stores";
import { useClaudeStore } from "@/stores/claudeStore";
import { useOpenCodeStore } from "@/stores/openCodeStore";
import type { InitialPromptImageAttachment } from "@/lib/initial-prompt-attachments";
import { buildReviewModelCatalog } from "@/lib/review-launch-options";
import { modelsForAgent } from "@/lib/agent-launch";
import {
  getCachedOpenCodeModelCatalog,
  type CachedOpenCodeModel,
} from "@/lib/backend";
import { useDockerAvailability } from "@/contexts/DockerAvailabilityContext";
import { firstEnabledAgentPlatform } from "@orkestrator/protocol/agent-platforms";

// Stable empty array reference to prevent infinite re-renders when no default port mappings are provided
const EMPTY_PORT_MAPPINGS: PortMapping[] = [];
function normalizeCachedOpenCodeModels(value: unknown): CachedOpenCodeModel[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((candidate): candidate is CachedOpenCodeModel => {
    if (typeof candidate !== "object" || candidate === null) return false;
    const record = candidate as Record<string, unknown>;
    return (
      typeof record.id === "string" &&
      record.id.trim().length > 0 &&
      typeof record.name === "string" &&
      record.name.trim().length > 0 &&
      typeof record.provider === "string" &&
      record.provider.trim().length > 0 &&
      (
        record.variants === undefined ||
        (
          Array.isArray(record.variants) &&
          record.variants.every(
            (variant) =>
              typeof variant === "string" && variant.trim().length > 0,
          )
        )
      )
    );
  });
}

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
const MOBILE_TAB_CONTENT_CLASSES = "create-environment-mobile-tab-panel mt-0 data-[state=inactive]:hidden";
const MAX_IMAGE_SIZE = 8 * 1024 * 1024;
const MAX_RGBA_SIZE = 32 * 1024 * 1024;

export function getEncodedImageSizeError(base64Length: number): string | null {
  const estimatedSize = (base64Length * 3) / 4;
  if (estimatedSize <= MAX_IMAGE_SIZE) return null;
  return `Image is ${(estimatedSize / 1024 / 1024).toFixed(1)}MB. Maximum is 8MB.`;
}

type MobileSection = "prompt" | "environment" | "agent" | "access" | "ports";
type MobileTabTransitionDirection = "forward" | "backward";

const MOBILE_SECTION_ORDER: MobileSection[] = [
  "prompt",
  "environment",
  "agent",
  "access",
  "ports",
];

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
  /**
   * One-shot model for the launched agent tab. `undefined` means "no explicit
   * choice" — the agent surface falls back to the user's configured defaults.
   */
  model?: string;
  reasoningEffort?: string;
  initialPrompt: string;
  initialPromptAttachments: InitialPromptImageAttachment[];
  networkAccessMode: NetworkAccessMode;
  portMappings: PortMapping[];
}

interface CreateEnvironmentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Return false when creation has been deferred or cancelled by a preflight.
   * Any other successful result completes the form submission normally.
   */
  onCreate: (options: ClaudeOptions) => Promise<void | boolean>;
  isLoading?: boolean;
  /** Project ID for persisting draft prompt text */
  projectId?: string | null;
  /** Project name displayed in the dialog title */
  projectName?: string;
  /** Default port mappings from repository settings */
  defaultPortMappings?: PortMapping[];
  /** Whether this project has a host checkout that can own local worktrees. */
  localEnvironmentAvailable?: boolean;
}

// Persist draft prompt text per project across dialog open/close within the session
const draftPrompts = new Map<string, string>();

export function CreateEnvironmentDialog({
  open,
  onOpenChange,
  onCreate,
  isLoading = false,
  projectId,
  projectName,
  defaultPortMappings = EMPTY_PORT_MAPPINGS,
  localEnvironmentAvailable = true,
}: CreateEnvironmentDialogProps) {
  const dockerAvailable = useDockerAvailability();
  const config = useConfigStore((state) => state.config);
  const repoConfig = projectId ? config.repositories[projectId] : undefined;

  // Resolve effective defaults: project-level overrides > app-level
  const resolved = resolveAgentDefaults(config.global, repoConfig);
  const configDefaultAgent = firstEnabledAgentPlatform(
    config.global.enabledAgentPlatforms ?? ["claude", "codex", "opencode"],
    resolved.defaultAgent as AgentType,
  );
  const configClaudeMode = resolved.claudeMode as ClaudeMode;
  const configOpencodeMode = resolved.opencodeMode as OpenCodeMode;
  const configCodexMode = resolved.codexMode as CodexMode;
  const configEnvironmentType: EnvironmentType = repoConfig?.lastEnvironmentType ?? "containerized";
  const effectiveDefaultEnvironmentType: EnvironmentType =
    !dockerAvailable
      && localEnvironmentAvailable
      && configEnvironmentType === "containerized"
      ? "local"
      : !localEnvironmentAvailable && configEnvironmentType === "local" && dockerAvailable
        ? "containerized"
        : configEnvironmentType;
  const claudeModels = useClaudeStore((state) => state.models);
  const codexModels = useCodexStore((state) => state.models);
  const openCodeModels = useOpenCodeStore((state) => state.models);
  const [cachedOpenCodeModels, setCachedOpenCodeModels] = useState<
    CachedOpenCodeModel[]
  >([]);
  const { favorites: favoriteModels, toggleFavorite: toggleFavoriteModel } = useAgentModelFavorites();
  const configuredOpenCodeModel =
    (configDefaultAgent === "opencode" ? repoConfig?.defaultModel : undefined)
    ?? config.global.opencodeModel;
  const configuredOpenCodeEffort =
    configDefaultAgent === "opencode" ? repoConfig?.defaultEffort : undefined;
  /**
   * `buildReviewModelCatalog` synthesises a single `{ id: "default" }` OpenCode
   * entry when no environment has cached a live catalog yet. That id is a UI
   * placeholder, not a model any OpenCode server knows, so submitting it would
   * pin a bogus one-shot model — and because a pending launch option is treated
   * as authoritative downstream, it would also suppress the user's own saved
   * OpenCode model preferences. Claude's `"default"` is a real catalog id and
   * must keep flowing through untouched.
   */
  const hasAvailableOpenCodeModels = useMemo(
    () =>
      cachedOpenCodeModels.length > 0 ||
      Array.from(openCodeModels.values()).some((models) => models.length > 0),
    [cachedOpenCodeModels, openCodeModels],
  );
  const modelCatalog = useMemo(
    () => {
      const liveCatalog = buildReviewModelCatalog(undefined);
      const hasLiveCatalog = Array.from(openCodeModels.values()).some(
        (models) => models.length > 0,
      );
      const catalog =
        !hasLiveCatalog && cachedOpenCodeModels.length > 0
          ? {
              ...liveCatalog,
              opencode: cachedOpenCodeModels.map((candidate) => ({
                id: candidate.id,
                name: candidate.name,
                description: candidate.provider,
                reasoningEfforts: [...(candidate.variants ?? [])],
              })),
            }
          : liveCatalog;
      if (!configuredOpenCodeModel) return catalog;

      const configuredModel = catalog.opencode.find(
        (candidate) => candidate.id === configuredOpenCodeModel,
      );
      if (configuredModel) {
        if (
          !configuredOpenCodeEffort
          || configuredModel.reasoningEfforts?.includes(configuredOpenCodeEffort)
        ) {
          return catalog;
        }
        return {
          ...catalog,
          opencode: catalog.opencode.map((candidate) =>
            candidate.id === configuredOpenCodeModel
              ? {
                  ...candidate,
                  reasoningEfforts: [
                    ...(candidate.reasoningEfforts ?? []),
                    configuredOpenCodeEffort,
                  ],
                }
              : candidate
          ),
        };
      }

      return {
        ...catalog,
        opencode: [
          {
            id: configuredOpenCodeModel,
            name: configuredOpenCodeModel,
            description: "Configured default",
            reasoningEfforts: configuredOpenCodeEffort
              ? [configuredOpenCodeEffort]
              : [],
          },
          ...catalog.opencode,
        ],
      };
    },
    [
      claudeModels,
      cachedOpenCodeModels,
      codexModels,
      configuredOpenCodeEffort,
      configuredOpenCodeModel,
      openCodeModels,
    ],
  );

  const getInitialAgentSelection = useCallback(
    (nextAgent: AgentType) => {
      const models = modelsForAgent(modelCatalog, nextAgent);
      const globalPreferredModel =
        nextAgent === "claude"
          ? config.global.claudeModel
          : nextAgent === "codex"
            ? config.global.codexModel
            : nextAgent === "opencode"
              ? config.global.opencodeModel
              : undefined;
      const projectPreferredModel =
        nextAgent === configDefaultAgent ? repoConfig?.defaultModel : undefined;
      const preferredModel = projectPreferredModel || globalPreferredModel;
      const selectedModel =
        models.find((candidate) => candidate.id === preferredModel)?.id ??
        models[0]?.id ??
        "default";
      const supportedEfforts =
        models.find((candidate) => candidate.id === selectedModel)?.reasoningEfforts ?? [];
      const projectPreferredEffort =
        nextAgent === configDefaultAgent ? repoConfig?.defaultEffort : undefined;
      const preferredEffort =
        projectPreferredEffort
        ?? (nextAgent === "codex"
          ? config.global.codexReasoningEffort
          : undefined);

      return {
        model: selectedModel,
        reasoningEffort:
          preferredEffort && supportedEfforts.includes(preferredEffort)
            ? preferredEffort
            : "default",
      };
    },
    [
      config.global.claudeModel,
      config.global.codexModel,
      config.global.codexReasoningEffort,
      config.global.opencodeModel,
      configDefaultAgent,
      modelCatalog,
      repoConfig?.defaultEffort,
      repoConfig?.defaultModel,
    ],
  );
  const initialAgentSelection = getInitialAgentSelection(configDefaultAgent);

  const [environmentType, setEnvironmentType] = useState<EnvironmentType>(effectiveDefaultEnvironmentType);
  const [environmentName, setEnvironmentName] = useState("");
  const [launchAgent, setLaunchAgent] = useState(true);
  const [agentType, setAgentType] = useState<AgentType>(configDefaultAgent);
  const [claudeMode, setClaudeMode] = useState<ClaudeMode>(configClaudeMode);
  const [opencodeMode, setOpencodeMode] = useState<OpenCodeMode>(configOpencodeMode);
  const [codexMode, setCodexMode] = useState<CodexMode>(configCodexMode);
  const [model, setModel] = useState(initialAgentSelection.model);
  const [reasoningEffort, setReasoningEffort] = useState(
    initialAgentSelection.reasoningEffort,
  );
  const [initialPrompt, setInitialPrompt] = useState("");
  const [initialPromptAttachments, setInitialPromptAttachments] = useState<InitialPromptImageAttachment[]>([]);
  const [networkAccessMode, setNetworkAccessMode] = useState<NetworkAccessMode>("full");
  const [portMappings, setPortMappings] = useState<PortMapping[]>(defaultPortMappings);
  const [showPortConfig, setShowPortConfig] = useState(defaultPortMappings.length > 0);
  const [mobileSection, setMobileSection] = useState<MobileSection>("prompt");
  const [mobileTabTransitionDirection, setMobileTabTransitionDirection] =
    useState<MobileTabTransitionDirection | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const promptPasteRequestIdRef = useRef(0);

  useEffect(() => {
    if (
      open
      && !dockerAvailable
      && localEnvironmentAvailable
      && environmentType === "containerized"
    ) {
      setEnvironmentType("local");
    } else if (
      open
      && !localEnvironmentAvailable
      && dockerAvailable
      && environmentType === "local"
    ) {
      setEnvironmentType("containerized");
    }
  }, [dockerAvailable, environmentType, localEnvironmentAvailable, open]);

  useEffect(() => {
    if (!open) {
      setCachedOpenCodeModels([]);
      return;
    }
    let cancelled = false;

    // Clear data from the previous project/open cycle synchronously. An empty,
    // rejected, malformed, or late response must not leave another project's
    // model catalog or preferences visible in this dialog.
    setCachedOpenCodeModels([]);

    const normalizedProjectId = projectId?.trim();
    if (normalizedProjectId) {
      void getCachedOpenCodeModelCatalog(normalizedProjectId)
        .then((snapshot) => {
          const models = normalizeCachedOpenCodeModels(snapshot?.models);
          if (
            !cancelled &&
            snapshot &&
            snapshot.projectId === normalizedProjectId &&
            models
          ) {
            setCachedOpenCodeModels(models);
          }
        })
        .catch((error) => {
          console.warn(
            "[CreateEnvironmentDialog] Failed to load cached OpenCode models:",
            error,
          );
        });
    }

    return () => {
      cancelled = true;
    };
  }, [open, projectId]);

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
    promptPasteRequestIdRef.current += 1;
    setEnvironmentType(effectiveDefaultEnvironmentType);
    setEnvironmentName("");
    setLaunchAgent(true);
    setAgentType(configDefaultAgent);
    setClaudeMode(configClaudeMode);
    setOpencodeMode(configOpencodeMode);
    setCodexMode(configCodexMode);
    const nextSelection = getInitialAgentSelection(configDefaultAgent);
    setModel(nextSelection.model);
    setReasoningEffort(nextSelection.reasoningEffort);
    setInitialPrompt("");
    setInitialPromptAttachments([]);
    setNetworkAccessMode("full");
    setPortMappings(defaultPortMappings);
    setShowPortConfig(defaultPortMappings.length > 0);
    setMobileSection("prompt");
    setMobileTabTransitionDirection(null);
  }, [
    defaultPortMappings,
    configClaudeMode,
    configCodexMode,
    configDefaultAgent,
    effectiveDefaultEnvironmentType,
    configOpencodeMode,
    getInitialAgentSelection,
  ]);

  const handlePromptPaste = useCallback(async (event: ClipboardEvent) => {
    if (!open || !launchAgent || document.activeElement !== promptRef.current) return;

    const requestId = ++promptPasteRequestIdRef.current;
    const isCurrentRequest = () =>
      requestId === promptPasteRequestIdRef.current &&
      document.activeElement === promptRef.current;

    try {
      const pastedBlob = getPastedImageBlob(event);
      if (pastedBlob) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }

      const image = await readImage(pastedBlob);
      if (!isCurrentRequest()) return;
      const rgba = await image.rgba();
      if (!isCurrentRequest()) return;
      const { width, height } = await image.size();
      if (!isCurrentRequest()) return;

      let canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const imageData = new ImageData(new Uint8ClampedArray(rgba), width, height);
      ctx.putImageData(imageData, 0, 0);
      canvas = resizeCanvasToMaxDimension(canvas, MAX_IMAGE_DIMENSION);
      canvas = resizeCanvasIfNeeded(canvas, MAX_RGBA_SIZE);

      const encodedImage = encodeCanvasAsPngWithinSize(canvas, MAX_IMAGE_SIZE);
      if (!encodedImage) {
        toast.error("Image too large", {
          description: "The image could not be resized below the 8MB attachment limit.",
        });
        return;
      }
      canvas = encodedImage.canvas;
      const { dataUrl: previewUrl, base64Data } = encodedImage;
      canvas.width = 0;
      canvas.height = 0;

      if (!pastedBlob) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }

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
    return () => {
      promptPasteRequestIdRef.current += 1;
      document.removeEventListener("paste", listener, { capture: true });
    };
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
      setMobileTabTransitionDirection(null);
      setPortMappings(defaultPortMappings);
      setShowPortConfig(defaultPortMappings.length > 0);
      setEnvironmentType(effectiveDefaultEnvironmentType);
      setAgentType(configDefaultAgent);
      setClaudeMode(configClaudeMode);
      setOpencodeMode(configOpencodeMode);
      setCodexMode(configCodexMode);
      const nextSelection = getInitialAgentSelection(configDefaultAgent);
      setModel(nextSelection.model);
      setReasoningEffort(nextSelection.reasoningEffort);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read current defaults only when the dialog opens
  }, [open]);

  const selectedMode =
    agentType === "claude"
      ? claudeMode
      : agentType === "opencode"
        ? opencodeMode
        : agentType === "codex"
          ? codexMode
          : "native";
  const availableModels = modelsForAgent(modelCatalog, agentType);
  const availableReasoningEfforts =
    availableModels.find((candidate) => candidate.id === model)?.reasoningEfforts ?? [];

  useEffect(() => {
    if (!open) return;

    const selectedModel = availableModels.find((candidate) => candidate.id === model);
    if (!selectedModel) {
      const nextSelection = getInitialAgentSelection(agentType);
      setModel(nextSelection.model);
      setReasoningEffort(nextSelection.reasoningEffort);
      return;
    }

    if (
      reasoningEffort !== "default"
      && !selectedModel.reasoningEfforts?.includes(reasoningEffort)
    ) {
      setReasoningEffort("default");
    }
  }, [
    agentType,
    availableModels,
    getInitialAgentSelection,
    model,
    open,
    reasoningEffort,
  ]);

  const selectAgent = useCallback(
    (nextAgent: AgentType) => {
      setAgentType(nextAgent);
      const nextSelection = getInitialAgentSelection(nextAgent);
      setModel(nextSelection.model);
      setReasoningEffort(nextSelection.reasoningEffort);
    },
    [getInitialAgentSelection],
  );

  const setUseTui = useCallback(
    (checked: boolean | "indeterminate") => {
      const nextMode = checked === true ? "terminal" : "native";
      if (agentType === "claude") {
        setClaudeMode(nextMode);
      } else if (agentType === "opencode") {
        setOpencodeMode(nextMode);
      } else {
        setCodexMode(nextMode);
      }
    },
    [agentType],
  );

  const selectModel = useCallback(
    (nextModel: string) => {
      setModel(nextModel);
      const supportedEfforts =
        availableModels.find((candidate) => candidate.id === nextModel)?.reasoningEfforts ?? [];
      if (
        reasoningEffort !== "default" &&
        !supportedEfforts.includes(reasoningEffort)
      ) {
        setReasoningEffort("default");
      }
    },
    [availableModels, reasoningEffort],
  );

  const selectMobileSection = useCallback(
    (nextSection: MobileSection) => {
      if (nextSection === mobileSection) return;

      const currentIndex = MOBILE_SECTION_ORDER.indexOf(mobileSection);
      const nextIndex = MOBILE_SECTION_ORDER.indexOf(nextSection);
      setMobileTabTransitionDirection(nextIndex > currentIndex ? "forward" : "backward");
      setMobileSection(nextSection);
    },
    [mobileSection],
  );

  useEffect(() => {
    if (!launchAgent && mobileSection === "prompt") {
      selectMobileSection("agent");
    } else if (
      environmentType === "local" &&
      (mobileSection === "access" || mobileSection === "ports")
    ) {
      selectMobileSection("environment");
    }
  }, [environmentType, launchAgent, mobileSection, selectMobileSection]);

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

      if (environmentType === "containerized" && !dockerAvailable) return;
      if (environmentType === "local" && !localEnvironmentAvailable) return;

      // Validate port mappings before submission
      if (environmentType === "containerized" && !validatePortMappings()) {
        console.error("Invalid port mappings: ports must be between 1 and 65535");
        return;
      }

      try {
        const created = await onCreate({
          environmentType,
          environmentName: environmentName.trim(),
          launchAgent,
          agentType,
          claudeMode,
          opencodeMode,
          codexMode,
          model:
            agentType === "opencode" && model === "default" && !hasAvailableOpenCodeModels
              ? undefined
              : model,
          reasoningEffort:
            reasoningEffort === "default" ? undefined : reasoningEffort,
          initialPrompt: initialPrompt.trim(),
          initialPromptAttachments,
          networkAccessMode,
          portMappings: environmentType === "containerized" ? portMappings : [],
        });
        if (created === false) return;
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
    [dockerAvailable, environmentType, environmentName, launchAgent, agentType, claudeMode, opencodeMode, codexMode, model, hasAvailableOpenCodeModels, reasoningEffort, initialPrompt, initialPromptAttachments, localEnvironmentAvailable, networkAccessMode, portMappings, onCreate, resetForm, onOpenChange, projectId, validatePortMappings]
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
          <DialogTitle>
            Create Ork (Environment){projectName ? ` - ${projectName}` : ""}
          </DialogTitle>
          <DialogDescription>
            Configure a new Ork environment with an optional initial prompt.
          </DialogDescription>
        </DialogHeader>

        <form ref={formRef} onSubmit={handleSubmit} className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto pr-1">
          <Tabs
            value={mobileSection}
            onValueChange={(value) => selectMobileSection(value as MobileSection)}
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
              data-mobile-transition={mobileTabTransitionDirection ?? undefined}
              className={cn(MOBILE_TAB_CONTENT_CLASSES, "space-y-4 sm:!contents")}
            >
          {/* Environment Type Selector */}
          <div className="space-y-2 sm:col-span-2">
            <Label>Environment Type</Label>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => setEnvironmentType("containerized")}
                disabled={isLoading || !dockerAvailable}
                title={!dockerAvailable ? "Start Docker to use container environments" : undefined}
                className={cn(
                  "p-3 rounded-lg border-2 text-left transition-colors",
                  environmentType === "containerized"
                    ? "border-primary bg-primary/5"
                    : UNSELECTED_CARD_CLASSES,
                  (isLoading || !dockerAvailable) && "opacity-50 cursor-not-allowed"
                )}
              >
                <div className="flex items-center gap-2">
                  <Container className="h-4 w-4" />
                  <div>
                    <div className="font-medium text-sm">Containerized</div>
                    <div className="text-xs text-muted-foreground">
                      {dockerAvailable ? "Isolated Docker environment" : "Unavailable while Docker is stopped"}
                    </div>
                  </div>
                </div>
              </button>

              <button
                type="button"
                onClick={() => setEnvironmentType("local")}
                disabled={isLoading || !localEnvironmentAvailable}
                title={
                  !localEnvironmentAvailable
                    ? "Add a local project checkout to use worktree environments"
                    : undefined
                }
                className={cn(
                  "p-3 rounded-lg border-2 text-left transition-colors",
                  environmentType === "local"
                    ? "border-primary bg-primary/5"
                    : UNSELECTED_CARD_CLASSES,
                  (isLoading || !localEnvironmentAvailable) && "opacity-50 cursor-not-allowed"
                )}
              >
                <div className="flex items-center gap-2">
                  <Laptop className="h-4 w-4" />
                  <div>
                    <div className="font-medium text-sm">Local</div>
                    <div className="text-xs text-muted-foreground">
                      {localEnvironmentAvailable
                        ? "Git worktree on your machine"
                        : "Unavailable without a local project checkout"}
                    </div>
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
                data-mobile-transition={mobileTabTransitionDirection ?? undefined}
                className={cn(MOBILE_TAB_CONTENT_CLASSES, "space-y-4 sm:!contents")}
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
              data-mobile-transition={mobileTabTransitionDirection ?? undefined}
              className={cn(MOBILE_TAB_CONTENT_CLASSES, "space-y-4 sm:!contents")}
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

          {/* Compact agent launch configuration */}
          <div
            className={cn(
              "space-y-3 sm:col-span-2",
              !launchAgent && "opacity-50",
            )}
          >
            <div className="flex min-h-5 items-center justify-between gap-4">
              <Label className="text-sm">Default Agent</Label>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="use-tui"
                  checked={selectedMode === "terminal"}
                  onCheckedChange={setUseTui}
                  disabled={isLoading || !launchAgent || agentType === "cursor" || agentType === "grok"}
                />
                <Label
                  htmlFor="use-tui"
                  className="cursor-pointer text-sm font-normal"
                >
                  Use TUI
                </Label>
              </div>
            </div>
            <div className="grid grid-cols-1 gap-3 rounded-xl border border-border/70 bg-zinc-950/45 p-3 sm:grid-cols-[max-content_minmax(0,1fr)_minmax(9rem,max-content)]">
              <div className="grid grid-rows-[1rem_2.25rem] gap-1.5">
                <Label className="text-xs font-normal leading-4 text-muted-foreground">
                  Agent
                </Label>
                <div
                  role="radiogroup"
                  aria-label="Default Agent"
                  className="flex h-9 w-fit items-center gap-1 rounded-md border border-input bg-input/30 p-1"
                >
                  {([
                    {
                      value: "claude",
                      label: "Claude",
                      icon: <ClaudeIcon className="h-4 w-4" />,
                    },
                    {
                      value: "codex",
                      label: "Codex",
                      icon: <CodexIcon className="h-4 w-4" />,
                    },
                    {
                      value: "opencode",
                      label: "OpenCode",
                      icon: <OpenCodeIcon className="h-4 w-4" />,
                    },
                    {
                      value: "cursor",
                      label: "Cursor Agent",
                      icon: <CursorAgentIcon className="h-4 w-4" />,
                    },
                    {
                      value: "grok",
                      label: "Grok Build",
                      icon: <GrokBuildIcon className="h-4 w-4" />,
                    },
                  ] as const)
                    .filter((option) => (config.global.enabledAgentPlatforms ?? ["claude", "codex", "opencode"]).includes(option.value))
                    .map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-label={option.label}
                      aria-checked={agentType === option.value}
                      title={option.label}
                      onClick={() => selectAgent(option.value)}
                      disabled={isLoading || !launchAgent}
                      className={cn(
                        "grid h-7 w-8 place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-zinc-800 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        agentType === option.value &&
                          "bg-primary text-primary-foreground shadow-sm hover:bg-primary hover:text-primary-foreground",
                        (isLoading || !launchAgent) && "cursor-not-allowed",
                      )}
                    >
                      {option.icon}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid min-w-0 grid-rows-[1rem_2.25rem] gap-1.5">
                <Label htmlFor="agent-model" className="text-xs font-normal leading-4 text-muted-foreground">
                  Model
                </Label>
                {agentType === "opencode" ? (
                  <AgentModelPicker
                    id="agent-model"
                    ariaLabel="Model"
                    models={availableModels.map((option) => ({
                      platform: "opencode" as const,
                      id: option.id,
                      label: option.name,
                      description: option.description,
                    }))}
                    enabledPlatforms={["opencode"]}
                    selectedPlatform="opencode"
                    favorites={favoriteModels}
                    onToggleFavorite={toggleFavoriteModel}
                    selectedModelId={model}
                    selectedModelLabel={availableModels.find((option) => option.id === model)?.name ?? "Select model"}
                    onModelChange={selectModel}
                    reasoningOptions={[]}
                    disabled={isLoading || !launchAgent}
                    title="Agent model"
                  />
                ) : (
                  <Select
                    value={model}
                    onValueChange={selectModel}
                    disabled={isLoading || !launchAgent}
                  >
                    <SelectTrigger id="agent-model" className="w-full">
                      <SelectValue placeholder="Select model" />
                    </SelectTrigger>
                    <SelectContent>
                      {availableModels.map((option) => (
                        <SelectItem key={option.id} value={option.id}>
                          {option.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>

              <div className="grid min-w-0 grid-rows-[1rem_2.25rem] gap-1.5">
                <Label
                  htmlFor="agent-reasoning-effort"
                  className="text-xs font-normal leading-4 text-muted-foreground"
                >
                  Reasoning effort
                </Label>
                <Select
                  value={reasoningEffort}
                  onValueChange={setReasoningEffort}
                  disabled={
                    isLoading ||
                    !launchAgent ||
                    availableReasoningEfforts.length === 0
                  }
                >
                  <SelectTrigger id="agent-reasoning-effort" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">Default</SelectItem>
                    {availableReasoningEfforts.map((effort) => (
                      <SelectItem key={effort} value={effort}>
                        {effort.charAt(0).toUpperCase() + effort.slice(1)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
            </TabsContent>

          {/* Port Configuration - only for containerized environments */}
          {environmentType === "containerized" && (
          <TabsContent
            value="ports"
            forceMount
            data-mobile-transition={mobileTabTransitionDirection ?? undefined}
            className={cn(MOBILE_TAB_CONTENT_CLASSES, "sm:col-span-2 sm:!block")}
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
                      <SelectTrigger
                        aria-label="Protocol"
                        className="col-span-3 col-start-1 w-full sm:col-span-1 sm:col-start-auto sm:w-20"
                      >
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
            data-mobile-transition={mobileTabTransitionDirection ?? undefined}
            className={cn(MOBILE_TAB_CONTENT_CLASSES, "sm:col-span-2 sm:!block")}
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
            disabled={
              isLoading
              || (environmentType === "containerized" && (!dockerAvailable || !validatePortMappings()))
              || (environmentType === "local" && !localEnvironmentAvailable)
            }
          >
            {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Create Environment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
