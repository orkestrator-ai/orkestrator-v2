// Minimal preload for backend, bridge, protocol, CLI, and desktop-script tests.
// Renderer tests use tests/setup.ts, which installs Happy DOM and native mocks.
import "./isolate-git-config";
import "./isolate-worktree-dir";
import { installBoundedConsoleDiagnostics } from "./bounded-console-diagnostics";
import { setClaudeLinuxSandboxStatusForTests } from "@orkestrator/protocol/node/claude-linux-sandbox";

process.env.CODEX_BRIDGE_NO_SERVER ??= "1";
installBoundedConsoleDiagnostics();
// Suites mock the Claude CLI, so whether this machine's bubblewrap can nest a
// user namespace must not decide whether their turns are refused. Tests of the
// probe and the refusal inject their own answer.
setClaudeLinuxSandboxStatusForTests({ available: true });
