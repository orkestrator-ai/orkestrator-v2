/**
 * A read-only Cursor coordinator's reading tools against a fixture data
 * directory (to-do 7400 task 1). The executors are called the way the SDK
 * calls them; the real filesystem and the SDK's own ripgrep do the rest.
 * Nothing here reads a real credential.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CURSOR_READ_BOUNDARY_REFUSAL,
  cursorCoordinatorReadBoundary,
  cursorReadBoundaryExecutors,
  cursorToolPath,
  type CursorReadBoundaryExecutors,
} from "./read-boundary.js";
import type { TreeNode } from "./read-tools.js";

const SECRET = "FIXTURE-OPERATOR-CREDENTIAL";
const OWN = "FIXTURE-CHECKOUT-FILE";
const ATTACHED = "FIXTURE-ATTACHMENT";

let root: string;
let dataDir: string;
let cwd: string;
let attachmentRoot: string;
let executors: CursorReadBoundaryExecutors;
const secrets: Record<string, string> = {};

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "cursor-read-boundary-")));
  dataDir = join(root, "data-dir");
  cwd = join(root, "project");
  attachmentRoot = join(dataDir, "coordinator-runtime", "c1", "attachments");
  const seed = async (path: string, content: string) => {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content);
    return path;
  };
  secrets.credentials = await seed(join(dataDir, "control-mcp.json"), SECRET);
  secrets.config = await seed(join(dataDir, "config.json"), SECRET);
  secrets.account = await seed(
    join(dataDir, "agent-accounts", "cursor", "a1", "auth.json"),
    SECRET,
  );
  await seed(join(attachmentRoot, "pasted.txt"), ATTACHED);
  await seed(join(cwd, "README.md"), OWN);
  await seed(join(cwd, "src", "app.ts"), `export const own = "${OWN}";\n`);
  // Links from the checkout into the data directory: one file, one directory.
  await symlink(secrets.credentials, join(cwd, "innocent.json"));
  await symlink(dataDir, join(cwd, "linked-dir"));
  const boundary = cursorCoordinatorReadBoundary(cwd, {
    ORKESTRATOR_COORDINATOR_PROTECTED_DATA_DIR: dataDir,
    ORKESTRATOR_BRIDGE_ATTACHMENT_ROOT: attachmentRoot,
  });
  expect(boundary).not.toBeNull();
  executors = cursorReadBoundaryExecutors(boundary!, cwd);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function read(path: string, extra: Record<string, unknown> = {}) {
  return executors.overrideReadExecutor.execute({}, { path, ...extra });
}

function grep(args: Record<string, unknown>) {
  return executors.overrideGrepExecutor.execute({}, args);
}

function ls(path: string) {
  return executors.overrideLsExecutor.execute({}, { path, ignore: [] });
}

function rejection(path: string) {
  return { result: { case: "rejected", value: { path, reason: CURSOR_READ_BOUNDARY_REFUSAL } } };
}

/** Every file name in a listing, with its directory. */
function listed(node: TreeNode): string[] {
  return [
    ...node.childrenFiles.map((file) => join(node.absPath, file.name)),
    ...node.childrenDirs.flatMap(listed),
  ];
}

describe("cursorCoordinatorReadBoundary", () => {
  test("is absent outside a coordinator", () => {
    expect(cursorCoordinatorReadBoundary(cwd, {})).toBeNull();
    expect(
      cursorCoordinatorReadBoundary(cwd, {
        ORKESTRATOR_COORDINATOR_PROTECTED_DATA_DIR: "relative",
      }),
    ).toBeNull();
  });
});

describe("cursorToolPath", () => {
  test("resolves the spellings the SDK accepts", () => {
    expect(cursorToolPath("src/app.ts", cwd)).toBe(join(cwd, "src", "app.ts"));
    expect(cursorToolPath(pathToFileURL(secrets.credentials!).href, cwd)).toBe(secrets.credentials);
    expect(cursorToolPath("../data-dir/config.json", cwd)).toBe(secrets.config);
    expect(cursorToolPath("file://%E0%A4%A", cwd)).toBeUndefined();
  });
});

describe("read", () => {
  test("refuses the data directory however the path is spelled", async () => {
    for (const path of Object.values(secrets)) {
      expect(await read(path)).toEqual(rejection(path));
    }
    expect(await read(pathToFileURL(secrets.credentials!).href)).toEqual(
      rejection(secrets.credentials!),
    );
    expect(await read("../data-dir/config.json")).toEqual(rejection(secrets.config!));
  });

  test("refuses a link in the checkout that points into the data directory", async () => {
    expect(await read("innocent.json")).toEqual(rejection(join(cwd, "innocent.json")));
    expect(await read("linked-dir/control-mcp.json")).toEqual(
      rejection(join(cwd, "linked-dir", "control-mcp.json")),
    );
  });

  test("refuses a URL it cannot decode rather than guessing", async () => {
    const result = await read("file://%E0%A4%A");
    expect(result.result.case).toBe("rejected");
  });

  test("reads the checkout and this conversation's attachments", async () => {
    const own = await read("README.md");
    expect(own.result.case).toBe("success");
    expect(JSON.stringify(own, (_key, value) => (typeof value === "bigint" ? 0 : value))).toContain(
      OWN,
    );
    const attached = await read(join(attachmentRoot, "pasted.txt"));
    expect(attached.result).toMatchObject({
      case: "success",
      value: { output: { case: "content", value: ATTACHED } },
    });
  });

  test("answers an empty path as the SDK does", async () => {
    expect((await read("  ")).result).toMatchObject({ case: "error" });
  });
});

describe("grep and glob", () => {
  test("refuse a search rooted in the data directory, directly or through a link", async () => {
    for (const path of [dataDir, join(cwd, "linked-dir"), "linked-dir/agent-accounts"]) {
      expect(await grep({ pattern: "CREDENTIAL", path })).toEqual({
        result: { case: "error", value: { error: CURSOR_READ_BOUNDARY_REFUSAL } },
      });
    }
  });

  test("a search of the checkout follows links but never returns the data directory", async () => {
    for (const outputMode of ["content", "files_with_matches", "count"]) {
      const result = await grep({ pattern: "FIXTURE", outputMode });
      expect(result.result.case).toBe("success");
      const text = JSON.stringify(result);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain("innocent.json");
      expect(text).not.toContain("control-mcp.json");
      expect(text).not.toContain("auth.json");
      expect(text).toContain("README.md");
    }
  });

  test("a search rooted above the data directory returns everything but it", async () => {
    const result = await grep({ pattern: "FIXTURE", path: root, outputMode: "files_with_matches" });
    expect(result.result.case).toBe("success");
    const text = JSON.stringify(result);
    expect(text).toContain("README.md");
    expect(text).not.toContain("control-mcp.json");
    expect(text).not.toContain("auth.json");
  });

  test("a glob of the checkout lists no file reached through a link", async () => {
    const result = await grep({ pattern: "", glob: "**/*.json", outputMode: "files_with_matches" });
    expect(result.result.case).toBe("success");
    const text = JSON.stringify(result);
    expect(text).not.toContain("control-mcp.json");
    expect(text).not.toContain("innocent.json");
  });
});

describe("ls", () => {
  test("refuses the data directory, directly or through a link", async () => {
    expect(await ls(dataDir)).toEqual(rejection(dataDir));
    expect(await ls("linked-dir")).toEqual(rejection(join(cwd, "linked-dir")));
  });

  test("lists the checkout and a parent without the data directory's files", async () => {
    for (const path of [cwd, root]) {
      const result = await ls(path);
      expect(result.result.case).toBe("success");
      if (result.result.case !== "success") continue;
      const files = listed(result.result.value.directoryTreeRoot);
      expect(files).toContain(join(cwd, "README.md"));
      // Only the attachments are listed from inside the data directory.
      expect(
        files.filter((file) => file.startsWith(dataDir) && !file.startsWith(attachmentRoot)),
      ).toEqual([]);
      expect(files).not.toContain(join(cwd, "innocent.json"));
    }
  });
});
