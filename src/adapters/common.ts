import fs from 'node:fs';
import path from 'node:path';
import type { HostId, PlanArtifact } from '../types.js';

export function resolveBinaryPath(
  binaryName: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (path.isAbsolute(binaryName)) {
    try {
      if (fs.existsSync(binaryName) && fs.statSync(binaryName).isFile()) {
        return binaryName;
      }
    } catch {
      // ignore
    }
  }

  const pathEnv = env.PATH || env.Path || env.path || '';
  if (!pathEnv) {
    return binaryName;
  }

  const entries = pathEnv.split(path.delimiter).filter(Boolean);
  const isWindows = process.platform === 'win32';
  const rawExtensions = isWindows
    ? (env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];

  const extensions = [
    '',
    ...rawExtensions.map((e) => e.toLowerCase()),
    ...rawExtensions.map((e) => e.toUpperCase()),
  ];

  for (const dir of entries) {
    for (const ext of extensions) {
      const candidate = path.join(dir, `${binaryName}${ext}`);
      try {
        if (fs.existsSync(candidate)) {
          const stat = fs.statSync(candidate);
          if (stat.isFile()) {
            return candidate;
          }
        }
      } catch {
        // Skip inaccessible entries
      }
    }
  }

  return binaryName;
}

export function isBinaryInPath(
  binaryName: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const resolved = resolveBinaryPath(binaryName, env);
  return resolved !== binaryName || (fs.existsSync(resolved) && fs.statSync(resolved).isFile());
}

export function buildBaseProfileEnv(
  profileDir: string,
  sessionId: string,
  host: HostId,
  baseEnv?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...(baseEnv ?? process.env),
    HOME: profileDir,
    USERPROFILE: profileDir,
    AGY_SESSION_ID: sessionId,
    AGENT_RELAY_SESSION_ID: sessionId,
    AGENT_RELAY_HOST: host,
  };

  if (process.platform === 'win32') {
    const parsed = path.parse(profileDir);
    const drive = parsed.root.replace(/[/\\]+$/, '');
    env.HOMEDRIVE = drive;
    env.HOMEPATH = profileDir.slice(drive.length);
  }

  if (process.platform === 'linux') {
    env.DBUS_SESSION_BUS_ADDRESS = '';
  }

  return env;
}

export async function findMarkdownArtifacts(
  searchDir: string,
  maxDepth = 2,
): Promise<PlanArtifact[]> {
  const artifacts: PlanArtifact[] = [];
  if (!fs.existsSync(searchDir)) {
    return artifacts;
  }

  function scan(currentDir: string, depth: number): void {
    if (depth > maxDepth) {
      return;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        try {
          const stat = fs.statSync(fullPath);
          const content = fs.readFileSync(fullPath, 'utf8');
          artifacts.push({
            name: entry.name,
            path: fullPath,
            content,
            mtimeMs: stat.mtimeMs,
          });
        } catch {
          // Skip unreadable files
        }
      } else if (entry.isDirectory()) {
        scan(fullPath, depth + 1);
      }
    }
  }

  scan(searchDir, 1);
  artifacts.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return artifacts;
}
