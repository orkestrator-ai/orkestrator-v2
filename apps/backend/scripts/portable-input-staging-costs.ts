/**
 * Host-side cost of staging agent-home inputs (DK-14, E25), on fixture homes:
 *
 *   mise exec -- bun apps/backend/scripts/portable-input-staging-costs.ts \
 *     --root output/efficiency/staging [--rounds 5] [--fixtures small,medium,plugins]
 *
 * Each round stages every fixture once per variant, interleaved so host load
 * falls on all of them alike: `clone` (the default staging) and `copy`
 * (`cloneFiles: false`, the byte copy every file took before reflinks). An
 * older `stagePortableInputs` ignores the option, so the script also measures
 * the code before the change. `--root` must be a directory this run may fill;
 * each fixture home and data directory is created inside a fresh temporary
 * directory there and removed afterwards. On btrfs the exclusive bytes of a
 * revision come from `btrfs filesystem du`, which is what reflinks save.
 *
 * It never reads a real home or data directory, and prints aggregates only.
 */
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import { stagePortableInputs } from "../src/core/portable-inputs.js";

type Fixture = {
  /** Skill directories per skills root (Claude, Codex, `~/.agents/skills`). */
  skills: number;
  /** Plugin files in Claude's `plugins` and in Codex's `plugins/cache`. */
  pluginFiles: number;
  pluginFileBytes: number;
};

const FIXTURES: Record<string, Fixture> = {
  small: { skills: 10, pluginFiles: 50, pluginFileBytes: 16 * 1024 },
  medium: { skills: 200, pluginFiles: 2_000, pluginFileBytes: 16 * 1024 },
  plugins: { skills: 20, pluginFiles: 600, pluginFileBytes: 256 * 1024 },
};

const BTRFS_MAGIC = 0x9123683e;

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

async function writeSkills(root: string, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const skill = path.join(root, `skill-${index}`);
    await mkdir(path.join(skill, "references"), { recursive: true });
    await writeFile(
      path.join(skill, "SKILL.md"),
      `# Skill ${index}\n\n${"Some guidance. ".repeat(80)}`,
    );
    await writeFile(path.join(skill, "references", "notes.md"), "Reference text. ".repeat(200));
  }
}

async function writePlugins(root: string, fixture: Fixture): Promise<void> {
  const perDirectory = 50;
  for (let index = 0; index < fixture.pluginFiles; index += 1) {
    const directory = path.join(root, `plugin-${Math.floor(index / perDirectory)}`);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `file-${index}.js`), randomBytes(fixture.pluginFileBytes));
  }
}

async function buildHome(home: string, fixture: Fixture): Promise<void> {
  await mkdir(path.join(home, ".claude"), { recursive: true });
  await writeFile(path.join(home, ".claude", "CLAUDE.md"), "# Instructions\n");
  await writeSkills(path.join(home, ".claude", "skills"), fixture.skills);
  await writePlugins(path.join(home, ".claude", "plugins", "marketplaces"), fixture);
  await mkdir(path.join(home, ".codex"), { recursive: true });
  await writeFile(path.join(home, ".codex", "config.toml"), 'model = "fixture"\n');
  await writeSkills(path.join(home, ".codex", "skills"), fixture.skills);
  await writePlugins(path.join(home, ".codex", "plugins", "cache"), fixture);
  await writeSkills(path.join(home, ".agents", "skills"), fixture.skills);
}

/** The bytes only this revision holds, or null where the filesystem cannot say. */
async function exclusiveBytes(directory: string): Promise<number | null> {
  if (Number((await statfs(directory)).type) !== BTRFS_MAGIC) return null;
  // Delayed allocation leaves unwritten data out of the extent counts until a flush.
  await Bun.spawn(["sync", "-f", directory]).exited;
  const child = Bun.spawn(["btrfs", "filesystem", "du", "-s", "--raw", directory], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const output = await new Response(child.stdout).text();
  if ((await child.exited) !== 0) return null;
  const columns = output.trim().split("\n").at(-1)?.trim().split(/\s+/) ?? [];
  const exclusive = Number(columns[1]);
  return Number.isFinite(exclusive) ? exclusive : null;
}

const root = path.resolve(argument("root", "output/efficiency/staging"));
const rounds = Number(argument("rounds", "5"));
const names = argument("fixtures", "small,medium,plugins").split(",");
await mkdir(root, { recursive: true });
const work = await mkdtemp(path.join(root, "run-"));
const providers = new Set(["claude", "codex", "shared-skills"] as const);
const variants = { clone: true, copy: false } as const;
type Variant = keyof typeof variants;

try {
  for (const name of names) {
    const fixture = FIXTURES[name];
    if (!fixture) throw new Error(`Unknown fixture ${name}`);
    const home = path.join(work, `home-${name}`);
    const dataDir = path.join(work, `data-${name}`);
    await buildHome(home, fixture);
    const samples = new Map<Variant, number[]>([
      ["clone", []],
      ["copy", []],
    ]);
    const exclusive = new Map<Variant, number | null>();
    let staged = { files: 0, bytes: 0 };
    for (let round = 0; round <= rounds; round += 1) {
      for (const variant of Object.keys(variants) as Variant[]) {
        const environmentId = `${name}-${variant}-${round}`;
        const started = performance.now();
        const result = await stagePortableInputs(
          dataDir,
          environmentId,
          providers,
          { home, agentTest: false },
          new Date(),
          undefined,
          // Ignored by a `stagePortableInputs` that predates the option.
          { cloneFiles: variants[variant] } as never,
        );
        const elapsed = performance.now() - started;
        // Round 0 warms the page cache and is not counted.
        if (round > 0) samples.get(variant)?.push(elapsed);
        staged = result.providers.reduce(
          (sum, provider) => ({
            files: sum.files + provider.files,
            bytes: sum.bytes + provider.bytes,
          }),
          { files: 0, bytes: 0 },
        );
        if (round === rounds) exclusive.set(variant, await exclusiveBytes(result.directory));
        await rm(path.dirname(result.directory), { recursive: true, force: true });
      }
    }
    for (const variant of Object.keys(variants) as Variant[]) {
      const values = samples.get(variant) ?? [];
      console.log(
        JSON.stringify({
          fixture: name,
          variant,
          stagedFiles: staged.files,
          stagedMiB: Number((staged.bytes / 1024 ** 2).toFixed(1)),
          medianMs: Math.round(median(values)),
          minMs: Math.round(Math.min(...values)),
          maxMs: Math.round(Math.max(...values)),
          exclusiveMiB:
            exclusive.get(variant) == null
              ? null
              : Number(((exclusive.get(variant) ?? 0) / 1024 ** 2).toFixed(1)),
        }),
      );
    }
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
