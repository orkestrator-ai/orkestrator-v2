/** A Linear-sourced build's ticket files in its prompts (`linear-files/service.ts`). */
import { describe, expect, test } from "bun:test";
import type { BuildPipeline, TaskSnapshot } from "@orkestrator/protocol/build-pipeline";
import { addTaskSnapshotImages, buildPrompt } from "./prompts.js";
import { startBuilding, pipeline, startInput, withService } from "./service-test-support.js";

const FILE = "https://uploads.linear.app/ws/aaaa/bbbb";
const SOURCE = { type: "linear", issueId: "issue-1", issueIdentifier: "DND-107" } as const;

function snapshot(description: string): TaskSnapshot {
  return { title: "DND-107", description, acceptanceCriteria: "", comments: [], images: [] };
}

function promptFor(description: string): string {
  return buildPrompt({ taskSnapshot: snapshot(description) } as BuildPipeline, "");
}

describe("the Linear files note", () => {
  test("tells an agent how to get the files instead of asking for a key", () => {
    const prompt = promptFor(`Use [package.zip](${FILE}).`);
    expect(prompt).toContain("**Linear files**");
    expect(prompt).toContain("download_linear_files");
    expect(prompt).toContain(".orkestrator/linear-files/");
  });

  test("is left out of a ticket without Linear-hosted files", () => {
    expect(promptFor("See https://linear.app/team/issue/DND-107")).not.toContain("Linear files");
  });
});

test("images are added once and stay within what a prompt carries", () => {
  const task = snapshot("");
  task.images = Array.from({ length: 19 }, (_, i) => ({ filename: `${i}.png`, data: "eA==" }));
  addTaskSnapshotImages(task, [
    { filename: "0.png", data: "eQ==" },
    { filename: "logo.png", data: "eQ==" },
    { filename: "over.png", data: "eQ==" },
  ]);
  expect(task.images.map((image) => image.filename).slice(18)).toEqual(["18.png", "logo.png"]);
  expect(task.images[0]!.data).toBe("eA==");
});

describe("a build started from a Linear issue", () => {
  test("has its files before its session, and says where they are", async () => {
    const order: string[] = [];
    await withService(
      async (service, storage, provider) => {
        const createSession = provider.createSession.bind(provider);
        provider.createSession = async (...args) => {
          order.push("session");
          return createSession(...args);
        };
        const { started } = await startBuilding(service, storage, {
          source: SOURCE,
          taskSnapshot: snapshot(`Use [package.zip](${FILE}).`),
        });

        expect(order).toEqual(["files", "session"]);
        expect(provider.sent[0]!.prompt).toContain("**Ticket files**\n- `package.zip`");
        // The image is on the ticket, so the prompt carries it and names it.
        expect(provider.sent[0]!.prompt).toContain("**Attached Images**: logo.png");
        const stored = await pipeline(storage, started.id);
        expect(stored.taskSnapshot.images).toEqual([{ filename: "logo.png", data: "eA==" }]);
      },
      {
        prepareLinearFiles: async () => {
          order.push("files");
          return {
            section: "**Ticket files**\n- `package.zip`",
            images: [{ filename: "logo.png", data: "eA==" }],
          };
        },
      },
    );
  });

  test("starts as before when there is nothing to prepare", async () => {
    await withService(
      async (service, storage, provider) => {
        await startBuilding(service, storage, startInput({ source: SOURCE }));
        expect(provider.sent[0]!.prompt).not.toContain("**Ticket files**");
      },
      { prepareLinearFiles: async () => null },
    );
  });

  test("prepares files for the Build only, not for later stages", async () => {
    let prepared = 0;
    await withService(
      async (service, storage) => {
        const started = await service.start(startInput({ source: SOURCE }));
        for (let pass = 0; pass < 4; pass += 1) await service.advanceNow(started.id);
        expect((await pipeline(storage, started.id)).phase).toBe("verifying");
        expect(prepared).toBe(1);
      },
      {
        prepareLinearFiles: async () => {
          prepared += 1;
          return null;
        },
      },
    );
  });
});

test.each(["pause", "cancel"] as const)(
  "%s interrupts file preparation before a session opens",
  async (stop) => {
    const preparing = Promise.withResolvers<string>();
    await withService(
      async (service, storage, provider) => {
        const started = await service.start(startInput({ source: SOURCE }));
        const advancing = (async () => {
          await service.advanceNow(started.id);
          await service.advanceNow(started.id);
        })();
        expect(await preparing.promise).toBe(started.id);
        const stopped = await service[stop](started.id);
        await advancing;
        expect(stopped.phase).toBe(stop === "pause" ? "paused" : "failed");
        expect(provider.sent).toEqual([]);
        expect((await pipeline(storage, started.id)).sessions).toEqual([]);
      },
      {
        prepareLinearFiles: (pipeline, signal) => {
          preparing.resolve(pipeline.id);
          return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        },
      },
    );
  },
);

test("strips signed links from a supplied snapshot and from the first Build prompt", async () => {
  const signed = `${FILE}?signature=synthetic_secret`;
  const taskSnapshot = {
    ...snapshot(`Use [package.zip](${signed})`),
    acceptanceCriteria: `Inspect ${signed}.`,
    comments: [{ text: `See **${signed}**.` }],
  };
  await withService(async (service, storage, provider) => {
    const { started } = await startBuilding(service, storage, { source: SOURCE, taskSnapshot });
    const stored = await pipeline(storage, started.id);
    expect(JSON.stringify(stored.taskSnapshot)).not.toContain("synthetic_secret");
    expect(stored.taskSnapshot.description).toBe(`Use [package.zip](${FILE})`);
    expect(stored.taskSnapshot.comments).toEqual([{ text: `See **${FILE}**.` }]);
    expect(provider.sent[0]?.prompt).not.toContain("synthetic_secret");
    expect(provider.sent[0]?.prompt).toContain(FILE);
  });
});
