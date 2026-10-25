/**
 * Pi's commands before its session attaches.
 *
 * A bridge session has no Pi `AgentSession` until its first turn (or an
 * explicit refresh) attaches one, and attaching binds extensions, which runs
 * extension code. Templates and skills are files, though: Pi's own
 * `DefaultResourceLoader` with extensions switched off reads them without
 * running anything. That read goes through the same builder an attach uses
 * (`buildCommandCatalogue`), so a new tab's picker lists the session's
 * templates and skills from the moment it opens, under the ids and binding
 * revisions the attach will publish for them.
 *
 * The list is published `stale` with `attachPending` whenever the session's
 * policy lets extensions load: extension commands, and templates or skills an
 * extension contributes through `resources_discover`, only exist after
 * attach. When the policy excludes extensions (`noExtensions`; host sessions
 * without project resources, read-only sessions) nothing can add a command at
 * attach (the bridge's own inline extensions register none), so the read is
 * the whole inventory and is published `ready`.
 *
 * What the read must never do:
 * - attach, touch `lastAccessed` or hydrate a transcript: it is metadata, and
 *   the catalogue route that starts it is a metadata read;
 * - load an extension: no extension paths, no inline factories, and no
 *   `resolveProjectTrust` pass (that pass loads user extensions to ask them);
 *   project trust comes from the session's policy instead;
 * - install a package: `DefaultPackageManager.resolve()` installs a missing
 *   npm or git package (running its lifecycle scripts) unless told to skip,
 *   and the loader calls it without that choice, so the read makes it skip;
 * - widen the session's resource policy: the discovery switches and project
 *   trust are the ones an attach would use.
 *
 * A selection made from these rows is still held to the attached list and to
 * Pi's own dispatch order after the prompt route attaches, so a template an
 * extension turns out to shadow is refused (422), never run as the wrong thing.
 */
import { agentDirectory, workingDirectory } from "./config.js";
import { isSessionClosed, piResourceLoaderPolicy } from "./agent-session.js";
import {
  buildCommandCatalogue,
  publishCommandCatalogue,
  type BuiltCommandCatalogue,
} from "./commands.js";
import { schedulePersist } from "./persistence.js";
import { DefaultResourceLoader, getAgentDir, SettingsManager } from "./pi-sdk.js";
import type { PiCommandPreview, SessionState } from "./state.js";
import { withTimeout } from "./timeout.js";

/**
 * How long a catalogue read waits for a preview still under way. Well inside
 * the backend's catalogue read timeout; a slower read publishes later and
 * moves `commandRevision`, which the backend revalidates on.
 */
export const COMMAND_PREVIEW_READ_WAIT_MS = 5_000;

export type ResourceLoaderPolicy = ReturnType<typeof piResourceLoaderPolicy>;

/** Reads one session's resource commands; replaced in tests. */
export type ResourceCommandReader = (
  policy: ResourceLoaderPolicy,
) => Promise<BuiltCommandCatalogue>;

type MissingSourceAction = "install" | "skip" | "error";
type PackageResolve = (onMissing?: (source: string) => Promise<MissingSourceAction>) => unknown;

/**
 * Make the loader's package resolution skip a missing package rather than
 * install it.
 *
 * Pi 1.4.0's loader keeps its `DefaultPackageManager` in a private field and
 * calls `resolve()` with no `onMissing`, which means "install". The field is
 * reached directly because there is no option for it; if a pin bump renames
 * it, this throws and the preview is skipped rather than risk an install
 * (`command-preview.test.ts` pins both halves against the real SDK).
 */
function skipPackageInstalls(loader: DefaultResourceLoader): void {
  const manager = (loader as unknown as { packageManager?: { resolve?: PackageResolve } })
    .packageManager;
  const resolve = manager?.resolve;
  if (!manager || typeof resolve !== "function") {
    throw new Error("Pi's resource loader no longer exposes its package manager");
  }
  manager.resolve = () => resolve.call(manager, async () => "skip");
}

/**
 * The templates and skills a session with this resource policy would load,
 * read without loading any extension or installing any package.
 */
export async function readResourceCommands(options: {
  cwd: string;
  agentDir: string;
  policy: ResourceLoaderPolicy;
}): Promise<BuiltCommandCatalogue> {
  // Trust is fixed up front, so untrusted project settings are never read.
  const settingsManager = SettingsManager.create(options.cwd, options.agentDir, {
    projectTrusted: options.policy.projectTrusted,
  });
  const loader = new DefaultResourceLoader({
    ...options.policy.discovery,
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager,
    // Whatever the policy allows on attach, nothing here loads an extension.
    noExtensions: true,
    noThemes: true,
    noContextFiles: true,
  });
  skipPackageInstalls(loader);
  await loader.reload();
  return buildCommandCatalogue({
    promptTemplates: loader.getPrompts().prompts,
    resourceLoader: loader,
    settingsManager,
  });
}

function readSessionResourceCommands(policy: ResourceLoaderPolicy): Promise<BuiltCommandCatalogue> {
  return readResourceCommands({
    cwd: workingDirectory,
    agentDir: agentDirectory() ?? getAgentDir(),
    policy,
  });
}

/**
 * Whether the list is one an attach read: published `ready`, or rows kept or
 * restored from one. Never-read lists and restored preview rows
 * (`attachPending`) are neither.
 */
function rowsFromAttach(state: SessionState): boolean {
  const catalogue = state.commandCatalogue;
  if (catalogue.status !== "stale") return true;
  return state.slashCommands.length > 0 && catalogue.attachPending !== true;
}

let defaultReader: ResourceCommandReader = readSessionResourceCommands;

/** Replace the filesystem read for route tests; `undefined` restores it. */
export function setCommandPreviewReaderForTests(reader?: ResourceCommandReader): void {
  defaultReader = reader ?? readSessionResourceCommands;
}

/**
 * Start the resource-only read for a session that has not attached, or return
 * the one already made under the same policy.
 *
 * Only a session with nothing better gets one: a never-read list (`stale`,
 * no rows), rows restored from an earlier process's preview, or rows a
 * preview made under a different policy. Rows an attach read (live, kept
 * across an idle detach, or restored from disk) list extension commands, so
 * they are kept. `publishAttachedSession` clears
 * `commandPreview`, which also stops a late preview overwriting an attach.
 * Never attaches, never rejects; one published read per policy, success or not.
 * Discarded reads retry once no attach is pending.
 */
export function startCommandPreview(
  state: SessionState,
  read: ResourceCommandReader = defaultReader,
): PiCommandPreview | undefined {
  if (state.session || state.attaching || isSessionClosed(state)) return undefined;
  const policy = piResourceLoaderPolicy(state);
  const key = JSON.stringify(policy);
  const current = state.commandPreview;
  if (current?.key === key && !current.discarded) return current;
  if (!current && rowsFromAttach(state)) return undefined;
  const preview: PiCommandPreview = { key, settled: Promise.resolve() };
  const stillCurrent = () => {
    if (state.commandPreview !== preview) return false;
    if (
      state.session ||
      state.attaching ||
      isSessionClosed(state) ||
      JSON.stringify(piResourceLoaderPolicy(state)) !== key
    ) {
      // Keep the preview marker so previously published preview rows (even a
      // ready list under a no-extensions policy) aren't mistaken for attached
      // rows. A failed attach must let the next metadata read retry discovery.
      preview.discarded = true;
      return false;
    }
    return true;
  };
  // Through `then`, so a reader that throws synchronously still settles.
  preview.settled = Promise.resolve()
    .then(() => read(policy))
    .then(
      (built) => {
        if (!stillCurrent()) return;
        publishCommandCatalogue(state, built, { attachPending: !policy.discovery.noExtensions });
        schedulePersist();
      },
      (error: unknown) => {
        if (!stillCurrent()) return;
        state.health.recordNotice({
          message: "Pi's templates and skills could not be listed before the session started",
          method: "session/commandPreview",
          severity: "warning",
          source: "bridge",
          detail: error instanceof Error ? error.message : String(error),
        });
      },
    );
  state.commandPreview = preview;
  return preview;
}

/**
 * Start the read if one is due and wait for it, bounded, so the first
 * catalogue read of a new tab already carries its templates and skills.
 */
export async function awaitCommandPreview(
  state: SessionState,
  waitMs: number = COMMAND_PREVIEW_READ_WAIT_MS,
  read?: ResourceCommandReader,
): Promise<void> {
  const preview = startCommandPreview(state, read);
  if (!preview) return;
  await withTimeout(preview.settled, waitMs, "Pi is still listing its commands").catch(
    () => undefined,
  );
}
