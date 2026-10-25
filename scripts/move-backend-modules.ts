/**
 * Moves backend modules and rewrites every reference to them, for the
 * `core/` domain-folder slices in docs/todo/backend-structure/0012-backend-core-domain-folders.md.
 *
 *   bun scripts/move-backend-modules.ts --prefix design- --into design [--dry-run]
 *   bun scripts/move-backend-modules.ts --map moves.json [--dry-run]
 *
 * `--prefix`/`--into` moves every `apps/backend/src/core/<prefix>*.ts` file,
 * tests included, into `apps/backend/src/core/<into>/` and drops the prefix.
 * A `--map` file is a JSON object of repo-relative old path to new path.
 *
 * For every tracked source file it rewrites relative specifiers in `from`,
 * `import`, `import()`, `require()` and `mock.module()` that point at a moved
 * file, and re-relativises every relative specifier inside a moved file
 * (including ones that leave the package). The original suffix style (`.js`,
 * `.ts` or none) is kept. In every tracked text file (tests, scripts, docs,
 * AGENTS.md) it then rewrites `…/<dir>/<old file>` path strings. Bare file
 * names in prose are not rewritten.
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const coreDir = path.join(root, "apps/backend/src/core");
const codeExtension = /\.(?:[cm]?[jt]sx?)$/;
const textExtension = /\.(?:[cm]?[jt]sx?|md|mdx|json|jsonc|ya?ml|toml|sh)$/;
const specifierPattern =
  /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|\bmock\.module\s*\(\s*)(["'])(\.{1,2}\/[^"'\n]*)\2/g;

function usage(message: string): never {
  console.error(message);
  console.error(
    "usage: bun scripts/move-backend-modules.ts (--prefix <prefix> --into <folder> | --map <file.json>) [--dry-run]",
  );
  process.exit(2);
}

function parseArgs(argv: string[]) {
  const options: { prefix?: string; into?: string; map?: string; dryRun: boolean } = {
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--prefix" || arg === "--into" || arg === "--map") {
      const value = argv[++index];
      if (!value) usage(`${arg} needs a value`);
      options[arg.slice(2) as "prefix" | "into" | "map"] = value;
    } else usage(`unknown argument: ${arg}`);
  }
  if (options.map ? options.prefix || options.into : !(options.prefix && options.into)) {
    usage("pass either --map, or both --prefix and --into");
  }
  return options;
}

async function buildMoves(options: ReturnType<typeof parseArgs>): Promise<Map<string, string>> {
  const moves = new Map<string, string>();
  if (options.map) {
    const entries = JSON.parse(await readFile(path.resolve(root, options.map), "utf8")) as Record<
      string,
      string
    >;
    for (const [from, to] of Object.entries(entries)) {
      moves.set(path.resolve(root, from), path.resolve(root, to));
    }
  } else {
    const { prefix, into } = options as { prefix: string; into: string };
    for (const entry of await readdir(coreDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.startsWith(prefix) || !codeExtension.test(entry.name)) {
        continue;
      }
      moves.set(
        path.join(coreDir, entry.name),
        path.join(coreDir, into, entry.name.slice(prefix.length)),
      );
    }
  }
  if (moves.size === 0) usage("nothing to move");
  const targets = new Set<string>();
  for (const [from, to] of moves) {
    if (!existsSync(from)) usage(`missing source: ${path.relative(root, from)}`);
    if (existsSync(to)) usage(`target exists: ${path.relative(root, to)}`);
    if (targets.has(to)) usage(`two files map to ${path.relative(root, to)}`);
    targets.add(to);
  }
  return moves;
}

async function trackedFiles(): Promise<string[]> {
  const output = await new Response(
    Bun.spawn(["git", "ls-files", "-z"], { cwd: root, stdout: "pipe" }).stdout,
  ).text();
  return output
    .split("\0")
    .filter((file) => file && textExtension.test(file))
    .map((file) => path.join(root, file))
    .filter((file) => existsSync(file));
}

/** Resolves a relative specifier to a file plus the suffix style it was written with. */
function resolveSpecifier(fromDir: string, specifier: string, moves: Map<string, string>) {
  const base = path.resolve(fromDir, specifier);
  const candidates: Array<{ file: string; strip: string; restore: string }> = [];
  const jsMatch = /\.([cm]?)js(x?)$/.exec(base);
  if (jsMatch) {
    const stem = base.slice(0, -jsMatch[0].length);
    candidates.push({
      file: `${stem}.${jsMatch[1]}ts${jsMatch[2]}`,
      strip: `.${jsMatch[1]}ts${jsMatch[2]}`,
      restore: jsMatch[0],
    });
  } else if (!/\.[cm]?tsx?$/.test(base)) {
    for (const extension of [".ts", ".tsx"]) {
      candidates.push({ file: `${base}${extension}`, strip: extension, restore: "" });
    }
  }
  candidates.push({ file: base, strip: "", restore: "" });
  const found =
    candidates.find((candidate) => moves.has(candidate.file)) ??
    candidates.find((candidate) => existsSync(candidate.file));
  return found ?? { file: base, strip: "", restore: "" };
}

function relativeSpecifier(fromDir: string, target: string): string {
  const relative = path.relative(fromDir, target).split(path.sep).join("/");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function rewriteSpecifiers(file: string, source: string, moves: Map<string, string>): string {
  const oldDir = path.dirname(file);
  const newDir = path.dirname(moves.get(file) ?? file);
  return source.replace(
    specifierPattern,
    (match, lead: string, quote: string, specifier: string) => {
      const target = resolveSpecifier(oldDir, specifier, moves);
      const movedTarget = moves.get(target.file);
      if (!movedTarget && oldDir === newDir) return match;
      const destination = movedTarget ?? target.file;
      const written =
        destination.slice(0, destination.length - target.strip.length) + target.restore;
      const rewritten = relativeSpecifier(newDir, written);
      return rewritten === specifier ? match : `${lead}${quote}${rewritten}${quote}`;
    },
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `core/design-service.ts` → `core/design/service.ts`, and the `.js` spelling. */
function pathStringRewrites(moves: Map<string, string>): Array<[RegExp, string]> {
  const rewrites: Array<[RegExp, string]> = [];
  for (const [from, to] of moves) {
    const fromParts = path.relative(root, from).split(path.sep);
    const toParts = path.relative(root, to).split(path.sep);
    let common = 0;
    while (common < fromParts.length - 1 && fromParts[common] === toParts[common]) common += 1;
    const anchor = Math.max(common - 1, 0);
    const oldTail = fromParts.slice(anchor).join("/");
    const newTail = toParts.slice(anchor).join("/");
    const variants: Array<[string, string]> = [[oldTail, newTail]];
    const tsMatch = /\.([cm]?)ts(x?)$/.exec(oldTail);
    if (tsMatch) {
      const js = `.${tsMatch[1]}js${tsMatch[2]}`;
      variants.push([
        oldTail.slice(0, -tsMatch[0].length) + js,
        newTail.replace(/\.[cm]?tsx?$/, js),
      ]);
    }
    for (const [oldText, newText] of variants) {
      rewrites.push([new RegExp(`(?<![\\w-])${escapeRegExp(oldText)}(?![\\w-])`, "g"), newText]);
    }
  }
  return rewrites;
}

/**
 * Stages every move in one `git add`, so git records renames. Other tools
 * (editors, Orkestrator's status polling) briefly hold `index.lock`, so retry.
 */
async function stageMoves(moves: Map<string, string>) {
  const paths = Array.from(moves).flatMap(([from, to]) => [from, to]);
  for (let attempt = 1; ; attempt += 1) {
    const result = Bun.spawnSync(["git", "add", "-A", "--", ...paths], {
      cwd: root,
      stderr: "pipe",
    });
    if (result.exitCode === 0) return;
    const message = result.stderr.toString();
    if (attempt >= 10 || !message.includes("index.lock")) {
      throw new Error(`git add failed: ${message}`);
    }
    await Bun.sleep(200 * attempt);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const moves = await buildMoves(options);
  const pathRewrites = pathStringRewrites(moves);
  const changed: string[] = [];
  for (const file of await trackedFiles()) {
    const source = await readFile(file, "utf8");
    let rewritten = codeExtension.test(file) ? rewriteSpecifiers(file, source, moves) : source;
    for (const [pattern, replacement] of pathRewrites) {
      rewritten = rewritten.replace(pattern, replacement);
    }
    if (rewritten === source) continue;
    changed.push(path.relative(root, file));
    if (!options.dryRun) await writeFile(file, rewritten);
  }
  for (const [from, to] of moves) {
    console.log(`move ${path.relative(root, from)} -> ${path.relative(root, to)}`);
    if (options.dryRun) continue;
    await mkdir(path.dirname(to), { recursive: true });
    await rename(from, to);
  }
  if (!options.dryRun) {
    // Shorter specifiers can let a wrapped import list fit on one line.
    const formatTargets = changed.map((file) =>
      path.relative(root, moves.get(path.join(root, file)) ?? path.join(root, file)),
    );
    // With no paths `bun fmt` formats the entire working directory in place.
    if (formatTargets.length > 0) {
      const format = Bun.spawnSync(
        [process.execPath, "fmt", "--no-script", "--ignore-unknown", ...formatTargets],
        {
          cwd: root,
          stderr: "pipe",
        },
      );
      if (format.exitCode !== 0) throw new Error(`bun fmt failed: ${format.stderr.toString()}`);
    }
    await stageMoves(moves);
  }
  for (const file of changed) console.log(`rewrite ${file}`);
  console.log(
    `${options.dryRun ? "Would move" : "Moved"} ${moves.size} file(s); ${options.dryRun ? "would rewrite" : "rewrote"} ${changed.length} file(s).`,
  );
}

await main();
