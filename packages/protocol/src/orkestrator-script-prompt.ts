import { MAX_APT_PACKAGES } from "./apt-packages";

/**
 * Prompt for creating/updating the orkestrator-ai.json configuration file,
 * shared by every client that launches the Run Script agent.
 */

export function createOrkestratorScriptPrompt(isLocalEnvironment: boolean): string {
  const environmentGuidance = isLocalEnvironment
    ? "- This is a local environment, so include useful setup commands in `setupLocal`."
    : "- This is a containerized environment, so include useful setup commands in `setupContainer`.";

  return `Create or update a project root file named \`orkestrator-ai.json\` for Orkestrator AI.

Primary objectives for this script:
1. Install relevant package managers and runtimes in the container (for example, Bun).
2. Declare any Debian system packages the project needs in \`aptPackages\` (for example a native library such as \`libvips-dev\`), rather than installing them with a \`root\` command.
3. Install local packages needed to make the project work.
4. Define how to run a dev instance.

Example (adapt commands to this repo if needed):
{
  "setupContainer": ["curl -fsSL https://bun.sh/install | bash", "bun install"],
  "setupLocal": ["bun install"],
  "run": ["bun run dev"]
}

Compatibility requirements (strict):
1. The file must be valid JSON only (double quotes, no comments, no trailing commas).
2. Use only these top-level keys:
   - \`aptPackages\`: array of Debian package names (optional).
     - Container environments install these from Debian's signed archive before \`root\` and \`setupContainer\`, in restricted and full-network containers alike. Local environments ignore it.
     - Use it for system libraries and tools (anything you would otherwise \`apt-get install\`), and put the package name only: lowercase letters, digits, \`+\`, \`-\` and \`.\`, no versions (\`name=1.2\`), architectures (\`name:amd64\`), releases or wildcards, at most ${MAX_APT_PACKAGES} names.
     - Each must be a real Debian 13 (trixie) package, not a virtual one. Packages that could change the container's protections are refused (sudo and similar, firewalls such as iptables or nftables, SSH and telnet servers), as is any package that would pull one in, and setup then stops.
     - The image already has git, curl, wget, jq, ripgrep, unzip, gnupg, the GitHub CLI, tmux, vim, nano, mise, Bun and Node, so do not list those.
   - \`root\`: string OR array of strings (optional).
     - Runs as root inside container environments before container setup.
     - Only honored when the container has full network access. Default restricted containers fail setup if this field is present, so omit it unless the environment is created with full networking. Never use it to install Debian packages; use \`aptPackages\` instead.
   - \`setupContainer\`: string OR array of strings (optional).
     - Runs for containerized environments during workspace startup.
   - \`setupLocal\`: string OR array of strings (optional).
     - Used for local environments.
   - \`run\`: array of strings (optional, but MUST be an array when present).
     - Used by the Orkestrator Play/Run button.
3. Every command must be a non-empty shell command string.
4. Prefer arrays for \`root\`, \`setupContainer\`, and \`setupLocal\` for consistency. \`aptPackages\` must always be an array of names, never commands.
5. Keep commands idempotent and safe to run multiple times.
6. Prefer Bun over npm/yarn for package management (for example \`bun install\`).
7. Take the setup and run commands from whatever the repository actually uses to expose them. If it defines tasks in \`mise.toml\`, use \`mise run <task>\`; if its commands live in \`package.json\` scripts, use \`bun run <script>\`. Do not copy the example above when the repository disagrees with it — a command that does not resolve leaves the Play/Run button broken.
8. If \`orkestrator-ai.json\` already exists, preserve useful existing commands and update safely.

Environment-specific guidance:
${environmentGuidance}
- If both local and container workflows are relevant, it is valid to include both \`setupLocal\` and \`setupContainer\`.
- Only add \`aptPackages\` when the repository needs a system package the image lacks (for example a native build dependency named in its README, Dockerfile, CI workflow or an existing \`root\` step). Move an existing \`root\` step that only runs \`apt-get install\` into \`aptPackages\` and drop the step.

Workflow:
1. Inspect the repository (package manager, task runner, scripts, framework, README, and existing tooling).
2. Build a practical \`orkestrator-ai.json\` that fits this project.
3. Write/update the file at repository root.
4. Validate JSON syntax (for example \`jq . orkestrator-ai.json\`).

Output requirements:
- Confirm the file path you created/updated.
- Show the final JSON content.
- Briefly explain why each command was chosen.`;
}
