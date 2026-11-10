/**
 * The package cache of a launched OpenCode server
 * (docs/todo/containers-and-environments/7550-opencode-launch-follow-ups.md,
 * task 2).
 *
 * OpenCode installs two kinds of npm package at run time and imports them into
 * the server: the AI SDK package of a provider it does not bundle (the
 * `provider.<id>.npm` key) and, on 1.x, an npm plugin (an entry of `plugin`).
 * Both land in `$XDG_CACHE_HOME/opencode`, which was node's `~/.cache`, so the
 * agent's uid could change a package's code before the next start imported it.
 * Shown on 2026-11-10 against the pinned binaries: code planted in a cached
 * provider package ran inside the next 1.19.5 and 2.2.6 server.
 *
 * On an `opencode2-launch=1` image the launcher points both servers'
 * `XDG_CACHE_HOME` at a root-owned directory, which the server's uid can read
 * but not write. Both binaries start with a read-only cache once
 * `opencode/bin` exists, import a package already in it without installing it
 * again, and skip the models catalogue write. So:
 *
 * - **1.x**: before each start, root installs every package the user's own
 *   configuration (root's copy of the host input) names and the cache lacks,
 *   with the image's Bun (`--ignore-scripts`, so no package code runs as
 *   root), into the directory 1.19.5 looks in: `packages/<npm>` for a
 *   provider, `packages/<spec>@latest` for a plugin given without a version.
 *   1.19.5 imported a package Bun installed there. Packages stay across starts.
 *   An install that fails (no network, a firewall without the registry) leaves
 *   that provider or plugin unavailable; nothing falls back to node's cache.
 * - **2.x**: the cache is root-owned and empty. 2.2.6 names its install
 *   directories with dist-tags it chooses itself (`npm/@ai-sdk/elevenlabs@ai-v6`),
 *   so root cannot fill it the way 2.x would look for it; a provider 2.x does
 *   not bundle does not load in a container (2.x already withholds npm plugins).
 *
 * A project configuration can name a provider package too; it is never
 * installed: that would let the agent choose code the server imports.
 */
import {
  OPENCODE2_LAUNCH_CACHE_HOME,
  OPENCODE_LAUNCH_CACHE_HOME,
  OPENCODE_LAUNCH_CONFIG_DIR,
} from "./agent-credential-files.js";
import { CONTAINER_BRIDGE_LAUNCHER } from "./container-bridge-credential.js";
import { quoteShell } from "./commands-agent-support.js";
import type { OpenCodeServerKind } from "./opencode-listener-identity.js";

/** At most this many packages are installed per start. */
export const OPENCODE_PACKAGE_INSTALL_LIMIT = 16;
/** Seconds one package install may take. */
export const OPENCODE_PACKAGE_INSTALL_TIMEOUT_SECONDS = 120;

/** The image's Bun, run as root from `/` with no configuration or `.env` of the working directory. */
const ROOT_BUN = "/usr/local/bin/bun --config=/dev/null --no-env-file";

export interface OpenCodePackageInstall {
  /** What to install (`name` or `name@version`). */
  spec: string;
  /** The directory below `<cache>/opencode/packages` that 1.19.5 imports it from. */
  directory: string;
}

/**
 * The packages a 1.x configuration document makes the server install, where
 * it looks for them. Self-contained (it uses only `Bun.JSONC`), because the
 * root script runs its source with the image's Bun. Only plain registry specs
 * are kept: a path, URL, git or `file:` spec is something OpenCode resolves
 * without installing, and anything else could not be passed to a shell.
 */
export function openCodePackageInstalls(texts: readonly string[]): OpenCodePackageInstall[] {
  const SPEC =
    /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*(?:@[A-Za-z0-9][A-Za-z0-9._~^*+-]*)?$/;
  const jsonc = (globalThis as unknown as { Bun: { JSONC: { parse(text: string): unknown } } }).Bun
    .JSONC;
  const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const hasVersion = (spec: string) => spec.lastIndexOf("@") > 0;
  const installs = new Map<string, string>();
  for (const text of texts) {
    let document: unknown;
    try {
      document = jsonc.parse(text);
    } catch {
      continue;
    }
    if (!isObject(document)) continue;
    if (isObject(document.provider)) {
      for (const provider of Object.values(document.provider)) {
        const npm = isObject(provider) ? provider.npm : undefined;
        if (typeof npm === "string" && SPEC.test(npm)) installs.set(npm, npm);
      }
    }
    if (Array.isArray(document.plugin)) {
      for (const plugin of document.plugin) {
        if (typeof plugin !== "string" || !SPEC.test(plugin)) continue;
        installs.set(hasVersion(plugin) ? plugin : `${plugin}@latest`, plugin);
      }
    }
  }
  return [...installs].map(([directory, spec]) => ({ spec, directory }));
}

/** Where a launched server of `kind` keeps its package cache. */
export function openCodeLaunchCacheHome(kind: OpenCodeServerKind): string {
  return kind === "opencode2" ? OPENCODE2_LAUNCH_CACHE_HOME : OPENCODE_LAUNCH_CACHE_HOME;
}

/**
 * Root shell that makes `kind`'s cache root-owned and, for 1.x, installs the
 * packages root's copy of the user's configuration names. Runs only on an
 * image whose launcher points the server at it (`opencode2-launch=1`); on an
 * older one it does nothing. Never fails the start: an install that fails is
 * reported on stderr and its package stays unavailable.
 */
export function openCodePackageCacheScript(kind: OpenCodeServerKind): string {
  const cache = openCodeLaunchCacheHome(kind);
  const lines = [
    "set -u",
    "umask 022",
    `grep -q '^# ORKESTRATOR_CAPABILITY opencode2-launch=1$' ${CONTAINER_BRIDGE_LAUNCHER} 2>/dev/null || exit 0`,
    `cache=${cache}`,
    // A cache that is not root's (or not a directory) is rebuilt from nothing.
    `if [ -L "$cache" ] || { [ -e "$cache" ] && { [ ! -d "$cache" ] || [ "$(stat -c %u "$cache")" != 0 ]; }; }; then rm -rf "$cache"; fi`,
    // Both binaries create opencode/bin at start and fail when they cannot.
    `mkdir -p "$cache/opencode/bin" "$cache/opencode/packages"`,
    `chown -R 0:0 "$cache"`,
    `chmod -R u=rwX,go=rX "$cache"`,
  ];
  if (kind === "opencode2") return lines.join("\n");
  const program = `const fs = require("node:fs");
const path = require("node:path");
const installs = (${openCodePackageInstalls.toString()});
const dir = process.env.ORK_OPENCODE_CONFIG_DIR;
const texts = [];
for (const name of ["config.json", "opencode.json", "opencode.jsonc"]) {
  try { texts.push(fs.readFileSync(path.join(dir, name), "utf8")); } catch {}
}
for (const install of installs(texts).slice(0, ${OPENCODE_PACKAGE_INSTALL_LIMIT})) {
  process.stdout.write(install.directory + "\\t" + install.spec + "\\n");
}
`;
  return [
    ...lines,
    "cd /",
    `list=$(ORK_OPENCODE_CONFIG_DIR=${quoteShell(OPENCODE_LAUNCH_CONFIG_DIR)} ${ROOT_BUN} -e ${quoteShell(program)} 2>/dev/null) || list=""`,
    "printf '%s\\n' \"$list\" | while IFS=\"$(printf '\\t')\" read -r directory spec; do",
    '  [ -n "$directory" ] && [ -n "$spec" ] || continue',
    // The program printed only specs its pattern admits, so neither can leave the cache.
    '  case "$directory/$spec" in *..* | /*) continue ;; esac',
    '  target="$cache/opencode/packages/$directory"',
    '  [ -d "$target/node_modules" ] && continue',
    '  stage=$(mktemp -d "$cache/opencode/.stage.XXXXXX") || continue',
    `  if (cd "$stage" && printf '{}\\n' > package.json && timeout ${OPENCODE_PACKAGE_INSTALL_TIMEOUT_SECONDS} env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/root ${ROOT_BUN} add --exact --ignore-scripts --no-progress --no-summary "$spec" >/dev/null 2>&1); then`,
    '    rm -rf "$target"',
    '    mkdir -p "$(dirname "$target")"',
    '    chown -R 0:0 "$stage"',
    '    chmod -R u=rwX,go=rX "$stage"',
    '    mv "$stage" "$target"',
    "  else",
    '    rm -rf "$stage"',
    "    printf 'OpenCode package %s could not be installed into its root-owned cache\\n' \"$spec\" >&2",
    "  fi",
    "done",
    "exit 0",
  ].join("\n");
}
