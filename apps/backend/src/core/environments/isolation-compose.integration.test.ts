import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { runCommand } from "../shell.js";
import { StorageService, createEnvironment } from "../storage.js";
import { localEnvironmentIsolationEnv, withEnvironmentIsolation } from "./isolation.js";

// Opt in: two disposable Postgres stacks; never uses a registered project.
test.skipIf(process.env.ORKESTRATOR_ISOLATION_COMPOSE_SMOKE !== "1")(
  "two worktrees provision prerequisites and use independent Compose databases and host ports",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ork-isolation-compose-"));
    const repo = path.join(root, "repo");
    const storage = new StorageService(path.join(root, "data"));
    const stacks: { cwd: string; env: NodeJS.ProcessEnv }[] = [];
    try {
      await storage.init();
      await mkdir(repo);
      const git = (args: string[]) => runCommand("git", args, { cwd: repo });
      await git(["init", "-q", "-b", "main"]);
      await writeFile(path.join(repo, ".env.example"), "DB_USER=fixture\n");
      await writeFile(
        path.join(repo, "compose.yaml"),
        `name: shared-default\nservices:\n  db:\n    image: postgres:17-alpine\n    environment:\n      POSTGRES_USER: fixture\n      POSTGRES_DB: fixture\n      POSTGRES_HOST_AUTH_METHOD: trust\n    ports:\n      - "127.0.0.1:\${ORKESTRATOR_PORT_BASE:?}:5432"\n    healthcheck:\n      test: ["CMD-SHELL", "pg_isready -U fixture -d fixture"]\n      interval: 1s\n      timeout: 3s\n      retries: 40\n`,
      );
      await git(["add", "."]);
      await git([
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-qm",
        "fixture",
      ]);
      const results: { port: string; project: string; marker: string }[] = [];
      for (const name of ["first", "second"]) {
        const cwd = path.join(root, name);
        await git(["worktree", "add", "--detach", cwd]);
        const environment = await storage.addEnvironment({
          ...createEnvironment("fixture", { environmentType: "local" }),
          id: randomUUID(),
          worktreePath: cwd,
        });
        const isolation = await localEnvironmentIsolationEnv(environment, storage);
        const env = withEnvironmentIsolation(
          Object.fromEntries(
            Object.entries(process.env).filter(
              ([key]) => !key.startsWith("PG") && !key.startsWith("COMPOSE_"),
            ),
          ),
          isolation,
        );
        const stack = { cwd, env };
        stacks.push(stack); // Clean up even if startup only partly succeeds.
        // Repository-owned provisioning: derive a local env file and build artifact.
        await writeFile(
          path.join(cwd, ".env"),
          `${await readFile(path.join(cwd, ".env.example"), "utf8")}DATABASE_URL=postgresql://fixture@127.0.0.1:${isolation.ORKESTRATOR_PORT_BASE}/fixture\n`,
        );
        await mkdir(path.join(cwd, "web", "dist"), { recursive: true });
        await writeFile(path.join(cwd, "web", "dist", "index.html"), "fixture build");
        await runCommand(
          "docker",
          ["compose", "up", "-d", "--pull", "never", "--wait", "--wait-timeout", "60"],
          { ...stack, timeoutMs: 90_000 },
        );
        const marker = name;
        const port = isolation.ORKESTRATOR_PORT_BASE!;
        const sql = (query: string) =>
          runCommand(
            "psql",
            [
              "-h",
              "127.0.0.1",
              "-p",
              port,
              "-U",
              "fixture",
              "-d",
              "fixture",
              "-v",
              "ON_ERROR_STOP=1",
              "-Atc",
              query,
            ],
            { env: { ...env, PGCONNECT_TIMEOUT: "3" }, timeoutMs: 10_000 },
          );
        await sql(`create table identity(marker text); insert into identity values ('${marker}')`);
        expect((await sql("select marker from identity")).stdout.trim()).toBe(marker);
        results.push({ port, project: isolation.COMPOSE_PROJECT_NAME!, marker });
      }
      expect(results[0]!.port).not.toBe(results[1]!.port);
      expect(results[0]!.project).not.toBe(results[1]!.project);
      // Re-read the first over its published host port after provisioning the second.
      const first = results[0]!;
      const reread = await runCommand(
        "psql",
        [
          "-h",
          "127.0.0.1",
          "-p",
          first.port,
          "-U",
          "fixture",
          "-d",
          "fixture",
          "-Atc",
          "select marker from identity",
        ],
        { env: { ...stacks[0]!.env, PGCONNECT_TIMEOUT: "3" }, timeoutMs: 10_000 },
      );
      expect(reread.stdout.trim()).toBe("first");
      await runCommand("docker", ["compose", "down", "--volumes"], {
        ...stacks[0]!,
        timeoutMs: 30_000,
      });
      const surviving = await runCommand(
        "docker",
        [
          "compose",
          "exec",
          "-T",
          "db",
          "psql",
          "-U",
          "fixture",
          "-d",
          "fixture",
          "-Atc",
          "select marker from identity",
        ],
        { ...stacks[1]!, timeoutMs: 10_000 },
      );
      expect(surviving.stdout.trim()).toBe("second");
    } finally {
      // Exact Compose projects created above; never prune other resources.
      for (const stack of stacks.reverse())
        await runCommand("docker", ["compose", "down", "--volumes", "--remove-orphans"], {
          ...stack,
          timeoutMs: 30_000,
        });
      storage.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  180_000,
);
