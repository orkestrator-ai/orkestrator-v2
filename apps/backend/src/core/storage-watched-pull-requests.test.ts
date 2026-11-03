import { expect, test } from "bun:test";

import {
  MAX_WATCHED_PULL_REQUESTS_PER_PROJECT,
  WATCHED_PULL_REQUEST_SETTLED_TTL_MS,
} from "./storage-watched-pull-requests.js";
import { withTemporaryStorage } from "./storage-test-support.js";

const entry = (number: number) => ({
  key: `acme/app#${number}`,
  owner: "acme",
  repo: "app",
  number,
  source: "rendered" as const,
});

test("watches are per project, bounded, settle, and go with the project", async () => {
  await withTemporaryStorage(async (storage) => {
    const project = await storage.addProject({
      id: "project-a",
      name: "A",
      gitUrl: "https://github.com/acme/app.git",
      localPath: null,
      addedAt: new Date(0).toISOString(),
      order: 0,
    });
    const watched = storage.watchedPullRequests;
    let now = Date.parse("2026-11-03T10:00:00.000Z");
    const at = () => new Date(now);

    expect(watched.watchPullRequest(project.id, entry(1), at(), 60_000)).toEqual({
      watched: true,
      added: true,
    });
    expect(watched.listWatchedPullRequests("project-b")).toEqual([]);
    const incarnation = watched.listWatchedPullRequests(project.id)[0]!.incarnationId;
    expect(incarnation).toBeString();

    // Seen again inside the touch window: no write; after it, lastSeenAt moves.
    now += 1_000;
    watched.watchPullRequest(project.id, entry(1), at(), 60_000);
    expect(watched.listWatchedPullRequests(project.id)[0]?.lastSeenAt).toBe(
      "2026-11-03T10:00:00.000Z",
    );
    now += 60_000;
    watched.watchPullRequest(project.id, entry(1), at(), 60_000);
    expect(watched.listWatchedPullRequests(project.id)[0]?.lastSeenAt).toBe(
      new Date(now).toISOString(),
    );

    expect(watched.listWatchedPullRequests(project.id)[0]!.incarnationId).toBe(incarnation);

    // The least recently seen goes once the bound is reached.
    for (let number = 2; number <= MAX_WATCHED_PULL_REQUESTS_PER_PROJECT + 1; number += 1) {
      now += 1_000;
      watched.watchPullRequest(project.id, entry(number), at(), 60_000);
    }
    const keys = watched.listWatchedPullRequests(project.id).map((item) => item.key);
    expect(keys).toHaveLength(MAX_WATCHED_PULL_REQUESTS_PER_PROJECT);
    expect(keys).not.toContain("acme/app#1");

    // Settling removes it and refuses it as a new watch for a while.
    expect(
      watched.updateWatchedPullRequest(project.id, "acme/app#2", at(), () => ({ kind: "settle" })),
    ).toBe(true);
    expect(
      watched.updateWatchedPullRequest(project.id, "acme/app#2", at(), () => ({ kind: "settle" })),
    ).toBe(false);
    expect(watched.watchPullRequest(project.id, entry(2), at(), 60_000)).toEqual({
      watched: false,
      reason: "settled",
    });
    now += WATCHED_PULL_REQUEST_SETTLED_TTL_MS;
    expect(watched.watchPullRequest(project.id, entry(2), at(), 60_000)).toEqual({
      watched: true,
      added: true,
    });

    watched.watchPullRequest(project.id, entry(1), at(), 60_000);
    expect(
      watched.listWatchedPullRequests(project.id).find((item) => item.key === "acme/app#1")!
        .incarnationId,
    ).not.toBe(incarnation);

    await storage.removeProject(project.id);
    expect(watched.listWatchedPullRequests(project.id)).toEqual([]);
  });
});
