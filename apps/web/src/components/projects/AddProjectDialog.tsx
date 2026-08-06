import { useCallback, useRef, useState } from "react";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  FolderGit2,
  FolderOpen,
  Github,
  GitBranch,
  Loader2,
  LockKeyhole,
  Plus,
} from "lucide-react";
import { open as openDialog } from "@/lib/native/dialog";
import { getGitRemoteUrl } from "@/lib/backend";
import { cn } from "@/lib/utils";

type ProjectSource = "existing" | "scratch";

interface AddProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (gitUrl: string, localPath?: string) => Promise<void>;
  onCreate: (localPath: string) => Promise<void>;
  validateGitUrl: (url: string) => Promise<boolean>;
}

export function AddProjectDialog({
  open: isOpen,
  onOpenChange,
  onAdd,
  onCreate,
  validateGitUrl,
}: AddProjectDialogProps) {
  const [source, setSource] = useState<ProjectSource>("existing");
  const [gitUrl, setGitUrl] = useState("");
  const [localPath, setLocalPath] = useState("");
  const [newProjectPath, setNewProjectPath] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isValidUrl, setIsValidUrl] = useState<boolean | null>(null);
  const validationRequestRef = useRef(0);

  const resetForm = useCallback(() => {
    validationRequestRef.current += 1;
    setSource("existing");
    setGitUrl("");
    setLocalPath("");
    setNewProjectPath("");
    setError(null);
    setIsValidUrl(null);
  }, []);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) resetForm();
      onOpenChange(open);
    },
    [onOpenChange, resetForm],
  );

  const handleSourceChange = useCallback((value: string) => {
    setSource(value as ProjectSource);
    setError(null);
  }, []);

  const setAndValidateGitUrl = useCallback(
    async (value: string) => {
      const validationRequest = ++validationRequestRef.current;
      setGitUrl(value);
      setError(null);

      if (!value.trim()) {
        setIsValidUrl(null);
        return;
      }

      try {
        const valid = await validateGitUrl(value);
        if (validationRequest === validationRequestRef.current) setIsValidUrl(valid);
      } catch (validationError) {
        if (validationRequest === validationRequestRef.current) {
          setIsValidUrl(false);
          setError(
            validationError instanceof Error
              ? validationError.message
              : "Failed to validate Git URL",
          );
        }
      }
    },
    [validateGitUrl],
  );

  const handleExistingBrowse = useCallback(async () => {
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: "Select repository directory",
        defaultPath: localPath.trim() || undefined,
      });
      const repositoryPath = typeof selected === "string"
        ? selected
        : window.orkestratorGateway?.enabled
          ? localPath.trim()
          : "";
      if (!repositoryPath) return;

      setLocalPath(repositoryPath);
      try {
        const remoteUrl = await getGitRemoteUrl(repositoryPath);
        if (remoteUrl) await setAndValidateGitUrl(remoteUrl);
      } catch (remoteError) {
        console.debug("Could not get git remote URL:", remoteError);
      }
    } catch (browseError) {
      console.error("Failed to open directory picker:", browseError);
    }
  }, [localPath, setAndValidateGitUrl]);

  const handleNewProjectBrowse = useCallback(async () => {
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: "Choose an empty project folder",
        defaultPath: newProjectPath.trim() || undefined,
      });
      const projectPath = typeof selected === "string"
        ? selected
        : window.orkestratorGateway?.enabled
          ? newProjectPath.trim()
          : "";
      if (projectPath) {
        setNewProjectPath(projectPath);
        setError(null);
      }
    } catch (browseError) {
      console.error("Failed to open directory picker:", browseError);
    }
  }, [newProjectPath]);

  const handleSubmit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();

      if (source === "existing") {
        if (!gitUrl.trim()) {
          setError("Git URL is required");
          return;
        }
        if (isValidUrl === false) {
          setError("Invalid Git URL format");
          return;
        }
      } else if (!newProjectPath.trim()) {
        setError("Project path is required");
        return;
      }

      setIsLoading(true);
      setError(null);
      try {
        if (source === "scratch") {
          await onCreate(newProjectPath.trim());
        } else {
          await onAdd(gitUrl.trim(), localPath.trim() || undefined);
        }
        handleOpenChange(false);
      } catch (submitError) {
        setError(
          submitError instanceof Error
            ? submitError.message
            : source === "scratch"
              ? "Failed to create project"
              : "Failed to add project",
        );
      } finally {
        setIsLoading(false);
      }
    },
    [
      gitUrl,
      handleOpenChange,
      isValidUrl,
      localPath,
      newProjectPath,
      onAdd,
      onCreate,
      source,
    ],
  );

  const canSubmit = source === "scratch" ? newProjectPath.trim() : gitUrl.trim();

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add project</DialogTitle>
          <DialogDescription>
            Bring in a repository you already have, or start a private GitHub project from an
            empty folder.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-5">
          <Tabs value={source} onValueChange={handleSourceChange}>
            <TabsList className="grid h-auto w-full grid-cols-2">
              <TabsTrigger value="existing" className="gap-2 py-2">
                <FolderGit2 className="h-4 w-4" />
                Existing repository
              </TabsTrigger>
              <TabsTrigger value="scratch" className="gap-2 py-2">
                <Plus className="h-4 w-4" />
                Create new
              </TabsTrigger>
            </TabsList>

            <TabsContent value="existing" className="mt-3 space-y-4">
              <div className="space-y-2">
                <label htmlFor="gitUrl" className="text-sm font-medium">
                  Git URL <span className="text-destructive">*</span>
                </label>
                <Input
                  id="gitUrl"
                  type="text"
                  placeholder="git@github.com:user/repo.git or https://..."
                  value={gitUrl}
                  onChange={(event) => void setAndValidateGitUrl(event.target.value)}
                  className={cn(
                    isValidUrl === false && "border-destructive",
                    isValidUrl === true && "border-green-500",
                  )}
                  disabled={isLoading}
                />
                {isValidUrl === false && (
                  <p className="text-xs text-destructive">
                    Enter a valid Git URL (SSH or HTTPS format)
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <label htmlFor="localPath" className="text-sm font-medium">
                  Local path <span className="text-muted-foreground">(optional)</span>
                </label>
                <div className="flex gap-2">
                  <Input
                    id="localPath"
                    type="text"
                    placeholder="/path/to/repository"
                    value={localPath}
                    onChange={(event) => setLocalPath(event.target.value)}
                    disabled={isLoading}
                    className="flex-1"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={handleExistingBrowse}
                    disabled={isLoading}
                    aria-label="Select or detect repository directory"
                  >
                    <FolderOpen className="h-4 w-4" />
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Select a local clone to copy its environment files into new environments.
                </p>
              </div>
            </TabsContent>

            <TabsContent value="scratch" className="mt-3 space-y-4">
              <div className="space-y-2">
                <label htmlFor="newProjectPath" className="text-sm font-medium">
                  Project path <span className="text-destructive">*</span>
                </label>
                <div className="flex gap-2">
                  <Input
                    id="newProjectPath"
                    type="text"
                    placeholder="/path/to/my-new-project"
                    value={newProjectPath}
                    onChange={(event) => {
                      setNewProjectPath(event.target.value);
                      setError(null);
                    }}
                    disabled={isLoading}
                    className="flex-1 font-mono text-sm"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={handleNewProjectBrowse}
                    disabled={isLoading}
                    aria-label="Choose an empty project folder"
                  >
                    <FolderOpen className="h-4 w-4" />
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Use a new path or an empty folder. The folder name becomes the GitHub repository
                  name.
                </p>
              </div>

              <ol
                aria-label="Project creation steps"
                className="grid grid-cols-3 overflow-hidden rounded-lg border bg-muted/30 text-xs"
              >
                <li className="flex items-center gap-2 border-r px-3 py-3">
                  <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
                  Create folder
                </li>
                <li className="flex items-center gap-2 border-r px-3 py-3">
                  <GitBranch className="h-4 w-4 shrink-0 text-muted-foreground" />
                  Initialize Git
                </li>
                <li className="flex items-center gap-2 px-3 py-3">
                  <span className="relative shrink-0">
                    <Github className="h-4 w-4 text-muted-foreground" />
                    <LockKeyhole className="absolute -bottom-1 -right-1 h-2.5 w-2.5 fill-background" />
                  </span>
                  Private origin
                </li>
              </ol>
              <p className="text-xs text-muted-foreground">
                GitHub CLI must be installed and signed in on this computer.
              </p>
            </TabsContent>
          </Tabs>

          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={isLoading}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isLoading || !canSubmit}>
              {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {source === "scratch" ? "Create project" : "Add project"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
