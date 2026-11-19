import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronsDownUp,
  ChevronsUpDown,
  EyeOff,
  FolderTree,
  MessageSquare,
  MessageSquareDot,
  Search,
  SkipForward,
} from "lucide-react";
import { toast } from "sonner";
import {
  gitHubPullRequestComparisonKey,
  gitHubPullRequestKey,
  gitHubPullRequestUrl,
  type GitHubPullRequestFile,
  type GitHubPullRequestFiles,
  type GitHubPullRequestRef,
  type GitHubPullRequestReviewThread,
} from "@orkestrator/protocol/github-pull-requests";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useWidthAtLeast } from "@/hooks/useWidthAtLeast";
import { cn } from "@/lib/utils";
import { filePatchKey, resourceKey, usePullRequestsStore } from "@/stores/pullRequestsStore";
import {
  PullRequestFileSection,
  openExternal,
  type FilePatchState,
} from "./PullRequestFileSection";
import { PullRequestFileTree } from "./PullRequestFileTree";
import { PullRequestReviewDrafts } from "./pull-request-review-drafts";
import { pluralize } from "./pull-request-format";
import {
  NO_FILE_FILTERS,
  ancestorDirectories,
  buildFileTree,
  fileMatchesFilters,
  filtersActive,
  nextFileAfter,
  nextThreadAfter,
  treeFileOrder,
  unresolvedByPath,
  unresolvedThreadOrder,
  type FileFilters,
} from "./pull-request-file-navigation";
import { errorMessage } from "./pull-request-shared";

/** Above this many files every file starts collapsed. */
export const AUTO_EXPAND_FILE_LIMIT = 20;
/** At this width the file tree sits beside the diffs and starts open. */
export const FILE_TREE_SIDE_BY_SIDE_MIN_WIDTH_PX = 640;

function initialExpanded(files: GitHubPullRequestFile[]): Set<string> {
  if (files.length > AUTO_EXPAND_FILE_LIMIT) return new Set();
  return new Set(files.filter((file) => file.viewedState !== "viewed").map((file) => file.path));
}

function withAdded(set: ReadonlySet<string>, ...values: string[]): Set<string> {
  const next = new Set(set);
  for (const value of values) next.add(value);
  return next;
}

function withRemoved(set: ReadonlySet<string>, ...values: string[]): Set<string> {
  const next = new Set(set);
  for (const value of values) next.delete(value);
  return next;
}

/** A pending scroll to a file section, or to one conversation inside it. */
type ScrollTarget = { path: string; threadId: string | null; revealTree: boolean };

function findByData(root: HTMLElement, selector: string, key: string, value: string) {
  for (const element of Array.from(root.querySelectorAll<HTMLElement>(selector))) {
    if (element.dataset[key] === value) return element;
  }
  return null;
}

function FilterToggle({
  pressed,
  onPressedChange,
  label,
  ariaLabel,
  icon: Icon,
}: {
  pressed: boolean;
  onPressedChange: (pressed: boolean) => void;
  label: string;
  ariaLabel: string;
  icon: typeof EyeOff;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-pressed={pressed}
      aria-label={ariaLabel}
      title={ariaLabel}
      onClick={() => onPressedChange(!pressed)}
      className={cn(
        "h-7 gap-1 px-2 text-xs text-muted-foreground",
        pressed && "bg-primary/15 text-primary hover:bg-primary/20 hover:text-primary",
      )}
    >
      <Icon className="size-3.5" />
      {label}
    </Button>
  );
}

export function PullRequestCodeTab({
  pullRequest,
  files,
  canComment,
}: {
  pullRequest: GitHubPullRequestRef;
  files: GitHubPullRequestFiles;
  canComment: boolean;
}) {
  const setFileViewed = usePullRequestsStore((state) => state.setFileViewed);
  const loadFilePatch = usePullRequestsStore((state) => state.loadFilePatch);
  const filePatches = usePullRequestsStore((state) => state.filePatches);
  const loading = usePullRequestsStore((state) => state.loading);
  const errors = usePullRequestsStore((state) => state.errors);
  const loadedAt = usePullRequestsStore((state) => state.loadedAt);
  const prKey = gitHubPullRequestKey(pullRequest);
  const { headSha, comparisonBase } = files;
  const comparisonKey = gitHubPullRequestComparisonKey(files);

  const [expanded, setExpanded] = useState(() => initialExpanded(files.files));
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [filters, setFilters] = useState<FileFilters>(NO_FILE_FILTERS);
  const [collapsedDirectories, setCollapsedDirectories] = useState<Set<string>>(() => new Set());
  // The last attempted comparison for each file the reader explicitly opened.
  // A null entry records intent on a file that had no deferred patch to load.
  const wantedPatches = useRef(new Map<string, string | null>());
  const [threadCursor, setThreadCursor] = useState<string | null>(null);
  const [treeOverride, setTreeOverride] = useState<boolean | null>(null);
  const [measureRef, wide] = useWidthAtLeast<HTMLDivElement>(FILE_TREE_SIDE_BY_SIDE_MIN_WIDTH_PX);
  const showTree = treeOverride ?? wide;
  const listRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<HTMLElement>(null);
  const scrollTarget = useRef<ScrollTarget | null>(null);
  // Bumped with each navigation so the scroll effect runs even when the
  // file was already open and selected.
  const [, setScrollRequests] = useState(0);

  const threadsByPath = useMemo(() => {
    const map = new Map<string, GitHubPullRequestReviewThread[]>();
    for (const thread of files.threads) {
      map.set(thread.path, [...(map.get(thread.path) ?? []), thread]);
    }
    return map;
  }, [files.threads]);
  const unresolved = useMemo(() => unresolvedByPath(files.threads), [files.threads]);
  const indexByPath = useMemo(
    () => new Map(files.files.map((file, index) => [file.path, index])),
    [files.files],
  );
  const filesByPath = useMemo(
    () => new Map(files.files.map((file) => [file.path, file])),
    [files.files],
  );
  const tree = useMemo(
    () =>
      buildFileTree(
        files.files.filter((file) => fileMatchesFilters(file, filters, unresolved)),
        unresolved,
      ),
    [files.files, filters, unresolved],
  );
  const shownFiles = useMemo(() => treeFileOrder(tree), [tree]);
  const shownPaths = useMemo(() => new Set(shownFiles.map((file) => file.path)), [shownFiles]);
  const unresolvedThreads = useMemo(
    () => unresolvedThreadOrder(shownFiles, files.threads),
    [shownFiles, files.threads],
  );
  const filtering = filtersActive(filters);
  const hiddenCount = files.files.length - shownFiles.length;
  const viewedCount = files.files.filter((file) => file.viewedState === "viewed").length;
  const nextUnviewed = nextFileAfter(
    shownFiles,
    selectedPath,
    (file) => file.viewedState !== "viewed",
  );
  const threadPosition = unresolvedThreads.findIndex((thread) => thread.id === threadCursor);

  const patchStateFor = (path: string): FilePatchState => {
    const key = filePatchKey(prKey, comparisonKey, path);
    const loadKey = resourceKey("file-patch", key);
    return {
      patch: filePatches.get(key),
      loading: loading.has(loadKey),
      error: errors.get(loadKey),
      settled: loadedAt.has(loadKey),
    };
  };

  const requestPatch = (path: string) => {
    if (!wantedPatches.current.has(path)) wantedPatches.current.set(path, null);
    const file = filesByPath.get(path);
    if (!comparisonBase || !file?.patchDeferred || file.patchAvailable) return;
    wantedPatches.current.set(path, comparisonKey);
    if (patchStateFor(path).patch) return;
    void loadFilePatch(pullRequest, {
      path,
      headSha,
      comparisonBase,
      index: indexByPath.get(path),
    });
  };

  // Carry explicit intent forward when a new list arrives. Cache eviction
  // leaves the attempt recorded so only another file action reloads that patch.
  useEffect(() => {
    for (const [path, attempted] of Array.from(wantedPatches.current)) {
      const file = filesByPath.get(path);
      if (!file) {
        wantedPatches.current.delete(path);
        continue;
      }
      if (!comparisonBase || !expanded.has(path) || !shownPaths.has(path)) continue;
      if (!file.patchDeferred || file.patchAvailable || attempted === comparisonKey) continue;
      wantedPatches.current.set(path, comparisonKey);
      const key = filePatchKey(prKey, comparisonKey, path);
      if (filePatches.has(key)) continue;
      void loadFilePatch(pullRequest, {
        path,
        headSha,
        comparisonBase,
        index: indexByPath.get(path),
      });
    }
  }, [
    comparisonBase,
    comparisonKey,
    expanded,
    shownPaths,
    filesByPath,
    filePatches,
    prKey,
    headSha,
    indexByPath,
    loadFilePatch,
    pullRequest,
  ]);

  useEffect(() => {
    const target = scrollTarget.current;
    const list = listRef.current;
    if (!target || !list) return;
    if (!shownPaths.has(target.path) || !expanded.has(target.path)) {
      scrollTarget.current = null;
      return;
    }
    const tree = treeRef.current;
    if (target.revealTree && tree) {
      const row = findByData(tree, '[aria-current="true"]', "path", target.path);
      if (row) {
        const viewport = tree.getBoundingClientRect();
        const bounds = row.getBoundingClientRect();
        if (bounds.top < viewport.top) tree.scrollTop += bounds.top - viewport.top;
        else if (bounds.bottom > viewport.bottom) tree.scrollTop += bounds.bottom - viewport.bottom;
      }
    }
    target.revealTree = false;

    const section = findByData(list, '[data-testid="pull-request-file"]', "path", target.path);
    if (!section) return;
    if (target.threadId) {
      const file = filesByPath.get(target.path);
      const { patch, loading, error, settled } = patchStateFor(target.path);
      if (
        comparisonBase &&
        file?.patchDeferred &&
        !file.patchAvailable &&
        (loading || (!patch && !error && !settled))
      )
        return;

      const thread = findByData(section, "[data-thread-id]", "threadId", target.threadId);
      if (thread) {
        scrollTarget.current = null;
        thread.scrollIntoView?.({ block: "center" });
        thread.focus?.({ preventScroll: true });
        return;
      }
    }
    scrollTarget.current = null;
    section.scrollIntoView?.({ block: "start" });
  });

  /** Opens a file (and optionally one of its conversations) and scrolls to it. */
  const openFile = (path: string, threadId: string | null = null) => {
    setSelectedPath(path);
    setExpanded((current) => (current.has(path) ? current : withAdded(current, path)));
    requestPatch(path);
    setCollapsedDirectories((current) => withRemoved(current, ...ancestorDirectories(path)));
    scrollTarget.current = { path, threadId, revealTree: true };
    setScrollRequests((count) => count + 1);
  };

  const toggle = (path: string) => {
    const opening = !expanded.has(path);
    setExpanded((current) => (opening ? withAdded(current, path) : withRemoved(current, path)));
    if (opening) {
      setSelectedPath(path);
      requestPatch(path);
    }
  };

  const markViewed = (path: string, viewed: boolean) => {
    // Like GitHub, marking a file viewed folds it away.
    if (viewed) setExpanded((current) => withRemoved(current, path));
    void setFileViewed(pullRequest, path, viewed).catch((error) => {
      toast.error(errorMessage(error, "Could not update the viewed state."));
    });
  };

  const goToNextUnresolved = () => {
    const next = nextThreadAfter(unresolvedThreads, threadCursor);
    if (!next) return;
    setThreadCursor(next.id);
    openFile(next.path, next.id);
  };

  const toggleDirectory = (path: string) =>
    setCollapsedDirectories((current) =>
      current.has(path) ? withRemoved(current, path) : withAdded(current, path),
    );

  const fileList =
    shownFiles.length === 0 ? (
      <p className="px-4 py-6 text-center text-xs text-muted-foreground">
        {files.files.length === 0 ? "No changed files." : "No files match the filters."}
      </p>
    ) : (
      shownFiles.map((file) => (
        <PullRequestFileSection
          key={file.path}
          pullRequest={pullRequest}
          file={file}
          threads={threadsByPath.get(file.path) ?? []}
          expanded={expanded.has(file.path)}
          selected={file.path === selectedPath}
          onToggle={() => toggle(file.path)}
          onViewed={(viewed) => markViewed(file.path, viewed)}
          commitId={headSha}
          comparisonKey={comparisonKey}
          canLoadPatch={Boolean(comparisonBase)}
          canComment={canComment}
          patchState={patchStateFor(file.path)}
          onLoadPatch={() => requestPatch(file.path)}
        />
      ))
    );

  return (
    <div ref={measureRef} className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border/60 px-2 py-1.5">
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn("size-7", showTree && "bg-muted")}
          aria-label={showTree ? "Hide file tree" : "Show file tree"}
          aria-pressed={showTree}
          title={showTree ? "Hide file tree" : "Show file tree"}
          onClick={() => setTreeOverride(!showTree)}
        >
          <FolderTree className="size-3.5" />
        </Button>
        <div className="relative min-w-32 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={filters.query}
            onChange={(event) => setFilters({ ...filters, query: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Escape" && filters.query) {
                event.stopPropagation();
                setFilters({ ...filters, query: "" });
              }
            }}
            placeholder="Filter files by path"
            aria-label="Filter files by path"
            className="h-7 pl-7 text-xs"
          />
        </div>
        <FilterToggle
          pressed={filters.unviewedOnly}
          onPressedChange={(unviewedOnly) => setFilters({ ...filters, unviewedOnly })}
          label="Unviewed"
          ariaLabel="Only unviewed files"
          icon={EyeOff}
        />
        <FilterToggle
          pressed={filters.unresolvedOnly}
          onPressedChange={(unresolvedOnly) => setFilters({ ...filters, unresolvedOnly })}
          label="Unresolved"
          ariaLabel="Only files with unresolved conversations"
          icon={MessageSquareDot}
        />
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border/60 px-3 py-1 text-xs text-muted-foreground">
        {filtering ? (
          <span data-testid="file-filter-summary" role="status">
            Showing {shownFiles.length} of {pluralize(files.files.length, "file")}
            {hiddenCount > 0 && ` · ${hiddenCount} hidden`}
            <button
              type="button"
              className="ml-1.5 text-primary hover:underline"
              onClick={() => setFilters(NO_FILE_FILTERS)}
            >
              Clear
            </button>
          </span>
        ) : (
          <span>{pluralize(files.files.length, "file")}</span>
        )}
        <span>·</span>
        <span data-testid="viewed-count">
          {viewedCount} / {files.files.length} viewed
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
            disabled={!nextUnviewed}
            title={nextUnviewed ? `Next unviewed: ${nextUnviewed.path}` : "No unviewed files shown"}
            onClick={() => nextUnviewed && openFile(nextUnviewed.path)}
          >
            <SkipForward className="size-3.5" />
            Next unviewed
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
            disabled={unresolvedThreads.length === 0}
            aria-label="Next unresolved conversation"
            title={
              unresolvedThreads.length === 0
                ? "No unresolved conversations on the files shown"
                : "Next unresolved conversation"
            }
            onClick={goToNextUnresolved}
          >
            <MessageSquare className="size-3.5" />
            <span data-testid="unresolved-position" className="tabular-nums">
              {threadPosition >= 0
                ? `${threadPosition + 1}/${unresolvedThreads.length}`
                : unresolvedThreads.length}
            </span>
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-7"
            aria-label="Expand all files"
            title="Expand all shown files"
            onClick={() =>
              setExpanded((current) => withAdded(current, ...shownFiles.map((file) => file.path)))
            }
          >
            <ChevronsUpDown className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-7"
            aria-label="Collapse all files"
            title="Collapse all"
            onClick={() => setExpanded(new Set())}
          >
            <ChevronsDownUp className="size-3.5" />
          </Button>
        </div>
      </div>
      {files.truncated && (
        <div
          role="note"
          className="shrink-0 border-b border-border/60 bg-muted/30 px-4 py-1.5 text-xs text-muted-foreground"
        >
          GitHub only lists the first {files.files.length.toLocaleString()} files of this pull
          request.{" "}
          <button
            type="button"
            className="text-primary hover:underline"
            onClick={() => openExternal(`${gitHubPullRequestUrl(pullRequest)}/files`)}
          >
            View all on GitHub
          </button>
        </div>
      )}
      <div className={cn("flex min-h-0 flex-1", wide ? "flex-row" : "flex-col")}>
        {showTree && files.files.length > 0 && (
          <PullRequestFileTree
            ref={treeRef}
            nodes={tree}
            collapsed={collapsedDirectories}
            forceOpen={filtering}
            selectedPath={selectedPath}
            onToggleDirectory={toggleDirectory}
            onSelectFile={(path) => openFile(path)}
            className={cn(
              "shrink-0 border-border/60",
              wide ? "w-64 max-w-[40%] border-r" : "max-h-[40%] border-b",
            )}
          />
        )}
        <div
          ref={listRef}
          data-testid="pull-request-file-list"
          className="min-h-0 min-w-0 flex-1 overflow-y-auto pb-6"
        >
          <PullRequestReviewDrafts>{fileList}</PullRequestReviewDrafts>
        </div>
      </div>
    </div>
  );
}
