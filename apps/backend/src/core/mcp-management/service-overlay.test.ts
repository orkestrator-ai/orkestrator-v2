import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  mcpManagementErrorFromUnknown,
  type McpManagementSnapshot,
  type McpOverlayAction,
} from "@orkestrator/protocol/mcp-management";

import { environmentStateDirectory } from "../environment-state-paths.js";
import { OVERLAY_DIVERGED_REASON, OVERLAY_UNREADABLE_REASON } from "./overlay-service.js";
import {
  SENTINEL,
  createFixture,
  entry,
  mutation,
  revision,
  targetIdFor,
  type Fixture,
} from "./test-support.js";

let fixture: Fixture;

const CODEX = "/home/node/.codex/config.toml";
const CLAUDE = "/home/node/.claude.json";

/** What the entrypoint copies into the container on every boot. */
const INHERITED_CODEX = `model = "gpt"\n\n[mcp_servers.inherited]\ncommand = "inherited"\n\n[mcp_servers.other]\ncommand = "other"\n`;

beforeEach(() => {
  fixture = createFixture({ environmentType: "containerized" });
  fixture.environment.containerId = "container-1";
  fixture.containerFiles.set(CODEX, INHERITED_CODEX);
});

afterEach(() => {
  fixture.cleanup();
});

async function snapshotOf(provider: AgentPlatform = "codex") {
  const targetId = await targetIdFor(fixture, provider, "environment");
  return { targetId, snapshot: await fixture.service.snapshot({ targetId }) };
}

function source(snapshot: McpManagementSnapshot, sourceId = "codex:user") {
  return snapshot.sources.find((candidate) => candidate.sourceId === sourceId)!;
}

async function addCodex(name: string, command = name) {
  const { targetId, snapshot } = await snapshotOf();
  return fixture.service.mutate(
    mutation(targetId, {
      kind: "add",
      sourceId: "codex:user",
      expectedRevision: revision(snapshot, "codex:user"),
      definition: { name, transport: "stdio", command },
    }),
  );
}

async function removeCodex(name: string) {
  const { targetId, snapshot } = await snapshotOf();
  return fixture.service.mutate(
    mutation(targetId, {
      kind: "remove",
      entryId: entry(snapshot, "codex:user", name).entryId,
      expectedRevision: revision(snapshot, "codex:user")!,
    }),
  );
}

/** A container start: the entrypoint re-copies `inherited`, then the backend materialises. */
async function restart(inherited = INHERITED_CODEX, boot = `boot-${Math.random()}`) {
  fixture.containerFiles.set(CODEX, inherited);
  fixture.containerBoot.value = boot;
  return fixture.service.materialiseEnvironment("env-1");
}

function codexServers(): Record<string, unknown> {
  return (Bun.TOML.parse(fixture.containerFiles.get(CODEX)!) as { mcp_servers?: object })
    .mcp_servers as Record<string, unknown>;
}

async function resolve(action: McpOverlayAction) {
  const { targetId, snapshot } = await snapshotOf();
  return fixture.service.resolveOverlay({
    resolution: {
      targetId,
      sourceId: "codex:user",
      expectedRevision: revision(snapshot, "codex:user"),
      action,
    },
  });
}

describe("environment-private saves", () => {
  test("a save writes the container's copy privately and leaves the host file byte-for-byte alone", async () => {
    const host = fixture.write("home/.codex/config.toml", `[mcp_servers.host]\ncommand = "h"\n`);
    const before = statSync(host).mtimeMs;
    const result = await addCodex("mine");
    expect(result.operation.phase).toBe("saved");
    expect(codexServers()).toEqual({
      inherited: { command: "inherited" },
      other: { command: "other" },
      mine: { command: "mine" },
    });
    // Other settings in the container's copy are kept.
    expect(fixture.containerFiles.get(CODEX)).toContain(`model = "gpt"`);
    expect(fixture.containerWrites).toEqual([{ path: CODEX, mode: "private" }]);
    expect(fixture.read("home/.codex/config.toml")).toBe(`[mcp_servers.host]\ncommand = "h"\n`);
    expect(statSync(host).mtimeMs).toBe(before);
    const { snapshot } = await snapshotOf();
    expect(source(snapshot).overlay).toMatchObject({ state: "in-sync", added: ["mine"] });
  });

  test("the record is private, keyed by environment, and survives a backend restart", async () => {
    await addCodex("mine");
    const directory = environmentStateDirectory(
      fixture.dataDir,
      "mcp-environment-overlays",
      "env-1",
    );
    const [file] = readdirSync(directory);
    expect(statSync(path.join(directory, file!)).mode & 0o777).toBe(0o600);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    fixture.service.dispose();
    fixture.service = fixture.newService();
    const { snapshot } = await snapshotOf();
    expect(source(snapshot).overlay?.added).toEqual(["mine"]);
  });

  test("stop and start, or a rebuild, reapplies additions and keeps removed servers removed", async () => {
    await addCodex("mine");
    await removeCodex("other");
    expect(Object.keys(codexServers()).sort()).toEqual(["inherited", "mine"]);
    expect(await restart()).toBe(1);
    expect(Object.keys(codexServers()).sort()).toEqual(["inherited", "mine"]);
    // A rebuild is a fresh container with the same inherited copy and a new boot.
    expect(await restart(INHERITED_CODEX, "rebuild-boot")).toBe(1);
    expect(Object.keys(codexServers()).sort()).toEqual(["inherited", "mine"]);
    const { snapshot } = await snapshotOf();
    expect(source(snapshot).overlay).toMatchObject({
      state: "in-sync",
      added: ["mine"],
      removed: ["other"],
    });
    // The same boot is never written twice.
    expect(await fixture.service.materialiseEnvironment("env-1")).toBe(0);
  });

  test("a restart outside the start path is pending, and the next save writes the overlay first", async () => {
    await addCodex("mine");
    fixture.containerFiles.set(CODEX, INHERITED_CODEX);
    fixture.containerBoot.value = "docker-restarted";
    const { snapshot } = await snapshotOf();
    expect(source(snapshot).overlay?.state).toBe("pending");
    expect(source(snapshot).writable).toBe(true);
    // The overlay is written back first, so a draft of the bare copy is stale.
    const stale = await addCodex("second").catch((failure: unknown) => failure);
    expect(mcpManagementErrorFromUnknown(stale)?.code).toBe("revision-conflict");
    expect(Object.keys(codexServers()).sort()).toEqual(["inherited", "mine", "other"]);
    await addCodex("second");
    expect(Object.keys(codexServers()).sort()).toEqual(["inherited", "mine", "other", "second"]);
  });

  test("a changed inherited server under a change is a conflict, held until the user decides", async () => {
    const { targetId, snapshot } = await snapshotOf();
    await fixture.service.mutate(
      mutation(targetId, {
        kind: "update",
        entryId: entry(snapshot, "codex:user", "inherited").entryId,
        expectedRevision: revision(snapshot, "codex:user")!,
        patch: { command: { kind: "set", value: "mine" } },
      }),
    );
    const changed = INHERITED_CODEX.replace(`command = "inherited"`, `command = "upstream"`);
    await restart(changed);
    // The container gets the inherited value; nothing failed.
    expect(codexServers().inherited).toEqual({ command: "upstream" });
    let after = (await snapshotOf()).snapshot;
    expect(source(after).overlay).toMatchObject({
      state: "conflict",
      replaced: ["inherited"],
      conflicts: [{ name: "inherited", reason: expect.stringContaining("changed after") }],
    });
    await resolve({ kind: "keep-environment", name: "inherited" });
    expect(codexServers().inherited).toEqual({ command: "mine" });
    after = (await snapshotOf()).snapshot;
    expect(source(after).overlay?.state).toBe("in-sync");
    // Re-anchored: the next restart with the same upstream value keeps the user's.
    await restart(changed);
    expect(codexServers().inherited).toEqual({ command: "mine" });
  });

  test("take-inherited drops the environment's change for that name", async () => {
    await removeCodex("other");
    await restart(INHERITED_CODEX.replace(`command = "other"`, `command = "other2"`));
    expect(codexServers().other).toEqual({ command: "other2" });
    await resolve({ kind: "take-inherited", name: "other" });
    const { snapshot } = await snapshotOf();
    expect(source(snapshot).overlay).toMatchObject({ state: "in-sync", removed: [] });
    await restart(INHERITED_CODEX.replace(`command = "other"`, `command = "other2"`));
    expect(codexServers().other).toEqual({ command: "other2" });
  });
});

describe("in-container edits", () => {
  async function editInside() {
    await addCodex("mine");
    fixture.containerFiles.set(
      CODEX,
      fixture.containerFiles.get(CODEX)!.replace(`command = "mine"`, `command = "edited"`),
    );
  }

  test("a diverged file blocks edits and never gets silently overwritten", async () => {
    await editInside();
    const { targetId, snapshot } = await snapshotOf();
    const home = source(snapshot);
    expect(home.overlay).toMatchObject({ state: "diverged", divergedNames: ["mine"] });
    expect(home.writable).toBe(false);
    expect(home.readOnlyReason).toBe(OVERLAY_DIVERGED_REASON);
    expect(entry(snapshot, "codex:user", "inherited").actions.edit.supported).toBe(false);
    const error = await fixture.service
      .mutate(
        mutation(targetId, {
          kind: "add",
          sourceId: "codex:user",
          expectedRevision: home.revision,
          definition: { name: "blocked", transport: "stdio", command: "b" },
        }),
      )
      .catch((failure: unknown) => failure);
    expect(mcpManagementErrorFromUnknown(error)?.code).toBe("environment-diverged");
    // A boot of the same id never overwrites it either.
    expect(await fixture.service.materialiseEnvironment("env-1")).toBe(0);
    expect(codexServers().mine).toEqual({ command: "edited" });
  });

  test("import adopts the in-container edit, and the next restart keeps it", async () => {
    await editInside();
    await resolve({ kind: "import" });
    expect((await snapshotOf()).snapshot.sources[0]!.overlay).toMatchObject({ state: "in-sync" });
    await restart();
    expect(codexServers().mine).toEqual({ command: "edited" });
  });

  test("reapply restores this environment's version", async () => {
    await editInside();
    await resolve({ kind: "reapply" });
    expect(codexServers().mine).toEqual({ command: "mine" });
    expect(source((await snapshotOf()).snapshot).overlay?.state).toBe("in-sync");
  });

  test("a stale revision refuses a resolution", async () => {
    await editInside();
    const { targetId } = await snapshotOf();
    const error = await fixture.service
      .resolveOverlay({
        resolution: {
          targetId,
          sourceId: "codex:user",
          expectedRevision: "r1.stale",
          action: { kind: "reapply" },
        },
      })
      .catch((failure: unknown) => failure);
    expect(mcpManagementErrorFromUnknown(error)?.code).toBe("revision-conflict");
  });

  test("reset drops every change, restores the inherited servers and removes the record", async () => {
    await addCodex("mine");
    await removeCodex("other");
    await resolve({ kind: "reset" });
    expect(Object.keys(codexServers()).sort()).toEqual(["inherited", "other"]);
    expect(source((await snapshotOf()).snapshot).overlay).toBeUndefined();
    const directory = environmentStateDirectory(
      fixture.dataDir,
      "mcp-environment-overlays",
      "env-1",
    );
    expect(readdirSync(directory)).toEqual([]);
  });

  test("an unreadable record refuses edits instead of starting over", async () => {
    await addCodex("mine");
    const directory = environmentStateDirectory(
      fixture.dataDir,
      "mcp-environment-overlays",
      "env-1",
    );
    writeFileSync(path.join(directory, readdirSync(directory)[0]!), "{not json");
    const { snapshot } = await snapshotOf();
    expect(source(snapshot).readOnlyReason).toBe(OVERLAY_UNREADABLE_REASON);
  });
});

describe("refreshing inherited defaults", () => {
  test("the preview names what changes, the refresh applies it under this environment's changes", async () => {
    await addCodex("mine");
    fixture.write(
      "home/.codex/config.toml",
      `[mcp_servers.inherited]\ncommand = "inherited"\n\n[mcp_servers.fresh]\ncommand = "fresh"\n`,
    );
    const { targetId } = await snapshotOf();
    const preview = await fixture.service.previewDefaultsRefresh({
      request: { targetId, sourceId: "codex:user" },
    });
    expect(preview).toMatchObject({
      added: ["fresh"],
      removed: ["other"],
      changed: [],
      conflicts: [],
      diverged: [],
      unchanged: false,
    });
    const stale = await fixture.service
      .refreshDefaults({
        request: { targetId, sourceId: "codex:user", previewToken: "o1.wrong" },
      })
      .catch((failure: unknown) => failure);
    expect(mcpManagementErrorFromUnknown(stale)?.code).toBe("revision-conflict");
    const refreshed = await fixture.service.refreshDefaults({
      request: { targetId, sourceId: "codex:user", previewToken: preview.previewToken },
    });
    expect(refreshed.stagedCopy).toBe("updated");
    expect(Object.keys(codexServers()).sort()).toEqual(["fresh", "inherited", "mine"]);
    // The staged copy the next boot reads holds the refreshed inherited servers only.
    const staged = Bun.TOML.parse(fixture.stagedDefaults.get("codex:user")!) as {
      mcp_servers: object;
    };
    expect(Object.keys(staged.mcp_servers).sort()).toEqual(["fresh", "inherited"]);
    await restart(fixture.stagedDefaults.get("codex:user")!);
    expect(Object.keys(codexServers()).sort()).toEqual(["fresh", "inherited", "mine"]);
    expect(source((await snapshotOf()).snapshot).overlay?.state).toBe("in-sync");
  });

  test("a refresh that changes a replaced server shows the conflict first", async () => {
    const { targetId, snapshot } = await snapshotOf();
    await fixture.service.mutate(
      mutation(targetId, {
        kind: "update",
        entryId: entry(snapshot, "codex:user", "inherited").entryId,
        expectedRevision: revision(snapshot, "codex:user")!,
        patch: { command: { kind: "set", value: "mine" } },
      }),
    );
    fixture.write("home/.codex/config.toml", `[mcp_servers.inherited]\ncommand = "host2"\n`);
    const preview = await fixture.service.previewDefaultsRefresh({
      request: { targetId, sourceId: "codex:user" },
    });
    expect(preview.changed).toEqual(["inherited"]);
    expect(preview.conflicts.map((conflict) => conflict.name)).toEqual(["inherited"]);
  });
});

describe("containers without a writer, project files, apply and hints", () => {
  test("project files are writable on a persistent workspace and written with their own mode", async () => {
    fixture.environment.containerLifecycle = {
      schemaVersion: 1,
      revision: 1,
      storage: { format: "volume-v1", workspaceGeneration: 1 },
    };
    fixture.containerFiles.set("/workspace/.codex/config.toml", "");
    const { targetId, snapshot } = await snapshotOf();
    const project = source(snapshot, "codex:project");
    expect(project.writable).toBe(true);
    await fixture.service.mutate(
      mutation(targetId, {
        kind: "add",
        sourceId: "codex:project",
        expectedRevision: project.revision,
        definition: { name: "proj", transport: "http", url: "https://p.example/mcp" },
      }),
    );
    expect(fixture.containerWrites.at(-1)).toEqual({
      path: "/workspace/.codex/config.toml",
      mode: "preserve",
    });
    expect(fixture.containerFiles.get("/workspace/.codex/config.toml")).toContain("proj");
  });

  test("a container save is adopted by its own sessions like a local one", async () => {
    fixture.sessions.push({
      environmentId: "env-1",
      agent: "codex",
      logicalSessionKey: "env-env-1:tab-1",
      pendingDispatch: false,
      coordinator: false,
    });
    const { targetId, snapshot } = await snapshotOf();
    const saved = await fixture.service.mutate(
      mutation(
        targetId,
        {
          kind: "add",
          sourceId: "codex:user",
          expectedRevision: revision(snapshot, "codex:user"),
          definition: { name: "mine", transport: "stdio", command: "m" },
        },
        "save-and-apply",
      ),
    );
    expect(saved.operation.apply.runtimes[0]?.state).toBe("queued");
    expect(
      saved.operation.affectedEnvironments?.map((environment) => environment.environmentId),
    ).toEqual(["env-1"]);
    await fixture.service.tick();
    expect(fixture.reloads).toEqual(["env-1"]);
  });

  test("restricted networks and container localhost are called out; the allowlist is untouched", async () => {
    const allowlist = ["github.com", "allowed.example"];
    fixture.containerNetwork.value = {
      mode: "restricted",
      allowedDomains: allowlist,
      policyVersion: 3,
    };
    const { targetId, snapshot } = await snapshotOf();
    const validate = (url: string) =>
      fixture.service.validate(
        mutation(targetId, {
          kind: "add",
          sourceId: "codex:user",
          expectedRevision: revision(snapshot, "codex:user"),
          definition: { name: "n", transport: "http", url },
        }),
      );
    const blocked = await validate(`https://blocked.example/mcp?token=${SENTINEL}`);
    const warning = blocked.preview!.warnings.join(" ");
    expect(warning).toContain(`"blocked.example" is not on its allowlist`);
    expect(warning).not.toContain(SENTINEL);
    const allowed = await validate("https://allowed.example/mcp");
    expect(allowed.preview!.warnings.join(" ")).not.toContain("allowlist");
    const port = await validate("https://allowed.example:8443/mcp");
    expect(port.preview!.warnings.join(" ")).toContain(`"allowed.example:8443"`);
    const loopback = await validate("http://localhost:3000/mcp");
    expect(loopback.preview!.warnings.join(" ")).toContain("is the container itself");
    expect(allowlist).toEqual(["github.com", "allowed.example"]);
  });

  test("host-only command and cwd paths are flagged on the row; nothing is installed", async () => {
    fixture.containerFiles.set(
      CODEX,
      `[mcp_servers.brew]\ncommand = "/opt/homebrew/bin/server"\ncwd = "/Users/me/project"\n\n[mcp_servers.ok]\ncommand = "/usr/bin/node"\n`,
    );
    fixture.containerPaths.set("/usr/bin/node", "file");
    const { snapshot } = await snapshotOf();
    const brew = entry(snapshot, "codex:user", "brew");
    expect(brew.warnings?.join(" ")).toContain(
      "/opt/homebrew/bin/server does not exist in this container",
    );
    expect(brew.warnings?.join(" ")).toContain("/Users/me/project does not exist");
    expect(entry(snapshot, "codex:user", "ok").warnings).toBeUndefined();
  });

  test("in-app sign-in is not advertised for containers", async () => {
    const { snapshot } = await snapshotOf("claude");
    expect(snapshot.target.capabilities.authentication.runtimeSignIn).toMatchObject({
      supported: false,
      reason: expect.stringContaining("not proven"),
    });
    fixture.containerFiles.set(CLAUDE, "{}");
    expect(source(snapshot, "claude:user").writable).toBe(true);
  });

  test("environment deletion's state root is where the record lives", async () => {
    await addCodex("mine");
    expect(
      existsSync(environmentStateDirectory(fixture.dataDir, "mcp-environment-overlays", "env-1")),
    ).toBe(true);
  });
});
