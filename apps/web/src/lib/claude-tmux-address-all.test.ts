import { describe, expect, mock, test } from "bun:test";
import { ADDRESS_ALL_REVIEW_PROMPT } from "./review-actions";
import { submitClaudeTmuxAddressAll } from "./claude-tmux-address-all";

describe("submitClaudeTmuxAddressAll", () => {
  test("leaves plan mode before submitting the implementation prompt", async () => {
    const order: string[] = [];
    const switchToBuild = mock(async () => {
      order.push("switch");
      return "bypassPermissions";
    });
    const submit = mock(async (prompt: string) => {
      order.push("submit");
      expect(prompt).toBe(ADDRESS_ALL_REVIEW_PROMPT);
      return true;
    });

    await expect(
      submitClaudeTmuxAddressAll({ planMode: true, switchToBuild, submit }),
    ).resolves.toBe("submitted");
    expect(order).toEqual(["switch", "submit"]);
  });

  test("does not submit while Claude still reports plan mode", async () => {
    const submit = mock(async () => true);
    await expect(
      submitClaudeTmuxAddressAll({
        planMode: true,
        switchToBuild: async () => "plan",
        submit,
      }),
    ).resolves.toBe("mode-switch-failed");
    expect(submit).not.toHaveBeenCalled();
  });
});
