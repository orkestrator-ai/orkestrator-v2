import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  readFile,
  rm,
  truncate,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  restrictClaudeCredentialsSnapshot,
  restrictCodexAuthSnapshot,
  restrictGrokAuthSnapshot,
  restrictOpenCodeAuthSnapshot,
  restrictPiAuthSnapshot,
  type LoginSnapshot,
} from "@orkestrator/protocol/login-snapshots";
import { claudeContainerPluginSettings } from "@orkestrator/protocol/node/claude-plugin-set";
import { SHARED_SKILLS_INPUT } from "@orkestrator/protocol/container-recovery";
import { claudeContainerConfig } from "./claude-container-config.js";
import { environmentStateDirectory } from "./environment-state-paths.js";

/**
 * Portable agent inputs, staged per environment (containers plan step 08).
 *
 * Instead of bind-mounting whole host agent homes (histories, databases,
 * transcripts and all) into every container, the backend copies the same
 * allowlist `docker/entrypoint.sh` consumes into a private revision directory
 * and binds only those staged subtrees, read-only, at the paths the entrypoint
 * already reads. The entrypoint's own bounded copy then runs unchanged.
 *
 * Only enabled providers are staged. Sources are read without following
 * symlinks in ancestors or files. Filtered settings may resolve a symlink to
 * a regular file. Each file is re-checked after opening so a swapped path
 * cannot be read, and bounds are enforced
 * while copying. Logins whose refresh token is single-use or rotating (Claude,
 * Codex, Grok, and OpenCode and Pi OAuth) are staged access-only (`accessOnlyLogin`),
 * so no container can spend the host's. A revision is written under a
 * temporary name and renamed into place, so a container never binds a
 * half-written revision.
 */

/**
 * Version 2 adds Cursor's `~/.cursor/mcp.json`; version 3 adds Claude's
 * `skills` and Grok's `commands`; version 4 withholds credentials in those trees;
 * version 5 adds the shared `~/.agents/skills` and stages a linked skill;
 * version 6 stages `.claude.json` through `claudeContainerConfig`; version 7
 * leaves a skill's oversized files out instead of the whole skill, and its
 * credential guard ignores example and placeholder values.
 */
export const PORTABLE_INPUT_SPEC_VERSION = 7;

export type InputLimits = {
  fileBytes: number;
  directoryEntries: number;
  directoryBytes: number;
  totalEntries: number;
  totalBytes: number;
};

export const INPUT_LIMITS: InputLimits = {
  fileBytes: 10 * 1024 * 1024,
  directoryEntries: 5_000,
  directoryBytes: 256 * 1024 * 1024,
  totalEntries: 20_000,
  totalBytes: 512 * 1024 * 1024,
};

/**
 * The pseudo-provider for the shared user skills root, `~/.agents/skills`. It
 * is staged once, for every provider that reads it (`SHARED_SKILL_READERS`),
 * and carries no credentials of any provider.
 */
export { SHARED_SKILLS_INPUT };

/**
 * Platforms that list `~/.agents/skills` (`rootSpecsFor` in `agent-skills.ts`).
 * Claude does not read it.
 */
export const SHARED_SKILL_READERS: readonly AgentPlatform[] = [
  "codex",
  "cursor",
  "grok",
  "opencode",
  "pi",
];

/**
 * The providers to stage, with {@link SHARED_SKILLS_INPUT} added when one of
 * them reads the shared skills root and the image's entrypoint copies it
 * (`imageCopiesSharedSkills`).
 */
export function withSharedSkillsInput<P extends ProviderInputSpec["provider"]>(
  providers: ReadonlySet<P>,
  imageCopiesSharedSkills: boolean,
): Set<P | typeof SHARED_SKILLS_INPUT> {
  const selected = new Set<P | typeof SHARED_SKILLS_INPUT>(providers);
  if (
    imageCopiesSharedSkills &&
    SHARED_SKILL_READERS.some((platform) => selected.has(platform as P))
  ) {
    selected.add(SHARED_SKILLS_INPUT);
  }
  return selected;
}

type DirectoryMode =
  /** Copy the directory as one unit; over-bound skips the whole directory. */
  | "tree"
  /** Copy each top-level entry as its own unit. */
  | "entries";

export interface InputSource {
  /** Staged sub-directory, also the name of the bind mount it feeds. */
  stage: string;
  /** Mount point inside the container (the path entrypoint.sh reads). */
  target: string;
  /** Host directory the allowlist is read from. */
  root: string | null;
  files?: readonly string[];
  directories?: readonly {
    path: string;
    mode: DirectoryMode;
    exclude?: readonly string[];
    withholdCredentials?: boolean;
    /**
     * A skill root. A link to a skill inside one of the run's skill roots may
     * be staged from it (`ProviderCopier.linkedSkill`): in `entries` mode a
     * top-level entry that links to a directory holding `SKILL.md` is copied
     * as a real directory. Every other link is still skipped.
     */
    skills?: boolean;
  }[];
  /**
   * Files of `files` staged only through a filter, which returns what a
   * container may see of them, or undefined to withhold the file.
   */
  filteredFiles?: Readonly<Record<string, (text: string) => string | undefined>>;
  /**
   * One of `files` that holds a login with a single-use or rotating refresh
   * token. It is staged through `restrict` (see
   * `@orkestrator/protocol/login-snapshots`), or not at all when that
   * withholds it.
   */
  accessOnlyLogin?: {
    file: string;
    restrict: AccessOnlyLoginRestriction;
    /**
     * Withhold without reporting `login-withheld`, for a login another path
     * delivers. Claude's arrives over stdin from the Keychain or this same file
     * on every start, so a stale file on a macOS host is no reason to warn.
     */
    quiet?: boolean;
  };
}

export type AccessOnlyLoginRestriction = (text: string, nowMs?: number) => LoginSnapshot;

export interface InputFile {
  stage: string;
  target: string;
  /** Host file. */
  source: string | null;
  /** What a container may see of the file, or undefined to withhold it. */
  filter?: (text: string) => string | undefined;
}

export interface ProviderInputSpec {
  provider: AgentPlatform | "git" | typeof SHARED_SKILLS_INPUT;
  directories: InputSource[];
  files: InputFile[];
}

export interface InputSourceRoots {
  home: string;
  /** Agent-test profiles read credentials from isolated locations. */
  agentTest: boolean;
  agentTestHostHome?: string;
  /**
   * Agent-test only: the Grok home holding the run's own restricted login,
   * `GROK_HOME` (a CLI scenario's disposable copy) or else `$HOME/.grok` (a
   * `dev:test` profile's isolated HOME). See {@link grokStagingHome}.
   */
  grokHome?: string;
  claudeConfigDir?: string;
  codexHome?: string;
  xdgConfigHome?: string;
  xdgDataHome?: string;
  xdgStateHome?: string;
  /**
   * The active added account's configuration directory, when it is not the
   * host login. Only the login itself is read from here — everything else in
   * an account directory is a link back to the host's, and staging never
   * follows links.
   */
  claudeAccountHome?: string;
  /** An explicit container credential opt-out excludes both host and added logins. */
  includeClaudeCredentials?: boolean;
  codexAccountHome?: string;
}

export function defaultInputSourceRoots(
  runtimeFlavor: string | undefined,
  claudeConfigDirEnv: string,
): InputSourceRoots {
  const agentTest = runtimeFlavor === "agent-test";
  return {
    // `HOME`, not `os.homedir()`: Bun reads the latter once at startup.
    home: process.env.HOME?.trim() || os.homedir(),
    agentTest,
    agentTestHostHome: process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME?.trim() || undefined,
    ...(agentTest
      ? {
          grokHome:
            process.env.GROK_HOME?.trim() ||
            path.join(process.env.HOME?.trim() || os.homedir(), ".grok"),
        }
      : {}),
    claudeConfigDir: process.env[claudeConfigDirEnv]?.trim() || undefined,
    codexHome: process.env.CODEX_HOME?.trim() || undefined,
    xdgConfigHome: process.env.XDG_CONFIG_HOME?.trim() || undefined,
    xdgDataHome: process.env.XDG_DATA_HOME?.trim() || undefined,
    xdgStateHome: process.env.XDG_STATE_HOME?.trim() || undefined,
  };
}

/**
 * Where Grok's home is staged from. Outside agent-test it is the user's
 * `~/.grok`. An agent-test run has its own restricted login, and that is the
 * one a container must get: a `dev:test` profile keeps it in its isolated
 * HOME (where its local Grok reads it) and a CLI scenario in `GROK_HOME`
 * (`InputSourceRoots.grokHome`). Staging the real host's `~/.grok` instead
 * handed containers a login the run never authorized in that form and ignored
 * a disposable copy. Grok's `.config/grok` is read beside the home it uses.
 */
export function grokStagingHome(roots: InputSourceRoots): string {
  if (roots.agentTest && roots.grokHome) return roots.grokHome;
  const hostHome =
    roots.agentTest && roots.agentTestHostHome ? roots.agentTestHostHome : roots.home;
  return path.join(hostHome, ".grok");
}

/** Grok's `.config/grok`, beside {@link grokStagingHome}. */
export function grokStagingConfig(roots: InputSourceRoots): string {
  return path.join(path.dirname(grokStagingHome(roots)), ".config", "grok");
}

/**
 * The versioned allowlist, per provider. It mirrors `docker/entrypoint.sh`
 * exactly — the entrypoint copies these same names from the same mount
 * points — so staging never exposes anything the container would not have
 * copied anyway. Keep the two in step.
 */
export function portableInputSpec(roots: InputSourceRoots): ProviderInputSpec[] {
  const { home, agentTest } = roots;
  const hostHome = agentTest && roots.agentTestHostHome ? roots.agentTestHostHome : home;
  const join = (base: string | undefined, ...parts: string[]) =>
    base ? path.join(base, ...parts) : null;
  const configHome = agentTest ? roots.xdgConfigHome : path.join(home, ".config");
  const { claudeAccountHome, codexAccountHome } = roots;
  const dataHome = agentTest ? roots.xdgDataHome : path.join(home, ".local", "share");
  const stateHome = agentTest ? roots.xdgStateHome : path.join(home, ".local", "state");
  return [
    {
      provider: "claude",
      directories: [
        {
          stage: "claude-config",
          target: "/claude-config",
          root: agentTest ? (roots.claudeConfigDir ?? null) : path.join(home, ".claude"),
          accessOnlyLogin: {
            file: ".credentials.json",
            restrict: restrictClaudeCredentialsSnapshot,
            quiet: true,
          },
          files: [
            "CLAUDE.md",
            "settings.local.json",
            "settings.json",
            ...(claudeAccountHome || roots.includeClaudeCredentials === false
              ? []
              : [".credentials.json"]),
          ],
          // Only Claude Code's plugin enablement: the entrypoint merges it into
          // the container's own settings, so the bridge passes, and the CLI
          // loads, the installs the host has turned on.
          filteredFiles: { "settings.json": claudeContainerPluginSettings },
          directories: [
            { path: "commands", mode: "entries" },
            // One unit per skill directory, like Grok's and Pi's skills. A
            // skill linked in from `~/.agents/skills` (an `npx skills`
            // install) is staged as a real directory.
            { path: "skills", mode: "entries", withholdCredentials: true, skills: true },
            { path: "agents", mode: "entries" },
            { path: "ide", mode: "entries" },
            { path: "plugins", mode: "entries" },
          ],
        },
        ...(claudeAccountHome && roots.includeClaudeCredentials !== false
          ? [
              {
                stage: "claude-config",
                target: "/claude-config",
                root: claudeAccountHome,
                files: [".credentials.json"],
                accessOnlyLogin: {
                  file: ".credentials.json",
                  restrict: restrictClaudeCredentialsSnapshot,
                  quiet: true,
                },
              },
            ]
          : []),
      ],
      files: [
        {
          stage: "claude.json",
          target: "/claude-config.json",
          // An account's `.claude.json` names its own login (`oauthAccount`)
          // and already carries the host's MCP servers.
          source: claudeAccountHome
            ? path.join(claudeAccountHome, ".claude.json")
            : join(hostHome, ".claude.json"),
          // Only the identity, onboarding flags and container-safe MCP
          // servers (security report M8); never project paths or keys.
          filter: (text) => claudeContainerConfig(text, { hostHomes: [home, hostHome] }),
        },
      ],
    },
    {
      provider: "opencode",
      directories: [
        {
          stage: "opencode-config",
          target: "/opencode-config",
          root: join(configHome, "opencode"),
          // User-authored: every entry except host-platform node_modules.
          directories: [{ path: ".", mode: "entries", exclude: ["node_modules"] }],
        },
        {
          stage: "opencode-data",
          target: "/opencode-data",
          root: join(dataHome, "opencode"),
          // Only the login: OpenCode never reads a host's snapshot/, storage/
          // or account.json in a container (entrypoint.sh, "/opencode-data").
          files: ["auth.json"],
          accessOnlyLogin: { file: "auth.json", restrict: restrictOpenCodeAuthSnapshot },
        },
      ],
      files: [
        {
          stage: "opencode-model.json",
          target: "/opencode-state/model.json",
          source: join(stateHome, "opencode", "model.json"),
        },
      ],
    },
    {
      provider: "codex",
      directories: [
        {
          stage: "codex-home",
          target: "/codex-home",
          root: agentTest ? (roots.codexHome ?? null) : path.join(home, ".codex"),
          files: [
            ...(codexAccountHome ? [] : ["auth.json"]),
            "config.toml",
            "AGENTS.md",
            "hooks.json",
            "models_cache.json",
            ".codex-global-state.json",
            "cloud-config-bundle-cache.json",
            "cloud-requirements-cache.json",
          ],
          directories: [
            { path: "rules", mode: "tree" },
            { path: "skills", mode: "entries", skills: true },
            { path: "prompts", mode: "tree" },
            { path: "vendor_imports", mode: "tree" },
            // plugins/.plugin-appserver holds host-platform binaries.
            { path: "plugins/cache", mode: "tree" },
          ],
          accessOnlyLogin: { file: "auth.json", restrict: restrictCodexAuthSnapshot },
        },
        ...(codexAccountHome
          ? [
              {
                stage: "codex-home",
                target: "/codex-home",
                root: codexAccountHome,
                files: ["auth.json"],
                accessOnlyLogin: { file: "auth.json", restrict: restrictCodexAuthSnapshot },
              },
            ]
          : []),
      ],
      files: [],
    },
    {
      provider: "grok",
      directories: [
        {
          stage: "grok-home",
          target: "/grok-home",
          root: grokStagingHome(roots),
          files: [
            "xai-api-key",
            "auth.json",
            "config.toml",
            "trusted_folders.toml",
            "agent_id",
            "models_cache.json",
          ],
          directories: [
            { path: "hooks", mode: "entries" },
            { path: "skills", mode: "entries", skills: true },
            // Legacy flat commands (`*.md`), which Grok lists as user skills.
            { path: "commands", mode: "entries", withholdCredentials: true },
          ],
          accessOnlyLogin: { file: "auth.json", restrict: restrictGrokAuthSnapshot },
        },
        {
          stage: "grok-config",
          target: "/grok-config",
          root: grokStagingConfig(roots),
          directories: [{ path: ".", mode: "tree" }],
        },
      ],
      files: [],
    },
    {
      provider: "pi",
      directories: [
        {
          stage: "pi-config",
          target: "/pi-config",
          root: path.join(hostHome, ".pi"),
          files: [
            "agent/auth.json",
            "agent/models.json",
            "agent/settings.json",
            "agent/mcp.json",
            "agent/SYSTEM.md",
            "agent/APPEND_SYSTEM.md",
          ],
          // Sessions are the host's own history and are never staged.
          directories: [
            { path: "agent/skills", mode: "entries", skills: true },
            { path: "agent/prompts", mode: "entries" },
            { path: "agent/extensions", mode: "entries" },
            { path: "agent/themes", mode: "entries" },
          ],
          accessOnlyLogin: { file: "agent/auth.json", restrict: restrictPiAuthSnapshot },
        },
      ],
      files: [],
    },
    {
      provider: "cursor",
      directories: [
        {
          stage: "cursor-config",
          target: "/cursor-config",
          root: path.join(hostHome, ".cursor"),
          // User MCP servers only. Everything else under ~/.cursor (account
          // and login state, IDE state, hooks, plugins, extensions, `sdk/`,
          // `cli-config.json`) is the host's own and is never staged; the
          // container's login arrives through the backend's key sync.
          files: ["mcp.json"],
        },
      ],
      files: [],
    },
    {
      provider: SHARED_SKILLS_INPUT,
      directories: [
        {
          stage: "agents-skills",
          target: "/agents-skills",
          root: path.join(hostHome, ".agents", "skills"),
          // One unit per skill, like the provider skill roots. Newly portable,
          // so credentials inside a skill are withheld.
          directories: [{ path: ".", mode: "entries", withholdCredentials: true, skills: true }],
        },
      ],
      files: [],
    },
    {
      provider: "git",
      directories: [],
      files: agentTest
        ? []
        : [{ stage: "gitconfig", target: "/tmp/gitconfig", source: path.join(home, ".gitconfig") }],
    },
  ];
}

// ---------------------------------------------------------------------------
// Copying
// ---------------------------------------------------------------------------

export type SkipReason =
  | "symlink"
  | "not-regular"
  | "too-large"
  | "too-many-entries"
  | "aggregate-budget"
  | "unreadable"
  | "changed-while-reading"
  /** A login withheld because a copy could not use it without refreshing. */
  | "login-withheld"
  | "credential-withheld";

export interface ProviderInputSummary {
  provider: ProviderInputSpec["provider"];
  files: number;
  bytes: number;
  /** Counts only: skipped names are user file names and stay private. */
  skipped: Partial<Record<SkipReason, number>>;
}

export interface StagedMount {
  source: string;
  target: string;
}

export interface StagedInputs {
  revision: string;
  directory: string;
  mounts: StagedMount[];
  providers: ProviderInputSummary[];
  specVersion: number;
  stagedAt: string;
  /** Files reflinked rather than copied ({@link FileCloner}); not in the manifest. */
  clonedFiles: number;
}

class Budget {
  entries = 0;
  bytes = 0;
  constructor(
    private readonly maxEntries: number,
    private readonly maxBytes: number,
  ) {}
  fits(entries: number, bytes: number): boolean {
    return this.entries + entries <= this.maxEntries && this.bytes + bytes <= this.maxBytes;
  }
  take(entries: number, bytes: number): void {
    this.entries += entries;
    this.bytes += bytes;
  }
}

class Skip extends Error {
  constructor(readonly reason: SkipReason) {
    super(reason);
  }
}

/**
 * A credential-named key assigned a value; group 1 is the value, unquoted.
 * A match consumes only the key and its `=` or `:`; the value is read by a
 * lookahead, so a value that is itself an assignment (`API_KEY= SECRET=...`)
 * is checked again as its own match. Spacing around the operator never
 * crosses a line break: an empty `API_KEY=` must not take the next line's
 * `CLIENT_SECRET=...` as its value, which hid the real key behind the word
 * "SECRET".
 */
const CREDENTIAL_ASSIGNMENT =
  /(?<=^|[\s"'{};,=:])[\w-]{0,128}(?:api[_-]?key|token|password|secret|private[_-]?key|access[_-]?key)[\w-]{0,128}["']?[ \t]*[:=](?=[ \t]*["']?([^\s"'#,;(){}[\]]+))/gim;

/** Words that mark a value as an example rather than a key someone holds. */
const PLACEHOLDER_VALUE =
  /your|example|sample|placeholder|changeme|dummy|redacted|secret|password|xxxx/i;

/**
 * Whether an assigned value is shaped like a generated secret rather than an
 * example, a reference or a count: eight or more characters holding both a
 * letter and a digit, not a `${VAR}`, `%VAR%` or `<placeholder>`, and not
 * spelled with a placeholder word. The value stops at a bracket, so
 * `token = tokens[0]` reads as `tokens`. Skill documentation is full of
 * `export CONTEXT7_API_KEY=your_key`, `--password=secret123`,
 * `"total_tokens": 1234`, `tokens=1-3` and `TOKEN = window.__APP_TOKEN__`;
 * withholding those discarded the very SKILL.md that defines a skill. A
 * random 20-character key lacks a digit about 3% of the time, which is the
 * price of this guard being defense in depth rather than secret detection.
 */
function looksLikeSecretValue(value: string): boolean {
  return (
    value.length >= 8 &&
    /[A-Za-z]/.test(value) &&
    /\d/.test(value) &&
    !/^[$%<]/.test(value) &&
    !PLACEHOLDER_VALUE.test(value)
  );
}

/** Conservative guard for newly portable extension resources. Never logs file names or bytes. */
function extensionCredentialGuard(relative: string): (contents: Buffer) => void {
  return (contents) => {
    const sensitivePath = relative
      .split("/")
      .some((part) =>
        /^(?:\.env(?:\..*)?|\.(?:ssh|aws|azure|gcloud)|(?:credentials?|secrets?|tokens?)(?:\..*)?|auth\.json|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|.*\.(?:pem|key|p12|pfx|keystore))$/i.test(
          part,
        ),
      );
    const text = contents.toString("utf8");
    const privateKey = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/.test(text);
    // Every assignment is checked: an example early in a file must not hide a
    // real key further down.
    let credentialValue = false;
    for (const match of text.matchAll(CREDENTIAL_ASSIGNMENT)) {
      if (looksLikeSecretValue(match[1]!)) {
        credentialValue = true;
        break;
      }
    }
    if (sensitivePath || privateKey || credentialValue) throw new Skip("credential-withheld");
  };
}

/** Throws unless every component below `root` up to `relative` is a real directory. */
async function assertNoSymlinkAncestry(root: string, relative: string): Promise<void> {
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Skip("symlink");
  const parts = relative.split("/").filter((part) => part && part !== ".");
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new Skip("symlink");
    if (!stat.isDirectory()) throw new Skip("not-regular");
  }
}

/** How {@link stagePortableInputs} writes a staged file; tests replace `copyFile`. */
export interface StagingOptions {
  /** Reflink unfiltered files where the filesystem can. Default true. */
  cloneFiles?: boolean;
  copyFile?: typeof copyFile;
  /**
   * Test seam: runs after a directory unit is listed and admitted and before
   * its files are copied, so a test can change the source in between.
   */
  afterListing?: (source: string) => Promise<void> | void;
}

/**
 * Reflinks staged files (DK-14). A reflink shares the source's blocks until
 * either side writes, so each revision is still an independent copy: a write
 * to it never reaches the host file or another environment's revision, unlike
 * a hard link. Where the filesystem cannot (ext4, tmpfs, another device than
 * the source, any platform but Linux) the file is copied as before.
 *
 * Only a file staged byte for byte is cloned. A filtered or guarded one must
 * be read anyway, and cloning after the read could stage bytes nobody checked.
 */
class FileCloner {
  cloned = 0;
  /** Source devices a clone failed from, so the rest of the run copies at once. */
  private readonly refused = new Set<number>();
  private readonly enabled: boolean;
  private readonly copy: typeof copyFile;

  constructor(options: StagingOptions = {}) {
    // `/proc/self/fd` reopens the very file the caller checked, never the path.
    this.enabled = options.cloneFiles !== false && process.platform === "linux";
    this.copy = options.copyFile ?? copyFile;
  }

  /**
   * Clones the open, identity-checked `handle` to `destination`. Returns its
   * size, or undefined when nothing was cloned and the caller must copy.
   */
  async clone(
    handle: FileHandle,
    device: number,
    destination: string,
    limit: number,
  ): Promise<number | undefined> {
    if (!this.enabled || this.refused.has(device)) return undefined;
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    try {
      await this.copy(
        `/proc/self/fd/${handle.fd}`,
        destination,
        fsConstants.COPYFILE_EXCL | fsConstants.COPYFILE_FICLONE_FORCE,
      );
    } catch (error) {
      // An existing destination is the copy's error too, so it must surface.
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw error;
      this.refused.add(device);
      await rm(destination, { force: true });
      return undefined;
    }
    try {
      await chmod(destination, 0o600);
      // A clone takes the file as it is now, so growth since the check is seen here.
      const size = (await lstat(destination)).size;
      if (size > limit) throw new Skip("too-large");
      this.cloned += 1;
      return size;
    } catch (error) {
      await rm(destination, { force: true });
      throw error;
    }
  }
}

async function copyRegularFile(
  source: string,
  destination: string,
  limit: number,
  cloner?: FileCloner,
): Promise<number>;
async function copyRegularFile(
  source: string,
  destination: string,
  limit: number,
  cloner: FileCloner | undefined,
  filter: ((text: string) => string | undefined) | undefined,
  guard?: (contents: Buffer) => void,
): Promise<number | undefined>;
async function copyRegularFile(
  source: string,
  destination: string,
  limit: number,
  cloner?: FileCloner,
  filter?: (text: string) => string | undefined,
  guard?: (contents: Buffer) => void,
): Promise<number | undefined> {
  const before = await lstat(source);
  if (before.isSymbolicLink()) throw new Skip("symlink");
  if (!before.isFile()) throw new Skip("not-regular");
  if (before.size > limit) throw new Skip("too-large");
  const handle = await open(source, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch(
    (error: NodeJS.ErrnoException) => {
      throw new Skip(error.code === "ELOOP" ? "symlink" : "unreadable");
    },
  );
  try {
    const opened = await handle.stat();
    if (opened.ino !== before.ino || opened.dev !== before.dev || !opened.isFile()) {
      throw new Skip("changed-while-reading");
    }
    if (cloner && !filter && !guard) {
      const cloned = await cloner.clone(handle, opened.dev, destination, limit);
      if (cloned !== undefined) return cloned;
    }
    // Read at most limit+1 bytes: growth past the bound is detected while
    // copying, not from the earlier size.
    const buffer = Buffer.alloc(Math.min(limit + 1, Math.max(opened.size, 0) + 1));
    let total = 0;
    const chunks: Buffer[] = [];
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > limit) throw new Skip("too-large");
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    const contents = Buffer.concat(chunks);
    guard?.(contents);
    const filtered = filter ? filter(contents.toString("utf8")) : contents;
    if (filtered === undefined) return undefined;
    // Raw filtered-file bytes never reach a staged path, even if reading or
    // filtering fails. Only the bounded allowlisted result is published.
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, filtered, { mode: 0o600, flag: "wx" });
    return Buffer.byteLength(filtered);
  } finally {
    await handle.close();
  }
}

interface TreeEntry {
  relative: string;
  kind: "file" | "directory";
  size: number;
}

/** Lists a tree without following links; symlinks are reported, not entered. */
async function listTree(
  root: string,
  maxEntries: number,
  exclude: readonly string[],
): Promise<{ entries: TreeEntry[]; symlinks: number }> {
  const entries: TreeEntry[] = [];
  let symlinks = 0;
  const walk = async (relative: string): Promise<void> => {
    const names = await readdir(path.join(root, relative));
    for (const name of names) {
      if (!relative && exclude.includes(name)) continue;
      const child = relative ? `${relative}/${name}` : name;
      const stat = await lstat(path.join(root, child));
      if (stat.isSymbolicLink()) {
        symlinks += 1;
        continue;
      }
      if (stat.isDirectory()) {
        entries.push({ relative: child, kind: "directory", size: 0 });
        if (entries.length > maxEntries) throw new Skip("too-many-entries");
        await walk(child);
      } else if (stat.isFile()) {
        entries.push({ relative: child, kind: "file", size: stat.size });
        if (entries.length > maxEntries) throw new Skip("too-many-entries");
      }
      // Sockets, devices and FIFOs are runtime artifacts, never inputs.
    }
  };
  await walk("");
  return { entries, symlinks };
}

/** Whether `child` lies below `parent` (never `parent` itself). */
function isStrictlyInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== "" && !path.isAbsolute(relative) && relative.split(path.sep)[0] !== "..";
}

/** Refuse roots broad enough to expose an entire source home. */
function safeSkillRoot(real: string, homes: readonly string[]): boolean {
  return (
    real !== path.parse(real).root &&
    !homes.some((home) => home === real || isStrictlyInside(home, real))
  );
}

/**
 * The real paths a linked skill may resolve into: `~/.agents/skills` and the
 * skill roots of the providers staged in this run. A root that resolves to
 * `/`, a home or an ancestor of one is dropped, so a linked root cannot make
 * the whole home an allowed target.
 */
async function linkedSkillRoots(
  spec: readonly ProviderInputSpec[],
  providers: ReadonlySet<ProviderInputSpec["provider"]>,
  homes: readonly string[],
): Promise<string[]> {
  const realHomes = await Promise.all(
    homes.map((home) => realpath(home).catch(() => path.resolve(home))),
  );
  const roots = new Set<string>();
  for (const entry of spec) {
    if (entry.provider !== SHARED_SKILLS_INPUT && !providers.has(entry.provider)) continue;
    for (const source of entry.directories) {
      if (!source.root) continue;
      for (const directory of source.directories ?? []) {
        if (!directory.skills) continue;
        const real = await realpath(path.join(source.root, directory.path)).catch(() => null);
        if (!real || !safeSkillRoot(real, realHomes)) continue;
        roots.add(real);
      }
    }
  }
  return [...roots];
}

class ProviderCopier {
  readonly summary: ProviderInputSummary;
  constructor(
    provider: ProviderInputSummary["provider"],
    private readonly total: Budget,
    private readonly limits: InputLimits,
    /** Real paths a linked skill may resolve into ({@link linkedSkillRoots}). */
    private readonly skillRoots: readonly string[] = [],
    private readonly cloner?: FileCloner,
    private readonly afterListing?: StagingOptions["afterListing"],
  ) {
    this.summary = { provider, files: 0, bytes: 0, skipped: {} };
  }

  skip(reason: SkipReason, count = 1): void {
    this.summary.skipped[reason] = (this.summary.skipped[reason] ?? 0) + count;
  }

  adjustLogin(adjustment: LoginAdjustment, quiet = false): void {
    this.adjustFiltered(adjustment);
    if (adjustment.withheld && !quiet) this.skip("login-withheld");
    if (adjustment.dropped) this.skip("login-withheld", adjustment.dropped);
  }

  /** Account for a staged file a filter rewrote or withheld. */
  adjustFiltered(adjustment: LoginAdjustment): void {
    const files = adjustment.withheld ? -1 : 0;
    const bytes = adjustment.bytes - adjustment.originalBytes;
    this.summary.files += files;
    this.summary.bytes += bytes;
    this.total.take(files, bytes);
  }

  private record(files: number, bytes: number): void {
    this.summary.files += files;
    this.summary.bytes += bytes;
    this.total.take(files, bytes);
  }

  async file(
    root: string,
    relative: string,
    destinationRoot: string,
    filter?: (text: string) => string | undefined,
  ): Promise<void> {
    try {
      await assertNoSymlinkAncestry(root, relative);
      // Dotfile managers commonly link settings.json. Only filtered files may
      // follow that link; copyRegularFile checks the resolved target's identity
      // and size and opens it with O_NOFOLLOW before reading any bytes.
      const source = filter ? await realpath(path.join(root, relative)) : path.join(root, relative);
      const stat = await lstat(source).catch(() => null);
      if (!stat) return;
      if (!this.total.fits(1, stat.size)) throw new Skip("aggregate-budget");
      const bytes = await copyRegularFile(
        source,
        path.join(destinationRoot, relative),
        this.limits.fileBytes,
        this.cloner,
        filter,
      );
      if (bytes !== undefined) this.record(1, bytes);
    } catch (error) {
      if (error instanceof Skip) this.skip(error.reason);
      else if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.skip("unreadable");
    }
  }

  /** Copies one unit (a directory tree or a single entry) all-or-nothing. */
  private async unit(
    root: string,
    relative: string,
    destinationRoot: string,
    exclude: readonly string[],
    withholdCredentials = false,
    followSkillLink = false,
  ): Promise<void> {
    const source = path.join(root, relative);
    const stat = await lstat(source).catch(() => null);
    if (!stat) return;
    if (stat.isSymbolicLink()) {
      if (followSkillLink) return this.linkedSkill(source, relative, destinationRoot);
      throw new Skip("symlink");
    }
    if (stat.isFile()) {
      if (!this.total.fits(1, stat.size)) throw new Skip("aggregate-budget");
      const bytes = await copyRegularFile(
        source,
        path.join(destinationRoot, relative),
        this.limits.fileBytes,
        this.cloner,
        undefined,
        withholdCredentials ? extensionCredentialGuard(relative) : undefined,
      );
      this.record(1, bytes!);
      return;
    }
    if (!stat.isDirectory()) throw new Skip("not-regular");
    await this.tree(source, destinationRoot, relative, exclude, withholdCredentials, {
      skill: followSkillLink,
    });
  }

  /**
   * Stages a top-level link of a skill root as a real directory, only when it
   * resolves to a directory holding a regular `SKILL.md` below one of the
   * run's skill roots, with no link between that root and the skill. Links
   * inside the skill are skipped like any other. The skill's identity is
   * checked again after copying, so a directory swapped in mid-copy is
   * discarded. Credentials inside it are always withheld: the link reaches
   * content the provider's own root did not hold.
   */
  private async linkedSkill(link: string, relative: string, destinationRoot: string) {
    const target = await realpath(link).catch(() => null);
    const container = target
      ? this.skillRoots.find((root) => isStrictlyInside(target, root))
      : undefined;
    if (!target || !container) throw new Skip("symlink");
    const before = await lstat(target);
    if (before.isSymbolicLink() || !before.isDirectory()) throw new Skip("symlink");
    await assertNoSymlinkAncestry(container, `${path.relative(container, target)}/SKILL.md`);
    const marker = await lstat(path.join(target, "SKILL.md")).catch(() => null);
    if (!marker?.isFile()) throw new Skip("symlink");
    const sourceRelative = path.relative(container, target).split(path.sep).join("/");
    // Reject sensitive source ancestry even when the destination uses a benign alias.
    extensionCredentialGuard(sourceRelative)(Buffer.alloc(0));
    await this.tree(target, destinationRoot, relative, [], true, {
      skill: true,
      verify: async () => {
        const after = await lstat(target).catch(() => null);
        if (!after || after.ino !== before.ino || after.dev !== before.dev) {
          throw new Skip("changed-while-reading");
        }
        try {
          await assertNoSymlinkAncestry(container, `${sourceRelative}/SKILL.md`);
          if ((await realpath(link)) !== target) throw new Skip("changed-while-reading");
        } catch {
          throw new Skip("changed-while-reading");
        }
      },
    });
  }

  /**
   * Copies the directory `source` to `destinationRoot/relative` all-or-nothing.
   * `verify` runs after the last file, before anything is counted: the skips
   * of files left out (links, files withheld or changed mid-copy, a skill's
   * oversized files) are held until the unit commits, so a unit refused whole
   * is counted as that one refusal and nothing else.
   *
   * A `skill` (an entry of a skill root) is the one exception: a file over the
   * per-file bound is left out and counted as `too-large`, and the rest of the
   * skill is still staged. Skills ship platform binaries and data blobs (a
   * 17 MB macOS executable beside a launcher that downloads the Linux one),
   * and losing the whole skill to a file the container cannot run anyway
   * left the agent without it. The skill's own `SKILL.md` is not optional:
   * when that is too large the skill is not staged at all.
   */
  private async tree(
    source: string,
    destinationRoot: string,
    relative: string,
    exclude: readonly string[],
    withholdCredentials: boolean,
    options: { skill?: boolean; verify?: () => Promise<void> } = {},
  ): Promise<void> {
    const { skill = false, verify } = options;
    const listed = await listTree(source, this.limits.directoryEntries, exclude);
    const skipped = new Map<SkipReason, number>();
    const leaveOut = (reason: SkipReason, count = 1) =>
      skipped.set(reason, (skipped.get(reason) ?? 0) + count);
    if (listed.symlinks > 0) leaveOut("symlink", listed.symlinks);
    const oversized = (entry: TreeEntry) =>
      entry.kind === "file" && entry.size > this.limits.fileBytes;
    // Only a skill's optional files may be left out; its SKILL.md never is.
    const optional = (entry: TreeEntry) => skill && entry.relative !== "SKILL.md";
    const dropped = listed.entries.filter((entry) => oversized(entry) && optional(entry)).length;
    const entries = dropped
      ? listed.entries.filter((entry) => !(oversized(entry) && optional(entry)))
      : listed.entries;
    if (dropped > 0) leaveOut("too-large", dropped);
    const bytes = entries.reduce((sum, entry) => sum + entry.size, 0);
    if (bytes > this.limits.directoryBytes) throw new Skip("too-large");
    if (entries.some(oversized)) throw new Skip("too-large");
    const files = entries.filter((entry) => entry.kind === "file");
    if (!this.total.fits(files.length, bytes)) throw new Skip("aggregate-budget");
    await this.afterListing?.(source);
    await mkdir(path.join(destinationRoot, relative), { recursive: true, mode: 0o700 });
    let copied = 0;
    let copiedBytes = 0;
    try {
      for (const entry of entries) {
        const target = path.join(destinationRoot, relative, entry.relative);
        if (entry.kind === "directory") {
          await mkdir(target, { recursive: true, mode: 0o700 });
          continue;
        }
        try {
          copiedBytes +=
            (await copyRegularFile(
              path.join(source, entry.relative),
              target,
              this.limits.fileBytes,
              this.cloner,
              undefined,
              withholdCredentials
                ? extensionCredentialGuard(`${relative}/${entry.relative}`)
                : undefined,
            )) ?? 0;
          copied += 1;
        } catch (error) {
          // One file changing mid-copy skips that file, not its siblings. A
          // file that grew past the bound since listing does too, in a skill.
          if (error instanceof Skip && (error.reason !== "too-large" || optional(entry))) {
            leaveOut(error.reason);
          } else throw error;
        }
        if (copiedBytes > this.limits.directoryBytes) throw new Skip("too-large");
      }
      await verify?.();
    } catch (error) {
      await rm(path.join(destinationRoot, relative), { recursive: true, force: true });
      throw error;
    }
    for (const [reason, count] of skipped) this.skip(reason, count);
    this.record(copied, copiedBytes);
  }

  async directory(
    root: string,
    spec: {
      path: string;
      mode: DirectoryMode;
      exclude?: readonly string[];
      withholdCredentials?: boolean;
      skills?: boolean;
    },
    destinationRoot: string,
  ): Promise<void> {
    const relative = spec.path === "." ? "" : spec.path;
    try {
      if (relative) await assertNoSymlinkAncestry(root, `${relative}/x`);
      else await assertNoSymlinkAncestry(root, "x");
      if (spec.mode === "tree") {
        await this.unit(
          root,
          relative || ".",
          destinationRoot,
          spec.exclude ?? [],
          spec.withholdCredentials,
        );
        return;
      }
      const directory = path.join(root, relative);
      const stat = await lstat(directory).catch(() => null);
      if (!stat) return;
      if (stat.isSymbolicLink()) throw new Skip("symlink");
      if (!stat.isDirectory()) throw new Skip("not-regular");
      const names = (await readdir(directory))
        .sort()
        .filter((name) => !(spec.exclude ?? []).includes(name));
      if (names.length > this.limits.directoryEntries) throw new Skip("too-many-entries");
      for (const name of names) {
        try {
          await this.unit(
            root,
            relative ? `${relative}/${name}` : name,
            destinationRoot,
            [],
            spec.withholdCredentials,
            spec.skills === true,
          );
        } catch (error) {
          if (error instanceof Skip) this.skip(error.reason);
          else this.skip("unreadable");
        }
      }
    } catch (error) {
      if (error instanceof Skip) this.skip(error.reason);
      else if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.skip("unreadable");
    }
  }
}

function portableInputsDirectory(dataDir: string, environmentId: string): string {
  return environmentStateDirectory(dataDir, "portable-inputs", environmentId);
}

/** One revision's directory. Callers validate the revision name first. */
export function portableInputRevisionDirectory(
  dataDir: string,
  environmentId: string,
  revision: string,
): string {
  if (!/^r[0-9a-z]+-[0-9a-f]{8}$/.test(revision)) throw new Error("Invalid input revision");
  return path.join(portableInputsDirectory(dataDir, environmentId), revision);
}

/**
 * Stages the allowlisted inputs of `providers` into a new revision for one
 * environment and returns the bind mounts that expose it. Only staged
 * subtrees are mounted — never the revision's parent, never another
 * environment's revisions.
 */
export async function stagePortableInputs(
  dataDir: string,
  environmentId: string,
  providers: ReadonlySet<ProviderInputSpec["provider"]>,
  roots: InputSourceRoots,
  now = new Date(),
  limits: InputLimits = INPUT_LIMITS,
  options: StagingOptions = {},
): Promise<StagedInputs> {
  const parent = portableInputsDirectory(dataDir, environmentId);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700);
  const revision = `r${now.getTime().toString(36)}-${randomUUID().slice(0, 8)}`;
  const partial = path.join(parent, `.${revision}.partial`);
  const directory = path.join(parent, revision);
  await mkdir(partial, { mode: 0o700 });
  const total = new Budget(limits.totalEntries, limits.totalBytes);
  const cloner = new FileCloner(options);
  const summaries: ProviderInputSummary[] = [];
  const mounts: StagedMount[] = [];
  try {
    const specs = portableInputSpec(roots);
    const homes = await Promise.all(
      [roots.home, ...(roots.agentTestHostHome ? [roots.agentTestHostHome] : [])].map((home) =>
        realpath(home).catch(() => path.resolve(home)),
      ),
    );
    const skillRoots = await linkedSkillRoots(specs, providers, homes);
    for (const spec of specs) {
      if (!providers.has(spec.provider)) continue;
      const copier = new ProviderCopier(
        spec.provider,
        total,
        limits,
        skillRoots,
        cloner,
        options.afterListing,
      );
      for (const source of spec.directories) {
        if (!source.root) continue;
        // The home entry itself is resolved, as the bind mount it replaces
        // was (a dotfiles manager may link it); nothing below it is followed.
        const root = await realpath(source.root).catch(() => null);
        if (!root) continue;
        if (spec.provider === SHARED_SKILLS_INPUT && !safeSkillRoot(root, homes)) {
          copier.skip("symlink");
          continue;
        }
        const stageRoot = path.join(partial, source.stage);
        for (const file of source.files ?? []) {
          await copier.file(root, file, stageRoot, source.filteredFiles?.[file]);
          if (source.accessOnlyLogin?.file === file) {
            const adjustment = await restrictStagedLogin(
              path.join(stageRoot, file),
              source.accessOnlyLogin.restrict,
              now,
            );
            if (adjustment) copier.adjustLogin(adjustment, source.accessOnlyLogin.quiet === true);
          }
        }
        for (const directory of source.directories ?? []) {
          await copier.directory(root, directory, stageRoot);
        }
        if (
          await lstat(stageRoot).then(
            () => true,
            () => false,
          )
        ) {
          // Two sources may feed one stage (an account's login beside the
          // host's configuration); the stage is still one mount.
          if (!mounts.some((mount) => mount.target === source.target)) {
            mounts.push({ source: path.join(directory, source.stage), target: source.target });
          }
        }
      }
      for (const file of spec.files) {
        if (!file.source) continue;
        const real = await realpath(file.source).catch(() => null);
        if (!real) continue;
        const staged = path.join(partial, "files", file.stage);
        await copier.file(path.dirname(real), path.basename(real), staged, file.filter);
        const stagedFile = path.join(staged, path.basename(real));
        if (
          await lstat(stagedFile).then(
            () => true,
            () => false,
          )
        ) {
          mounts.push({
            source: path.join(directory, "files", file.stage, path.basename(real)),
            target: file.target,
          });
        }
      }
      summaries.push(copier.summary);
    }
    const stagedAt = now.toISOString();
    await writeFile(
      path.join(partial, "manifest.json"),
      JSON.stringify({
        specVersion: PORTABLE_INPUT_SPEC_VERSION,
        revision,
        stagedAt,
        providers: summaries,
      }),
      { mode: 0o600 },
    );
    await rename(partial, directory);
    return {
      revision,
      directory,
      mounts,
      providers: summaries,
      specVersion: PORTABLE_INPUT_SPEC_VERSION,
      stagedAt,
      clonedFiles: cloner.cloned,
    };
  } catch (error) {
    await rm(partial, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

interface LoginAdjustment {
  withheld: boolean;
  originalBytes: number;
  bytes: number;
  /** Provider logins left out of a file that is still staged. */
  dropped?: number;
}

/**
 * Rewrite a just-staged file through `restrict` (a login made access-only, or
 * a filtered file), or remove it, returning the accounting adjustment. An
 * absent file was never counted and needs no adjustment.
 */
async function restrictStagedLogin(
  file: string,
  restrict: AccessOnlyLoginRestriction,
  now: Date,
): Promise<LoginAdjustment | undefined> {
  const contents = await readFile(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (contents === undefined) return undefined;
  const originalBytes = contents.byteLength;
  const restricted = restrict(contents.toString("utf8"), now.getTime());
  if ("withheld" in restricted) {
    await rm(file, { force: true });
    return { withheld: true, originalBytes, bytes: 0 };
  }
  // The staged copy is private to this revision and not yet mounted.
  await rm(file, { force: true });
  await writeFile(file, restricted.text, { mode: 0o600, flag: "wx" });
  return {
    withheld: false,
    originalBytes,
    bytes: Buffer.byteLength(restricted.text),
    dropped: restricted.dropped,
  };
}

const ACCESS_ONLY_LOGINS: Record<AccessOnlyLoginProvider, AccessOnlyLoginRestriction> = {
  claude: restrictClaudeCredentialsSnapshot,
  codex: restrictCodexAuthSnapshot,
  grok: restrictGrokAuthSnapshot,
  opencode: restrictOpenCodeAuthSnapshot,
  pi: restrictPiAuthSnapshot,
};

/** Providers whose staged login file a container may only hold access-only. */
export type AccessOnlyLoginProvider = "claude" | "codex" | "grok" | "opencode" | "pi";

/**
 * The access-only form of a login a running container or a restaged revision
 * is about to receive, or undefined when it must receive none.
 */
export function accessOnlyLoginText(
  provider: AccessOnlyLoginProvider,
  text: string | undefined,
  nowMs = Date.now(),
): string | undefined {
  if (text === undefined) return undefined;
  const restricted = ACCESS_ONLY_LOGINS[provider](text, nowMs);
  return "text" in restricted ? restricted.text : undefined;
}

/**
 * Where an image's root entrypoint relays a staged mount `node` cannot read
 * (`staged-inputs` 3, `relay_staged_inputs` in
 * `docker/network-policy-entrypoint.sh`): under rootless Docker the backend's
 * user is container root. Each mount keeps its target path below it.
 */
export const STAGED_INPUT_RELAY_DIR = "/run/orkestrator-inputs";

/**
 * The relayed copies of one provider's staged mounts inside a container.
 * Revocation removes them with the imported files, because a running
 * container keeps its relay until its next boot rebuilds it.
 */
export function stagedInputRelayPaths(provider: ProviderInputSpec["provider"]): string[] {
  const spec = portableInputSpec({ home: "/", agentTest: false }).find(
    (entry) => entry.provider === provider,
  );
  if (!spec) return [];
  const targets = [
    ...spec.directories.map((source) => source.target),
    ...spec.files.map((file) => file.target),
  ];
  return [...new Set(targets)].map((target) => `${STAGED_INPUT_RELAY_DIR}${target}`);
}

/** Docker arguments binding exactly the staged subtrees, read-only. */
export function stagedInputMountArguments(staged: StagedInputs): string[] {
  // `--mount` (unlike `-v`) fails on a missing source instead of creating a
  // host directory.
  return staged.mounts.flatMap((mount) => [
    "--mount",
    `type=bind,src=${mount.source},dst=${mount.target},readonly`,
  ]);
}

/**
 * Removes this environment's revisions that no container still binds.
 * `referenced` must come from Docker (labels of every container of the
 * environment, including recovery copies); a stopped container whose bind
 * source is gone could not start again.
 */
export async function pruneInputRevisions(
  dataDir: string,
  environmentId: string,
  referenced: ReadonlySet<string>,
  now = Date.now(),
): Promise<number> {
  const parent = portableInputsDirectory(dataDir, environmentId);
  const names = await readdir(parent).catch(() => [] as string[]);
  let removed = 0;
  for (const name of names) {
    if (referenced.has(name)) continue;
    if (!/^\.?r[0-9a-z]+-[0-9a-f]{8}(\.partial)?$/.test(name)) continue;
    // A revision (or a partial one) this recent may belong to a staging or a
    // container creation still in progress, whose label does not exist yet.
    const modified = await lstat(path.join(parent, name)).then(
      (info) => info.mtimeMs,
      () => null,
    );
    if (modified === null || now - modified < INPUT_REVISION_PRUNE_GRACE_MS) continue;
    await rm(path.join(parent, name), { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

/** Unreferenced revisions younger than this are kept. */
export const INPUT_REVISION_PRUNE_GRACE_MS = 30 * 60_000;

/**
 * Empties one provider's staged inputs inside an existing revision, so a
 * container that binds the revision sees nothing of that provider from now
 * on, including after a restart (its entrypoint imports from these mounts).
 * Directory mounts are emptied in place; a file mount keeps its inode (a bind
 * mount would otherwise go on showing the deleted file) and is truncated.
 * Returns false when the revision does not exist.
 */
export async function scrubStagedProvider(
  dataDir: string,
  environmentId: string,
  revision: string,
  provider: ProviderInputSpec["provider"],
): Promise<boolean> {
  if (!/^r[0-9a-z]+-[0-9a-f]{8}$/.test(revision)) return false;
  const directory = path.join(portableInputsDirectory(dataDir, environmentId), revision);
  const exists = await lstat(directory).then(
    (info) => info.isDirectory(),
    () => false,
  );
  if (!exists) return false;
  // Stage names do not depend on where the sources live.
  const spec = portableInputSpec({ home: "/", agentTest: false }).find(
    (entry) => entry.provider === provider,
  );
  if (!spec) return true;
  for (const source of spec.directories) {
    const stageRoot = path.join(directory, source.stage);
    const entries = await readdir(stageRoot).catch(() => [] as string[]);
    for (const entry of entries) {
      await rm(path.join(stageRoot, entry), { recursive: true, force: true });
    }
  }
  for (const file of spec.files) {
    const stageDirectory = path.join(directory, "files", file.stage);
    const entries = await readdir(stageDirectory).catch(() => [] as string[]);
    for (const entry of entries) {
      const target = path.join(stageDirectory, entry);
      const info = await lstat(target).catch(() => null);
      if (info?.isFile()) await truncate(target, 0);
    }
  }
  return true;
}

export interface EnvironmentInputsManifest {
  revision: string;
  stagedAt: string;
  specVersion: number;
  providers: ProviderInputSummary[];
}

export async function readInputsManifest(
  dataDir: string,
  environmentId: string,
  revision: string,
): Promise<EnvironmentInputsManifest | null> {
  if (!/^r[0-9a-z]+-[0-9a-f]{8}$/.test(revision)) return null;
  const file = path.join(
    portableInputsDirectory(dataDir, environmentId),
    revision,
    "manifest.json",
  );
  try {
    const handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (stat.size > 256 * 1024) return null;
      const parsed = JSON.parse(
        (await handle.readFile()).toString("utf8"),
      ) as EnvironmentInputsManifest;
      return parsed && typeof parsed.revision === "string" ? parsed : null;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/**
 * Replace one staged file inside an existing revision, e.g. the login after
 * the active agent account changed. The entrypoint imports from these mounts
 * on every start, so this is what a restarted container picks up.
 *
 * `relative` names a file under the revision (`codex-home/auth.json`). A file
 * inside a staged directory is swapped atomically; a file that is itself a
 * bind mount (`inPlace`) must keep its inode, so it is rewritten in place and
 * only when it already exists. `undefined` contents remove (or, in place,
 * truncate) the file. Returns false when nothing could be written: the
 * revision or its stage does not exist.
 */
export async function replaceStagedInputFile(
  dataDir: string,
  environmentId: string,
  revision: string,
  relative: string,
  contents: string | undefined,
  options: { inPlace?: boolean } = {},
): Promise<boolean> {
  if (!/^r[0-9a-z]+-[0-9a-f]{8}$/.test(revision)) return false;
  const parts = relative.split("/");
  if (parts.length < 2 || parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("Staged input path is not valid");
  }
  const directory = path.join(portableInputsDirectory(dataDir, environmentId), revision);
  try {
    await assertNoSymlinkAncestry(directory, relative);
  } catch {
    return false;
  }
  const target = path.join(directory, relative);
  const current = await lstat(target).catch(() => null);
  if (current?.isSymbolicLink()) return false;
  if (options.inPlace) {
    if (!current?.isFile()) return false;
    const handle = await open(
      target,
      fsConstants.O_WRONLY | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
    );
    try {
      if (contents !== undefined) await handle.writeFile(contents, "utf8");
    } finally {
      await handle.close();
    }
    return true;
  }
  if (contents === undefined) {
    await rm(target, { force: true });
    return true;
  }
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return true;
}
