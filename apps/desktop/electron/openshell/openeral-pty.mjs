// PTY bridge for OpenEral sessions. Spawns the canonical openshell
// invocation inside a real pseudo-terminal (node-pty) so Claude Code
// and OpenClaw — which both refuse to launch without a TTY — get a
// working stdin/stdout/resize channel.
//
// The actual wsl.exe argv + env come from buildSandboxLaunchSpec in
// openeral.mjs and depend on whether this is a fresh launch or a
// reconnect:
//   - Fresh launch (existed=false):
//       wsl -d <distro> -- bash -c 'trap "rm <db>" EXIT;
//                                   openshell sandbox create --tty
//                                   --name X --from Y --upload <db>
//                                   --provider claude --auto-providers
//                                   -- openeral'
//   - Reconnect (existed=true):
//       wsl -d <distro> -- openshell sandbox connect <name>
//     then the openSession injects `exec openeral\r` into the PTY's
//     stdin once the bashrc-decorated shell prompt appears, so the
//     agent relaunches against the existing /home/agent state.
//
// The bytes flow:
//
//   renderer xterm.js ──IPC── main process ──node-pty.write── wsl.exe ──
//     openshell sandbox create|connect ── ssh/docker ── Claude Code TUI
//
//   …and back the other way.
//
// One module-level `sessions` Map tracks every open PTY by a fresh
// session id (UUID). The renderer holds the id; main owns the IPty
// handle. Closing the renderer-side terminal calls back here to clean
// up the IPty (kill the wsl child) and run any per-session cleanup
// (e.g. unstageDatabaseUrl). The OpenEral sandbox container persists
// — that's OpenEral's portability story.
//
// node-pty is lazy-loaded inside spawnSession() so this module can be
// imported under `node --test` (the test suite stubs out spawnSession
// via __testing.installSpawnImpl).

import { randomUUID } from "node:crypto";

import { buildSandboxLaunchSpec } from "./openeral.mjs";

/** @typedef {(data: string | Uint8Array) => void} DataHandler */
/** @typedef {(exitCode: number | null, signal?: string | null) => void} ExitHandler */

/**
 * @typedef {Object} IPtyLike
 * @property {(data: string) => void} write
 * @property {(cols: number, rows: number) => void} resize
 * @property {(signal?: string) => void} kill
 * @property {(handler: DataHandler) => { dispose: () => void }} onData
 * @property {(handler: (event: { exitCode: number; signal?: number | undefined }) => void) => { dispose: () => void }} onExit
 * @property {number | undefined} pid
 */

/**
 * @typedef {Object} Session
 * @property {string} id
 * @property {string} sandboxName
 * @property {IPtyLike} pty
 * @property {DataHandler | null} onData
 * @property {ExitHandler | null} onExit
 * @property {{ cols: number; rows: number }} size
 * @property {number} openedAt
 * @property {(() => Promise<void> | void) | null} cleanup
 */

/** @type {Map<string, Session>} */
const sessions = new Map();

/**
 * Default spawn implementation: lazy-loads node-pty and spawns wsl.exe
 * with the launch spec's argv + env. Overridable via
 * __testing.installSpawnImpl for the unit suite.
 *
 * @param {{ sandboxName: string; cols: number; rows: number; args: string[]; env: NodeJS.ProcessEnv }} opts
 * @returns {Promise<IPtyLike>}
 */
let spawnImpl = async ({ cols, rows, args, env }) => {
  const pty = await import("node-pty");
  // wsl.exe is the only executable in the chain. node-pty handles the
  // TTY allocation and wsl forwards the PTY into the distro. From there
  // openshell wires the host TTY directly into the container — so
  // Claude Code's first-run prompts are answerable and keystrokes flow
  // back end-to-end.
  return pty.spawn("wsl.exe", args, {
    name: "xterm-256color",
    cols,
    rows,
    env,
    // CWD doesn't really matter for wsl.exe, but cleanup-safe default.
    cwd: process.env.HOME ?? process.env.USERPROFILE ?? process.cwd(),
  });
};

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;

/**
 * Open a new PTY session against an OpenEral sandbox.
 *
 * On a fresh launch (`existed === false`) this runs the canonical
 * `openshell sandbox create --tty ... -- openeral` recipe — a single
 * blocking process that provisions the container, runs setup.sh, and
 * exec's the agent, all inside the host TTY. No `sandbox exec` shenanigans.
 *
 * On a reconnect (`existed === true`) this runs
 * `openshell sandbox connect <name>`, which drops into the sandbox
 * user's shell. setup.sh's bashrc rewrite sets HOME=/home/agent for
 * those sessions, so the agent's prior state is visible. We then write
 * `exec openeral\r` to the PTY's stdin so the agent relaunches.
 *
 * @param {Object} opts
 * @param {string} opts.sandboxName
 * @param {"openeral-claude"|"openeral-openclaw"} opts.profile
 * @param {string} opts.imageRef
 * @param {boolean} opts.existed
 * @param {string | null} opts.dbStagingPath     Required when !existed
 * @param {string | null} [opts.anthropicApiKey] Required when !existed
 * @param {string | null} [opts.stringcostApiKey] Optional cost-tracking key
 * @param {number} [opts.cols]
 * @param {number} [opts.rows]
 * @param {DataHandler} [opts.onData]   Receives PTY stdout/stderr bytes
 * @param {ExitHandler} [opts.onExit]   Called when the wsl child exits
 * @param {(() => Promise<void> | void) | null} [opts.cleanup]
 *        Called once after the PTY exits (e.g. unstageDatabaseUrl).
 * @returns {Promise<{ id: string, sandboxName: string }>}
 */
export async function openSession(opts) {
  if (!opts?.sandboxName) {
    throw new Error("openSession: sandboxName is required");
  }
  const cols = Number.isFinite(opts.cols) ? opts.cols : DEFAULT_COLS;
  const rows = Number.isFinite(opts.rows) ? opts.rows : DEFAULT_ROWS;

  const spec = buildSandboxLaunchSpec({
    name: opts.sandboxName,
    profile: opts.profile,
    imageRef: opts.imageRef,
    existed: !!opts.existed,
    dbStagingPath: opts.dbStagingPath ?? null,
    anthropicApiKey: opts.anthropicApiKey ?? null,
    stringcostApiKey: opts.stringcostApiKey ?? null,
  });

  const pty = await spawnImpl({
    sandboxName: opts.sandboxName,
    cols,
    rows,
    args: spec.args,
    env: spec.env,
  });
  const id = randomUUID();

  /** @type {Session} */
  const session = {
    id,
    sandboxName: opts.sandboxName,
    pty,
    onData: opts.onData ?? null,
    onExit: opts.onExit ?? null,
    size: { cols, rows },
    openedAt: Date.now(),
    cleanup: opts.cleanup ?? null,
  };

  // Wire data → caller. node-pty's onData fires for both stdout and
  // stderr — there's no TTY-side distinction, which is exactly what
  // xterm.js expects.
  pty.onData((data) => {
    session.onData?.(data);
  });

  pty.onExit((event) => {
    sessions.delete(id);
    const code = typeof event?.exitCode === "number" ? event.exitCode : null;
    const signal =
      typeof event?.signal === "number" ? String(event.signal) : event?.signal ?? null;
    // Cleanup is fire-and-forget — its job is to remove ephemeral
    // state (the DATABASE_URL staging file), not to gate the exit
    // notification on disk I/O.
    if (session.cleanup) {
      Promise.resolve()
        .then(() => session.cleanup?.())
        .catch(() => {
          // Best-effort. The launch script's bash `trap` also rms it.
        });
    }
    session.onExit?.(code, signal);
  });

  sessions.set(id, session);

  // Reconnect: inject `exec openeral\r` so the bashrc-decorated shell
  // relaunches the agent against the existing /home/agent state.
  // Small delay lets the bash prompt render first so the typed command
  // is queued past any initial PROMPT_COMMAND output rather than being
  // eaten by the shell's input clear.
  if (spec.reconnectStdinInjection) {
    setTimeout(() => {
      // Re-check the session still exists — the user may have closed it.
      const live = sessions.get(id);
      if (!live) return;
      try {
        live.pty.write(spec.reconnectStdinInjection);
      } catch {
        // Best-effort — if the PTY already died, the exit handler took care of it.
      }
    }, 250);
  }

  return { id, sandboxName: opts.sandboxName };
}

/**
 * Write bytes from the renderer's xterm to the PTY's stdin. Returns
 * `false` if the session is unknown (caller can decide whether to
 * surface that or swallow it — keystrokes after close are noise).
 */
export function writeSession(id, data) {
  const session = sessions.get(id);
  if (!session) return false;
  session.pty.write(typeof data === "string" ? data : String(data));
  return true;
}

/**
 * Forward an xterm.js resize. Returns `false` if the session is gone.
 * No-op (returns true) if the size hasn't changed — saves the SIGWINCH
 * cost on every renderer re-paint.
 */
export function resizeSession(id, cols, rows) {
  const session = sessions.get(id);
  if (!session) return false;
  const safeCols = Number.isFinite(cols) && cols > 0 ? Math.floor(cols) : session.size.cols;
  const safeRows = Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : session.size.rows;
  if (safeCols === session.size.cols && safeRows === session.size.rows) {
    return true;
  }
  session.pty.resize(safeCols, safeRows);
  session.size = { cols: safeCols, rows: safeRows };
  return true;
}

/**
 * Kill the PTY's wsl child. The onExit handler fires synchronously and
 * removes the session from the map. The OpenEral sandbox itself
 * persists — that's the whole point of OpenEral's PostgreSQL-backed
 * /home/agent.
 */
export function closeSession(id, signal = "SIGTERM") {
  const session = sessions.get(id);
  if (!session) return false;
  try {
    session.pty.kill(signal);
  } catch {
    // Already exited; the onExit cleanup may not have run yet.
    sessions.delete(id);
  }
  return true;
}

/**
 * Renderer-safe view of every live session. Used by the workspace tab
 * UI to show "session active" badges and by the doctor to count open
 * sessions per sandbox.
 */
export function listSessions() {
  return Array.from(sessions.values()).map((s) => ({
    id: s.id,
    sandboxName: s.sandboxName,
    cols: s.size.cols,
    rows: s.size.rows,
    openedAt: s.openedAt,
    pid: s.pty.pid ?? null,
  }));
}

/**
 * Replace data/exit handlers for a live session. Used when the renderer
 * remounts (e.g., user toggles between session tabs) so the new
 * component picks up the existing PTY without spawning a new one.
 *
 * @param {string} id
 * @param {{ onData?: DataHandler | null, onExit?: ExitHandler | null }} [handlers]
 */
export function attachHandlers(id, handlers = {}) {
  const { onData, onExit } = handlers;
  const session = sessions.get(id);
  if (!session) return false;
  if (onData !== undefined) session.onData = onData ?? null;
  if (onExit !== undefined) session.onExit = onExit ?? null;
  return true;
}

/** Tear down every session. Called on app quit / runtime shutdown. */
export function closeAllSessions() {
  for (const id of Array.from(sessions.keys())) {
    closeSession(id);
  }
}

export const __testing = {
  /**
   * Replace the node-pty spawn with a stub. The stub receives
   * `{ sandboxName, cols, rows, args, env }` and must return an
   * IPty-like object. Use clearSpawnImpl() to restore the default.
   */
  installSpawnImpl(fn) {
    spawnImpl = fn;
  },
  clearSpawnImpl() {
    spawnImpl = async ({ cols, rows, args, env }) => {
      const pty = await import("node-pty");
      return pty.spawn("wsl.exe", args, {
        name: "xterm-256color",
        cols,
        rows,
        env,
        cwd: process.env.HOME ?? process.env.USERPROFILE ?? process.cwd(),
      });
    };
  },
  getSessionCount() {
    return sessions.size;
  },
  resetAll() {
    closeAllSessions();
    sessions.clear();
  },
};
