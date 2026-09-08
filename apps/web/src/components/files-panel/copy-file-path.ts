import { writeText } from "@/lib/native/clipboard";
import { toast } from "sonner";

export async function copyFilePath(filePath: string): Promise<void> {
  try {
    await writeText(filePath);
    toast.success("Path copied to clipboard", { description: filePath });
  } catch (error) {
    console.error("[files-panel] Failed to copy file path:", error);
    toast.error("Failed to copy path");
  }
}
