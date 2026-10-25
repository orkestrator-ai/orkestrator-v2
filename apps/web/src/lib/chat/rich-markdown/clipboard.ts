import { toast } from "sonner";
import { writeText } from "@/lib/native/clipboard";

/**
 * Copy exact text for a rich-block action. Failure is visible and names a
 * recovery path, because a silently failed "Copy code" reads as success.
 */
export async function copyRichText(text: string, what: string): Promise<boolean> {
  try {
    await writeText(text);
    toast.success(`Copied ${what}`);
    return true;
  } catch (error) {
    console.error(
      "[RichMarkdown] Clipboard write failed:",
      error instanceof Error ? error.name : "error",
    );
    toast.error(`Could not copy ${what}`, {
      description:
        "The clipboard is unavailable. Open the viewer and select the text to copy it manually.",
    });
    return false;
  }
}
