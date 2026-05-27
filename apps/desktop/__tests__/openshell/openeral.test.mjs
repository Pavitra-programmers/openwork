// Unit tests for apps/desktop/electron/openshell/openeral.mjs.
//
// Uses the same mock-wsl.sh as wsl.test.mjs / doctor.test.mjs to record
// argv and emit canned stdout. Credentials are stubbed via the
// OPENWORK_TEST_CREDENTIALS_DIR env seam baked into
// openeral-credentials.mjs (plain-file storage; no Electron required).
//
// The actual docker pull + openshell sandbox create round-trip lives in
// the Phase 10 E2E spec — these unit tests verify only the argv shape,
// the validation logic, and the orchestration between sub-steps.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_WSL = join(__dirname, "mock-wsl.sh");

let workDir;
let logPath;
let credsDir;

test.beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "openeral-test-"));
  logPath = join(workDir, "wsl-args.log");
  credsDir = join(workDir, "creds");
  process.env.OPENWORK_WSL_EXE = MOCK_WSL;
  process.env.MOCK_WSL_LOG = logPath;
  process.env.OPENWORK_TEST_CREDENTIALS_DIR = credsDir;
  process.env.OPENWORK_CREDENTIALS_FILE = join(workDir, "creds-prod-fallback.json");
  for (const key of [
    "MOCK_WSL_STDOUT",
    "MOCK_WSL_STDOUT_FILE",
    "MOCK_WSL_STDERR",
    "MOCK_WSL_EXIT",
    "MOCK_WSL_DELAY_MS",
    "MOCK_WSL_DELAY_BEFORE_MS",
  ]) {
    delete process.env[key];
  }
});

test.afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  delete process.env.OPENWORK_WSL_EXE;
  delete process.env.MOCK_WSL_LOG;
  delete process.env.OPENWORK_TEST_CREDENTIALS_DIR;
  delete process.env.OPENWORK_CREDENTIALS_FILE;
});

function readArgsLog() {
  try {
    return readFileSync(logPath, "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

const openeral = await import("../../electron/openshell/openeral.mjs");
const credentials = await import("../../electron/openshell/openeral-credentials.mjs");

// ── Pure helpers ───────────────────────────────────────────────────────

test("imageForProfile: maps claude profile to sandys image", () => {
  assert.equal(
    openeral.imageForProfile("openeral-claude"),
    "ghcr.io/sandys/openeral/sandbox:just-bash",
  );
});

test("imageForProfile: maps openclaw profile to sandys image (same as claude)", () => {
  // openeral README: same image, only --provider differs.
  assert.equal(
    openeral.imageForProfile("openeral-openclaw"),
    "ghcr.io/sandys/openeral/sandbox:just-bash",
  );
});

test("imageForProfile: throws on unknown profile", () => {
  assert.throws(() => openeral.imageForProfile("openeral-unknown"), /Unknown OpenEral profile/);
});

// ── buildWslEnvForwarding ──────────────────────────────────────────────

test("buildWslEnvForwarding: extends WSLENV with forwarded names", () => {
  const env = openeral.__testing.buildWslEnvForwarding({
    ANTHROPIC_API_KEY: "sk-ant-test",
    OPENERAL_AGENT: "openclaw",
  });
  assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-test");
  assert.equal(env.OPENERAL_AGENT, "openclaw");
  const names = env.WSLENV.split(":").filter(Boolean);
  assert.ok(names.includes("ANTHROPIC_API_KEY"));
  assert.ok(names.includes("OPENERAL_AGENT"));
});

test("buildWslEnvForwarding: preserves existing WSLENV entries", () => {
  const prev = process.env.WSLENV;
  process.env.WSLENV = "EXISTING_VAR";
  try {
    const env = openeral.__testing.buildWslEnvForwarding({ FOO: "bar" });
    const names = env.WSLENV.split(":").filter(Boolean);
    assert.ok(names.includes("EXISTING_VAR"), `expected EXISTING_VAR in ${env.WSLENV}`);
    assert.ok(names.includes("FOO"), `expected FOO in ${env.WSLENV}`);
  } finally {
    if (prev === undefined) delete process.env.WSLENV;
    else process.env.WSLENV = prev;
  }
});

// ── sandboxExists ──────────────────────────────────────────────────────

test("sandboxExists: returns true when the sandbox is in the list", async () => {
  process.env.MOCK_WSL_STDOUT = JSON.stringify([
    { name: "openeral-foo" },
    { name: "openeral-bar" },
  ]);
  assert.equal(await openeral.sandboxExists("openeral-foo"), true);
});

test("sandboxExists: returns false when not present", async () => {
  process.env.MOCK_WSL_STDOUT = JSON.stringify([{ name: "something-else" }]);
  assert.equal(await openeral.sandboxExists("openeral-foo"), false);
});

test("sandboxExists: accepts plain-string list entries", async () => {
  process.env.MOCK_WSL_STDOUT = JSON.stringify(["openeral-foo"]);
  assert.equal(await openeral.sandboxExists("openeral-foo"), true);
});

test("sandboxExists: returns false when list command fails", async () => {
  process.env.MOCK_WSL_EXIT = "1";
  assert.equal(await openeral.sandboxExists("openeral-foo"), false);
});

test("sandboxExists: returns false on empty input", async () => {
  assert.equal(await openeral.sandboxExists(""), false);
});

// ── createOpenEralSandbox ──────────────────────────────────────────────

test("createOpenEralSandbox: throws when DATABASE_URL is unconfigured", async () => {
  await assert.rejects(
    () =>
      openeral.createOpenEralSandbox({
        name: "openeral-test",
        profile: "openeral-claude",
        skipImagePull: true,
      }),
    /DATABASE_URL is not configured/,
  );
});

test("createOpenEralSandbox: throws when ANTHROPIC_API_KEY missing (any profile)", async () => {
  await credentials.setCredential("databaseUrl", "postgresql://test/db");
  await assert.rejects(
    () =>
      openeral.createOpenEralSandbox({
        name: "openeral-test",
        profile: "openeral-claude",
        skipImagePull: true,
      }),
    /ANTHROPIC_API_KEY is not configured/,
  );
});

test("createOpenEralSandbox: short-circuits when sandbox already exists, returns sparse context", async () => {
  // listSandboxes returns our target name → existed=true. Then
  // waitForSandboxReady probes the list once more; with a flat-string
  // entry it treats the sandbox as ready and returns. No DB staging,
  // no image pull, no `sandbox create`.
  await credentials.setCredential("databaseUrl", "postgresql://test/db");
  process.env.MOCK_WSL_STDOUT = JSON.stringify(["openeral-resume"]);
  const result = await openeral.createOpenEralSandbox({
    name: "openeral-resume",
    profile: "openeral-claude",
    skipImagePull: true,
  });
  assert.equal(result.existed, true);
  assert.equal(result.dbStagingPath, null);
  assert.equal(result.anthropicApiKey, null);
  const lines = readArgsLog();
  // Two list calls: existence probe + waitForSandboxReady's ready check.
  assert.ok(
    lines.every((l) => /openshell sandbox list --json/.test(l)),
    `expected only list calls; got: ${JSON.stringify(lines)}`,
  );
  // Critically: no `sandbox create` (PTY layer's responsibility) and no
  // DB URL staging (the existing sandbox already has it).
  assert.equal(
    lines.filter((l) => /openshell sandbox create/.test(l)).length,
    0,
  );
  assert.equal(
    lines.filter((l) => /openwork-staging\/db-url-/.test(l)).length,
    0,
  );
});

test("createOpenEralSandbox: pre-flights credentials + stages DB URL, returns launch context", async () => {
  await credentials.setCredential("databaseUrl", "postgresql://test/db");
  await credentials.setCredential("anthropicApiKey", "sk-ant-test");
  // Mock always emits "[]" so sandbox list parses to empty (sandbox absent).
  process.env.MOCK_WSL_STDOUT = "[]";
  const result = await openeral.createOpenEralSandbox({
    name: "openeral-new",
    profile: "openeral-claude",
    skipImagePull: true,
  });
  assert.equal(result.existed, false);
  assert.equal(result.name, "openeral-new");
  assert.equal(result.profile, "openeral-claude");
  assert.equal(result.imageRef, "ghcr.io/sandys/openeral/sandbox:just-bash");
  assert.match(
    result.dbStagingPath ?? "",
    /^\/home\/banker\/\.openwork-staging\/db-url-[\w-]+$/,
    "staging path lives under the banker user's home, not /tmp",
  );
  assert.equal(result.anthropicApiKey, "sk-ant-test");

  const lines = readArgsLog();

  // No `provider create` calls — the canonical flow uses --auto-providers
  // to pick up ANTHROPIC_API_KEY from the env at sandbox-create time.
  assert.equal(
    lines.filter((l) => /openshell provider create/.test(l)).length,
    0,
    "canonical openeral flow does not call `provider create` ahead of time",
  );

  // Pre-flight stages DATABASE_URL via one bash call against the distro:
  // mkdir + cat + chmod. The staging path mirrors result.dbStagingPath.
  assert.ok(
    lines.some((l) => /mkdir -p \/home\/banker\/\.openwork-staging/.test(l)),
    "expected staging directory to be created under banker's home",
  );
  assert.ok(
    lines.some((l) => /cat > \/home\/banker\/\.openwork-staging\/db-url-[\w-]+/.test(l)),
    "expected DATABASE_URL staging via `cat > /home/banker/.openwork-staging/db-url-<uuid>`",
  );
  assert.ok(
    lines.some((l) => /chmod 600 \/home\/banker\/\.openwork-staging\/db-url-[\w-]+/.test(l)),
    "expected chmod 600 on the staging file",
  );

  // Pre-flight must NOT actually run `openshell sandbox create` — that's
  // the PTY layer's job, since sandbox create with `-- openeral` blocks
  // until Claude Code exits and needs a real TTY.
  assert.equal(
    lines.filter((l) => /openshell sandbox create/.test(l)).length,
    0,
    "createOpenEralSandbox is pre-flight only; sandbox create runs inside the PTY",
  );

  // The dropped `openshell sandbox exec` path must not return either.
  assert.equal(
    lines.filter((l) => /openshell sandbox exec/.test(l)).length,
    0,
    "openshell sandbox exec is NOT a real subcommand (openeral-js asserts the same)",
  );
});

test("createOpenEralSandbox: openclaw profile returns anthropicApiKey and image ref", async () => {
  await credentials.setCredential("databaseUrl", "postgresql://test/db");
  await credentials.setCredential("anthropicApiKey", "sk-ant-xxx");
  process.env.MOCK_WSL_STDOUT = "[]";
  const result = await openeral.createOpenEralSandbox({
    name: "openeral-claws",
    profile: "openeral-openclaw",
    skipImagePull: true,
  });
  assert.equal(result.existed, false);
  assert.equal(result.profile, "openeral-openclaw");
  assert.equal(result.imageRef, "ghcr.io/sandys/openeral/sandbox:just-bash");
  assert.equal(result.anthropicApiKey, "sk-ant-xxx");
  assert.ok(result.dbStagingPath);
});

// ── buildSandboxLaunchSpec ─────────────────────────────────────────────

test("buildSandboxLaunchSpec: fresh launch builds canonical openshell sandbox create argv", () => {
  const spec = openeral.buildSandboxLaunchSpec({
    name: "openeral-new",
    profile: "openeral-claude",
    imageRef: "ghcr.io/sandys/openeral/sandbox:just-bash",
    existed: false,
    dbStagingPath: "/home/banker/.openwork-staging/db-url-abc",
    anthropicApiKey: "sk-ant-test",
  });
  // wsl.exe argv shape: -d <distro> -- bash -c <script>
  assert.equal(spec.args[0], "-d");
  assert.equal(spec.args[1], "openwork-openshell");
  assert.equal(spec.args[2], "--");
  assert.equal(spec.args[3], "bash");
  assert.equal(spec.args[4], "-c");
  const script = spec.args[5];
  assert.match(script, /sandbox create --tty/);
  assert.match(script, /--name 'openeral-new'/);
  assert.match(script, /--from 'ghcr\.io\/sandys\/openeral\/sandbox:just-bash'/);
  assert.match(
    script,
    /--upload \/home\/banker\/\.openwork-staging\/db-url-abc:\/sandbox\/db-url/,
  );
  assert.match(script, /--provider claude --auto-providers/);
  assert.match(script, /-- openeral$/m);
  assert.match(
    script,
    /trap 'rm -f \/home\/banker\/\.openwork-staging\/db-url-abc' EXIT/,
    "expected EXIT trap to clean up staging file",
  );
  // Things that should NOT be there.
  assert.doesNotMatch(script, /--gateway/, "no --gateway flag in canonical flow");
  assert.doesNotMatch(script, /--no-tty/, "canonical flow uses --tty, not --no-tty");
  assert.doesNotMatch(
    script,
    /sandbox exec/,
    "`sandbox exec` is not a real openshell subcommand (per openeral-js tests)",
  );
  assert.doesNotMatch(script, /-- \/bin\/true/, "trailing command is openeral, not /bin/true");
  // Env carries the API key + WSLENV forwarding.
  assert.equal(spec.env.ANTHROPIC_API_KEY, "sk-ant-test");
  assert.ok(spec.env.WSLENV.split(":").includes("ANTHROPIC_API_KEY"));
  assert.equal(spec.reconnectStdinInjection, null);
});

test("buildSandboxLaunchSpec: openclaw fresh launch adds OPENERAL_AGENT to env", () => {
  const spec = openeral.buildSandboxLaunchSpec({
    name: "openeral-claws",
    profile: "openeral-openclaw",
    imageRef: "ghcr.io/sandys/openeral/sandbox:just-bash",
    existed: false,
    dbStagingPath: "/home/banker/.openwork-staging/db-url-xyz",
    anthropicApiKey: "sk-ant-test",
  });
  assert.equal(spec.env.OPENERAL_AGENT, "openclaw");
  assert.ok(spec.env.WSLENV.split(":").includes("OPENERAL_AGENT"));
  assert.ok(spec.env.WSLENV.split(":").includes("ANTHROPIC_API_KEY"));
});

test("buildSandboxLaunchSpec: reconnect path uses `openshell sandbox connect` and queues an `exec openeral` injection", () => {
  const spec = openeral.buildSandboxLaunchSpec({
    name: "openeral-existing",
    profile: "openeral-claude",
    imageRef: "ghcr.io/sandys/openeral/sandbox:just-bash",
    existed: true,
    dbStagingPath: null,
    anthropicApiKey: null,
  });
  assert.deepEqual(spec.args, [
    "-d",
    "openwork-openshell",
    "--",
    "openshell",
    "sandbox",
    "connect",
    "openeral-existing",
  ]);
  assert.equal(spec.dbStagingPath, null);
  // The PTY layer writes this string to stdin once the connect-shell
  // prompt renders — relaunches the agent against /home/agent state.
  assert.equal(spec.reconnectStdinInjection, "exec openeral\r");
});

test("buildSandboxLaunchSpec: fresh launch rejects missing dbStagingPath / anthropicApiKey", () => {
  assert.throws(
    () =>
      openeral.buildSandboxLaunchSpec({
        name: "x",
        profile: "openeral-claude",
        imageRef: "img",
        existed: false,
        dbStagingPath: null,
        anthropicApiKey: "sk-ant",
      }),
    /dbStagingPath is required/,
  );
  assert.throws(
    () =>
      openeral.buildSandboxLaunchSpec({
        name: "x",
        profile: "openeral-claude",
        imageRef: "img",
        existed: false,
        dbStagingPath: "/p",
        anthropicApiKey: null,
      }),
    /anthropicApiKey is required/,
  );
});

test("createOpenEralSandbox: requires name and profile", async () => {
  await assert.rejects(
    () => openeral.createOpenEralSandbox({ profile: "openeral-claude" }),
    /name is required/,
  );
  await assert.rejects(
    () => openeral.createOpenEralSandbox({ name: "x" }),
    /profile is required/,
  );
});

// ── deleteOpenEralSandbox ──────────────────────────────────────────────

test("deleteOpenEralSandbox: invokes the bash-wrapped openshell sandbox delete <name>", async () => {
  process.env.MOCK_WSL_STDOUT = "";
  await openeral.deleteOpenEralSandbox("openeral-foo");
  const lines = readArgsLog();
  assert.equal(lines.length, 1);
  // Wrapped in `bash -c "timeout 20 openshell sandbox delete '<name>'"`
  // so a hung gateway is force-killed at the inner timer rather than
  // tripping wslRun's outer one. --force is intentionally NOT passed —
  // openshell 0.0.45 errors on the unknown flag.
  assert.match(lines[0], /timeout \d+ openshell sandbox delete 'openeral-foo'/);
  assert.doesNotMatch(lines[0], /--force/, "openshell sandbox delete does not accept --force");
});

test("deleteOpenEralSandbox: rejects empty name", async () => {
  await assert.rejects(() => openeral.deleteOpenEralSandbox(""), /name is required/);
});

// ── probeDatabaseUrl ───────────────────────────────────────────────────

test("probeDatabaseUrl: throws when DATABASE_URL unset", async () => {
  await assert.rejects(() => openeral.probeDatabaseUrl(), /not configured/);
});

test("probeDatabaseUrl: runs psql in postgres:16-alpine and returns reachable", async () => {
  await credentials.setCredential("databaseUrl", "postgresql://test/db");
  process.env.MOCK_WSL_STDOUT = "1";
  const r = await openeral.probeDatabaseUrl();
  assert.equal(r.ok, true);
  assert.equal(r.reachable, true);
  const lines = readArgsLog();
  assert.equal(lines.length, 1);
  // docker is wrapped with `docker --config <dir>` to dodge Docker
  // Desktop's credential helper (see pullImage comment).
  assert.match(
    lines[0],
    /docker --config \S+ run --rm -i -e PGCONNECT_TIMEOUT=10 postgres:16-alpine psql/,
  );
  assert.match(lines[0], /postgresql:\/\/test\/db/);
  assert.match(lines[0], /-tAc 'select 1'/);
});

test("probeDatabaseUrl: surfaces psql error stderr", async () => {
  await credentials.setCredential("databaseUrl", "postgresql://bad/host");
  process.env.MOCK_WSL_EXIT = "2";
  process.env.MOCK_WSL_STDERR = "psql: connection refused";
  await assert.rejects(
    () => openeral.probeDatabaseUrl(),
    /Could not reach PostgreSQL.*connection refused/s,
  );
});
