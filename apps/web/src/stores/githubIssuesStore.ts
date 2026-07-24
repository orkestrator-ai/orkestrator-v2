import { create } from "zustand";
import {
  addGitHubIssueComment,
  closeGitHubIssue,
  getGitHubIssue,
  getGitHubIssues,
  updateGitHubIssue,
  updateGitHubIssueComment,
  updateGitHubIssueStatus,
} from "@/lib/backend";
import type {
  GitHubIssue,
  GitHubIssueComment,
  GitHubIssueDetail,
  GitHubIssuesSnapshot,
  GitHubIssueStatus,
} from "@/types/github";

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}

function detailKey(projectId: string, issueNumber: number): string {
  return `${projectId}:${issueNumber}`;
}

function replaceIssue(
  snapshot: GitHubIssuesSnapshot | undefined,
  issue: GitHubIssue,
): GitHubIssuesSnapshot | undefined {
  if (!snapshot) return snapshot;
  return {
    ...snapshot,
    issues:
      issue.state === "open"
        ? snapshot.issues.map((candidate) =>
            candidate.number === issue.number ? issue : candidate,
          )
        : snapshot.issues.filter((candidate) => candidate.number !== issue.number),
  };
}

function mergeIssueDetail(
  current: GitHubIssueDetail | undefined,
  issue: GitHubIssue,
): GitHubIssueDetail | undefined {
  if (!current || current.number !== issue.number) return current;
  return { ...current, ...issue, comments: current.comments };
}

interface GitHubIssuesState {
  snapshots: Map<string, GitHubIssuesSnapshot>;
  details: Map<string, GitHubIssueDetail>;
  loadingProjects: Set<string>;
  loadingDetails: Set<string>;
  projectErrors: Map<string, string>;
  detailErrors: Map<string, string>;
  mutations: Set<string>;
  mutationErrors: Map<string, string>;
  loadIssues: (projectId: string) => Promise<void>;
  loadIssue: (projectId: string, issueNumber: number) => Promise<void>;
  changeStatus: (
    projectId: string,
    issueNumber: number,
    status: GitHubIssueStatus,
  ) => Promise<void>;
  saveIssue: (
    projectId: string,
    issueNumber: number,
    updates: { title: string; body: string },
  ) => Promise<GitHubIssue>;
  closeIssue: (projectId: string, issueNumber: number) => Promise<void>;
  addComment: (
    projectId: string,
    issueNumber: number,
    body: string,
  ) => Promise<GitHubIssueComment>;
  editComment: (
    projectId: string,
    issueNumber: number,
    commentId: number,
    body: string,
  ) => Promise<GitHubIssueComment>;
  clearMutationError: (key: string) => void;
  clearProject: (projectId: string) => void;
}

const activeIssueRequests = new Map<string, number>();
const activeProjectRequests = new Map<string, number>();

function invalidateIssueReads(projectId: string, issueNumber: number): string {
  const key = detailKey(projectId, issueNumber);
  activeProjectRequests.set(
    projectId,
    (activeProjectRequests.get(projectId) ?? 0) + 1,
  );
  activeIssueRequests.set(key, (activeIssueRequests.get(key) ?? 0) + 1);
  return key;
}

export const useGitHubIssuesStore = create<GitHubIssuesState>()((set, get) => ({
  snapshots: new Map(),
  details: new Map(),
  loadingProjects: new Set(),
  loadingDetails: new Set(),
  projectErrors: new Map(),
  detailErrors: new Map(),
  mutations: new Set(),
  mutationErrors: new Map(),

  loadIssues: async (projectId) => {
    const requestId = (activeProjectRequests.get(projectId) ?? 0) + 1;
    activeProjectRequests.set(projectId, requestId);
    set((state) => {
      const loadingProjects = new Set(state.loadingProjects).add(projectId);
      const projectErrors = new Map(state.projectErrors);
      projectErrors.delete(projectId);
      return { loadingProjects, projectErrors };
    });

    try {
      const snapshot = await getGitHubIssues(projectId);
      if (activeProjectRequests.get(projectId) !== requestId) return;
      set((state) => {
        const snapshots = new Map(state.snapshots).set(projectId, snapshot);
        const loadingProjects = new Set(state.loadingProjects);
        loadingProjects.delete(projectId);
        return { snapshots, loadingProjects };
      });
    } catch (error) {
      if (activeProjectRequests.get(projectId) !== requestId) return;
      set((state) => {
        const loadingProjects = new Set(state.loadingProjects);
        loadingProjects.delete(projectId);
        const projectErrors = new Map(state.projectErrors).set(
          projectId,
          errorMessage(error, "Could not load GitHub issues."),
        );
        return { loadingProjects, projectErrors };
      });
    }
  },

  loadIssue: async (projectId, issueNumber) => {
    const key = detailKey(projectId, issueNumber);
    const requestId = (activeIssueRequests.get(key) ?? 0) + 1;
    activeIssueRequests.set(key, requestId);
    set((state) => {
      const loadingDetails = new Set(state.loadingDetails).add(key);
      const detailErrors = new Map(state.detailErrors);
      detailErrors.delete(key);
      return { loadingDetails, detailErrors };
    });

    try {
      const issue = await getGitHubIssue(projectId, issueNumber);
      if (activeIssueRequests.get(key) !== requestId) return;
      set((state) => {
        const details = new Map(state.details).set(key, issue);
        const snapshots = new Map(state.snapshots);
        const nextSnapshot = replaceIssue(snapshots.get(projectId), issue);
        if (nextSnapshot) snapshots.set(projectId, nextSnapshot);
        const loadingDetails = new Set(state.loadingDetails);
        loadingDetails.delete(key);
        return { details, snapshots, loadingDetails };
      });
    } catch (error) {
      if (activeIssueRequests.get(key) !== requestId) return;
      set((state) => {
        const loadingDetails = new Set(state.loadingDetails);
        loadingDetails.delete(key);
        const detailErrors = new Map(state.detailErrors).set(
          key,
          errorMessage(error, "Could not load this GitHub issue."),
        );
        return { loadingDetails, detailErrors };
      });
    }
  },

  changeStatus: async (projectId, issueNumber, status) => {
    const mutationKey = `status:${projectId}:${issueNumber}`;
    if (get().mutations.has(mutationKey)) return;
    const detailRequestKey = invalidateIssueReads(projectId, issueNumber);

    const previousSnapshot = get().snapshots.get(projectId);
    const previousIssue = previousSnapshot?.issues.find(
      (candidate) => candidate.number === issueNumber,
    );
    set((state) => {
      const mutations = new Set(state.mutations).add(mutationKey);
      const loadingProjects = new Set(state.loadingProjects);
      loadingProjects.delete(projectId);
      const loadingDetails = new Set(state.loadingDetails);
      loadingDetails.delete(detailRequestKey);
      const mutationErrors = new Map(state.mutationErrors);
      mutationErrors.delete(mutationKey);
      const snapshots = new Map(state.snapshots);
      if (previousSnapshot && previousIssue) {
        snapshots.set(
          projectId,
          replaceIssue(previousSnapshot, { ...previousIssue, status })!,
        );
      }
      return { mutations, mutationErrors, snapshots, loadingProjects, loadingDetails };
    });

    try {
      const issue = await updateGitHubIssueStatus(projectId, issueNumber, status);
      set((state) => {
        const mutations = new Set(state.mutations);
        mutations.delete(mutationKey);
        const snapshots = new Map(state.snapshots);
        const nextSnapshot = replaceIssue(snapshots.get(projectId), issue);
        if (nextSnapshot) snapshots.set(projectId, nextSnapshot);
        const details = new Map(state.details);
        const key = detailKey(projectId, issueNumber);
        const nextDetail = mergeIssueDetail(details.get(key), issue);
        if (nextDetail) details.set(key, nextDetail);
        return { mutations, snapshots, details };
      });
    } catch (error) {
      set((state) => {
        const mutations = new Set(state.mutations);
        mutations.delete(mutationKey);
        const snapshots = new Map(state.snapshots);
        if (previousSnapshot) snapshots.set(projectId, previousSnapshot);
        const mutationErrors = new Map(state.mutationErrors).set(
          mutationKey,
          errorMessage(error, "Could not change the issue status."),
        );
        return { mutations, snapshots, mutationErrors };
      });
      await Promise.all([
        get().loadIssues(projectId),
        get().details.has(detailKey(projectId, issueNumber))
          ? get().loadIssue(projectId, issueNumber)
          : Promise.resolve(),
      ]);
      throw error;
    }
  },

  saveIssue: async (projectId, issueNumber, updates) => {
    const mutationKey = `edit:${projectId}:${issueNumber}`;
    if (get().mutations.has(mutationKey)) {
      throw new Error("This issue is already being saved.");
    }
    const detailRequestKey = invalidateIssueReads(projectId, issueNumber);
    set((state) => {
      const mutations = new Set(state.mutations).add(mutationKey);
      const loadingProjects = new Set(state.loadingProjects);
      loadingProjects.delete(projectId);
      const loadingDetails = new Set(state.loadingDetails);
      loadingDetails.delete(detailRequestKey);
      const mutationErrors = new Map(state.mutationErrors);
      mutationErrors.delete(mutationKey);
      return { mutations, mutationErrors, loadingProjects, loadingDetails };
    });
    try {
      const issue = await updateGitHubIssue(projectId, issueNumber, updates);
      set((state) => {
        const mutations = new Set(state.mutations);
        mutations.delete(mutationKey);
        const snapshots = new Map(state.snapshots);
        const nextSnapshot = replaceIssue(snapshots.get(projectId), issue);
        if (nextSnapshot) snapshots.set(projectId, nextSnapshot);
        const details = new Map(state.details);
        const key = detailKey(projectId, issueNumber);
        const nextDetail = mergeIssueDetail(details.get(key), issue);
        if (nextDetail) details.set(key, nextDetail);
        return { mutations, snapshots, details };
      });
      return issue;
    } catch (error) {
      set((state) => {
        const mutations = new Set(state.mutations);
        mutations.delete(mutationKey);
        const mutationErrors = new Map(state.mutationErrors).set(
          mutationKey,
          errorMessage(error, "Could not save the issue."),
        );
        return { mutations, mutationErrors };
      });
      throw error;
    }
  },

  closeIssue: async (projectId, issueNumber) => {
    const mutationKey = `close:${projectId}:${issueNumber}`;
    if (get().mutations.has(mutationKey)) return;
    const detailRequestKey = invalidateIssueReads(projectId, issueNumber);
    set((state) => {
      const mutationErrors = new Map(state.mutationErrors);
      mutationErrors.delete(mutationKey);
      const loadingProjects = new Set(state.loadingProjects);
      loadingProjects.delete(projectId);
      const loadingDetails = new Set(state.loadingDetails);
      loadingDetails.delete(detailRequestKey);
      return {
        mutations: new Set(state.mutations).add(mutationKey),
        mutationErrors,
        loadingProjects,
        loadingDetails,
      };
    });
    try {
      const issue = await closeGitHubIssue(projectId, issueNumber);
      set((state) => {
        const mutations = new Set(state.mutations);
        mutations.delete(mutationKey);
        const snapshots = new Map(state.snapshots);
        const nextSnapshot = replaceIssue(snapshots.get(projectId), issue);
        if (nextSnapshot) snapshots.set(projectId, nextSnapshot);
        const details = new Map(state.details);
        details.delete(detailKey(projectId, issueNumber));
        return { mutations, snapshots, details };
      });
    } catch (error) {
      set((state) => {
        const mutations = new Set(state.mutations);
        mutations.delete(mutationKey);
        const mutationErrors = new Map(state.mutationErrors).set(
          mutationKey,
          errorMessage(error, "Could not close the issue."),
        );
        return { mutations, mutationErrors };
      });
      throw error;
    }
  },

  addComment: async (projectId, issueNumber, body) => {
    const mutationKey = `comment-add:${projectId}:${issueNumber}`;
    if (get().mutations.has(mutationKey)) {
      throw new Error("A comment is already being posted.");
    }
    const detailRequestKey = invalidateIssueReads(projectId, issueNumber);
    set((state) => {
      const mutationErrors = new Map(state.mutationErrors);
      mutationErrors.delete(mutationKey);
      const loadingProjects = new Set(state.loadingProjects);
      loadingProjects.delete(projectId);
      const loadingDetails = new Set(state.loadingDetails);
      loadingDetails.delete(detailRequestKey);
      return {
        mutations: new Set(state.mutations).add(mutationKey),
        mutationErrors,
        loadingProjects,
        loadingDetails,
      };
    });
    try {
      const comment = await addGitHubIssueComment(projectId, issueNumber, body);
      set((state) => {
        const mutations = new Set(state.mutations);
        mutations.delete(mutationKey);
        const details = new Map(state.details);
        const key = detailKey(projectId, issueNumber);
        const detail = details.get(key);
        if (detail) {
          details.set(key, {
            ...detail,
            commentsCount: detail.commentsCount + 1,
            comments: [...detail.comments, comment],
          });
        }
        const snapshots = new Map(state.snapshots);
        const snapshot = snapshots.get(projectId);
        const listIssue = snapshot?.issues.find(
          (candidate) => candidate.number === issueNumber,
        );
        if (snapshot && listIssue) {
          snapshots.set(
            projectId,
            replaceIssue(snapshot, {
              ...listIssue,
              commentsCount: listIssue.commentsCount + 1,
            })!,
          );
        }
        return { mutations, details, snapshots };
      });
      return comment;
    } catch (error) {
      set((state) => {
        const mutations = new Set(state.mutations);
        mutations.delete(mutationKey);
        const mutationErrors = new Map(state.mutationErrors).set(
          mutationKey,
          errorMessage(error, "Could not add the comment."),
        );
        return { mutations, mutationErrors };
      });
      throw error;
    }
  },

  editComment: async (projectId, issueNumber, commentId, body) => {
    const mutationKey = `comment-edit:${projectId}:${commentId}`;
    if (get().mutations.has(mutationKey)) {
      throw new Error("This comment is already being saved.");
    }
    const detailRequestKey = invalidateIssueReads(projectId, issueNumber);
    set((state) => {
      const mutationErrors = new Map(state.mutationErrors);
      mutationErrors.delete(mutationKey);
      const loadingProjects = new Set(state.loadingProjects);
      loadingProjects.delete(projectId);
      const loadingDetails = new Set(state.loadingDetails);
      loadingDetails.delete(detailRequestKey);
      return {
        mutations: new Set(state.mutations).add(mutationKey),
        mutationErrors,
        loadingProjects,
        loadingDetails,
      };
    });
    try {
      const comment = await updateGitHubIssueComment(
        projectId,
        issueNumber,
        commentId,
        body,
      );
      set((state) => {
        const mutations = new Set(state.mutations);
        mutations.delete(mutationKey);
        const details = new Map(state.details);
        const key = detailKey(projectId, issueNumber);
        const detail = details.get(key);
        if (detail) {
          details.set(key, {
            ...detail,
            comments: detail.comments.map((candidate) =>
              candidate.id === comment.id ? comment : candidate,
            ),
          });
        }
        return { mutations, details };
      });
      return comment;
    } catch (error) {
      set((state) => {
        const mutations = new Set(state.mutations);
        mutations.delete(mutationKey);
        const mutationErrors = new Map(state.mutationErrors).set(
          mutationKey,
          errorMessage(error, "Could not save the comment."),
        );
        return { mutations, mutationErrors };
      });
      throw error;
    }
  },

  clearMutationError: (key) =>
    set((state) => {
      const mutationErrors = new Map(state.mutationErrors);
      mutationErrors.delete(key);
      return { mutationErrors };
    }),

  clearProject: (projectId) =>
    set((state) => {
      activeProjectRequests.set(
        projectId,
        (activeProjectRequests.get(projectId) ?? 0) + 1,
      );
      for (const key of activeIssueRequests.keys()) {
        if (key.startsWith(`${projectId}:`)) {
          activeIssueRequests.set(key, (activeIssueRequests.get(key) ?? 0) + 1);
        }
      }
      const snapshots = new Map(state.snapshots);
      snapshots.delete(projectId);
      const details = new Map(
        Array.from(state.details).filter(([key]) => !key.startsWith(`${projectId}:`)),
      );
      const loadingProjects = new Set(state.loadingProjects);
      loadingProjects.delete(projectId);
      const loadingDetails = new Set(
        Array.from(state.loadingDetails).filter(
          (key) => !key.startsWith(`${projectId}:`),
        ),
      );
      const projectErrors = new Map(state.projectErrors);
      projectErrors.delete(projectId);
      const detailErrors = new Map(
        Array.from(state.detailErrors).filter(
          ([key]) => !key.startsWith(`${projectId}:`),
        ),
      );
      const mutations = new Set(
        Array.from(state.mutations).filter(
          (key) => !key.includes(`:${projectId}:`),
        ),
      );
      const mutationErrors = new Map(
        Array.from(state.mutationErrors).filter(
          ([key]) => !key.includes(`:${projectId}:`),
        ),
      );
      return {
        snapshots,
        details,
        loadingProjects,
        loadingDetails,
        projectErrors,
        detailErrors,
        mutations,
        mutationErrors,
      };
    }),
}));

export { detailKey as githubIssueDetailKey };
