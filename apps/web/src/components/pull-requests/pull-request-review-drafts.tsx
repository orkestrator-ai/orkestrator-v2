import { createContext, useContext, useState, type ReactNode } from "react";
import { createStore, useStore } from "zustand";
import type { GitHubPullRequestRef } from "@orkestrator/protocol/github-pull-requests";
import { usePullRequestsStore } from "@/stores/pullRequestsStore";
import { CommentComposer } from "./pull-request-shared";

type CommentDraft = { body: string; submitting: boolean };

type InlineReviewAnchor = {
  comparisonKey: string;
  commitId: string;
  path: string;
  side: "LEFT" | "RIGHT";
  line: number;
  hunkIndex: number;
  lineIndex: number;
};

type Drafts = { inline: CommentDraft & { anchor: InlineReviewAnchor }; replies: CommentDraft };
type DraftState = { [K in keyof Drafts]: Map<string, Drafts[K]> };
type ReviewDraftStore = ReturnType<typeof createDraftStore>;

const createDraftStore = () =>
  createStore<DraftState>(() => ({ inline: new Map(), replies: new Map() }));
const DraftContext = createContext<ReviewDraftStore | null>(null);

/** Lifetime of the Code tab, including while individual files are hidden. */
export function PullRequestReviewDrafts({ children }: { children: ReactNode }) {
  const [store] = useState(createDraftStore);
  return <DraftContext.Provider value={store}>{children}</DraftContext.Provider>;
}

export function useReviewDraftStore() {
  const sharedStore = useContext(DraftContext);
  const [store] = useState(() => sharedStore ?? createDraftStore());
  return store;
}

export function useReviewDraft<K extends keyof Drafts, T>(
  store: ReviewDraftStore,
  kind: K,
  key: string,
  select: (draft: Drafts[K] | undefined) => T,
) {
  const draft = useStore(store, (state) => select(state[kind].get(key)));
  const setDraft = (value: Drafts[K] | undefined) => {
    const next = new Map<string, Drafts[K]>(store.getState()[kind]);
    if (value) next.set(key, value);
    else next.delete(key);
    store.setState({ [kind]: next });
  };
  const updateDraft = (change: Partial<CommentDraft>) => {
    const current = store.getState()[kind].get(key);
    if (current) setDraft({ ...current, ...change });
  };
  return { draft, setDraft, updateDraft };
}

export function InlineReviewDraftComposer({
  pullRequest,
  store,
  path,
  comparisonKey,
  autoFocus,
}: {
  pullRequest: GitHubPullRequestRef;
  store: ReviewDraftStore;
  path: string;
  comparisonKey: string;
  autoFocus?: boolean;
}) {
  const { draft, setDraft, updateDraft } = useReviewDraft(store, "inline", path, (draft) => draft);
  const addReviewComment = usePullRequestsStore((state) => state.addReviewComment);
  if (!draft) return null;
  const { anchor } = draft;
  return (
    <div className="rounded-lg border border-border bg-card/60 p-2 font-sans">
      {anchor.comparisonKey !== comparisonKey && (
        <p className="mb-2 text-xs text-muted-foreground">
          Commenting on the original revision {anchor.commitId.slice(0, 7)}, {anchor.path},{" "}
          {anchor.side} line {anchor.line}.
        </p>
      )}
      <CommentComposer
        autoFocus={autoFocus}
        placeholder="Add a review comment"
        ariaLabel="Review comment"
        submitLabel="Add comment"
        draft={{ body: draft.body, submitting: draft.submitting, update: updateDraft }}
        onCancel={() => setDraft(undefined)}
        onSubmit={async (body) => {
          await addReviewComment(pullRequest, anchor.commitId, {
            path: anchor.path,
            line: anchor.line,
            side: anchor.side,
            body,
          });
          setDraft(undefined);
        }}
      />
    </div>
  );
}
