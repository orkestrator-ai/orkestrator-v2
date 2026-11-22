// Recognize direct Bun scripts and this repository's tier wrapper. Arbitrary
// setup chains cannot be reconstructed safely from a test filename alone.
const READ_SETUP = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const [root, directory] = process.argv.slice(1);
const cwd = path.resolve(root, directory);
const manifestPath = path.join(cwd, "package.json");
const info = fs.lstatSync(manifestPath);
if (!info.isFile() || info.size > 128 * 1024) process.exit(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const scripts = manifest.scripts || {};
const tier = scripts["test:workspace"] || scripts["test:bridge"];
const script = tier || scripts.test;
const direct = /^(bun run build && )?bun test(?: (.*))?$/;
const wrapper = /^bun --no-env-file (?:[.][.][/])+scripts\/bun-test-tier\.ts [\w./-]+ [\w./ -]+ -- (.*)$/;
const tierMatch = typeof tier === "string" && wrapper.exec(tier);
const directMatch = typeof script === "string" && direct.exec(script);
if (!tierMatch && !directMatch && (script || (directory && scripts.build))) process.exit(2);
const flags = (tierMatch && tierMatch[1]) || (directMatch && directMatch[2]) || "";
const preloads = [];
// The wrapper's parallelism, timing and display-only flags are supplied by
// the focused runner. Only preserve flags this runner understands.
const safeFlags = flags.replace(/\$\{ORKESTRATOR_TEST_TIMINGS_DIR:\+--timings=\$ORKESTRATOR_TEST_TIMINGS_DIR\/[\w.-]+ --update-timings\}/g, "")
  .replace(/--parallel=\$\{ORKESTRATOR_(?:BACKEND_)?TEST_WORKERS:-[^\s]+\}/g, "");
const args = safeFlags.trim().split(/\s+/).filter(Boolean);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--preload" || arg.startsWith("--preload=")) {
    const preload = arg === "--preload" ? args[++i] : arg.slice("--preload=".length);
    if (!preload || !/^[\w./-]+$/.test(preload)) process.exit(2);
    const resolved = fs.realpathSync(path.resolve(cwd, preload));
    const realRoot = fs.realpathSync(root);
    if (!resolved.startsWith(realRoot + path.sep)) process.exit(2);
    preloads.push(preload);
  } else if (!/^--(?:only-failures|parallel(?:=\d+)?|isolate)$/.test(arg) && !/^(?!-)[\w./-]+$/.test(arg)) {
    process.exit(2);
  }
}
let build = null;
if (tierMatch && scripts["test:workspace"] && scripts.build) {
  if (typeof manifest.name !== "string" || !/^(?:@[\w.-]+\/)?[\w.-]+$/.test(manifest.name)) process.exit(2);
  build = manifest.name;
} else if (directMatch && directMatch[1]) {
  build = "";
}
process.stdout.write(JSON.stringify({ preloads, build }));
`;

export const SETUP_SCRIPT = `exec "$ORKESTRATOR_BASELINE_BUN" --no-env-file --config=/dev/null -e '${READ_SETUP.replaceAll("'", "'\\''")}' "$@"`;
export const BUILD_SCRIPT = `
  if [ -n "$3" ]; then
    cd "$1" || exit 1
    exec ./node_modules/.bin/turbo run build --filter="$3" --concurrency=1 --cache=local:rw 2>&1
  fi
  cd "$2" || exit 1
  exec "$ORKESTRATOR_BASELINE_BUN" run build 2>&1
`;

export interface MergeBaseTestSetup {
  preloads: string[];
  build: string | null;
}

export function parseMergeBaseTestSetup(output: string): MergeBaseTestSetup | null {
  try {
    const setup: MergeBaseTestSetup = JSON.parse(output);
    if (
      Array.isArray(setup.preloads) &&
      setup.preloads.every((item) => typeof item === "string") &&
      (setup.build === null || typeof setup.build === "string")
    )
      return setup;
  } catch {
    // An unsupported or unreadable setup cannot supply baseline evidence.
  }
  return null;
}
