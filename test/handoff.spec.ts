import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  stripAnsi,
  formatPtyBuffer,
  generateHandoff,
  writeSwapTrigger,
  readAndClearSwapTrigger,
  buildIgnitionPrompt,
  MAX_PTY_LINES,
  MAX_LINE_CHARS,
  MAX_PTY_BUFFER_CHARS,
} from '../src/handoff.js';

describe('handoff', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-relay-test-handoff-'));
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {
      // Best-effort cleanup on Windows
    }
  });

  describe('stripAnsi', () => {
    it('strips ANSI color codes and text styles', () => {
      const styled = '\u001b[31;1mError:\u001b[0m \u001b[32mResource exhausted\u001b[0m';
      assert.equal(stripAnsi(styled), 'Error: Resource exhausted');
    });

    it('strips cursor movements and VT100 control sequences', () => {
      const input = '\u001b[2J\u001b[HClearing screen\u001b[1A\u0007\x08';
      assert.equal(stripAnsi(input), 'Clearing screen');
    });

    it('preserves standard tabs, newlines, and carriage returns', () => {
      const input = 'Line 1\tIndent\r\nLine 2';
      assert.equal(stripAnsi(input), 'Line 1\tIndent\r\nLine 2');
    });

    it('handles empty string gracefully', () => {
      assert.equal(stripAnsi(''), '');
    });
  });

  describe('formatPtyBuffer', () => {
    it('returns empty string for empty input array', () => {
      assert.equal(formatPtyBuffer([]), '');
    });

    it('limits buffer to the most recent 150 lines (MAX_PTY_LINES)', () => {
      const lines: string[] = [];
      for (let i = 1; i <= 200; i++) {
        lines.push(`Line ${i}`);
      }

      const formatted = formatPtyBuffer(lines);
      const outputLines = formatted.split('\n');

      assert.equal(outputLines.length, MAX_PTY_LINES);
      assert.equal(outputLines[0], 'Line 51');
      assert.equal(outputLines[outputLines.length - 1], 'Line 200');
    });

    it('truncates individual lines longer than 300 characters (MAX_LINE_CHARS)', () => {
      const longLine = 'A'.repeat(400);
      const formatted = formatPtyBuffer([longLine]);

      assert.equal(formatted.length, MAX_LINE_CHARS);
      assert.equal(formatted, 'A'.repeat(MAX_LINE_CHARS));
    });

    it('redacts sensitive credentials found inside terminal lines', () => {
      const rawLines = [
        'Connecting with key: sk-ant-api03-1234567890abcdefghijklmnop',
        'Authorization: Bearer token1234567890abcdef',
        'Normal diagnostic line',
      ];

      const formatted = formatPtyBuffer(rawLines);

      assert.ok(!formatted.includes('sk-ant-api03-'));
      assert.ok(!formatted.includes('token1234567890abcdef'));
      assert.ok(formatted.includes('[REDACTED_SECRET]'));
      assert.ok(formatted.includes('Normal diagnostic line'));
    });

    it('enforces total character limit cap (MAX_PTY_BUFFER_CHARS)', () => {
      // 100 lines of 200 characters each = 20000 chars > 7500 cap
      const lines = Array.from({ length: 100 }, (_, i) => `Line ${i.toString().padStart(3, '0')}: ${'X'.repeat(200)}`);
      const formatted = formatPtyBuffer(lines);

      assert.ok(formatted.length <= MAX_PTY_BUFFER_CHARS);
    });
  });

  describe('buildIgnitionPrompt', () => {
    it('generates prompt with state transfer path and deletion instruction', () => {
      const handoffPath = 'C:\\temp\\runtime\\handoff.md';
      const prompt = buildIgnitionPrompt(handoffPath);

      assert.ok(prompt.includes('CRITICAL SESSION HANDOFF:'));
      assert.ok(prompt.includes(handoffPath));
      assert.ok(prompt.includes('Immediately delete that handoff file once read'));
    });
  });

  describe('generateHandoff (4-level cascade)', () => {
    it('creates structured handoff document with all 4 levels and injection defense nonce', async () => {
      const profileDir = path.join(tempDir, 'profile');
      const cwdDir = path.join(tempDir, 'workspace');
      const runtimeDir = path.join(tempDir, 'runtime');
      fs.mkdirSync(profileDir, { recursive: true });
      fs.mkdirSync(cwdDir, { recursive: true });
      fs.mkdirSync(runtimeDir, { recursive: true });

      // Create an active plan artifact for Antigravity (Level 2)
      const brainDir = path.join(profileDir, '.gemini', 'antigravity-cli', 'brain', 'session-active');
      fs.mkdirSync(brainDir, { recursive: true });
      fs.writeFileSync(
        path.join(brainDir, 'implementation_plan.md'),
        '# Active Feature Plan\n- Step 1: Tests\n- Step 2: Verification',
      );

      const summary = 'User hit rate limit during refactoring. OpenAI API key was sk-1234567890123456789012345';
      const ptyLines = [
        '\u001b[31mError 429: Too Many Requests\u001b[0m',
        'npm test in progress...',
      ];

      const result = await generateHandoff({
        host: 'antigravity',
        sessionId: 'session-handoff-test-001',
        profileDir,
        cwd: cwdDir,
        runtimeRoot: runtimeDir,
        summary,
        ptyLines,
      });

      // Verify result structure
      assert.ok(result.handoffPath.endsWith('handoff.md'));
      assert.equal(result.sessionId, 'session-handoff-test-001');
      assert.ok(result.nonce.length >= 16);
      assert.ok(result.bytesWritten > 0);
      assert.ok(fs.existsSync(result.handoffPath));

      const fileContent = fs.readFileSync(result.handoffPath, 'utf8');

      // Nonce and prompt injection tags
      assert.ok(fileContent.includes(`<untrusted_session_handoff nonce="${result.nonce}">`));
      assert.ok(fileContent.includes('</untrusted_session_handoff>'));

      // Level 1: Agent Summary with redacted key
      assert.ok(fileContent.includes('## Level 1 — Agent Summary'));
      assert.ok(fileContent.includes('User hit rate limit during refactoring.'));
      assert.ok(!fileContent.includes('sk-1234567890123456789012345'));
      assert.ok(fileContent.includes('[REDACTED_SECRET]'));

      // Level 2: Plan Artifacts
      assert.ok(fileContent.includes('## Level 2 — Active Plan Artifacts'));
      assert.ok(fileContent.includes('Active Feature Plan'));

      // Level 3: Git Repository State
      assert.ok(fileContent.includes('## Level 3 — Git Repository State'));

      // Level 4: Terminal PTY Snapshot (with ANSI stripped)
      assert.ok(fileContent.includes('## Level 4 — Terminal PTY Snapshot'));
      assert.ok(fileContent.includes('Error 429: Too Many Requests'));
      assert.ok(!fileContent.includes('\u001b[31m'));
    });

    it('handles handoff generation gracefully with missing summary, artifacts, and PTY lines', async () => {
      const profileDir = path.join(tempDir, 'empty-profile');
      const cwdDir = path.join(tempDir, 'empty-cwd');
      const runtimeDir = path.join(tempDir, 'empty-runtime');
      fs.mkdirSync(profileDir, { recursive: true });
      fs.mkdirSync(cwdDir, { recursive: true });
      fs.mkdirSync(runtimeDir, { recursive: true });

      const result = await generateHandoff({
        host: 'claude',
        sessionId: 'session-minimal',
        profileDir,
        cwd: cwdDir,
        runtimeRoot: runtimeDir,
      });

      const content = fs.readFileSync(result.handoffPath, 'utf8');
      assert.ok(content.includes('_No agent summary provided._'));
      assert.ok(content.includes('_No active plan artifacts found._'));
      assert.ok(content.includes('_No terminal output recorded._'));
    });
  });

  describe('writeSwapTrigger and readAndClearSwapTrigger', () => {
    it('writes swap trigger payload and reads it once before clearing', () => {
      const sessionId = 'session-swap-test-101';
      const triggerSummary = 'Quota exhausted on primary account with key sk-1234567890123456789012345';

      const triggerPath = writeSwapTrigger(sessionId, triggerSummary, tempDir);
      assert.ok(fs.existsSync(triggerPath));

      // First read: should detect trigger and clear file
      const result1 = readAndClearSwapTrigger(sessionId, tempDir);
      assert.equal(result1.triggered, true);
      assert.ok(result1.summary?.includes('Quota exhausted on primary account'));
      assert.ok(!result1.summary?.includes('sk-1234567890123456789012345'));
      assert.ok(result1.summary?.includes('[REDACTED_SECRET]'));

      // File should now be deleted
      assert.ok(!fs.existsSync(triggerPath));

      // Second read: should indicate no pending trigger
      const result2 = readAndClearSwapTrigger(sessionId, tempDir);
      assert.equal(result2.triggered, false);
      assert.equal(result2.summary, undefined);
    });

    it('returns triggered: false if trigger file does not exist', () => {
      const result = readAndClearSwapTrigger('non-existent-session', tempDir);
      assert.equal(result.triggered, false);
    });
  });
});
