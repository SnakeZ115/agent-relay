import * as path from 'node:path';
import type { HostAdapter, HostId, ProfileStatus } from './types.js';
import { getAdapter } from './adapters/index.js';
import {
  getNextProfile,
  getRuntimeSessionDir,
  initProfile,
  listProfiles,
  syncProfileSharedFiles,
} from './profiles.js';
import {
  generateHandoff,
  readAndClearSwapTrigger,
  stripAnsi,
} from './handoff.js';
import { enforceDirectorySecurity } from './security.js';

export const SWAP_COOLDOWN_MS = 60_000;

const TEST_CODE_REGEX = /^\s*(?:expect\(|assert\.|it\(|it\s*\(|test\(|test\s*\(|describe\(|describe\s*\(|✔|✓|✖|✕|▶|#|\/\/|\/\*|\*)/i;

/**
 * Circular buffer holding terminal output lines with ANSI stripping,
 * per-line truncation, and fixed maximum line capacity.
 */
export class CircularLineBuffer {
  private readonly maxLines: number;
  private readonly maxLineChars: number;
  private lines: string[] = [];
  private remainder = '';

  constructor(maxLines = 150, maxLineChars = 300) {
    this.maxLines = maxLines;
    this.maxLineChars = maxLineChars;
  }

  pushChunk(chunk: string): void {
    if (!chunk) return;
    const combined = this.remainder + chunk;
    const parts = combined.split(/\r?\n/);
    this.remainder = parts.pop() ?? '';

    for (const part of parts) {
      this.appendLine(part);
    }

    if (this.remainder.length > this.maxLineChars * 4) {
      this.appendLine(this.remainder);
      this.remainder = '';
    }
  }

  private appendLine(raw: string): void {
    const cleaned = stripAnsi(raw);
    const truncated = cleaned.length > this.maxLineChars ? cleaned.slice(0, this.maxLineChars) : cleaned;
    this.lines.push(truncated);
    if (this.lines.length > this.maxLines) {
      this.lines.splice(0, this.lines.length - this.maxLines);
    }
  }

  getLines(): string[] {
    const result = [...this.lines];
    if (this.remainder) {
      const cleaned = stripAnsi(this.remainder);
      const truncated = cleaned.length > this.maxLineChars ? cleaned.slice(0, this.maxLineChars) : cleaned;
      result.push(truncated);
      if (result.length > this.maxLines) {
        result.splice(0, result.length - this.maxLines);
      }
    }
    return result;
  }

  clear(): void {
    this.lines = [];
    this.remainder = '';
  }
}

/**
 * Detects whether terminal output indicates quota exhaustion (HTTP 429),
 * filtering out false positives originating from unit test suites and assertions.
 */
export function detectQuotaExhaustion(text: string, adapter: HostAdapter): boolean {
  if (!text || !adapter.quotaExhaustedPatterns || adapter.quotaExhaustedPatterns.length === 0) {
    return false;
  }

  const clean = stripAnsi(text);
  const lines = clean.split(/\r?\n/);

  for (const line of lines) {
    if (TEST_CODE_REGEX.test(line)) {
      continue;
    }
    for (const pattern of adapter.quotaExhaustedPatterns) {
      pattern.lastIndex = 0;
      if (pattern.test(line)) {
        return true;
      }
    }
  }

  return false;
}

export interface WatcherOptions {
  host: HostId;
  initialProfile?: string;
  extraArgs?: string[];
  cwd?: string;
  realHome?: string;
  cooldownMs?: number;
}

/**
 * Constructs an environment dictionary isolated for the given profile and host.
 */
function buildChildEnv(
  host: HostId,
  profileDir: string,
  sessionId: string,
  baseEnv: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(baseEnv)) {
    if (v !== undefined) {
      env[k] = v;
    }
  }

  env.AGENT_RELAY_SESSION_ID = sessionId;
  env.AGENT_RELAY_PROFILE_DIR = profileDir;
  env.AGENT_RELAY_HOST = host;
  env.HOME = profileDir;
  env.USERPROFILE = profileDir;

  if (host === 'claude') {
    env.CLAUDE_CONFIG_DIR = path.join(profileDir, '.claude');
  } else if (host === 'codex') {
    env.CODEX_HOME = path.join(profileDir, '.codex');
  } else if (host === 'opencode') {
    env.XDG_CONFIG_HOME = path.join(profileDir, '.config');
    env.XDG_DATA_HOME = path.join(profileDir, '.local', 'share');
  }

  return env;
}

/**
 * Supervises an interactive PTY session for the selected host CLI,
 * transparently handling profile rotation upon quota exhaustion or manual signal.
 */
export async function runSupervisedSession(options: WatcherOptions): Promise<number> {
  // Dynamically import node-pty to avoid eager native binary loading in tests
  const ptyImport = await import('node-pty');
  const pty = ((ptyImport as Record<string, unknown>).default ?? ptyImport) as typeof import('node-pty');

  const adapter = getAdapter(options.host);
  const cwd = options.cwd ?? process.cwd();
  const cooldownMs = options.cooldownMs ?? SWAP_COOLDOWN_MS;
  const sessionId = `relay-${process.pid}-${Date.now()}`;
  const sessionDir = getRuntimeSessionDir(sessionId, options.realHome);
  enforceDirectorySecurity(sessionDir);

  // Initialize or discover profile status
  let existingProfiles = await listProfiles(options.host, { realHome: options.realHome });
  if (existingProfiles.length === 0) {
    const initialAlias = options.initialProfile ?? 'default';
    const created = await initProfile(options.host, initialAlias, { realHome: options.realHome });
    existingProfiles = [created];
  }

  let activeProfile: ProfileStatus;
  if (options.initialProfile) {
    const matched = existingProfiles.find((p) => p.alias === options.initialProfile);
    activeProfile = matched ?? existingProfiles[0];
  } else {
    activeProfile = existingProfiles.find((p) => p.isActive) ?? existingProfiles[0];
  }

  const lineBuffer = new CircularLineBuffer();
  let recentOutputChunk = '';
  let lastSwapTimestamp = 0;
  let swapRequested = false;
  let swapSummary: string | undefined;
  let pendingIgnitionPrompt: string | null = null;
  let isShuttingDown = false;

  return new Promise<number>((resolve) => {
    let ptyProcess: import('node-pty').IPty;
    let monitorTimer: NodeJS.Timeout | null = null;

    const cleanupTerminal = () => {
      if (monitorTimer) {
        clearInterval(monitorTimer);
        monitorTimer = null;
      }
      if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
        try {
          process.stdin.setRawMode(false);
        } catch {
          // ignore
        }
      }
      process.stdin.pause();
      process.stdin.off('data', onStdinData);
      process.stdout.off('resize', onStdoutResize);
    };

    const onStdinData = (data: Buffer | string) => {
      if (ptyProcess && !swapRequested) {
        ptyProcess.write(typeof data === 'string' ? data : data.toString());
      }
    };

    const onStdoutResize = () => {
      if (ptyProcess) {
        try {
          ptyProcess.resize(process.stdout.columns || 80, process.stdout.rows || 24);
        } catch {
          // ignore
        }
      }
    };

    const triggerProfileSwap = async (reason: string, customSummary?: string) => {
      const now = Date.now();
      if (now - lastSwapTimestamp < cooldownMs) {
        process.stdout.write(
          `\n\r[agent-relay] Swap trigger ignored: cooldown active (${Math.round((cooldownMs - (now - lastSwapTimestamp)) / 1000)}s remaining).\n\r`
        );
        return;
      }

      swapRequested = true;
      lastSwapTimestamp = now;
      swapSummary = customSummary;

      try {
        const handoff = await generateHandoff({
          host: options.host,
          sessionId,
          profileDir: activeProfile.path,
          cwd,
          summary: customSummary ?? reason,
          ptyLines: lineBuffer.getLines(),
          runtimeRoot: sessionDir,
        });

        pendingIgnitionPrompt = handoff.ignitionPrompt;

        // Sync shared changes from active profile before rotation
        await syncProfileSharedFiles(options.host, activeProfile.path, {
          realHome: options.realHome,
          direction: 'from-profile',
        });

        const nextProfile = await getNextProfile(options.host, activeProfile.alias, {
          realHome: options.realHome,
        });

        if (!nextProfile) {
          process.stdout.write(
            `\n\r[agent-relay] No alternative profiles found for host "${options.host}". Continuing current session.\n\r`
          );
          swapRequested = false;
          return;
        }

        activeProfile = nextProfile;
        process.stdout.write(
          `\n\r[agent-relay] Rotating active profile to "${activeProfile.alias}" (${activeProfile.host}). Relaying session state...\n\r`
        );

        // Terminate active child PTY process to cycle into the new profile
        ptyProcess.kill();
      } catch (err) {
        process.stdout.write(
          `\n\r[agent-relay] Error during profile handoff: ${err instanceof Error ? err.message : String(err)}\n\r`
        );
        swapRequested = false;
      }
    };

    const spawnChildPty = async () => {
      // Synchronize shared files to the target profile directory
      await syncProfileSharedFiles(options.host, activeProfile.path, {
        realHome: options.realHome,
        direction: 'to-profile',
      });

      const childEnv = buildChildEnv(options.host, activeProfile.path, sessionId);
      const command = adapter.resolveCommand();
      const args = pendingIgnitionPrompt
        ? adapter.buildIgnitionArgs(pendingIgnitionPrompt, options.extraArgs)
        : (options.extraArgs ? [...options.extraArgs] : []);

      pendingIgnitionPrompt = null;
      swapRequested = false;
      swapSummary = undefined;
      lineBuffer.clear();
      recentOutputChunk = '';

      ptyProcess = pty.spawn(command, args, {
        name: 'xterm-256color',
        cols: process.stdout.columns || 80,
        rows: process.stdout.rows || 24,
        cwd,
        env: childEnv,
      });

      ptyProcess.onData((data: string) => {
        process.stdout.write(data);
        lineBuffer.pushChunk(data);
        recentOutputChunk += data;
        if (recentOutputChunk.length > 8000) {
          recentOutputChunk = recentOutputChunk.slice(-4000);
        }
      });

      ptyProcess.onExit(({ exitCode }) => {
        if (swapRequested) {
          // Restart supervisor with next profile
          setImmediate(() => {
            spawnChildPty().catch((err) => {
              process.stderr.write(`Failed to restart supervised PTY: ${String(err)}\n`);
              cleanupTerminal();
              resolve(1);
            });
          });
          return;
        }

        if (!isShuttingDown) {
          cleanupTerminal();
          resolve(exitCode ?? 0);
        }
      });
    };

    // Configure terminal input mode
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
      try {
        process.stdin.setRawMode(true);
      } catch {
        // ignore
      }
    }
    process.stdin.resume();
    process.stdin.on('data', onStdinData);
    process.stdout.on('resize', onStdoutResize);

    const onSigint = () => {
      isShuttingDown = true;
      cleanupTerminal();
      if (ptyProcess) {
        ptyProcess.kill();
      }
      resolve(130);
    };

    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigint);

    // Periodic watcher checking swap triggers and quota detection
    monitorTimer = setInterval(() => {
      if (swapRequested) return;

      const triggerResult = readAndClearSwapTrigger(sessionId, options.realHome);
      if (triggerResult.triggered) {
        void triggerProfileSwap('Manual profile swap triggered via CLI signal.', triggerResult.summary);
        return;
      }

      if (recentOutputChunk.length > 0 && detectQuotaExhaustion(recentOutputChunk, adapter)) {
        void triggerProfileSwap('Automatic profile swap triggered by quota exhaustion pattern.');
        recentOutputChunk = '';
      }
    }, 400);

    spawnChildPty().catch((err) => {
      process.stderr.write(`Failed to start initial supervised PTY: ${String(err)}\n`);
      cleanupTerminal();
      resolve(1);
    });
  });
}
