/**
 * The build has to keep `@cursor/sdk` external.
 *
 * The SDK's ESM build code-splits into numbered chunks it loads with dynamic
 * `import()` at runtime. Bundling it inlines the static graph but cannot follow
 * those, so a bundled bridge starts, serves routes, mints a login URL — and
 * then dies with "Cannot find module './401.js'" the moment a lazy path runs.
 * That is a long way past anything a unit test touches, which is why this
 * checks the build's shape directly.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const packageRoot = path.resolve(import.meta.dir, "..");
const distEntry = path.join(packageRoot, "dist", "index.js");
const vendored = path.join(packageRoot, "dist", "node_modules");

describe("the build script", () => {
  test("keeps @cursor/sdk external", async () => {
    const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(manifest.scripts.build).toContain("--external @cursor/sdk");
    // Vendoring is what makes "external" resolvable from `dist/index.js`;
    // dropping it turns the same bug into a start-up failure instead.
    expect(manifest.scripts.build).toContain("vendor");
  });
});

/**
 * Only meaningful once the bridge has been built, so a clean checkout skips it
 * rather than failing on an absence that is not a defect.
 *
 * Be aware of what that costs: there is no CI job that runs this suite, so on
 * a machine that has never built this package these assertions do not run at
 * all and the block above is the whole check. Run `bun run build:cursor-bridge`
 * before trusting a green result here, and treat the packaging guard in
 * `tests/unit/bridge-packaging.test.ts` — which is unconditional — as the one
 * that holds the shape of this package in place.
 */
describe.if(existsSync(distEntry))("the built bundle", () => {
  test("imports the SDK rather than inlining it", async () => {
    const bundle = await readFile(distEntry, "utf8");
    expect(bundle).toContain("@cursor/sdk");
    // An inlined SDK is orders of magnitude larger than this bridge's own code
    // and is the shape that carries the chunk-loading bug.
    const { size } = await stat(distEntry);
    expect(size).toBeLessThan(1024 * 1024);
  });

  test("vendors the SDK and the closure its flat build imports", async () => {
    expect(existsSync(path.join(vendored, "@cursor", "sdk"))).toBe(true);
    // The flat build the `bun` condition selects imports these by bare
    // specifier, so an absent one fails at the first transport call.
    for (const dependency of [
      path.join("@bufbuild", "protobuf"),
      path.join("@connectrpc", "connect"),
      path.join("@connectrpc", "connect-node"),
    ]) {
      expect(existsSync(path.join(vendored, dependency))).toBe(true);
    }
  });

  test("stages a platform package beside the SDK for its native helpers", async () => {
    // Located by walking up from `dist/index.js` looking for
    // `node_modules/@cursor/sdk-<platform>/`, so it has to live under dist.
    const scope = path.join(vendored, "@cursor");
    const entries = await import("node:fs/promises").then((fs) => fs.readdir(scope));
    expect(entries.some((entry) => entry.startsWith("sdk-"))).toBe(true);
  });
});
