import { expect, test } from "bun:test";
import { createCodexHostFixture } from "../../e2e/fixtures/codex-host-rules";

test("real host-only descriptor maps to a host offer, auto-answers, and asks after removal", async () => {
  const fixture = await createCodexHostFixture();
  try {
    fixture.raise();
    const card = (await fixture.snapshot()).requests[0]!;
    expect(card.presentation.title).toBe("Approve network access");
    expect(fixture.detail(card.id)?.subject).toEqual({
      kind: "network-host",
      host: "registry.npmjs.org",
    });
    expect(card.presentation.ruleOffer).toMatchObject({
      kind: "network-host",
      patterns: ["registry.npmjs.org"],
    });
    expect(
      await fixture.remember(card.id, {
        pattern: "registry.npmjs.org",
        scope: "project",
        anyProvider: false,
      }),
    ).toMatchObject({ result: "applied" });
    fixture.raise();
    expect((await fixture.snapshot()).requests).toEqual([]);
    expect(fixture.rules()[0]?.useCount).toBe(1);
    expect(fixture.wireResponses).toEqual([
      { result: { decision: "accept" } },
      { result: { decision: "accept" } },
    ]);
    fixture.remove();
    fixture.raise();
    expect((await fixture.snapshot()).requests).toHaveLength(1);
    expect(fixture.wireResponses).toHaveLength(2);
  } finally {
    fixture.close();
  }
});
