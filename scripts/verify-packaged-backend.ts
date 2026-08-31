import { semver } from "bun";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(import.meta.dir, "..");
const releaseRoot = path.join(repositoryRoot, "release");
const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADklEQVR4AWL6////fwAAAAD//w7I1cwAAAAGSURBVAMACgUD/9k79a8AAAAASUVORK5CYII=",
  "base64",
);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

async function findResourceRoots(directory: string, depth = 0): Promise<string[]> {
  if (depth > 6) return [];
  if (await exists(path.join(directory, "backend", "main.js"))) return [directory];

  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isDirectory() && !["backend", "node_modules", "locales"].includes(entry.name),
      )
      .map((entry) => findResourceRoots(path.join(directory, entry.name), depth + 1)),
  );
  return nested.flat();
}

function assertDescendant(parent: string, candidate: string, label: string): void {
  const relative = path.relative(parent, candidate);
  assert(
    relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    `${label} resolved outside ${parent}: ${candidate}`,
  );
}

const backendManifest = JSON.parse(
  await readFile(path.join(repositoryRoot, "apps/backend/package.json"), "utf8"),
) as { dependencies: { sharp: string } };
const resourceRoots = await findResourceRoots(releaseRoot);
assert(resourceRoots.length > 0, `No packaged backend was found under ${releaseRoot}`);

for (const resourceRoot of resourceRoots) {
  const backendRoot = path.join(resourceRoot, "backend");
  const packagedNodeModules = path.join(backendRoot, "node_modules");
  const packagedSharpRoot = path.join(packagedNodeModules, "sharp");
  const resolvedSharp = Bun.resolveSync("sharp", backendRoot);
  assertDescendant(packagedSharpRoot, resolvedSharp, "sharp");

  const sharpManifest = JSON.parse(
    await readFile(path.join(packagedSharpRoot, "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string>; version: string };
  assert(
    semver.satisfies(sharpManifest.version, backendManifest.dependencies.sharp),
    `Packaged sharp ${sharpManifest.version} does not satisfy ${backendManifest.dependencies.sharp}`,
  );
  for (const dependency of Object.keys(sharpManifest.dependencies ?? {})) {
    const resolvedDependency = Bun.resolveSync(dependency, packagedSharpRoot);
    assertDescendant(packagedNodeModules, resolvedDependency, dependency);
  }

  const sharpModule = (await import(pathToFileURL(resolvedSharp).href)) as {
    default: (input: Buffer) => {
      resize(
        width: number,
        height: number,
      ): {
        webp(): { toBuffer(): Promise<Buffer> };
      };
    };
  };
  const webp = await sharpModule.default(onePixelPng).resize(1, 1).webp().toBuffer();
  assert(webp.subarray(0, 4).toString("ascii") === "RIFF", "Sharp did not produce a WebP RIFF");
  assert(webp.subarray(8, 12).toString("ascii") === "WEBP", "Sharp output is not WebP");

  console.log(
    `Verified packaged Sharp ${sharpManifest.version} at ${path.relative(repositoryRoot, resolvedSharp)}`,
  );
}
