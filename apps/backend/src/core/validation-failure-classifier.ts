/**
 * Environment-side classifier for a review package's failing tests.
 *
 * It reads only data that already exists — the validation commands' recorded
 * output, the branch's changed paths, the tests' static imports, the
 * repository's flake registry and the target branch's CI result — and never
 * runs a test. The contract it fills is `ValidationFailureTriage`
 * (`@orkestrator/protocol/validation-failure-triage`); the backend wraps it in
 * `validation-failure-triage-service.ts`.
 *
 * {@link classifyValidationFailures} executes inside the environment (a local
 * worktree or a container) through `bun -e`, so it is self-contained: it uses
 * only its arguments, Node built-ins reached through `req`, and the `Bun`
 * global. Do not reference anything outside the function body; it is shipped
 * as source by {@link VALIDATION_FAILURE_CLASSIFIER_SCRIPT}. Its limits mirror
 * the protocol's bounds, which `isValidationFailureTriage` enforces on the
 * result.
 */

export interface ValidationFailureClassifierCommand {
  command: string;
  /** Workspace-relative cwd the command ran in. */
  cwd: string;
  status: "failed" | "incomplete";
  stdoutPath: string | null;
  stderrPath: string | null;
}

export interface ValidationFailureClassifierInput {
  root: string;
  commands: ValidationFailureClassifierCommand[];
  /** Repository-relative paths the branch changed since its merge-base. */
  changedFiles: string[];
  /** Set when {@link changedFiles} was cut to fit the transport. */
  changedFilesTruncated?: boolean;
  mergeBase: string | null;
  /** The target branch's CI, read with `gh`; null when it is not a GitHub repository. */
  ci: { repository: string; gh: string } | null;
  /** Wall-clock budget for the whole classification. */
  budgetMs?: number;
}

export function classifyValidationFailures(input: ValidationFailureClassifierInput, req: any): any {
  const fs = req("node:fs");
  const path = req("node:path");
  const childProcess = req("node:child_process");
  const deadline = Date.now() + Math.max(1_000, Math.min(120_000, input.budgetMs ?? 45_000));
  const root: string = fs.realpathSync(input.root);
  const limitations: string[] = [];
  const clip = (text: string, max = 1_000): string =>
    text.length <= max ? text : `${text.slice(0, max - 1)}…`;
  const note = (text: string): void => {
    const value = clip(text);
    if (limitations.length < 20 && !limitations.includes(value)) limitations.push(value);
  };
  const outOfTime = (): boolean => Date.now() > deadline;
  const normalizeName = (name: string): string =>
    name
      .replace(/\s+\[\d+(?:\.\d+)?\s*m?s\]\s*$/, "")
      .replace(/\s+/g, " ")
      .trim();
  const keyOf = (runner: string, file: string | null, name: string): string =>
    `${runner}:${file ?? "?"}::${normalizeName(name)}`;
  const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
  const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/;
  const SKIPPED_DIRECTORIES = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    "out",
    "output",
    "coverage",
    ".turbo",
    ".orkestrator",
    ".next",
  ]);

  // ---------------------------------------------------------------------------
  // Repository files
  // ---------------------------------------------------------------------------
  function listRepositoryFiles(): string[] {
    const listed = childProcess.spawnSync(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 20_000 },
    );
    if (listed.status === 0 && typeof listed.stdout === "string") {
      return listed.stdout.split("\0").filter(Boolean);
    }
    // Not a Git checkout (or Git is missing): walk the tree instead, bounded.
    const files: string[] = [];
    const pending = [""];
    while (pending.length > 0 && files.length < 100_000 && !outOfTime()) {
      const directory = pending.pop()!;
      let entries: any[];
      try {
        entries = fs.readdirSync(path.join(root, directory), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const relative = directory ? `${directory}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (!SKIPPED_DIRECTORIES.has(entry.name)) pending.push(relative);
        } else if (entry.isFile()) {
          files.push(relative);
        }
      }
    }
    return files;
  }
  const repositoryFiles = listRepositoryFiles();
  const repositoryFileSet = new Set(repositoryFiles);
  const isRepositoryFile = (relative: string): boolean => repositoryFileSet.has(relative);
  function readRepositoryText(relative: string, maxBytes = 2 * 1024 * 1024): string | null {
    try {
      const absolute = path.join(root, relative);
      return fs.statSync(absolute).size <= maxBytes ? fs.readFileSync(absolute, "utf8") : null;
    } catch {
      return null;
    }
  }
  // Only the few files read more than once (titles, helpers) are cached; an
  // import graph reads thousands, once each.
  const textCache = new Map<string, string | null>();
  function cachedRepositoryText(relative: string): string | null {
    if (!textCache.has(relative)) textCache.set(relative, readRepositoryText(relative));
    return textCache.get(relative)!;
  }

  // Workspace package name -> directory, for output prefixed by a task runner
  // (`@scope/pkg:test: ...`), whose paths are relative to that package.
  const packageDirectories = new Map<string, string>();
  for (const file of repositoryFiles) {
    if (packageDirectories.size >= 500) break;
    if (!/(?:^|\/)package\.json$/.test(file) || file.includes("node_modules/")) continue;
    try {
      const manifest = JSON.parse(readRepositoryText(file, 512 * 1024) ?? "{}");
      if (typeof manifest.name === "string" && !packageDirectories.has(manifest.name)) {
        packageDirectories.set(manifest.name, path.posix.dirname(file));
      }
    } catch {
      // An unreadable manifest only loses its prefix mapping.
    }
  }

  function bySuffix(candidate: string): string | null {
    const trimmed = candidate.replace(/^\.\//, "");
    const matches = repositoryFiles.filter(
      (file) => file === trimmed || file.endsWith(`/${trimmed}`),
    );
    return matches.length === 1 ? matches[0]! : null;
  }

  /** Repository-relative path for a path printed by a runner, or null. */
  function toRepositoryPath(candidate: string, bases: string[]): string | null {
    const cleaned = candidate.replace(/\\/g, "/");
    if (path.posix.isAbsolute(cleaned) || /^[A-Za-z]:\//.test(cleaned)) {
      if (cleaned.startsWith(`${root}/`)) {
        const relative = cleaned.slice(root.length + 1);
        if (isRepositoryFile(relative)) return relative;
      }
      // A path from another checkout (CI, a container mount): find the
      // shortest suffix that names exactly one file here.
      const parts = cleaned.split("/").filter(Boolean);
      for (let start = 0; start < parts.length; start += 1) {
        const suffix = parts.slice(start).join("/");
        if (isRepositoryFile(suffix)) return suffix;
      }
      return null;
    }
    for (const base of bases) {
      const joined = path.posix.normalize(path.posix.join(base || ".", cleaned));
      if (!joined.startsWith("..") && isRepositoryFile(joined)) return joined;
    }
    return bySuffix(cleaned);
  }

  function leafTitle(name: string): string {
    const parts = name.split(/ > | › /);
    return parts[parts.length - 1]!.trim();
  }

  function textMentionsTitle(text: string | null, name: string): boolean {
    const leaf = leafTitle(name);
    if (!text || leaf.length === 0) return false;
    return text.includes(leaf) || text.includes(JSON.stringify(leaf).slice(1, -1));
  }
  const fileMentionsTitle = (relative: string, name: string): boolean =>
    textMentionsTitle(cachedRepositoryText(relative), name);

  let testFiles: string[] | null = null;
  /** The one test file whose source contains the title, when exactly one does. */
  function findByTitle(name: string): string | null {
    testFiles ??= repositoryFiles.filter((file) => TEST_FILE.test(file)).slice(0, 10_000);
    const leaf = leafTitle(name);
    if (leaf.length < 8) return null;
    let found: string | null = null;
    for (const file of testFiles) {
      if (outOfTime()) return null;
      if (!textMentionsTitle(readRepositoryText(file), name)) continue;
      if (found) return null;
      found = file;
    }
    return found;
  }

  // ---------------------------------------------------------------------------
  // Runner output
  // ---------------------------------------------------------------------------
  type ParsedFailure = {
    runner: string;
    file: string | null;
    name: string;
    outcome: "failed" | "flaky";
  };
  type ParsedOutput = { failures: ParsedFailure[]; unattributed: string | null };

  function readArtifact(relative: string | null): string {
    if (!relative) return "";
    try {
      const absolute = path.join(root, relative);
      const real = fs.realpathSync(absolute);
      if (!real.startsWith(`${root}/`)) return "";
      const size = fs.statSync(real).size;
      const limit = 32 * 1024 * 1024;
      if (size <= limit) return fs.readFileSync(real, "utf8");
      const descriptor = fs.openSync(real, "r");
      try {
        const buffer = Buffer.alloc(limit);
        fs.readSync(descriptor, buffer, 0, limit, size - limit);
        return buffer.toString("utf8");
      } finally {
        fs.closeSync(descriptor);
      }
    } catch {
      return "";
    }
  }

  const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
  const TASK_PREFIX = /^((?:@[\w.-]+\/)?[\w.-]+):([\w:.-]+): ?(.*)$/;

  function parseOutput(text: string, cwd: string): ParsedOutput {
    const lines = text.split("\n").map((line) =>
      line
        .replace(ANSI, "")
        .replace(/\r$/, "")
        // GitHub Actions log timestamps, then a mise task label.
        .replace(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/, "")
        .replace(/^\[[\w:.-]+\] /, ""),
    );
    const failures: ParsedFailure[] = [];
    const problems: string[] = [];

    // Bun, per output stream (a task runner prefixes each package's lines).
    type BunStream = {
      header: string | null;
      stackFile: string | null;
      fails: Array<{ name: string; stackFile: string | null; header: string | null }>;
      failTotal: number | null;
      errors: number;
      exited: boolean;
    };
    const streams = new Map<string, BunStream>();
    let unhandled = false;
    // Playwright's closing summary.
    let playwrightSection: "failed" | "flaky" | null = null;
    const playwrightCounts = { failed: 0, flaky: 0 };
    const playwrightListed = { failed: 0, flaky: 0 };
    let playwrightInterrupted = false;
    // Vitest, Jest and pytest.
    let vitestCount: number | null = null;
    let jestCount: number | null = null;
    let jestFile: string | null = null;
    let pytestCount: number | null = null;
    let suiteLevelFailure = false;

    for (const raw of lines) {
      const prefixed = TASK_PREFIX.exec(raw);
      const stream = prefixed ? prefixed[1]! : "";
      const line = prefixed ? prefixed[3]! : raw;
      let state = streams.get(stream);
      if (!state) {
        state = {
          header: null,
          stackFile: null,
          fails: [],
          failTotal: null,
          errors: 0,
          exited: false,
        };
        streams.set(stream, state);
      }

      // --- Bun -------------------------------------------------------------
      const header = /^(\S[^:]*\.[cm]?[jt]sx?):$/.exec(line);
      if (header) {
        state.header = header[1]!;
        state.stackFile = null;
        continue;
      }
      const stack =
        /^\s+at\s.*?\(?((?:[A-Za-z]:)?[^\s()]*\.(?:test|spec)\.[cm]?[jt]sx?):\d+:\d+\)?\s*$/.exec(
          line,
        );
      if (stack) {
        state.stackFile ??= stack[1]!;
        continue;
      }
      const bunFail = /^\(fail\) (.+)$/.exec(line);
      if (bunFail) {
        state.fails.push({ name: bunFail[1]!, stackFile: state.stackFile, header: state.header });
        state.stackFile = null;
        continue;
      }
      const bunTotal = /^\s*(\d+) fail$/.exec(line);
      if (bunTotal) {
        state.failTotal = (state.failTotal ?? 0) + Number(bunTotal[1]);
        continue;
      }
      const bunErrors = /^\s*(\d+) errors?$/.exec(line);
      if (bunErrors) {
        state.errors += Number(bunErrors[1]);
        continue;
      }
      if (/Unhandled error between tests/.test(line)) unhandled = true;
      if (/^error: script ".*" exited with code \d+/.test(line)) state.exited = true;

      // --- Playwright ------------------------------------------------------
      const playwrightCount =
        /^\s+(\d+) (failed|flaky|interrupted|did not run|skipped|passed)\b/.exec(line);
      if (playwrightCount) {
        const kind = playwrightCount[2]!;
        playwrightSection = kind === "failed" || kind === "flaky" ? kind : null;
        if (kind === "failed" || kind === "flaky")
          playwrightCounts[kind] += Number(playwrightCount[1]);
        if ((kind === "interrupted" || kind === "did not run") && Number(playwrightCount[1]) > 0) {
          playwrightInterrupted = true;
        }
        continue;
      }
      if (playwrightSection) {
        const entry = /^\s+(?:\[([^\]]+)\] › )?(\S+?):\d+:\d+ › (.+?)\s*$/.exec(line);
        if (entry) {
          failures.push({
            runner: "playwright",
            file: toRepositoryPath(entry[2]!, [cwd]),
            name: entry[3]!,
            outcome: playwrightSection,
          });
          playwrightListed[playwrightSection] += 1;
          continue;
        }
        playwrightSection = null;
      }
      if (/errors? (?:was|were) not a part of any test/i.test(line)) playwrightInterrupted = true;

      // --- Vitest ----------------------------------------------------------
      const vitest = /^\s*(?:FAIL|×|✗)\s+(\S+\.(?:test|spec)\.[cm]?[jt]sx?)\s+>\s+(.+?)\s*$/.exec(
        line,
      );
      if (vitest) {
        failures.push({
          runner: "vitest",
          file: toRepositoryPath(vitest[1]!, [cwd]),
          name: vitest[2]!,
          outcome: "failed",
        });
        continue;
      }
      const vitestTotal = /^\s*Tests\s+(\d+) failed/.exec(line);
      if (vitestTotal) {
        vitestCount = (vitestCount ?? 0) + Number(vitestTotal[1]);
        continue;
      }

      // --- Jest ------------------------------------------------------------
      const jestHeader = /^\s*FAIL\s+(\S+\.(?:test|spec)\.[cm]?[jt]sx?)\s*(?:\(.*\))?$/.exec(line);
      if (jestHeader) {
        jestFile = jestHeader[1]!;
        continue;
      }
      const jestEntry = /^\s+● (.+?)\s*$/.exec(line);
      if (jestEntry && jestFile) {
        if (/^Test suite failed to run$/.test(jestEntry[1]!)) suiteLevelFailure = true;
        else {
          failures.push({
            runner: "jest",
            file: toRepositoryPath(jestFile, [cwd]),
            name: jestEntry[1]!,
            outcome: "failed",
          });
        }
        continue;
      }
      const jestTotal = /^Tests:\s+(\d+) failed/.exec(line);
      if (jestTotal) {
        jestCount = (jestCount ?? 0) + Number(jestTotal[1]);
        continue;
      }

      // --- pytest ----------------------------------------------------------
      const pytest = /^FAILED (\S+?\.py)::(\S.*?)(?: - .*)?$/.exec(line);
      if (pytest) {
        failures.push({
          runner: "pytest",
          file: toRepositoryPath(pytest[1]!, [cwd]),
          name: pytest[2]!,
          outcome: "failed",
        });
        continue;
      }
      if (/^ERROR \S+\.py/.test(line)) suiteLevelFailure = true;
      const pytestTotal = /^=+ .*?\b(\d+) failed\b.* =+$/.exec(line);
      if (pytestTotal) pytestCount = (pytestCount ?? 0) + Number(pytestTotal[1]);
    }

    // Bun: attribute each failure to its file and check every stream's count.
    for (const [stream, state] of streams) {
      const packageDirectory = stream ? packageDirectories.get(stream) : undefined;
      const bases = [packageDirectory, cwd, "."].filter(
        (base): base is string => typeof base === "string",
      );
      const keys = new Set<string>();
      for (const fail of state.fails) {
        let file: string | null = null;
        // A stack frame names the failing file; the nearest header can belong
        // to another file when a parallel run interleaves output.
        if (fail.stackFile) file = toRepositoryPath(fail.stackFile, bases);
        if (!file && fail.header) {
          const candidate = toRepositoryPath(fail.header, bases);
          if (candidate && fileMentionsTitle(candidate, fail.name)) file = candidate;
        }
        file ??= findByTitle(fail.name);
        failures.push({ runner: "bun", file, name: fail.name, outcome: "failed" });
        keys.add(keyOf("bun", file, fail.name));
      }
      if (state.fails.length > 0 && state.failTotal === null) {
        problems.push(
          "Bun reported failing tests without its closing summary, so others may be unlisted",
        );
      } else if (state.failTotal !== null && state.failTotal !== keys.size) {
        problems.push(
          `Bun counted ${state.failTotal} failing tests but the output names ${keys.size}`,
        );
      }
      if (state.errors > 0) problems.push("Bun reported errors outside any test");
      if (state.exited && state.failTotal === null && state.fails.length === 0) {
        problems.push(
          `${stream || "A command"} exited with an error without reporting a failing test`,
        );
      }
    }
    if (unhandled) problems.push("Bun reported an unhandled error between tests");
    if (playwrightCounts.failed !== playwrightListed.failed) {
      problems.push(
        `Playwright counted ${playwrightCounts.failed} failed tests but listed ${playwrightListed.failed}`,
      );
    }
    if (playwrightInterrupted) {
      problems.push("Playwright interrupted tests or reported errors outside any test");
    }
    const countOf = (runner: string) =>
      new Set(
        failures
          .filter((failure) => failure.runner === runner)
          .map((f) => keyOf(runner, f.file, f.name)),
      ).size;
    if (vitestCount !== null && vitestCount !== countOf("vitest")) {
      problems.push(
        `Vitest counted ${vitestCount} failed tests but the output names ${countOf("vitest")}`,
      );
    }
    if (jestCount !== null && jestCount !== countOf("jest")) {
      problems.push(
        `Jest counted ${jestCount} failed tests but the output names ${countOf("jest")}`,
      );
    }
    if (pytestCount !== null && pytestCount !== countOf("pytest")) {
      problems.push(
        `pytest counted ${pytestCount} failed tests but the output names ${countOf("pytest")}`,
      );
    }
    if (suiteLevelFailure) problems.push("A test file failed to load, so its tests never ran");
    return { failures, unattributed: problems.length > 0 ? problems.join("; ") : null };
  }

  // ---------------------------------------------------------------------------
  // Evidence: what the branch changed
  // ---------------------------------------------------------------------------
  const changed = new Set(input.changedFiles);
  const GLOBAL_CHANGE = [
    /(?:^|\/)package\.json$/,
    /(?:^|\/)(?:bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/,
    /(?:^|\/)tsconfig[^/]*\.json$/,
    /(?:^|\/)bunfig\.toml$/,
    /(?:^|\/)mise\.toml$/,
    /(?:^|\/)\.env[^/]*$/,
    /(?:^|\/)[^/]*\.config\.[cm]?[jt]s$/,
    /(?:^|\/)tests?\/setup[^/]*$/,
    /(?:^|\/)patches\//,
  ];
  // Every bun test also loads the files a bunfig.toml preloads, so their
  // imports count as each test's own.
  const preloads: string[] = [];
  for (const file of repositoryFiles) {
    if (!/(?:^|\/)bunfig\.toml$/.test(file)) continue;
    const text = readRepositoryText(file, 256 * 1024) ?? "";
    const directory = path.posix.dirname(file);
    for (const match of text.matchAll(/preload\s*=\s*(\[[^\]]*\]|"[^"]*")/g)) {
      for (const entry of match[1]!.matchAll(/"([^"]+)"/g)) {
        const relative = path.posix.normalize(path.posix.join(directory, entry[1]!));
        if (isRepositoryFile(relative)) preloads.push(relative);
      }
    }
  }
  const globalChanges = input.changedFiles.filter(
    (file) => GLOBAL_CHANGE.some((pattern) => pattern.test(file)) || preloads.includes(file),
  );
  if (input.changedFilesTruncated)
    note(
      "The changed-file list was too long to send in full, so no failure was classified unrelated by its imports",
    );

  // ---------------------------------------------------------------------------
  // Evidence: static import graph
  // ---------------------------------------------------------------------------
  const BunRuntime = (globalThis as any).Bun;
  const transpilers = new Map<string, any>();
  const builtins = new Set<string>(req("node:module").builtinModules ?? []);
  const workspaceNames = [...packageDirectories.keys()];
  const dependencyCache = new Map<string, { deps: string[]; incomplete: boolean }>();
  let graphBudget = 40_000;
  let graphBudgetSpent = false;

  function dependenciesOf(relative: string): { deps: string[]; incomplete: boolean } {
    const cached = dependencyCache.get(relative);
    if (cached) return cached;
    const result = { deps: [] as string[], incomplete: false };
    dependencyCache.set(relative, result);
    if (!CODE_FILE.test(relative)) return result;
    if (!BunRuntime?.Transpiler || !BunRuntime?.resolveSync) {
      result.incomplete = true;
      return result;
    }
    const text = readRepositoryText(relative);
    if (text === null) {
      result.incomplete = true;
      return result;
    }
    // A static scan cannot prove what crosses a runtime or process boundary.
    if (
      /\b(?:import|require)\s*\(\s*(?![\s"'])/.test(text) ||
      /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(|\bBun\s*\.\s*(?:spawn|spawnSync)\b|child_process/.test(
        text,
      )
    ) {
      result.incomplete = true;
    }
    const loader = /\.[cm]?ts$/.test(relative) ? "ts" : "tsx";
    let transpiler = transpilers.get(loader);
    if (!transpiler) {
      transpiler = new BunRuntime.Transpiler({ loader });
      transpilers.set(loader, transpiler);
    }
    let imports: Array<{ path: string }>;
    try {
      imports = transpiler.scanImports(text);
    } catch {
      result.incomplete = true;
      return result;
    }
    const directory = path.join(root, path.posix.dirname(relative));
    for (const { path: specifier } of imports) {
      if (/^(?:execa|cross-spawn|shelljs)(?:\/|$)/.test(specifier)) result.incomplete = true;
      if (/^(?:bun|node):/.test(specifier) || builtins.has(specifier)) continue;
      let resolved: string;
      try {
        resolved = BunRuntime.resolveSync(specifier, directory);
      } catch {
        const local =
          specifier.startsWith(".") ||
          specifier.startsWith("/") ||
          workspaceNames.some((name) => specifier === name || specifier.startsWith(`${name}/`));
        // A missing third-party package cannot be this branch's code.
        if (local) result.incomplete = true;
        continue;
      }
      if (!path.isAbsolute(resolved)) continue;
      let real = resolved;
      try {
        real = fs.realpathSync(resolved);
      } catch {
        // Keep the unresolved spelling.
      }
      if (!real.startsWith(`${root}/`)) continue;
      const dependency = real.slice(root.length + 1);
      if (dependency.includes("node_modules/")) continue;
      result.deps.push(dependency);
    }
    return result;
  }

  // Mirrors the protocol's MAX_RELATED_IMPORT_HOPS (this function cannot
  // import it): a changed file further than this many import edges from the
  // test's own code makes the failure `undetermined`, not `related`.
  const MAX_RELATED_IMPORT_HOPS = 2;

  /**
   * The files a test loads, and the changed file among them closest to the
   * test's own code, with its distance in import edges (`changedHops`).
   *
   * The test's own code is the test file and the helpers it reaches through
   * other helpers; a file any of them imports is one hop away. A bunfig
   * preload is itself one hop away, as a file the test imports. The walk is
   * breadth-first by distance, every own file first, so the first changed file
   * it meets is the closest. Only a close hit stops the walk; a distant hit
   * keeps walking within the budget so path references see the full closure.
   */
  function importClosure(
    testFile: string,
    withPreloads: boolean,
  ): {
    files: string[];
    changedHit: string | null;
    changedHops: number | null;
    incomplete: boolean;
  } {
    const seen = new Set<string>();
    // Own files expand before anything else; distances in `queue` never
    // decrease, so each file is settled at its shortest distance.
    const own = [testFile];
    const queue: Array<{ file: string; hops: number }> = withPreloads
      ? preloads.map((file) => ({ file, hops: 1 }))
      : [];
    let changedHit: string | null = null;
    let changedHops: number | null = null;
    let incomplete = false;
    let nextOwn = 0;
    let nextQueued = 0;
    while (nextOwn < own.length || nextQueued < queue.length) {
      const isOwn = nextOwn < own.length;
      const file = isOwn ? own[nextOwn++]! : queue[nextQueued]!.file;
      // An own helper is a direct import of the test or of another helper.
      const hops = isOwn ? 1 : queue[nextQueued++]!.hops;
      if (seen.has(file)) continue;
      seen.add(file);
      if (changedHit === null && file !== testFile && changed.has(file)) {
        changedHit = file;
        changedHops = hops;
        if (hops <= MAX_RELATED_IMPORT_HOPS) break;
      }
      if (graphBudget <= 0 || outOfTime()) {
        graphBudgetSpent = true;
        incomplete = true;
        break;
      }
      graphBudget -= 1;
      const { deps, incomplete: partial } = dependenciesOf(file);
      if (partial) incomplete = true;
      for (const dependency of deps) {
        if (seen.has(dependency)) continue;
        if (isOwn && isHelperFile(dependency)) own.push(dependency);
        else queue.push({ file: dependency, hops: isOwn ? 1 : hops + 1 });
      }
    }
    return { files: [...seen], changedHit, changedHops, incomplete };
  }

  // ---------------------------------------------------------------------------
  // Evidence: paths a test names (fixtures, documents, directories it scans)
  // ---------------------------------------------------------------------------
  // A test and its own helpers may name a changed file, its basename or a
  // directory above it. Any other module the test loads counts only by a
  // changed file's full path in its code, as a module that reads that file at
  // run time does: a directory or a basename there is a description (a doc
  // comment's `apps/web`, a `config.json` read from elsewhere), not evidence
  // that this test depends on the change. Comments never count.
  const GENERIC_BASENAMES = new Set([
    "index.ts",
    "index.tsx",
    "index.js",
    "types.ts",
    "utils.ts",
    "package.json",
    "README.md",
    "AGENTS.md",
  ]);
  const HELPER_DIRECTORY =
    /(?:^|\/)(?:tests?|__tests__|testing|fixtures?|__fixtures__|mocks?|__mocks__|e2e)\//;
  const HELPER_BASENAME =
    /(?:^|[-_.])(?:tests?|testing|spec|fixtures?|mocks?|stubs?|fakes?)(?:[-_.])/;
  const isHelperFile = (relative: string): boolean =>
    TEST_FILE.test(relative) ||
    HELPER_DIRECTORY.test(relative) ||
    HELPER_BASENAME.test(path.posix.basename(relative));
  const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // One entry per distinct literal; a cheap `includes` gates each pattern.
  // `path` is what a match reports: the changed file, or the directory named.
  type PathToken = { path: string; helperOnly: boolean; pattern: RegExp };
  const pathTokens = new Map<string, PathToken>();
  for (const file of input.changedFiles) {
    if (!pathTokens.has(file)) {
      pathTokens.set(file, {
        path: file,
        helperOnly: false,
        pattern: new RegExp(`(?:^|[^\\w./-])${escapeRegExp(file)}(?![\\w-])`),
      });
    }
    const basename = path.posix.basename(file);
    if (
      basename.length >= 8 &&
      basename.includes(".") &&
      !GENERIC_BASENAMES.has(basename) &&
      !pathTokens.has(basename)
    ) {
      pathTokens.set(basename, {
        path: file,
        helperOnly: true,
        pattern: new RegExp(`["'\`/]${escapeRegExp(basename)}["'\`]`),
      });
    }
    const segments = file.split("/");
    for (let length = segments.length - 1; length >= 2; length -= 1) {
      // A directory counts only as a whole literal or a glob over it: a test
      // that reads or scans that directory.
      const directory = segments.slice(0, length).join("/");
      if (pathTokens.has(directory)) continue;
      pathTokens.set(directory, {
        path: directory,
        helperOnly: true,
        pattern: new RegExp(`["'\`]${escapeRegExp(directory)}/?(?:["'\`]|/\\*)`),
      });
    }
  }

  /**
   * Bun drops ordinary comments but preserves legal block comments. Walk its
   * JavaScript output to remove those too, keeping quoted and template text.
   * A slash outside those tokens can be division or a regexp: refuse that
   * ambiguous analysis rather than interpreting regexp contents as comments.
   */
  function withoutComments(code: string): string | null {
    if (!code.includes("/*") && !code.includes("//")) return code;
    const output: string[] = [];
    let next = 0;
    function quoted(quote: string): boolean {
      output.push(code[next++]!);
      while (next < code.length) {
        const character = code[next++]!;
        output.push(character);
        if (character === "\\") {
          if (next >= code.length) return false;
          output.push(code[next++]!);
        } else if (character === quote) {
          return true;
        } else if (quote === "`" && character === "$" && code[next] === "{") {
          output.push(code[next++]!);
          if (!expression(true)) return false;
        }
      }
      return false;
    }
    function expression(template: boolean): boolean {
      let braces = 0;
      while (next < code.length) {
        const character = code[next]!;
        if (character === '"' || character === "'" || character === "`") {
          if (!quoted(character)) return false;
          continue;
        }
        if (character === "/") {
          if (code[next + 1] === "*") {
            const end = code.indexOf("*/", next + 2);
            if (end < 0) return false;
            output.push(" ");
            next = end + 2;
            continue;
          }
          if (code[next + 1] === "/") {
            const end = code.indexOf("\n", next + 2);
            next = end < 0 ? code.length : end;
            output.push("\n");
            continue;
          }
          return false;
        }
        output.push(character);
        next += 1;
        if (character === "{") braces += 1;
        if (character === "}") {
          if (template && braces === 0) return true;
          braces -= 1;
        }
      }
      return !template;
    }
    return expression(false) ? output.join("") : null;
  }

  /** Null means path evidence is unavailable, never a raw-source fallback. */
  function codeOf(relative: string, text: string): string | null {
    if (!CODE_FILE.test(relative) || !BunRuntime?.Transpiler) return null;
    const loader = /\.[cm]?ts$/.test(relative) ? "ts" : "tsx";
    try {
      let transpiler = transpilers.get(loader);
      if (!transpiler) {
        transpiler = new BunRuntime.Transpiler({ loader });
        transpilers.set(loader, transpiler);
      }
      return withoutComments(transpiler.transformSync(text));
    } catch {
      return null;
    }
  }

  const referenceCache = new Map<string, string | null>();
  const unavailableReferences = new Set<string>();
  function referenceIn(file: string, helper: boolean): string | null {
    const cacheKey = `${helper ? "helper" : "module"}:${file}`;
    if (referenceCache.has(cacheKey)) return referenceCache.get(cacheKey)!;
    let found: string | null = null;
    const text = textCache.get(file) ?? readRepositoryText(file);
    if (text) {
      const candidates = [...pathTokens].filter(
        ([literal, token]) => (helper || !token.helperOnly) && text.includes(literal),
      );
      // Most files name no changed path at all, so only those that might are
      // parsed to drop their comments.
      const code = candidates.length > 0 ? codeOf(file, text) : "";
      if (code === null) {
        // A substring can be only a prefix of a longer path. Failed analysis
        // leaves uncertainty only when a complete raw pattern could match;
        // raw text still never supplies positive path evidence.
        if (candidates.some(([, token]) => token.pattern.test(text))) {
          unavailableReferences.add(file);
        }
        referenceCache.set(cacheKey, null);
        return null;
      }
      for (const [, token] of candidates) {
        if (token.pattern.test(code)) {
          found = token.path;
          break;
        }
      }
    }
    referenceCache.set(cacheKey, found);
    return found;
  }

  /** The test file and the helpers it reaches through its own imports. */
  function helpersOf(testFile: string, closure: string[]): Set<string> {
    const inClosure = new Set(closure);
    const reached = new Set([testFile]);
    const queue = [testFile];
    for (let next = 0; next < queue.length; next += 1) {
      for (const dependency of dependencyCache.get(queue[next]!)?.deps ?? []) {
        if (reached.has(dependency) || !inClosure.has(dependency)) continue;
        reached.add(dependency);
        queue.push(dependency);
      }
    }
    return new Set([testFile, ...[...reached].filter(isHelperFile)]);
  }

  function referencedChange(testFile: string, files: string[]): string | null {
    const helpers = helpersOf(testFile, files);
    for (const file of files) {
      if (outOfTime()) return null;
      const found = referenceIn(file, helpers.has(file));
      if (found) return found;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Evidence: the repository's flake registry
  // ---------------------------------------------------------------------------
  const registryRows: Array<{ file: string | null; names: string[] }> = [];
  for (const file of repositoryFiles) {
    if (!/^docs\/tests\/flaky-tests\/(?:[^/]+\/)*0000-index\.md$/.test(file)) continue;
    const text = cachedRepositoryText(file) ?? "";
    let columns: { status: number; test: number; file: number } | null = null;
    for (const line of text.split("\n")) {
      if (!line.trim().startsWith("|")) {
        columns = null;
        continue;
      }
      const cells = line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim());
      const lowered = cells.map((cell) => cell.toLowerCase());
      if (lowered.includes("status") && lowered.includes("test")) {
        columns = {
          status: lowered.indexOf("status"),
          test: lowered.indexOf("test"),
          file: lowered.indexOf("file"),
        };
        continue;
      }
      if (!columns || /^:?-+:?$/.test(cells[0] ?? "")) continue;
      const status = (cells[columns.status] ?? "").toLowerCase();
      if (!status || /resolved|fixed|closed|removed|deleted/.test(status)) continue;
      const testCell = cells[columns.test] ?? "";
      const quoted = [...testCell.matchAll(/`([^`]+)`/g)].map((match) => match[1]!);
      const names = (
        quoted.length > 0 ? quoted : [testCell.replace(/\s*\(\d{4}-\d\d-\d\d\)\s*$/, "")]
      )
        .map(normalizeName)
        .filter((name) => name.length > 0);
      const fileCell =
        columns.file >= 0
          ? (cells[columns.file] ?? "")
              .replace(/`/g, "")
              .replace(/:\d+(?::\d+)?$/, "")
              .trim()
          : "";
      registryRows.push({ file: fileCell || null, names });
    }
  }
  function inFlakeRegistry(failure: ParsedFailure): boolean {
    const name = normalizeName(failure.name);
    const leaf = leafTitle(name);
    return registryRows.some((row) => {
      if (row.file && failure.file && row.file !== failure.file) return false;
      return row.names.some(
        (entry) =>
          entry === name ||
          ((row.file !== null || failure.file === null) &&
            (name.endsWith(entry) || (leaf.length >= 12 && entry.endsWith(leaf)))),
      );
    });
  }

  // ---------------------------------------------------------------------------
  // Evidence: the target branch's CI on the merge-base commit
  // ---------------------------------------------------------------------------
  let ciKeys: Set<string> | null | undefined;
  function targetCiFailures(): Set<string> | null {
    if (ciKeys !== undefined) return ciKeys;
    ciKeys = null;
    if (!input.ci || !input.mergeBase) return null;
    const { repository, gh } = input.ci;
    const commit = input.mergeBase.slice(0, 12);
    const listed = childProcess.spawnSync(
      gh,
      ["api", `repos/${repository}/commits/${input.mergeBase}/check-runs?per_page=100`],
      { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 20_000 },
    );
    if (listed.status !== 0) {
      note(`The target branch's CI result for ${commit} could not be read`);
      return null;
    }
    let runs: any[] = [];
    try {
      runs = JSON.parse(listed.stdout).check_runs ?? [];
    } catch {
      note(`The target branch's CI result for ${commit} was unreadable`);
      return null;
    }
    if (runs.length === 0) {
      note(`No CI ran on the merge-base commit ${commit}`);
      return null;
    }
    if (runs.some((run) => run.status !== "completed")) {
      note(`CI on the merge-base commit ${commit} had not finished`);
    }
    const failed = runs
      .filter(
        (run) =>
          run.status === "completed" &&
          run.conclusion === "failure" &&
          run.app?.slug === "github-actions" &&
          Number.isSafeInteger(run.id),
      )
      .slice(0, 6);
    const keys = new Set<string>();
    // Check runs and Actions jobs have distinct IDs. Resolve the job through
    // its check_run_url instead of treating the check ID as a job ID.
    const jobs: any[] = [];
    if (failed.length > 0 && !outOfTime()) {
      try {
        const workflows = childProcess.spawnSync(
          gh,
          ["api", `repos/${repository}/actions/runs?head_sha=${input.mergeBase}&per_page=100`],
          { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 10_000 },
        );
        if (workflows.status !== 0) throw new Error("workflow lookup failed");
        for (const workflow of (JSON.parse(workflows.stdout).workflow_runs ?? []).slice(0, 6)) {
          if (outOfTime()) break;
          if (!Number.isSafeInteger(workflow.id)) continue;
          const listedJobs = childProcess.spawnSync(
            gh,
            ["api", `repos/${repository}/actions/runs/${workflow.id}/jobs?per_page=100`],
            { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 10_000 },
          );
          if (listedJobs.status !== 0) continue;
          jobs.push(...(JSON.parse(listedJobs.stdout).jobs ?? []));
        }
      } catch {
        note(`Actions jobs on ${commit} could not be resolved`);
      }
    }
    for (const run of failed) {
      if (outOfTime()) {
        note(`Reading CI logs for ${commit} ran out of time`);
        break;
      }
      const job = jobs.find(
        (job) =>
          Number.isSafeInteger(job.id) &&
          job.check_run_url === `https://api.github.com/repos/${repository}/check-runs/${run.id}`,
      );
      if (!job) {
        note(
          `The Actions job for CI check ${run.name ?? run.id} on ${commit} could not be resolved`,
        );
        continue;
      }
      // Logs can be large; the failing tests and summaries are at the end.
      // Current gh refuses output with terminal escapes unless allowed; an
      // older gh rejects the flag, so it is retried without it.
      const logs = childProcess.spawnSync(
        "sh",
        [
          "-c",
          '{ "$0" api --allow-escape-sequences "$1" 2>/dev/null || "$0" api "$1"; } | tail -c 16777216',
          gh,
          `repos/${repository}/actions/jobs/${job.id}/logs`,
        ],
        { cwd: root, encoding: "utf8", maxBuffer: 20 * 1024 * 1024, timeout: 30_000 },
      );
      if (logs.status !== 0 || typeof logs.stdout !== "string" || logs.stdout.length === 0) {
        note(`The log of CI job ${run.name ?? run.id} on ${commit} could not be read`);
        continue;
      }
      for (const failure of parseOutput(logs.stdout, ".").failures) {
        if (failure.outcome === "failed")
          keys.add(keyOf(failure.runner, failure.file, failure.name));
      }
    }
    ciKeys = keys;
    return keys;
  }

  // ---------------------------------------------------------------------------
  // Classification
  // ---------------------------------------------------------------------------
  function classify(failure: ParsedFailure): any {
    const reasons: string[] = [];
    let changedPath: string | undefined;
    let changedPathHops: number | undefined;
    if (failure.outcome === "flaky") reasons.push("passed-on-retry");
    if (inFlakeRegistry(failure)) reasons.push("known-flaky");
    const traceable =
      failure.runner === "bun" || failure.runner === "vitest" || failure.runner === "jest";
    if (!failure.file) {
      reasons.push("test-file-unknown");
    } else {
      if (changed.has(failure.file)) reasons.push("test-file-changed");
      if (!traceable || !CODE_FILE.test(failure.file)) {
        reasons.push("not-import-traceable");
      } else if (!changed.has(failure.file)) {
        const closure = importClosure(failure.file, failure.runner === "bun");
        const close =
          closure.changedHit !== null && (closure.changedHops ?? 0) <= MAX_RELATED_IMPORT_HOPS;
        // A distant import still lets path references across the bounded
        // closure decide, including references in non-helper modules.
        const referenced = close ? null : referencedChange(failure.file, closure.files);
        if (close) {
          reasons.push("imports-changed-file");
          changedPath = closure.changedHit!;
          changedPathHops = closure.changedHops!;
        } else if (referenced) {
          reasons.push("references-changed-path");
          changedPath = referenced;
        } else if (closure.changedHit) {
          // Never `unrelated`: the verifier sees the distant import.
          reasons.push("reaches-changed-file-indirectly");
          changedPath = closure.changedHit;
          changedPathHops = closure.changedHops!;
        } else if (input.changedFilesTruncated || globalChanges.length > 0) {
          reasons.push("global-change");
          changedPath ??= globalChanges[0];
        } else if (
          closure.incomplete ||
          closure.files.some((file) => unavailableReferences.has(file)) ||
          input.changedFiles.some((file) => !CODE_FILE.test(file) && !/^docs\/.*\.md$/.test(file))
        ) {
          reasons.push("dependency-graph-incomplete");
        } else {
          reasons.push("no-changed-dependency");
        }
      }
    }
    let verdict: string;
    if (reasons.includes("passed-on-retry")) verdict = "unrelated";
    else if (
      reasons.includes("test-file-changed") ||
      reasons.includes("imports-changed-file") ||
      reasons.includes("references-changed-path")
    )
      verdict = "related";
    else if (reasons.includes("no-changed-dependency")) verdict = "unrelated";
    else verdict = "undetermined";
    return {
      key: clip(keyOf(failure.runner, failure.file, failure.name)),
      runner: failure.runner,
      file: failure.file === null ? null : clip(failure.file),
      name: clip(normalizeName(failure.name) || failure.name.trim() || "(unnamed test)"),
      outcome: failure.outcome,
      verdict,
      reasons,
      ...(changedPath ? { changedPath: clip(changedPath) } : {}),
      ...(changedPathHops !== undefined ? { changedPathHops } : {}),
    };
  }

  const commands: any[] = [];
  let listedTotal = 0;
  for (const command of input.commands.slice(0, 32)) {
    const text = `${readArtifact(command.stdoutPath)}\n${readArtifact(command.stderrPath)}`;
    const parsed = parseOutput(text, command.cwd || ".");
    const unique = new Map<string, ParsedFailure>();
    for (const failure of parsed.failures) {
      const key = keyOf(failure.runner, failure.file, failure.name);
      const existing = unique.get(key);
      // A test listed as both failed and flaky (two projects) stays failed.
      if (!existing || (existing.outcome === "flaky" && failure.outcome === "failed")) {
        unique.set(key, failure);
      }
    }
    const room = Math.max(0, Math.min(100, 200 - listedTotal));
    const all = [...unique.values()];
    const listed = all.slice(0, room).map(classify);
    listedTotal += listed.length;
    let unattributed = parsed.unattributed;
    if (command.status === "incomplete") {
      unattributed = unattributed
        ? `The command did not finish; ${unattributed}`
        : "The command did not finish, so tests it never reached are unlisted";
    } else if (all.length === 0) {
      unattributed ??=
        "The output names no failing test (for example a type, lint or build error, a crash or a timeout)";
    } else if (all.every((failure) => failure.outcome === "flaky") && !unattributed) {
      unattributed = "Every listed test passed on retry, yet the command still failed";
    }
    commands.push({
      command: command.command,
      failures: listed,
      omittedFailures: all.length - listed.length,
      unattributed: unattributed !== null,
      ...(unattributed ? { unattributedReason: clip(unattributed) } : {}),
    });
  }

  // CI is read last, and only when a failure is still blocking or open.
  const open = commands.flatMap((command) =>
    command.failures.filter((failure: any) => failure.verdict !== "unrelated"),
  );
  if (open.length > 0) {
    const keys = targetCiFailures();
    if (keys) {
      for (const failure of open) {
        if (!keys.has(failure.key)) continue;
        failure.reasons.push("failed-on-target-ci");
        failure.verdict = "unrelated";
      }
    }
  }
  if (graphBudgetSpent) {
    note(
      "The import graph ran out of budget, so some failures are undetermined rather than classified",
    );
  }

  return {
    version: 1,
    mergeBase: input.mergeBase,
    commands,
    limitations,
  };
}

/** `bun -e` source: decodes the base64 JSON input in argv[1] and prints the triage. */
export const VALIDATION_FAILURE_CLASSIFIER_SCRIPT = `const input = JSON.parse(Buffer.from(process.argv[1], "base64").toString());
process.stdout.write(JSON.stringify((${classifyValidationFailures.toString()})(input, require)));`;
