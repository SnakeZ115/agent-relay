import path from 'node:path';
import type { HostAdapter, HostId } from '../types.js';
import { AntigravityAdapter, antigravityAdapter } from './antigravity.js';
import { ClaudeAdapter, claudeAdapter } from './claude.js';
import { CodexAdapter, codexAdapter } from './codex.js';
import { OpenCodeAdapter, opencodeAdapter } from './opencode.js';

export {
  AntigravityAdapter,
  antigravityAdapter,
  ClaudeAdapter,
  claudeAdapter,
  CodexAdapter,
  codexAdapter,
  OpenCodeAdapter,
  opencodeAdapter,
};

const adapters: Record<HostId, HostAdapter> = {
  antigravity: antigravityAdapter,
  claude: claudeAdapter,
  codex: codexAdapter,
  opencode: opencodeAdapter,
};

export function getAdapter(host: HostId): HostAdapter {
  const adapter = adapters[host];
  if (!adapter) {
    throw new Error(`Unsupported host: "${host}"`);
  }
  return adapter;
}

export function getAllAdapters(): readonly HostAdapter[] {
  return [
    antigravityAdapter,
    claudeAdapter,
    codexAdapter,
    opencodeAdapter,
  ];
}

export function resolveHostId(input?: string, invokedBinName?: string): HostId {
  if (input) {
    const normalized = input.trim().toLowerCase();
    if (normalized === 'antigravity' || normalized === 'agy') {
      return 'antigravity';
    }
    if (normalized === 'claude' || normalized === 'cl') {
      return 'claude';
    }
    if (normalized === 'codex' || normalized === 'cx') {
      return 'codex';
    }
    if (normalized === 'opencode' || normalized === 'oc') {
      return 'opencode';
    }
  }

  if (invokedBinName) {
    const bin = path.basename(invokedBinName).toLowerCase().replace(/\.(exe|cmd|bat|ps1|js)$/i, '');
    if (bin === 'agy-switch' || bin === 'antigravity' || bin === 'agy') {
      return 'antigravity';
    }
    if (bin === 'claude-switch' || bin === 'claude') {
      return 'claude';
    }
    if (bin === 'codex-switch' || bin === 'codex') {
      return 'codex';
    }
    if (bin === 'opencode-switch' || bin === 'opencode') {
      return 'opencode';
    }
  }

  if (process.env.AGENT_RELAY_HOST) {
    const envHost = process.env.AGENT_RELAY_HOST.trim().toLowerCase();
    if (
      envHost === 'antigravity' ||
      envHost === 'claude' ||
      envHost === 'codex' ||
      envHost === 'opencode'
    ) {
      return envHost as HostId;
    }
  }

  return 'antigravity';
}
