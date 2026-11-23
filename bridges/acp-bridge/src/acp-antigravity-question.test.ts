import { describe, expect, test } from "bun:test";
import { nativeFetch, sharedBridge, waitFor } from "./acp-test-harness.js";

// One Antigravity bridge (built-in launcher record, fake agent) for the file.
const shared = sharedBridge({ ACP_PROVIDER: "antigravity" });

const autoApprove = {
  id: "interactive-host",
  sandbox: "none",
  approvals: "auto-approve",
  projectResources: true,
  networkAccess: "full",
} as const;

type Interaction = {
  id: string;
  kind: string;
  questions?: Array<{ id: string; multiple: boolean; options: Array<{ id: string }> }>;
};

async function openSession(): Promise<string> {
  const { base, headers } = shared;
  const { id } = (await nativeFetch(`${base}/session/create`, {
    method: "POST",
    headers,
    body: JSON.stringify({ policy: autoApprove }),
  }).then((response) => response.json())) as { id: string };
  shared.track(id);
  return id;
}

async function ask(id: string, text = "ANTIGRAVITY_QUESTION"): Promise<Interaction> {
  const { base, headers } = shared;
  const prompt = await nativeFetch(`${base}/session/${id}/prompt`, {
    method: "POST",
    headers,
    body: JSON.stringify({ prompt: text, policy: autoApprove }),
  });
  expect(prompt.status).toBe(202);
  const parked = await waitFor(
    () =>
      nativeFetch(`${base}/session/${id}/interactions`, { headers }).then((response) =>
        response.json(),
      ) as Promise<{ interactions: Interaction[] }>,
    (value) => value.interactions.length > 0,
  );
  return parked.interactions[0]!;
}

async function transcriptText(id: string): Promise<string> {
  const { base, headers } = shared;
  const body = (await nativeFetch(`${base}/session/${id}/messages`, { headers }).then((response) =>
    response.json(),
  )) as Array<{ content?: string; parts?: Array<{ text?: string }> }>;
  return JSON.stringify(body);
}

describe("Antigravity questions over the ACP bridge", () => {
  test("an interaction_ request is a person's question even under auto-approval", async () => {
    const id = await openSession();
    const interaction = await ask(id);
    // Auto-approval would have chosen the allow option at once; instead the
    // request is parked as a single-choice question with the native options.
    expect(interaction).toMatchObject({ id: "interaction_db", kind: "question" });
    expect(interaction.questions).toHaveLength(1);
    expect(interaction.questions![0]!.multiple).toBe(false);
    expect(interaction.questions![0]!.options.map((option) => option.id)).toEqual([
      "opt-pg",
      "opt-sqlite",
    ]);
    const { base, headers } = shared;
    const answered = await nativeFetch(`${base}/session/${id}/interactions/interaction_db`, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "accept", answers: { answer: ["opt-sqlite"] } }),
    });
    expect(answered.status).toBe(200);
    await waitFor(
      () => transcriptText(id),
      (text) => text.includes("answered:opt-sqlite"),
    );
  });

  test("a cancelled question answers the agent with a cancel, not an approval", async () => {
    const id = await openSession();
    await ask(id);
    const { base, headers } = shared;
    await nativeFetch(`${base}/session/${id}/interactions/interaction_db`, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "cancel" }),
    });
    await waitFor(
      () => transcriptText(id),
      (text) => text.includes("answered:cancelled"),
    );
  });
  test.each(["answer", "stop"])(
    "preserves a live tool and late question after the prompt response, then %s",
    async (action) => {
      const id = await openSession();
      await ask(id, "ANTIGRAVITY_BACKGROUND_QUESTION");
      const { base, headers } = shared;
      const readActivity = () =>
        nativeFetch(`${base}/session/${id}/activity`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{ activity: string }>;
      expect(await readActivity()).toMatchObject({ activity: "waiting" });
      const next = await nativeFetch(`${base}/session/${id}/prompt`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: "second prompt" }),
      });
      expect(next.status).toBe(409);
      const response = await nativeFetch(
        `${base}/session/${id}/${action === "stop" ? "cancel" : "interactions/interaction_db"}`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ action: "accept", answers: { answer: ["opt-pg"] } }),
        },
      );
      expect(response.ok).toBe(true);
      await waitFor(readActivity, (value) => value.activity === "idle");
      expect(await transcriptText(id)).not.toContain("Tool call ended without a result");
    },
  );
});
