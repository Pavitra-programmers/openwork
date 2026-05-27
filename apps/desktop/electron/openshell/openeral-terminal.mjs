// External-terminal launcher for OpenEral sessions. Same launch spec
// as the in-app xterm.js path (see openeral-pty.mjs); we just hand the
// argv off to an OS terminal emulator instead of node-pty. Both shapes
// need a real TTY so Claude Code's first-run prompts are answerable.
//
// Reconnect caveat: the in-app PTY path can inject `exec openeral\r`
// once the connect-shell prompt appears. The external terminal can't
// (no stdin handle after spawn), so for reconnects the user has to
// type `openeral` (or `claude`) in the connect shell themselves. That's
// acceptable for the "pop out" feature, which is supplementary to the
// in-app terminal.
//
// Platforms:
//   - Windows: Windows Terminal (wt.exe) if available, else cmd.exe.
//     Windows Terminal handles TTY resize properly; cmd.exe is the
//     fallback so the feature works on stock Windows 11 install.
//   - macOS:   osascript drives Terminal.app to open a new window.
//   - Linux:   probes a list of known terminal emulators and uses the
//              first one found. Dev-only — banker laptops are Windows.

import { spawn } from "node:child_process";
import process from "node:process";

import { buildSandboxLaunchSpec } from "./openeral.mjs";

const LINUX_TERMINAL_CANDIDATES = [
  // Each entry is { command, argsForCommand(cmd, args) → string[] }
  // where the inner closure builds the argv that launches `cmd args[...]`
  // inside the terminal emulator and exits when it does.
  { exe: "alacritty", build: (cmd, args) => ["-e", cmd, ...args] },
  { exe: "kitty", build: (cmd, args) => [cmd, ...args] },
  { exe: "wezterm", build: (cmd, args) => ["start", "--", cmd, ...args] },
  { exe: "gnome-terminal", build: (cmd, args) => ["--", cmd, ...args] },
  { exe: "konsole", build: (cmd, args) => ["-e", cmd, ...args] },
  { exe: "xfce4-terminal", build: (cmd, args) => ["-e", `${cmd} ${args.join(" ")}`] },
  { exe: "tilix", build: (cmd, args) => ["-e", `${cmd} ${args.join(" ")}`] },
  { exe: "xterm", build: (cmd, args) => ["-e", cmd, ...args] },
];

function detectLinuxTerminal() {
  for (const candidate of LINUX_TERMINAL_CANDIDATES) {
    try {
      // Cheap probe: spawn `which`. Cross-distro available.
      const probe = spawn("which", [candidate.exe], {
        stdio: ["ignore", "ignore", "ignore"],
      });
      // Synchronous wait via a small busy promise wouldn't fit here.
      // Instead, return the first candidate that doesn't error
      // immediately — `which` returning non-zero is handled at launch
      // time by the actual spawn() failing. This is good enough for the
      // Linux dev path; bankers run Windows.
      probe.unref();
    } catch {
      // ignore
    }
  }
  // Without a synchronous which-check, return them all and let the
  // caller try in order. Cleaner: the actual launcher tries each.
  return LINUX_TERMINAL_CANDIDATES;
}

/**
 * Spawn an OS terminal window running the canonical openshell sandbox
 * launch (create + openeral on first launch, connect on reconnect).
 * Returns once the terminal launch has been dispatched — does NOT wait
 * for the user to close it.
 *
 * Throws if no terminal could be launched.
 *
 * @param {Object} launchInfo
 * @param {string} launchInfo.sandboxName
 * @param {"openeral-claude"|"openeral-openclaw"} launchInfo.profile
 * @param {string} launchInfo.imageRef
 * @param {boolean} launchInfo.existed
 * @param {string | null} launchInfo.dbStagingPath
 * @param {string | null} [launchInfo.anthropicApiKey]
 * @param {string | null} [launchInfo.stringcostApiKey]
 * @param {{ windowTitle?: string }} [options]
 */
export async function launchExternalTerminalToSandbox(launchInfo, options = {}) {
  if (!launchInfo?.sandboxName) {
    throw new Error("launchExternalTerminalToSandbox: sandboxName is required");
  }
  const windowTitle = options.windowTitle ?? `OpenWork — ${launchInfo.sandboxName}`;

  const spec = buildSandboxLaunchSpec({
    name: launchInfo.sandboxName,
    profile: launchInfo.profile,
    imageRef: launchInfo.imageRef,
    existed: !!launchInfo.existed,
    dbStagingPath: launchInfo.dbStagingPath ?? null,
    anthropicApiKey: launchInfo.anthropicApiKey ?? null,
    stringcostApiKey: launchInfo.stringcostApiKey ?? null,
  });

  if (process.platform === "win32") {
    return launchWindowsTerminal(spec, windowTitle);
  }
  if (process.platform === "darwin") {
    return launchMacOSTerminal(spec, windowTitle);
  }
  return launchLinuxTerminal(spec, windowTitle);
}

function launchWindowsTerminal(spec, windowTitle) {
  // Try Windows Terminal first. The `wt.exe` shim accepts `--title`
  // and runs the wsl.exe argv directly as the command. If wt isn't
  // installed (older Win11 installs), fall back to cmd.exe so the
  // window stays open while the wsl command runs.
  const wslArgs = spec.args;
  const env = spec.env ?? process.env;

  const wtChild = spawn(
    "wt.exe",
    ["--title", windowTitle, "wsl.exe", ...wslArgs],
    { detached: true, stdio: "ignore", windowsHide: false, env },
  );
  return new Promise((resolve, reject) => {
    wtChild.once("error", () => {
      // wt.exe missing — fall back to cmd.exe.
      const cmdChild = spawn(
        "cmd.exe",
        ["/C", "start", `"${windowTitle}"`, "wsl.exe", ...wslArgs],
        { detached: true, stdio: "ignore", windowsHide: false, shell: true, env },
      );
      cmdChild.once("error", reject);
      cmdChild.unref();
      resolve({ launched: "cmd.exe" });
    });
    wtChild.unref();
    // Resolve a tick after dispatch — wt.exe's "error" fires sync if missing.
    setTimeout(() => resolve({ launched: "wt.exe" }), 50);
  });
}

function launchMacOSTerminal(_spec, _windowTitle) {
  // osascript opens Terminal.app and runs a command. We can't directly
  // run wsl on macOS (it doesn't exist) but the sandbox-connect target
  // is wsl-resident, so this path is dev-only and runs against a
  // remote dev distro via SSH (which a banker laptop wouldn't have).
  // Surfacing a clear "macOS unsupported for OpenEral" error is more
  // honest than spawning a terminal that immediately fails.
  return Promise.reject(
    new Error(
      "OpenEral sessions are not supported on macOS — the openwork-openshell WSL distro " +
        "only exists on Windows. macOS / Linux remain testing-only host platforms for " +
        "OpenWork itself; the sandboxes always run on the banker's Windows machine.",
    ),
  );
}

async function launchLinuxTerminal(spec, _windowTitle) {
  // Linux is dev convenience only — banker laptops are Windows. Probe a
  // list of common terminal emulators in priority order.
  const wslArgs = spec.args;
  const env = spec.env ?? process.env;
  const candidates = detectLinuxTerminal();
  for (const cand of candidates) {
    const args = cand.build("wsl.exe", wslArgs);
    try {
      const child = spawn(cand.exe, args, {
        detached: true,
        stdio: "ignore",
        env,
      });
      // Sync error from missing binary fires within a tick.
      const launched = await new Promise((resolve) => {
        let settled = false;
        child.once("error", () => {
          if (!settled) {
            settled = true;
            resolve(false);
          }
        });
        setTimeout(() => {
          if (!settled) {
            settled = true;
            child.unref();
            resolve(true);
          }
        }, 80);
      });
      if (launched) {
        return { launched: cand.exe };
      }
    } catch {
      // try next
    }
  }
  throw new Error(
    "Could not find a terminal emulator to launch the OpenEral session in. " +
      "Install one of: alacritty, kitty, wezterm, gnome-terminal, konsole, xfce4-terminal, tilix, xterm. " +
      "(Linux is a dev-only host for OpenEral; banker laptops run Windows.)",
  );
}

/**
 * Sanitize a workspace id into a stable OpenShell sandbox name.
 * Sandbox name = workspace id is OpenEral's portability story; same
 * workspace from a different machine restores the same Postgres-backed
 * /home/agent. We just guard against punctuation OpenShell won't accept.
 */
export function deriveOpenEralSandboxName(workspaceId) {
  const trimmed = String(workspaceId ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  if (!trimmed) {
    throw new Error("Cannot derive OpenEral sandbox name from empty workspace id.");
  }
  return `openeral-${trimmed}`;
}
