import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { graphTemplateDigest } from "@orkestrator/protocol/graphs/compile";
import { GRAPH_LIBRARY_BOUNDS } from "@orkestrator/protocol/graphs/library";
import { GraphProjectTemplates } from "./graph-project-templates.js";
import { GraphTemplateError } from "./graph-template-errors.js";
import {
  FakeGraphProjectWatch,
  sampleGraphTemplate,
  waitForGraphCondition,
} from "./graph-template-test-support.js";

let root: string;
let checkout: string;
let graphs: string;
let watch: FakeGraphProjectWatch;
let changes: string[];
let reader: GraphProjectTemplates;
let checkouts: Record<string, string | null>;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ork-graph-project-"));
  checkout = path.join(root, "checkout");
  graphs = path.join(checkout, ".orkestrator", "graphs");
  await mkdir(checkout, { recursive: true });
  watch = new FakeGraphProjectWatch();
  changes = [];
  checkouts = { p1: checkout, bare: null };
  reader = new GraphProjectTemplates({
    checkoutOf: async (projectId) => {
      if (!(projectId in checkouts)) throw new GraphTemplateError("not-found", "no project");
      return checkouts[projectId] ?? null;
    },
    onChange: (projectId) => changes.push(projectId),
    startWatch: watch.start,
    settleMs: 0,
  });
});

afterEach(async () => {
  reader.close();
  await rm(root, { recursive: true, force: true });
});

async function write(name: string, value: unknown): Promise<void> {
  await mkdir(graphs, { recursive: true });
  await writeFile(
    path.join(graphs, name),
    typeof value === "string" ? value : JSON.stringify(value),
  );
}

describe("reading .orkestrator/graphs", () => {
  test("a missing directory or checkout lists nothing", async () => {
    expect((await reader.scan("p1")).source).toMatchObject({
      status: "ok",
      files: 0,
      problems: [],
    });
    expect((await reader.scan("bare")).source.status).toBe("no-checkout");
    await expect(reader.scan("gone")).rejects.toThrow(GraphTemplateError);
  });

  test("reads valid templates with digests and reports every refused file", async () => {
    const template = sampleGraphTemplate("from-repo");
    await write("review.graph.json", template);
    await write("broken.graph.json", "{ not json");
    await write("dupe.graph.json", '{"format":"orkestrator.graph","format":"x"}');
    await write("big.graph.json", "x".repeat(GRAPH_LIBRARY_BOUNDS.maxProjectFileBytes + 1));
    await write(".hidden.graph.json", template);
    await write("notes.json", template);
    await mkdir(path.join(graphs, "dir.graph.json"));
    await writeFile(path.join(root, "outside.json"), JSON.stringify(template));
    await symlink(path.join(root, "outside.json"), path.join(graphs, "link.graph.json"));

    const scan = await reader.scan("p1");
    expect(scan.files.map((file) => file.path)).toEqual([".orkestrator/graphs/review.graph.json"]);
    expect(scan.files[0]?.digest).toBe(graphTemplateDigest(template));
    expect(scan.source.problems.map((problem) => [problem.path, problem.code])).toEqual([
      [".orkestrator/graphs/.hidden.graph.json", "invalid-name"],
      [".orkestrator/graphs/big.graph.json", "too-large"],
      [".orkestrator/graphs/broken.graph.json", "invalid-template"],
      [".orkestrator/graphs/dir.graph.json", "not-a-file"],
      [".orkestrator/graphs/dupe.graph.json", "invalid-template"],
      [".orkestrator/graphs/link.graph.json", "not-a-file"],
    ]);
    // Duplicate keys are refused by the strict reader, with the guard's code.
    const dupe = scan.source.problems.find((problem) => problem.path.endsWith("dupe.graph.json"));
    expect(dupe?.errors?.[0]?.code).toBe("invalid_json");
    // Problems never echo file contents.
    expect(JSON.stringify(scan.source)).not.toContain("not json");
  });

  test("bounds the number of files read", async () => {
    await mkdir(graphs, { recursive: true });
    for (let index = 0; index <= GRAPH_LIBRARY_BOUNDS.maxProjectFiles; index += 1) {
      await writeFile(path.join(graphs, `t${String(index).padStart(3, "0")}.graph.json`), "{}");
    }
    const scan = await reader.scan("p1");
    expect(scan.source.truncated).toBe(true);
    expect(scan.source.files).toBe(GRAPH_LIBRARY_BOUNDS.maxProjectFiles);
    expect(scan.source.problems[0]?.code).toBe("too-many-files");
  });

  test("refuses a template directory that leads outside the checkout", async () => {
    const elsewhere = path.join(root, "elsewhere");
    await mkdir(elsewhere, { recursive: true });
    await writeFile(path.join(elsewhere, "x.graph.json"), JSON.stringify(sampleGraphTemplate()));
    await mkdir(path.join(checkout, ".orkestrator"), { recursive: true });
    await symlink(elsewhere, graphs);
    const scan = await reader.scan("p1");
    expect(scan.source.status).toBe("unavailable");
    expect(scan.files).toEqual([]);
  });

  test("reuses a scan while nothing changed and re-reads after a change", async () => {
    await write("a.graph.json", sampleGraphTemplate("a"));
    const first = await reader.scan("p1");
    expect(await reader.scan("p1")).toBe(first);
    await write("a.graph.json", { ...sampleGraphTemplate("a"), name: "Changed name" });
    const second = await reader.scan("p1");
    expect(second).not.toBe(first);
    expect(second.files[0]?.template.name).toBe("Changed name");
  });
});

describe("watching", () => {
  test("watches the template directory without recursion and re-reads on an event", async () => {
    await write("a.graph.json", sampleGraphTemplate("a"));
    await reader.scan("p1");
    await waitForGraphCondition(() => watch.open().length === 1);
    expect(watch.open()).toEqual([graphs]);

    await write("a.graph.json", { ...sampleGraphTemplate("a"), name: "Edited" });
    watch.fire();
    await waitForGraphCondition(() => changes.length === 1);
    expect(changes).toEqual(["p1"]);
    expect((await reader.scan("p1")).files[0]?.template.name).toBe("Edited");

    // An event that changes nothing the library shows is not announced.
    watch.fire();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(changes).toEqual(["p1"]);
  });

  test("watches the nearest existing parent until the directory exists", async () => {
    await reader.scan("p1");
    await waitForGraphCondition(() => watch.open().length === 1);
    expect(watch.open()).toEqual([checkout]);
    await write("new.graph.json", sampleGraphTemplate("new"));
    watch.fire();
    await waitForGraphCondition(() => changes.length === 1);
    // The rescan moved the watch down to the template directory.
    await waitForGraphCondition(() => watch.open()[0] === graphs);
    expect(watch.open()).toEqual([graphs]);
    expect(watch.closed).toBe(1);
  });

  test("stops watching on close and evicts the least recently scanned project", async () => {
    const small = new GraphProjectTemplates({
      checkoutOf: async (projectId) => (projectId === "bare" ? null : checkout),
      startWatch: watch.start,
      maxWatchedProjects: 1,
    });
    await small.scan("one");
    await waitForGraphCondition(() => small.watchedProjects().length === 1);
    await small.scan("two");
    await waitForGraphCondition(() => small.watchedProjects()[0] === "two");
    expect(small.watchedProjects()).toEqual(["two"]);
    small.close();
    expect(small.watchedProjects()).toEqual([]);
    expect(watch.open()).toEqual([]);
  });
});
