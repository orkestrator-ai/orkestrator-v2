import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  Archive,
  ArrowLeft,
  Building2,
  ChevronRight,
  FolderOpen,
  GitFork,
  Loader2,
  LockKeyhole,
  RefreshCw,
  Search,
  User,
} from "lucide-react";
import {
  compareGitHubNames,
  sortGitHubRepositories,
  type GitHubCloneAccount,
  type GitHubCloneRepository,
  type GitHubCloneRepositoryList,
  type GitHubRepositorySortOrder,
} from "@orkestrator/protocol/github-clone";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SegmentedSelector } from "@/components/ui/segmented-selector";
import { formatCompactRelativeTime } from "@/lib/format-relative-time";
import { pickHostPath } from "@/lib/host-path-picker";
import { joinHostPath, normalizeGitHubRemote, parentDirectory } from "@/lib/github-clone";
import { cn } from "@/lib/utils";

type LoadState<T> =
  | { status: "loading" }
  | { status: "ready"; value: T; loadingMore?: boolean; pageError?: string }
  | { status: "error"; message: string };

type PickerStep =
  | { kind: "account" }
  | { kind: "repository"; account: GitHubCloneAccount }
  | { kind: "path"; account: GitHubCloneAccount; repository: GitHubCloneRepository };

const SORT_OPTIONS = [
  { value: "recent", label: "Recent" },
  { value: "alphabetical", label: "A–Z" },
] as const;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

interface SearchableListProps<T> {
  items: readonly T[];
  query: string;
  onQueryChange: (query: string) => void;
  searchLabel: string;
  placeholder: string;
  emptyLabel: string;
  itemKey: (item: T) => string;
  isDisabled?: (item: T) => boolean;
  onSelect: (item: T) => void;
  renderItem: (item: T) => React.ReactNode;
}

function SearchableList<T>({
  items,
  query,
  onQueryChange,
  searchLabel,
  placeholder,
  emptyLabel,
  itemKey,
  isDisabled,
  onSelect,
  renderItem,
}: SearchableListProps<T>) {
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    // The picker lives inside the add-project form; Enter must not submit it.
    event.preventDefault();
    const first = items.find((item) => !isDisabled?.(item));
    if (first) onSelect(first);
  };

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          aria-label={searchLabel}
          placeholder={placeholder}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={handleKeyDown}
          className="pl-9"
          autoFocus
        />
      </div>
      <ul
        aria-label={searchLabel.replace(/^Search /, "")}
        className="max-h-80 overflow-y-auto rounded-lg border divide-y divide-border"
      >
        {items.length === 0 ? (
          <li className="px-3 py-6 text-center text-sm text-muted-foreground">{emptyLabel}</li>
        ) : (
          items.map((item) => (
            <li key={itemKey(item)}>
              <button
                type="button"
                onClick={() => onSelect(item)}
                disabled={isDisabled?.(item)}
                className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
              >
                {renderItem(item)}
              </button>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

function LoadingRow({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center gap-2 rounded-lg border px-3 py-10 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
      {label}
    </div>
  );
}

function ErrorRow({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="space-y-3 rounded-lg border border-destructive/40 px-3 py-4 text-sm">
      <p className="text-destructive" role="alert">
        {message}
      </p>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        <RefreshCw className="mr-2 h-3.5 w-3.5" />
        Retry
      </Button>
    </div>
  );
}

export interface GitHubRepositoryPickerProps {
  loadAccounts: () => Promise<GitHubCloneAccount[]>;
  loadRepositories: (owner: string, cursor?: string) => Promise<GitHubCloneRepositoryList>;
  /** Clones the repository into the path and adds it as a project. */
  onClone: (cloneUrl: string, localPath: string) => Promise<void>;
  /** Leaves the picker for the manual Git URL form. */
  onCancel: () => void;
  /** Folder a new clone is placed in by default. */
  defaultCloneDirectory?: string;
  /** Remotes of existing projects; matching repositories cannot be picked again. */
  existingGitUrls?: readonly string[];
}

export function GitHubRepositoryPicker({
  loadAccounts,
  loadRepositories,
  onClone,
  onCancel,
  defaultCloneDirectory,
  existingGitUrls = [],
}: GitHubRepositoryPickerProps) {
  const [step, setStep] = useState<PickerStep>({ kind: "account" });
  const [accounts, setAccounts] = useState<LoadState<GitHubCloneAccount[]>>({
    status: "loading",
  });
  const [repositories, setRepositories] = useState<
    Map<string, LoadState<GitHubCloneRepositoryList>>
  >(() => new Map());
  const [accountQuery, setAccountQuery] = useState("");
  const [repositoryQuery, setRepositoryQuery] = useState("");
  const [sortOrder, setSortOrder] = useState<GitHubRepositorySortOrder>("recent");
  const [localPath, setLocalPath] = useState("");
  const [isCloning, setIsCloning] = useState(false);
  const [cloneError, setCloneError] = useState<string | null>(null);
  const [accountsAttempt, setAccountsAttempt] = useState(0);
  const [repositoriesAttempt, setRepositoriesAttempt] = useState(0);
  const cloningRef = useRef(false);
  const loadLatestAccounts = useEffectEvent(() => loadAccounts());
  const loadLatestRepositories = useEffectEvent((owner: string, cursor?: string) =>
    loadRepositories(owner, cursor),
  );

  // Starts "loading": the initial state, and what a retry sets.
  useEffect(() => {
    let cancelled = false;
    loadLatestAccounts().then(
      (value) => {
        if (!cancelled) setAccounts({ status: "ready", value });
      },
      (error: unknown) => {
        if (!cancelled) {
          setAccounts({
            status: "error",
            message: errorMessage(error, "Could not list your GitHub organizations"),
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [accountsAttempt]);

  const activeOwner = step.kind === "repository" ? step.account.login : null;
  const activeRepositories = activeOwner ? repositories.get(activeOwner) : undefined;
  const cachedRepositories = useEffectEvent((owner: string) => repositories.get(owner));

  useEffect(() => {
    if (!activeOwner) return;
    // Settled listings are cached per owner for the life of the picker.
    const cached = cachedRepositories(activeOwner);
    if (cached && cached.status !== "loading" && !(cached.status === "ready" && cached.loadingMore))
      return;
    const previous = cached?.status === "ready" ? cached.value : undefined;
    let cancelled = false;
    const update = (state: LoadState<GitHubCloneRepositoryList>) => {
      setRepositories((current) => new Map(current).set(activeOwner, state));
    };
    if (!previous) update({ status: "loading" });
    loadLatestRepositories(activeOwner, previous?.nextCursor).then(
      (value) => {
        if (!cancelled) {
          const merged = new Map(
            previous?.repositories.map((repository) => [repository.fullName, repository]),
          );
          for (const repository of value.repositories) merged.set(repository.fullName, repository);
          update({
            status: "ready",
            value: { ...value, repositories: Array.from(merged.values()) },
          });
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          const message = errorMessage(error, `Could not list repositories for ${activeOwner}`);
          update(
            previous
              ? { status: "ready", value: previous, pageError: message }
              : { status: "error", message },
          );
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [activeOwner, repositoriesAttempt]);

  const existingRemotes = useMemo(
    () => new Set(existingGitUrls.map(normalizeGitHubRemote)),
    [existingGitUrls],
  );
  const isAlreadyAdded = useCallback(
    (repository: GitHubCloneRepository) =>
      existingRemotes.has(normalizeGitHubRemote(repository.cloneUrl)),
    [existingRemotes],
  );

  const filteredAccounts = useMemo(() => {
    if (accounts.status !== "ready") return [];
    const query = accountQuery.trim().toLowerCase();
    return accounts.value
      .filter((account) => !query || account.login.toLowerCase().includes(query))
      .sort((left, right) => compareGitHubNames(left.login, right.login));
  }, [accountQuery, accounts]);

  const filteredRepositories = useMemo(() => {
    if (activeRepositories?.status !== "ready") return [];
    const query = repositoryQuery.trim().toLowerCase();
    const matches = activeRepositories.value.repositories.filter(
      (repository) =>
        !query ||
        repository.name.toLowerCase().includes(query) ||
        (repository.description?.toLowerCase().includes(query) ?? false),
    );
    return sortGitHubRepositories(matches, sortOrder);
  }, [activeRepositories, repositoryQuery, sortOrder]);

  const selectAccount = (account: GitHubCloneAccount) => {
    setRepositoryQuery("");
    setStep({ kind: "repository", account });
  };

  const selectRepository = (account: GitHubCloneAccount, repository: GitHubCloneRepository) => {
    setCloneError(null);
    setLocalPath(defaultCloneDirectory ? joinHostPath(defaultCloneDirectory, repository.name) : "");
    setStep({ kind: "path", account, repository });
  };

  const retryRepositories = (owner: string) => {
    setRepositories((current) => {
      const next = new Map(current);
      next.delete(owner);
      return next;
    });
    setRepositoriesAttempt((attempt) => attempt + 1);
  };

  const browseForDirectory = async (repository: GitHubCloneRepository) => {
    try {
      const directory = await pickHostPath({
        mode: "directory",
        title: `Choose where to clone ${repository.name}`,
        defaultPath: parentDirectory(localPath) ?? defaultCloneDirectory,
      });
      if (!directory) return;
      setLocalPath(joinHostPath(directory, repository.name));
      setCloneError(null);
    } catch (browseError) {
      console.error("Failed to open directory picker:", browseError);
    }
  };

  const clone = async (repository: GitHubCloneRepository) => {
    if (cloningRef.current) return;
    const target = localPath.trim();
    if (!target) {
      setCloneError("Local path is required");
      return;
    }
    cloningRef.current = true;
    setIsCloning(true);
    setCloneError(null);
    try {
      await onClone(repository.cloneUrl, target);
    } catch (error) {
      setCloneError(errorMessage(error, "Failed to clone the repository"));
    } finally {
      cloningRef.current = false;
      setIsCloning(false);
    }
  };

  if (step.kind === "account") {
    return (
      <div className="min-w-0 space-y-3">
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            <ArrowLeft className="mr-1 h-4 w-4" />
            Back
          </Button>
          <span className="text-sm font-medium">Choose an organization</span>
        </div>
        {accounts.status === "loading" && <LoadingRow label="Loading organizations…" />}
        {accounts.status === "error" && (
          <ErrorRow
            message={accounts.message}
            onRetry={() => {
              setAccounts({ status: "loading" });
              setAccountsAttempt((attempt) => attempt + 1);
            }}
          />
        )}
        {accounts.status === "ready" && (
          <SearchableList
            items={filteredAccounts}
            query={accountQuery}
            onQueryChange={setAccountQuery}
            searchLabel="Search organizations"
            placeholder="Search organizations"
            emptyLabel="No matching organizations"
            itemKey={(account) => account.login}
            onSelect={selectAccount}
            renderItem={(account) => (
              <>
                {account.kind === "user" ? (
                  <User className="h-4 w-4 shrink-0 text-muted-foreground" />
                ) : (
                  <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1 truncate font-medium">{account.login}</span>
                {account.kind === "user" && (
                  <span className="text-xs text-muted-foreground">Personal</span>
                )}
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              </>
            )}
          />
        )}
      </div>
    );
  }

  if (step.kind === "repository") {
    const { account } = step;
    // min-w-0 keeps this dialog grid item from growing to fit long, untruncated
    // repository descriptions, which pushed the list past the dialog edge.
    return (
      <div className="min-w-0 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setStep({ kind: "account" })}
            >
              <ArrowLeft className="mr-1 h-4 w-4" />
              Organizations
            </Button>
            <span className="truncate text-sm font-medium">{account.login}</span>
          </div>
          <SegmentedSelector
            ariaLabel="Repository order"
            value={sortOrder}
            options={SORT_OPTIONS}
            onValueChange={setSortOrder}
            buttonClassName="h-7 px-2.5 text-xs"
          />
        </div>
        {(!activeRepositories || activeRepositories.status === "loading") && (
          <LoadingRow label="Loading repositories…" />
        )}
        {activeRepositories?.status === "error" && (
          <ErrorRow
            message={activeRepositories.message}
            onRetry={() => retryRepositories(account.login)}
          />
        )}
        {activeRepositories?.status === "ready" && (
          <>
            <SearchableList
              items={filteredRepositories}
              query={repositoryQuery}
              onQueryChange={setRepositoryQuery}
              searchLabel="Search repositories"
              placeholder={`Search ${account.login} repositories`}
              emptyLabel={
                activeRepositories.value.repositories.length === 0
                  ? "No repositories"
                  : "No matching repositories"
              }
              itemKey={(repository) => repository.fullName}
              isDisabled={isAlreadyAdded}
              onSelect={(repository) => selectRepository(account, repository)}
              renderItem={(repository) => {
                const added = isAlreadyAdded(repository);
                return (
                  <>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate font-medium" title={repository.name}>
                          {repository.name}
                        </span>
                        {repository.isPrivate && (
                          <LockKeyhole
                            className="h-3 w-3 shrink-0 text-muted-foreground"
                            aria-label="Private"
                          />
                        )}
                        {repository.isFork && (
                          <GitFork
                            className="h-3 w-3 shrink-0 text-muted-foreground"
                            aria-label="Fork"
                          />
                        )}
                        {repository.isArchived && (
                          <Archive
                            className="h-3 w-3 shrink-0 text-muted-foreground"
                            aria-label="Archived"
                          />
                        )}
                      </div>
                      {repository.description && (
                        <p
                          className="truncate text-xs text-muted-foreground"
                          title={repository.description}
                        >
                          {repository.description}
                        </p>
                      )}
                    </div>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {added ? "Already added" : formatCompactRelativeTime(repository.updatedAt)}
                    </span>
                  </>
                );
              }}
            />
            {activeRepositories.value.nextCursor && (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  {activeRepositories.value.repositories.length} repositories loaded. Load more to
                  search the rest.
                </p>
                {activeRepositories.pageError && (
                  <p role="alert" className="text-sm text-destructive">
                    {activeRepositories.pageError}
                  </p>
                )}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={activeRepositories.loadingMore}
                  onClick={() => {
                    setRepositories((current) =>
                      new Map(current).set(account.login, {
                        ...activeRepositories,
                        loadingMore: true,
                        pageError: undefined,
                      }),
                    );
                    setRepositoriesAttempt((attempt) => attempt + 1);
                  }}
                >
                  {activeRepositories.loadingMore
                    ? "Loading more…"
                    : activeRepositories.pageError
                      ? "Retry loading more"
                      : "Load more repositories"}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  const { account, repository } = step;
  return (
    <div className="min-w-0 space-y-4">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setStep({ kind: "repository", account })}
          disabled={isCloning}
        >
          <ArrowLeft className="mr-1 h-4 w-4" />
          Repositories
        </Button>
        <span className="truncate text-sm font-medium">{repository.fullName}</span>
      </div>

      <div className="space-y-2">
        <label htmlFor="githubClonePath" className="text-sm font-medium">
          Local path <span className="text-destructive">*</span>
        </label>
        <div className="flex gap-2">
          <Input
            id="githubClonePath"
            type="text"
            placeholder={`/path/to/${repository.name}`}
            value={localPath}
            onChange={(event) => {
              setLocalPath(event.target.value);
              setCloneError(null);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              void clone(repository);
            }}
            disabled={isCloning}
            className="flex-1 font-mono text-sm"
            autoFocus
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() => void browseForDirectory(repository)}
            disabled={isCloning}
            aria-label="Choose clone folder"
          >
            <FolderOpen className="h-4 w-4" />
          </Button>
        </div>
        <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {repository.fullName} is cloned into this folder, then added as a project.
        </p>
      </div>

      {cloneError && (
        <p className="text-sm text-destructive" role="alert">
          {cloneError}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel} disabled={isCloning}>
          Cancel
        </Button>
        <Button
          type="button"
          onClick={() => void clone(repository)}
          disabled={isCloning || !localPath.trim()}
          className={cn(isCloning && "cursor-wait")}
        >
          {isCloning && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {isCloning ? "Cloning…" : "Clone project"}
        </Button>
      </div>
    </div>
  );
}
