import {
  CircleCheck,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  MessageSquare,
} from "lucide-react";
import type { Ref } from "react";
import { cn } from "@/lib/utils";
import { pluralize } from "./pull-request-format";
import type { FileTreeNode } from "./pull-request-file-navigation";
import { FILE_STATUS_ICONS } from "./pull-request-file-status";

const INDENT_PX = 12;

function UnresolvedBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span
      className="flex shrink-0 items-center gap-0.5 text-[10px] text-amber-400 tabular-nums"
      title={pluralize(count, "unresolved conversation")}
    >
      <MessageSquare className="size-3" />
      {count}
    </span>
  );
}

function TreeLevel({
  nodes,
  depth,
  collapsed,
  forceOpen,
  selectedPath,
  onToggleDirectory,
  onSelectFile,
}: {
  nodes: readonly FileTreeNode[];
  depth: number;
  collapsed: ReadonlySet<string>;
  forceOpen: boolean;
  selectedPath: string | null;
  onToggleDirectory: (path: string) => void;
  onSelectFile: (path: string) => void;
}) {
  return (
    <ul role={depth === 0 ? undefined : "group"} className="min-w-0">
      {nodes.map((node) => {
        const padding = { paddingLeft: `${depth * INDENT_PX + 4}px` };
        if (node.kind === "directory") {
          const open = forceOpen || !collapsed.has(node.path);
          const allViewed = node.fileCount > 0 && node.viewedCount === node.fileCount;
          return (
            <li key={`d:${node.path}`} className="min-w-0">
              <button
                type="button"
                data-testid="file-tree-directory"
                data-path={node.path}
                aria-expanded={open}
                disabled={forceOpen}
                onClick={() => onToggleDirectory(node.path)}
                title={`${node.path} · ${node.viewedCount} / ${pluralize(node.fileCount, "file")} viewed`}
                className={cn(
                  "flex w-full min-w-0 items-center gap-1 rounded-sm py-0.5 pr-1.5 text-left text-xs text-muted-foreground",
                  !forceOpen && "hover:bg-muted/40 hover:text-foreground",
                )}
                style={padding}
              >
                {open ? (
                  <ChevronDown className={cn("size-3 shrink-0", forceOpen && "invisible")} />
                ) : (
                  <ChevronRight className="size-3 shrink-0" />
                )}
                {open ? (
                  <FolderOpen className="size-3.5 shrink-0" />
                ) : (
                  <Folder className="size-3.5 shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate">{node.name}</span>
                <UnresolvedBadge count={node.unresolvedCount} />
                {allViewed && (
                  <CircleCheck
                    className="size-3 shrink-0 text-muted-foreground/70"
                    aria-label="All viewed"
                  />
                )}
              </button>
              {open && (
                <TreeLevel
                  nodes={node.children}
                  depth={depth + 1}
                  collapsed={collapsed}
                  forceOpen={forceOpen}
                  selectedPath={selectedPath}
                  onToggleDirectory={onToggleDirectory}
                  onSelectFile={onSelectFile}
                />
              )}
            </li>
          );
        }
        const { icon: StatusIcon, className: statusClass } = FILE_STATUS_ICONS[node.file.status];
        const selected = node.path === selectedPath;
        const viewed = node.file.viewedState === "viewed";
        return (
          <li key={`f:${node.path}`} className="min-w-0">
            <button
              type="button"
              data-testid="file-tree-file"
              data-path={node.path}
              aria-current={selected ? "true" : undefined}
              onClick={() => onSelectFile(node.path)}
              title={node.path}
              className={cn(
                "flex w-full min-w-0 items-center gap-1 rounded-sm py-0.5 pr-1.5 text-left text-xs hover:bg-muted/40",
                selected ? "bg-muted text-foreground" : "text-foreground/90",
                viewed && !selected && "text-muted-foreground",
              )}
              style={{ paddingLeft: `${depth * INDENT_PX + 4 + 16}px` }}
            >
              <StatusIcon
                className={cn("size-3.5 shrink-0", statusClass)}
                aria-label={node.file.status}
              />
              <span className="min-w-0 flex-1 truncate">{node.name}</span>
              <UnresolvedBadge count={node.unresolvedCount} />
              {viewed && (
                <CircleCheck
                  className="size-3 shrink-0 text-muted-foreground/70"
                  aria-label="Viewed"
                />
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The changed files as a collapsible path tree. Selecting a file asks the
 * code tab to open and scroll to it; while a search or filter is active every
 * directory is shown open, so a match is never hidden in a closed folder.
 */
export function PullRequestFileTree({
  ref,
  nodes,
  collapsed,
  forceOpen,
  selectedPath,
  onToggleDirectory,
  onSelectFile,
  className,
}: {
  nodes: readonly FileTreeNode[];
  collapsed: ReadonlySet<string>;
  forceOpen: boolean;
  selectedPath: string | null;
  onToggleDirectory: (path: string) => void;
  onSelectFile: (path: string) => void;
  className?: string;
  ref?: Ref<HTMLElement>;
}) {
  return (
    <nav
      ref={ref}
      aria-label="Changed files"
      data-testid="pull-request-file-tree"
      className={cn("min-h-0 overflow-y-auto py-1", className)}
    >
      {nodes.length === 0 ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">No files match.</p>
      ) : (
        <TreeLevel
          nodes={nodes}
          depth={0}
          collapsed={collapsed}
          forceOpen={forceOpen}
          selectedPath={selectedPath}
          onToggleDirectory={onToggleDirectory}
          onSelectFile={onSelectFile}
        />
      )}
    </nav>
  );
}
