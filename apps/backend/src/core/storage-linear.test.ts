import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StorageService } from "./storage.js";
import {
  linearBoardLinkKey,
  MAX_LINEAR_ISSUE_CREATES,
  MAX_LINEAR_REVOCATIONS,
  parseLinearBoardLink,
  sameLinearBoard,
} from "./storage-linear.js";

const directories: string[] = [];
const services: StorageService[] = [];

async function storage(): Promise<StorageService> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-linear-storage-"));
  directories.push(dataDir);
  const service = new StorageService(dataDir);
  services.push(service);
  await service.init();
  return service;
}

afterEach(async () => {
  for (const service of services.splice(0)) service.close();
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

const REPO = "repo:github.com/acme/web";

describe("Linear board link keys", () => {
  test("a project with a remote is keyed by its repository, whatever the URL form", () => {
    expect(linearBoardLinkKey({ id: "p1", gitUrl: "https://github.com/Acme/Web.git" })).toBe(REPO);
    expect(linearBoardLinkKey({ id: "p2", gitUrl: "git@github.com:acme/web.git" })).toBe(REPO);
  });

  test("a project without a remote is keyed by its id", () => {
    expect(linearBoardLinkKey({ id: "p1", gitUrl: null })).toBe("project:p1");
  });

  test("boards overlap when the team matches and either side covers the other", () => {
    const team = parseLinearBoardLink({
      key: REPO,
      teamId: "t1",
      updatedAt: "2026-11-11T00:00:00Z",
    })!;
    const project = { ...team, key: "repo:x", linearProjectId: "lp1" };
    const other = { ...team, key: "repo:y", linearProjectId: "lp2" };
    expect(sameLinearBoard(team, project)).toBe(true);
    expect(sameLinearBoard(project, other)).toBe(false);
    expect(sameLinearBoard(team, { ...team, teamId: "t2" })).toBe(false);
  });
});

describe("LinearRepository", () => {
  test("saves, reads and clears a link, leaving a tombstone that syncs", async () => {
    const service = await storage();
    const link = service.linear.saveLinearBoardLink(
      {
        key: REPO,
        repositoryHint: "github.com/acme/web",
        projectId: "p1",
        teamId: "t1",
        teamName: "Eng",
      },
      new Set([REPO]),
    );
    expect(link).toMatchObject({ key: REPO, teamId: "t1", teamName: "Eng" });
    expect(await service.linear.getLinearBoardLink(REPO)).toMatchObject({ teamId: "t1" });

    expect(service.linear.clearLinearBoardLink(REPO)).toBe(true);
    expect(service.linear.clearLinearBoardLink(REPO)).toBe(false);
    expect(await service.linear.getLinearBoardLink(REPO)).toBeNull();
    const [tombstone] = await service.linear.listLinearBoardLinks();
    expect(tombstone).toMatchObject({ key: REPO, cleared: true });
    expect(tombstone?.teamId).toBeUndefined();
  });

  test("refuses a second project of this machine on the same board", async () => {
    const service = await storage();
    const local = new Set([REPO, "repo:github.com/acme/api"]);
    service.linear.saveLinearBoardLink({ key: REPO, teamId: "t1" }, local);
    expect(() =>
      service.linear.saveLinearBoardLink(
        { key: "repo:github.com/acme/api", teamId: "t1" },
        local,
        () => 'project "Web"',
      ),
    ).toThrow('That Linear board is already linked to project "Web"');
    // Another Linear project in the same team is a different board only when both name one.
    service.linear.clearLinearBoardLink(REPO);
    service.linear.saveLinearBoardLink({ key: REPO, teamId: "t1", linearProjectId: "lp1" }, local);
    expect(
      service.linear.saveLinearBoardLink(
        { key: "repo:github.com/acme/api", teamId: "t1", linearProjectId: "lp2" },
        local,
      ),
    ).toMatchObject({ linearProjectId: "lp2" });
  });

  test("a link synced for a repository this machine does not have does not block one", async () => {
    const service = await storage();
    service.linear.mergeLinearBoardLinks([
      { key: "repo:github.com/acme/other", teamId: "t1", updatedAt: "2026-11-11T00:00:00Z" },
    ]);
    expect(
      service.linear.saveLinearBoardLink({ key: REPO, teamId: "t1" }, new Set([REPO])),
    ).toMatchObject({ teamId: "t1" });
  });

  test("merging keeps whichever side changed each link last, and only repository keys", async () => {
    const service = await storage();
    service.linear.saveLinearBoardLink(
      { key: REPO, projectId: "p1", teamId: "t1" },
      new Set([REPO]),
    );
    const [mine] = await service.linear.listLinearBoardLinks();

    expect(
      service.linear.mergeLinearBoardLinks([
        { key: REPO, teamId: "old", updatedAt: "2020-01-01T00:00:00Z" },
        { key: "project:p9", teamId: "t9", updatedAt: "2030-01-01T00:00:00Z" },
        { key: "nonsense", teamId: "t9", updatedAt: "2030-01-01T00:00:00Z" },
      ]),
    ).toBe(0);
    expect(await service.linear.getLinearBoardLink(REPO)).toMatchObject({ teamId: "t1" });

    const later = new Date(Date.parse(mine!.updatedAt) + 1_000).toISOString();
    expect(
      service.linear.mergeLinearBoardLinks([
        { key: REPO, teamId: "t2", projectId: "theirs", updatedAt: later },
      ]),
    ).toBe(1);
    const merged = await service.linear.getLinearBoardLink(REPO);
    expect(merged).toMatchObject({ teamId: "t2", updatedAt: later });
    // A synced link names no project of this machine.
    expect(merged?.projectId).toBeUndefined();

    const cleared = new Date(Date.parse(later) + 1_000).toISOString();
    expect(
      service.linear.mergeLinearBoardLinks([{ key: REPO, cleared: true, updatedAt: cleared }]),
    ).toBe(1);
    expect(await service.linear.getLinearBoardLink(REPO)).toBeNull();
  });

  test("a synced link may not give two of this machine's projects one board: the newer keeps it", async () => {
    const API = "repo:github.com/acme/api";
    const local = new Set([REPO, API]);
    const service = await storage();
    // Linked here first: web → team t1.
    service.linear.saveLinearBoardLink({ key: REPO, projectId: "p1", teamId: "t1" }, local);
    const [mine] = await service.linear.listLinearBoardLinks();

    // Another machine linked api → t1 later: it keeps the board, web is cleared.
    const later = new Date(Date.parse(mine!.updatedAt) + 1_000).toISOString();
    expect(
      service.linear.mergeLinearBoardLinks([{ key: API, teamId: "t1", updatedAt: later }], local),
    ).toBe(2);
    expect(await service.linear.getLinearBoardLink(API)).toMatchObject({ teamId: "t1" });
    expect(await service.linear.getLinearBoardLink(REPO)).toBeNull();
    const webTombstone = (await service.linear.listLinearBoardLinks()).find(
      (link) => link.key === REPO,
    );
    expect(webTombstone).toMatchObject({ cleared: true, supersededBy: API });
    // Stamped after the link it replaced, so the clear wins on every machine.
    expect(Date.parse(webTombstone!.updatedAt)).toBeGreaterThan(Date.parse(mine!.updatedAt));

    // An older link to the same board from elsewhere loses and is cleared instead.
    const older = new Date(Date.parse(later) - 500).toISOString();
    const DOCS = "repo:github.com/acme/docs";
    const withDocs = new Set([...local, DOCS]);
    expect(
      service.linear.mergeLinearBoardLinks(
        [{ key: DOCS, teamId: "t1", updatedAt: older }],
        withDocs,
      ),
    ).toBe(1);
    expect(await service.linear.getLinearBoardLink(DOCS)).toBeNull();
    expect(await service.linear.getLinearBoardLink(API)).toMatchObject({ teamId: "t1" });
    expect(
      (await service.linear.listLinearBoardLinks()).find((link) => link.key === DOCS),
    ).toMatchObject({ cleared: true, supersededBy: API });

    // A tombstone keeps its winner through parsing (it travels with sync).
    expect(
      parseLinearBoardLink({ key: REPO, cleared: true, supersededBy: API, updatedAt: later }),
    ).toMatchObject({ supersededBy: API });
  });

  test("links to one board for repositories this machine does not both have are both kept", async () => {
    const API = "repo:github.com/acme/api";
    const service = await storage();
    const at = new Date().toISOString();
    expect(
      service.linear.mergeLinearBoardLinks(
        [
          { key: REPO, teamId: "t1", updatedAt: at },
          { key: API, teamId: "t1", updatedAt: at },
        ],
        new Set([REPO]),
      ),
    ).toBe(2);
    expect(await service.linear.getLinearBoardLink(REPO)).toMatchObject({ teamId: "t1" });
    expect(await service.linear.getLinearBoardLink(API)).toMatchObject({ teamId: "t1" });
  });

  test("keeps the newest disconnect per key, bounded", async () => {
    const service = await storage();
    const now = Date.now();
    const at = (offset: number) => new Date(now - offset).toISOString();
    expect(
      service.linear.mergeLinearRevocations([
        { keyFingerprint: "aaaaaaaaaaaaaaaa", revokedAt: at(10_000) },
        { keyFingerprint: "aaaaaaaaaaaaaaaa", revokedAt: at(1_000) },
        { keyFingerprint: "not-hex!", revokedAt: at(0) },
        { keyFingerprint: "bbbbbbbbbbbbbbbb", revokedAt: at(400 * 24 * 60 * 60 * 1_000) },
      ]),
    ).toBe(3);
    expect(await service.linear.listLinearRevocations()).toEqual([
      { keyFingerprint: "aaaaaaaaaaaaaaaa", revokedAt: at(1_000) },
    ]);

    service.linear.mergeLinearRevocations(
      Array.from({ length: MAX_LINEAR_REVOCATIONS + 10 }, (_, index) => ({
        keyFingerprint: index.toString(16).padStart(16, "0"),
        revokedAt: at(index),
      })),
    );
    expect((await service.linear.listLinearRevocations()).length).toBe(MAX_LINEAR_REVOCATIONS);
  });

  test("remembers issue creations by request key, bounded", async () => {
    const service = await storage();
    service.linear.recordLinearIssueCreate({ requestKey: "r1", linkKey: REPO, issueId: "i1" });
    expect(await service.linear.findLinearIssueCreate("r1")).toMatchObject({
      requestKey: "r1",
      linkKey: REPO,
      issueId: "i1",
    });
    expect(await service.linear.findLinearIssueCreate("r2")).toBeNull();
    for (let index = 0; index < MAX_LINEAR_ISSUE_CREATES; index += 1) {
      service.linear.recordLinearIssueCreate({
        requestKey: `k${index}`,
        linkKey: REPO,
        issueId: `i${index}`,
      });
    }
    expect(await service.linear.findLinearIssueCreate("r1")).toBeNull();
    expect(
      await service.linear.findLinearIssueCreate(`k${MAX_LINEAR_ISSUE_CREATES - 1}`),
    ).not.toBeNull();
  });
});
