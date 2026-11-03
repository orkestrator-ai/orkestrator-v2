import { describe, expect, test } from "bun:test";
import { AgentMailError, type AgentMailNotice } from "@orkestrator/protocol/agent-mail";
import type { GitHubPullRequestRef } from "@orkestrator/protocol/github-pull-requests";
import {
  CoordinatorPullRequestWatches,
  describeWatchedPullRequestChanges,
  WATCHED_PR_MAX_READS_PER_SWEEP,
  WATCHED_PR_MISSING_GIVE_UP_MS,
  WATCHED_PR_POLL_INTERVAL_MS,
  watchedPullRequestReading,
} from "./coordinator-pr-watches.js";
import { GitHubApiError } from "./github.js";
import type { GitHubPullRequestStatus } from "./github-pull-requests.js";
import type { StorageService } from "./storage.js";
import { withTemporaryStorage } from "./storage-test-support.js";

const PROJECT_ID = "project-a";

function status(overrides: Partial<GitHubPullRequestStatus> = {}): GitHubPullRequestStatus {
  return {
    title: "Add the watch",
    htmlUrl: "https://github.com/acme/app/pull/7",
    state: "open",
    isDraft: false,
    checksState: "pending",
    mergeability: "blocked",
    reviewDecision: "none",
    ...overrides,
  };
}

interface SentMail {
  requestId: string;
  toEnvironmentId: string;
  toTabId: string;
  subject?: string;
  body: string;
  notice?: AgentMailNotice;
  statusBudgetKey?: string;
}

interface Harness {
  storage: StorageService;
  watches: CoordinatorPullRequestWatches;
  sent: SentMail[];
  reads: GitHubPullRequestRef[];
  setStatus(number: number, next: GitHubPullRequestStatus | Error): void;
  advance(ms: number): void;
  setMode(mode: "off" | "settled" | "stages"): Promise<void>;
  setToken(token: string | undefined): void;
  setCoordinator(present: boolean): void;
  setDeliveryError(error?: Error): void;
  setFollowed(followed: boolean): void;
  /** What the deletion probe answers after a 404 or 410; false (ambiguous) by default. */
  setDeleted(deleted: boolean): void;
  deletionProbes: GitHubPullRequestRef[];
}

async function withHarness(run: (harness: Harness) => Promise<void>): Promise<void> {
  await withTemporaryStorage(async (storage) => {
    await storage.addProject({
      id: PROJECT_ID,
      name: "A",
      gitUrl: "git@github.com:Acme/App.git",
      localPath: null,
      addedAt: new Date(0).toISOString(),
      order: 0,
    });
    let now = Date.parse("2026-11-03T10:00:00.000Z");
    let token: string | undefined = "token";
    let coordinator = true;
    let deliveryError: Error | undefined;
    let followed = false;
    let deleted = false;
    const deletionProbes: GitHubPullRequestRef[] = [];
    const statuses = new Map<number, GitHubPullRequestStatus | Error>();
    const sent: SentMail[] = [];
    const reads: GitHubPullRequestRef[] = [];
    const workspace = {
      id: "coord-1",
      conversations: [
        {
          id: "conv-main",
          tabId: "tab-main",
          role: "main",
          logicalSessionKey: "k",
          title: "Coordinator",
          createdAt: new Date(0).toISOString(),
          mailboxIncarnationId: "inc",
        },
      ],
    };
    const facade = {
      watchedPullRequests: storage.watchedPullRequests,
      getProject: (id: string) => storage.getProject(id),
      loadProjects: () => storage.loadProjects(),
      loadConfig: () => storage.loadConfig(),
      sendAgentMail: async (
        _sender: unknown,
        input: Omit<SentMail, "notice" | "statusBudgetKey">,
        options: { notice?: AgentMailNotice; statusBudgetKey?: string },
      ) => {
        if (deliveryError) throw deliveryError;
        sent.push({ ...input, notice: options.notice, statusBudgetKey: options.statusBudgetKey });
        return {} as never;
      },
      coordinators: {
        listCoordinatorWorkflowAssociations: async () =>
          followed
            ? [
                {
                  kind: "pull-request",
                  pullRequest: { prUrl: "https://github.com/acme/app/pull/7" },
                },
              ]
            : [],
        getCoordinatorWorkspace: async () => (coordinator ? (workspace as never) : null),
      },
    } as unknown as ConstructorParameters<typeof CoordinatorPullRequestWatches>[0]["storage"];
    const watches = new CoordinatorPullRequestWatches({
      storage: facade,
      now: () => now,
      token: async () => token,
      readStatus: async (_token, ref) => {
        reads.push(ref);
        const next = statuses.get(ref.number) ?? status();
        if (next instanceof Error) throw next;
        return next;
      },
      confirmDeleted: async (_token, ref) => {
        deletionProbes.push(ref);
        return deleted;
      },
    });
    await run({
      storage,
      watches,
      sent,
      reads,
      setStatus: (number, next) => statuses.set(number, next),
      advance: (ms) => {
        now += ms;
      },
      setMode: async (mode) => {
        const config = await storage.loadConfig();
        await storage.updateGlobalConfig({
          ...config.global,
          agentMessaging: { ...config.global.agentMessaging!, coordinatorStatusWakes: mode },
        });
      },
      setToken: (next) => {
        token = next;
      },
      setDeliveryError: (error) => {
        deliveryError = error;
      },
      setFollowed: (value) => {
        followed = value;
      },
      setDeleted: (value) => {
        deleted = value;
      },
      deletionProbes,
      setCoordinator: (present) => {
        coordinator = present;
      },
    });
  });
}

const ref = (number: number): GitHubPullRequestRef => ({ owner: "acme", repo: "app", number });

describe("watching a pull request", () => {
  test("watches only the project's own repository, once it has a coordinator", async () => {
    await withHarness(async ({ watches, storage, setCoordinator }) => {
      expect(await watches.watch(PROJECT_ID, { ...ref(1), repo: "other" }, "rendered")).toEqual({
        watched: false,
        reason: "other-repository",
      });
      setCoordinator(false);
      expect(await watches.watch(PROJECT_ID, ref(1), "rendered")).toEqual({
        watched: false,
        reason: "no-coordinator",
      });
      setCoordinator(true);
      expect(await watches.watch(PROJECT_ID, ref(1), "opened")).toEqual({
        watched: true,
        added: true,
      });
      // Seen again: still watched, not added twice. Owner and repo match case-insensitively.
      expect(
        await watches.watch(PROJECT_ID, { owner: "ACME", repo: "APP", number: 1 }, "rendered"),
      ).toEqual({ watched: true, added: false });
      const entries = storage.watchedPullRequests.listWatchedPullRequests(PROJECT_ID);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        key: "acme/app#1",
        owner: "Acme",
        repo: "App",
        number: 1,
        source: "opened",
        notices: 0,
      });
      await expect(watches.watch("missing", ref(1), "rendered")).rejects.toThrow(
        "Project not found",
      );
    });
  });

  test("the first reading is the baseline; a later change is one small notice", async () => {
    await withHarness(async ({ watches, sent, setStatus, advance, storage }) => {
      await watches.watch(PROJECT_ID, ref(7), "rendered");
      await watches.sweep();
      expect(sent).toHaveLength(0);
      expect(storage.watchedPullRequests.listWatchedPullRequests(PROJECT_ID)[0]?.reading).toEqual({
        state: "open",
        checks: "pending",
        conflicts: false,
        review: "none",
      });

      setStatus(7, status({ checksState: "failure" }));
      // Not due yet: nothing is read inside the poll interval.
      advance(WATCHED_PR_POLL_INTERVAL_MS - 1_000);
      await watches.sweep();
      expect(sent).toHaveLength(0);

      advance(1_000);
      await watches.sweep();
      expect(sent).toHaveLength(1);
      const mail = sent[0]!;
      expect(mail.toEnvironmentId).toBe("coordinator:coord-1:conv-main");
      expect(mail.toTabId).toBe("tab-main");
      expect(mail.subject).toBe("PR #7 updated: Add the watch");
      expect(mail.body).toContain("checks failing");
      expect(mail.body).toContain("no action is expected");
      expect(mail.notice).toEqual({
        resource: { kind: "watched-pull-request", id: "acme/app#7", label: "Add the watch" },
        state: "pr-checks-failed",
        tone: "failure",
      });

      // The same state again is not news.
      advance(WATCHED_PR_POLL_INTERVAL_MS);
      await watches.sweep();
      expect(sent).toHaveLength(1);

      // A later change gets a new request id.
      setStatus(7, status({ checksState: "success", reviewDecision: "approved" }));
      advance(WATCHED_PR_POLL_INTERVAL_MS);
      await watches.sweep();
      expect(sent).toHaveLength(2);
      expect(sent[1]!.body).toContain("checks passing, approved");
      expect(sent[1]!.notice?.state).toBe("pr-updated");
      expect(sent[1]!.requestId).not.toBe(sent[0]!.requestId);
      expect(storage.watchedPullRequests.listWatchedPullRequests(PROJECT_ID)[0]?.notices).toBe(2);
    });
  });

  test("a merge is reported once, then the pull request is no longer watched", async () => {
    await withHarness(async ({ watches, sent, setStatus, advance, storage, reads }) => {
      await watches.watch(PROJECT_ID, ref(7), "rendered");
      await watches.sweep();
      setStatus(7, status({ state: "merged", mergeability: "unavailable" }));
      advance(WATCHED_PR_POLL_INTERVAL_MS);
      await watches.sweep();
      expect(sent.map((mail) => mail.notice?.state)).toEqual(["pr-merged"]);
      expect(sent[0]!.notice?.tone).toBe("success");
      expect(storage.watchedPullRequests.listWatchedPullRequests(PROJECT_ID)).toEqual([]);

      // Rendered again: settled, so not re-watched and not read again.
      expect(await watches.watch(PROJECT_ID, ref(7), "rendered")).toEqual({
        watched: false,
        reason: "settled",
      });
      const before = reads.length;
      advance(WATCHED_PR_POLL_INTERVAL_MS);
      await watches.sweep();
      expect(reads.length).toBe(before);
    });
  });

  test("a pull request already settled at its first reading ends silently", async () => {
    await withHarness(async ({ watches, sent, setStatus, storage }) => {
      setStatus(3, status({ state: "closed", mergeability: "unavailable" }));
      await watches.watch(PROJECT_ID, ref(3), "rendered");
      await watches.sweep();
      expect(sent).toEqual([]);
      expect(storage.watchedPullRequests.listWatchedPullRequests(PROJECT_ID)).toEqual([]);
    });
  });

  test("an ambiguous 404 preserves the baseline and recovers after access returns", async () => {
    await withHarness(async ({ watches, sent, setStatus, advance, storage }) => {
      await watches.watch(PROJECT_ID, ref(9), "rendered");
      await watches.sweep();
      setStatus(9, new GitHubApiError("gone", { code: "not-found", status: 404 }));
      advance(WATCHED_PR_POLL_INTERVAL_MS);
      await watches.sweep();
      expect(sent).toEqual([]);
      expect(storage.watchedPullRequests.listWatchedPullRequests(PROJECT_ID)).toHaveLength(1);
      setStatus(9, status({ checksState: "success" }));
      await watches.sweep();
      expect(sent).toEqual([]);
      advance(WATCHED_PR_POLL_INTERVAL_MS);
      await watches.sweep();
      expect(sent[0]?.body).toContain("checks passing");
    });
  });

  test("a deletion GitHub confirms is reported once, then the pull request is no longer watched", async () => {
    await withHarness(async ({ watches, sent, setStatus, setDeleted, advance, storage, reads }) => {
      await watches.watch(PROJECT_ID, ref(9), "rendered");
      await watches.sweep();
      setStatus(9, new GitHubApiError("gone", { code: "not-found", status: 404 }));
      setDeleted(true);
      advance(WATCHED_PR_POLL_INTERVAL_MS);
      await watches.sweep();
      expect(sent).toHaveLength(1);
      expect(sent[0]!.notice).toMatchObject({ state: "pr-gone", tone: "info" });
      expect(sent[0]!.subject).toBe("PR #9 updated: Add the watch");
      expect(sent[0]!.body).toContain("Acme/App: deleted from GitHub.");
      expect(sent[0]!.body).toContain("no action is expected");
      expect(storage.watchedPullRequests.listWatchedPullRequests(PROJECT_ID)).toEqual([]);

      expect(await watches.watch(PROJECT_ID, ref(9), "rendered")).toEqual({
        watched: false,
        reason: "settled",
      });
      const before = reads.length;
      advance(WATCHED_PR_POLL_INTERVAL_MS);
      await watches.sweep();
      expect(reads.length).toBe(before);
    });
  });

  test("a 410 is probed too, and a pull request deleted before its baseline ends silently", async () => {
    await withHarness(async ({ watches, sent, setStatus, setDeleted, storage, deletionProbes }) => {
      setStatus(4, new GitHubApiError("gone", { code: "github", status: 410 }));
      setDeleted(true);
      await watches.watch(PROJECT_ID, ref(4), "rendered");
      await watches.sweep();
      expect(deletionProbes).toEqual([{ owner: "Acme", repo: "App", number: 4 }]);
      expect(sent).toEqual([]);
      expect(storage.watchedPullRequests.listWatchedPullRequests(PROJECT_ID)).toEqual([]);
    });
  });

  test("other read failures never probe for a deletion", async () => {
    await withHarness(async ({ watches, setStatus, setDeleted, storage, deletionProbes }) => {
      setStatus(4, new GitHubApiError("denied", { code: "permission", status: 403 }));
      setDeleted(true);
      await watches.watch(PROJECT_ID, ref(4), "rendered");
      await watches.sweep();
      expect(deletionProbes).toEqual([]);
      expect(storage.watchedPullRequests.listWatchedPullRequests(PROJECT_ID)).toHaveLength(1);
    });
  });

  test("a failed deletion notice keeps the watch and is retried", async () => {
    await withHarness(
      async ({ watches, sent, setStatus, setDeleted, setDeliveryError, advance, storage }) => {
        await watches.watch(PROJECT_ID, ref(9), "rendered");
        await watches.sweep();
        setStatus(9, new GitHubApiError("gone", { code: "not-found", status: 404 }));
        setDeleted(true);
        setDeliveryError(new Error("mail store unavailable"));
        advance(WATCHED_PR_POLL_INTERVAL_MS);
        await watches.sweep();
        expect(storage.watchedPullRequests.listWatchedPullRequests(PROJECT_ID)).toHaveLength(1);
        setDeliveryError();
        advance(WATCHED_PR_POLL_INTERVAL_MS);
        await watches.sweep();
        expect(sent.map((mail) => mail.notice?.state)).toEqual(["pr-gone"]);
        expect(storage.watchedPullRequests.listWatchedPullRequests(PROJECT_ID)).toEqual([]);
      },
    );
  });

  test("an unconfirmed 404 gives up quietly once it outlasts the give-up period", async () => {
    await withHarness(async ({ watches, sent, setStatus, advance, storage }) => {
      await watches.watch(PROJECT_ID, ref(9), "rendered");
      await watches.sweep();
      const notFound = new GitHubApiError("gone", { code: "not-found", status: 404 });
      setStatus(9, notFound);
      advance(WATCHED_PR_POLL_INTERVAL_MS);
      await watches.sweep();
      const [first] = storage.watchedPullRequests.listWatchedPullRequests(PROJECT_ID);
      expect(first?.missingSince).toBeDefined();
      expect(first?.reading?.state).toBe("open");

      // A successful reading in between restarts the period.
      advance(WATCHED_PR_MISSING_GIVE_UP_MS - WATCHED_PR_POLL_INTERVAL_MS);
      setStatus(9, status());
      await watches.sweep();
      expect(
        storage.watchedPullRequests.listWatchedPullRequests(PROJECT_ID)[0]?.missingSince,
      ).toBeUndefined();
      setStatus(9, notFound);
      advance(WATCHED_PR_POLL_INTERVAL_MS);
      await watches.sweep();
      advance(WATCHED_PR_MISSING_GIVE_UP_MS - WATCHED_PR_POLL_INTERVAL_MS);
      await watches.sweep();
      expect(storage.watchedPullRequests.listWatchedPullRequests(PROJECT_ID)).toHaveLength(1);

      advance(WATCHED_PR_POLL_INTERVAL_MS);
      await watches.sweep();
      expect(storage.watchedPullRequests.listWatchedPullRequests(PROJECT_ID)).toEqual([]);
      expect(sent).toEqual([]);
      // An explicit open watches it again.
      expect(await watches.watch(PROJECT_ID, ref(9), "opened")).toEqual({
        watched: true,
        added: true,
      });
    });
  });

  test("explicit opens revalidate closed PRs and resume a reopened watch", async () => {
    await withHarness(async ({ watches, setStatus, advance, sent, storage }) => {
      await watches.watch(PROJECT_ID, ref(7), "rendered");
      await watches.sweep();
      setStatus(7, status({ state: "closed" }));
      advance(WATCHED_PR_POLL_INTERVAL_MS);
      await watches.sweep();
      expect(await watches.watch(PROJECT_ID, ref(7), "rendered")).toMatchObject({
        reason: "settled",
      });
      await watches.watch(PROJECT_ID, ref(7), "opened");
      await watches.sweep();
      expect(storage.watchedPullRequests.listWatchedPullRequests(PROJECT_ID)).toHaveLength(0);
      setStatus(7, status());
      await watches.watch(PROJECT_ID, ref(7), "opened");
      await watches.sweep();
      setStatus(7, status({ checksState: "success" }));
      advance(WATCHED_PR_POLL_INTERVAL_MS);
      await watches.sweep();
      expect(sent).toHaveLength(2);
    });
  });

  test("delivery failure advances due order and retries without losing the change", async () => {
    await withHarness(
      async ({ watches, setStatus, advance, setDeliveryError, reads, sent, storage }) => {
        await watches.watch(PROJECT_ID, ref(7), "rendered");
        await watches.sweep();
        setStatus(7, status({ checksState: "failure" }));
        advance(WATCHED_PR_POLL_INTERVAL_MS);
        setDeliveryError(new AgentMailError("messaging-disabled", "disabled"));
        await watches.sweep();
        const checked =
          storage.watchedPullRequests.listWatchedPullRequests(PROJECT_ID)[0]?.checkedAt;
        expect(checked).toBeDefined();
        await watches.sweep();
        expect(reads).toHaveLength(2);
        setDeliveryError();
        advance(WATCHED_PR_POLL_INTERVAL_MS);
        await watches.sweep();
        expect(sent).toHaveLength(1);
        expect(sent[0]?.body).toContain("checks failing");
      },
    );
  });

  test("generic read failures back off without changing the baseline", async () => {
    await withHarness(async ({ watches, setStatus, reads, storage }) => {
      await watches.watch(PROJECT_ID, ref(7), "rendered");
      setStatus(7, new Error("network unavailable"));
      await watches.sweep();
      expect(
        storage.watchedPullRequests.listWatchedPullRequests(PROJECT_ID)[0]?.checkedAt,
      ).toBeDefined();
      await watches.sweep();
      expect(reads).toHaveLength(1);
    });
  });

  test("missing repository is refused and associated PRs have only their existing follow", async () => {
    await withHarness(async ({ watches, storage, setFollowed, setStatus, advance, sent }) => {
      await storage.addProject({
        id: "no-repo",
        name: "None",
        gitUrl: "",
        localPath: null,
        addedAt: new Date(0).toISOString(),
        order: 1,
      });
      expect(await watches.watch("no-repo", ref(7), "rendered")).toMatchObject({
        reason: "no-repository",
      });
      await watches.watch(PROJECT_ID, ref(7), "rendered");
      await watches.sweep();
      setFollowed(true);
      expect(await watches.watch(PROJECT_ID, ref(7), "opened")).toMatchObject({
        reason: "already-followed",
      });
      setStatus(7, status({ checksState: "failure" }));
      advance(WATCHED_PR_POLL_INTERVAL_MS);
      await watches.sweep();
      expect(sent).toEqual([]);
      expect(storage.watchedPullRequests.listWatchedPullRequests(PROJECT_ID)).toHaveLength(0);
    });
  });

  test.each(["clean", "blocked"] as const)(
    "unknown to %s mergeability is a silent baseline",
    async (mergeability) => {
      await withHarness(async ({ watches, setStatus, advance, sent }) => {
        setStatus(7, status({ mergeability: "unknown" }));
        await watches.watch(PROJECT_ID, ref(7), "rendered");
        await watches.sweep();
        setStatus(7, status({ mergeability }));
        advance(WATCHED_PR_POLL_INTERVAL_MS);
        await watches.sweep();
        expect(sent).toEqual([]);
      });
    },
  );

  test("other read failures keep the watch and stop the sweep on a rate limit", async () => {
    await withHarness(async ({ watches, sent, setStatus, reads, storage }) => {
      await watches.watch(PROJECT_ID, ref(1), "rendered");
      await watches.watch(PROJECT_ID, ref(2), "rendered");
      setStatus(1, new GitHubApiError("slow down", { code: "rate-limit", status: 403 }));
      setStatus(2, new GitHubApiError("slow down", { code: "rate-limit", status: 403 }));
      await watches.sweep();
      expect(reads).toHaveLength(1);
      expect(sent).toEqual([]);
      expect(storage.watchedPullRequests.listWatchedPullRequests(PROJECT_ID)).toHaveLength(2);
    });
  });

  test("disabled messaging records readings without attempting delivery", async () => {
    await withHarness(async ({ watches, storage, setStatus, advance, setDeliveryError }) => {
      const config = await storage.loadConfig();
      await storage.updateGlobalConfig({
        ...config.global,
        agentMessaging: { ...config.global.agentMessaging!, enabled: false },
      });
      setDeliveryError(new Error("must not attempt delivery"));
      await watches.watch(PROJECT_ID, ref(7), "rendered");
      await watches.sweep();
      setStatus(7, status({ checksState: "failure" }));
      advance(WATCHED_PR_POLL_INTERVAL_MS);
      await watches.sweep();
      expect(
        storage.watchedPullRequests.listWatchedPullRequests(PROJECT_ID)[0]?.reading?.checks,
      ).toBe("failing");
    });
  });

  test("with status updates off, changes are recorded without a notice", async () => {
    await withHarness(async ({ watches, sent, setStatus, advance, setMode, storage }) => {
      await setMode("off");
      await watches.watch(PROJECT_ID, ref(7), "rendered");
      await watches.sweep();
      setStatus(7, status({ checksState: "failure" }));
      advance(WATCHED_PR_POLL_INTERVAL_MS);
      await watches.sweep();
      expect(sent).toEqual([]);
      expect(
        storage.watchedPullRequests.listWatchedPullRequests(PROJECT_ID)[0]?.reading?.checks,
      ).toBe("failing");
    });
  });

  test("nothing is read without a GitHub credential, and a sweep reads a bounded number", async () => {
    await withHarness(async ({ watches, reads, setToken }) => {
      for (let number = 1; number <= WATCHED_PR_MAX_READS_PER_SWEEP + 3; number += 1) {
        await watches.watch(PROJECT_ID, ref(number), "rendered");
      }
      setToken(undefined);
      await watches.sweep();
      expect(reads).toEqual([]);
      setToken("token");
      await watches.sweep();
      expect(reads).toHaveLength(WATCHED_PR_MAX_READS_PER_SWEEP);
      // The rest are read next, before anything read just now.
      await watches.sweep();
      expect(reads).toHaveLength(WATCHED_PR_MAX_READS_PER_SWEEP + 3);
    });
  });

  test("with no main coordinator open the change is recorded without a notice", async () => {
    await withHarness(async ({ watches, sent, setStatus, advance, setCoordinator, storage }) => {
      await watches.watch(PROJECT_ID, ref(7), "rendered");
      await watches.sweep();
      setCoordinator(false);
      setStatus(7, status({ checksState: "failure" }));
      advance(WATCHED_PR_POLL_INTERVAL_MS);
      await watches.sweep();
      expect(sent).toEqual([]);
      expect(storage.watchedPullRequests.listWatchedPullRequests(PROJECT_ID)[0]).toMatchObject({
        notices: 0,
        reading: { checks: "failing" },
      });
    });
  });
});

describe("readings", () => {
  test("an unknown mergeability keeps the last known conflict state", () => {
    const previous = { state: "open", checks: "passing", conflicts: true, review: "none" } as const;
    expect(watchedPullRequestReading(status({ mergeability: "unknown" }), previous).conflicts).toBe(
      true,
    );
    expect(watchedPullRequestReading(status({ mergeability: "dirty" })).conflicts).toBe(true);
    expect(watchedPullRequestReading(status({ isDraft: true })).state).toBe("draft");
  });

  test("neutral checks stay distinct and first known conflicts are silent", () => {
    const previous = { state: "open", checks: "passing", conflicts: null, review: "none" } as const;
    const next = watchedPullRequestReading(
      status({ checksState: "neutral", mergeability: "clean" }),
    );
    expect(next.checks).toBe("neutral");
    expect(describeWatchedPullRequestChanges(previous, next)).toEqual([
      "checks neutral or skipped",
    ]);
    expect(describeWatchedPullRequestChanges(previous, { ...previous, conflicts: false })).toEqual(
      [],
    );
  });

  test("changes are described briefly, and a settled pull request only by its outcome", () => {
    const open = { state: "open", checks: "pending", conflicts: false, review: "none" } as const;
    expect(
      describeWatchedPullRequestChanges(open, {
        state: "draft",
        checks: "failing",
        conflicts: true,
        review: "changes-requested",
      }),
    ).toEqual(["converted to draft", "checks failing", "has merge conflicts", "changes requested"]);
    expect(
      describeWatchedPullRequestChanges(open, {
        state: "merged",
        checks: "passing",
        conflicts: null,
        review: "approved",
      }),
    ).toEqual(["merged"]);
    expect(describeWatchedPullRequestChanges(open, open)).toEqual([]);
  });
});
