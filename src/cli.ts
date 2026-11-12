#!/usr/bin/env node

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HostId } from './types.js';
import { SUPPORTED_HOSTS } from './types.js';
import { resolveHostId } from './adapters/index.js';
import {
  getAgentRelayRoot,
  initProfile,
  installGlobalSkill,
  listProfiles,
} from './profiles.js';
import { generateHandoff, writeSwapTrigger } from './handoff.js';
import { runSupervisedSession } from './watcher.js';

const VERSION = '0.1.0';

/**
 * Displays command-line help documentation.
 */
function printHelp(): void {
  console.log(`
agent-relay - Multi-host session relay and account switcher

USAGE:
  agent-relay [run] [profile] [--host <agy|claude|codex|opencode>] [-- <extra-args>]
  agent-relay init <alias> [--host <host>] [--no-launch] [--json]
  agent-relay status [--host <host|all>] [--json]
  agent-relay handoff [--summary "<text>"] [--trigger-swap] [--session <id>] [--host <host>] [--json]
  agent-relay install-skill [--silent] [--json]
  agent-relay --help / -h
  agent-relay --version / -v

SUPPORTED HOSTS:
  agy         Antigravity CLI (default)
  claude      Claude Code
  codex       OpenAI Codex CLI
  opencode    OpenCode CLI

ALIASES:
  agy-switch    Runs agent-relay with default host 'agy'
  claude-switch Runs agent-relay with default host 'claude'
`);
}

/**
 * Parses raw CLI arguments into a structured command representation.
 */
interface ParsedArgs {
  command?: string;
  positional: string[];
  flags: Record<string, string | boolean>;
  extraArgs: string[];
}

function parseArguments(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  const extraArgs: string[] = [];

  let isExtra = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (isExtra) {
      extraArgs.push(arg);
      continue;
    }
    if (arg === '--') {
      isExtra = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (key.includes('=')) {
        const [k, v] = key.split('=', 2);
        flags[k] = v;
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
        flags[key] = argv[++i];
      } else {
        flags[key] = true;
      }
    } else if (arg.startsWith('-')) {
      const key = arg.slice(1);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
        flags[key] = argv[++i];
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  const knownCommands = ['init', 'status', 'handoff', 'install-skill', 'run'];
  let command: string | undefined;

  if (positional.length > 0 && knownCommands.includes(positional[0])) {
    command = positional.shift();
  }

  return { command, positional, flags, extraArgs };
}

/**
 * Finds the most recent runtime session ID from disk if not explicitly passed.
 */
function findLatestSessionId(realHome?: string): string | null {
  const runtimeDir = path.join(getAgentRelayRoot(realHome), '.runtime');
  if (!fs.existsSync(runtimeDir)) return null;

  try {
    const entries = fs.readdirSync(runtimeDir, { withFileTypes: true });
    const sessionDirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => {
        const fullPath = path.join(runtimeDir, e.name);
        return { name: e.name, mtime: fs.statSync(fullPath).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);

    return sessionDirs[0]?.name ?? null;
  } catch {
    return null;
  }
}

/**
 * Main CLI execution entry point.
 */
export async function runCli(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const parsed = parseArguments(argv);
  const jsonOutput = Boolean(parsed.flags.json);
  const realHome = typeof parsed.flags['real-home'] === 'string' ? parsed.flags['real-home'] : undefined;

  if (parsed.flags.help || parsed.flags.h) {
    printHelp();
    return 0;
  }

  if (parsed.flags.version || parsed.flags.v) {
    console.log(VERSION);
    return 0;
  }

  const hostFlag = typeof parsed.flags.host === 'string' ? parsed.flags.host : undefined;
  const invokedBin = process.argv[1];

  switch (parsed.command) {
    case 'init': {
      const alias = parsed.positional[0];
      if (!alias) {
        if (jsonOutput) {
          console.error(JSON.stringify({ error: 'Missing required profile alias argument.' }));
        } else {
          console.error('Error: Profile alias is required. Usage: agent-relay init <alias> [--host <host>]');
        }
        return 1;
      }

      const host = resolveHostId(hostFlag, invokedBin);
      const profile = await initProfile(host, alias, { realHome });

      if (jsonOutput) {
        console.log(JSON.stringify({ success: true, profile }, null, 2));
      } else {
        console.log(`[agent-relay] Profile "${alias}" successfully initialized for "${host}".`);
        console.log(`  Path: ${profile.path}`);
      }

      if (!parsed.flags['no-launch']) {
        if (!jsonOutput) {
          console.log(`[agent-relay] Launching supervised session on profile "${alias}"...`);
        }
        return await runSupervisedSession({
          host,
          initialProfile: alias,
          extraArgs: parsed.extraArgs,
          realHome,
        });
      }
      return 0;
    }

    case 'status': {
      const targetHost = hostFlag ?? 'all';
      const hostsToQuery: readonly HostId[] =
        targetHost === 'all'
          ? SUPPORTED_HOSTS
          : [resolveHostId(targetHost, invokedBin)];

      const results: Record<string, Awaited<ReturnType<typeof listProfiles>>> = {};
      for (const h of hostsToQuery) {
        results[h] = await listProfiles(h, { realHome });
      }

      if (jsonOutput) {
        console.log(JSON.stringify(results, null, 2));
        return 0;
      }

      console.log('AGENT-RELAY PROFILE STATUS');
      console.log('==========================');
      for (const [h, list] of Object.entries(results)) {
        console.log(`\nHost: ${h}`);
        if (list.length === 0) {
          console.log('  (no profiles configured)');
          continue;
        }
        for (const prof of list) {
          const activeMarker = prof.isActive ? '* ' : '  ';
          const authMarker = prof.authConfigExists ? '[auth: ok]' : '[auth: missing]';
          console.log(`${activeMarker}${prof.alias.padEnd(16)} ${authMarker.padEnd(16)} ${prof.path}`);
        }
      }
      return 0;
    }

    case 'handoff': {
      const summary = typeof parsed.flags.summary === 'string' ? parsed.flags.summary : undefined;
      const triggerSwap = Boolean(parsed.flags['trigger-swap']);
      const sessionFlag = typeof parsed.flags.session === 'string' ? parsed.flags.session : undefined;
      const sessionId = sessionFlag ?? env.AGENT_RELAY_SESSION_ID ?? findLatestSessionId(realHome);

      if (triggerSwap) {
        if (!sessionId) {
          const errorMsg = 'No active session found to signal swap. Ensure a supervised session is running.';
          if (jsonOutput) {
            console.error(JSON.stringify({ error: errorMsg }));
          } else {
            console.error(`Error: ${errorMsg}`);
          }
          return 1;
        }

        const triggerPath = writeSwapTrigger(sessionId, summary, realHome);
        if (jsonOutput) {
          console.log(JSON.stringify({ success: true, triggered: true, sessionId, triggerPath, summary }, null, 2));
        } else {
          console.log(`[agent-relay] Profile swap signal dispatched for session "${sessionId}".`);
        }
        return 0;
      }

      // Generate manual handoff
      const host = resolveHostId(hostFlag, invokedBin);
      const resolvedSessionId = sessionId ?? `manual-${Date.now()}`;
      const profiles = await listProfiles(host, { realHome });
      const profileDir = profiles[0]?.path ?? getAgentRelayRoot(realHome);

      const result = await generateHandoff({
        host,
        sessionId: resolvedSessionId,
        profileDir,
        cwd: process.cwd(),
        summary,
      });

      if (jsonOutput) {
        console.log(JSON.stringify({ success: true, result }, null, 2));
      } else {
        console.log(`[agent-relay] Context handoff generated at:`);
        console.log(`  ${result.handoffPath} (${result.bytesWritten} bytes)`);
      }
      return 0;
    }

    case 'install-skill': {
      const silent = Boolean(parsed.flags.silent);
      const result = await installGlobalSkill({
        realHome,
        silent,
      });

      if (jsonOutput) {
        console.log(JSON.stringify({ success: true, installedPaths: result.installedPaths }, null, 2));
      } else if (!silent) {
        console.log('[agent-relay] Agent skill installed successfully at:');
        for (const p of result.installedPaths) {
          console.log(`  - ${p}`);
        }
      }
      return 0;
    }

    case 'run':
    default: {
      const host = resolveHostId(hostFlag, invokedBin);
      const initialProfile = parsed.positional[0];
      const cooldownMs =
        typeof parsed.flags.cooldown === 'string' ? Number(parsed.flags.cooldown) : undefined;

      return await runSupervisedSession({
        host,
        initialProfile,
        extraArgs: parsed.extraArgs,
        realHome,
        cooldownMs,
      });
    }
  }
}

/**
 * Checks whether the module is being directly executed from the command line.
 */
function isDirectExecution(): boolean {
  if (!process.argv[1]) return false;
  try {
    const currentFilePath = fileURLToPath(import.meta.url).toLowerCase();
    const invokedPath = path.resolve(process.argv[1]).toLowerCase();

    if (currentFilePath === invokedPath) return true;

    // Detect wrapper binary executions (agent-relay, agy-switch, claude-switch)
    const normalizedInvoked = invokedPath.replace(/\\/g, '/');
    if (
      normalizedInvoked.endsWith('/dist/cli.js') ||
      normalizedInvoked.endsWith('/src/cli.ts') ||
      normalizedInvoked.endsWith('/bin/agent-relay') ||
      normalizedInvoked.endsWith('/bin/agy-switch') ||
      normalizedInvoked.endsWith('/bin/claude-switch')
    ) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  runCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  );
}
