import { currentFilesPanelTargetId } from "@/lib/pull-request-opener";
import { useFilesPanelStore } from "@/stores/filesPanelStore";
import { GitPullRequest, X } from "lucide-react";
import { PullRequestOpenerProvider, openPullRequestInApp } from "@/lib/pull-request-opener";
import { cn } from "@/lib/utils";
import { useCallback } from "react";
import type {
  GitHubPullRequestRef,
  GitHubPullRequestViewTab,
} from "@orkestrator/protocol/github-pull-requests";
import { useNodeScope } from "@/lib/node-scope/providers";
import {
  projectPullRequestsStore,
  selectProjectPullRequestTabs,
  useProjectPullRequestsStore,
} from "@/stores/projectPullRequestsStore";
import { useShallow } from "zustand/react/shallow";
import { PullRequestList } from "./PullRequestList";
import { PullRequestStateIcon } from "./PullRequestStateIcon";
import { PullRequestView } from "./PullRequestView";

/**
 * The project page's "Pull requests" tab: the repository's list plus the pull
 * requests opened from it, each in its own closable tab.
 */
export function ProjectPullRequestsView({ projectId }: { projectId: string }) {
  const scope = useNodeScope();
  // This node's files panel target (an in-tree node's own, plan item 5002).
  const targetId = currentFilesPanelTargetId(scope);
  const panePR = useFilesPanelStore((state) =>
    targetId
      ? state.pullRequestTabs[targetId]?.find(
          (tab) => state.activeTab === `pull-request:${tab.key}`,
        )
      : undefined,
  );
  const { tabs, activeKey } = useProjectPullRequestsStore(
    useShallow((state) => selectProjectPullRequestTabs(state, projectId)),
  );
  const closePullRequest = useProjectPullRequestsStore((state) => state.closePullRequest);
  const setActive = useProjectPullRequestsStore((state) => state.setActive);
  const updateTab = useProjectPullRequestsStore((state) => state.updateTab);
  const projectPullRequests = scope.store(projectPullRequestsStore);
  const openInApp = useCallback(
    (ref: GitHubPullRequestRef, view?: GitHubPullRequestViewTab) =>
      openPullRequestInApp(ref, view, scope),
    [scope],
  );
  const active = activeKey ? tabs.find((tab) => tab.key === activeKey) : undefined;

  return (
    <PullRequestOpenerProvider open={openInApp}>
      <div className="flex h-full min-h-0 flex-col">
        <div
          role="tablist"
          aria-label="Pull request tabs"
          className="flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-border/80 px-3"
        >
          <button
            type="button"
            role="tab"
            aria-selected={!active}
            onClick={() => setActive(projectId, null)}
            className={cn(
              "flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-muted-foreground hover:text-foreground",
              !active && "bg-elevated text-foreground",
            )}
          >
            <GitPullRequest className="size-3.5" />
            Pull requests
          </button>
          {panePR && (
            <button
              type="button"
              className="px-2 text-xs text-muted-foreground hover:text-foreground"
              onClick={() =>
                projectPullRequests.getState().openPullRequest(projectId, panePR.ref, panePR.view)
              }
            >
              Open pane PR in main area
            </button>
          )}
          {tabs.map((tab) => {
            const selected = tab.key === active?.key;
            const label = `${tab.ref.owner}/${tab.ref.repo} #${tab.ref.number}${tab.title ? ` · ${tab.title}` : ""}`;
            return (
              <div
                key={tab.key}
                className={cn(
                  "group flex h-7 max-w-64 shrink-0 items-center rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground",
                  selected && "bg-elevated text-foreground",
                )}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  title={label}
                  onClick={() => setActive(projectId, tab.key)}
                  className="flex min-w-0 items-center gap-1.5 py-1 pl-2.5 pr-1"
                >
                  {tab.state ? (
                    <PullRequestStateIcon
                      state={tab.state}
                      isDraft={tab.isDraft ?? false}
                      className="size-3.5 shrink-0"
                    />
                  ) : (
                    <GitPullRequest className="size-3.5 shrink-0" />
                  )}
                  <span className="shrink-0">#{tab.ref.number}</span>
                  {tab.title && <span className="truncate">{tab.title}</span>}
                </button>
                <button
                  type="button"
                  aria-label={`Close ${label}`}
                  onClick={() => closePullRequest(projectId, tab.key)}
                  className="mr-1 rounded p-0.5 text-muted-foreground opacity-60 hover:bg-white/10 hover:text-foreground hover:opacity-100"
                >
                  <X className="size-3" />
                </button>
              </div>
            );
          })}
        </div>
        {active ? (
          <PullRequestView
            key={`${active.key}:${active.openRequest}`}
            className="min-h-0 flex-1"
            pullRequest={active.ref}
            initialView={active.view}
            layout="page"
            onSummaryLoaded={(summary) => updateTab(projectId, active.key, summary)}
          />
        ) : (
          <PullRequestList
            className="min-h-0 flex-1"
            projectId={projectId}
            layout="page"
            onOpenPullRequest={(ref) => openInApp(ref)}
          />
        )}
      </div>
    </PullRequestOpenerProvider>
  );
}
