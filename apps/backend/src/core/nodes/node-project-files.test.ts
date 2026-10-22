import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { NodeFiles, parseEnv, type NodeFileScope } from "./node-files.js";
import { NodeProjectFiles } from "./node-project-files.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const GIT_URL = "git@github.com:acme/site.git";

async function checkout(name: string, files: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), `ork-pf-${name}-`));
  dirs.push(root);
  const dir = path.join(root, "checkout");
  await Bun.write(path.join(dir, ".keep"), "");
  for (const [file, content] of Object.entries(files))
    await Bun.write(path.join(dir, file), content);
  return { root, dir };
}

function storageFor(projectId: string, dir: string, dataDir: string, filesToCopy: string[]) {
  return {
    getDataDir: () => dataDir,
    getProject: async (id: string) =>
      id === projectId ? { id, localPath: dir, gitUrl: GIT_URL } : null,
    loadProjects: async () => [{ id: projectId, localPath: dir, gitUrl: GIT_URL }],
    getEnvironment: async (id: string) => (id === "env-1" ? { id, projectId } : null),
    getRepositoryConfig: async () => ({ filesToCopy }),
  };
}

function fileCommands(files: NodeFiles) {
  return async <T>(command: string, args: Record<string, unknown>): Promise<T> => {
    const scope = args.scope as NodeFileScope;
    const map: Record<string, () => Promise<unknown>> = {
      stat_node_file: () => files.stat(scope, String(args.path)),
      read_node_file: () =>
        files.read(scope, String(args.path), Number(args.offset), Number(args.length)),
      begin_node_file_write: () =>
        files.beginWrite({
          scope,
          path: String(args.path),
          size: Number(args.size),
          sha256: String(args.sha256),
          overwrite: args.overwrite === true,
        }),
      append_node_file_write: () =>
        files.appendWrite(String(args.uploadId), String(args.contentBase64)),
      commit_node_file_write: () => files.commitWrite(String(args.uploadId)),
      abort_node_file_write: () => files.abortWrite(String(args.uploadId)),
      get_project_seed_files: () => files.seedFiles(String(args.projectId)),
      fingerprint_project_files: () =>
        files.fingerprints(
          String(args.projectId),
          args.files as string[],
          Buffer.from(String(args.key), "base64"),
        ),
      apply_env_keys: () =>
        files.applyEnvKeys(
          String(args.projectId),
          String(args.path),
          args.set as Record<string, string>,
          args.remove as string[],
        ),
      read_env_values: () =>
        files.envValues(String(args.projectId), String(args.path), args.keys as string[]),
    };
    return (await map[command]!()) as T;
  };
}

async function world(options: {
  local: Record<string, string>;
  leaf: Record<string, string>;
  filesToCopy?: string[];
  leafFilesToCopy?: string[];
}) {
  const local = await checkout("command", options.local);
  const leaf = await checkout("leaf", options.leaf);
  const localFiles = new NodeFiles(
    storageFor(
      "p-self",
      local.dir,
      path.join(local.root, "data"),
      options.filesToCopy ?? [],
    ) as never,
  );
  const leafFiles = new NodeFiles(
    storageFor(
      "p-leaf",
      leaf.dir,
      path.join(leaf.root, "data"),
      options.leafFilesToCopy ?? options.filesToCopy ?? [],
    ) as never,
  );
  const leafInvoke = fileCommands(leafFiles);
  const delivered: Array<{ body: string }> = [];
  const portal = {
    summaries: async () => ({
      selfId: "bk_self",
      nodes: [
        {
          nodeId: "bk_leaf",
          view: { displayName: "Build box" },
          available: true,
          projects: [
            {
              ref: { backendId: "bk_leaf", projectId: "p-leaf" },
              repositoryHint: "github.com/acme/site",
            },
          ],
        },
      ],
    }),
    invokeOnNode: async (args: { command: string; args: Record<string, unknown> }) => ({
      outcome: "ok",
      result: await leafInvoke(args.command, args.args),
    }),
  };
  const projectFiles = new NodeProjectFiles({
    storage: storageFor(
      "p-self",
      local.dir,
      path.join(local.root, "data"),
      options.filesToCopy ?? [],
    ) as never,
    nodes: { selfIdentity: async () => "bk_self" } as never,
    portal: portal as never,
    local: localFiles,
    localInvoke: fileCommands(localFiles),
    deliverToConversation: async (input) => {
      delivered.push(input);
    },
  });
  return { local, leaf, projectFiles, delivered };
}

describe("FL-06 comparing project files across nodes", () => {
  test("reports missing, extra, same and different files, and .env key changes without values", async () => {
    const { projectFiles } = await world({
      local: { ".env": "API_KEY=secret-a\nSHARED=1\nONLY_HERE=x\n", "config/local.json": "{}" },
      leaf: { ".env": "API_KEY=secret-b\nSHARED=1\nONLY_THERE=y\n", ".env.local": "Z=1" },
      filesToCopy: ["config/local.json"],
    });
    const result = await projectFiles.compare("p-self");
    expect(result.files).toEqual([".env", ".env.local", "config/local.json"]);
    const node = result.nodes[0]!;
    expect(node).toMatchObject({ nodeId: "bk_leaf", projectId: "p-leaf", available: true });
    const byPath = new Map(node.files.map((entry) => [entry.path, entry]));
    expect(byPath.get(".env")).toEqual({
      path: ".env",
      status: "differs",
      keys: { added: ["ONLY_THERE"], removed: ["ONLY_HERE"], changed: ["API_KEY"], same: 1 },
    });
    expect(byPath.get(".env.local")!.status).toBe("only-on-node");
    expect(byPath.get("config/local.json")!.status).toBe("missing-on-node");
    const text = JSON.stringify(result);
    for (const secret of ["secret-a", "secret-b", "ONLY_HERE=x"])
      expect(text).not.toContain(secret);
  });
});

describe("FL-04/FL-05 seed files for a leaf environment", () => {
  test("only the files the leaf lacks are staged from the command node; the leaf's own copy wins", async () => {
    const { leaf, projectFiles } = await world({
      local: { ".env": "FROM=command", "config/local.json": '{"from":"command"}' },
      leaf: { ".env": "FROM=leaf" },
      filesToCopy: ["config/local.json"],
    });
    await projectFiles.seedEnvironment("bk_leaf" as never, "p-leaf", "env-1");
    const staging = path.join(leaf.root, "data", "node-seed", "env-1");
    expect(await readFile(path.join(staging, "config/local.json"), "utf8")).toBe(
      '{"from":"command"}',
    );
    // The leaf has its own .env: nothing from the command node is staged for it.
    await expect(readFile(path.join(staging, ".env"), "utf8")).rejects.toThrow();
  });
});

describe("FL-08/FL-07 approved updates and reveals", () => {
  const request = (kind: string, targets: Array<Record<string, unknown>>) =>
    ({
      requestId: "req-1",
      kind,
      targets,
      requestedBy: {
        coordinatorEnvironmentId: "coordinator:c:main",
        coordinatorTabId: "tab",
        projectId: "p-self",
      },
      createdAt: "",
      expiresAt: "",
      state: "approved",
    }) as never;

  test("key-level updates copy values node to node and keep the leaf's other lines", async () => {
    const { leaf, projectFiles } = await world({
      local: { ".env": "API_KEY=new-secret\nDEBUG=0\n" },
      leaf: { ".env": "# leaf\nAPI_KEY=old\nLEAF_ONLY=1\n" },
    });
    const result = await projectFiles.executeUpdate(
      request("update-project-files", [
        {
          nodeId: "bk_leaf",
          nodeName: "Build box",
          projectId: "p-leaf",
          files: [".env"],
          keys: ["API_KEY"],
        },
      ]),
    );
    expect(result.message).not.toContain("new-secret");
    const values = new Map(parseEnv(await readFile(path.join(leaf.dir, ".env"), "utf8")));
    expect(values.get("API_KEY")).toBe("new-secret");
    expect(values.get("LEAF_ONLY")).toBe("1");
  });

  test("whole files are replaced through the transfer framework", async () => {
    const { leaf, projectFiles } = await world({
      local: { "config/local.json": '{"v":2}' },
      leaf: { "config/local.json": '{"v":1}' },
    });
    await projectFiles.executeUpdate(
      request("update-project-files", [
        {
          nodeId: "bk_leaf",
          nodeName: "Build box",
          projectId: "p-leaf",
          files: ["config/local.json"],
        },
      ]),
    );
    expect(await readFile(path.join(leaf.dir, "config/local.json"), "utf8")).toBe('{"v":2}');
  });

  test("a reveal mails the value to the requesting conversation and keeps it out of the result", async () => {
    const { projectFiles, delivered } = await world({ local: {}, leaf: { ".env": "TOKEN=abc\n" } });
    const result = await projectFiles.executeReveal(
      request("reveal-env-value", [
        {
          nodeId: "bk_leaf",
          nodeName: "Build box",
          projectId: "p-leaf",
          files: [".env"],
          keys: ["TOKEN"],
        },
      ]),
    );
    expect(JSON.stringify(result)).not.toContain("abc");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.body).toBe("TOKEN (.env on Build box) = abc");
  });
});

test("only command-selected paths can be seeded and the completed manifest includes command-only files", async () => {
  const { projectFiles, leaf } = await world({
    local: { "config/only.json": "selected", "secret.pem": "unselected" },
    leaf: {},
    filesToCopy: ["config/only.json"],
    leafFilesToCopy: ["secret.pem"],
  });
  await projectFiles.seedEnvironment("bk_leaf" as never, "p-leaf", "env-1");
  const root = path.join(leaf.root, "data", "node-seed", "env-1");
  expect(await readFile(path.join(root, "config/only.json"), "utf8")).toBe("selected");
  await expect(readFile(path.join(root, "secret.pem"))).rejects.toThrow();
  const { readSeedManifest } = await import("./node-seed.js");
  expect(await readSeedManifest(root)).toEqual(["config/only.json"]);
});
