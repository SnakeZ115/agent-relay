import path from 'node:path';
import type { HostAdapter, HostId, PlanArtifact, SharedItemMapping } from '../types.js';
import { buildBaseProfileEnv, findMarkdownArtifacts, isBinaryInPath } from './common.js';

export class OpenCodeAdapter implements HostAdapter {
  readonly id: HostId = 'opencode';
  readonly displayName = 'OpenCode CLI';
  readonly binaryName = 'opencode';

  readonly quotaExhaustedPatterns: readonly RegExp[] = [
    /rate_limit_exceeded/i,
    /quota\s+exceeded/i,
    /429\s+Too\s+Many\s+Requests/i,
  ];

  detectInstalled(env?: NodeJS.ProcessEnv): boolean {
    return isBinaryInPath(this.binaryName, env);
  }

  getSharedDirectories(): readonly SharedItemMapping[] {
    return [
      {
        sourceRelPath: path.join('.config', 'opencode', 'skills'),
        targetRelPath: path.join('.config', 'opencode', 'skills'),
      },
      {
        sourceRelPath: path.join('.config', 'opencode', 'agents'),
        targetRelPath: path.join('.config', 'opencode', 'agents'),
      },
    ];
  }

  getSharedFiles(): readonly SharedItemMapping[] {
    return [
      {
        sourceRelPath: path.join('.config', 'opencode', 'cli.json'),
        targetRelPath: path.join('.config', 'opencode', 'cli.json'),
      },
      {
        sourceRelPath: path.join('.config', 'opencode', 'opencode.json'),
        targetRelPath: path.join('.config', 'opencode', 'opencode.json'),
      },
      {
        sourceRelPath: path.join('.config', 'opencode', 'AGENTS.md'),
        targetRelPath: path.join('.config', 'opencode', 'AGENTS.md'),
      },
    ];
  }

  getIsolatedAuthFiles(): readonly string[] {
    return [
      path.join('.local', 'share', 'opencode', 'auth.json'),
      path.join('.local', 'share', 'opencode', 'opencode.db'),
    ];
  }

  getSkillInstallTargets(realHome: string): readonly string[] {
    return [
      path.join(
        realHome,
        '.config',
        'opencode',
        'skills',
        'agent-relay',
        'SKILL.md',
      ),
    ];
  }

  buildProfileEnv(
    profileDir: string,
    sessionId: string,
    baseEnv?: NodeJS.ProcessEnv,
  ): NodeJS.ProcessEnv {
    const env = buildBaseProfileEnv(profileDir, sessionId, this.id, baseEnv);
    env.XDG_CONFIG_HOME = path.join(profileDir, '.config');
    env.XDG_DATA_HOME = path.join(profileDir, '.local', 'share');
    return env;
  }

  async findLatestPlanArtifacts(profileDir: string, _cwd: string): Promise<PlanArtifact[]> {
    const dataDir = path.join(profileDir, '.local', 'share', 'opencode');
    return findMarkdownArtifacts(dataDir, 2);
  }

  buildIgnitionArgs(ignitionPrompt: string, extraArgs?: readonly string[]): string[] {
    return ['--prompt', ignitionPrompt, ...(extraArgs ?? [])];
  }
}

export const opencodeAdapter = new OpenCodeAdapter();
