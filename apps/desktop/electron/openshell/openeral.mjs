// OpenEral sandbox lifecycle.
//
// Canonical openeral launch (per the maintainers' SKILL.md and
// openeral-js/src/cli.ts ≈ 1867) is a SINGLE interactive command:
//
//   openshell sandbox create --tty \
//     --name <name> \
//     --from ghcr.io/sandys/openeral/sandbox:just-bash \
//     --upload <db-url-file>:/sandbox/db-url \
//     --provider claude --auto-providers \
//     -- openeral
//
// That call BLOCKS until the user exits Claude Code. Provisioning,
// setup.sh, and the agent REPL all happen inside one TTY-attached
// process. The maintainers' own tests in openeral-js explicitly assert
// that `openshell sandbox exec` is NOT a real subcommand — we must not
// split provisioning and launch via that path.
//
// We can't drive the canonical recipe from `wslRun` (piped stdio):
// Claude Code's first-run prompts ("Use this API key?", theme, trust
// /sandbox, security ack) need a real TTY. So we structure things as:
//
//   1. `createOpenEralSandbox` does PRE-FLIGHT only — validates creds,
//      pulls the image, checks whether the sandbox already exists, and
//      stages DATABASE_URL into a persistent file inside the distro
//      (NOT /tmp — see STAGING_DIR comment). It does NOT call
//      `openshell sandbox create`.
//
//   2. `buildSandboxLaunchSpec` returns the wsl.exe argv + env that
//      the PTY layer (openeral-pty.mjs via node-pty, or openeral-
//      terminal.mjs via an OS terminal emulator) actually executes.
//      For a fresh sandbox the argv is the canonical
//      `openshell sandbox create --tty ... -- openeral`; for a reconnect
//      it's `openshell sandbox connect <name>` (the PTY layer is then
//      responsible for injecting `exec openeral\r` so the connect-shell
//      relaunches the agent inside the existing /home/agent state).
//
// Invariants:
//   - DATABASE_URL stages as a FILE under /home/banker/.openwork-staging
//     (mode 600, banker-owned). Uploads to /sandbox/db-url. setup.sh
//     reads either /sandbox/openeral-input/db-url or /sandbox/db-url;
//     we use the latter to keep the --upload shape a single file:dst.
//   - ANTHROPIC_API_KEY rides in via env + WSLENV; --auto-providers
//     auto-creates the `claude` provider from it at create time.
//   - No --gateway flag: relies on the active selected gateway, which
//     the installer registers via `gateway add --local --name openshell`
//     and selects via `gateway select`.
//   - The rootfs MUST include openssh-client — openshell shells out to
//     ssh/scp for upload, connect, download.

import { randomUUID } from "node:crypto";

import { getCredential } from "./openeral-credentials.mjs";
import { DISTRO_NAME, wslRun, wslSpawn } from "./wsl.mjs";

const SANDBOX_IMAGE = "ghcr.io/sandys/openeral/sandbox:just-bash";
const IMAGE_BY_PROFILE = {
  "openeral-claude": SANDBOX_IMAGE,
  "openeral-openclaw": SANDBOX_IMAGE,
};

const DEFAULT_PULL_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_PROBE_TIMEOUT_MS = 15_000;
const DB_STAGE_TIMEOUT_MS = 15_000;

// DATABASE_URL stages under banker's home, not /tmp. Two reasons:
//   (a) /tmp namespacing diverges between wsl.exe sessions on banker
//       distros under systemd's PrivateTmp — a file written by one
//       wsl.exe call can be ENOENT from the next, and we stage from
//       one wsl.exe call (createOpenEralSandbox pre-flight) but consume
//       from another (the node-pty-spawned sandbox create).
//   (b) banker's home is mode 700 by default, so the secret bytes hit
//       disk only behind the user's own permissions.
const STAGING_DIR = "/home/banker/.openwork-staging";

// Docker pulls happen under user `banker` inside the distro. If Docker
// Desktop's WSL integration ever ran for this distro (or runs again on
// a future boot) it can write a `credsStore: "desktop"` line into
// ~/.docker/config.json that points at /mnt/c/.../docker-credential-desktop.exe.
// Linux docker can't exec a Windows binary — pulls then fail with
// `exec format error`. We route our docker invocations through an empty
// managed config dir so the credential helper is never invoked. The
// images we pull (openeral sandbox, postgres:16-alpine) are public, so
// skipping credentials is correct, not a workaround.
const DOCKER_CONFIG_DIR = "/tmp/openwork-docker-config";

export function imageForProfile(profile) {
  const img = IMAGE_BY_PROFILE[profile];
  if (!img) throw new Error(`Unknown OpenEral profile: ${profile}`);
  return img;
}

/**
 * Pull the OpenEral image into the distro's Docker. Streamed via
 * wslSpawn so a long-running pull shows incremental progress.
 *
 * @param {string} imageRef
 * @param {{ onProgress?: (text: string) => void, timeoutMs?: number }} [options]
 */
export async function pullImage(imageRef, options = {}) {
  const { onProgress, timeoutMs = DEFAULT_PULL_TIMEOUT_MS } = options;
  return new Promise((resolve, reject) => {
    const child = wslSpawn([
      "-d",
      DISTRO_NAME,
      "--",
      "bash",
      "-c",
      `mkdir -p ${DOCKER_CONFIG_DIR} && exec docker --config ${DOCKER_CONFIG_DIR} pull ${shellQuote(imageRef)}`,
    ]);
    let lastStderr = "";
    const tail = (chunk) => {
      const text = chunk.toString("utf8");
      lastStderr = text;
      onProgress?.(text);
    };
    child.stdout.on("data", tail);
    child.stderr.on("data", tail);
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      reject(new Error(`docker pull ${imageRef} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ ok: true });
      else reject(new Error(`docker pull ${imageRef} failed (exit ${code}): ${lastStderr.trim()}`));
    });
  });
}

/**
 * Parse the raw openshell sandbox list output into a normalised array.
 * Returns null only when the raw text cannot yield any sandbox list at all.
 *
 * The openshell CLI has emitted several JSON shapes across releases:
 *   - Flat array:                  [...sandbox objects...]
 *   - {sandboxes: [...]}           early releases
 *   - {items: [...]}               v0.0.3x
 *   - {data: [...]}                v0.0.4x
 *   - {results: [...]}             some builds
 *   - {page: ..., items: [...]}    paginated response
 *
 * If none of the known envelope keys match, we fall back to the FIRST
 * Array-valued key found in the object, so future CLI versions with a
 * new envelope key still work without a code change.
 *
 * Each item is either a plain string (name only) or an object that may
 * carry phase/status fields depending on the CLI version.
 */
function parseSandboxList(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // Not valid JSON at all — caller falls back to text search.
    return null;
  }

  // Flat array
  if (Array.isArray(parsed)) return parsed;

  if (parsed && typeof parsed === "object") {
    // Known envelope keys (add new ones here as the CLI evolves)
    for (const key of ["sandboxes", "items", "data", "results", "namespaces"]) {
      if (Array.isArray(parsed[key])) return parsed[key];
    }
    // Generic fallback: return the first array value found
    for (const key of Object.keys(parsed)) {
      if (Array.isArray(parsed[key])) {
        console.warn(`[parseSandboxList] using unknown envelope key "${key}"`);
        return parsed[key];
      }
    }
  }

  return null;
}

/**
 * Poll `openshell sandbox list --json` until the named sandbox reports
 * a Ready/running phase, or until the timeout elapses. If the CLI does
 * not include phase information in the list (flat string arrays), we
 * optimistically assume the sandbox is ready and return immediately.
 *
 * @param {string} name
 * @param {{ timeoutMs?: number, pollMs?: number, onProgress?: Function }} [opts]
 */
async function waitForSandboxReady(name, opts = {}) {
  const { timeoutMs = 120_000, pollMs = 4_000, onProgress } = opts;
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  // Track the first time we see a "Provisioning" phase so we can detect
  // sandboxes that are stuck (never transition to Ready).
  let firstProvisioningAt = null;
  const STUCK_PROVISIONING_THRESHOLD_MS = 90_000; // 90 s in Provisioning → stuck

  while (Date.now() < deadline) {
    attempt += 1;
    // 20 s outer timeout gives 10 s slack after bash's inner 10 s timer
    // fires, so wsl.exe has time to exit before wslRun's own timer does.
    let r;
    try {
      r = await wslRun(
        ["-d", DISTRO_NAME, "--", "bash", "-c", "timeout 10 openshell sandbox list --json"],
        { timeout: 20_000 },
      );
    } catch {
      // Gateway unreachable during polling — report progress and keep
      // waiting; the sandbox may still transition to Ready.
      onProgress?.({ phase: "waiting", message: `Gateway unresponsive (attempt ${attempt}), retrying…` });
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      continue;
    }
    if (r.exitCode === 0) {
      const list = parseSandboxList(r.stdout);
      if (list) {
        const entry = list.find((s) => {
          if (typeof s === "string") return s === name;
          return s?.name === name || s?.sandbox_name === name || s?.id === name;
        });
        if (entry !== undefined) {
          // Flat string → no phase info, assume ready.
          if (typeof entry === "string") return;
          const phase = String(entry?.phase ?? entry?.status ?? entry?.state ?? "").toLowerCase();
          if (!phase || /ready|running/i.test(phase)) return;
          if (/error|failed/i.test(phase)) {
            throw new Error(`Sandbox ${name} is in error state (${phase}). Delete it and reconnect.`);
          }
          // Detect sandboxes stuck in Provisioning. If the sandbox has been
          // in a provisioning-like state for longer than the threshold, bail
          // out early with a clear error so the renderer can offer a
          // "Delete and start fresh" action rather than spinning forever.
          if (/provision/i.test(phase)) {
            if (!firstProvisioningAt) firstProvisioningAt = Date.now();
            const stuckMs = Date.now() - firstProvisioningAt;
            if (stuckMs > STUCK_PROVISIONING_THRESHOLD_MS) {
              throw new Error(
                `STUCK_PROVISIONING: Sandbox "${name}" has been in "${phase}" state for ` +
                  `over ${Math.round(stuckMs / 1000)}s and appears stuck. ` +
                  `Delete the sandbox and reconnect to create a fresh one. ` +
                  `If the error persists, restart the OpenShell gateway from Settings \u2192 Sandbox \u2192 OpenShell health.`,
              );
            }
          } else {
            // Phase changed away from Provisioning — reset the timer.
            firstProvisioningAt = null;
          }
          onProgress?.({ phase: "waiting", message: `Sandbox is ${phase} (attempt ${attempt}), waiting…` });
        }
      }
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  // Timed out without confirming Ready — if we last saw a provisioning phase
  // treat it as stuck rather than proceeding optimistically (the exec would
  // fail anyway with "phase: Provisioning").
  if (firstProvisioningAt) {
    throw new Error(
      `STUCK_PROVISIONING: Sandbox "${name}" did not reach Ready state within ${Math.round(timeoutMs / 1000)}s ` +
        `(last observed phase: Provisioning). ` +
        `Delete the sandbox and reconnect to create a fresh one. ` +
        `If the error persists, restart the OpenShell gateway from Settings \u2192 Sandbox \u2192 OpenShell health.`,
    );
  }
  // Non-provisioning timeout — proceed; exec may succeed if setup.sh just finished.
  onProgress?.({ phase: "timeout", message: "Sandbox did not confirm Ready state; attempting to connect anyway." });
}

/**
 * True if a sandbox with this name is registered. Used to short-circuit
 * createOpenEralSandbox when re-opening a workspace.
 *
 * Tolerates the flat-array (`[...]`) and envelope (`{sandboxes:[...]}`,
 * `{items:[...]}`) JSON shapes the upstream CLI has emitted across releases.
 */
export async function sandboxExists(name) {
  if (!name) return false;
  // Wrap with bash timeout so the openshell CLI is force-killed after
  // 15 s if the gateway is unreachable. Without this wrapper the
  // process hangs until wslRun's full timeout fires — making the UI
  // appear frozen. bash exits 124 when it kills the child.
  //
  // wslRun timeout is set to 25 s (10 s slack after bash's 15 s fires).
  // Without the extra slack wsl.exe can outlive the bash timeout and
  // trigger wslRun's own timer — throwing a raw "wsl.exe timed out"
  // error before the exitCode === 124 check below is ever reached.
  let r;
  try {
    r = await wslRun(
      ["-d", DISTRO_NAME, "--", "bash", "-c", "timeout 15 openshell sandbox list --json"],
      { timeout: 25_000 },
    );
  } catch (err) {
    // wslRun throws (never returns r) when its own timer fires.
    // Map any timeout to the user-friendly gateway message so the
    // renderer can show a clear call-to-action instead of a raw stack.
    throw new Error(
      "OpenShell gateway is not responding (sandbox list timed out). " +
        "Restart the gateway from Settings \u2192 Sandbox \u2192 OpenShell health \u2192 Restart Gateway, " +
        "then try again.",
    );
  }
  if (r.exitCode === 124) {
    throw new Error(
      "OpenShell gateway is not responding (openshell sandbox list timed out). " +
        "Restart the gateway from Settings \u2192 Sandbox \u2192 OpenShell health \u2192 Restart Gateway, " +
        "then try again.",
    );
  }
  if (r.exitCode !== 0) return false;
  const list = parseSandboxList(r.stdout);
  if (!list) {
    // parseSandboxList could not find an array in the JSON (completely
    // unknown format). Fall back to a raw text search: if the sandbox
    // name appears anywhere in the output it almost certainly exists.
    // This prevents sandboxExists returning false (triggering an
    // unnecessary create that then times out) just because the CLI
    // changed its output format.
    const found = r.stdout.includes(name);
    console.warn(
      `[sandboxExists] unrecognised sandbox list shape — ` +
        `falling back to text search for "${name}": ${found ? "found" : "not found"}. ` +
        `Raw output: ${r.stdout.slice(0, 300)}`,
    );
    return found;
  }
  return list.some((s) => {
    if (typeof s === "string") return s === name;
    // Try every plausible name key the CLI might use
    return s?.name === name || s?.sandbox_name === name || s?.id === name;
  });
}

/**
 * Build the wsl.exe env that forwards ANTHROPIC_API_KEY (and, for the
 * openclaw profile, OPENERAL_AGENT) into the Linux side. WSL only
 * forwards env vars whose names appear in WSLENV.
 */
function buildWslEnvForwarding(extra) {
  const forwardedNames = Object.keys(extra);
  const existingWslEnv = process.env.WSLENV ? [process.env.WSLENV] : [];
  return {
    ...process.env,
    ...extra,
    WSLENV: [...existingWslEnv, ...forwardedNames].join(":"),
  };
}

/**
 * Single-quote a string for safe embedding in a bash command.
 * Replaces any embedded ' with the standard `'\''` escape so the value
 * always rides as a single bash token even if it contains spaces or
 * shell metachars.
 */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * Stage DATABASE_URL into a fresh per-launch file inside the distro.
 * The bytes flow through wsl.exe stdin (memory only) into a 0600 file
 * under banker's home. The PTY launch script's bash `trap` rms the file
 * when the agent process exits; if that trap doesn't fire (PTY killed
 * abruptly), the main-process `unstageDatabaseUrl` cleanup callback
 * removes it. Both paths are idempotent.
 *
 * Returns the absolute Linux path of the staged file.
 */
async function stageDatabaseUrl(databaseUrl) {
  const dbPath = `${STAGING_DIR}/db-url-${randomUUID()}`;
  const script = [
    "set -e",
    "umask 077",
    `mkdir -p ${STAGING_DIR}`,
    `cat > ${dbPath}`,
    `chmod 600 ${dbPath}`,
  ].join("\n");
  const r = await wslRun(
    ["-d", DISTRO_NAME, "--", "bash", "-c", script],
    { timeout: DB_STAGE_TIMEOUT_MS, stdin: databaseUrl },
  );
  if (r.exitCode !== 0) {
    throw new Error(
      `Could not stage DATABASE_URL inside distro: ${(r.stderr || r.stdout).trim() || "(no output)"}`,
    );
  }
  return dbPath;
}

/**
 * Best-effort removal of a staging file. The launch script's bash trap
 * also rms it, so this is idempotent — calling it after a clean exit is
 * a no-op.
 */
export async function unstageDatabaseUrl(dbPath) {
  if (!dbPath || !dbPath.startsWith(STAGING_DIR)) return;
  await wslRun(
    ["-d", DISTRO_NAME, "--", "rm", "-f", dbPath],
    { timeout: 10_000 },
  ).catch(() => {
    // Best-effort.
  });
}

/**
 * Pre-flight an OpenEral sandbox launch. Does NOT call
 * `openshell sandbox create` — that has to run with a real TTY and is
 * the PTY layer's responsibility (see buildSandboxLaunchSpec).
 *
 * Steps:
 *   - Probe whether the sandbox already exists. If yes, wait for it to
 *     reach Ready phase so a subsequent `sandbox connect` doesn't race
 *     a restart.
 *   - Validate credentials are set.
 *   - Pull the image if needed.
 *   - Stage DATABASE_URL into a fresh file inside the distro.
 *
 * Returns the launch context that openeral-pty.mjs / openeral-terminal.mjs
 * pass to `buildSandboxLaunchSpec` to build the canonical openshell
 * invocation. Sandbox naming is stable per-workspace — same name on the
 * same Postgres is OpenEral's portability story.
 *
 * @param {Object} opts
 * @param {string} opts.name
 * @param {"openeral-claude"|"openeral-openclaw"} opts.profile
 * @param {(evt: {phase: string, message: string}) => void} [opts.onProgress]
 * @param {boolean} [opts.skipImagePull]  Skip the docker pull (testing)
 * @returns {Promise<{
 *   name: string,
 *   profile: "openeral-claude"|"openeral-openclaw",
 *   imageRef: string,
 *   existed: boolean,
 *   dbStagingPath: string | null,
 *   anthropicApiKey: string | null,
 *   stringcostApiKey: string | null,
 * }>}
 */
export async function createOpenEralSandbox(opts) {
  const { name, profile, onProgress, skipImagePull = false } = opts;
  if (!name) throw new Error("createOpenEralSandbox: name is required");
  if (!profile) throw new Error("createOpenEralSandbox: profile is required");

  const imageRef = imageForProfile(profile);

  // Short-circuit if the sandbox already exists. Wait for Ready so a
  // subsequent `sandbox connect` doesn't race a restart. Reconnect
  // doesn't need DATABASE_URL (already in the sandbox) or any image pull.
  if (await sandboxExists(name)) {
    onProgress?.({ phase: "exists", message: `Sandbox ${name} already exists; waiting for it to be ready…` });
    await waitForSandboxReady(name, {
      onProgress: (evt) => onProgress?.({ phase: evt.phase, message: evt.message }),
    });
    return {
      name,
      profile,
      imageRef,
      existed: true,
      dbStagingPath: null,
      anthropicApiKey: null,
      stringcostApiKey: null,
    };
  }

  // Validate credentials.
  const databaseUrl = await getCredential("databaseUrl");
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is not configured. Set it in Settings → Sandbox → OpenEral configuration.",
    );
  }
  const anthropicApiKey = await getCredential("anthropicApiKey");
  if (!anthropicApiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not configured. Set it in Settings → Sandbox → OpenEral configuration.",
    );
  }

  const stringcostApiKey = await getCredential("stringcostApiKey");

  // Image pull (~1.5 GB on first run for :just-bash).
  if (!skipImagePull) {
    onProgress?.({ phase: "pull", message: `Pulling ${imageRef}...` });
    await pullImage(imageRef, {
      onProgress: (text) => onProgress?.({ phase: "pull", message: text.trimEnd() }),
    });
  }

  // Stage DATABASE_URL into a persistent path inside the distro. The
  // PTY launch script will `--upload` it to /sandbox/db-url when it
  // runs `openshell sandbox create` with a real TTY.
  onProgress?.({ phase: "stage", message: "Staging credentials inside distro..." });
  const dbStagingPath = await stageDatabaseUrl(databaseUrl);
  onProgress?.({ phase: "ready", message: `Sandbox ${name} ready to launch.` });

  return {
    name,
    profile,
    imageRef,
    existed: false,
    dbStagingPath,
    anthropicApiKey,
    stringcostApiKey,
  };
}

/**
 * Build the wsl.exe argv + env for spawning an OpenEral session inside
 * a real PTY. Two shapes:
 *
 *   - existed=false (first launch): canonical single-step recipe:
 *
 *       trap 'rm -f <dbStagingPath>' EXIT
 *       openshell sandbox create --tty \
 *         --name <name> --from <imageRef> \
 *         --upload <dbStagingPath>:/sandbox/db-url \
 *         --provider claude --auto-providers \
 *         -- openeral
 *
 *     ANTHROPIC_API_KEY (and optionally STRINGCOST_API_KEY) ride in via
 *     env + WSLENV so --auto-providers picks them up at create time.
 *     The bash trap removes the staging file when sandbox create finally
 *     returns (when the user exits the agent REPL).
 *
 *   - existed=true (reconnect): `openshell sandbox connect <name>`.
 *     Drops into a shell where setup.sh's bashrc rewrite has set
 *     HOME=/home/agent. The caller is responsible for writing
 *     `reconnectStdinInjection` (`exec openeral\r`) to the PTY's stdin
 *     so the agent relaunches against the existing /home/agent state.
 *
 * Why NOT `openshell sandbox exec`: the openeral maintainers' tests
 * (openeral-js/src/cli.test.ts:129) explicitly assert that subcommand
 * is not real. The previous OpenWork shape used `sandbox exec --tty
 * -- bash -c '... exec openeral'`, which "kind of" launched Claude
 * Code but left stdin disconnected from the container PTY — the
 * symptom users reported as "Claude loads but I can't type." The
 * canonical single-step recipe above doesn't have that problem
 * because openshell wires the host TTY directly into the container.
 *
 * @param {Object} spec
 * @param {string} spec.name
 * @param {"openeral-claude"|"openeral-openclaw"} spec.profile
 * @param {string} spec.imageRef
 * @param {boolean} spec.existed
 * @param {string | null} spec.dbStagingPath  Required when !existed
 * @param {string | null} [spec.anthropicApiKey]  Required when !existed
 * @param {string | null} [spec.stringcostApiKey]  Optional cost-tracking key
 * @returns {{
 *   args: string[],
 *   env: NodeJS.ProcessEnv,
 *   dbStagingPath: string | null,
 *   reconnectStdinInjection: string | null,
 * }}
 */
export function buildSandboxLaunchSpec(spec) {
  const {
    name,
    profile,
    imageRef,
    existed,
    dbStagingPath,
    anthropicApiKey,
    stringcostApiKey,
  } = spec;
  if (!name) throw new Error("buildSandboxLaunchSpec: name is required");

  if (existed) {
    return {
      args: ["-d", DISTRO_NAME, "--", "openshell", "sandbox", "connect", name],
      env: process.env,
      dbStagingPath: null,
      reconnectStdinInjection: "exec openeral\r",
    };
  }

  if (!imageRef) {
    throw new Error("buildSandboxLaunchSpec: imageRef is required for fresh launch");
  }
  if (!dbStagingPath) {
    throw new Error("buildSandboxLaunchSpec: dbStagingPath is required for fresh launch");
  }
  if (!anthropicApiKey) {
    throw new Error(
      "buildSandboxLaunchSpec: anthropicApiKey is required for fresh launch (used by --auto-providers)",
    );
  }

  // Provider arg: claude for both profiles. For openclaw, OPENERAL_AGENT
  // is injected via WSLENV — the image's setup.sh dispatches on it.
  // STRINGCOST_API_KEY is forwarded so setup.sh can create the presign.
  const forwarded = { ANTHROPIC_API_KEY: anthropicApiKey };
  if (stringcostApiKey) {
    forwarded.STRINGCOST_API_KEY = stringcostApiKey;
  }
  if (profile === "openeral-openclaw") {
    forwarded.OPENERAL_AGENT = "openclaw";
  }
  const env = buildWslEnvForwarding(forwarded);

  // `openshell sandbox create` blocks until the trailing command
  // (openeral) exits. The bash EXIT trap rms the staging file after
  // openshell returns. We deliberately do NOT `exec openshell ...`
  // here — `exec` would replace bash and the trap would never fire.
  const script = [
    "set -e",
    `trap 'rm -f ${dbStagingPath}' EXIT`,
    `openshell sandbox create --tty ` +
      `--name ${shellQuote(name)} ` +
      `--from ${shellQuote(imageRef)} ` +
      `--upload ${dbStagingPath}:/sandbox/db-url ` +
      `--provider claude --auto-providers ` +
      `-- openeral`,
  ].join("\n");

  return {
    args: ["-d", DISTRO_NAME, "--", "bash", "-c", script],
    env,
    dbStagingPath,
    reconnectStdinInjection: null,
  };
}

export async function deleteOpenEralSandbox(name) {
  if (!name) throw new Error("deleteOpenEralSandbox: name is required");
  // `openshell sandbox delete` does NOT support --force; passing it causes
  // "unexpected argument '--force' found" and exit 1. Use bash timeout for
  // the same inner-timeout safety net we apply to list/create calls.
  let r;
  try {
    r = await wslRun(
      ["-d", DISTRO_NAME, "--", "bash", "-c", `timeout 20 openshell sandbox delete ${shellQuote(name)}`],
      { timeout: 30_000 },
    );
  } catch (err) {
    if (/wsl\.exe timed out/i.test(err?.message ?? "")) {
      throw new Error(
        "openshell sandbox delete timed out. The OpenShell gateway may be unresponsive. " +
          "Restart the gateway from Settings \u2192 Sandbox \u2192 OpenShell health \u2192 Restart Gateway, " +
          "then try again.",
      );
    }
    throw err;
  }
  if (r.exitCode !== 0) {
    const output = (r.stderr || r.stdout).trim();
    // 124 = bash timeout(1) hit the inner timer — gateway is unresponsive.
    if (r.exitCode === 124) {
      throw new Error(
        "openshell sandbox delete timed out (gateway unresponsive). " +
          "Restart the gateway from Settings \u2192 Sandbox \u2192 OpenShell health \u2192 Restart Gateway, " +
          "then try again.",
      );
    }
    throw new Error(`openshell sandbox delete failed: ${output || "(no output)"}`);
  }
  return r;
}

/**
 * Live database-reachability probe. Runs psql via a transient
 * `postgres:16-alpine` container inside the distro. Pulls lazily on
 * first call (~6 MB). Returns `{ ok: true, reachable: true }` on
 * successful `SELECT 1`, throws otherwise.
 */
export async function probeDatabaseUrl({ timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
  const url = await getCredential("databaseUrl");
  if (!url) {
    throw new Error("DATABASE_URL is not configured.");
  }
  // Same DOCKER_CONFIG sidestep as pullImage — postgres:16-alpine is
  // public and we don't want Docker Desktop's credential helper in the
  // path here either.
  const r = await wslRun(
    [
      "-d",
      DISTRO_NAME,
      "--",
      "bash",
      "-c",
      `mkdir -p ${DOCKER_CONFIG_DIR} && exec docker --config ${DOCKER_CONFIG_DIR} run --rm -i -e PGCONNECT_TIMEOUT=10 postgres:16-alpine psql ${shellQuote(url)} -tAc 'select 1'`,
    ],
    { timeout: timeoutMs },
  );
  if (r.exitCode !== 0) {
    throw new Error(
      `Could not reach PostgreSQL: ${(r.stderr || r.stdout).trim() || "unknown error"}`,
    );
  }
  return { ok: true, reachable: true };
}

export const __testing = {
  IMAGE_BY_PROFILE,
  STAGING_DIR,
  buildWslEnvForwarding,
  shellQuote,
};
