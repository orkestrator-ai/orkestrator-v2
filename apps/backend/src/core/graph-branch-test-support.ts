/**
 * Fake Git worktrees on top of {@link FakeGraphRepo} (item 403): the
 * branch worktrees an isolated run creates, their commits, branches and
 * reflogs, `select-workspace`'s fast-forward of the run's branch, and a
 * shell and command runner over the same state. Test-only.
 */
import type { Environment } from "./models.js";
import type { EnvironmentCommandRunner } from "./commands-review.js";
import { FakeGraphRepo } from "./graph-agent-test-support.js";
import { GraphBranchWorktrees } from "./graph-branch-worktrees.js";
import type { GraphEnvironmentShell } from "./graph-system-environment.js";

export interface FakeWorktree {
  branch: string;
  head: string;
  dirty: string[];
  reflog: Array<{ sha: string; at: number }>;
}

/** Worktrees and branches of the environment's repository, over the fake main checkout. */
export class FakeBranchRepo {
  readonly worktrees = new Map<string, FakeWorktree>();
  readonly branches = new Map<string, string>();
  /** Every git command, as `args.join(" ")`. */
  readonly calls: string[] = [];
  /** Paths removed by the confined remover (unregistered leftovers). */
  readonly removedDirectories: string[] = [];
  private counter = 0;

  /** Commits the repository had before the test (the run's inputs). */
  readonly initial = new Set<string>();

  constructor(
    readonly main: FakeGraphRepo,
    /** Where `worktree list` says the environment root is. */
    readonly root = "/root",
  ) {
    this.initial.add(main.head);
  }

  private known(sha: string): boolean {
    return sha === this.main.head || this.main.commits.has(sha) || this.initial.has(sha);
  }

  /** Whether `ancestor` is reachable from `sha` over parents. */
  isAncestor(ancestor: string, sha: string): boolean {
    for (let current: string | undefined = sha, steps = 0; current && steps < 10_000; steps++) {
      if (current === ancestor) return true;
      current = this.main.commits.get(current)?.parent;
    }
    return false;
  }

  /** A commit in a worktree (the agent's work), now. */
  commitIn(path: string): string {
    const worktree = this.worktrees.get(path);
    if (!worktree) throw new Error(`no worktree ${path}`);
    const sha = (++this.counter).toString(16).padStart(40, "d");
    const now = Math.floor(Date.now() / 1000);
    this.main.commits.set(sha, { parent: worktree.head, time: now });
    worktree.head = sha;
    worktree.reflog.unshift({ sha, at: now });
    this.branches.set(worktree.branch, sha);
    return sha;
  }

  /** The worktree path inside an absolute directory a prompt named. */
  static relative(directory: string): string {
    const at = directory.indexOf(".orkestrator/graph-branches/");
    if (at < 0) throw new Error(`not a branch worktree: ${directory}`);
    return directory.slice(at);
  }

  readonly git = async (environmentId: string, args: string[]): Promise<string> => {
    this.calls.push(args.join(" "));
    if (args[0] === "-C") {
      const worktree = this.worktrees.get(args[1]!);
      if (!worktree) throw new Error(`fatal: cannot change to '${args[1]}': No such directory`);
      return this.inWorktree(worktree, args.slice(2));
    }
    const [command, ...rest] = args;
    switch (command) {
      case "worktree":
        return this.worktree(rest);
      case "branch": {
        const name = rest.at(-1)!;
        if (!this.branches.delete(name)) throw new Error(`error: branch '${name}' not found.`);
        return "";
      }
      case "for-each-ref": {
        const prefix = rest.at(-1)!.replace(/^refs\/heads\//, "");
        return [...this.branches.keys()].filter((name) => name.startsWith(prefix)).join("\n");
      }
      case "cat-file": {
        const sha = rest.at(-1)!.replace(/\^\{commit\}$/, "");
        if (!this.known(sha)) throw new Error("fatal: Not a valid object name");
        return "";
      }
      case "merge-base":
        if (!this.isAncestor(rest[1]!, rest[2]!)) throw new Error("exit 1");
        return "";
      case "merge": {
        const sha = rest.at(-1)!;
        if (!this.isAncestor(this.main.head, sha))
          throw new Error("fatal: Not possible to fast-forward");
        this.main.reset(sha);
        return "";
      }
      case "reset":
        this.main.reset(rest.at(-1)!);
        return "";
      case "update-ref":
        this.branches.set(rest[0]!, rest[1]!);
        return "";
      case "status":
        return this.main.dirty.map((path) => ` M ${path}`).join("\n");
      default:
        return this.main.git(environmentId, args);
    }
  };

  private worktree(args: string[]): string {
    const [command, ...rest] = args;
    switch (command) {
      case "add": {
        const [branch, path, base] = rest.filter((arg) => !arg.startsWith("-"));
        if (this.worktrees.has(path!)) throw new Error(`fatal: '${path}' already exists`);
        if (!this.known(base!)) throw new Error("fatal: invalid reference");
        for (const worktree of this.worktrees.values()) {
          if (worktree.branch === branch)
            throw new Error(`fatal: '${branch}' is already checked out`);
        }
        this.worktrees.set(path!, { branch: branch!, head: base!, dirty: [], reflog: [] });
        this.branches.set(branch!, base!);
        return "";
      }
      case "list":
        return [
          `worktree ${this.root}`,
          `HEAD ${this.main.head}`,
          `branch refs/heads/${this.main.branch}`,
          "",
          ...[...this.worktrees].flatMap(([path, worktree]) => [
            `worktree ${this.root}/${path}`,
            `HEAD ${worktree.head}`,
            `branch refs/heads/${worktree.branch}`,
            "",
          ]),
        ].join("\n");
      case "remove": {
        const path = rest.at(-1)!;
        if (!this.worktrees.delete(path)) throw new Error(`fatal: '${path}' is not a working tree`);
        return "";
      }
      case "prune":
        return "";
      default:
        throw new Error(`unexpected git worktree ${args.join(" ")}`);
    }
  }

  private inWorktree(worktree: FakeWorktree, args: string[]): string {
    const [command, ...rest] = args;
    switch (command) {
      case "rev-parse":
        return `${worktree.head}\n`;
      case "symbolic-ref":
        return `${worktree.branch}\n`;
      case "status":
        return worktree.dirty.map((path) => `?? ${path}`).join("\n");
      case "merge-base":
        if (!this.isAncestor(rest[1]!, rest[2]!)) throw new Error("exit 1");
        return "";
      case "log": {
        if (rest.includes("-g")) {
          return worktree.reflog
            .map(
              (entry) =>
                `${entry.sha} ${this.main.commits.get(entry.sha)?.time ?? 0} HEAD@{${entry.at}}`,
            )
            .join("\n");
        }
        const base = rest.find((arg) => arg.includes(".."))!.split("..")[0]!;
        const lines: string[] = [];
        for (let sha = worktree.head; sha !== base;) {
          const commit = this.main.commits.get(sha);
          if (!commit) break;
          lines.push(`${sha} ${commit.time}`);
          sha = commit.parent;
        }
        return lines.join("\n");
      }
      default:
        throw new Error(`unexpected git -C ${args.join(" ")}`);
    }
  }

  /** A command runner at the environment root, as `createEnvironmentCommandRunner` gives. */
  runner(environment: Environment): EnvironmentCommandRunner {
    return async (command, args) => {
      if (command !== "git") throw new Error(`unexpected command ${command}`);
      return this.git(environment.id, args);
    };
  }

  /** The worktree service over this repository. */
  service(): GraphBranchWorktrees {
    return new GraphBranchWorktrees({
      storage: { getEnvironment: async () => null },
      fence: { beginMutation: () => () => undefined },
      createRunner: (environment) => this.runner(environment),
      ensureExcluded: async () => undefined,
      removeDirectory: async (_environment, _runner, relative) => {
        this.removedDirectories.push(relative);
        for (const path of Array.from(this.worktrees.keys())) {
          if (path === relative || path.startsWith(`${relative}/`)) this.worktrees.delete(path);
        }
      },
    });
  }

  /** A system-node shell whose local Git is this repository. */
  shell(): GraphEnvironmentShell {
    return {
      git: (environment, args) => this.git(environment.id, args),
      remoteGit: async () => {
        throw new Error("no remote in tests");
      },
      gh: async () => {
        throw new Error("no gh in tests");
      },
      readFile: async () => {
        throw new Error("no files in tests");
      },
    };
  }
}
