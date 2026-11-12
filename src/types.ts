export type HostId = 'antigravity' | 'claude' | 'codex' | 'opencode';

export const SUPPORTED_HOSTS: readonly HostId[] = [
  'antigravity',
  'claude',
  'codex',
  'opencode',
] as const;

export interface SharedItemMapping {
  sourceRelPath: string;
  targetRelPath: string;
}

export interface PlanArtifact {
  name: string;
  path: string;
  content: string;
  mtimeMs: number;
}

export interface HostAdapter {
  readonly id: HostId;
  readonly displayName: string;
  readonly binaryName: string;
  readonly quotaExhaustedPatterns: readonly RegExp[];
  detectInstalled(env?: NodeJS.ProcessEnv): boolean;
  getSharedDirectories(): readonly SharedItemMapping[];
  getSharedFiles(): readonly SharedItemMapping[];
  getIsolatedAuthFiles(): readonly string[];
  getSkillInstallTargets(realHome: string): readonly string[];
  buildProfileEnv(
    profileDir: string,
    sessionId: string,
    baseEnv?: NodeJS.ProcessEnv,
  ): NodeJS.ProcessEnv;
  findLatestPlanArtifacts(profileDir: string, cwd: string): Promise<PlanArtifact[]>;
  buildIgnitionArgs(ignitionPrompt: string, extraArgs?: readonly string[]): string[];
}

export interface LinkStatus {
  targetRelPath: string;
  kind: 'directory-link' | 'hardlink' | 'synced-copy' | 'missing';
  valid: boolean;
}

export interface ProfileStatus {
  name: string;
  host: HostId;
  path: string;
  isDefault: boolean;
  authenticated: boolean;
  links: LinkStatus[];
  syncedStorageWarning: boolean;
}

export interface HandoffOptions {
  host: HostId;
  profileName?: string;
  profileDir: string;
  sessionId: string;
  cwd: string;
  summary?: string;
  ptyLines?: readonly string[];
  runtimeRoot?: string;
}

export interface HandoffResult {
  handoffPath: string;
  sessionId: string;
  nonce: string;
  content: string;
  ignitionPrompt: string;
  bytesWritten: number;
}
