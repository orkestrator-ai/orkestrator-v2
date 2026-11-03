/**
 * Prepare a private Playwright browsers directory in which WebKit launches on
 * a Linux distribution Playwright does not support (Arch and its derivatives).
 *
 * Playwright installs its Ubuntu 24.04 WebKit bundle on such hosts. The bundle
 * links against ICU 74, libxml2 2.9 and flite, which a rolling distribution
 * ships under newer sonames or not at all, so every WebKit launch fails with
 * "Host system is missing dependencies". `playwright install-deps` uses `apt`
 * and cannot help, and the bundle's `MiniBrowser` wrapper overwrites
 * `LD_LIBRARY_PATH`, so the libraries cannot be supplied from outside either.
 *
 * This script builds a separate `PLAYWRIGHT_BROWSERS_PATH` instead:
 *
 * - a copy of the shared `webkit-<revision>` directory, with the missing
 *   libraries from pinned, SHA-256-verified Ubuntu 24.04 packages added to
 *   `minibrowser-wpe/sys/lib` (the headless engine's own library directory);
 * - symlinks to every other browser in the shared cache.
 *
 * It needs no root and changes neither the host's libraries nor the shared
 * browser cache, which concurrent builds rely on:
 *
 *   mise run test:preview:webkit-libs
 *   PLAYWRIGHT_BROWSERS_PATH="$(bun scripts/playwright-webkit-host-libs.ts --print-path)" \
 *     mise run test:preview:browser
 *
 * The directory lives outside the worktree on purpose: `mise run format:check`
 * scans untracked files and fails on the bundle's `protocol.json`.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants, createWriteStream, existsSync, realpathSync } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";

const repoRoot = path.resolve(import.meta.dir, "..");

/**
 * The Ubuntu release whose WebKit bundle Playwright installs on a distribution
 * it does not support (its platform detection falls back to `ubuntu24.04`).
 *
 * What needs maintaining is this pairing, not the WebKit revision: the
 * libraries the bundle wants depend on the Ubuntu release it was built for, so
 * a new Playwright revision on the same release needs nothing here. If a
 * Playwright upgrade moves the fallback to another release (it already ships
 * an `ubuntu26.04` build), the check at the end of `main` fails naming the
 * libraries that are still missing; replace `HOST_LIBRARY_PACKAGES` with that
 * release's packages and update this constant. Launchpad keeps superseded
 * package files, so the current pins stay downloadable meanwhile.
 */
export const UBUNTU_BASE = "ubuntu24.04";

export interface HostLibraryPackage {
  name: string;
  version: string;
  /** Pool path below the archive root, as in the `Filename` field of `Packages`. */
  filename: string;
  size: number;
  sha256: string;
}

/**
 * The Ubuntu 24.04 amd64 packages that provide the libraries the WebKit bundle
 * cannot find on Arch: `libicu{data,i18n,uc}.so.74`, `libxml2.so.2` and the
 * thirteen `libflite*.so.1` libraries.
 *
 * Size and SHA-256 are copied from the `noble-updates/main` (ICU, libxml2) and
 * `noble/universe` (flite) `Packages` indexes as read on 2026-11-03. To refresh
 * them, read the same fields from
 * `https://archive.ubuntu.com/ubuntu/dists/<suite>/<component>/binary-amd64/Packages.xz`.
 */
export const HOST_LIBRARY_PACKAGES: readonly HostLibraryPackage[] = [
  {
    name: "libicu74",
    version: "74.2-1ubuntu3.1",
    filename: "pool/main/i/icu/libicu74_74.2-1ubuntu3.1_amd64.deb",
    size: 10_860_078,
    sha256: "c9a70989678660eed9a1e904c74fa043da8bec8e2036856fc16e31ced79b04f8",
  },
  {
    name: "libxml2",
    version: "2.9.14+dfsg-1.3ubuntu3.10",
    filename: "pool/main/libx/libxml2/libxml2_2.9.14+dfsg-1.3ubuntu3.10_amd64.deb",
    size: 763_592,
    sha256: "c5a065f85c1e6f605741e365e40cad71c3ceb0e85e2791400bd35b8896e12ad1",
  },
  {
    name: "libflite1",
    version: "2.2-6build3",
    filename: "pool/universe/f/flite/libflite1_2.2-6build3_amd64.deb",
    size: 13_601_102,
    sha256: "367f1d0da5cd38759a0515eafc27aa133b2d7bf99308cac34831df0212e96b75",
  },
];

/**
 * Where a package can be fetched. The archive pool drops a version once an
 * update supersedes it; Launchpad keeps every published file, so it is the
 * fallback. Both are checked against the same pinned digest.
 */
export function packageUrls(pkg: HostLibraryPackage): string[] {
  return [
    `https://archive.ubuntu.com/ubuntu/${pkg.filename}`,
    `https://launchpad.net/ubuntu/+archive/primary/+files/${path.posix.basename(pkg.filename)}`,
  ];
}

/** Playwright's ldd directories for WebKit (`registry` in playwright-core). */
export const WEBKIT_LDD_DIRECTORIES = [
  "minibrowser-gtk",
  "minibrowser-gtk/bin",
  "minibrowser-gtk/lib",
  "minibrowser-gtk/sys/lib",
  "minibrowser-wpe",
  "minibrowser-wpe/bin",
  "minibrowser-wpe/lib",
  "minibrowser-wpe/sys/lib",
];

/** The headless engine's private library directory, which its wrapper puts on the path. */
export const WEBKIT_LIBRARY_DIRECTORY = "minibrowser-wpe/sys/lib";

const STAMP_FILE = ".orkestrator-host-libs.json";
const MULTIARCH_DIRECTORY = "usr/lib/x86_64-linux-gnu/";
const SHARED_LIBRARY_NAME = /^lib[A-Za-z0-9_+.-]*\.so(\.[0-9]+)*$/;
const LAUNCH_CHECK_TIMEOUT_MS = 90_000;
/** Covers the body too, so a stalled mirror fails over instead of hanging. */
const DOWNLOAD_TIMEOUT_MS = 300_000;
const MAX_CHILD_OUTPUT_BYTES = 16_000;

// ---------------------------------------------------------------------------
// Archive readers. A `.deb` is an `ar` archive whose `data.tar.*` member holds
// the files; both formats are simple enough to read here, which keeps the
// untrusted download away from any external extraction tool.
// ---------------------------------------------------------------------------

/** Bytes backed by a plain `ArrayBuffer`, which Bun's decompressors require. */
type Bytes = Uint8Array<ArrayBuffer>;

export interface ArMember {
  name: string;
  data: Bytes;
}

const decoder = new TextDecoder();

function field(bytes: Uint8Array, start: number, length: number): string {
  const raw = decoder.decode(bytes.subarray(start, start + length));
  const nul = raw.indexOf("\0");
  return nul === -1 ? raw : raw.slice(0, nul);
}

export function readAr(bytes: Bytes): ArMember[] {
  if (field(bytes, 0, 8) !== "!<arch>\n") throw new Error("not an ar archive");
  const members: ArMember[] = [];
  let offset = 8;
  while (offset + 60 <= bytes.length) {
    const name = field(bytes, offset, 16).trim().replace(/\/$/, "");
    const size = Number.parseInt(field(bytes, offset + 48, 10).trim(), 10);
    if (field(bytes, offset + 58, 2) !== "`\n" || !Number.isSafeInteger(size) || size < 0) {
      throw new Error("malformed ar member header");
    }
    const start = offset + 60;
    if (start + size > bytes.length) throw new Error(`truncated ar member ${name}`);
    members.push({ name, data: bytes.subarray(start, start + size) });
    offset = start + size + (size % 2);
  }
  return members;
}

export type TarEntryType = "file" | "symlink" | "other";

export interface TarEntry {
  path: string;
  type: TarEntryType;
  linkTarget: string;
  data: Uint8Array;
}

function octal(bytes: Uint8Array, start: number, length: number): number {
  if ((bytes[start]! & 0x80) !== 0) throw new Error("base-256 tar numbers are not supported");
  const text = field(bytes, start, length).trim();
  if (text === "") return 0;
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`malformed tar number ${text}`);
  return value;
}

function paxPath(data: Uint8Array): string | undefined {
  // Records are "<length> <key>=<value>\n".
  for (const record of decoder.decode(data).split("\n")) {
    const match = /^\d+ path=(.*)$/.exec(record);
    if (match) return match[1];
  }
  return undefined;
}

export function readTar(bytes: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let longName: string | undefined;
  let longLink: string | undefined;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = octal(header, 124, 12);
    const typeflag = String.fromCharCode(header[156]!);
    const start = offset + 512;
    if (start + size > bytes.length) throw new Error("truncated tar entry");
    const data = bytes.subarray(start, start + size);
    offset = start + Math.ceil(size / 512) * 512;

    if (typeflag === "L") {
      longName = field(data, 0, data.length);
      continue;
    }
    if (typeflag === "K") {
      longLink = field(data, 0, data.length);
      continue;
    }
    if (typeflag === "x") {
      longName = paxPath(data) ?? longName;
      continue;
    }
    if (typeflag === "g") continue;

    const prefix = field(header, 257, 6).startsWith("ustar") ? field(header, 345, 155) : "";
    const shortName = field(header, 0, 100);
    const entryPath = longName ?? (prefix ? `${prefix}/${shortName}` : shortName);
    const linkTarget = longLink ?? field(header, 157, 100);
    longName = undefined;
    longLink = undefined;
    const type: TarEntryType =
      typeflag === "0" || typeflag === "\0" ? "file" : typeflag === "2" ? "symlink" : "other";
    entries.push({ path: entryPath, type, linkTarget, data });
  }
  return entries;
}

export function decompressDataMember(member: ArMember): Uint8Array {
  if (member.name === "data.tar") return member.data;
  if (member.name === "data.tar.zst") return Bun.zstdDecompressSync(member.data);
  if (member.name === "data.tar.gz") return Bun.gunzipSync(member.data);
  throw new Error(`unsupported package payload ${member.name}`);
}

export interface SharedLibrary {
  name: string;
  /** Present for a regular file. */
  data?: Uint8Array;
  /** Present for a symlink; always a bare name in the same directory. */
  linkTarget?: string;
}

/**
 * The shared libraries a package installs into the amd64 multiarch directory.
 * Anything else (documentation, nested directories, links that leave the
 * directory) is ignored, so nothing from the archive can name a path outside
 * the library directory it is copied into.
 */
export function sharedLibrariesInDeb(bytes: Bytes): SharedLibrary[] {
  const dataMember = readAr(bytes).find((member) => member.name.startsWith("data.tar"));
  if (!dataMember) throw new Error("package has no data archive");
  const libraries: SharedLibrary[] = [];
  for (const entry of readTar(decompressDataMember(dataMember))) {
    const normalized = entry.path.replace(/^\.\//, "");
    if (!normalized.startsWith(MULTIARCH_DIRECTORY)) continue;
    const name = normalized.slice(MULTIARCH_DIRECTORY.length);
    if (!SHARED_LIBRARY_NAME.test(name)) continue;
    if (entry.type === "file") libraries.push({ name, data: entry.data });
    else if (entry.type === "symlink" && SHARED_LIBRARY_NAME.test(entry.linkTarget)) {
      libraries.push({ name, linkTarget: entry.linkTarget });
    }
  }
  return libraries;
}

// ---------------------------------------------------------------------------
// Download and verification.
// ---------------------------------------------------------------------------

export type Fetch = (url: string) => Promise<Response>;

const fetchWithTimeout: Fetch = (url) =>
  fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });

/**
 * Stream one URL to `destination`, refusing more bytes than the pinned size,
 * and return its SHA-256.
 */
async function downloadTo(
  url: string,
  destination: string,
  maxBytes: number,
  fetchImpl: Fetch,
): Promise<{ size: number; sha256: string }> {
  const response = await fetchImpl(url);
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
  const hash = createHash("sha256");
  const out = createWriteStream(destination, { flags: "wx", mode: 0o600 });
  let size = 0;
  // Pipeline owns backpressure and tears down both ends on read or write errors.
  await pipeline(
    response.body as unknown as AsyncIterable<Uint8Array>,
    async function* (source: AsyncIterable<Uint8Array>) {
      for await (const chunk of source) {
        size += chunk.byteLength;
        if (size > maxBytes) throw new Error(`more than the pinned ${maxBytes} bytes`);
        hash.update(chunk);
        yield chunk;
      }
    },
    out,
  );
  return { size, sha256: hash.digest("hex") };
}

/**
 * Download a package into `directory` and return its bytes once both its size
 * and SHA-256 match the pin. A mismatch or failure on one URL moves on to the
 * next; nothing unverified is ever returned.
 */
export async function downloadVerifiedPackage(
  pkg: HostLibraryPackage,
  directory: string,
  fetchImpl: Fetch = fetchWithTimeout,
  log: (message: string) => void = () => {},
): Promise<Bytes> {
  const destination = path.join(directory, path.posix.basename(pkg.filename));
  const failures: string[] = [];
  for (const url of packageUrls(pkg)) {
    await rm(destination, { force: true });
    try {
      const actual = await downloadTo(url, destination, pkg.size, fetchImpl);
      if (actual.size !== pkg.size) throw new Error(`size ${actual.size}, expected ${pkg.size}`);
      if (actual.sha256 !== pkg.sha256)
        throw new Error(`SHA-256 ${actual.sha256}, expected ${pkg.sha256}`);
      log(
        `verified ${pkg.name} ${pkg.version} (sha256 ${pkg.sha256.slice(0, 12)}…) from ${new URL(url).host}`,
      );
      return new Uint8Array(await readFile(destination));
    } catch (error) {
      await rm(destination, { force: true });
      failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(
    `could not download a verified ${pkg.name} ${pkg.version}:\n  ${failures.join("\n  ")}`,
  );
}

// ---------------------------------------------------------------------------
// Dependency check, mirroring Playwright's own `validateDependenciesLinux`.
// ---------------------------------------------------------------------------

/** Library names `ldd` reported as `not found`. */
export function parseLddMissing(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith("not found") && line.includes("=>"))
    .map((line) => line.split("=>")[0]!.trim());
}

interface ChildResult {
  code: number | null;
  output: string;
  timedOut: boolean;
}

function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const append = (chunk: Buffer) => {
      if (output.length < MAX_CHILD_OUTPUT_BYTES)
        output += chunk.toString("utf8").slice(0, MAX_CHILD_OUTPUT_BYTES - output.length);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    let timedOut = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, options.timeoutMs)
      : undefined;
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, output, timedOut });
    });
  });
}

async function isElfOrSharedLibrary(filePath: string): Promise<boolean> {
  const stats = await lstat(filePath);
  if (!stats.isFile()) return false;
  if (/\.so(\.|$)/.test(path.basename(filePath))) return true;
  if ((stats.mode & 0o111) === 0) return false;
  const handle = Bun.file(filePath).slice(0, 4);
  const magic = new Uint8Array(await handle.arrayBuffer());
  return magic[0] === 0x7f && magic[1] === 0x45 && magic[2] === 0x4c && magic[3] === 0x46;
}

/** Every library `ldd` cannot resolve in the bundle, as Playwright checks before launch. */
export async function missingWebkitLibraries(
  webkitDirectory: string,
  runner = run,
): Promise<string[]> {
  const directories = WEBKIT_LDD_DIRECTORIES.map((directory) =>
    path.join(webkitDirectory, directory),
  ).filter((directory) => existsSync(directory));
  const env = { ...process.env, LD_LIBRARY_PATH: directories.join(":") };
  const missing = new Set<string>();
  for (const directory of directories) {
    for (const name of await readdir(directory)) {
      const filePath = path.join(directory, name);
      if (!(await isElfOrSharedLibrary(filePath))) continue;
      const result = await runner("ldd", [filePath], { cwd: directory, env });
      if (result.code !== 0) continue;
      for (const library of parseLddMissing(result.output)) missing.add(library);
    }
  }
  return [...missing].sort();
}

// ---------------------------------------------------------------------------
// Preparing the private browsers directory.
// ---------------------------------------------------------------------------

export function sharedBrowsersDirectory(
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
): string {
  if (env.PLAYWRIGHT_BROWSERS_PATH === "0") {
    throw new Error(
      "PLAYWRIGHT_BROWSERS_PATH=0 uses package-local browsers; unset it or specify a shared cache path",
    );
  }
  if (env.PLAYWRIGHT_BROWSERS_PATH) {
    return path.resolve(env.PLAYWRIGHT_BROWSERS_PATH);
  }
  return path.join(env.XDG_CACHE_HOME || path.join(home, ".cache"), "ms-playwright");
}

/** Recover the original source after exporting this helper's output. */
export async function resolveSharedDirectory(
  directory: string,
  env = process.env,
): Promise<string> {
  const candidate = sharedBrowsersDirectory(env);
  if (physicalPath(candidate) !== physicalPath(directory)) return candidate;
  const source = JSON.parse(await readFile(path.join(directory, ".source.json"), "utf8")) as {
    shared: string;
  };
  if (typeof source.shared !== "string") throw new Error("invalid private cache source metadata");
  validatePrivateDirectory(directory, source.shared);
  return source.shared;
}

/** Resolve aliases even when the final path does not exist yet. */
function physicalPath(value: string): string {
  let existing = path.resolve(value);
  const suffix: string[] = [];
  while (true) {
    try {
      return path.join(realpathSync(existing), ...suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      suffix.unshift(path.basename(existing));
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
}

export function defaultPrivateDirectory(
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
): string {
  return path.join(
    env.XDG_CACHE_HOME || path.join(home, ".cache"),
    "orkestrator",
    `playwright-browsers-${UBUNTU_BASE}-libs`,
  );
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** The WebKit revision the repository's Playwright launches. */
export async function playwrightWebkitRevision(): Promise<string> {
  const requireFromRepo = createRequire(path.join(repoRoot, "package.json"));
  const requireFromPlaywright = createRequire(requireFromRepo.resolve("playwright/package.json"));
  // `browsers.json` is not in playwright-core's export map; its manifest is.
  const browsersJson = path.join(
    path.dirname(requireFromPlaywright.resolve("playwright-core/package.json")),
    "browsers.json",
  );
  const manifest = JSON.parse(await readFile(browsersJson, "utf8")) as {
    browsers: { name: string; revision: string }[];
  };
  const webkit = manifest.browsers.find((browser) => browser.name === "webkit");
  if (!webkit) throw new Error(`no webkit entry in ${browsersJson}`);
  return webkit.revision;
}

export function packagesFingerprint(
  revision: string,
  packages: readonly HostLibraryPackage[] = HOST_LIBRARY_PACKAGES,
): string {
  return JSON.stringify({
    webkitRevision: revision,
    packages: packages.map(({ name, version, sha256 }) => ({ name, version, sha256 })),
  });
}

async function readStamp(webkitDirectory: string): Promise<string | undefined> {
  try {
    return await readFile(path.join(webkitDirectory, STAMP_FILE), "utf8");
  } catch {
    return undefined;
  }
}

/** Write the package libraries into `libraryDirectory`, never replacing a file the bundle ships. */
export async function installLibraries(
  libraries: readonly SharedLibrary[],
  libraryDirectory: string,
): Promise<number> {
  let installed = 0;
  for (const library of libraries) {
    const target = path.join(libraryDirectory, library.name);
    if (await lstat(target).catch(() => undefined)) continue;
    if (library.data) await writeFile(target, library.data, { mode: 0o644, flag: "wx" });
    else if (library.linkTarget) await symlink(library.linkTarget, target);
    else continue;
    installed += 1;
  }
  return installed;
}

/** Point `<private>/<name>` at every browser in the shared cache except WebKit itself. */
async function linkSharedBrowsers(
  shared: string,
  target: string,
  webkitName: string,
): Promise<void> {
  for (const name of await readdir(shared)) {
    if (name.startsWith(".") || name === webkitName) continue;
    const source = path.join(shared, name);
    if (!(await lstat(source)).isDirectory()) continue;
    const link = path.join(target, name);
    const existing = await lstat(link).catch(() => undefined);
    if (existing && !existing.isSymbolicLink()) continue;
    if (existing) {
      if ((await readlink(link)) === source) continue;
      // Another worktree may still use a prepared, older WebKit revision.
      // Only the explicit idle-cache prune may retire that generation.
      if (/^webkit-\d+$/.test(name) && (await readStamp(link)) !== undefined) continue;
    }
    const temporary = `${link}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    await symlink(source, temporary);
    await rename(temporary, link);
  }
}

export interface PrepareOptions {
  directory: string;
  shared: string;
  revision: string;
  force?: boolean;
  /** Only when no browser or other cache reader is running. */
  prune?: boolean;
  /** Injected by tests; defaults to the pinned Ubuntu packages. */
  packages?: readonly HostLibraryPackage[];
  fetchImpl?: Fetch;
  log: (message: string) => void;
}

export async function preparePrivateBrowsers(options: PrepareOptions): Promise<string> {
  validatePrivateDirectory(options.directory, options.shared);
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const lock = path.join(options.directory, ".prepare-lock");
  const deadline = Date.now() + 300_000;
  while (true) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline)
        throw new Error(
          `cache locked: ${lock}; if its setup process died, remove this lock before retrying`,
        );
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try {
    return await prepareLocked(options);
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

async function prepareLocked(options: PrepareOptions): Promise<string> {
  const { directory, shared, revision, log } = options;
  const packages = options.packages ?? HOST_LIBRARY_PACKAGES;
  const webkitName = `webkit-${revision}`;
  const sharedWebkit = path.join(shared, webkitName);
  if (!existsSync(path.join(sharedWebkit, "INSTALLATION_COMPLETE"))) {
    throw new Error(
      `${sharedWebkit} is not installed. Install the engine first: mise exec -- bunx playwright install webkit`,
    );
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const privateWebkit = path.join(directory, webkitName);
  const fingerprint = packagesFingerprint(revision, packages);

  if (!options.force && (await readStamp(privateWebkit)) === fingerprint) {
    log(`${privateWebkit} is already prepared`);
  } else {
    const staging = path.join(
      directory,
      `.${webkitName}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`,
    );
    const downloads = await mkdtemp(path.join(os.tmpdir(), "orkestrator-webkit-debs-"));
    try {
      log(`copying ${sharedWebkit} (reflinked where the filesystem allows)`);
      await cp(sharedWebkit, staging, {
        recursive: true,
        verbatimSymlinks: true,
        mode: fsConstants.COPYFILE_FICLONE,
      });
      const libraryDirectory = path.join(staging, WEBKIT_LIBRARY_DIRECTORY);
      await mkdir(libraryDirectory, { recursive: true });
      for (const pkg of packages) {
        const bytes = await downloadVerifiedPackage(pkg, downloads, options.fetchImpl, log);
        const added = await installLibraries(sharedLibrariesInDeb(bytes), libraryDirectory);
        log(`added ${added} libraries from ${pkg.name}`);
      }
      await writeFile(path.join(staging, STAMP_FILE), fingerprint);
      const generation = path.join(
        directory,
        `.generation-${webkitName}-${randomBytes(8).toString("hex")}`,
      );
      const existing = await lstat(privateWebkit).catch(() => undefined);
      if (existing && !existing.isSymbolicLink()) {
        // A legacy real directory cannot be replaced atomically by a symlink.
        // Only migrate when the caller explicitly promises there are no readers.
        if (!options.prune)
          throw new Error("legacy private cache: stop readers and rerun with --prune");
        await rm(privateWebkit, { recursive: true });
      }
      await rename(staging, generation);
      const pointer = `${staging}.link`;
      try {
        await symlink(path.basename(generation), pointer);
        await rename(pointer, privateWebkit);
      } finally {
        await rm(pointer, { force: true });
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
      await rm(downloads, { recursive: true, force: true });
    }
  }

  const sourceTemporary = path.join(directory, ".source.json.tmp");
  await writeFile(sourceTemporary, JSON.stringify({ shared: physicalPath(shared) }));
  await rename(sourceTemporary, path.join(directory, ".source.json"));
  if (options.prune) {
    const current = physicalPath(privateWebkit);
    for (const name of await readdir(directory)) {
      if (
        !/^(?:webkit-\d+(?:\.old-[\w-]+)?$|\.generation-webkit-\d+-[a-f0-9]+$|\.webkit-\d+\.tmp-[\w.-]+$)/.test(
          name,
        )
      )
        continue;
      const entry = path.join(directory, name);
      if (entry === privateWebkit || physicalPath(entry) === current) continue;
      await rm(entry, { recursive: true, force: true });
    }
  }
  await linkSharedBrowsers(shared, directory, webkitName);
  return privateWebkit;
}

/** Launch headless WebKit from the private directory and render a page. */
export async function launchCheck(directory: string, runner = run): Promise<void> {
  const script = [
    'const { webkit } = require("playwright");',
    "(async () => {",
    "  const browser = await webkit.launch({ headless: true });",
    "  const page = await browser.newPage();",
    '  await page.setContent("<p id=ok>ok</p>");',
    '  const text = await page.textContent("#ok");',
    "  await browser.close();",
    '  if (text !== "ok") throw new Error("unexpected page text");',
    '  console.log("webkit launched");',
    "})().catch((error) => { console.error(String(error?.message ?? error)); process.exit(1); });",
  ].join("\n");
  const result = await runner(process.execPath, ["-e", script], {
    cwd: repoRoot,
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: directory },
    timeoutMs: LAUNCH_CHECK_TIMEOUT_MS,
  });
  if (result.timedOut)
    throw new Error(`WebKit did not launch within ${LAUNCH_CHECK_TIMEOUT_MS / 1000}s`);
  if (result.code !== 0) throw new Error(`WebKit failed to launch:\n${result.output.trim()}`);
}

const USAGE = `Usage: bun scripts/playwright-webkit-host-libs.ts [options]

Prepare a private PLAYWRIGHT_BROWSERS_PATH in which Playwright's WebKit
launches on a Linux distribution Playwright does not support.

  --dir <path>         Private directory (default: ${defaultPrivateDirectory()})
  --print-path         Print only the directory on stdout (progress goes to stderr)
  --prune              Remove retired copies (stop all cache readers first)
  --force              Rebuild the private WebKit copy even if it is current
  --no-launch-check    Skip launching headless WebKit after the dependency check
  -h, --help           Show this help`;

export interface CliOptions {
  directory?: string;
  prune?: boolean;
  printPath: boolean;
  force: boolean;
  launchCheck: boolean;
  help: boolean;
}

export function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = { printPath: false, force: false, launchCheck: true, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--dir") {
      const value = argv[++index];
      if (!value) throw new Error("--dir needs a path");
      options.directory = value;
    } else if (arg.startsWith("--dir=")) options.directory = arg.slice("--dir=".length);
    else if (arg === "--print-path") options.printPath = true;
    else if (arg === "--prune") options.prune = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--no-launch-check") options.launchCheck = false;
    else if (arg === "-h" || arg === "--help") options.help = true;
    else throw new Error(`unknown argument ${arg}\n\n${USAGE}`);
  }
  return options;
}

export function validatePrivateDirectory(directory: string, shared: string): void {
  directory = physicalPath(directory);
  shared = physicalPath(shared);
  if (isInside(directory, physicalPath(repoRoot))) {
    throw new Error(
      `${directory} is inside the repository; choose a directory outside it ` +
        "(format:check scans untracked files and fails on the WebKit bundle)",
    );
  }
  if (isInside(directory, shared) || isInside(shared, directory)) {
    throw new Error(
      `${directory} overlaps the shared browser cache ${shared}; choose a separate directory`,
    );
  }
}

export async function main(
  argv = process.argv.slice(2),
  dependencies = {
    prepare: preparePrivateBrowsers,
    missing: missingWebkitLibraries,
    launch: launchCheck,
  },
  host: { platform: string; arch: string } = process,
): Promise<void> {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(USAGE);
    return;
  }
  if (host.platform !== "linux" || host.arch !== "x64") {
    throw new Error(
      `this script supplies Ubuntu 24.04 amd64 libraries and only applies to Linux x64 (this host is ${host.platform}-${host.arch})`,
    );
  }
  const log = (message: string) => console.error(`[webkit-host-libs] ${message}`);
  const directory = path.resolve(options.directory ?? defaultPrivateDirectory());
  const shared = await resolveSharedDirectory(directory);
  validatePrivateDirectory(directory, shared);
  const revision = await playwrightWebkitRevision();

  const privateWebkit = await dependencies.prepare({
    directory,
    shared,
    revision,
    force: options.force,
    prune: options.prune,
    log,
  });

  const missing = await dependencies.missing(privateWebkit);
  if (missing.length > 0) {
    throw new Error(
      `WebKit still cannot resolve: ${missing.join(", ")}. ` +
        `Add the ${UBUNTU_BASE} package that provides them to HOST_LIBRARY_PACKAGES, or, if ` +
        "Playwright now installs a different Ubuntu release's WebKit, replace the pins (see UBUNTU_BASE).",
    );
  }
  log("ldd resolves every WebKit library");

  if (options.launchCheck) {
    await dependencies.launch(directory);
    log("headless WebKit launched and rendered a page");
  }

  if (options.printPath) console.log(directory);
  else {
    log("ready. Run Playwright with:");
    console.log(`export PLAYWRIGHT_BROWSERS_PATH=${directory}`);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`[webkit-host-libs] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
