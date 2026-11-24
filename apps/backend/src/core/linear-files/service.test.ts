import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import sharp from "sharp";
import { McpServer } from "@modelcontextprotocol/server";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BUILD_PIPELINE_VERSION, type BuildPipeline } from "@orkestrator/protocol/build-pipeline";
import { CONTAINER_PINNED_ATTACHMENT_WRITE } from "../commands-files.js";
import { runCommand } from "../command-capture.js";
import { callToolInProcess, listToolsInProcess } from "../mcp-in-process.js";
import { linearFileName, safeFileName } from "./issue-files.js";
import { LinearFileService, type LinearFileServiceDependencies } from "./service.js";
import { WorkflowResultService } from "../workflows/index.js";
import { registerLinearFileTool } from "./tool.js";

const KEY = "lin_api_secret";
const ZIP = "https://uploads.linear.app/ws/aaaa/bbbb";
const LOGO = "https://uploads.linear.app/ws/cccc/dddd";
const NOTES = "https://uploads.linear.app/ws/eeee/ffff";
const SCOPE = { environmentId: "env-1", projectId: "project-1" };
const STAGING_DIRECTORY = ".orkestrator/linear-files/DND-107";
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
const listForEnvironment = mock(async (_projectId: string, _environmentId: string) =>
  pipelines.map((snapshot) => ({ snapshot })),
);

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

function pendingAttempt(requestId: string): NonNullable<BuildPipeline["pendingPromptAttempt"]> {
  return {
    dispatchVersion: 1,
    id: requestId,
    requestId,
    sessionId: "session",
    phase: "building",
    prompt: "Build the ticket",
    useTaskImages: false,
    structuredReview: false,
    startedAt: "2026-11-24T10:00:00.000Z",
  };
}

function service(
  overrides: Partial<LinearFileServiceDependencies> = {},
  containerId?: string,
): LinearFileService {
  return new LinearFileService({
    storage: {
      getEnvironment: async (id: string) =>
        id === SCOPE.environmentId
          ? {
              id,
              projectId: SCOPE.projectId,
              ...(containerId
                ? { environmentType: "container", containerId }
                : { environmentType: "local", worktreePath: worktree }),
            }
          : null,
      getProject: async (id: string) => ({ id, name: "Web", gitUrl: null }),
      kanban: { getLinearAuth: async () => (apiKey ? { apiKey } : null) },
      linear: { getLinearBoardLink: async () => board },
      listBuildPipelinesForEnvironment: listForEnvironment,
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
  listForEnvironment.mockClear();
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
    const cjk = `${"文".repeat(100)}.pdf`;
    const filename = linearFileName(`${ZIP}/${encodeURIComponent(cjk)}`);
    expect(Buffer.byteLength(filename)).toBeLessThan(200);
    expect(filename.endsWith(".pdf")).toBe(true);
    expect(linearFileName(ZIP)).not.toBe(linearFileName(LOGO));
  });
});

describe("the build's files", () => {
  test("are written Git-excluded and named in the prompt, with images for the ticket", async () => {
    const prepared = (await service().prepareBuild(linearPipeline()))!;

    const directory = path.join(worktree, ".orkestrator/linear-files/DND-107");
    const names = (await readdir(directory)).sort();
    expect(names).toHaveLength(2);
    const zip = `${linearFileName(ZIP)}.zip`;
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
    expect(prepared.images).toHaveLength(1);
    expect(prepared.images[0]?.filename).toBe(`${linearFileName(LOGO)}.webp`);
    expect((await sharp(Buffer.from(prepared.images[0]!.data, "base64")).metadata()).format).toBe(
      "webp",
    );
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
    expect(prepared.section).toContain(linearFileName(LOGO));
    expect(prepared.section).toContain(`package.zip (${ZIP}): Linear refused the download (403)`);
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
    expect(prepared.section).toContain(linearFileName(ZIP));
    expect(prepared.section).toContain("files together are too large");
  });

  test("includes acceptance-criteria links from the snapshot", async () => {
    const snapshot = { ...taskSnapshot(""), acceptanceCriteria: `Extract [package.zip](${ZIP})` };
    const prepared = await service().prepareBuild({ ...linearPipeline(), taskSnapshot: snapshot });
    expect(prepared?.section).toContain(`${STAGING_DIRECTORY}/${linearFileName(ZIP)}.zip`);
    expect(fetched).toEqual([ZIP]);
  });

  test("refuses a destination exposed by an ignore exception or already tracked", async () => {
    const target = `${STAGING_DIRECTORY}/${linearFileName(ZIP)}.zip`;
    await writeFile(
      path.join(worktree, ".gitignore"),
      `!/.orkestrator/\n/${STAGING_DIRECTORY}/*\n!/${target}\n`,
    );
    const host = service();
    const exposed = await host.download(SCOPE, { urls: [ZIP] });
    expect(exposed.failed[0]?.reason).toContain("not Git-excluded");
    await expect(stat(path.join(worktree, target))).rejects.toThrow();

    await mkdir(path.dirname(path.join(worktree, target)), { recursive: true });
    await writeFile(path.join(worktree, target), "tracked contents");
    await runCommand("git", ["add", "--force", "--", target], { cwd: worktree });
    await writeFile(path.join(worktree, ".gitignore"), "");
    const tracked = await host.download(SCOPE, { urls: [ZIP] });
    expect(tracked.failed[0]?.reason).toContain("tracked by Git");
    expect(await readFile(path.join(worktree, target), "utf8")).toBe("tracked contents");
  });

  test("counts partial chunked responses against the issue budget", async () => {
    for (const url of [ZIP, LOGO]) {
      fileAnswers.set(
        url,
        () =>
          new Response(
            new ReadableStream({
              pull: (controller) => controller.enqueue(new Uint8Array(4)),
            }),
          ),
      );
    }
    const result = await service({ maxFileBytes: 6, maxIssueBytes: 12 }).download(SCOPE);
    expect(fetched).toEqual([ZIP, LOGO]);
    expect(result.files).toEqual([]);
    expect(result.failed.map(({ reason }) => reason)).toEqual([
      expect.stringContaining("larger than"),
      expect.stringContaining("issue limit"),
      expect.stringContaining("issue limit"),
    ]);
  });

  test("cancels a stalled container writer before releasing the workspace fence", async () => {
    const order: string[] = [];
    const run = mock<typeof runCommand>(async () => ({ stdout: "", stderr: "" }));
    const writeContainer = mock<NonNullable<LinearFileServiceDependencies["writeContainer"]>>(
      async (_container, _directory, _filename, _contents, signal, deadline) => {
        order.push("started");
        expect(deadline - Date.now()).toBeLessThanOrEqual(500);
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
        order.push("stopped");
        throw new Error("The writer stopped.");
      },
    );
    const storage = {
      getEnvironment: async () => ({ id: SCOPE.environmentId, containerId: "c1" }),
      kanban: { getLinearAuth: async () => ({ apiKey: KEY }) },
    } as unknown as LinearFileServiceDependencies["storage"];
    const controller = new AbortController();
    const host = service({
      storage,
      run,
      writeContainer,
      fence: {
        beginMutation: () => () => {
          if (order.includes("started")) order.push("released");
        },
      },
    });
    const prepared = await host.prepareBuild(linearPipeline(), 500, controller.signal);
    expect(order).toEqual(["started", "stopped", "released"]);
    expect(prepared?.section.match(/timed out/g)).toHaveLength(2);
    expect(fetched).toEqual([ZIP]);
    expect(writeContainer).toHaveBeenCalledTimes(1);
  });

  test("bounds the input size and number of ticket images", async () => {
    const urls = Array.from({ length: 13 }, (_, index) => `${LOGO}/${index}.png`);
    const snapshot = taskSnapshot(urls.join(" "));
    issue.description = snapshot.description;
    for (const [index, url] of urls.entries()) {
      const image = index === 0 ? Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]) : PNG;
      fileAnswers.set(url, () => new Response(image));
    }
    const prepared = await service().prepareBuild({ ...linearPipeline(), taskSnapshot: snapshot });
    expect(prepared?.images.map(({ filename }) => filename)).toEqual(
      urls.slice(1, 11).map((url) => linearFileName(url).replace(/\.png$/, ".webp")),
    );
  });

  test("keeps original files and uses only decodable, bounded images in the ticket", async () => {
    const corrupt = PNG.subarray(0, 18);
    const tall = await sharp({
      create: { width: 100, height: 9000, channels: 3, background: "green" },
    })
      .png()
      .toBuffer();
    fileAnswers.set(ZIP, () => new Response(corrupt));
    fileAnswers.set(LOGO, () => new Response(tall));
    const prepared = await service().prepareBuild(linearPipeline());
    expect(prepared?.images).toHaveLength(1);
    const normalized = await sharp(Buffer.from(prepared!.images[0]!.data, "base64")).metadata();
    expect(normalized).toMatchObject({ height: 2000, format: "webp" });
    expect(
      await readFile(path.join(worktree, STAGING_DIRECTORY, `${linearFileName(ZIP)}.png`)),
    ).toEqual(corrupt);
    expect(
      await readFile(path.join(worktree, STAGING_DIRECTORY, `${linearFileName(LOGO)}.png`)),
    ).toEqual(tall);
  });

  test("recovers file extensions and reuses the first path when response metadata changes", async () => {
    fileAnswers.set(
      ZIP,
      () =>
        new Response("zip", {
          headers: { "content-disposition": 'attachment; filename="archive.zip"' },
        }),
    );
    const host = service();
    const first = await host.download(SCOPE, { urls: [ZIP, LOGO] });
    expect(first.files.map(({ path }) => path)).toEqual([
      `${STAGING_DIRECTORY}/${linearFileName(ZIP)}.zip`,
      `${STAGING_DIRECTORY}/${linearFileName(LOGO)}.png`,
    ]);
    fileAnswers.set(
      ZIP,
      () =>
        new Response("new", {
          headers: { "content-disposition": 'attachment; filename="archive.gz"' },
        }),
    );
    const second = await host.download(SCOPE, { urls: [ZIP] });
    expect(second.files[0]?.path).toBe(first.files[0]?.path);
    expect(await readFile(path.join(worktree, second.files[0]!.path), "utf8")).toBe("new");
  });

  test("names the issue budget when the next file cannot fit", async () => {
    const result = await service({ maxIssueBytes: 10 }).download(SCOPE, { urls: [ZIP, LOGO] });
    expect(result.files).toHaveLength(1);
    expect(result.failed[0]?.reason).toContain("10 B issue limit. Request this file by URL.");
  });

  test("reuses a path after a link label changes and writes long Unicode names", async () => {
    const url = `${ZIP}/${encodeURIComponent(`${"文".repeat(100)}.pdf`)}`;
    const host = service();
    issue.description = `[Original.pdf](${url})`;
    fileAnswers.set(url, () => new Response("old"));
    const first = await host.download(SCOPE, { urls: [url] });
    issue.description = `[Updated label](${url})`;
    fileAnswers.set(url, () => new Response("new"));
    const second = await host.download(SCOPE, { urls: [url] });
    expect(second.files).toMatchObject([{ name: "Updated label", path: first.files[0]?.path }]);
    expect(await readdir(path.join(worktree, STAGING_DIRECTORY))).toEqual([linearFileName(url)]);
    expect(await readFile(path.join(worktree, second.files[0]!.path), "utf8")).toBe("new");
  });

  test("the container helper waits for authorization before publishing a long Unicode name", async () => {
    const file = linearFileName(`${ZIP}/${encodeURIComponent(`${"文".repeat(100)}.pdf`)}`);
    const target = path.join(worktree, STAGING_DIRECTORY, file);
    for (const publish of [false, true]) {
      const helper = Bun.spawn(
        [
          process.execPath,
          "-e",
          CONTAINER_PINNED_ATTACHMENT_WRITE,
          worktree,
          STAGING_DIRECTORY,
          file,
          "3",
          "",
          "overwrite",
          String(0o644),
          "",
          String(Date.now() + 3_000),
        ],
        { stdin: "pipe", stdout: "pipe", stderr: "ignore" },
      );
      try {
        helper.stdin.write("emlw\n");
        helper.stdin.flush();
        const reader = helper.stdout.getReader();
        const staged = await reader.read();
        expect(Buffer.from(staged.value!).toString()).toBe("LINEAR_FILE_STAGED\n");
        await expect(stat(target)).rejects.toThrow();
        if (publish) helper.stdin.write("publish\n");
        helper.stdin.end();
        expect(await helper.exited).toBe(publish ? 0 : 78);
        expect(await readdir(path.dirname(target))).toEqual(publish ? [file] : []);
      } finally {
        helper.kill();
        await helper.exited;
      }
    }
    expect(await readFile(target, "utf8")).toBe("zip");
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
    expect(listForEnvironment).toHaveBeenCalledWith(SCOPE.projectId, SCOPE.environmentId);
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

  test("scopes off-board access to the own attempt or the latest general build", async () => {
    const first = {
      ...linearPipeline(),
      pendingPromptAttempt: pendingAttempt("first-attempt"),
    };
    pipelines = [
      first,
      {
        ...first,
        id: "pipeline-2",
        createdAt: "2026-11-24T11:00:00Z",
        source: { type: "kanban", taskId: "task-2" },
        pendingPromptAttempt: pendingAttempt("second-attempt"),
      },
    ];
    const host = service();
    await expect(host.offered(SCOPE)).resolves.toBe(false);
    await expect(
      host.download({ ...SCOPE, workflowResultKey: "second-attempt" }, { issueId: "issue-1" }),
    ).rejects.toThrow("not on");
    await expect(
      host.download({ ...SCOPE, workflowResultKey: "first-attempt" }, { urls: [ZIP] }),
    ).resolves.toMatchObject({ issue: "DND-107" });
    pipelines[1]!.source = { type: "linear", issueId: "issue-2", issueIdentifier: "DND-108" };
    const fetchFile = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, options?: RequestInit) => {
      if (String(input) !== "https://api.linear.app/graphql") return fetchFile(input, options);
      const { variables } = JSON.parse(String(options?.body));
      return Response.json({
        data: {
          issue: {
            ...issue,
            id: variables.id,
            identifier: variables.id === "issue-1" ? "DND-107" : "DND-108",
          },
        },
      });
    }) as typeof fetch;
    for (const [workflowResultKey, expected] of [
      ["first-attempt", "DND-107"],
      ["second-attempt", "DND-108"],
    ]) {
      await expect(
        host.download({ ...SCOPE, workflowResultKey }, { urls: [ZIP] }),
      ).resolves.toMatchObject({ issue: expected });
    }
  });

  test("resolves the worktree after the fetch under a workspace mutation hold", async () => {
    const retired = worktree;
    const next = await mkdtemp(path.join(os.tmpdir(), "linear-moved-"));
    try {
      await runCommand("git", ["init", "--quiet", next], { timeoutMs: 10_000 });
      fileAnswers.set(ZIP, () => {
        worktree = next;
        return new Response("contents");
      });
      const host = service();
      const result = await host.download(SCOPE, { urls: [ZIP] });
      const target = result.files[0]!.path;
      expect(await readFile(path.join(next, target), "utf8")).toBe("contents");
      await expect(stat(path.join(retired, target))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      worktree = retired;
      await rm(next, { recursive: true, force: true });
    }
  });

  test.each(["local", "container"] as const)(
    "revocation during network I/O fences %s publication",
    async (target) => {
      const resultKey = crypto.randomUUID();
      const results = new WorkflowResultService(worktree);
      await results.prepare({ ...SCOPE, resultKey, kind: "review-preparation", provider: "codex" });
      pipelines[0]!.pendingPromptAttempt = pendingAttempt(resultKey);
      const started = Promise.withResolvers<void>();
      const fetched = Promise.withResolvers<Response>();
      const fetchFile = globalThis.fetch;
      globalThis.fetch = (async (input: string | URL | Request, options?: RequestInit) => {
        if (String(input) !== ZIP) return fetchFile(input, options);
        started.resolve();
        return fetched.promise;
      }) as typeof fetch;
      const writeContainer = mock(async () => {});
      const beginMutation = mock(() => () => undefined);
      const host = service(
        { writeContainer, fence: { beginMutation } },
        target === "container" ? "test-container" : undefined,
      );
      try {
        const srv = new McpServer({ name: "test", version: "1" }, { capabilities: { tools: {} } });
        expect(
          await registerLinearFileTool(srv, host, { ...SCOPE, workflowResultKey: resultKey }, () =>
            results.holdOpenResult(SCOPE, resultKey),
          ),
        ).toBe(true);
        const call = callToolInProcess(async () => srv, "download_linear_files", { urls: [ZIP] });
        await started.promise;
        await results.close(resultKey, "cancelled");
        fetched.resolve(new Response("arrived after close"));
        expect((await call).isError).toBe(true);
        expect(beginMutation).not.toHaveBeenCalled();
        expect(writeContainer).not.toHaveBeenCalled();
        await expect(stat(path.join(worktree, STAGING_DIRECTORY))).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        fetched.resolve(new Response());
        results.closeStorage();
      }
    },
  );

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

  test("checks files beyond the download cap and follows the comment cursor", async () => {
    const urls = Array.from({ length: 51 }, (_, index) => `${ZIP}/${index}`);
    issue.description = urls.slice(0, 50).join(" ");
    issue.comments = { nodes: [], pageInfo: { hasNextPage: true, endCursor: "next" } };
    const fetchFirstPage = globalThis.fetch;
    const cursors: (string | null)[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === "https://api.linear.app/graphql") {
        const { variables } = JSON.parse(String(init?.body));
        cursors.push(variables.after);
        if (variables.after === "next")
          return Response.json({
            data: {
              issue: {
                id: "issue-1",
                comments: { nodes: [{ body: urls[50] }], pageInfo: { hasNextPage: false } },
              },
            },
          });
      }
      return fetchFirstPage(input, init);
    }) as typeof fetch;
    for (const url of urls) fileAnswers.set(url, () => new Response("file"));
    const host = service();
    const selected = await host.download(SCOPE, { urls: [urls[50]!] });
    expect(selected.files).toMatchObject([{ url: urls[50] }]);
    expect(cursors).toEqual([null, "next"]);
    const all = await host.download(SCOPE);
    expect(all.files).toHaveLength(50);
    expect(all.failed).toEqual([
      { url: urls[50]!, reason: expect.stringContaining("Only 50 files") },
    ]);
  });

  test("says how to connect Linear", async () => {
    apiKey = null;
    const result = await call();
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("Linear is not connected on this machine");
  });
});
