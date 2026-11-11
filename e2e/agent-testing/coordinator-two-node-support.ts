/**
 * Two real `dev:test` profiles on one host, one attached to the other as its
 * leaf: sign-in, a checkout of one shared repository on each, the node link,
 * and a profile's isolated Pi provider. Shared by
 * `coordinator-node-mail-fake.spec.ts` (to-do 2900) and
 * `coordinator-notice-live.spec.ts` (to-do 7542).
 */
import { expect, type Page } from "./browser-test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { snapshotFixtureFiles } from "./codex-fixture-files";
import {
  authenticatedInvoke,
  profileStatus,
  type Invoke,
  type Status,
} from "./slash-command-live-support";

export type Profile = { name: string; status: Status & { authFile?: string }; invoke: Invoke };

export async function until<T>(
  label: string,
  read: () => Promise<T>,
  ok: (value: T) => boolean,
  timeoutMs = 180_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      last = await read();
      if (ok(last)) return last;
    } catch (error) {
      lastError = error instanceof Error ? error.message.slice(0, 300) : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(
    `Timed out waiting for ${label}${lastError ? ` (last error: ${lastError})` : ""}`,
  );
}

/**
 * Signs a page in to a running profile. A profile restarted without
 * `--fixture` reports no fixture project, so a re-sign-in passes
 * `{ fixture: false }`.
 */
export async function signIn(
  page: Page,
  name: string,
  options: { fixture?: boolean } = {},
): Promise<Profile> {
  const status = profileStatus(name) as Profile["status"];
  expect(status.status, `profile "${name}" is not running`).toBe("ready");
  expect(status.dataDir, "dev:status reported no data directory").toBeTruthy();
  if (options.fixture !== false) {
    expect(status.testProject, "the profile has no fixture").toBeTruthy();
  }
  return { name, status, invoke: await authenticatedInvoke(page, status, name) };
}

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed in the QA checkout`);
}

/**
 * A checkout of the shared repository next to the profile's fixture, added
 * as a project of this profile. The same `gitUrl` on both profiles is how
 * each finds the other's copy; the fixture projects' local-path origins give
 * a command node nothing to match. With `localOrigin`, the checkout's
 * `origin` is a bare repository beside it, so the profile can create
 * environments of the project (it fetches `origin` first).
 */
export async function sharedProject(
  profile: Profile,
  checkoutName: string,
  gitUrl: string,
  options: { localOrigin?: boolean } = {},
): Promise<{ id: string; checkout: string }> {
  const fixtureDir = path.dirname(profile.status.testProject!);
  const checkout = path.join(fixtureDir, checkoutName);
  const created = !existsSync(path.join(checkout, ".git"));
  if (created) {
    mkdirSync(checkout, { recursive: true });
    git(checkout, "init", "-q", "-b", "main");
    writeFileSync(path.join(checkout, "README.md"), `# ${checkoutName}\n`);
    git(checkout, "add", "README.md");
    git(
      checkout,
      "-c",
      "user.email=qa@example.com",
      "-c",
      "user.name=QA",
      "commit",
      "-q",
      "-m",
      "init",
    );
  }
  if (options.localOrigin && created) {
    const origin = path.join(fixtureDir, `${checkoutName}-origin.git`);
    git(fixtureDir, "init", "-q", "--bare", "-b", "main", origin);
    git(checkout, "remote", "add", "origin", origin);
    git(checkout, "push", "-q", "-u", "origin", "main");
  }
  const projects =
    await profile.invoke<Array<{ id: string; localPath: string | null }>>("get_projects");
  const existing = projects.find((project) => project.localPath === checkout);
  if (existing) return { id: existing.id, checkout };
  const project = await profile.invoke<{ id: string }>("add_project", {
    gitUrl,
    localPath: checkout,
  });
  return { id: project.id, checkout };
}

/**
 * The command node attaches the leaf over the leaf's real gateway, as
 * `add_node` does for a real machine, and waits until the link is up and the
 * leaf is in leaf mode. The leaf's token is read in memory and handed to the
 * product, never printed. `onAttached` hears the `nodeId` before the wait, so
 * a caller can forget the node even when the link never comes up.
 */
export async function attachLeaf(
  desk: Profile,
  leaf: Profile,
  onAttached: (nodeId: string) => void,
): Promise<string> {
  const leafToken = (JSON.parse(readFileSync(leaf.status.authFile!, "utf8")) as { token?: unknown })
    .token;
  expect(typeof leafToken, "the leaf's auth file has no token").toBe("string");
  const attached = await desk.invoke<{ nodeId: string; connection: { state: string } }>(
    "add_node",
    {
      routes: [
        {
          id: "loopback",
          kind: "https",
          enabled: true,
          origin: new URL(leaf.status.browserUrl!).origin,
        },
      ],
      token: leafToken,
      displayName: "Leaf profile",
    },
  );
  onAttached(attached.nodeId);
  await waitForLeafLink(desk, leaf, attached.nodeId);
  return attached.nodeId;
}

/** Until the command node holds the leaf connected and the leaf reports leaf mode. */
export async function waitForLeafLink(
  desk: Profile,
  leaf: Profile,
  nodeId: string,
  timeoutMs = 90_000,
): Promise<void> {
  await until(
    "the leaf to be connected and in leaf mode",
    async () => ({
      nodes: await desk.invoke<{
        nodes: Array<{ nodeId: string; connection: { state: string } }>;
      }>("list_nodes"),
      leafStatus: await leaf.invoke<{ mode: string }>("get_node_status"),
    }),
    ({ nodes, leafStatus }) =>
      leafStatus.mode === "leaf" &&
      nodes.nodes.some((node) => node.nodeId === nodeId && node.connection.state === "connected"),
    timeoutMs,
  );
}

export interface PiProvider {
  id: string;
  name: string;
  model: string;
  modelName: string;
  apiKey: string;
}

/**
 * Names `provider` in a profile's isolated Pi `models.json` and makes it Pi's
 * saved default there (never `~/.pi`); returns the restore. The key is a
 * literal placeholder.
 */
export function pointPiAt(status: Status, baseUrl: string, provider: PiProvider): () => void {
  const root = path.resolve(status.dataDir!);
  const directory = path.join(root, "agent-credentials", "home", ".pi", "agent");
  const models = path.join(directory, "models.json");
  const settings = path.join(directory, "settings.json");
  for (const file of [models, settings]) {
    if (!file.startsWith(`${root}${path.sep}`)) throw new Error("Pi settings escape the profile");
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const restore = snapshotFixtureFiles([models, settings]);
  const read = (file: string) =>
    existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : {};
  const existing = read(models) as { providers?: Record<string, unknown> };
  writeFileSync(
    models,
    `${JSON.stringify(
      {
        ...existing,
        providers: {
          ...existing.providers,
          [provider.id]: {
            name: provider.name,
            baseUrl,
            api: "openai-completions",
            apiKey: provider.apiKey,
            compat: {
              supportsStore: false,
              supportsDeveloperRole: false,
              supportsReasoningEffort: false,
              supportsUsageInStreaming: true,
              maxTokensField: "max_tokens",
            },
            models: [
              {
                id: provider.model,
                name: provider.modelName,
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 1_000_000,
                maxTokens: 4_096,
              },
            ],
          },
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    settings,
    `${JSON.stringify({ ...read(settings), defaultProvider: provider.id, defaultModel: provider.model }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return restore;
}
