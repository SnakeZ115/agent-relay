import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveHostId,
  getAllAdapters,
  getAdapter,
} from '../src/adapters/index.js';
import type { HostId } from '../src/types.js';

describe('adapters', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-relay-test-adapters-'));
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup error on busy Windows handles
    }
  });

  describe('resolveHostId', () => {
    it('resolves host aliases from direct input string', () => {
      assert.equal(resolveHostId('agy'), 'antigravity');
      assert.equal(resolveHostId(' AGY '), 'antigravity');
      assert.equal(resolveHostId('antigravity'), 'antigravity');
      assert.equal(resolveHostId('claude'), 'claude');
      assert.equal(resolveHostId('cl'), 'claude');
      assert.equal(resolveHostId('codex'), 'codex');
      assert.equal(resolveHostId('cx'), 'codex');
      assert.equal(resolveHostId('opencode'), 'opencode');
      assert.equal(resolveHostId('oc'), 'opencode');
    });

    it('resolves host from invoked binary names', () => {
      assert.equal(resolveHostId(undefined, 'agy-switch'), 'antigravity');
      assert.equal(resolveHostId(undefined, 'C:\\bin\\agy-switch.cmd'), 'antigravity');
      assert.equal(resolveHostId(undefined, '/usr/local/bin/agy-switch'), 'antigravity');
      assert.equal(resolveHostId(undefined, 'claude-switch'), 'claude');
      assert.equal(resolveHostId(undefined, 'C:\\tools\\claude-switch.exe'), 'claude');
      assert.equal(resolveHostId(undefined, 'codex-switch'), 'codex');
      assert.equal(resolveHostId(undefined, 'opencode-switch'), 'opencode');
    });

    it('resolves host from AGENT_RELAY_HOST environment variable', () => {
      const originalEnv = process.env.AGENT_RELAY_HOST;
      try {
        process.env.AGENT_RELAY_HOST = 'claude';
        assert.equal(resolveHostId(), 'claude');

        process.env.AGENT_RELAY_HOST = 'codex';
        assert.equal(resolveHostId(), 'codex');

        process.env.AGENT_RELAY_HOST = 'opencode';
        assert.equal(resolveHostId(), 'opencode');
      } finally {
        if (originalEnv !== undefined) {
          process.env.AGENT_RELAY_HOST = originalEnv;
        } else {
          delete process.env.AGENT_RELAY_HOST;
        }
      }
    });

    it('falls back to antigravity by default', () => {
      const originalEnv = process.env.AGENT_RELAY_HOST;
      try {
        delete process.env.AGENT_RELAY_HOST;
        assert.equal(resolveHostId(), 'antigravity');
        assert.equal(resolveHostId('unknown-host'), 'antigravity');
        assert.equal(resolveHostId(undefined, 'custom-bin'), 'antigravity');
      } finally {
        if (originalEnv !== undefined) {
          process.env.AGENT_RELAY_HOST = originalEnv;
        }
      }
    });
  });

  describe('getAllAdapters & getAdapter', () => {
    it('returns all 4 supported adapters', () => {
      const adapters = getAllAdapters();
      assert.equal(adapters.length, 4);

      const ids = adapters.map((a) => a.id);
      assert.deepEqual(ids, ['antigravity', 'claude', 'codex', 'opencode']);
    });

    it('retrieves individual adapter instances correctly', () => {
      assert.equal(getAdapter('antigravity').id, 'antigravity');
      assert.equal(getAdapter('claude').id, 'claude');
      assert.equal(getAdapter('codex').id, 'codex');
      assert.equal(getAdapter('opencode').id, 'opencode');
    });

    it('throws error when requesting unsupported host', () => {
      assert.throws(
        () => getAdapter('unsupported' as HostId),
        /Unsupported host: "unsupported"/,
      );
    });
  });

  describe('buildProfileEnv', () => {
    const profileDir = path.join(os.tmpdir(), 'agent-relay-test-profile');
    const sessionId = 'test-session-1234';

    it('builds environment for Antigravity', () => {
      const adapter = getAdapter('antigravity');
      const env = adapter.buildProfileEnv(profileDir, sessionId);

      assert.equal(env.HOME, profileDir);
      assert.equal(env.USERPROFILE, profileDir);
      assert.equal(env.AGY_SESSION_ID, sessionId);
      assert.equal(env.AGENT_RELAY_SESSION_ID, sessionId);
      assert.equal(env.AGENT_RELAY_HOST, 'antigravity');
    });

    it('builds environment for Claude with CLAUDE_CONFIG_DIR', () => {
      const adapter = getAdapter('claude');
      const env = adapter.buildProfileEnv(profileDir, sessionId);

      assert.equal(env.HOME, profileDir);
      assert.equal(env.USERPROFILE, profileDir);
      assert.equal(env.AGY_SESSION_ID, sessionId);
      assert.equal(env.AGENT_RELAY_SESSION_ID, sessionId);
      assert.equal(env.AGENT_RELAY_HOST, 'claude');
      assert.equal(env.CLAUDE_CONFIG_DIR, path.join(profileDir, '.claude'));
    });

    it('builds environment for Codex with CODEX_HOME', () => {
      const adapter = getAdapter('codex');
      const env = adapter.buildProfileEnv(profileDir, sessionId);

      assert.equal(env.HOME, profileDir);
      assert.equal(env.USERPROFILE, profileDir);
      assert.equal(env.AGY_SESSION_ID, sessionId);
      assert.equal(env.AGENT_RELAY_SESSION_ID, sessionId);
      assert.equal(env.AGENT_RELAY_HOST, 'codex');
      assert.equal(env.CODEX_HOME, path.join(profileDir, '.codex'));
    });

    it('builds environment for OpenCode with XDG variables', () => {
      const adapter = getAdapter('opencode');
      const env = adapter.buildProfileEnv(profileDir, sessionId);

      assert.equal(env.HOME, profileDir);
      assert.equal(env.USERPROFILE, profileDir);
      assert.equal(env.AGY_SESSION_ID, sessionId);
      assert.equal(env.AGENT_RELAY_SESSION_ID, sessionId);
      assert.equal(env.AGENT_RELAY_HOST, 'opencode');
      assert.equal(env.XDG_CONFIG_HOME, path.join(profileDir, '.config'));
      assert.equal(env.XDG_DATA_HOME, path.join(profileDir, '.local', 'share'));
    });
  });

  describe('buildIgnitionArgs', () => {
    const prompt = 'CRITICAL SESSION HANDOFF: Read handoff.md';

    it('builds Antigravity ignition arguments with -i flag', () => {
      const adapter = getAdapter('antigravity');
      const args = adapter.buildIgnitionArgs(prompt, ['--verbose']);
      assert.deepEqual(args, ['-i', prompt, '--verbose']);
    });

    it('builds Claude ignition arguments as positional argument', () => {
      const adapter = getAdapter('claude');
      const args = adapter.buildIgnitionArgs(prompt, ['--print']);
      assert.deepEqual(args, ['--print', prompt]);
    });

    it('builds Codex ignition arguments as positional argument', () => {
      const adapter = getAdapter('codex');
      const args = adapter.buildIgnitionArgs(prompt, ['--dangerously-bypass-approvals']);
      assert.deepEqual(args, ['--dangerously-bypass-approvals', prompt]);
    });

    it('builds OpenCode ignition arguments with --prompt flag', () => {
      const adapter = getAdapter('opencode');
      const args = adapter.buildIgnitionArgs(prompt, ['--model', 'claude-3-7-sonnet']);
      assert.deepEqual(args, ['--prompt', prompt, '--model', 'claude-3-7-sonnet']);
    });
  });

  describe('getSharedDirectories and getSharedFiles', () => {
    it('provides shared mappings for Antigravity', () => {
      const adapter = getAdapter('antigravity');
      const dirs = adapter.getSharedDirectories();
      const files = adapter.getSharedFiles();

      assert.ok(dirs.some((d) => d.targetRelPath === path.join('.gemini', 'config')));
      assert.ok(files.some((f) => f.targetRelPath === path.join('.gemini', 'antigravity-cli', 'settings.json')));
      assert.ok(files.some((f) => f.targetRelPath === path.join('.gemini', 'GEMINI.md')));
    });

    it('provides shared mappings for Claude', () => {
      const adapter = getAdapter('claude');
      const dirs = adapter.getSharedDirectories();
      const files = adapter.getSharedFiles();

      assert.ok(dirs.some((d) => d.targetRelPath === path.join('.claude', 'skills')));
      assert.ok(dirs.some((d) => d.targetRelPath === path.join('.claude', 'commands')));
      assert.ok(dirs.some((d) => d.targetRelPath === path.join('.claude', 'agents')));
      assert.ok(files.some((f) => f.targetRelPath === path.join('.claude', 'settings.json')));
      assert.ok(files.some((f) => f.targetRelPath === path.join('.claude', 'CLAUDE.md')));
    });

    it('provides shared mappings for Codex', () => {
      const adapter = getAdapter('codex');
      const dirs = adapter.getSharedDirectories();
      const files = adapter.getSharedFiles();

      assert.ok(dirs.some((d) => d.targetRelPath === path.join('.codex', 'skills')));
      assert.ok(dirs.some((d) => d.targetRelPath === path.join('.codex', 'agents')));
      assert.ok(files.some((f) => f.targetRelPath === path.join('.codex', 'config.toml')));
      assert.ok(files.some((f) => f.targetRelPath === path.join('.codex', 'AGENTS.md')));
    });

    it('provides shared mappings for OpenCode', () => {
      const adapter = getAdapter('opencode');
      const dirs = adapter.getSharedDirectories();
      const files = adapter.getSharedFiles();

      assert.ok(dirs.some((d) => d.targetRelPath === path.join('.config', 'opencode', 'skills')));
      assert.ok(dirs.some((d) => d.targetRelPath === path.join('.config', 'opencode', 'agents')));
      assert.ok(files.some((f) => f.targetRelPath === path.join('.config', 'opencode', 'cli.json')));
      assert.ok(files.some((f) => f.targetRelPath === path.join('.config', 'opencode', 'opencode.json')));
      assert.ok(files.some((f) => f.targetRelPath === path.join('.config', 'opencode', 'AGENTS.md')));
    });
  });

  describe('findLatestPlanArtifacts', () => {
    it('discovers and prioritizes Antigravity brain artifacts', async () => {
      const adapter = getAdapter('antigravity');
      const brainDir = path.join(tempDir, '.gemini', 'antigravity-cli', 'brain', 'session-alpha');
      fs.mkdirSync(brainDir, { recursive: true });

      const planPath = path.join(brainDir, 'implementation_plan.md');
      const taskPath = path.join(brainDir, 'task.md');
      const notesPath = path.join(brainDir, 'notes.md');

      fs.writeFileSync(planPath, '# Plan Alpha');
      fs.writeFileSync(taskPath, '# Task Alpha');
      fs.writeFileSync(notesPath, '# Notes Alpha');

      const artifacts = await adapter.findLatestPlanArtifacts(tempDir, tempDir);
      assert.equal(artifacts.length, 3);
      // implementation_plan.md must be first priority (weight 2), followed by task.md (weight 1)
      assert.equal(artifacts[0].name, 'implementation_plan.md');
      assert.equal(artifacts[0].content, '# Plan Alpha');
      assert.equal(artifacts[1].name, 'task.md');
      assert.equal(artifacts[1].content, '# Task Alpha');
    });

    it('discovers and deduplicates Claude plan artifacts across profile and cwd', async () => {
      const adapter = getAdapter('claude');
      const profilePlans = path.join(tempDir, 'profile', '.claude', 'plans');
      const cwdPlans = path.join(tempDir, 'cwd', '.claude', 'plans');
      fs.mkdirSync(profilePlans, { recursive: true });
      fs.mkdirSync(cwdPlans, { recursive: true });

      fs.writeFileSync(path.join(profilePlans, 'plan-a.md'), '# Plan A in Profile');
      fs.writeFileSync(path.join(cwdPlans, 'plan-b.md'), '# Plan B in CWD');

      const artifacts = await adapter.findLatestPlanArtifacts(
        path.join(tempDir, 'profile'),
        path.join(tempDir, 'cwd'),
      );

      assert.equal(artifacts.length, 2);
      const names = artifacts.map((a) => a.name);
      assert.ok(names.includes('plan-a.md'));
      assert.ok(names.includes('plan-b.md'));
    });

    it('discovers Codex session plan artifacts', async () => {
      const adapter = getAdapter('codex');
      const sessionsDir = path.join(tempDir, '.codex', 'sessions', 'sess-01');
      fs.mkdirSync(sessionsDir, { recursive: true });
      fs.writeFileSync(path.join(sessionsDir, 'task.md'), '# Codex Task');

      const artifacts = await adapter.findLatestPlanArtifacts(tempDir, tempDir);
      assert.equal(artifacts.length, 1);
      assert.equal(artifacts[0].name, 'task.md');
      assert.equal(artifacts[0].content, '# Codex Task');
    });

    it('discovers OpenCode data plan artifacts', async () => {
      const adapter = getAdapter('opencode');
      const dataDir = path.join(tempDir, '.local', 'share', 'opencode', 'sess-02');
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(path.join(dataDir, 'plan.md'), '# OpenCode Plan');

      const artifacts = await adapter.findLatestPlanArtifacts(tempDir, tempDir);
      assert.equal(artifacts.length, 1);
      assert.equal(artifacts[0].name, 'plan.md');
      assert.equal(artifacts[0].content, '# OpenCode Plan');
    });
  });
});
