import { agentSettingsTiers, resolvedActionDefault } from "@/lib/agent-settings";
import {
  resolveAgentPlatformSettings,
  resolveDefaultAgent,
  type AgentSettingsTiers,
} from "@orkestrator/protocol/agent-settings";
import {
  MAX_INITIAL_PROMPT_ATTACHMENT_STORAGE_BYTES,
  serializedInitialPromptAttachmentBytes,
} from "@orkestrator/protocol/initial-prompt-attachments";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
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
  FileText,
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
  AgentStyle,
  ClaudeMode,
  CodexMode,
  EnvironmentType,
  NetworkAccessMode,
  OpenCodeMode,
  PortMapping,
  PortProtocol,
} from "@/types";
import type { AgentType } from "@/stores";
import { useCodexStore, useConfigStore } from "@/stores";
import { useClaudeStore } from "@/stores/claudeStore";
import { useOpenCodeStore } from "@/stores/openCodeStore";
import type { InitialPromptImageAttachment } from "@/lib/initial-prompt-attachments";
import { buildReviewModelCatalog, includeMissingOpenCodeModels } from "@/lib/review-launch-options";
import { effortLabel, modelsForAgent } from "@/lib/agent-launch";
import { resolveCreateEnvironmentAgentDefaults } from "@/lib/create-environment-agent-defaults";
import { FeatureBuildFields } from "./FeatureBuildFields";
import {
  defaultFeatureBuildModels,
  featureBuildIdentity,
  featureBuildRequest,
  type BuildIntent,
  type FeatureBuildModelState,
} from "@/lib/feature-build-launch";
import type { CreateFeatureBuildInput } from "@orkestrator/protocol/feature-build";
import {
  getCachedOpenCodeModelCatalog,
  ensureHostPiModelCatalog,
  type CachedOpenCodeModel,
} from "@/lib/backend";
import { useDockerAvailability } from "@/contexts/DockerAvailabilityContext";
import {
  firstEnabledAgentPlatform,
  type AgentPlatform,
} from "@orkestrator/protocol/agent-platforms";
import type { AgentModel } from "@orkestrator/protocol/native-agent";
import {
  normalizeOpenCodeModelProviders,
  openCodeModelDisplayLabel,
} from "@orkestrator/protocol/native-agent";
import { syncCachedAcpModels, useAgentModelCatalogStore } from "@/stores/agentModelCatalogStore";

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
      (record.variants === undefined ||
        (Array.isArray(record.variants) &&
          record.variants.every(
            (variant) => typeof variant === "string" && variant.trim().length > 0,
          )))
    );
  });
}

/**
 * The effective agent defaults for a new environment in this repository.
 *
 * Every mode comes from that platform's own column now. The previous version
 * read the repository's single `agentStyle` for every platform, which meant
 * choosing "Native" for Claude silently moved the other agents too.
 */
export function resolveAgentDefaults(
  tiers: AgentSettingsTiers,
  defaultAgentOverride?: AgentPlatform,
) {
  return {
    defaultAgent: defaultAgentOverride ?? resolveDefaultAgent(tiers),
    claudeMode: resolveAgentPlatformSettings(tiers, "claude").mode,
    opencodeMode: resolveAgentPlatformSettings(tiers, "opencode").mode,
    codexMode: resolveAgentPlatformSettings(tiers, "codex").mode,
    grokMode: resolveAgentPlatformSettings(tiers, "grok").mode,
    piMode: resolveAgentPlatformSettings(tiers, "pi").mode,
  } as const;
}

const MOBILE_TAB_TRIGGER_CLASSES =
  "h-11 min-w-0 flex-1 flex-col gap-0.5 rounded-lg px-1 py-1 text-[10px] leading-none data-[state=active]:border-primary/40 data-[state=active]:bg-primary/10 data-[state=active]:text-primary data-[state=active]:shadow-none";
const MOBILE_TAB_CONTENT_CLASSES =
  "create-environment-mobile-tab-panel mt-0 data-[state=inactive]:hidden";
const MAX_IMAGE_SIZE = 8 * 1024 * 1024;
const MAX_RGBA_SIZE = 32 * 1024 * 1024;
const MAX_INITIAL_PROMPT_ATTACHMENTS = 20;

export function getEncodedImageSizeError(base64Length: number): string | null {
  const estimatedSize = (base64Length * 3) / 4;
  if (estimatedSize <= MAX_IMAGE_SIZE) return null;
  return `Image is ${(estimatedSize / 1024 / 1024).toFixed(1)}MB. Maximum is 8MB.`;
}

type MobileSection = "prompt" | "environment" | "agent" | "access" | "ports";
type MobileTabTransitionDirection = "forward" | "backward";
type AttachmentOperation = { id: number; generation: number };

const MOBILE_SECTION_ORDER: MobileSection[] = ["prompt", "environment", "agent", "access", "ports"];

function generateImageFilename(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const random = Math.random().toString(36).substring(2, 8);
  return `initial-prompt-${timestamp}-${random}.png`;
}

export function pngFilenameForDroppedImage(filename: string): string {
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  return `${stem || "attachment"}.png`;
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 32 * 1024;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function AttachmentPreviews({
  attachments,
  disabled,
  onRemove,
}: {
  attachments: InitialPromptImageAttachment[];
  disabled: boolean;
  onRemove: (id: string) => void;
}) {
  if (attachments.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {attachments.map((attachment) => (
        <div
          key={attachment.id}
          className={cn(
            "group relative h-16 overflow-hidden rounded-md border border-border bg-muted",
            attachment.type === "file" ? "flex w-40 items-center gap-2 px-2" : "w-16",
          )}
        >
          {attachment.type === "file" ? (
            <>
              <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate pr-4 text-xs" title={attachment.name}>
                {attachment.name}
              </span>
            </>
          ) : (
            <img
              src={attachment.previewUrl}
              alt={attachment.name}
              className="h-full w-full object-cover"
            />
          )}
          <button
            type="button"
            onClick={() => onRemove(attachment.id)}
            disabled={disabled}
            className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-background/90 opacity-0 shadow-sm transition-opacity group-hover:opacity-100"
            aria-label={`Remove ${attachment.name}`}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  );
}

export interface ClaudeOptions {
  environmentType: EnvironmentType;
  environmentName: string;
  launchAgent: boolean;
  agentType: AgentType;
  claudeMode: ClaudeMode;
  opencodeMode: OpenCodeMode;
  codexMode: CodexMode;
  grokMode?: AgentStyle;
  piMode?: AgentStyle;
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
  /**
   * Starts a feature build: one backend request that creates the Kanban ticket,
   * the environment and the pipeline. Absent when the caller cannot build.
   *
   * Return false when creation has been deferred or cancelled by a preflight,
   * matching {@link onCreate}.
   */
  onCreateFeatureBuild?: (input: CreateFeatureBuildInput) => Promise<void | boolean>;
}

// Persist draft prompt text per project across dialog open/close within the session
const draftPrompts = new Map<string, string>();

export function CreateEnvironmentDialog({
  open,
  onOpenChange,
  onCreate,
  onCreateFeatureBuild,
  isLoading = false,
  projectId,
  projectName,
  defaultPortMappings = EMPTY_PORT_MAPPINGS,
  localEnvironmentAvailable = true,
}: CreateEnvironmentDialogProps) {
  const dockerAvailable = useDockerAvailability();
  const config = useConfigStore((state) => state.config);
  const repoConfig = projectId ? config.repositories[projectId] : undefined;

  const enabledAgentPlatforms = useMemo(
    () =>
      (config.global.enabledAgentPlatforms ?? ["claude", "codex", "opencode"]) as AgentPlatform[],
    [config.global.enabledAgentPlatforms],
  );
  const agentTiers = useMemo(
    () => agentSettingsTiers(config, projectId ?? undefined),
    [config, projectId],
  );
  const newProjectDefault = useMemo(
    () => resolvedActionDefault(agentTiers, "newProject", enabledAgentPlatforms),
    [agentTiers, enabledAgentPlatforms],
  );
  // Resolve effective defaults: project-level overrides > app-level
  const resolved = resolveAgentDefaults(agentTiers, newProjectDefault.agent);
  const configDefaultAgent = firstEnabledAgentPlatform(
    enabledAgentPlatforms,
    resolved.defaultAgent as AgentType,
  );
  const configClaudeMode = resolved.claudeMode as ClaudeMode;
  const configOpencodeMode = resolved.opencodeMode as OpenCodeMode;
  const configCodexMode = resolved.codexMode as CodexMode;
  const configGrokMode = resolved.grokMode;
  const configPiMode = resolved.piMode;
  const configEnvironmentType: EnvironmentType = repoConfig?.lastEnvironmentType ?? "containerized";
  const effectiveDefaultEnvironmentType: EnvironmentType =
    !dockerAvailable && localEnvironmentAvailable && configEnvironmentType === "containerized"
      ? "local"
      : !localEnvironmentAvailable && configEnvironmentType === "local" && dockerAvailable
        ? "containerized"
        : configEnvironmentType;
  const claudeModels = useClaudeStore((state) => state.models);
  const codexModels = useCodexStore((state) => state.models);
  const openCodeModels = useOpenCodeStore((state) => state.models);
  const cursorModels = useAgentModelCatalogStore((state) => state.cursorModels);
  const grokModels = useAgentModelCatalogStore((state) => state.grokModels);
  const piModels = useAgentModelCatalogStore((state) => state.piModels);
  const piCatalogSeedAttemptedRef = useRef(false);
  const [cachedOpenCodeModels, setCachedOpenCodeModels] = useState<CachedOpenCodeModel[]>([]);
  useEffect(() => {
    if (!open) {
      piCatalogSeedAttemptedRef.current = false;
      return;
    }
    if (
      !enabledAgentPlatforms.includes("pi") ||
      piModels.length > 0 ||
      piCatalogSeedAttemptedRef.current
    ) {
      return;
    }
    piCatalogSeedAttemptedRef.current = true;
    void ensureHostPiModelCatalog()
      .then((models) => {
        if (Array.isArray(models) && models.length > 0) syncCachedAcpModels(models);
      })
      .catch((error) => {
        console.warn("[CreateEnvironmentDialog] Failed to seed the Pi model catalogue:", error);
      });
  }, [enabledAgentPlatforms, open, piModels.length]);
  const {
    favorites: favoriteModels,
    toggleFavorite: toggleFavoriteModel,
    reorderFavorites,
  } = useAgentModelFavorites();
  const { resolvedModelsByPlatform, resolvedEffortsByPlatform } = useMemo(() => {
    const models: Partial<Record<AgentPlatform, string>> = {};
    const efforts: Partial<Record<AgentPlatform, string>> = {};
    for (const platform of enabledAgentPlatforms) {
      const resolved = resolveAgentPlatformSettings(agentTiers, platform);
      if (resolved.model) models[platform] = resolved.model;
      if (resolved.reasoningEffort) efforts[platform] = resolved.reasoningEffort;
    }
    return { resolvedModelsByPlatform: models, resolvedEffortsByPlatform: efforts };
  }, [agentTiers, enabledAgentPlatforms]);
  const openCodeDefaults = resolveAgentPlatformSettings(agentTiers, "opencode");
  const configuredOpenCodeModel =
    (newProjectDefault.agent === "opencode" ? newProjectDefault.model : undefined) ??
    openCodeDefaults.model;
  const configuredOpenCodeEffort =
    (newProjectDefault.agent === "opencode" ? newProjectDefault.reasoningEffort : undefined) ??
    openCodeDefaults.reasoningEffort;
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
  const modelCatalog = useMemo(() => {
    const liveCatalog = buildReviewModelCatalog(undefined);
    const hasLiveCatalog = Array.from(openCodeModels.values()).some((models) => models.length > 0);
    const catalog =
      !hasLiveCatalog && cachedOpenCodeModels.length > 0
        ? {
            ...liveCatalog,
            opencode: cachedOpenCodeModels.map((candidate) => ({
              id: candidate.id,
              name: openCodeModelDisplayLabel(candidate.id, candidate.name),
              description: candidate.provider,
              reasoningEfforts: [...(candidate.variants ?? [])],
            })),
          }
        : liveCatalog;
    const withConfigured = (() => {
      if (!configuredOpenCodeModel) return catalog;
      const configuredModel = catalog.opencode.find(
        (candidate) => candidate.id === configuredOpenCodeModel,
      );
      if (configuredModel) {
        if (
          !configuredOpenCodeEffort ||
          configuredModel.reasoningEfforts?.includes(configuredOpenCodeEffort)
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
              : candidate,
          ),
        };
      }
      return {
        ...catalog,
        opencode: [
          {
            id: configuredOpenCodeModel,
            name: openCodeModelDisplayLabel(configuredOpenCodeModel),
            description: "Configured default",
            reasoningEfforts: configuredOpenCodeEffort ? [configuredOpenCodeEffort] : [],
          },
          ...catalog.opencode,
        ],
      };
    })();
    return {
      ...withConfigured,
      opencode: includeMissingOpenCodeModels(
        withConfigured.opencode,
        favoriteModels
          .filter((favorite) => favorite.platform === "opencode")
          .map((favorite) => favorite.modelId),
        normalizeOpenCodeModelProviders(config.global.openCodeModelProviders),
      ),
    };
    // buildReviewModelCatalog reads the Claude/Codex/Cursor/Grok/Pi stores through
    // getState(), which does not subscribe. These selectors are the subscription:
    // the rule sees them as unused because the body never names them, but dropping
    // them freezes the catalog at whatever was loaded on first render.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [
    claudeModels,
    cachedOpenCodeModels,
    codexModels,
    config.global.openCodeModelProviders,
    configuredOpenCodeEffort,
    configuredOpenCodeModel,
    cursorModels,
    favoriteModels,
    grokModels,
    piModels,
    openCodeModels,
  ]);

  const configuredAgentDefaults = useMemo(
    () => ({
      agent: configDefaultAgent,
      claudeMode: configClaudeMode,
      opencodeMode: configOpencodeMode,
      codexMode: configCodexMode,
      grokMode: configGrokMode,
      piMode: configPiMode,
      // Each platform's own resolved column, so a model is only ever offered to
      // the platform whose catalogue it came from.
      models: {
        ...resolvedModelsByPlatform,
        ...(newProjectDefault.model ? { [newProjectDefault.agent]: newProjectDefault.model } : {}),
      },
      reasoningEfforts: {
        ...resolvedEffortsByPlatform,
        ...(newProjectDefault.reasoningEffort
          ? { [newProjectDefault.agent]: newProjectDefault.reasoningEffort }
          : {}),
      },
    }),
    [
      resolvedModelsByPlatform,
      resolvedEffortsByPlatform,
      configClaudeMode,
      configCodexMode,
      configDefaultAgent,
      configGrokMode,
      configPiMode,
      configOpencodeMode,
      newProjectDefault,
    ],
  );
  const initialAgentDefaults = useMemo(
    () =>
      resolveCreateEnvironmentAgentDefaults({
        catalog: modelCatalog,
        enabledAgents: enabledAgentPlatforms,
        configured: configuredAgentDefaults,
      }),
    [configuredAgentDefaults, enabledAgentPlatforms, modelCatalog],
  );
  const getInitialAgentSelection = useCallback(
    (nextAgent: AgentType) => {
      const defaults = resolveCreateEnvironmentAgentDefaults({
        catalog: modelCatalog,
        enabledAgents: [nextAgent],
        configured: { ...configuredAgentDefaults, agent: nextAgent },
      });
      return {
        model: defaults.model,
        reasoningEffort: defaults.reasoningEffort,
      };
    },
    [configuredAgentDefaults, modelCatalog],
  );

  const [environmentType, setEnvironmentType] = useState<EnvironmentType>(
    effectiveDefaultEnvironmentType,
  );
  const [environmentName, setEnvironmentName] = useState("");
  const [launchAgent, setLaunchAgent] = useState(true);
  const [agentType, setAgentType] = useState<AgentType>(initialAgentDefaults.agent);
  const [claudeMode, setClaudeMode] = useState<ClaudeMode>(initialAgentDefaults.claudeMode);
  const [opencodeMode, setOpencodeMode] = useState<OpenCodeMode>(initialAgentDefaults.opencodeMode);
  const [codexMode, setCodexMode] = useState<CodexMode>(initialAgentDefaults.codexMode);
  const [grokMode, setGrokMode] = useState<AgentStyle>(initialAgentDefaults.grokMode);
  const [piMode, setPiMode] = useState<AgentStyle>(initialAgentDefaults.piMode);
  const [model, setModel] = useState(initialAgentDefaults.model);
  const [reasoningEffort, setReasoningEffort] = useState(initialAgentDefaults.reasoningEffort);
  /**
   * The models "Customize models" opens on.
   *
   * Every non-build step reads its own Settings entry — the same entries the
   * review, multi-review, PR and resolve launchers use. Build follows the live
   * Default Agent picker, including model and reasoning, because that is the
   * decision the user has already made a few controls above.
   */
  const defaultFeatureModels = useMemo(
    () =>
      defaultFeatureBuildModels({
        catalog: modelCatalog,
        build: {
          agent: agentType,
          model,
          reasoningEffort,
        },
        review: resolvedActionDefault(agentTiers, "review", enabledAgentPlatforms),
        review2: resolvedActionDefault(agentTiers, "review2", enabledAgentPlatforms),
        address: resolvedActionDefault(agentTiers, "fixReviewIssues", enabledAgentPlatforms),
        pr: resolvedActionDefault(agentTiers, "pr", enabledAgentPlatforms),
        resolve: resolvedActionDefault(agentTiers, "resolve", enabledAgentPlatforms),
      }),
    [agentTiers, agentType, enabledAgentPlatforms, model, modelCatalog, reasoningEffort],
  );
  const [buildIntent, setBuildIntent] = useState<BuildIntent>("prompt");
  const [featureName, setFeatureName] = useState("");
  const [featureDescription, setFeatureDescription] = useState("");
  const [featureAcceptanceCriteria, setFeatureAcceptanceCriteria] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [customizeModels, setCustomizeModels] = useState(false);
  const [featureModels, setFeatureModels] = useState<FeatureBuildModelState | null>(null);
  /**
   * Idempotency key for the feature build.
   *
   * Held so a retry after a lost response returns the same ticket and the same
   * pipeline rather than a second of each. Rotated on a successful create, on a
   * reset, and — see `featureAttemptIdentityRef` — whenever the user edits the
   * request between attempts.
   */
  const featureRequestIdRef = useRef(createUuid());
  /**
   * The request the current key was last spent on, or null if it is unspent.
   *
   * The backend binds a key to its first arguments and rejects reuse with
   * different ones. A create can fail *after* the ticket was written — a
   * provisioning failure is the common one — and the natural response is to
   * change something and try again, so an edited retry has to arrive under a
   * new key. An unchanged retry must not, because that is the lost-response
   * case the key exists for.
   */
  const featureAttemptIdentityRef = useRef<string | null>(null);
  /**
   * Concrete model defaults used by the current attempt.
   *
   * Live catalogues may arrive after a request whose response was lost. A retry
   * must reuse the exact reviewer payload bound to its idempotency key, while an
   * explicit picker edit or toggle is allowed to replace this snapshot.
   */
  const featureAttemptModelsRef = useRef<FeatureBuildModelState | null>(null);
  // Held as null until the panel is first shown so that reopening the dialog,
  // or a catalogue arriving late, re-resolves the defaults instead of pinning
  // whatever was known on first render.
  const effectiveFeatureModels = featureModels ?? defaultFeatureModels;
  const [initialPrompt, setInitialPrompt] = useState("");
  const [initialPromptAttachments, setInitialPromptAttachments] = useState<
    InitialPromptImageAttachment[]
  >([]);
  const [isDraggingAttachments, setIsDraggingAttachments] = useState(false);
  const [pendingAttachmentOperations, setPendingAttachmentOperations] = useState(0);
  const [networkAccessMode, setNetworkAccessMode] = useState<NetworkAccessMode>("full");
  const [portMappings, setPortMappings] = useState<PortMapping[]>(defaultPortMappings);
  const [showPortConfig, setShowPortConfig] = useState(defaultPortMappings.length > 0);
  const [mobileSection, setMobileSection] = useState<MobileSection>("prompt");
  const [mobileTabTransitionDirection, setMobileTabTransitionDirection] =
    useState<MobileTabTransitionDirection | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const buildIntentRef = useRef<BuildIntent>("prompt");
  const promptPasteRequestIdRef = useRef(0);
  const initialPromptAttachmentsRef = useRef<InitialPromptImageAttachment[]>([]);
  const attachmentDragDepthRef = useRef(0);
  const attachmentProcessingGenerationRef = useRef(0);
  const nextAttachmentOperationIdRef = useRef(0);
  const activeAttachmentOperationIdsRef = useRef(new Set<number>());
  const promptPasteOperationRef = useRef<AttachmentOperation | null>(null);
  const agentSelectionTouchedRef = useRef(false);

  useEffect(() => {
    if (
      open &&
      !dockerAvailable &&
      localEnvironmentAvailable &&
      environmentType === "containerized"
    ) {
      setEnvironmentType("local");
    } else if (
      open &&
      !localEnvironmentAvailable &&
      dockerAvailable &&
      environmentType === "local"
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
          if (!cancelled && snapshot && snapshot.projectId === normalizedProjectId && models) {
            setCachedOpenCodeModels(models);
          }
        })
        .catch((error) => {
          console.warn("[CreateEnvironmentDialog] Failed to load cached OpenCode models:", error);
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
    attachmentProcessingGenerationRef.current += 1;
    activeAttachmentOperationIdsRef.current.clear();
    promptPasteOperationRef.current = null;
    setEnvironmentType(effectiveDefaultEnvironmentType);
    setEnvironmentName("");
    setLaunchAgent(true);
    setAgentType(initialAgentDefaults.agent);
    setClaudeMode(initialAgentDefaults.claudeMode);
    setOpencodeMode(initialAgentDefaults.opencodeMode);
    setCodexMode(initialAgentDefaults.codexMode);
    setGrokMode(initialAgentDefaults.grokMode);
    setPiMode(initialAgentDefaults.piMode);
    setModel(initialAgentDefaults.model);
    setReasoningEffort(initialAgentDefaults.reasoningEffort);
    agentSelectionTouchedRef.current = false;
    setInitialPrompt("");
    initialPromptAttachmentsRef.current = [];
    setInitialPromptAttachments([]);
    setIsDraggingAttachments(false);
    setPendingAttachmentOperations(0);
    attachmentDragDepthRef.current = 0;
    setNetworkAccessMode("full");
    setPortMappings(defaultPortMappings);
    setShowPortConfig(defaultPortMappings.length > 0);
    setMobileSection("prompt");
    setMobileTabTransitionDirection(null);
    buildIntentRef.current = "prompt";
    setBuildIntent("prompt");
    setFeatureName("");
    setFeatureDescription("");
    setFeatureAcceptanceCriteria("");
    setAdvancedOpen(false);
    setCustomizeModels(false);
    // Back to null rather than to the current defaults, so the next opening
    // re-resolves them against whatever the catalogue holds by then.
    setFeatureModels(null);
    // The form this key was minted for is gone, so it can never be the "same
    // request again" a reuse would stand for.
    featureRequestIdRef.current = createUuid();
    featureAttemptIdentityRef.current = null;
    featureAttemptModelsRef.current = null;
  }, [defaultPortMappings, effectiveDefaultEnvironmentType, initialAgentDefaults]);

  const handleCustomizeModelsChange = useCallback(
    (enabled: boolean) => {
      setCustomizeModels(enabled);
      // Enabling pins what the user sees. Disabling discards every panel edit,
      // matching the switch's promise to return to configured defaults.
      setFeatureModels(enabled ? defaultFeatureModels : null);
      featureAttemptModelsRef.current = null;
    },
    [defaultFeatureModels],
  );

  const handleFeatureModelsChange = useCallback((models: FeatureBuildModelState) => {
    setFeatureModels(models);
    featureAttemptModelsRef.current = null;
  }, []);

  const handleBuildIntentChange = useCallback((intent: BuildIntent) => {
    if (intent === buildIntentRef.current) return;
    promptPasteRequestIdRef.current += 1;
    attachmentProcessingGenerationRef.current += 1;
    activeAttachmentOperationIdsRef.current.clear();
    promptPasteOperationRef.current = null;
    setPendingAttachmentOperations(0);
    attachmentDragDepthRef.current = 0;
    setIsDraggingAttachments(false);
    buildIntentRef.current = intent;
    setBuildIntent(intent);
  }, []);

  const beginAttachmentOperation = useCallback(() => {
    const operation = {
      id: ++nextAttachmentOperationIdRef.current,
      generation: attachmentProcessingGenerationRef.current,
    };
    activeAttachmentOperationIdsRef.current.add(operation.id);
    setPendingAttachmentOperations(activeAttachmentOperationIdsRef.current.size);
    return operation;
  }, []);

  const finishAttachmentOperation = useCallback((operation: AttachmentOperation) => {
    if (operation.generation !== attachmentProcessingGenerationRef.current) return;
    if (!activeAttachmentOperationIdsRef.current.delete(operation.id)) return;
    setPendingAttachmentOperations(activeAttachmentOperationIdsRef.current.size);
  }, []);

  const encodeImageAttachment = useCallback(
    async (
      blob: Blob | null | undefined,
      filename?: string,
      isCurrent: () => boolean = () => true,
    ): Promise<InitialPromptImageAttachment | null> => {
      const image = await readImage(blob);
      if (!isCurrent()) return null;
      const rgba = await image.rgba();
      if (!isCurrent()) return null;
      const { width, height } = await image.size();
      if (!isCurrent()) return null;

      let canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;

      const imageData = new ImageData(new Uint8ClampedArray(rgba), width, height);
      ctx.putImageData(imageData, 0, 0);
      canvas = resizeCanvasToMaxDimension(canvas, MAX_IMAGE_DIMENSION);
      canvas = resizeCanvasIfNeeded(canvas, MAX_RGBA_SIZE);

      const encodedImage = encodeCanvasAsPngWithinSize(canvas, MAX_IMAGE_SIZE);
      if (!encodedImage) {
        if (isCurrent()) {
          toast.error("Image too large", {
            description: "The image could not be resized below the 8MB attachment limit.",
          });
        }
        return null;
      }
      if (!isCurrent()) {
        encodedImage.canvas.width = 0;
        encodedImage.canvas.height = 0;
        return null;
      }
      canvas = encodedImage.canvas;
      const { dataUrl: previewUrl, base64Data } = encodedImage;
      canvas.width = 0;
      canvas.height = 0;

      return {
        id: createUuid(),
        name: filename ? pngFilenameForDroppedImage(filename) : generateImageFilename(),
        type: "image",
        previewUrl,
        base64Data,
      };
    },
    [],
  );

  const appendInitialPromptAttachments = useCallback(
    (attachments: InitialPromptImageAttachment[]): boolean => {
      if (attachments.length === 0) return false;
      const current = initialPromptAttachmentsRef.current;
      const next = [...current, ...attachments];
      if (next.length > MAX_INITIAL_PROMPT_ATTACHMENTS) {
        toast.error("Too many attachments", {
          description: `Up to ${MAX_INITIAL_PROMPT_ATTACHMENTS} attachments can be included.`,
        });
        return false;
      }
      const durableBytes = serializedInitialPromptAttachmentBytes(next);
      if (durableBytes > MAX_INITIAL_PROMPT_ATTACHMENT_STORAGE_BYTES) {
        toast.error("Attachments too large", {
          description: "Attachments can use up to 32MB of stored data.",
        });
        return false;
      }
      initialPromptAttachmentsRef.current = next;
      setInitialPromptAttachments(next);
      return true;
    },
    [],
  );

  const handlePromptPaste = useCallback(
    async (event: ClipboardEvent) => {
      const isPasteTarget = () =>
        buildIntentRef.current === "feature" ||
        (launchAgent && document.activeElement === promptRef.current);
      if (!open || !isPasteTarget()) return;

      const pasteIntent = buildIntentRef.current;
      const pastedBlob = getPastedImageBlob(event);
      // A native paste event already exposes its complete readable payload.
      // If that payload contains no image, leave text paste alone without
      // starting an operation or asking the browser to read the clipboard.
      if (event.clipboardData && !pastedBlob) return;

      const requestId = ++promptPasteRequestIdRef.current;
      const previousOperation = promptPasteOperationRef.current;
      if (previousOperation) finishAttachmentOperation(previousOperation);
      const operation = beginAttachmentOperation();
      promptPasteOperationRef.current = operation;
      const isCurrentRequest = () =>
        requestId === promptPasteRequestIdRef.current &&
        operation.generation === attachmentProcessingGenerationRef.current &&
        pasteIntent === buildIntentRef.current &&
        isPasteTarget();

      try {
        if (pastedBlob) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }

        const attachment = await encodeImageAttachment(pastedBlob, undefined, isCurrentRequest);
        if (!isCurrentRequest()) return;
        if (!attachment) return;

        if (!pastedBlob) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }

        if (appendInitialPromptAttachments([attachment])) {
          toast.success("Image attached");
        }
      } catch {
        // No image in the clipboard; let normal text paste continue.
      } finally {
        if (promptPasteOperationRef.current?.id === operation.id) {
          promptPasteOperationRef.current = null;
        }
        finishAttachmentOperation(operation);
      }
    },
    [
      appendInitialPromptAttachments,
      beginAttachmentOperation,
      encodeImageAttachment,
      finishAttachmentOperation,
      launchAgent,
      open,
    ],
  );

  const handleAttachmentDrop = useCallback(
    async (event: React.DragEvent<HTMLElement>) => {
      attachmentDragDepthRef.current = 0;
      setIsDraggingAttachments(false);
      if (event.dataTransfer.files.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      if (!open || (buildIntent !== "feature" && !launchAgent) || isLoading) return;

      const dropIntent = buildIntentRef.current;
      let files = Array.from(event.dataTransfer.files);
      let skippedFeatureFiles = 0;
      if (dropIntent === "feature") {
        const imageCandidates = files.filter(
          (file) => file.type.startsWith("image/") || file.type === "",
        );
        skippedFeatureFiles = files.length - imageCandidates.length;
        files = imageCandidates;
        if (files.length === 0) {
          toast.error("Only images can be attached to a feature build");
          return;
        }
      }
      const currentAttachments = initialPromptAttachmentsRef.current;
      if (currentAttachments.length + files.length > MAX_INITIAL_PROMPT_ATTACHMENTS) {
        toast.error("Too many attachments", {
          description: `Up to ${MAX_INITIAL_PROMPT_ATTACHMENTS} attachments can be included.`,
        });
        return;
      }
      const empty = files.find((file) => file.size === 0);
      if (empty) {
        toast.error("File is empty", { description: empty.name });
        return;
      }
      const oversized = files.find((file) => file.size > MAX_IMAGE_SIZE);
      if (oversized) {
        toast.error("File too large", {
          description: `${oversized.name} exceeds the 8MB attachment limit.`,
        });
        return;
      }
      const operation = beginAttachmentOperation();
      const isCurrentOperation = () =>
        operation.generation === attachmentProcessingGenerationRef.current &&
        dropIntent === buildIntentRef.current;
      try {
        const attachments: InitialPromptImageAttachment[] = [];
        for (const file of files) {
          try {
            if (dropIntent === "feature" || file.type.startsWith("image/")) {
              const attachment = await encodeImageAttachment(file, file.name, isCurrentOperation);
              if (!isCurrentOperation()) return;
              if (attachment) {
                attachments.push(attachment);
              } else if (dropIntent === "feature") {
                skippedFeatureFiles += 1;
              }
            } else {
              const buffer = await file.arrayBuffer();
              if (!isCurrentOperation()) return;
              attachments.push({
                id: createUuid(),
                name: file.name || "attachment",
                type: "file",
                base64Data: bytesToBase64(new Uint8Array(buffer)),
              });
            }
          } catch (error) {
            if (!isCurrentOperation()) return;
            console.warn("[CreateEnvironmentDialog] Failed to read dropped attachment:", error);
            if (dropIntent === "feature") {
              skippedFeatureFiles += 1;
            } else {
              toast.error("Could not attach file", { description: file.name });
            }
          }
        }
        if (!isCurrentOperation()) return;
        if (appendInitialPromptAttachments(attachments)) {
          toast.success(
            `${attachments.length} file${attachments.length === 1 ? "" : "s"} attached`,
          );
        }
        if (skippedFeatureFiles > 0) {
          toast.error("Some files were skipped", {
            description: `${skippedFeatureFiles} unsupported file${skippedFeatureFiles === 1 ? " was" : "s were"} not attached.`,
          });
        }
      } finally {
        finishAttachmentOperation(operation);
      }
    },
    [
      appendInitialPromptAttachments,
      beginAttachmentOperation,
      encodeImageAttachment,
      finishAttachmentOperation,
      buildIntent,
      isLoading,
      launchAgent,
      open,
    ],
  );

  const hasDraggedFiles = useCallback(
    (event: React.DragEvent<HTMLElement>) => Array.from(event.dataTransfer.types).includes("Files"),
    [],
  );

  const handleAttachmentDragEnter = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      if (!hasDraggedFiles(event)) return;
      event.preventDefault();
      if (!open || (buildIntent !== "feature" && !launchAgent) || isLoading) return;
      attachmentDragDepthRef.current += 1;
      setIsDraggingAttachments(true);
    },
    [buildIntent, hasDraggedFiles, isLoading, launchAgent, open],
  );

  const handleAttachmentDragOver = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      if (!hasDraggedFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect =
        open && (buildIntent === "feature" || launchAgent) && !isLoading ? "copy" : "none";
    },
    [buildIntent, hasDraggedFiles, isLoading, launchAgent, open],
  );

  const handleAttachmentDragLeave = useCallback(() => {
    if (attachmentDragDepthRef.current === 0) return;
    attachmentDragDepthRef.current = Math.max(0, attachmentDragDepthRef.current - 1);
    if (attachmentDragDepthRef.current === 0) setIsDraggingAttachments(false);
  }, []);

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

  useEffect(() => {
    if (open && (launchAgent || buildIntent === "feature")) return;
    promptPasteRequestIdRef.current += 1;
    attachmentProcessingGenerationRef.current += 1;
    activeAttachmentOperationIdsRef.current.clear();
    promptPasteOperationRef.current = null;
    setPendingAttachmentOperations(0);
  }, [buildIntent, launchAgent, open]);

  useEffect(
    () => () => {
      promptPasteRequestIdRef.current += 1;
      attachmentProcessingGenerationRef.current += 1;
      activeAttachmentOperationIdsRef.current.clear();
      promptPasteOperationRef.current = null;
    },
    [],
  );

  const removeInitialPromptAttachment = useCallback((id: string) => {
    const next = initialPromptAttachmentsRef.current.filter((attachment) => attachment.id !== id);
    initialPromptAttachmentsRef.current = next;
    setInitialPromptAttachments(next);
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
      agentSelectionTouchedRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read current defaults only when the dialog opens
  }, [open]);

  // Model catalogues can arrive after the dialog opens (especially OpenCode's
  // project-scoped cache). Keep applying the configured selection until the user
  // changes an agent control, then leave their in-progress choice alone.
  useEffect(() => {
    if (!open || agentSelectionTouchedRef.current) return;
    setAgentType(initialAgentDefaults.agent);
    setClaudeMode(initialAgentDefaults.claudeMode);
    setOpencodeMode(initialAgentDefaults.opencodeMode);
    setCodexMode(initialAgentDefaults.codexMode);
    setGrokMode(initialAgentDefaults.grokMode);
    setPiMode(initialAgentDefaults.piMode);
    setModel(initialAgentDefaults.model);
    setReasoningEffort(initialAgentDefaults.reasoningEffort);
  }, [initialAgentDefaults, open]);

  /**
   * Terminal-versus-native is no longer a per-environment choice in this
   * dialog: it comes from each platform's own Settings column, which is where
   * every other launcher reads it from. The checkbox that used to override it
   * here is now Launch Agent.
   */
  const availableModels = modelsForAgent(modelCatalog, agentType);
  const pickerModels = enabledAgentPlatforms.flatMap((platform) =>
    modelsForAgent(modelCatalog, platform).map((option) => ({
      platform,
      id: option.id,
      label: option.name,
      description: option.description,
    })),
  );
  const selectedModel = availableModels.find((candidate) => candidate.id === model);
  const availableReasoningEfforts =
    availableModels.find((candidate) => candidate.id === model)?.reasoningEfforts ?? [];
  const reasoningOptions =
    availableReasoningEfforts.length > 0
      ? [
          { id: "default", label: "Default" },
          ...availableReasoningEfforts.map((effort) => ({
            id: effort,
            label: effortLabel(effort),
          })),
        ]
      : [];

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
      reasoningEffort !== "default" &&
      !selectedModel.reasoningEfforts?.includes(reasoningEffort)
    ) {
      setReasoningEffort("default");
    }
  }, [agentType, availableModels, getInitialAgentSelection, model, open, reasoningEffort]);

  const selectAgent = useCallback(
    (nextAgent: AgentType) => {
      if (nextAgent === agentType) return;
      agentSelectionTouchedRef.current = true;
      featureAttemptModelsRef.current = null;
      setAgentType(nextAgent);
      const nextSelection = getInitialAgentSelection(nextAgent);
      setModel(nextSelection.model);
      setReasoningEffort(nextSelection.reasoningEffort);
    },
    [agentType, getInitialAgentSelection],
  );

  const selectAgentModel = useCallback(
    (nextModel: AgentModel) => {
      agentSelectionTouchedRef.current = true;
      featureAttemptModelsRef.current = null;
      const targetModels = modelsForAgent(modelCatalog, nextModel.platform);
      const supportedEfforts =
        targetModels.find((candidate) => candidate.id === nextModel.id)?.reasoningEfforts ?? [];
      const nextReasoningEffort =
        nextModel.platform === agentType
          ? reasoningEffort
          : getInitialAgentSelection(nextModel.platform).reasoningEffort;

      setAgentType(nextModel.platform);
      setModel(nextModel.id);
      setReasoningEffort(
        nextReasoningEffort !== "default" && supportedEfforts.includes(nextReasoningEffort)
          ? nextReasoningEffort
          : "default",
      );
    },
    [agentType, getInitialAgentSelection, modelCatalog, reasoningEffort],
  );

  // The picker resolves a model to `selectAgentModel`; this id-only form is the
  // fallback shape it uses without that handler. It delegates rather than
  // repeating the effort-compatibility rule so the two cannot drift.
  const selectModel = useCallback(
    (nextModel: string) => {
      selectAgentModel({ platform: agentType, id: nextModel, label: nextModel });
    },
    [agentType, selectAgentModel],
  );

  const selectReasoningEffort = useCallback((nextEffort: string) => {
    agentSelectionTouchedRef.current = true;
    featureAttemptModelsRef.current = null;
    setReasoningEffort(nextEffort);
  }, []);

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

  const updatePortMapping = useCallback((index: number, updates: Partial<PortMapping>) => {
    setPortMappings((prev) => prev.map((m, i) => (i === index ? { ...m, ...updates } : m)));
  }, []);

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
    [onOpenChange, resetForm, projectId, initialPrompt],
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

      if (activeAttachmentOperationIdsRef.current.size > 0) return;

      if (environmentType === "containerized" && !dockerAvailable) return;
      if (environmentType === "local" && !localEnvironmentAvailable) return;

      // Validate port mappings before submission
      if (environmentType === "containerized" && !validatePortMappings()) {
        console.error("Invalid port mappings: ports must be between 1 and 65535");
        return;
      }

      try {
        if (buildIntent === "feature") {
          if (!projectId || !onCreateFeatureBuild || !featureName.trim()) return;
          const requestModels = featureAttemptModelsRef.current ?? effectiveFeatureModels;
          const buildRequest = (requestId: string) =>
            featureBuildRequest({
              projectId,
              title: featureName,
              description: featureDescription,
              acceptanceCriteria: featureAcceptanceCriteria,
              environmentType,
              environmentName,
              networkAccessMode,
              portMappings,
              images: initialPromptAttachments
                .filter((attachment) => attachment.type !== "file")
                .map((attachment) => ({
                  filename: attachment.name,
                  data: attachment.base64Data,
                })),
              models: requestModels,
              requestId,
            });
          let request = buildRequest(featureRequestIdRef.current);
          const identity = featureBuildIdentity(request);
          // A previous attempt may have created the ticket before it failed, so
          // the key is spent. Reusing it for an edited request is rejected
          // outright by the backend; only an unchanged retry may reuse it.
          if (
            featureAttemptIdentityRef.current !== null &&
            featureAttemptIdentityRef.current !== identity
          ) {
            featureRequestIdRef.current = createUuid();
            request = buildRequest(featureRequestIdRef.current);
          }
          featureAttemptIdentityRef.current = identity;
          featureAttemptModelsRef.current = requestModels;
          const started = await onCreateFeatureBuild(request);
          if (started === false) return;
          // A new key only after the request succeeded: a retry of a create
          // whose response was lost has to reuse this one.
          featureRequestIdRef.current = createUuid();
          featureAttemptIdentityRef.current = null;
          featureAttemptModelsRef.current = null;
          resetForm();
          onOpenChange(false);
          return;
        }
        const created = await onCreate({
          environmentType,
          environmentName: environmentName.trim(),
          launchAgent,
          agentType,
          claudeMode,
          opencodeMode,
          codexMode,
          grokMode,
          piMode,
          model:
            agentType === "opencode" && model === "default" && !hasAvailableOpenCodeModels
              ? undefined
              : model,
          reasoningEffort: reasoningEffort === "default" ? undefined : reasoningEffort,
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
        toast.error("Could not create environment", {
          description: err instanceof Error ? err.message : "An unexpected error occurred.",
        });
      }
    },
    [
      dockerAvailable,
      environmentType,
      environmentName,
      launchAgent,
      agentType,
      buildIntent,
      effectiveFeatureModels,
      featureAcceptanceCriteria,
      featureDescription,
      featureName,
      onCreateFeatureBuild,
      claudeMode,
      opencodeMode,
      codexMode,
      grokMode,
      piMode,
      model,
      hasAvailableOpenCodeModels,
      reasoningEffort,
      initialPrompt,
      initialPromptAttachments,
      localEnvironmentAvailable,
      networkAccessMode,
      portMappings,
      onCreate,
      resetForm,
      onOpenChange,
      projectId,
      validatePortMappings,
    ],
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
        !isLoading &&
        pendingAttachmentOperations === 0
      ) {
        e.preventDefault();
        formRef.current?.requestSubmit();
      }
    },
    [isLoading, pendingAttachmentOperations],
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className={cn(
          "flex max-h-[calc(100dvh-1rem)] flex-col gap-0 overflow-hidden p-0 sm:max-h-[90vh] sm:max-w-[896px] sm:p-0",
          isDraggingAttachments && "ring-2 ring-primary ring-offset-2 ring-offset-background",
        )}
        onDragEnter={handleAttachmentDragEnter}
        onDragOver={handleAttachmentDragOver}
        onDragLeave={handleAttachmentDragLeave}
        onDrop={(event) => void handleAttachmentDrop(event)}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader className="m-0 shrink-0 gap-0 border-b border-divider bg-background px-4 py-3.5 pr-14 sm:m-0 sm:px-6 sm:py-4 sm:pr-14">
          <div className="flex min-w-0 items-start gap-3">
            <span
              role="img"
              aria-label={
                environmentType === "containerized"
                  ? "Containerized environment"
                  : "Local environment"
              }
              className="mt-0.5 shrink-0 text-primary"
            >
              {environmentType === "containerized" ? (
                <Container className="size-5" aria-hidden="true" />
              ) : (
                <Laptop className="size-5" aria-hidden="true" />
              )}
            </span>
            <DialogTitle
              aria-label={
                projectName
                  ? `Create Ork (Environment) - ${projectName}`
                  : "Create Ork (Environment)"
              }
              className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 text-xl leading-tight"
            >
              <span className="shrink-0">Create Ork (Environment)</span>
              {projectName && (
                <span className="max-w-full truncate font-mono text-sm text-muted-foreground">
                  {projectName}
                </span>
              )}
            </DialogTitle>
          </div>
          <DialogDescription className="sr-only">
            Configure a new Ork environment with an optional initial prompt.
          </DialogDescription>
        </DialogHeader>

        <form
          ref={formRef}
          onSubmit={handleSubmit}
          className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
        >
          <Tabs
            value={mobileSection}
            onValueChange={(value) => selectMobileSection(value as MobileSection)}
            className="min-h-0 gap-0"
          >
            <TabsList
              aria-label="Environment configuration sections"
              className="sticky top-0 z-10 m-2 flex h-auto w-[calc(100%-1rem)] shrink-0 rounded-xl border border-border/80 bg-zinc-950/95 p-1 shadow-lg shadow-black/15 backdrop-blur sm:hidden"
            >
              <TabsTrigger
                value="prompt"
                disabled={!launchAgent}
                className={MOBILE_TAB_TRIGGER_CLASSES}
              >
                <MessageSquareText className="h-4 w-4" />
                <span>Prompt</span>
              </TabsTrigger>
              <TabsTrigger value="environment" className={MOBILE_TAB_TRIGGER_CLASSES}>
                <Container className="h-4 w-4" />
                <span>Setup</span>
              </TabsTrigger>
              <TabsTrigger value="agent" className={MOBILE_TAB_TRIGGER_CLASSES}>
                <Bot className="h-4 w-4" />
                <span>Agent</span>
              </TabsTrigger>
              {environmentType === "containerized" && (
                <>
                  <TabsTrigger value="access" className={MOBILE_TAB_TRIGGER_CLASSES}>
                    <Shield className="h-4 w-4" />
                    <span>Access</span>
                  </TabsTrigger>
                  <TabsTrigger value="ports" className={MOBILE_TAB_TRIGGER_CLASSES}>
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
              className={cn(MOBILE_TAB_CONTENT_CLASSES, "sm:!contents")}
            >
              {/* Environment Type Selector */}
              <div className="border-b border-divider px-4 py-3 sm:grid sm:grid-cols-[7.5rem_minmax(0,1fr)] sm:items-center sm:gap-4 sm:px-6">
                <Label className="mb-2 block text-sm font-medium text-muted-foreground sm:mb-0">
                  Type
                </Label>
                <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
                  <div className="inline-grid grid-cols-2 rounded-lg border border-divider bg-input-surface p-0.5">
                    <button
                      type="button"
                      onClick={() => setEnvironmentType("containerized")}
                      disabled={isLoading || !dockerAvailable}
                      aria-describedby={!dockerAvailable ? "containerized-unavailable" : undefined}
                      title={
                        !dockerAvailable ? "Start Docker to use container environments" : undefined
                      }
                      className={cn(
                        "h-8 rounded-md px-3 text-sm transition-[background-color,color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                        environmentType === "containerized"
                          ? "bg-primary font-bold text-primary-foreground shadow-sm"
                          : "font-normal text-muted-foreground hover:bg-elevated hover:text-foreground",
                        (isLoading || !dockerAvailable) && "cursor-not-allowed opacity-50",
                      )}
                    >
                      Containerized
                    </button>

                    <button
                      type="button"
                      onClick={() => setEnvironmentType("local")}
                      disabled={isLoading || !localEnvironmentAvailable}
                      aria-describedby={
                        !localEnvironmentAvailable ? "local-unavailable" : undefined
                      }
                      title={
                        !localEnvironmentAvailable
                          ? "Add a local project checkout to use worktree environments"
                          : undefined
                      }
                      className={cn(
                        "h-8 rounded-md px-3 text-sm transition-[background-color,color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                        environmentType === "local"
                          ? "bg-primary font-bold text-primary-foreground shadow-sm"
                          : "font-normal text-muted-foreground hover:bg-elevated hover:text-foreground",
                        (isLoading || !localEnvironmentAvailable) &&
                          "cursor-not-allowed opacity-50",
                      )}
                    >
                      Local
                    </button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {environmentType === "local"
                      ? "Git worktree on your machine"
                      : "Isolated Docker environment"}
                  </p>
                  {!dockerAvailable && (
                    <p id="containerized-unavailable" className="text-xs text-amber-400">
                      Unavailable while Docker is stopped
                    </p>
                  )}
                  {!localEnvironmentAvailable && (
                    <p id="local-unavailable" className="text-xs text-amber-400">
                      Unavailable without a local project checkout
                    </p>
                  )}
                </div>
              </div>

              {/* Environment Name */}
              <div className="border-b border-divider px-4 py-3 sm:grid sm:grid-cols-[7.5rem_minmax(0,1fr)] sm:items-center sm:gap-4 sm:px-6">
                <Label
                  htmlFor="environment-name"
                  className="mb-2 block text-sm font-medium text-muted-foreground sm:mb-0"
                >
                  Name <span className="sr-only">(optional)</span>
                </Label>
                <div className="grid min-w-0 items-center gap-2 sm:grid-cols-[minmax(0,1fr)_7rem] sm:gap-4">
                  <Input
                    id="environment-name"
                    aria-label="Environment Name (optional)"
                    placeholder="e.g., feature-dark-mode"
                    value={environmentName}
                    onChange={(e) => setEnvironmentName(e.target.value)}
                    disabled={isLoading}
                    className="h-9 rounded-lg border border-border/70 bg-input-surface px-3 py-1 shadow-none"
                  />
                  <p className="font-mono text-[11px] text-muted-foreground sm:px-1">= branch</p>
                </div>
              </div>
            </TabsContent>

            {/* Network Access Mode - only for containerized environments */}
            {environmentType === "containerized" && (
              <TabsContent
                value="access"
                forceMount
                data-mobile-transition={mobileTabTransitionDirection ?? undefined}
                className={cn(MOBILE_TAB_CONTENT_CLASSES, "sm:!contents")}
              >
                {/* Network Access Mode - only for containerized environments */}
                <div className="border-b border-divider px-4 py-3 sm:grid sm:grid-cols-[7.5rem_minmax(0,1fr)] sm:items-center sm:gap-4 sm:px-6">
                  <Label className="mb-2 block text-sm font-medium text-muted-foreground sm:mb-0">
                    Access
                  </Label>
                  <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
                    <div className="inline-grid grid-cols-2 rounded-lg border border-divider bg-input-surface p-0.5">
                      <button
                        type="button"
                        onClick={() => setNetworkAccessMode("restricted")}
                        disabled={isLoading}
                        className={cn(
                          "flex h-8 items-center justify-center gap-1.5 rounded-md px-3 text-sm transition-[background-color,color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                          networkAccessMode === "restricted"
                            ? "bg-primary font-bold text-primary-foreground shadow-sm"
                            : "font-normal text-muted-foreground hover:bg-elevated hover:text-foreground",
                          isLoading && "cursor-not-allowed opacity-50",
                        )}
                      >
                        <Shield className="h-3.5 w-3.5" />
                        Restricted
                      </button>

                      <button
                        type="button"
                        onClick={() => setNetworkAccessMode("full")}
                        disabled={isLoading}
                        className={cn(
                          "flex h-8 items-center justify-center gap-1.5 rounded-md px-3 text-sm transition-[background-color,color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                          networkAccessMode === "full"
                            ? "bg-primary font-bold text-primary-foreground shadow-sm"
                            : "font-normal text-muted-foreground hover:bg-elevated hover:text-foreground",
                          isLoading && "cursor-not-allowed opacity-50",
                        )}
                      >
                        <Globe className="h-3.5 w-3.5" />
                        Full access
                      </button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {networkAccessMode === "restricted"
                        ? "Only GitHub, npm, and agent APIs"
                        : "Unrestricted internet access"}
                    </p>
                  </div>
                </div>
              </TabsContent>
            )}

            <TabsContent
              value="agent"
              forceMount
              data-mobile-transition={mobileTabTransitionDirection ?? undefined}
              className={cn(MOBILE_TAB_CONTENT_CLASSES, "sm:!contents")}
            >
              {/* Compact agent launch configuration */}
              <div
                className={cn(
                  "border-b border-divider px-4 py-3 sm:grid sm:grid-cols-[7.5rem_minmax(0,1fr)] sm:items-center sm:gap-4 sm:px-6",
                  !launchAgent && buildIntent === "prompt" && "opacity-50",
                )}
              >
                <Label className="mb-2 text-sm font-medium text-muted-foreground sm:mb-0">
                  Agent
                </Label>
                <div className="grid min-w-0 items-center gap-2 sm:grid-cols-[minmax(0,1fr)_7rem] sm:gap-4">
                  <AgentModelPicker
                    id="agent-model"
                    ariaLabel="Agent, model and reasoning"
                    models={pickerModels}
                    enabledPlatforms={enabledAgentPlatforms}
                    selectedPlatform={agentType}
                    favorites={favoriteModels}
                    onPlatformChange={selectAgent}
                    onToggleFavorite={toggleFavoriteModel}
                    onReorderFavorites={reorderFavorites}
                    selectedModelId={model}
                    selectedModelLabel={selectedModel?.name ?? "Select model"}
                    onModelChange={selectModel}
                    onModelSelect={selectAgentModel}
                    reasoningOptions={reasoningOptions}
                    selectedReasoningId={reasoningEffort}
                    selectedReasoningLabel={
                      reasoningOptions.find((option) => option.id === reasoningEffort)?.label
                    }
                    onReasoningChange={selectReasoningEffort}
                    disabled={isLoading || (!launchAgent && buildIntent === "prompt")}
                    title="Choose agent, model, and reasoning"
                    className="h-9 w-full max-w-none justify-start rounded-lg border border-border/70 bg-input-surface px-3 text-sm shadow-none hover:bg-elevated md:max-w-none md:flex-1"
                  />
                  <div className="flex items-center gap-2 sm:px-1">
                    <Checkbox
                      id="launch-agent"
                      aria-label="Launch Agent"
                      checked={launchAgent}
                      onCheckedChange={(checked) => setLaunchAgent(checked === true)}
                      disabled={isLoading}
                    />
                    <Label
                      htmlFor="launch-agent"
                      className="cursor-pointer text-sm font-normal text-foreground"
                    >
                      Launch
                    </Label>
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
                className={cn(MOBILE_TAB_CONTENT_CLASSES, "sm:!contents")}
              >
                <div className="border-b border-divider px-4 py-3 sm:grid sm:grid-cols-[7.5rem_minmax(0,1fr)] sm:items-start sm:gap-4 sm:px-6">
                  <Label className="mb-2 block text-sm font-medium text-muted-foreground sm:mb-0 sm:pt-2.5">
                    Ports
                  </Label>
                  <Collapsible open={showPortConfig} onOpenChange={setShowPortConfig}>
                    <CollapsibleTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        className="h-9 w-full justify-between rounded-lg border border-border/70 bg-input-surface px-3 hover:bg-elevated"
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
                            showPortConfig && "rotate-180",
                          )}
                        />
                      </Button>
                    </CollapsibleTrigger>
                    <CollapsibleContent className="space-y-3 pt-3">
                      <p className="text-xs text-muted-foreground">
                        Expose container ports to the host machine. These are set at container
                        creation.
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
                </div>
              </TabsContent>
            )}

            <TabsContent
              value="prompt"
              forceMount
              data-mobile-transition={mobileTabTransitionDirection ?? undefined}
              className={cn(MOBILE_TAB_CONTENT_CLASSES, "sm:!block")}
            >
              <FeatureBuildFields
                intent={buildIntent}
                onIntentChange={handleBuildIntentChange}
                name={featureName}
                onNameChange={setFeatureName}
                description={featureDescription}
                onDescriptionChange={setFeatureDescription}
                acceptanceCriteria={featureAcceptanceCriteria}
                onAcceptanceCriteriaChange={setFeatureAcceptanceCriteria}
                advancedOpen={advancedOpen}
                onAdvancedOpenChange={setAdvancedOpen}
                customizeModels={customizeModels}
                onCustomizeModelsChange={handleCustomizeModelsChange}
                models={effectiveFeatureModels}
                onModelsChange={handleFeatureModelsChange}
                catalog={modelCatalog}
                enabledPlatforms={enabledAgentPlatforms}
                disabled={isLoading}
                featureAttachments={
                  <div className="space-y-1.5">
                    <Label className="text-sm">Reference images</Label>
                    <p className="text-xs text-muted-foreground">
                      Paste or drop images to include them in the feature build.
                    </p>
                    {isDraggingAttachments && (
                      <p className="rounded-md border border-dashed border-primary/70 bg-primary/10 px-3 py-2 text-center text-sm text-primary">
                        Drop images to attach them to the feature
                      </p>
                    )}
                    <AttachmentPreviews
                      attachments={initialPromptAttachments.filter(
                        (attachment) => attachment.type !== "file",
                      )}
                      disabled={isLoading}
                      onRemove={removeInitialPromptAttachment}
                    />
                  </div>
                }
                promptFields={
                  launchAgent ? (
                    <div
                      data-slot="initial-prompt-field"
                      className="sm:grid sm:grid-cols-[7.5rem_minmax(0,1fr)] sm:items-start sm:gap-4"
                    >
                      <Label
                        htmlFor="initial-prompt"
                        className="mb-2 block text-sm font-medium text-muted-foreground sm:mb-0 sm:pt-2"
                      >
                        Initial Prompt <span className="sr-only">(optional)</span>
                      </Label>
                      <div className="space-y-2">
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
                          className="min-h-36 max-h-[calc(15*theme(lineHeight.normal)*1em)] resize-y overflow-y-auto rounded-xl border border-border/70 bg-input-surface px-3 py-2 shadow-none"
                        />
                        {isDraggingAttachments && (
                          <p className="rounded-md border border-dashed border-primary/70 bg-primary/10 px-3 py-2 text-center text-sm text-primary">
                            Drop files to attach them to the initial prompt
                          </p>
                        )}
                        <AttachmentPreviews
                          attachments={initialPromptAttachments}
                          disabled={isLoading}
                          onRemove={removeInitialPromptAttachment}
                        />
                      </div>
                    </div>
                  ) : null
                }
              />
            </TabsContent>
          </Tabs>
        </form>

        <DialogFooter className="m-0 grid shrink-0 grid-cols-2 border-t border-divider px-4 py-2.5 sm:m-0 sm:flex sm:flex-row sm:px-6">
          <Button
            type="button"
            variant="ghost"
            onClick={() => handleOpenChange(false)}
            disabled={isLoading}
            className="h-9 px-4"
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => formRef.current?.requestSubmit()}
            disabled={
              isLoading ||
              pendingAttachmentOperations > 0 ||
              (environmentType === "containerized" &&
                (!dockerAvailable || !validatePortMappings())) ||
              (environmentType === "local" && !localEnvironmentAvailable) ||
              // A feature build opens a ticket, so it needs something to call
              // it. Everything else about the feature form is optional.
              (buildIntent === "feature" && (!onCreateFeatureBuild || !featureName.trim()))
            }
            className="h-9 px-5 font-bold shadow-[0_8px_24px_rgba(59,130,246,0.22)]"
          >
            {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Create Environment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
