import { useCallback, useEffect, useState } from "react";
import { writeText } from "@/lib/native/clipboard";

export function useTimedCopyFeedback(
  durationMs = 1200,
  copyText: (value: string) => Promise<void> = writeText,
) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timeoutId = window.setTimeout(() => setCopied(false), durationMs);
    return () => window.clearTimeout(timeoutId);
  }, [copied, durationMs]);

  const copy = useCallback(async (value: string) => {
    await copyText(value);
    setCopied(true);
  }, [copyText]);

  return { copied, copy };
}
