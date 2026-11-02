import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { writeText } from "@/lib/native/clipboard";
import { toast } from "sonner";

const log = createLogger("web.files");

export async function copyFilePath(filePath: string): Promise<void> {
  try {
    await writeText(filePath);
    toast.success("Path copied to clipboard", { description: filePath });
  } catch (error) {
    log.error("path.copy-failed", { error: formatLogError(error) });
    toast.error("Failed to copy path");
  }
}
