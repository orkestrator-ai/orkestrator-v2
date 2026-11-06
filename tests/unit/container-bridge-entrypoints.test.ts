import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const bridges = path.resolve(import.meta.dir, "../../bridges");
for (const directory of readdirSync(bridges, { withFileTypes: true })) {
  if (!directory.isDirectory()) continue;
  const file = path.join(bridges, directory.name, "src/testing/container-fake-engine-server.ts");
  let source: string;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  test(`${directory.name} container fixture restores its environment before engine imports`, () => {
    const firstImport = source.match(/^import\s+[^;]+;/m)?.[0];
    expect(firstImport).toBe('import "@orkestrator/protocol/node/bridge-launch-environment";');
  });
}
