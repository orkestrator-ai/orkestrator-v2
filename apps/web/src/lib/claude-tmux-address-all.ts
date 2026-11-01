import { ADDRESS_ALL_REVIEW_PROMPT } from "@orkestrator/protocol/git-workflow-prompts";

export async function submitClaudeTmuxAddressAll(input: {
  planMode: boolean;
  switchToBuild: () => Promise<string>;
  submit: (prompt: string) => Promise<boolean>;
}): Promise<"submitted" | "mode-switch-failed"> {
  if (input.planMode && (await input.switchToBuild()) === "plan") {
    return "mode-switch-failed";
  }
  await input.submit(ADDRESS_ALL_REVIEW_PROMPT);
  return "submitted";
}
