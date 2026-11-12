import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { HandoffOptions, HandoffResult } from './types.js';
import { getAdapter } from './adapters/index.js';
import {
  atomicWriteRestricted,
  enforceDirectorySecurity,
  redactSecrets,
  secureDeleteFile,
  wrapUntrustedHandoff,
} from './security.js';
import { getRuntimeSessionDir } from './profiles.js';

export const MAX_PTY_LINES = 150;
export const MAX_LINE_CHARS = 300;
export const MAX_PTY_BUFFER_CHARS = 7500;

const ANSI_REGEX = /(?:\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]|[\u0080-\u009f])/g;
const CONTROL_CHARS_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

/**
 * Eliminates ANSI/VT100 escape sequences and non-printable control characters,
 * preserving line breaks and horizontal tabs.
 */
export function stripAnsi(text: string): string {
  if (!text) return '';
  return text.replace(ANSI_REGEX, '').replace(CONTROL_CHARS_REGEX, '');
}

/**
 * Formats terminal PTY buffer lines by extracting the most recent slice,
 * stripping ANSI codes, truncating line length, redacting secrets,
 * and enforcing maximum character bounds.
 */
export function formatPtyBuffer(lines: readonly string[]): string {
  if (!lines || lines.length === 0) {
    return '';
  }

  const recent = lines.slice(-MAX_PTY_LINES);
  const formatted = recent.map((line) => {
    const stripped = stripAnsi(line);
    const truncated = stripped.length > MAX_LINE_CHARS ? stripped.slice(0, MAX_LINE_CHARS) : stripped;
    return redactSecrets(truncated);
  });

  let joined = formatted.join('\n');
  if (joined.length > MAX_PTY_BUFFER_CHARS) {
    joined = joined.slice(-MAX_PTY_BUFFER_CHARS);
  }
  return joined;
}

/**
 * Collects short git status and diff statistics from the target working directory.
 * Returns null if the directory is not a git repository or the command times out.
 */
export function collectGitStatus(cwd: string): { statusShort: string; diffStat: string } | null {
  try {
    const statusShortRaw = execFileSync('git', ['status', '--short'], {
      cwd,
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });

    const diffStatRaw = execFileSync('git', ['diff', '--stat'], {
      cwd,
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });

    return {
      statusShort: redactSecrets(statusShortRaw.trimEnd()),
      diffStat: redactSecrets(diffStatRaw.trimEnd()),
    };
  } catch {
    return null;
  }
}

/**
 * Builds the ignition prompt informing the incoming agent to load the handoff file,
 * securely delete it, and proceed immediately with the pending task.
 */
export function buildIgnitionPrompt(handoffPath: string): string {
  return (
    `CRITICAL SESSION HANDOFF: Read the state transfer instructions in "${handoffPath}". ` +
    `Immediately delete that handoff file once read, and proceed seamlessly with the next pending task ` +
    `without asking for unnecessary confirmation.`
  );
}

/**
 * Assembles a structured 4-level context handoff document, wraps it with
 * prompt injection defense nonces, and writes it atomically to the runtime directory.
 */
export async function generateHandoff(options: HandoffOptions): Promise<HandoffResult> {
  const adapter = getAdapter(options.host);
  const sections: string[] = [];

  // Header metadata
  sections.push(
    `# Agent Relay Context Handoff\n\n` +
      `- **Host:** ${options.host}\n` +
      `- **Session ID:** ${options.sessionId}\n` +
      `- **Working Directory:** ${options.cwd}\n` +
      `- **Timestamp:** ${new Date().toISOString()}`
  );

  // Level 1 — Agent Summary
  sections.push('## Level 1 — Agent Summary');
  if (options.summary && options.summary.trim().length > 0) {
    sections.push(redactSecrets(options.summary.trim()));
  } else {
    sections.push('_No agent summary provided._');
  }

  // Level 2 — Active Plan Artifacts
  sections.push('## Level 2 — Active Plan Artifacts');
  let artifacts: Awaited<ReturnType<typeof adapter.findLatestPlanArtifacts>> = [];
  try {
    artifacts = await adapter.findLatestPlanArtifacts(options.profileDir, options.cwd);
  } catch {
    artifacts = [];
  }

  if (artifacts.length > 0) {
    for (const artifact of artifacts) {
      sections.push(
        `### Artifact: ${artifact.path} (${artifact.kind})\n` +
          '```markdown\n' +
          redactSecrets(artifact.content.trim()) +
          '\n```'
      );
    }
  } else {
    sections.push('_No active plan artifacts found._');
  }

  // Level 3 — Git Repository State
  sections.push('## Level 3 — Git Repository State');
  const gitStatus = collectGitStatus(options.cwd);
  if (gitStatus) {
    const parts: string[] = [];
    if (gitStatus.statusShort) {
      parts.push(`### Short Status:\n\`\`\`text\n${gitStatus.statusShort}\n\`\`\``);
    }
    if (gitStatus.diffStat) {
      parts.push(`### Diff Stat:\n\`\`\`text\n${gitStatus.diffStat}\n\`\`\``);
    }
    if (parts.length > 0) {
      sections.push(parts.join('\n\n'));
    } else {
      sections.push('_Git repository working tree is clean._');
    }
  } else {
    sections.push('_Not a git repository or git status timed out._');
  }

  // Level 4 — Terminal PTY Snapshot
  sections.push('## Level 4 — Terminal PTY Snapshot');
  if (options.ptyLines && options.ptyLines.length > 0) {
    const formattedPty = formatPtyBuffer(options.ptyLines);
    if (formattedPty.trim().length > 0) {
      sections.push(`\`\`\`text\n${formattedPty}\n\`\`\``);
    } else {
      sections.push('_Terminal buffer was empty or contained only stripped control characters._');
    }
  } else {
    sections.push('_No terminal output recorded._');
  }

  const assembledMarkdown = sections.join('\n\n') + '\n';
  const targetDir = options.runtimeRoot ?? getRuntimeSessionDir(options.sessionId);
  enforceDirectorySecurity(targetDir);

  const handoffPath = path.join(targetDir, 'handoff.md');
  const { wrapped, nonce } = wrapUntrustedHandoff(assembledMarkdown);
  atomicWriteRestricted(handoffPath, wrapped);

  const bytesWritten = Buffer.byteLength(wrapped, 'utf-8');
  const ignitionPrompt = buildIgnitionPrompt(handoffPath);

  return {
    handoffPath,
    ignitionPrompt,
    nonce,
    bytesWritten,
    timestamp: new Date(),
  };
}

/**
 * Writes an atomic swap trigger signal payload for the supervisor.
 */
export function writeSwapTrigger(sessionId: string, summary?: string, realHome?: string): string {
  const sessionDir = getRuntimeSessionDir(sessionId, realHome);
  enforceDirectorySecurity(sessionDir);
  const triggerPath = path.join(sessionDir, 'trigger-swap.json');
  const payload = {
    triggeredAt: new Date().toISOString(),
    ...(summary ? { summary: redactSecrets(summary) } : {}),
  };
  atomicWriteRestricted(triggerPath, JSON.stringify(payload, null, 2));
  return triggerPath;
}

/**
 * Checks for a pending swap trigger signal file, parses its contents,
 * securely deletes the trigger file, and returns the result.
 */
export function readAndClearSwapTrigger(
  sessionId: string,
  realHome?: string
): { triggered: boolean; summary?: string } {
  const sessionDir = getRuntimeSessionDir(sessionId, realHome);
  const triggerPath = path.join(sessionDir, 'trigger-swap.json');

  if (!fs.existsSync(triggerPath)) {
    return { triggered: false };
  }

  try {
    const content = fs.readFileSync(triggerPath, 'utf-8');
    secureDeleteFile(triggerPath);
    const parsed = JSON.parse(content);
    return {
      triggered: true,
      summary: typeof parsed.summary === 'string' ? parsed.summary : undefined,
    };
  } catch {
    try {
      secureDeleteFile(triggerPath);
    } catch {
      // ignore deletion errors
    }
    return { triggered: false };
  }
}
