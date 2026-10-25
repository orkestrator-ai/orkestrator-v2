/**
 * `transcript_media_pdf_preview` reads bytes only through the registered
 * authorized readers (with their own arguments and confinement), checks a
 * container id against the environment, and `transcript_artifact_prepare_worker`
 * reports honestly when no preparation is wired.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { TRANSCRIPT_ARTIFACT_COMMANDS } from "@orkestrator/protocol/transcript-artifact-commands";

import type { CommandContext, CommandHandler } from "../commands-context.js";
import { registerTranscriptArtifactCommands } from "./commands.js";
import { containerRelativePath, registerTranscriptArtifactPdfCommands } from "./commands-pdf.js";
import { ENV, createHarness, fakePdf, type Harness } from "./service-test-support.js";

let h: Harness;
const commands = new Map<string, CommandHandler>();
const readerCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
const PDF_BASE64 = Buffer.from(fakePdf("command")).toString("base64");

function reader(name: string, answer: (args: Record<string, unknown>) => unknown) {
  commands.set(name, async (args) => {
    readerCalls.push({ name, args: args as Record<string, unknown> });
    return answer(args as Record<string, unknown>);
  });
}

registerTranscriptArtifactCommands((name, handler) => commands.set(name, handler));
registerTranscriptArtifactPdfCommands(
  (name, handler) => commands.set(name, handler),
  (name) => commands.get(name),
);
reader("read_file_base64", () => PDF_BASE64);
reader("read_container_file_base64", () => `${PDF_BASE64}\n`);
reader("get_native_agent_tool_details", () => ({
  fileDataUrl: `data:application/pdf;base64,${PDF_BASE64}`,
}));

beforeEach(async () => {
  h = await createHarness();
  readerCalls.length = 0;
});
afterEach(async () => {
  await h.close();
});

function invoke(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const context = {
    transcriptArtifacts: h.service,
    storage: h.storage,
  } as unknown as CommandContext;
  return Promise.resolve(commands.get(name)!(args as never, context));
}

async function setContainer(containerId: string | null): Promise<void> {
  const environment = (await h.storage.getEnvironment(ENV))!;
  await h.storage.updateEnvironment(ENV, { ...environment, containerId });
}

describe("transcript_media_pdf_preview", () => {
  test("host paths go through read_file_base64 unchanged", async () => {
    const response = await invoke(TRANSCRIPT_ARTIFACT_COMMANDS.mediaPdfPreview, {
      environmentId: ENV,
      source: { path: "/Users/me/worktree/doc.pdf" },
    });
    expect(response).toMatchObject({ status: "ready", pageCount: 3 });
    expect(readerCalls).toEqual([
      { name: "read_file_base64", args: { filePath: "/Users/me/worktree/doc.pdf" } },
    ]);
  });

  test("container paths must name the environment's own container and stay in /workspace", async () => {
    await setContainer("container-own");
    const ok = await invoke(TRANSCRIPT_ARTIFACT_COMMANDS.mediaPdfPreview, {
      environmentId: ENV,
      source: { path: "/workspace/docs/a.pdf", containerId: "container-own" },
    });
    expect(ok.status).toBe("ready");
    expect(readerCalls.at(-1)).toEqual({
      name: "read_container_file_base64",
      args: { containerId: "container-own", filePath: "docs/a.pdf" },
    });
    await expect(
      invoke(TRANSCRIPT_ARTIFACT_COMMANDS.mediaPdfPreview, {
        environmentId: ENV,
        source: { path: "docs/a.pdf", containerId: "someone-else" },
      }),
    ).rejects.toMatchObject({ code: "policy_denied" });
    await expect(
      invoke(TRANSCRIPT_ARTIFACT_COMMANDS.mediaPdfPreview, {
        environmentId: ENV,
        source: { path: "../../etc/passwd", containerId: "container-own" },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(readerCalls).toHaveLength(1);
  });

  test("relative host paths, unknown environments and empty sources are refused", async () => {
    await expect(
      invoke(TRANSCRIPT_ARTIFACT_COMMANDS.mediaPdfPreview, {
        environmentId: ENV,
        source: { path: "relative/doc.pdf" },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      invoke(TRANSCRIPT_ARTIFACT_COMMANDS.mediaPdfPreview, {
        environmentId: "env-missing",
        source: { path: "/a.pdf" },
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      invoke(TRANSCRIPT_ARTIFACT_COMMANDS.mediaPdfPreview, { environmentId: ENV, source: {} }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(readerCalls).toHaveLength(0);
  });

  test("deferred tool details are read through the conversation's detail loader", async () => {
    const response = await invoke(TRANSCRIPT_ARTIFACT_COMMANDS.mediaPdfPreview, {
      environmentId: ENV,
      source: { detailRef: "detail-1", agent: "claude", logicalSessionKey: "env-env-1:tab-1" },
    });
    expect(response.status).toBe("ready");
    expect(readerCalls).toEqual([
      {
        name: "get_native_agent_tool_details",
        args: {
          environmentId: ENV,
          agent: "claude",
          logicalSessionKey: "env-env-1:tab-1",
          detailRef: "detail-1",
        },
      },
    ]);
  });

  test("a reader's size refusal becomes a byte-limit refusal, other failures read-failed", async () => {
    reader("read_file_base64", () => {
      throw new Error("File is too large to read");
    });
    expect(
      await invoke(TRANSCRIPT_ARTIFACT_COMMANDS.mediaPdfPreview, {
        environmentId: ENV,
        source: { path: "/Users/me/big.pdf" },
      }),
    ).toMatchObject({ status: "refused", reason: "byte-limit" });
    reader("read_file_base64", () => {
      throw new Error("Path is outside the allowed roots");
    });
    expect(
      await invoke(TRANSCRIPT_ARTIFACT_COMMANDS.mediaPdfPreview, {
        environmentId: ENV,
        source: { path: "/etc/secret.pdf" },
      }),
    ).toMatchObject({ status: "unavailable", reason: "read-failed" });
    reader("read_file_base64", () => PDF_BASE64);
  });
});

describe("pdf representation command", () => {
  test("paper is one of the two fixed sizes; anything else is refused before any work", async () => {
    await expect(
      invoke(TRANSCRIPT_ARTIFACT_COMMANDS.readRepresentation, {
        environmentId: ENV,
        logicalSessionKey: "env-env-1:tab-1",
        publicationId: "pub_missing0001",
        representation: "pdf",
        paper: "legal",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    // A valid request for an unknown publication is an ordinary not_found.
    await expect(
      invoke(TRANSCRIPT_ARTIFACT_COMMANDS.readRepresentation, {
        environmentId: ENV,
        logicalSessionKey: "env-env-1:tab-1",
        publicationId: "pub_missing0001",
        representation: "pdf",
        paper: "letter",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(h.runner.calls).toHaveLength(0);
  });
});

describe("transcript_artifact_prepare_worker", () => {
  test("without a wired preparation it reports why instead of running anything", async () => {
    expect(await invoke(TRANSCRIPT_ARTIFACT_COMMANDS.prepareWorker)).toMatchObject({
      available: false,
      state: "failed",
      method: null,
    });
  });
});

test("container path confinement", () => {
  expect(containerRelativePath("/workspace/a/b.pdf")).toBe("a/b.pdf");
  expect(containerRelativePath("a/b.pdf")).toBe("a/b.pdf");
  for (const bad of ["/etc/x.pdf", "~/x.pdf", "a/../../x.pdf", "/workspace/", "C:\\x.pdf", "a\0b"])
    expect(containerRelativePath(bad)).toBeNull();
});
