import { toast } from "sonner";

const TAB_LIMIT_TOAST_ID = "tab-limit-reached";

export function showTabLimitReachedToast(maxTabs: number): void {
  toast.error("Tab limit reached", {
    description: `You can have up to ${maxTabs} tabs open. Close a tab and try again.`,
    id: TAB_LIMIT_TOAST_ID,
  });
}
