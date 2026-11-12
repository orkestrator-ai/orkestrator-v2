import { describe, expect, test } from "bun:test";
import { codexReadOnlyCommandVerdict } from "./codex-read-only-commands.js";

const allowed = (command: string | readonly string[]) =>
  codexReadOnlyCommandVerdict(command).allowed;

describe("codexReadOnlyCommandVerdict", () => {
  // What a reviewer needs to read its package and diff, in the shapes Codex
  // sends: wrapped in the user's login shell, quoted the way it joins argv.
  test.each([
    "/bin/bash -lc 'cat review-package.json'",
    "/bin/zsh -lc 'rg -n \"readOnly\" src'",
    "bash -lc 'git diff origin/main...HEAD -- src/app.ts'",
    "/bin/bash -lc 'git show --stat HEAD'",
    "/bin/bash -lc 'git log --oneline -20'",
    "/bin/bash -lc 'git --no-pager diff --name-only'",
    "/bin/bash -lc 'git status --short'",
    "/bin/bash -lc 'git branch --show-current'",
    "/bin/bash -lc \"sed -n '1,200p' src/app.ts\"",
    "/bin/bash -lc 'sed -n 1,80p src/app.ts'",
    "/bin/bash -lc 'nl -ba src/app.ts | sed -n '\"'\"'40,90p'\"'\"''",
    "/bin/bash -lc 'cd bridges/codex-bridge && rg --files src | head -50'",
    "/bin/bash -lc 'ls -la; wc -l src/a.ts src/b.ts'",
    "/bin/bash -lc 'find src -name \"*.test.ts\" -type f'",
    "/bin/bash -lc 'grep -rn TODO src || true'",
    "/bin/bash -lc 'jq .validation review.json'",
    "rg -n foo src",
    "cat a.txt\nhead -5 b.txt",
  ])("%s is allowed", (command) => {
    expect(codexReadOnlyCommandVerdict(command)).toEqual({ allowed: true });
  });

  test.each([
    // Writes, by program or by argument.
    "/bin/bash -lc 'touch sentinel'",
    "/bin/bash -lc 'rm -rf build'",
    "/bin/bash -lc 'git commit -am x'",
    "/bin/bash -lc 'git branch -D feature'",
    "/bin/bash -lc 'git branch new-branch'",
    "/bin/bash -lc 'git checkout -- src'",
    "/bin/bash -lc 'git diff --output=patch.txt'",
    "/bin/bash -lc 'git log --out=patch.txt'",
    "/bin/bash -lc 'git diff --ext-diff'",
    "/bin/bash -lc 'git -C /elsewhere status'",
    "/bin/bash -lc 'git -c core.pager=sh status'",
    "/bin/bash -lc 'git fetch origin'",
    "/bin/bash -lc 'find . -delete'",
    "/bin/bash -lc 'find . -name x -exec rm {} +'",
    "/bin/bash -lc 'sort -o out.txt in.txt'",
    "/bin/bash -lc 'sort -no out.txt in.txt'",
    "/bin/bash -lc 'uniq in.txt out.txt'",
    "/bin/bash -lc 'rg --pre ./run.sh foo'",
    "/bin/bash -lc 'yq -i .a=1 x.yaml'",
    "/bin/bash -lc \"sed -i 's/a/b/' x\"",
    "/bin/bash -lc \"sed -n 'w out' x\"",
    "/bin/bash -lc \"sed -n '1e touch x' x\"",
    '/bin/bash -lc "awk \'{system(\\"touch x\\")}\' x"',
    "/bin/bash -lc 'apply_patch'",
    "/bin/bash -lc 'python3 -c 1'",
    "/bin/bash -lc 'bun run build'",
    "/bin/bash -lc 'curl https://example.com'",
    "/bin/bash -lc 'env cat x'",
    "/bin/bash -lc 'xargs rm'",
    "/bin/bash -lc './bin/cat x'",
    // Composition the check cannot see through.
    "/bin/bash -lc 'cat a > b'",
    "/bin/bash -lc 'cat < a'",
    "/bin/bash -lc 'cat a >> b'",
    "/bin/bash -lc 'echo $(touch x)'",
    "/bin/bash -lc 'echo `touch x`'",
    "/bin/bash -lc 'echo $HOME'",
    "/bin/bash -lc 'cat \"$FILE\"'",
    "/bin/bash -lc 'cat a & touch b'",
    "/bin/bash -lc 'cat a |& tee b'",
    "/bin/bash -lc '(touch x)'",
    "/bin/bash -lc '{ touch x; }'",
    "/bin/bash -lc 'cat *.ts'",
    "/bin/bash -lc 'cat ~/.codex/auth.json'",
    "/bin/bash -lc 'cat a\\ b'",
    "/bin/bash -lc 'GIT_EXTERNAL_DIFF=./x git diff'",
    "/bin/bash -lc 'cat a | tee b'",
    "/bin/bash -lc 'ls && touch x'",
    "/bin/bash -lc 'ls\ntouch x'",
    "/bin/bash -lc '| cat'",
    "/bin/bash -lc 'cat a |'",
    "/bin/bash -lc 'cat \"unterminated'",
    "/bin/bash -lc 'cat a' extra",
    "/bin/bash -c 'ls' -c 'touch x'",
    "",
  ])("%s is refused", (command) => {
    const verdict = codexReadOnlyCommandVerdict(command);
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.reason).toContain("without Codex's command sandbox");
    }
  });

  test("a legacy argv is checked as written, and a wrapped one by its script", () => {
    expect(allowed(["cat", "a b.txt"])).toBe(true);
    // No shell sees an argv, so a metacharacter in it is only a filename.
    expect(allowed(["cat", "a;b"])).toBe(true);
    expect(allowed(["rm", "-rf", "build"])).toBe(false);
    expect(allowed(["/bin/bash", "-lc", "rg foo | head"])).toBe(true);
    expect(allowed(["/bin/bash", "-lc", "cat a > b"])).toBe(false);
    expect(allowed([])).toBe(false);
  });

  test("a refusal names the program and what is available", () => {
    const verdict = codexReadOnlyCommandVerdict("/bin/bash -lc 'touch x'");
    expect(verdict).toMatchObject({ allowed: false });
    if (!verdict.allowed) {
      expect(verdict.reason).toContain("`touch`");
      expect(verdict.reason).toContain("Only reading programs run here");
    }
  });

  // The key comes from the model: an inherited property must not admit it.
  test.each(["constructor", "toString", "__proto__"])("git %s is refused", (subcommand) => {
    expect(allowed(`git ${subcommand}`)).toBe(false);
  });
});
