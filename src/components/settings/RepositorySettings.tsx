import { useState, useEffect, useCallback, useMemo } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { useConfigStore } from "@/stores";
import { useClaudeStore } from "@/stores/claudeStore";
import { useOpenCodeStore } from "@/stores/openCodeStore";
import { useCodexStore } from "@/stores/codexStore";
import * as tauri from "@/lib/tauri";
import type { ClaudeModel, ClaudeEffortLevel } from "@/lib/claude-client";
import type { OpenCodeModel } from "@/lib/opencode-client";
import type { CodexReasoningEffort } from "@/lib/codex-client";
import { CODEX_MODELS } from "@/lib/codex-client";
import { Loader2, Network, Plus, Trash2, ChevronDown, FolderOpen, ExternalLink, FileText, Bot } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { cn } from "@/lib/utils";
import type { Project, RepositoryConfig, PortMapping, PortProtocol } from "@/types";

interface RepositorySettingsProps {
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdateProject?: (project: Project) => Promise<Project | void>;
}

const DEFAULT_CONFIG: RepositoryConfig = {
  defaultBranch: "main",
  prBaseBranch: "main",
};

/** Fallback Claude models when no bridge server is running */
const FALLBACK_CLAUDE_MODELS: ClaudeModel[] = [
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high"] },
  { id: "claude-opus-4-6", name: "Claude Opus 4.6", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high"] },
  { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high"] },
];

const CLAUDE_EFFORT_LEVELS: { value: ClaudeEffortLevel; label: string }[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "max", label: "Max" },
];

const CODEX_EFFORT_LEVELS: { value: CodexReasoningEffort; label: string }[] = [
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra High" },
];

/** OpenCode uses model variants for effort/thinking levels */
const OPENCODE_DEFAULT_VARIANTS = ["low", "high", "xhigh"];

export function RepositorySettings({
  project,
  open,
  onOpenChange,
  onUpdateProject,
}: RepositorySettingsProps) {
  const { getRepositoryConfig, setRepositoryConfig, setConfig, config } = useConfigStore();
  const defaultAgent = config.global.defaultAgent || "claude";

  // Pull cached models from stores
  const claudeModels = useClaudeStore((s) => s.models);
  const openCodeModelsMap = useOpenCodeStore((s) => s.models);
  const codexModels = useCodexStore((s) => s.models);

  const existingConfig = getRepositoryConfig(project.id);
  const initialConfig = existingConfig ?? DEFAULT_CONFIG;

  // Project fields
  const [projectName, setProjectName] = useState(project.name);
  const [localPath, setLocalPath] = useState(project.localPath || "");
  const [projectNameError, setProjectNameError] = useState<string | null>(null);

  // Repository config fields
  const [defaultBranch, setDefaultBranch] = useState(initialConfig.defaultBranch);
  const [prBaseBranch, setPrBaseBranch] = useState(initialConfig.prBaseBranch);
  const [portMappings, setPortMappings] = useState<PortMapping[]>(
    initialConfig.defaultPortMappings ?? []
  );
  const [showPortConfig, setShowPortConfig] = useState(false);
  const [filesToCopy, setFilesToCopy] = useState<string[]>(
    initialConfig.filesToCopy ?? []
  );
  const [showFilesConfig, setShowFilesConfig] = useState(false);
  const [defaultModel, setDefaultModel] = useState(initialConfig.defaultModel ?? "");
  const [defaultEffort, setDefaultEffort] = useState(initialConfig.defaultEffort ?? "");
  const [isSaving, setIsSaving] = useState(false);

  // Reset form when project changes or dialog opens
  useEffect(() => {
    if (open) {
      // Reset project fields
      setProjectName(project.name);
      setLocalPath(project.localPath || "");
      setProjectNameError(null);

      // Reset repo config fields
      const config = getRepositoryConfig(project.id) ?? DEFAULT_CONFIG;
      setDefaultBranch(config.defaultBranch);
      setPrBaseBranch(config.prBaseBranch);
      setPortMappings(config.defaultPortMappings ?? []);
      setShowPortConfig((config.defaultPortMappings ?? []).length > 0);
      setFilesToCopy(config.filesToCopy ?? []);
      setShowFilesConfig((config.filesToCopy ?? []).length > 0);
      setDefaultModel(config.defaultModel ?? "");
      setDefaultEffort(config.defaultEffort ?? "");
    }
  }, [open, project.id, project.name, project.localPath, getRepositoryConfig]);

  // Validate project name
  const validateProjectName = (value: string): boolean => {
    const trimmed = value.trim();
    if (!trimmed) {
      setProjectNameError("Name cannot be empty");
      return false;
    }
    if (trimmed.length > 100) {
      setProjectNameError("Name cannot exceed 100 characters");
      return false;
    }
    setProjectNameError(null);
    return true;
  };

  // Handle project name change
  const handleProjectNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setProjectName(value);
    validateProjectName(value);
  };

  // Browse for local directory
  const handleBrowse = async () => {
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: "Select Repository Directory",
        defaultPath: localPath || undefined,
      });

      if (selected && typeof selected === "string") {
        setLocalPath(selected);
      }
    } catch (err) {
      console.error("Failed to open directory picker:", err);
    }
  };

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

  // File to copy management
  const addFileToCopy = useCallback(() => {
    setFilesToCopy((prev) => [...prev, ""]);
  }, []);

  const removeFileToCopy = useCallback((index: number) => {
    setFilesToCopy((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const updateFileToCopy = useCallback((index: number, value: string) => {
    setFilesToCopy((prev) => prev.map((f, i) => (i === index ? value : f)));
  }, []);

  // Browse for file to copy (relative to project local path)
  const handleBrowseFile = async (index: number) => {
    if (!localPath) {
      toast.error("Set a local path first", {
        description: "You need to set the local path before browsing for files.",
      });
      return;
    }

    try {
      const selected = await openDialog({
        directory: false,
        multiple: false,
        title: "Select File to Copy",
        defaultPath: localPath,
      });

      if (selected && typeof selected === "string") {
        // Convert absolute path to relative path
        if (selected.startsWith(localPath)) {
          let relativePath = selected.slice(localPath.length);
          // Remove leading slash if present
          if (relativePath.startsWith("/")) {
            relativePath = relativePath.slice(1);
          }
          updateFileToCopy(index, relativePath);
        } else {
          toast.error("Invalid file location", {
            description: "The file must be inside the project's local path.",
          });
        }
      }
    } catch (err) {
      console.error("Failed to open file picker:", err);
    }
  };

  // Validate files to copy - returns { valid: boolean, error?: string }
  const validateFilesToCopy = useCallback((): { valid: boolean; error?: string } => {
    for (const file of filesToCopy) {
      const trimmed = file.trim();
      if (trimmed === "") continue; // Empty entries are removed on save
      if (trimmed.startsWith("/")) {
        return { valid: false, error: "Paths must be relative (cannot start with /)" };
      }
      if (trimmed.includes("..")) {
        return { valid: false, error: "Paths cannot contain .." };
      }
    }
    // Check for duplicates (excluding empty entries)
    // Use case-insensitive comparison for macOS filesystem compatibility
    const nonEmpty = filesToCopy.filter((f) => f.trim() !== "");
    const normalized = nonEmpty.map((f) => f.toLowerCase());
    const hasDuplicates = new Set(normalized).size !== normalized.length;
    if (hasDuplicates) {
      return { valid: false, error: "Duplicate file paths are not allowed" };
    }
    return { valid: true };
  }, [filesToCopy]);

  // Validate port mappings - returns { valid: boolean, error?: string }
  const validatePortMappings = useCallback((): { valid: boolean; error?: string } => {
    for (const mapping of portMappings) {
      if (mapping.containerPort < 1 || mapping.containerPort > 65535) {
        return { valid: false, error: "Port numbers must be between 1 and 65535" };
      }
      if (mapping.hostPort < 1 || mapping.hostPort > 65535) {
        return { valid: false, error: "Port numbers must be between 1 and 65535" };
      }
    }
    // Check for duplicate host ports
    const hostPorts = portMappings.map((m) => m.hostPort);
    const hasDuplicates = new Set(hostPorts).size !== hostPorts.length;
    if (hasDuplicates) {
      return { valid: false, error: "Each host port can only be used once" };
    }
    return { valid: true };
  }, [portMappings]);

  const handleSave = async () => {
    // Validate project name
    if (!validateProjectName(projectName)) {
      return;
    }

    // Validate port mappings
    const portValidation = validatePortMappings();
    if (!portValidation.valid) {
      toast.error("Invalid port mappings", {
        description: portValidation.error,
      });
      return;
    }

    // Validate files to copy
    const filesValidation = validateFilesToCopy();
    if (!filesValidation.valid) {
      toast.error("Invalid files to copy", {
        description: filesValidation.error,
      });
      return;
    }

    setIsSaving(true);
    try {
      // Update project if name or localPath changed
      const trimmedName = projectName.trim();
      const trimmedPath = localPath.trim() || null;
      const projectChanged = trimmedName !== project.name || trimmedPath !== project.localPath;

      if (projectChanged && onUpdateProject) {
        await onUpdateProject({
          ...project,
          name: trimmedName,
          localPath: trimmedPath,
        });
      }

      // Update repository config - filter out empty file paths
      const cleanedFilesToCopy = filesToCopy.filter((f) => f.trim() !== "");
      const repoConfig: RepositoryConfig = {
        defaultBranch,
        prBaseBranch,
        defaultPortMappings: portMappings.length > 0 ? portMappings : undefined,
        filesToCopy: cleanedFilesToCopy.length > 0 ? cleanedFilesToCopy : undefined,
        defaultModel: defaultModel || undefined,
        defaultEffort: defaultEffort || undefined,
      };

      // Update backend
      const newConfig = await tauri.updateRepositoryConfig(project.id, repoConfig);
      setConfig(newConfig);

      // Also update local store
      setRepositoryConfig(project.id, repoConfig);

      toast.success("Settings saved");
      onOpenChange(false);
    } catch (err) {
      console.error("Failed to save settings:", err);
      const message = err instanceof Error ? err.message : "Failed to save settings";
      toast.error("Failed to save settings", { description: message });
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancel = () => {
    // Reset project fields
    setProjectName(project.name);
    setLocalPath(project.localPath || "");
    setProjectNameError(null);

    // Reset repo config fields
    const config = getRepositoryConfig(project.id) ?? DEFAULT_CONFIG;
    setDefaultBranch(config.defaultBranch);
    setPrBaseBranch(config.prBaseBranch);
    setPortMappings(config.defaultPortMappings ?? []);
    setFilesToCopy(config.filesToCopy ?? []);
    setDefaultModel(config.defaultModel ?? "");
    setDefaultEffort(config.defaultEffort ?? "");
    onOpenChange(false);
  };

  // Memoize validation results to avoid recalculating on every render
  const portValidationResult = useMemo(() => validatePortMappings(), [validatePortMappings]);
  const filesValidationResult = useMemo(() => validateFilesToCopy(), [validateFilesToCopy]);

  // Memoize non-empty file count for UI display
  const nonEmptyFilesCount = useMemo(
    () => filesToCopy.filter((f) => f.trim() !== "").length,
    [filesToCopy]
  );

  // Compute available models and effort levels based on the global default agent
  const availableModels = useMemo((): { id: string; name: string }[] => {
    switch (defaultAgent) {
      case "claude": {
        const models = claudeModels.length > 0 ? claudeModels : FALLBACK_CLAUDE_MODELS;
        return models.map((m) => ({ id: m.id, name: m.name }));
      }
      case "opencode": {
        // Flatten all cached opencode models from any environment
        const allModels: OpenCodeModel[] = [];
        const seenIds = new Set<string>();
        for (const models of openCodeModelsMap.values()) {
          for (const m of models) {
            if (!seenIds.has(m.id)) {
              seenIds.add(m.id);
              allModels.push(m);
            }
          }
        }
        return allModels.map((m) => ({ id: m.id, name: m.name }));
      }
      case "codex": {
        const models = codexModels.length > 0 ? codexModels : CODEX_MODELS;
        return models.map((m) => ({ id: m.id, name: m.name }));
      }
      default:
        return [];
    }
  }, [defaultAgent, claudeModels, openCodeModelsMap, codexModels]);

  const availableEffortLevels = useMemo((): { value: string; label: string }[] => {
    switch (defaultAgent) {
      case "claude": {
        // If we have a selected model with specific effort levels, use those
        const allModels = claudeModels.length > 0 ? claudeModels : FALLBACK_CLAUDE_MODELS;
        const selectedClaudeModel = allModels.find((m) => m.id === defaultModel);
        if (selectedClaudeModel?.supportedEffortLevels) {
          return CLAUDE_EFFORT_LEVELS.filter((e) =>
            selectedClaudeModel.supportedEffortLevels!.includes(e.value)
          );
        }
        return CLAUDE_EFFORT_LEVELS;
      }
      case "opencode": {
        // Find the selected model and use its variants
        for (const models of openCodeModelsMap.values()) {
          const model = models.find((m) => m.id === defaultModel);
          if (model?.variants && model.variants.length > 0) {
            return model.variants.map((v) => ({ value: v, label: v.charAt(0).toUpperCase() + v.slice(1) }));
          }
        }
        return OPENCODE_DEFAULT_VARIANTS.map((v) => ({ value: v, label: v.charAt(0).toUpperCase() + v.slice(1) }));
      }
      case "codex":
        return CODEX_EFFORT_LEVELS;
      default:
        return [];
    }
  }, [defaultAgent, defaultModel, claudeModels, openCodeModelsMap]);

  const agentLabel = defaultAgent === "claude" ? "Claude" : defaultAgent === "opencode" ? "OpenCode" : "Codex";

  const hasErrors = projectNameError !== null || !portValidationResult.valid || !filesValidationResult.valid;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px] max-h-[85vh] flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle>Repository Settings</DialogTitle>
          <DialogDescription>
            Configure settings for this repository
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4 overflow-y-auto flex-1 pr-2">
          {/* Project Settings Section */}
          <div className="grid gap-2">
            <Label htmlFor="projectName">Name</Label>
            <Input
              id="projectName"
              value={projectName}
              onChange={handleProjectNameChange}
              placeholder="Project name"
              disabled={isSaving}
            />
            {projectNameError && (
              <p className="text-sm text-destructive">{projectNameError}</p>
            )}
          </div>

          <div className="grid gap-2">
            <Label>Git URL</Label>
            <div className="flex items-center gap-2">
              <Input
                value={project.gitUrl}
                readOnly
                className="bg-muted cursor-default flex-1"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => window.open(project.gitUrl, "_blank")}
                title="Open in browser"
              >
                <ExternalLink className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              The Git URL cannot be changed after adding the project.
            </p>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="localPath">Local Path</Label>
            <div className="flex gap-2">
              <Input
                id="localPath"
                value={localPath}
                onChange={(e) => setLocalPath(e.target.value)}
                placeholder="/path/to/repository"
                className="flex-1"
                disabled={isSaving}
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={handleBrowse}
                disabled={isSaving}
              >
                <FolderOpen className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              If you have a local clone, select it to copy .env files to environments.
            </p>
          </div>

          {/* Separator */}
          <div className="border-t border-border my-2" />

          {/* Repository Config Section */}
          <div className="grid gap-2">
            <Label htmlFor="defaultBranch">Default Branch</Label>
            <Input
              id="defaultBranch"
              value={defaultBranch}
              onChange={(e) => setDefaultBranch(e.target.value)}
              placeholder="main"
            />
            <p className="text-xs text-muted-foreground">
              The branch to clone when creating new environments
            </p>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="prBaseBranch">PR Base Branch</Label>
            <Input
              id="prBaseBranch"
              value={prBaseBranch}
              onChange={(e) => setPrBaseBranch(e.target.value)}
              placeholder="main"
            />
            <p className="text-xs text-muted-foreground">
              The target branch for pull requests
            </p>
          </div>

          {/* Default Agent Model & Effort */}
          <div className="border-t border-border my-2" />

          <div className="grid gap-2">
            <div className="flex items-center gap-2">
              <Bot className="h-4 w-4 text-muted-foreground" />
              <Label className="text-sm font-medium">Default Agent Settings</Label>
              <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                {agentLabel}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              Default model and effort level for new sessions. Agent type is configured in global settings.
            </p>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="defaultModel">Default Model</Label>
            {availableModels.length > 0 ? (
              <Select
                value={defaultModel}
                onValueChange={setDefaultModel}
                disabled={isSaving}
              >
                <SelectTrigger id="defaultModel">
                  <SelectValue placeholder="Use agent default" />
                </SelectTrigger>
                <SelectContent>
                  {availableModels.map((model) => (
                    <SelectItem key={model.id} value={model.id}>
                      {model.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <p className="text-xs text-muted-foreground italic">
                Start an environment to load available models
              </p>
            )}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="defaultEffort">Default Effort Level</Label>
            {availableEffortLevels.length > 0 ? (
              <Select
                value={defaultEffort}
                onValueChange={setDefaultEffort}
                disabled={isSaving}
              >
                <SelectTrigger id="defaultEffort">
                  <SelectValue placeholder="Use agent default" />
                </SelectTrigger>
                <SelectContent>
                  {availableEffortLevels.map((level) => (
                    <SelectItem key={level.value} value={level.value}>
                      {level.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <p className="text-xs text-muted-foreground italic">
                No effort levels available for this agent
              </p>
            )}
          </div>

          {/* Default Port Configuration */}
          <Collapsible open={showPortConfig} onOpenChange={setShowPortConfig}>
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                className="w-full justify-between p-3 h-auto rounded-lg border border-input bg-muted/30 hover:bg-muted/50"
                disabled={isSaving}
              >
                <div className="flex items-center gap-2">
                  <Network className="h-4 w-4" />
                  <span className="text-sm font-medium">Default Port Mappings</span>
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
                These port mappings will be pre-filled when creating new environments for this repository.
              </p>
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
                      disabled={isSaving}
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
                      disabled={isSaving}
                    />
                    <Select
                      value={mapping.protocol}
                      onValueChange={(value: PortProtocol) =>
                        updatePortMapping(index, { protocol: value })
                      }
                      disabled={isSaving}
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
                      disabled={isSaving}
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
                disabled={isSaving}
                className="w-full"
              >
                <Plus className="h-4 w-4 mr-2" />
                Add Port Mapping
              </Button>
            </CollapsibleContent>
          </Collapsible>

          {/* Files to Copy Configuration */}
          <Collapsible open={showFilesConfig} onOpenChange={setShowFilesConfig}>
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                className="w-full justify-between p-3 h-auto rounded-lg border border-input bg-muted/30 hover:bg-muted/50"
                disabled={isSaving}
              >
                <div className="flex items-center gap-2">
                  <FileText className="h-4 w-4" />
                  <span className="text-sm font-medium">Files to Copy</span>
                  {nonEmptyFilesCount > 0 && (
                    <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                      {nonEmptyFilesCount} file{nonEmptyFilesCount !== 1 ? "s" : ""}
                    </span>
                  )}
                </div>
                <ChevronDown
                  className={cn(
                    "h-4 w-4 transition-transform duration-200",
                    showFilesConfig && "rotate-180"
                  )}
                />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-3 space-y-3">
              <p className="text-xs text-muted-foreground">
                Specify files from your local repository to copy into environments. Use relative paths from the project root.
              </p>
              {filesToCopy.map((filePath, index) => (
                <div key={index} className="flex items-center gap-2">
                  <Input
                    value={filePath}
                    onChange={(e) => updateFileToCopy(index, e.target.value)}
                    placeholder="config/settings.json"
                    className="flex-1 text-sm"
                    disabled={isSaving}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={() => handleBrowseFile(index)}
                    disabled={isSaving || !localPath}
                    title={localPath ? "Browse for file" : "Set local path first"}
                    className="h-8 w-8"
                  >
                    <FolderOpen className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => removeFileToCopy(index)}
                    disabled={isSaving}
                    className="h-8 w-8"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addFileToCopy}
                disabled={isSaving}
                className="w-full"
              >
                <Plus className="h-4 w-4 mr-2" />
                Add File
              </Button>
            </CollapsibleContent>
          </Collapsible>
        </div>

        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={handleCancel}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isSaving || hasErrors}>
            {isSaving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving...
              </>
            ) : (
              "Save"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
