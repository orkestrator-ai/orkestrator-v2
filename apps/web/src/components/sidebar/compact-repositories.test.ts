import { describe, expect, test } from "bun:test";
import type { MachineView } from "@/lib/federation/aggregate";
import type { FederatedEnvironment, FederatedProject } from "@/lib/federation/summaries";
import {
  compactLocalRepositories,
  compactRepositories,
  compactRepositoryStatus,
  remoteMemberFacts,
  type CompactMemberFacts,
} from "./compact-repositories";

const LAYOUT = { projectOrder: [], projectFolders: {}, repositoryOrder: [] };

function machine(
  id: string,
  projects: Array<{ id: string; name: string; hint?: string; icon?: string }>,
  overrides: Partial<MachineView> = {},
): MachineView {
  return {
    connectionId: id,
    backendId: id,
    name: id,
    colorToken: id === "command" ? "violet" : "teal",
    bound: false,
    transport: "connected",
    loadedAt: 1,
    projects: projects.map(
      (project, index) =>
        ({
          key: `${id}:${project.id}`,
          ref: { backendId: id, projectId: project.id },
          name: project.name,
          order: index,
          folder: null,
          ...(project.hint ? { repositoryHint: project.hint } : {}),
          ...(project.icon ? { icon: project.icon } : {}),
        }) as unknown as FederatedProject,
    ),
    environmentsByProject: new Map(),
    ...overrides,
  } as unknown as MachineView;
}

const HINT = "github.com/acme/app";

describe("the list", () => {
  test("a repository on several machines is one entry, opening the command node's copy", () => {
    const repositories = compactRepositories(
      [
        machine("leaf", [{ id: "l", name: "app-leaf", hint: HINT }]),
        machine("command", [{ id: "c", name: "app", hint: HINT }], { bound: true }),
      ],
      LAYOUT,
      "command",
    );
    expect(repositories).toHaveLength(1);
    const [repository] = repositories;
    expect(repository!.name).toBe("acme/app");
    expect(repository!.members.map((member) => member.projectId).sort()).toEqual(["c", "l"]);
    expect(repository!.opens).toMatchObject({ machine: { backendId: "command" } });
  });

  test("a repository takes the command node's colour and icon, as its heading does", () => {
    const [repository] = compactRepositories(
      [
        machine("leaf", [{ id: "l", name: "app", hint: HINT, icon: "leaf-icon" }]),
        machine("command", [{ id: "c", name: "app", hint: HINT, icon: "command-icon" }]),
      ],
      LAYOUT,
      "command",
    );
    expect(repository!.colorToken).toBe("violet");
    expect(repository!.icon).toBe("command-icon");
  });

  test("a repository not on the command node takes the colour of the machine it opens on", () => {
    const [repository] = compactRepositories(
      [
        machine("command", [{ id: "c", name: "other", hint: "github.com/acme/other" }]),
        machine("first", [{ id: "f", name: "app", hint: HINT }], { colorToken: "rose" }),
        machine("second", [{ id: "s", name: "app", hint: HINT }]),
      ],
      LAYOUT,
      "command",
    ).filter((entry) => entry.repository === HINT);
    expect(repository!.opens).toMatchObject({ machine: { backendId: "first" } });
    expect(repository!.colorToken).toBe("rose");
    expect(repository!.icon).toBeUndefined();
  });

  test("a repository not on the command node takes the first icon in machine order", () => {
    const [repository] = compactRepositories(
      [
        machine("command", [{ id: "c", name: "other", hint: "github.com/acme/other" }]),
        machine("first", [{ id: "f", name: "app", hint: HINT }]),
        machine("second", [{ id: "s", name: "app", hint: HINT, icon: "second-icon" }]),
        machine("third", [{ id: "t", name: "app", hint: HINT, icon: "third-icon" }]),
      ],
      LAYOUT,
      "command",
    ).filter((entry) => entry.repository === HINT);
    expect(repository!.opens).toMatchObject({ machine: { backendId: "first" } });
    expect(repository!.icon).toBe("second-icon");
  });

  test("a repository with no icon on the command node shows the house tile", () => {
    const [repository] = compactRepositories(
      [
        machine("leaf", [{ id: "l", name: "app", hint: HINT, icon: "leaf-icon" }]),
        machine("command", [{ id: "c", name: "app", hint: HINT }]),
      ],
      LAYOUT,
      "command",
    );
    expect(repository!.icon).toBeUndefined();
  });

  test("a project that reports no repository is its own entry, under its own machine's colour", () => {
    const repositories = compactRepositories(
      [machine("leaf", [{ id: "l", name: "scratch", icon: "own-icon" }])],
      LAYOUT,
      "command",
    );
    expect(repositories.map((repository) => repository.name)).toEqual(["scratch"]);
    expect(repositories[0]!.repository).toBeUndefined();
    expect(repositories[0]!.colorToken).toBe("teal");
    expect(repositories[0]!.icon).toBe("own-icon");
  });

  test("a machine that is not connected is left out", () => {
    expect(
      compactRepositories(
        [machine("leaf", [{ id: "l", name: "app" }], { transport: "unreachable" })],
        LAYOUT,
        "command",
      ),
    ).toEqual([]);
  });

  test("a window naming no machines lists its own projects", () => {
    const repositories = compactLocalRepositories([
      { id: "one", name: "one", icon: "icon" },
      { id: "two", name: "two" },
    ]);
    expect(repositories.map((repository) => repository.key)).toEqual(["one", "two"]);
    expect(repositories[0]!.icon).toBe("icon");
    expect(repositories[0]!.opens).toEqual({ projectId: "one" });
  });
});

function facts(overrides: Partial<CompactMemberFacts> = {}): CompactMemberFacts {
  return {
    coordinator: null,
    home: null,
    unreadWork: false,
    unreadMail: 0,
    failedMail: false,
    ...overrides,
  };
}

const IDLE_HOME = {
  deleting: false,
  buildActive: false,
  activity: "idle" as const,
  hasUnreadWork: false,
};

describe("an icon's status", () => {
  test("nothing to show", () => {
    expect(compactRepositoryStatus([facts()])).toEqual({ ring: null, badge: null, labels: [] });
    expect(compactRepositoryStatus([])).toEqual({ ring: null, badge: null, labels: [] });
  });

  test("the coordinator's spinner and halo", () => {
    expect(compactRepositoryStatus([facts({ coordinator: "working" })]).ring).toBe("working");
    expect(compactRepositoryStatus([facts({ coordinator: "waiting" })]).ring).toBe("waiting");
  });

  test("the project home's spinner and halo, as its row's", () => {
    expect(
      compactRepositoryStatus([facts({ home: { ...IDLE_HOME, activity: "working" } })]).ring,
    ).toBe("working");
    expect(
      compactRepositoryStatus([facts({ home: { ...IDLE_HOME, buildActive: true } })]).ring,
    ).toBe("working");
    expect(
      compactRepositoryStatus([facts({ home: { ...IDLE_HOME, activity: "waiting" } })]).ring,
    ).toBe("waiting");
  });

  test("a home being deleted shows nothing", () => {
    expect(
      compactRepositoryStatus([
        facts({ home: { ...IDLE_HOME, deleting: true, activity: "working" } }),
      ]),
    ).toEqual({ ring: null, badge: null, labels: [] });
  });

  test("unread mail is a dot, with its count in words", () => {
    const status = compactRepositoryStatus([facts({ unreadMail: 3 })]);
    expect(status.badge).toBe("unread");
    expect(status.labels).toEqual(["3 unread agent messages"]);
    expect(compactRepositoryStatus([facts({ unreadMail: 1 })]).labels).toEqual([
      "1 unread agent message",
    ]);
  });

  test("attention outranks unread mail", () => {
    expect(compactRepositoryStatus([facts({ unreadWork: true, unreadMail: 2 })]).badge).toBe(
      "attention",
    );
    expect(compactRepositoryStatus([facts({ failedMail: true, unreadMail: 2 })]).badge).toBe(
      "attention",
    );
    expect(
      compactRepositoryStatus([facts({ home: { ...IDLE_HOME, hasUnreadWork: true } })]).badge,
    ).toBe("attention");
  });

  test("across machines the spinner wins and the badge carries the wait", () => {
    const status = compactRepositoryStatus([
      facts({ coordinator: "working" }),
      facts({ coordinator: "waiting" }),
    ]);
    expect(status.ring).toBe("working");
    expect(status.badge).toBe("attention");
    expect(status.labels).toEqual(["Working", "Waiting for you"]);
  });

  test("mail adds up across machines", () => {
    expect(
      compactRepositoryStatus([facts({ unreadMail: 1 }), facts({ unreadMail: 2 })]).labels,
    ).toEqual(["3 unread agent messages"]);
  });
});

describe("another machine's facts", () => {
  const environment = (overrides: Partial<FederatedEnvironment>) =>
    ({
      isProjectHome: false,
      deleting: false,
      hasUnreadWork: false,
      activity: "idle",
      ...overrides,
    }) as FederatedEnvironment;

  test("reads its home, unread work and mail from the summaries", () => {
    expect(
      remoteMemberFacts([
        environment({ isProjectHome: true, activity: "working", buildActive: true }),
        environment({ hasUnreadWork: true, agentMailUnread: 2 }),
        environment({ agentMailUnread: 1, agentMailFailed: true }),
      ]),
    ).toEqual({
      working: false,
      waiting: false,
      coordinator: null,
      home: { deleting: false, buildActive: true, activity: "working", hasUnreadWork: false },
      unreadWork: true,
      unreadMail: 3,
      failedMail: true,
    });
  });

  test("ignores an environment being deleted", () => {
    expect(
      remoteMemberFacts([
        environment({ isProjectHome: true, deleting: true, activity: "working" }),
        environment({ deleting: true, hasUnreadWork: true }),
      ]),
    ).toEqual({
      working: false,
      waiting: false,
      coordinator: null,
      home: null,
      unreadWork: false,
      unreadMail: 0,
      failedMail: false,
    });
  });
});

for (const activity of ["working", "waiting"] as const) {
  test("remote ordinary environment " + activity + " contributes unless deleting", () => {
    const environment = { isProjectHome: false, deleting: false, activity } as FederatedEnvironment;
    expect(compactRepositoryStatus([remoteMemberFacts([environment])]).ring).toBe(activity);
    expect(
      compactRepositoryStatus([remoteMemberFacts([{ ...environment, deleting: true }])]).ring,
    ).toBeNull();
  });
}
