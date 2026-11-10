import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  INTENTIONAL_SUBCLASSES,
  PINNED_CHAINS,
  checkInheritanceChains,
  findChains,
} from "../source-guards/inheritance-chains";
import { RepositoryIndex } from "../source-guards/repository-index";

const repoRoot = resolve(import.meta.dir, "../..");

// The real repository's chains are checked once, in the guard stage
// (`mise run guards`, scripts/guards.ts). These are the resolver's fixtures.
describe("inheritance resolver fixtures", () => {
  const cases: Array<{
    name: string;
    files: Record<string, string>;
    expectedNames: string[][];
  }> = [
    {
      name: "relative named import",
      files: {
        "apps/web/src/lib/base.ts": "export class Base {}",
        "apps/web/src/child.ts": "import { Base } from './lib/base'; class Child extends Base {}",
      },
      expectedNames: [["Base", "Child"]],
    },
    {
      name: "web alias with a duplicate class name elsewhere",
      files: {
        "apps/web/src/lib/base.ts": "export class Base {}",
        "apps/backend/src/base.ts": "export class Base {}",
        "apps/web/src/child.ts": "import { Base } from '@/lib/base'; class Child extends Base {}",
      },
      expectedNames: [["Base", "Child"]],
    },
    {
      name: "renamed import",
      files: {
        "apps/web/src/lib/base.ts": "export class Base {}",
        "apps/web/src/child.ts":
          "import { Base as Parent } from './lib/base.js'; class Child extends Parent {}",
      },
      expectedNames: [["Base", "Child"]],
    },
    {
      name: "renamed barrel re-export through the web alias",
      files: {
        "apps/web/src/lib/base.ts": "export class Base {}",
        "apps/web/src/lib/index.ts": "export { Base as Parent } from './base';",
        "apps/web/src/child.ts":
          "import { Parent as Renamed } from '@/lib'; class Child extends Renamed {}",
      },
      expectedNames: [["Base", "Child"]],
    },
    {
      name: "star barrel re-export",
      files: {
        "apps/web/src/lib/base.ts": "export class Base {}",
        "apps/web/src/lib/index.ts": "export * from './base';",
        "apps/web/src/child.ts": "import { Base } from './lib'; class Child extends Base {}",
      },
      expectedNames: [["Base", "Child"]],
    },
    {
      name: "barrel import followed by a local export",
      files: {
        "apps/web/src/lib/base.ts": "export class Base {}",
        "apps/web/src/lib/index.ts": "import { Base } from './base'; export { Base as Parent };",
        "apps/web/src/child.ts": "import { Parent } from '@/lib'; class Child extends Parent {}",
      },
      expectedNames: [["Base", "Child"]],
    },
    {
      name: "named default class",
      files: {
        "apps/web/src/lib/base.ts": "export default class Base {}",
        "apps/web/src/child.ts": "import Parent from '@/lib/base'; class Child extends Parent {}",
      },
      expectedNames: [["Base", "Child"]],
    },
    {
      name: "default identifier re-exported by a barrel",
      files: {
        "apps/web/src/lib/base.ts": "class Base {} export default Base;",
        "apps/web/src/lib/index.ts": "export { default as Parent } from './base';",
        "apps/web/src/child.ts": "import { Parent } from '@/lib'; class Child extends Parent {}",
      },
      expectedNames: [["Base", "Child"]],
    },
    {
      name: "anonymous default class",
      files: {
        "apps/web/src/lib/base.ts": "export default class {}",
        "apps/web/src/child.ts": "import Parent from './lib/base'; class Child extends Parent {}",
      },
      expectedNames: [["default", "Child"]],
    },
    {
      name: "built-ins and external imports stay allowed despite project name collisions",
      files: {
        "apps/web/src/lib/base.ts":
          "export class Error {} export class Map {} export class EventEmitter {} export class Component {}",
        "apps/web/src/child.ts":
          "import { EventEmitter } from 'node:events'; import { Component } from 'react'; import * as React from 'react'; class BuiltinChild extends Error {} class MapChild extends Map {} class EventChild extends EventEmitter {} class ReactChild extends Component {} class NamespaceChild extends React.Component {}",
      },
      expectedNames: [],
    },
    {
      name: "web alias does not apply to other applications",
      files: {
        "apps/web/src/lib/base.ts": "export class Base {}",
        "apps/backend/src/child.ts":
          "import { Base } from '@/lib/base'; class Child extends Base {}",
      },
      expectedNames: [],
    },
    {
      name: "cyclic star barrels still resolve a reachable base",
      files: {
        "apps/web/src/lib/base.ts": "export class Base {}",
        "apps/web/src/lib/index.ts": "export * from './cycle'; export * from './base';",
        "apps/web/src/lib/cycle.ts": "export * from './index';",
        "apps/web/src/child.ts": "import { Base } from '@/lib'; class Child extends Base {}",
      },
      expectedNames: [["Base", "Child"]],
    },
  ];

  test.each(cases)("$name", ({ files, expectedNames }) => {
    const root = mkdtempSync(join(tmpdir(), "inheritance-guard-"));
    try {
      for (const [path, source] of Object.entries(files)) {
        const file = join(root, path);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, source);
      }
      expect(findChains(RepositoryIndex.fromWalk(root))).toEqual(
        expectedNames.map((names) => ({ names, leafFile: "apps/web/src/child.ts" })),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("recorded inheritance chains", () => {
  const allowed = [...PINNED_CHAINS, ...INTENTIONAL_SUBCLASSES];

  test("a chain outside the recorded sets, and a recorded chain that is gone, are reported", () => {
    const recorded = INTENTIONAL_SUBCLASSES.map((entry) => ({
      names: [...entry.classes],
      leafFile: "apps/backend/src/x.ts",
    }));
    expect(checkInheritanceChains(recorded)).toEqual([]);
    expect(
      checkInheritanceChains([
        ...recorded.slice(1),
        { names: ["Base", "Child"], leafFile: "apps/web/src/child.ts" },
      ]),
    ).toEqual([
      "new chain: Base -> Child in apps/web/src/child.ts",
      `recorded chain no longer exists: ${INTENTIONAL_SUBCLASSES[0]!.classes.join(" -> ")}`,
    ]);
  });

  test("pinned chains are layered and intentional subclasses are one level", () => {
    for (const entry of PINNED_CHAINS) expect(entry.classes.length).toBeGreaterThan(2);
    for (const entry of INTENTIONAL_SUBCLASSES) expect(entry.classes.length).toBe(2);
  });

  test("every recorded chain carries a reason and pinned chains link their plan", () => {
    for (const entry of allowed) expect(entry.reason.length).toBeGreaterThan(40);
    for (const entry of PINNED_CHAINS) expect(existsSync(join(repoRoot, entry.plan))).toBe(true);
  });
});
