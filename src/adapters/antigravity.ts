import fs from 'node:fs';
import path from 'node:path';
import type { HostAdapter, HostId, PlanArtifact, SharedItemMapping } from '../types.js';
import { buildBaseProfileEnv, findMarkdownArtifacts, isBinaryInPath } from './common.js';

export class AntigravityAdapter implements HostAdapter {
  readonly id: HostId = 'antigravity';
  readonly displayName = 'Antigravity CLI (agy)';
  readonly binaryName = 'agy';

  readonly quotaExhaustedPatterns: readonly RegExp[] = [
    /RESOURCE_EXHAUSTED/i,
    /Quota exceeded for quota metric/i,
    /GoogleGenerativeAIError.*quota/i,
    /429\s+Too\s+Many\s+Requests/i,
    /rate\s+limit\s+exceeded.*quota/i,
  ];

  detectInstalled(env?: NodeJS.ProcessEnv): boolean {
    return isBinaryInPath(this.binaryName, env);
  }

  getSharedDirectories(): readonly SharedItemMapping[] {
    return [
      {
        sourceRelPath: path.join('.gemini', 'config'),
        targetRelPath: path.join('.gemini', 'config'),
      },
    ];
  }

  getSharedFiles(): readonly SharedItemMapping[] {
    return [
      {
        sourceRelPath: path.join('.gemini', 'antigravity-cli', 'settings.json'),
        targetRelPath: path.join('.gemini', 'antigravity-cli', 'settings.json'),
      },
      {
        sourceRelPath: path.join('.gemini', 'GEMINI.md'),
        targetRelPath: path.join('.gemini', 'GEMINI.md'),
      },
    ];
  }

  getIsolatedAuthFiles(): readonly string[] {
    return [path.join('.gemini', 'antigravity-cli', 'jetski_state.pbtxt')];
  }

  getSkillInstallTargets(realHome: string): readonly string[] {
    return [
      path.join(
        realHome,
        '.gemini',
        'config',
        'plugins',
        'agent-relay',
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
    return buildBaseProfileEnv(profileDir, sessionId, this.id, baseEnv);
  }

  async findLatestPlanArtifacts(profileDir: string, _cwd: string): Promise<PlanArtifact[]> {
    const brainDir = path.join(profileDir, '.gemini', 'antigravity-cli', 'brain');
    if (!fs.existsSync(brainDir)) {
      return [];
    }

    let subdirs: { path: string; mtimeMs: number }[] = [];
    try {
      const entries = fs.readdirSync(brainDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const dirPath = path.join(brainDir, entry.name);
          const stat = fs.statSync(dirPath);
          subdirs.push({ path: dirPath, mtimeMs: stat.mtimeMs });
        }
      }
    } catch {
      return [];
    }

    subdirs.sort((a, b) => b.mtimeMs - a.mtimeMs);

    if (subdirs.length === 0) {
      return findMarkdownArtifacts(brainDir, 1);
    }

    const latestDir = subdirs[0].path;
    const artifacts = await findMarkdownArtifacts(latestDir, 1);

    artifacts.sort((a, b) => {
      const aPrio = a.name === 'implementation_plan.md' ? 2 : a.name === 'task.md' ? 1 : 0;
      const bPrio = b.name === 'implementation_plan.md' ? 2 : b.name === 'task.md' ? 1 : 0;
      if (aPrio !== bPrio) {
        return bPrio - aPrio;
      }
      return b.mtimeMs - a.mtimeMs;
    });

    return artifacts;
  }

  buildIgnitionArgs(ignitionPrompt: string, extraArgs?: readonly string[]): string[] {
    return ['-i', ignitionPrompt, ...(extraArgs ?? [])];
  }
}

export const antigravityAdapter = new AntigravityAdapter();
