import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

function run(args) {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error("The disposable PostgreSQL fixture could not be managed");
  return result.stdout.trim();
}
const name = "hanko-session-test-" + randomBytes(8).toString("hex");
let started = false;
try {
  let url = process.env.HANKO_TEST_DATABASE_URL;
  if (!url) {
    const password = randomBytes(32).toString("hex");
    run(["run", "-d", "--rm", "--name", name, "-p", "127.0.0.1::5432", "-e", "POSTGRES_DB=hanko_sessions", "-e", "POSTGRES_PASSWORD=" + password, "postgres:17-alpine"]);
    started = true;
    const ports = JSON.parse(run(["inspect", name, "--format", "{{json .NetworkSettings.Ports}}"]));
    url = `postgres://postgres:${password}@127.0.0.1:${ports["5432/tcp"][0].HostPort}/hanko_sessions`;
    const deadline = Date.now() + 30_000;
    while (spawnSync("docker", ["exec", name, "pg_isready", "-U", "postgres"], { stdio: "ignore" }).status !== 0) {
      if (Date.now() >= deadline) throw new Error("Disposable PostgreSQL fixture did not become ready");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  const result = spawnSync(process.execPath, ["scripts/check-session-flow.mjs"], { env: { ...process.env, HANKO_TEST_DATABASE_URL: url }, stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} finally {
  if (started) run(["rm", "-f", name]);
}
