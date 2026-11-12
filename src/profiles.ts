import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAdapter } from './adapters/index.js';
import {
  atomicWriteRestricted,
  enforceDirectorySecurity,
  isCloudSyncedPath,
  sha256File,
} from './security.js';
import type { HostId, LinkStatus, ProfileStatus } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_SKILL_CONTENT = `---
name: agent-relay
description: Multi-host session relay and profile switcher for Antigravity, Claude Code, Codex, and OpenCode.
---

# Agent Relay Skill

This skill allows AI coding assistants to inspect available profiles, trigger session handoffs, and safely rotate credentials when quota or rate limits are reached.

## Commands & Capabilities
- Inspect profile states and switch active accounts.
- Export and import handoff bundles between hosts.
- Supervise interactive sessions with auto-recovery.
`;

export function getAgentRelayRoot(realHome?: string): string {
  const home = realHome || os.homedir();
  return path.join(home, '.agent-relay');
}

export function getRuntimeSessionDir(sessionId: string, realHome?: string): string {
  return path.join(getAgentRelayRoot(realHome), 'runtime', sessionId);
}

export function getProfilesHostDir(host: HostId, realHome?: string): string {
  return path.join(getAgentRelayRoot(realHome), 'profiles', host);
}

export async function initProfile(
  host: HostId,
  alias: string,
  options?: { realHome?: string },
): Promise<ProfileStatus> {
  if (!alias || !/^[a-zA-Z0-9_-]+$/.test(alias)) {
    throw new Error(
      `Invalid profile alias "${alias}". Alias must only contain alphanumeric characters, underscores, and hyphens.`,
    );
  }

  if (alias.toLowerCase() === 'default') {
    throw new Error(
      'Profile alias cannot be "default". "default" is reserved for the primary user environment.',
    );
  }

  const home = options?.realHome || os.homedir();
  const profileDir = path.join(getProfilesHostDir(host, home), alias);
  enforceDirectorySecurity(profileDir);

  const adapter = getAdapter(host);
  const links: LinkStatus[] = [];

  // 1. Link shared directories (junction on Windows, symlink on POSIX)
  for (const mapping of adapter.getSharedDirectories()) {
    const sourcePath = path.resolve(home, mapping.sourceRelPath);
    const targetPath = path.resolve(profileDir, mapping.targetRelPath);

    if (!fs.existsSync(sourcePath)) {
      enforceDirectorySecurity(sourcePath);
    }
    enforceDirectorySecurity(path.dirname(targetPath));

    let valid = false;
    try {
      if (fs.existsSync(targetPath)) {
        const stat = fs.lstatSync(targetPath);
        if (stat.isSymbolicLink()) {
          valid = true;
        }
      } else {
        fs.symlinkSync(
          sourcePath,
          targetPath,
          process.platform === 'win32' ? 'junction' : 'dir',
        );
        valid = true;
      }
    } catch {
      valid = false;
    }

    links.push({
      targetRelPath: mapping.targetRelPath,
      kind: 'directory-link',
      valid,
    });
  }

  // 2. Link shared files (hardlink first, copy fallback)
  for (const mapping of adapter.getSharedFiles()) {
    const sourcePath = path.resolve(home, mapping.sourceRelPath);
    const targetPath = path.resolve(profileDir, mapping.targetRelPath);
    let kind: 'hardlink' | 'synced-copy' | 'missing' = 'missing';
    let valid = false;

    if (fs.existsSync(sourcePath)) {
      enforceDirectorySecurity(path.dirname(targetPath));

      if (fs.existsSync(targetPath)) {
        try {
          const sStat = fs.statSync(sourcePath);
          const tStat = fs.statSync(targetPath);
          if (sStat.ino === tStat.ino && sStat.dev === tStat.dev) {
            kind = 'hardlink';
            valid = true;
          } else {
            kind = 'synced-copy';
            valid = sha256File(sourcePath) === sha256File(targetPath);
          }
        } catch {
          valid = false;
        }
      } else {
        try {
          fs.linkSync(sourcePath, targetPath);
          kind = 'hardlink';
          valid = true;
        } catch {
          try {
            fs.copyFileSync(sourcePath, targetPath);
            kind = 'synced-copy';
            valid = true;
          } catch {
            kind = 'missing';
            valid = false;
          }
        }
      }
    }

    links.push({
      targetRelPath: mapping.targetRelPath,
      kind,
      valid,
    });
  }

  // 3. Check authentication status
  let authenticated = false;
  for (const authRelPath of adapter.getIsolatedAuthFiles()) {
    const authPath = path.resolve(profileDir, authRelPath);
    try {
      if (fs.existsSync(authPath) && fs.statSync(authPath).size > 0) {
        authenticated = true;
        break;
      }
    } catch {
      // Inaccessible
    }
  }

  return {
    name: alias,
    host,
    path: profileDir,
    isDefault: false,
    authenticated,
    links,
    syncedStorageWarning: isCloudSyncedPath(profileDir),
  };
}

export async function syncProfileSharedFiles(
  host: HostId,
  profileDir: string,
  options?: {
    realHome?: string;
    direction?: 'to-profile' | 'from-profile' | 'bidirectional';
  },
): Promise<void> {
  const home = options?.realHome || os.homedir();
  const direction = options?.direction || 'bidirectional';
  const adapter = getAdapter(host);

  for (const mapping of adapter.getSharedFiles()) {
    const sourcePath = path.resolve(home, mapping.sourceRelPath);
    const targetPath = path.resolve(profileDir, mapping.targetRelPath);

    const sourceExists = fs.existsSync(sourcePath);
    const targetExists = fs.existsSync(targetPath);

    if (sourceExists && targetExists) {
      try {
        const sStat = fs.statSync(sourcePath);
        const tStat = fs.statSync(targetPath);

        // If hardlink is intact, no copy is necessary
        if (sStat.ino === tStat.ino && sStat.dev === tStat.dev) {
          continue;
        }

        const sHash = sha256File(sourcePath);
        const tHash = sha256File(targetPath);

        if (sHash === tHash) {
          continue;
        }

        if (direction === 'to-profile') {
          enforceDirectorySecurity(path.dirname(targetPath));
          atomicWriteRestricted(targetPath, fs.readFileSync(sourcePath, 'utf8'));
        } else if (direction === 'from-profile') {
          enforceDirectorySecurity(path.dirname(sourcePath));
          atomicWriteRestricted(sourcePath, fs.readFileSync(targetPath, 'utf8'));
        } else {
          // Bidirectional: newer file overwrites older file
          if (tStat.mtimeMs > sStat.mtimeMs) {
            enforceDirectorySecurity(path.dirname(sourcePath));
            atomicWriteRestricted(sourcePath, fs.readFileSync(targetPath, 'utf8'));
          } else {
            enforceDirectorySecurity(path.dirname(targetPath));
            atomicWriteRestricted(targetPath, fs.readFileSync(sourcePath, 'utf8'));
          }
        }
      } catch {
        // Skip unreadable files
      }
    } else if (sourceExists && !targetExists) {
      if (direction === 'to-profile' || direction === 'bidirectional') {
        try {
          enforceDirectorySecurity(path.dirname(targetPath));
          atomicWriteRestricted(targetPath, fs.readFileSync(sourcePath, 'utf8'));
        } catch {
          // Skip write failures
        }
      }
    } else if (!sourceExists && targetExists) {
      if (direction === 'from-profile' || direction === 'bidirectional') {
        try {
          enforceDirectorySecurity(path.dirname(sourcePath));
          atomicWriteRestricted(sourcePath, fs.readFileSync(targetPath, 'utf8'));
        } catch {
          // Skip write failures
        }
      }
    }
  }
}

export async function listProfiles(
  host: HostId,
  options?: { realHome?: string },
): Promise<ProfileStatus[]> {
  const home = options?.realHome || os.homedir();
  const adapter = getAdapter(host);

  // Check default profile authentication in realHome
  let defaultAuth = false;
  for (const authRelPath of adapter.getIsolatedAuthFiles()) {
    const authPath = path.resolve(home, authRelPath);
    try {
      if (fs.existsSync(authPath) && fs.statSync(authPath).size > 0) {
        defaultAuth = true;
        break;
      }
    } catch {
      // Inaccessible
    }
  }

  const defaultProfile: ProfileStatus = {
    name: 'default',
    host,
    path: home,
    isDefault: true,
    authenticated: defaultAuth,
    links: [],
    syncedStorageWarning: isCloudSyncedPath(home),
  };

  const results: ProfileStatus[] = [defaultProfile];
  const hostDir = getProfilesHostDir(host, home);

  if (!fs.existsSync(hostDir)) {
    return results;
  }

  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(hostDir, { withFileTypes: true });
  } catch {
    return results;
  }

  const dirNames = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));

  for (const dirName of dirNames) {
    const profilePath = path.join(hostDir, dirName);
    const links: LinkStatus[] = [];

    for (const mapping of adapter.getSharedDirectories()) {
      const targetPath = path.resolve(profilePath, mapping.targetRelPath);
      let valid = false;
      try {
        if (fs.existsSync(targetPath)) {
          const stat = fs.lstatSync(targetPath);
          valid = stat.isSymbolicLink();
        }
      } catch {
        valid = false;
      }

      links.push({
        targetRelPath: mapping.targetRelPath,
        kind: 'directory-link',
        valid,
      });
    }

    for (const mapping of adapter.getSharedFiles()) {
      const sourcePath = path.resolve(home, mapping.sourceRelPath);
      const targetPath = path.resolve(profilePath, mapping.targetRelPath);
      let kind: 'hardlink' | 'synced-copy' | 'missing' = 'missing';
      let valid = false;

      if (fs.existsSync(targetPath)) {
        try {
          if (fs.existsSync(sourcePath)) {
            const sStat = fs.statSync(sourcePath);
            const tStat = fs.statSync(targetPath);
            if (sStat.ino === tStat.ino && sStat.dev === tStat.dev) {
              kind = 'hardlink';
              valid = true;
            } else {
              kind = 'synced-copy';
              valid = sha256File(sourcePath) === sha256File(targetPath);
            }
          } else {
            kind = 'synced-copy';
            valid = true;
          }
        } catch {
          valid = false;
        }
      }

      links.push({
        targetRelPath: mapping.targetRelPath,
        kind,
        valid,
      });
    }

    let authenticated = false;
    for (const authRelPath of adapter.getIsolatedAuthFiles()) {
      const authPath = path.resolve(profilePath, authRelPath);
      try {
        if (fs.existsSync(authPath) && fs.statSync(authPath).size > 0) {
          authenticated = true;
          break;
        }
      } catch {
        // Inaccessible
      }
    }

    results.push({
      name: dirName,
      host,
      path: profilePath,
      isDefault: false,
      authenticated,
      links,
      syncedStorageWarning: isCloudSyncedPath(profilePath),
    });
  }

  return results;
}

export async function getNextProfile(
  host: HostId,
  currentProfile: string,
  options?: { realHome?: string },
): Promise<ProfileStatus | null> {
  const profiles = await listProfiles(host, options);
  if (profiles.length <= 1) {
    return null;
  }

  const currentIndex = profiles.findIndex((p) => p.name === currentProfile);
  if (currentIndex === -1) {
    return profiles[0];
  }

  const nextIndex = (currentIndex + 1) % profiles.length;
  return profiles[nextIndex];
}

export async function installGlobalSkill(
  options?: {
    realHome?: string;
    skillSourcePath?: string;
    silent?: boolean;
  },
): Promise<{ installedPaths: string[] }> {
  const home = options?.realHome || os.homedir();
  const installedPaths: string[] = [];

  let skillContent = DEFAULT_SKILL_CONTENT;

  if (options?.skillSourcePath && fs.existsSync(options.skillSourcePath)) {
    try {
      skillContent = fs.readFileSync(options.skillSourcePath, 'utf8');
    } catch {
      // Fallback to default content
    }
  } else {
    const candidatePaths = [
      path.resolve(__dirname, 'skills', 'SKILL.md'),
      path.resolve(__dirname, '..', 'src', 'skills', 'SKILL.md'),
      path.resolve(process.cwd(), 'src', 'skills', 'SKILL.md'),
    ];

    for (const candidate of candidatePaths) {
      if (fs.existsSync(candidate)) {
        try {
          skillContent = fs.readFileSync(candidate, 'utf8');
          break;
        } catch {
          // Try next candidate
        }
      }
    }
  }

  // 1. Antigravity: always install
  const antigravityTargets = getAdapter('antigravity').getSkillInstallTargets(home);
  for (const target of antigravityTargets) {
    try {
      enforceDirectorySecurity(path.dirname(target));
      atomicWriteRestricted(target, skillContent);
      installedPaths.push(target);
    } catch {
      // Skip if inaccessible
    }
  }

  // 2. Claude: if ~/.claude directory exists
  if (fs.existsSync(path.join(home, '.claude'))) {
    const claudeTargets = getAdapter('claude').getSkillInstallTargets(home);
    for (const target of claudeTargets) {
      try {
        enforceDirectorySecurity(path.dirname(target));
        atomicWriteRestricted(target, skillContent);
        installedPaths.push(target);
      } catch {
        // Skip if inaccessible
      }
    }
  }

  // 3. Codex: if ~/.codex directory exists
  if (fs.existsSync(path.join(home, '.codex'))) {
    const codexTargets = getAdapter('codex').getSkillInstallTargets(home);
    for (const target of codexTargets) {
      try {
        enforceDirectorySecurity(path.dirname(target));
        atomicWriteRestricted(target, skillContent);
        installedPaths.push(target);
      } catch {
        // Skip if inaccessible
      }
    }
  }

  // 4. OpenCode: if ~/.config/opencode directory exists
  if (fs.existsSync(path.join(home, '.config', 'opencode'))) {
    const opencodeTargets = getAdapter('opencode').getSkillInstallTargets(home);
    for (const target of opencodeTargets) {
      try {
        enforceDirectorySecurity(path.dirname(target));
        atomicWriteRestricted(target, skillContent);
        installedPaths.push(target);
      } catch {
        // Skip if inaccessible
      }
    }
  }

  return { installedPaths };
}
