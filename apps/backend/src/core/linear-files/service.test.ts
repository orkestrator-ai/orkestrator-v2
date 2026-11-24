import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/server";
import { mkdtemp, readdir, readFile, rm, stat, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BUILD_PIPELINE_VERSION, type BuildPipeline } from "@orkestrator/protocol/build-pipeline";
import { runCommand } from "../command-capture.js";
import { callToolInProcess, listToolsInProcess } from "../mcp-in-process.js";
import { linearFileName, safeFileName } from "./issue-files.js";
import { LinearFileService, type LinearFileServiceDependencies } from "./service.js";
import { registerLinearFileTool } from "./tool.js";

const KEY = "lin_api_secret";
const ZIP = "https://uploads.linear.app/ws/aaaa/bbbb";
const LOGO = "https://uploads.linear.app/ws/cccc/dddd";
const NOTES = "https://uploads.linear.app/ws/eeee/ffff";
const SCOPE = { environmentId: "env-1", projectId: "project-1" };
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

const originalFetch = globalThis.fetch;
let worktree: string;
let apiKey: string | null;
let board: { teamId: string } | null;
let pipelines: BuildPipeline[];
let issue: Record<string, unknown>;
let fileAnswers: Map<string, () => Response>;
let fetched: string[];

const description = `Use [package.zip](${ZIP}) and ![logo](${LOGO}).`;

function taskSnapshot(text = description, comments: string[] = []) {
  return {
    title: "DND-107: Landing page",
    description: text,
    acceptanceCriteria: "",
    comments: comments.map((comment) => ({ text: comment })),
    images: [],
  };
}

function linearPipeline(): BuildPipeline {
  return {
    version: BUILD_PIPELINE_VERSION,
    id: "pipeline-1",
    taskId: "issue-1",
    projectId: SCOPE.projectId,
    environmentId: SCOPE.environmentId,
    environmentType: "local",
    agentType: "claude",
    phase: "building",
    sessions: [],
    currentSessionIndex: -1,
    iteration: 0,
    maxIterations: 3,
    createdAt: "2026-11-24T10:00:00.000Z",
    taskTitle: "DND-107",
    taskSnapshot: taskSnapshot(),
    source: { type: "linear", issueId: "issue-1", issueIdentifier: "DND-107" },
    backendRevision: 0,
    controller: "backend",
  } as BuildPipeline;
}

function service(overrides: Partial<LinearFileServiceDependencies> = {}): LinearFileService {
  return new LinearFileService({
    storage: {
      getEnvironment: async (id: string) =>
        id === SCOPE.environmentId
          ? { id, projectId: SCOPE.projectId, environmentType: "local", worktreePath: worktree }
          : null,
      getProject: async (id: string) => ({ id, name: "Web", gitUrl: null }),
      kanban: { getLinearAuth: async () => (apiKey ? { apiKey } : null) },
      linear: { getLinearBoardLink: async () => board },
      listBuildPipelines: async () => pipelines.map((snapshot) => ({ snapshot })),
    } as unknown as LinearFileServiceDependencies["storage"],
    fence: { beginMutation: () => () => undefined },
    ...overrides,
  });
}

beforeEach(async () => {
  worktree = await mkdtemp(path.join(os.tmpdir(), "linear-files-"));
  await runCommand("git", ["init", "--quiet", worktree], { timeoutMs: 10_000 });
  apiKey = KEY;
  board = null;
  pipelines = [linearPipeline()];
  issue = {
    id: "issue-1",
    identifier: "DND-107",
    description,
    team: { id: "team-1" },
    project: null,
    attachments: { nodes: [] },
    comments: {
      nodes: [{ body: `Also [notes.md](${NOTES})` }],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  };
  fileAnswers = new Map([
    [ZIP, () => new Response("zip-bytes", { headers: { "content-type": "application/zip" } })],
    [LOGO, () => new Response(PNG, { headers: { "content-type": "image/png" } })],
    [NOTES, () => new Response("notes")],
  ]);
  fetched = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "https://api.linear.app/graphql") return Response.json({ data: { issue } });
    fetched.push(url);
    return fileAnswers.get(url)?.() ?? new Response("missing", { status: 404 });
  }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await rm(worktree, { recursive: true, force: true });
});

describe("file names", () => {
  test("cannot leave the directory and keep the file's extension", () => {
    expect(safeFileName("../../etc/passwd")).toBe("etc-passwd");
    expect(safeFileName(".env")).toBe("env");
    expect(safeFileName(`${"a".repeat(300)}.zip`)).toMatch(/^a{116}\.zip$/);
    expect(linearFileName({ url: ZIP, name: "pack.zip" }, {})).toMatch(/^[0-9a-f]{8}-pack\.zip$/);
    expect(linearFileName({ url: ZIP, name: "logo" }, { contentType: "image/png" })).toMatch(
      /-logo\.png$/,
    );
    expect(linearFileName({ url: ZIP, name: "logo" }, { filename: "real.svg" })).toMatch(
      /-real\.svg$/,
    );
    expect(linearFileName({ url: ZIP }, {})).toMatch(/^[0-9a-f]{8}-file$/);
    expect(linearFileName({ url: ZIP, name: "image.png" }, {})).not.toBe(
      linearFileName({ url: LOGO, name: "image.png" }, {}),
    );
  });
});

describe("the build's files", () => {
  test("are written Git-excluded and named in the prompt, with images for the ticket", async () => {
    const prepared = (await service().prepareBuild(linearPipeline()))!;

    const directory = path.join(worktree, ".orkestrator/linear-files/DND-107");
    const names = (await readdir(directory)).sort();
    expect(names).toHaveLength(2);
    const zip = names.find((name) => name.endsWith("-package.zip"))!;
    expect(await readFile(path.join(directory, zip), "utf8")).toBe("zip-bytes");
    expect((await stat(path.join(directory, zip))).mode & 0o777).toBe(0o644);
    const { stdout } = await runCommand(
      "git",
      ["-C", worktree, "status", "--porcelain", "--untracked-files=all"],
      { timeoutMs: 10_000 },
    );
    expect(stdout).toBe("");

    expect(prepared.section).toContain(`.orkestrator/linear-files/DND-107/${zip}`);
    expect(prepared.section).not.toContain("could not be downloaded");
    expect(prepared.images).toEqual([
      { filename: expect.stringMatching(/-logo\.png$/), data: PNG.toString("base64") },
    ]);
    // The comment's file is not in this build's ticket: comments were left out.
    expect(fetched).toEqual([ZIP, LOGO]);
  });

  test("include the quoted comments' files", async () => {
    const pipeline = { ...linearPipeline(), taskSnapshot: taskSnapshot("", [`See ${NOTES}`]) };
    await service().prepareBuild(pipeline);
    expect(fetched).toEqual([NOTES]);
  });

  test("are only ones the live issue itself refers to", async () => {
    const other = "https://uploads.linear.app/ws/other/secret";
    const pipeline = { ...linearPipeline(), taskSnapshot: taskSnapshot(`See ${other}`) };
    const prepared = (await service().prepareBuild(pipeline))!;
    expect(fetched).toEqual([]);
    expect(prepared.section).toContain("no longer refers to it");
  });

  test("report one that failed beside the ones that worked", async () => {
    fileAnswers.set(ZIP, () => new Response("no", { status: 403 }));
    const prepared = (await service().prepareBuild(linearPipeline()))!;
    expect(prepared.section).toContain("-logo.png");
    expect(prepared.section).toContain(`${ZIP}: Linear refused the download (403)`);
    expect(prepared.section).toContain("download_linear_files");
  });

  test("never stop the build: a missing key or workspace is said in the prompt", async () => {
    apiKey = null;
    const unconnected = (await service().prepareBuild(linearPipeline()))!;
    expect(unconnected.section).toContain("Linear is not connected on this machine");
    expect(unconnected.images).toEqual([]);

    apiKey = KEY;
    const gone = (await service().prepareBuild({ ...linearPipeline(), environmentId: "gone" }))!;
    expect(gone.section).toContain("no workspace to download files into");
  });

  test("are nothing for a ticket without files or not from Linear", async () => {
    expect(
      await service().prepareBuild({ ...linearPipeline(), taskSnapshot: taskSnapshot("None") }),
    ).toBeNull();
    expect(
      await service().prepareBuild({
        ...linearPipeline(),
        source: { type: "kanban", taskId: "task" },
      }),
    ).toBeNull();
  });

  test("never hold the key in what the agent reads", async () => {
    globalThis.fetch = (async () => {
      throw new Error(`refused ${KEY}`);
    }) as unknown as typeof fetch;
    const prepared = (await service().prepareBuild(linearPipeline()))!;
    expect(prepared.section).not.toContain(KEY);
  });

  test("do not follow a symbolic link the repository put in the way", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "linear-files-outside-"));
    try {
      await symlink(outside, path.join(worktree, ".orkestrator"));
      const prepared = (await service().prepareBuild(linearPipeline()))!;
      expect(prepared.section).not.toContain("Orkestrator downloaded");
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("stop at the issue's size limit", async () => {
    const prepared = (await service({ maxIssueBytes: "zip-bytes".length }).prepareBuild(
      linearPipeline(),
    ))!;
    expect(prepared.section).toContain("-package.zip");
    expect(prepared.section).toContain("files together are too large");
  });

  test("are piped into a container", async () => {
    const writes: string[][] = [];
    const container = service({
      run: (async (_command: string, args: string[]) => {
        writes.push(args);
        return { stdout: "", stderr: "" };
      }) as unknown as typeof runCommand,
    });
    // Only the write is under test: the Git exclusion runs in a real container.
    const write = (
      container as unknown as {
        write(environment: object, file: string, contents: Buffer, max: number): Promise<void>;
      }
    ).write.bind(container);
    await write(
      { id: "env-1", environmentType: "container", containerId: "c1" },
      ".orkestrator/linear-files/DND-107/x.zip",
      Buffer.from("zip"),
      100,
    );
    expect(writes[0]).toEqual(
      expect.arrayContaining(["c1", ".orkestrator/linear-files/DND-107", "x.zip", String(0o644)]),
    );
  });
});

describe("download_linear_files", () => {
  const factory =
    (host = service(), scope = SCOPE) =>
    async () => {
      const server = new McpServer({ name: "test", version: "1.0.0" });
      server.registerTool("other", { description: "Keeps the list non-empty." }, async () => ({
        content: [],
      }));
      await registerLinearFileTool(server, host, scope);
      return server;
    };
  const call = (args: Record<string, unknown> = {}) =>
    callToolInProcess(factory(), "download_linear_files", args);

  test("is listed for a Linear build or a linked board, and nowhere else", async () => {
    const names = async () => (await listToolsInProcess(factory())).map((tool) => tool.name);
    expect(await names()).toEqual(["other", "download_linear_files"]);
    pipelines = [];
    expect(await names()).toEqual(["other"]);
    board = { teamId: "team-1" };
    expect(await names()).toEqual(["other", "download_linear_files"]);
  });

  test("downloads every file of the build's issue, comments included", async () => {
    const result = await call();
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      issue: "DND-107",
      files: [
        { name: "package.zip", url: ZIP, bytes: 9 },
        { name: "logo", url: LOGO },
        { name: "notes.md", url: NOTES },
      ],
      failed: [],
    });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  test("downloads only the files asked for, and refuses one the issue does not have", async () => {
    await call({ urls: [`${LOGO}?signature=x`] });
    expect(fetched).toEqual([LOGO]);
    fetched = [];
    const refused = await call({ urls: ["https://uploads.linear.app/ws/other/secret"] });
    expect(refused.isError).toBe(true);
    expect(fetched).toEqual([]);
  });

  test("reads another issue only when it is on the project's board", async () => {
    issue.id = "issue-2";
    issue.identifier = "DND-108";
    expect((await call({ issueId: "DND-108" })).isError).toBe(true);
    board = { teamId: "another-team" };
    expect((await call({ issueId: "DND-108" })).isError).toBe(true);
    expect(fetched).toEqual([]);
    board = { teamId: "team-1" };
    expect((await call({ issueId: "DND-108" })).isError).toBe(false);
  });

  test("includes an attachment Linear hosts, and no other attachment", async () => {
    issue.description = "";
    issue.comments = { nodes: [] };
    issue.attachments = {
      nodes: [
        { title: "Spec.pdf", url: NOTES },
        { title: "PR", url: "https://github.com/acme/web/pull/1" },
      ],
    };
    expect((await call()).structuredContent).toMatchObject({ files: [{ name: "Spec.pdf" }] });
  });

  test("says how to connect Linear", async () => {
    apiKey = null;
    const result = await call();
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("Linear is not connected on this machine");
  });
});
