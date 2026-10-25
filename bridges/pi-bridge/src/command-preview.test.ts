import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { NativeAgentSlashCommand } from "@orkestrator/protocol/native-agent";
import {
  createPiSessionServices,
  ensureSession,
  markSessionClosed,
  newSessionState,
  piResourceLoaderPolicy,
  setAgentSessionTestHooks,
} from "./agent-session.js";
import {
  awaitCommandPreview,
  readResourceCommands,
  startCommandPreview,
  type ResourceCommandReader,
} from "./command-preview.js";
import { buildCommandCatalogue, publishCommandCatalogue } from "./commands.js";
import { DefaultResourceLoader } from "./pi-sdk.js";
import type { SessionState } from "./state.js";

const directories: string[] = [];
afterAll(async () => {
  await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
});

const globals = globalThis as { __orkPreviewLoaded?: string[] };
afterEach(() => {
  delete globals.__orkPreviewLoaded;
  setAgentSessionTestHooks(undefined);
});

/** An extension that records being loaded at all, and registers a command. */
const extensionSource = (name: string) => `
globalThis.__orkPreviewLoaded = [...(globalThis.__orkPreviewLoaded ?? []), ${JSON.stringify(name)}];
export default function (pi) {
  pi.registerCommand(${JSON.stringify(name)}, { description: "Extension command", handler: async () => {} });
}
`;

/** A missing npm package; resolving it unguarded would run `npm install`. */
const MISSING_PACKAGE = "npm:@orkestrator-test/never-installed@1.0.0";

const PROJECT_POLICY = {
  id: "interactive-host",
  sandbox: "provider",
  approvals: "auto-approve",
  projectResources: true,
  networkAccess: "full",
} as const;

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

/**
 * A project and a Pi agent directory holding one of everything: templates and
 * skills on both sides, an extension on both sides, and a configured package
 * that is not installed.
 */
async function fixture(): Promise<{ cwd: string; agentDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "ork-pi-preview-"));
  directories.push(root);
  const cwd = join(root, "repo");
  const agentDir = join(root, "agent");
  await write(join(cwd, ".pi/prompts/alpha.md"), "---\ndescription: Alpha\n---\nDo alpha $@\n");
  await write(
    join(cwd, ".pi/skills/lint/SKILL.md"),
    "---\nname: lint\ndescription: Lint the tree\n---\nRun the linter.\n",
  );
  await write(join(cwd, ".pi/extensions/project-probe.js"), extensionSource("project-probe"));
  await write(join(agentDir, "prompts/mine.md"), "---\ndescription: Mine\n---\nMine $@\n");
  await write(join(agentDir, "extensions/user-probe.js"), extensionSource("user-probe"));
  await write(join(agentDir, "settings.json"), JSON.stringify({ packages: [MISSING_PACKAGE] }));
  return { cwd, agentDir };
}

/** The policy an attach would use, through the same function. */
function policyFor(projectResources: boolean, readOnly = false) {
  const state = newSessionState(undefined, { ...PROJECT_POLICY, projectResources });
  if (readOnly) state.readOnly = true;
  return piResourceLoaderPolicy(state);
}

/** Record installs instead of running them, for the duration of `work`. */
async function recordingInstalls<T>(
  work: () => Promise<T>,
): Promise<{ installs: string[]; result: T }> {
  const prototype = DefaultPackageManager.prototype as unknown as {
    installParsedSource: (parsed: { name?: string }, scope: string) => Promise<void>;
  };
  const original = prototype.installParsedSource;
  const installs: string[] = [];
  const offline = process.env.PI_OFFLINE;
  delete process.env.PI_OFFLINE;
  prototype.installParsedSource = async (parsed) => {
    installs.push(parsed.name ?? "unknown");
    throw new Error("install attempted");
  };
  try {
    return { installs, result: await work() };
  } finally {
    prototype.installParsedSource = original;
    if (offline !== undefined) process.env.PI_OFFLINE = offline;
  }
}

const names = (commands: NativeAgentSlashCommand[]) => commands.map((command) => command.name);

describe("resource-only command read (SDK pin)", () => {
  test("lists templates and skills without loading an extension or installing a package", async () => {
    const { cwd, agentDir } = await fixture();
    const { installs, result } = await recordingInstalls(() =>
      readResourceCommands({ cwd, agentDir, policy: policyFor(true) }),
    );

    // Pi also finds skills in the user's own `~/.agents/skills`, on attach and
    // here alike, so the fixture's rows are checked rather than the whole list.
    expect(names(result.commands)).toEqual(
      expect.arrayContaining(["/alpha", "/mine", "/skill:lint"]),
    );
    expect(result.commands.filter((command) => command.source === "extension")).toEqual([]);
    expect(result.commands.find((command) => command.name === "/alpha")).toMatchObject({
      id: "pi:template:alpha",
      source: "template",
      origin: "project",
      executionKind: "provider-prompt",
    });
    expect(result.commands.find((command) => command.name === "/mine")?.origin).toBe("user");
    // Neither extension module was even imported.
    expect(globals.__orkPreviewLoaded).toBeUndefined();
    expect(installs).toEqual([]);
    // Nothing private on the wire.
    expect(JSON.stringify(result.commands)).not.toContain(cwd);
  });

  test("the loader unguarded would install the missing package", async () => {
    // Pins the reason `skipPackageInstalls` exists: if Pi stops installing on
    // `reload()`, or renames the field it reaches, this or the test above fails.
    const { cwd, agentDir } = await fixture();
    const { installs, result } = await recordingInstalls(async () => {
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager: SettingsManager.create(cwd, agentDir),
        noExtensions: true,
      });
      expect((loader as unknown as { packageManager?: unknown }).packageManager).toBeDefined();
      return loader.reload().then(
        () => "resolved",
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
    });
    expect(installs.length).toBe(1);
    expect(result).toBe("install attempted");
  });

  test("follows the session's resource policy", async () => {
    const { cwd, agentDir } = await fixture();
    // Without project resources Pi's loader skips templates and skills
    // altogether (user ones too), exactly as it does on attach.
    const off = await recordingInstalls(() =>
      readResourceCommands({ cwd, agentDir, policy: policyFor(false) }),
    );
    expect(off.result.commands).toEqual([]);
    const readOnly = await recordingInstalls(() =>
      readResourceCommands({ cwd, agentDir, policy: policyFor(true, true) }),
    );
    expect(readOnly.result.commands).toEqual([]);
  });

  test("matches what the attach path's loader lists for the same resources", async () => {
    const { cwd, agentDir } = await fixture();
    // No package entry here: the attach path would try to install it.
    await writeFile(join(agentDir, "settings.json"), "{}");
    const state = newSessionState(undefined, PROJECT_POLICY);
    const preview = await readResourceCommands({
      cwd,
      agentDir,
      policy: piResourceLoaderPolicy(state),
    });
    expect(globals.__orkPreviewLoaded).toBeUndefined();

    const settingsManager = SettingsManager.create(cwd, agentDir);
    const services = await createPiSessionServices(state, { cwd, agentDir, settingsManager });
    const attached = buildCommandCatalogue({
      promptTemplates: services.resourceLoader.getPrompts().prompts,
      resourceLoader: services.resourceLoader,
      settingsManager,
      extensionRunner: {
        getRegisteredCommands: () =>
          services.resourceLoader
            .getExtensions()
            .extensions.flatMap((extension) => Array.from(extension.commands.values()))
            .map((command) => ({ ...command, invocationName: command.name })) as never,
      },
    });
    // The attach path loaded both extensions (Pi's pre-trust pass may import a
    // user one twice, depending on its module cache); the preview loaded neither.
    expect(new Set(globals.__orkPreviewLoaded)).toEqual(new Set(["project-probe", "user-probe"]));
    expect(attached.commands.filter((command) => command.source !== "extension")).toEqual(
      preview.commands,
    );
    expect(names(attached.commands)).toContain("/project-probe");
  });
});

function rows(...invocations: string[]) {
  return {
    commands: invocations.map((invocation): NativeAgentSlashCommand => ({
      name: `/${invocation}`,
      id: `pi:template:${invocation}`,
      executionKind: "provider-prompt",
      source: "template",
      bindingRevision: `rev-${invocation}`,
      caseSensitive: true,
    })),
    truncated: false,
  };
}

function freshState(projectResources = true): SessionState {
  return newSessionState(undefined, { ...PROJECT_POLICY, projectResources });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("command preview lifecycle", () => {
  test("publishes a never-read session's list as stale and attach-pending", async () => {
    const state = freshState();
    state.lastAccessed = 1;
    const revision = state.revision;
    await awaitCommandPreview(state, 1_000, async () => rows("alpha"));

    expect(names(state.slashCommands)).toEqual(["/alpha"]);
    expect(state.commandCatalogue).toEqual({ status: "stale", revision: 1, attachPending: true });
    expect(state.revision).toBe(revision + 1);
    // Metadata: never attached, never touched.
    expect(state.session).toBeNull();
    expect(state.attaching).toBeUndefined();
    expect(state.lastAccessed).toBe(1);
  });

  test("is the whole list, ready, when the policy loads no extensions", async () => {
    const state = freshState(false);
    await awaitCommandPreview(state, 1_000, async () => rows());
    // Nothing can add a command at attach, so an empty read is authoritative.
    expect(state.commandCatalogue).toEqual({ status: "ready", revision: 1 });
    expect(state.slashCommands).toEqual([]);
  });

  test("reads once per policy, and again when the policy changes", async () => {
    const state = freshState();
    let reads = 0;
    const read: ResourceCommandReader = async () => {
      reads += 1;
      return rows(`r${reads}`);
    };
    await awaitCommandPreview(state, 1_000, read);
    await awaitCommandPreview(state, 1_000, read);
    expect(reads).toBe(1);

    state.policy = { ...PROJECT_POLICY, projectResources: false };
    await awaitCommandPreview(state, 1_000, read);
    expect(reads).toBe(2);
    expect(names(state.slashCommands)).toEqual(["/r2"]);
    expect(state.commandCatalogue).toMatchObject({ status: "ready" });
    expect(state.commandCatalogue.attachPending).toBeUndefined();
  });

  test("leaves a list an attach read alone", async () => {
    let reads = 0;
    const read: ResourceCommandReader = async () => {
      reads += 1;
      return rows("preview");
    };
    // Attached.
    const attached = freshState();
    attached.session = {} as never;
    expect(startCommandPreview(attached, read)).toBeUndefined();
    // Detached after an attach published its (even empty) list.
    const detached = freshState();
    publishCommandCatalogue(detached, rows());
    expect(startCommandPreview(detached, read)).toBeUndefined();
    // Restored from disk with rows an attach read.
    const restored = freshState();
    restored.slashCommands = rows("restored").commands;
    expect(startCommandPreview(restored, read)).toBeUndefined();
    // Ready from an attach, even if empty.
    const ready = freshState();
    ready.commandCatalogue = { status: "ready", revision: 3 };
    expect(startCommandPreview(ready, read)).toBeUndefined();
    // Attaching, or closing.
    const attaching = freshState();
    attaching.attaching = new Promise(() => undefined);
    expect(startCommandPreview(attaching, read)).toBeUndefined();
    const closed = freshState();
    markSessionClosed(closed);
    expect(startCommandPreview(closed, read)).toBeUndefined();
    expect(reads).toBe(0);
  });

  test("rows restored from an earlier preview are read again", async () => {
    const state = freshState();
    state.slashCommands = rows("old").commands;
    state.commandCatalogue = { status: "stale", revision: 0, attachPending: true };
    await awaitCommandPreview(state, 1_000, async () => rows("new"));
    expect(names(state.slashCommands)).toEqual(["/new"]);
    expect(state.commandCatalogue).toEqual({ status: "stale", revision: 1, attachPending: true });
  });

  test("an attach that lands first wins over a late preview", async () => {
    const state = freshState();
    let finish: (() => void) | undefined;
    const preview = startCommandPreview(
      state,
      () => new Promise((resolve) => (finish = () => resolve(rows("late")))),
    )!;
    // What `publishAttachedSession` does.
    state.commandPreview = undefined;
    publishCommandCatalogue(state, rows("attached"));
    // The reader runs on a later tick, so wait for it to be holding the read.
    while (!finish) await Promise.resolve();
    finish();
    await preview.settled;
    expect(names(state.slashCommands)).toEqual(["/attached"]);
    expect(state.commandCatalogue.status).toBe("ready");
  });

  test.each(["success", "failure"])(
    "retries a preview %s discarded during an attach that fails",
    async (outcome) => {
      const state = freshState();
      const discovery = deferred<ReturnType<typeof rows>>();
      const attach = deferred<never>();
      let reads = 0;
      let attaches = 0;
      const read: ResourceCommandReader = () => {
        reads += 1;
        if (reads === 1) return discovery.promise;
        if (outcome === "failure") throw new Error("retry read failed");
        return Promise.resolve(rows("retried"));
      };
      setAgentSessionTestHooks({
        createAgentSession: () => {
          attaches += 1;
          return attach.promise;
        },
      });
      const preview = startCommandPreview(state, read)!;
      // Let discovery begin before starting the real attach lifecycle.
      await Promise.resolve();
      const attached = ensureSession(state).catch((error: unknown) => error);
      expect(state.attaching).toBeDefined();
      if (outcome === "success") discovery.resolve(rows("discarded"));
      else discovery.reject(new Error("discarded read failed"));
      await preview.settled;
      expect(state.slashCommands).toEqual([]);
      expect(state.health.snapshot().notices).toEqual([]);

      attach.reject(new Error("attach failed"));
      expect(await attached).toEqual(new Error("attach failed"));
      expect(state.attaching).toBeUndefined();
      state.lastAccessed = 1;
      await awaitCommandPreview(state, 1_000, read);
      await awaitCommandPreview(state, 1_000, read);
      expect(reads).toBe(2);
      expect(attaches).toBe(1);
      expect(state.session).toBeNull();
      expect(state.lastAccessed).toBe(1);
      if (outcome === "success") {
        expect(names(state.slashCommands)).toEqual(["/retried"]);
        expect(state.commandCatalogue).toEqual({
          status: "stale",
          revision: 1,
          attachPending: true,
        });
      } else {
        expect(state.health.snapshot().notices).toContainEqual(
          expect.objectContaining({
            method: "session/commandPreview",
            occurrences: [expect.objectContaining({ detail: "retry read failed" })],
          }),
        );
      }
    },
  );

  test("retries a discarded read even when an earlier policy published a ready preview", async () => {
    const state = freshState(false);
    await awaitCommandPreview(state, 1_000, async () => rows());
    expect(state.commandCatalogue.status).toBe("ready");
    state.policy = PROJECT_POLICY;
    const discovery = deferred<ReturnType<typeof rows>>();
    const preview = startCommandPreview(state, () => discovery.promise)!;
    state.attaching = new Promise(() => undefined);
    discovery.resolve(rows("discarded"));
    await preview.settled;
    state.attaching = undefined;

    await awaitCommandPreview(state, 1_000, async () => rows("retried"));
    expect(names(state.slashCommands)).toEqual(["/retried"]);
    expect(state.commandCatalogue).toMatchObject({ status: "stale", attachPending: true });
  });

  test.each(["success", "failure"])(
    "discards a preview %s after the session closes",
    async (outcome) => {
      const state = freshState();
      const discovery = deferred<ReturnType<typeof rows>>();
      const preview = startCommandPreview(state, () => discovery.promise)!;
      await Promise.resolve();
      const revision = state.revision;
      markSessionClosed(state);
      if (outcome === "success") discovery.resolve(rows("late"));
      else discovery.reject(new Error("late failure"));
      await preview.settled;

      expect(state.slashCommands).toEqual([]);
      expect(state.commandCatalogue).toEqual({ status: "stale", revision: 0 });
      expect(state.revision).toBe(revision);
      expect(state.health.snapshot().notices).toEqual([]);
      expect(startCommandPreview(state)).toBeUndefined();
    },
  );

  test("discards a read if its policy changes before another catalogue request", async () => {
    const state = freshState();
    const discovery = deferred<ReturnType<typeof rows>>();
    const preview = startCommandPreview(state, () => discovery.promise)!;
    await Promise.resolve();
    state.policy = { ...PROJECT_POLICY, projectResources: false };
    discovery.resolve(rows("old-policy"));
    await preview.settled;
    expect(state.slashCommands).toEqual([]);
    expect(state.commandCatalogue.revision).toBe(0);

    await awaitCommandPreview(state, 1_000, async () => rows());
    expect(state.commandCatalogue).toEqual({ status: "ready", revision: 1 });
  });

  test.each(["success", "failure"])(
    "a superseded preview %s cannot replace or invalidate the new policy's read",
    async (outcome) => {
      const state = freshState();
      const discovery = deferred<ReturnType<typeof rows>>();
      const preview = startCommandPreview(state, () => discovery.promise)!;
      await Promise.resolve();
      state.policy = { ...PROJECT_POLICY, projectResources: false };
      let reads = 0;
      const read: ResourceCommandReader = async () => {
        reads += 1;
        return rows();
      };
      await awaitCommandPreview(state, 1_000, read);
      const replacement = state.commandPreview;
      const revision = state.revision;
      if (outcome === "success") discovery.resolve(rows("old-policy"));
      else discovery.reject(new Error("old-policy failure"));
      await preview.settled;
      await awaitCommandPreview(state, 1_000, read);
      expect(state.commandPreview).toBe(replacement);
      expect(reads).toBe(1);
      expect(state.revision).toBe(revision);
      expect(state.slashCommands).toEqual([]);
      expect(state.commandCatalogue).toEqual({ status: "ready", revision: 1 });
      expect(state.health.snapshot().notices).toEqual([]);
    },
  );

  test("a failed read keeps the list stale and empty, reports it, and does not loop", async () => {
    const state = freshState();
    let reads = 0;
    const read: ResourceCommandReader = () => {
      reads += 1;
      throw new Error("disk on fire");
    };
    await awaitCommandPreview(state, 1_000, read);
    await awaitCommandPreview(state, 1_000, read);
    expect(reads).toBe(1);
    expect(state.slashCommands).toEqual([]);
    expect(state.commandCatalogue).toEqual({ status: "stale", revision: 0 });
    expect(state.health.snapshot().notices).toContainEqual(
      expect.objectContaining({
        method: "session/commandPreview",
        occurrences: [expect.objectContaining({ detail: "disk on fire" })],
      }),
    );
  });

  test("a catalogue read waits for a slow preview only so long", async () => {
    const state = freshState();
    const started = Date.now();
    await awaitCommandPreview(state, 50, () => new Promise(() => undefined));
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(state.commandCatalogue).toEqual({ status: "stale", revision: 0 });
  });
});
