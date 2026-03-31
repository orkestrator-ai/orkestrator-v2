import type { ClaudeMessage } from "@/lib/claude-client";

export function parseVerificationResult(messages: ClaudeMessage[]): { verdict: "pass" | "fail"; feedback: string } {
  const lastAssistant = messages.filter((m) => m.role === "assistant").pop();
  if (!lastAssistant) return { verdict: "fail", feedback: "No verification response received" };

  const text = lastAssistant.parts
    .filter((p) => p.type === "text")
    .map((p) => p.content)
    .join("\n")
    .trim();

  // Try JSON format first: { "complete": true/false, "rationale": "..." }
  try {
    // Prefer ```json block, then bare ``` block, then raw JSON object
    const jsonMatch =
      text.match(/```json\s*\n([\s\S]*?)\n\s*```/) ??
      text.match(/```\s*\n([\s\S]*?)\n\s*```/) ??
      text.match(/(\{"complete"\s*:\s*(?:true|false)\s*,\s*"rationale"\s*:\s*"[\s\S]*?"\s*\})/);
    if (jsonMatch?.[1]) {
      const parsed = JSON.parse(jsonMatch[1]);
      if (typeof parsed.complete === "boolean") {
        return {
          verdict: parsed.complete ? "pass" : "fail",
          feedback: typeof parsed.rationale === "string" ? parsed.rationale : text,
        };
      }
    }
  } catch {
    // Fall through to legacy parsing
  }

  // Legacy fallback: check for YES/NO on first line
  const firstLine = text.split("\n")[0]?.trim().toUpperCase() ?? "";
  const verdict = firstLine.startsWith("YES") ? "pass" : "fail";

  return { verdict, feedback: text };
}
