import path from 'node:path';
import type { HostAdapter, HostId, PlanArtifact, SharedItemMapping } from '../types.js';
import { buildBaseProfileEnv, findMarkdownArtifacts, isBinaryInPath } from './common.js';

export class CodexAdapter implements HostAdapter {
  readonly id: HostId = 'codex';
  readonly displayName = 'OpenAI Codex CLI';
  readonly binaryName = 'codex';

  readonly quotaExhaustedPatterns: readonly RegExp[] = [
    /rate_limit_exceeded/i,
    /insufficient_quota/i,
    /You\s+exceeded\s+your\s+current\s+quota/i,
    /429\s+Too\s+Many\s+Requests/i,
  ];

  detectInstalled(env?: NodeJS.ProcessEnv): boolean {
    return isBinaryInPath(this.binaryName, env);
  }

  getSharedDirectories(): readonly SharedItemMapping[] {
    return [
      {
        sourceRelPath: path.join('.codex', 'skills'),
        targetRelPath: path.join('.codex', 'skills'),
      },
      {
        sourceRelPath: path.join('.codex', 'agents'),
        targetRelPath: path.join('.codex', 'agents'),
      },
    ];
  }

  getSharedFiles(): readonly SharedItemMapping[] {
    return [
      {
        sourceRelPath: path.join('.codex', 'config.toml'),
        targetRelPath: path.join('.codex', 'config.toml'),
      },
      {
        sourceRelPath: path.join('.codex', 'AGENTS.md'),
        targetRelPath: path.join('.codex', 'AGENTS.md'),
      },
    ];
  }

  getIsolatedAuthFiles(): readonly string[] {
    return [path.join('.codex', 'auth.json')];
  }

  getSkillInstallTargets(realHome: string): readonly string[] {
    return [
      path.join(realHome, '.codex', 'skills', 'agent-relay', 'SKILL.md'),
    ];
  }

  buildProfileEnv(
    profileDir: string,
    sessionId: string,
    baseEnv?: NodeJS.ProcessEnv,
  ): NodeJS.ProcessEnv {
    const env = buildBaseProfileEnv(profileDir, sessionId, this.id, baseEnv);
    env.CODEX_HOME = path.join(profileDir, '.codex');
    return env;
  }

  async findLatestPlanArtifacts(profileDir: string, _cwd: string): Promise<PlanArtifact[]> {
    const sessionsDir = path.join(profileDir, '.codex', 'sessions');
    return findMarkdownArtifacts(sessionsDir, 2);
  }

  buildIgnitionArgs(ignitionPrompt: string, extraArgs?: readonly string[]): string[] {
    return [...(extraArgs ?? []), ignitionPrompt];
  }
}

export const codexAdapter = new CodexAdapter();
