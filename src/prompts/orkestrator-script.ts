/**
 * Prompt for creating/updating the orkestrator-ai.json configuration file.
 */

export function createOrkestratorScriptPrompt(isLocalEnvironment: boolean): string {
  const environmentGuidance = isLocalEnvironment
    ? "- This is a local environment, so include useful setup commands in `setupLocal`."
    : "- This is a containerized environment, so include useful setup commands in `setupContainer`.";

  return `Create or update a project root file named \`orkestrator-ai.json\` for Orkestrator AI.

Primary objectives for this script:
1. Install relevant package managers and runtimes in the container (for example, Bun).
2. Install local packages needed to make the project work.
3. Define how to run a dev instance.

Example (adapt commands to this repo if needed):
{
  "setupContainer": ["curl -fsSL https://bun.sh/install | bash", "bun install"],
  "setupLocal": ["bun install"],
  "run": ["bun run dev"]
}

Compatibility requirements (strict):
1. The file must be valid JSON only (double quotes, no comments, no trailing commas).
2. Use only these top-level keys:
   - \`root\`: string OR array of strings (optional).
     - Runs as root inside container environments before container setup.
   - \`setupContainer\`: string OR array of strings (optional).
     - Runs for containerized environments during workspace startup.
   - \`setupLocal\`: string OR array of strings (optional).
     - Used for local environments.
   - \`run\`: array of strings (optional, but MUST be an array when present).
     - Used by the Orkestrator Play/Run button.
3. Every command must be a non-empty shell command string.
4. Prefer arrays for \`root\`, \`setupContainer\`, and \`setupLocal\` for consistency.
5. Keep commands idempotent and safe to run multiple times.
6. For this repo, prefer Bun commands (for example \`bun install\`, \`bun run dev\`) instead of npm/yarn.
7. If \`orkestrator-ai.json\` already exists, preserve useful existing commands and update safely.

Environment-specific guidance:
${environmentGuidance}
- If both local and container workflows are relevant, it is valid to include both \`setupLocal\` and \`setupContainer\`.

Workflow:
1. Inspect the repository (package manager, scripts, framework, README, and existing tooling).
2. Build a practical \`orkestrator-ai.json\` that fits this project.
3. Write/update the file at repository root.
4. Validate JSON syntax (for example \`jq . orkestrator-ai.json\`).

Output requirements:
- Confirm the file path you created/updated.
- Show the final JSON content.
- Briefly explain why each command was chosen.`;
}
