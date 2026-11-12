import path from 'node:path';
import type { HostAdapter, HostId, PlanArtifact, SharedItemMapping } from '../types.js';
import { buildBaseProfileEnv, findMarkdownArtifacts, isBinaryInPath } from './common.js';

export class ClaudeAdapter implements HostAdapter {
  readonly id: HostId = 'claude';
  readonly displayName = 'Claude Code';
  readonly binaryName = 'claude';

  readonly quotaExhaustedPatterns: readonly RegExp[] = [
    /rate_limit_error/i,
    /usage\s+limit\s+reached/i,
    /Claude\s+AI\s+usage\s+limit/i,
    /429\s+Too\s+Many\s+Requests/i,
  ];

  detectInstalled(env?: NodeJS.ProcessEnv): boolean {
    return isBinaryInPath(this.binaryName, env);
  }

  getSharedDirectories(): readonly SharedItemMapping[] {
    return [
      {
        sourceRelPath: path.join('.claude', 'skills'),
        targetRelPath: path.join('.claude', 'skills'),
      },
      {
        sourceRelPath: path.join('.claude', 'commands'),
        targetRelPath: path.join('.claude', 'commands'),
      },
      {
        sourceRelPath: path.join('.claude', 'agents'),
        targetRelPath: path.join('.claude', 'agents'),
      },
    ];
  }

  getSharedFiles(): readonly SharedItemMapping[] {
    return [
      {
        sourceRelPath: path.join('.claude', 'settings.json'),
        targetRelPath: path.join('.claude', 'settings.json'),
      },
      {
        sourceRelPath: path.join('.claude', 'CLAUDE.md'),
        targetRelPath: path.join('.claude', 'CLAUDE.md'),
      },
    ];
  }

  getIsolatedAuthFiles(): readonly string[] {
    return [
      '.claude.json',
      path.join('.claude', '.credentials.json'),
    ];
  }

  getSkillInstallTargets(realHome: string): readonly string[] {
    return [
      path.join(realHome, '.claude', 'skills', 'agent-relay', 'SKILL.md'),
    ];
  }

  buildProfileEnv(
    profileDir: string,
    sessionId: string,
    baseEnv?: NodeJS.ProcessEnv,
  ): NodeJS.ProcessEnv {
    const env = buildBaseProfileEnv(profileDir, sessionId, this.id, baseEnv);
    env.CLAUDE_CONFIG_DIR = path.join(profileDir, '.claude');
    return env;
  }

  async findLatestPlanArtifacts(profileDir: string, cwd: string): Promise<PlanArtifact[]> {
    const profilePlansDir = path.join(profileDir, '.claude', 'plans');
    const cwdPlansDir = path.join(cwd, '.claude', 'plans');

    const [profileArtifacts, cwdArtifacts] = await Promise.all([
      findMarkdownArtifacts(profilePlansDir, 1),
      findMarkdownArtifacts(cwdPlansDir, 1),
    ]);

    const combined = [...profileArtifacts, ...cwdArtifacts];
    // Deduplicate by path
    const seen = new Set<string>();
    const unique: PlanArtifact[] = [];

    for (const artifact of combined) {
      if (!seen.has(artifact.path)) {
        seen.add(artifact.path);
        unique.push(artifact);
      }
    }

    unique.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return unique;
  }

  buildIgnitionArgs(ignitionPrompt: string, extraArgs?: readonly string[]): string[] {
    return [...(extraArgs ?? []), ignitionPrompt];
  }
}

export const claudeAdapter = new ClaudeAdapter();
