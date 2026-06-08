import { spawn, execSync } from 'child_process';
import * as os from 'os';

/**
 * Cross-platform helpers for "preset" actions used by Combined Operations
 * (native execution, no terminal) and Claude Hooks Manager (emitted as shell
 * command strings).
 *
 * Each helper returns the best command for the current OS. When the primary
 * utility isn't installed, falls back to a sensible alternative or returns
 * an empty string and lets the caller surface a "missing dependency" warning.
 */

const platform: NodeJS.Platform = os.platform();

interface ToolAvailability {
  paplay: boolean;
  aplay: boolean;
  afplay: boolean;
  notifySend: boolean;
  osascript: boolean;
  xdgOpen: boolean;
  open: boolean;
  start: boolean;
  powershell: boolean;
  pwsh: boolean;
}

let cachedAvailability: ToolAvailability | null = null;

function which(bin: string): boolean {
  try {
    const cmd = platform === 'win32' ? `where ${bin}` : `command -v ${bin}`;
    execSync(cmd, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function detectAvailable(): ToolAvailability {
  if (cachedAvailability) return cachedAvailability;
  cachedAvailability = {
    paplay: which('paplay'),
    aplay: which('aplay'),
    afplay: which('afplay'),
    notifySend: which('notify-send'),
    osascript: which('osascript'),
    xdgOpen: which('xdg-open'),
    open: which('open'),
    start: platform === 'win32',
    powershell: which('powershell') || which('powershell.exe'),
    pwsh: which('pwsh') || which('pwsh.exe'),
  };
  return cachedAvailability;
}

/** Drop the cache (e.g. after the user installs a missing tool). */
export function resetAvailabilityCache(): void {
  cachedAvailability = null;
}

const SOUND_CLIPS: Record<string, { linux: string; macos: string }> = {
  complete: {
    linux: '/usr/share/sounds/freedesktop/stereo/complete.oga',
    macos: '/System/Library/Sounds/Glass.aiff',
  },
  alert: {
    linux: '/usr/share/sounds/freedesktop/stereo/bell.oga',
    macos: '/System/Library/Sounds/Ping.aiff',
  },
  error: {
    linux: '/usr/share/sounds/freedesktop/stereo/dialog-error.oga',
    macos: '/System/Library/Sounds/Basso.aiff',
  },
};

/**
 * Returns a shell command string that plays a sound on the current OS, or
 * '' if no usable tool was found. Used by Claude Hooks (shell-only) and by
 * Combined Operations when run as a `sound` step (spawned natively).
 */
export function soundCommand(clip: keyof typeof SOUND_CLIPS = 'complete'): string {
  const tools = detectAvailable();
  if (platform === 'darwin') {
    if (tools.afplay) return `afplay "${SOUND_CLIPS[clip].macos}"`;
    return '';
  }
  if (platform === 'win32') {
    const ps = tools.pwsh ? 'pwsh' : tools.powershell ? 'powershell' : '';
    if (!ps) return '';
    const freq = clip === 'error' ? 300 : clip === 'alert' ? 1200 : 800;
    return `${ps} -NoProfile -Command "[console]::beep(${freq},400)"`;
  }
  // linux / other unix
  const file = SOUND_CLIPS[clip].linux;
  if (tools.paplay) return `paplay "${file}"`;
  if (tools.aplay) return `aplay -q "${file}"`;
  return ''; // last-resort terminal bell is `printf '\\a'` — too quiet to be useful
}

function escapeShellArg(s: string): string {
  // Conservative quoting that works across bash/zsh/cmd/powershell. Embedded
  // single-quotes get escaped via the standard '\'' trick on unix; on Windows
  // we wrap in double-quotes and escape inner double-quotes.
  if (platform === 'win32') {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function notificationCommand(
  message: string,
  level: 'info' | 'warn' | 'error' = 'info',
  title = 'Claude',
): string {
  const tools = detectAvailable();
  if (platform === 'darwin') {
    if (!tools.osascript) return '';
    // osascript's display notification doesn't have warn/error levels; we
    // prefix the title to convey severity.
    const tt = level === 'info' ? title : `${title} [${level}]`;
    const safeMsg = message.replace(/"/g, '\\"');
    const safeTt = tt.replace(/"/g, '\\"');
    return `osascript -e 'display notification "${safeMsg}" with title "${safeTt}"'`;
  }
  if (platform === 'win32') {
    const ps = tools.pwsh ? 'pwsh' : tools.powershell ? 'powershell' : '';
    if (!ps) return '';
    // BurntToast is the best option but isn't installed by default. Fall back
    // to a simple message box via [System.Windows.MessageBox] (needs .NET).
    const safeMsg = message.replace(/"/g, '`"');
    return `${ps} -NoProfile -Command "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show(\\"${safeMsg}\\", \\"${title}\\")"`;
  }
  // linux
  if (!tools.notifySend) return '';
  const urgency = level === 'error' ? 'critical' : level === 'warn' ? 'normal' : 'low';
  return `notify-send -u ${urgency} ${escapeShellArg(title)} ${escapeShellArg(message)}`;
}

export function openCommand(target: string, kind: 'url' | 'file' | 'app' = 'url'): string {
  const tools = detectAvailable();
  const arg = escapeShellArg(target);
  if (platform === 'darwin') {
    if (!tools.open) return '';
    return kind === 'app' ? `open -a ${arg}` : `open ${arg}`;
  }
  if (platform === 'win32') {
    // `start` needs an empty title arg so quoted targets aren't mistaken for it
    return `start "" ${arg}`;
  }
  // linux
  if (kind === 'app') {
    // xdg-open expects URLs/files, not app names. gtk-launch resolves
    // .desktop files; fall back to executing the binary directly for apps
    // that exist in PATH but don't ship a .desktop entry.
    return `gtk-launch ${arg} 2>/dev/null || ${arg}`;
  }
  if (!tools.xdgOpen) return '';
  return `xdg-open ${arg}`;
}

/**
 * Native sound playback used by Combined Operations runner — spawns the
 * command detached so it doesn't block the next step. Returns true if a
 * command was launched, false if no usable tool was detected.
 */
export function playSoundNative(clip: keyof typeof SOUND_CLIPS = 'complete'): boolean {
  const cmd = soundCommand(clip);
  if (!cmd) return false;
  try {
    const child = spawn(cmd, { shell: true, detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Native open used by Combined Operations runner for `kind: 'app'` targets.
 * For url/file the runner uses vscode.env.openExternal which is cleaner.
 */
export function openAppNative(target: string): boolean {
  const cmd = openCommand(target, 'app');
  if (!cmd) return false;
  try {
    const child = spawn(cmd, { shell: true, detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export interface PresetAvailabilityReport {
  sound: boolean;
  notification: boolean;
  open: boolean;
  installHint: string;
}

/**
 * Used by the webview's editor modal to render a ⚠ "may not work" badge next
 * to presets whose underlying tool isn't installed on this system.
 */
export function getPresetAvailability(): PresetAvailabilityReport {
  const t = detectAvailable();
  let sound = false;
  let notification = false;
  let open = false;
  let installHint = '';

  if (platform === 'darwin') {
    sound = t.afplay;
    notification = t.osascript;
    open = t.open;
  } else if (platform === 'win32') {
    sound = t.pwsh || t.powershell;
    notification = t.pwsh || t.powershell;
    open = true; // `start` is built-in
    if (!notification) installHint = 'Install PowerShell 7+ (`pwsh`) for sound/notification.';
  } else {
    sound = t.paplay || t.aplay;
    notification = t.notifySend;
    open = t.xdgOpen;
    const missing: string[] = [];
    if (!sound) missing.push('pulseaudio-utils');
    if (!notification) missing.push('libnotify-bin');
    if (!open) missing.push('xdg-utils');
    if (missing.length) {
      installHint = `Install: sudo apt install ${missing.join(' ')} (or equivalent for your distro).`;
    }
  }

  return { sound, notification, open, installHint };
}
