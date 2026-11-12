import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  initProfile,
  listProfiles,
  getNextProfile,
  syncProfileSharedFiles,
  installGlobalSkill,
  getProfilesHostDir,
} from '../src/profiles.js';

describe('profiles', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-relay-test-profiles-home-'));

    // Create realHome initial structure
    const configDir = path.join(tempHome, '.gemini', 'config');
    const cliDir = path.join(tempHome, '.gemini', 'antigravity-cli');
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(cliDir, { recursive: true });

    fs.writeFileSync(
      path.join(configDir, 'mcp_config.json'),
      JSON.stringify({ mcpServers: { testServer: { command: 'node' } } }, null, 2),
      'utf8',
    );
    fs.writeFileSync(
      path.join(cliDir, 'settings.json'),
      JSON.stringify({ model: 'gemini-2.5-pro' }, null, 2),
      'utf8',
    );
    fs.writeFileSync(
      path.join(tempHome, '.gemini', 'GEMINI.md'),
      '# Antigravity Instructions\nDo not break production.',
      'utf8',
    );
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tempHome)) {
        fs.rmSync(tempHome, { recursive: true, force: true });
      }
    } catch {
      // Best-effort cleanup on Windows
    }
  });

  describe('initProfile', () => {
    it('rejects invalid aliases and reserved "default" alias', async () => {
      await assert.rejects(
        () => initProfile('antigravity', 'default', { realHome: tempHome }),
        /Profile alias cannot be "default"/,
      );

      await assert.rejects(
        () => initProfile('antigravity', 'invalid alias with spaces!', { realHome: tempHome }),
        /Invalid profile alias/,
      );

      await assert.rejects(
        () => initProfile('antigravity', '', { realHome: tempHome }),
        /Invalid profile alias/,
      );
    });

    it('initializes a new profile with shared directory and files', async () => {
      const profile = await initProfile('antigravity', 'personal', { realHome: tempHome });

      assert.equal(profile.name, 'personal');
      assert.equal(profile.host, 'antigravity');
      assert.equal(profile.isDefault, false);
      assert.equal(profile.authenticated, false); // No jetski_state.pbtxt initially

      // Verify directory structure created
      const expectedDir = path.join(getProfilesHostDir('antigravity', tempHome), 'personal');
      assert.equal(profile.path, expectedDir);
      assert.ok(fs.existsSync(expectedDir));

      // Shared directory check (.gemini/config)
      const sharedDirLink = path.join(expectedDir, '.gemini', 'config');
      assert.ok(fs.existsSync(sharedDirLink));
      const mcpConfigInProfile = path.join(sharedDirLink, 'mcp_config.json');
      assert.ok(fs.existsSync(mcpConfigInProfile));

      // Shared files check (.gemini/antigravity-cli/settings.json and .gemini/GEMINI.md)
      const settingsInProfile = path.join(expectedDir, '.gemini', 'antigravity-cli', 'settings.json');
      const geminiMdInProfile = path.join(expectedDir, '.gemini', 'GEMINI.md');
      assert.ok(fs.existsSync(settingsInProfile));
      assert.ok(fs.existsSync(geminiMdInProfile));
      assert.equal(
        fs.readFileSync(settingsInProfile, 'utf8'),
        fs.readFileSync(path.join(tempHome, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8'),
      );

      // Verify link statuses
      assert.ok(profile.links.length >= 3);
      for (const link of profile.links) {
        assert.ok(link.valid, `Expected link ${link.targetRelPath} to be valid`);
      }
    });

    it('detects authentication when auth file is present in profile', async () => {
      const profileDir = path.join(getProfilesHostDir('antigravity', tempHome), 'authenticated-profile');
      const authFile = path.join(profileDir, '.gemini', 'antigravity-cli', 'jetski_state.pbtxt');
      fs.mkdirSync(path.dirname(authFile), { recursive: true });
      fs.writeFileSync(authFile, 'auth_token: "test-token-valid"');

      const profile = await initProfile('antigravity', 'authenticated-profile', { realHome: tempHome });
      assert.equal(profile.authenticated, true);
    });
  });

  describe('listProfiles', () => {
    it('returns default profile plus all initialized profiles', async () => {
      await initProfile('antigravity', 'personal', { realHome: tempHome });
      await initProfile('antigravity', 'work', { realHome: tempHome });

      const profiles = await listProfiles('antigravity', { realHome: tempHome });

      assert.equal(profiles.length, 3);
      assert.equal(profiles[0].name, 'default');
      assert.equal(profiles[0].isDefault, true);
      assert.equal(profiles[0].path, tempHome);

      const names = profiles.map((p) => p.name);
      assert.deepEqual(names, ['default', 'personal', 'work']);
    });

    it('returns only default profile if no extra profiles exist', async () => {
      const profiles = await listProfiles('antigravity', { realHome: tempHome });
      assert.equal(profiles.length, 1);
      assert.equal(profiles[0].name, 'default');
      assert.equal(profiles[0].isDefault, true);
    });
  });

  describe('getNextProfile', () => {
    it('returns null when only default profile is present', async () => {
      const next = await getNextProfile('antigravity', 'default', { realHome: tempHome });
      assert.equal(next, null);
    });

    it('rotates cyclically between default and personal profiles', async () => {
      await initProfile('antigravity', 'personal', { realHome: tempHome });

      // Current is default -> next should be personal
      const nextFromDefault = await getNextProfile('antigravity', 'default', { realHome: tempHome });
      assert.ok(nextFromDefault);
      assert.equal(nextFromDefault.name, 'personal');

      // Current is personal -> next should rotate back to default
      const nextFromPersonal = await getNextProfile('antigravity', 'personal', { realHome: tempHome });
      assert.ok(nextFromPersonal);
      assert.equal(nextFromPersonal.name, 'default');

      // Current unknown -> fallback to first profile (default)
      const nextFromUnknown = await getNextProfile('antigravity', 'unknown-profile', { realHome: tempHome });
      assert.ok(nextFromUnknown);
      assert.equal(nextFromUnknown.name, 'default');
    });
  });

  describe('syncProfileSharedFiles', () => {
    it('syncs updated files from realHome to profileDir (to-profile)', async () => {
      const profile = await initProfile('antigravity', 'personal', { realHome: tempHome });
      const targetGeminiMd = path.join(profile.path, '.gemini', 'GEMINI.md');
      const sourceGeminiMd = path.join(tempHome, '.gemini', 'GEMINI.md');

      // Break hardlink by rewriting target as separate file
      fs.unlinkSync(targetGeminiMd);
      fs.writeFileSync(targetGeminiMd, '# Old Profile Content');

      // Update source
      fs.writeFileSync(sourceGeminiMd, '# Updated Content In Main Workspace');

      await syncProfileSharedFiles('antigravity', profile.path, {
        realHome: tempHome,
        direction: 'to-profile',
      });

      assert.equal(
        fs.readFileSync(targetGeminiMd, 'utf8'),
        '# Updated Content In Main Workspace',
      );
    });

    it('syncs updated files from profileDir to realHome (from-profile)', async () => {
      const profile = await initProfile('antigravity', 'personal', { realHome: tempHome });
      const targetGeminiMd = path.join(profile.path, '.gemini', 'GEMINI.md');
      const sourceGeminiMd = path.join(tempHome, '.gemini', 'GEMINI.md');

      // Break hardlink
      fs.unlinkSync(targetGeminiMd);
      fs.writeFileSync(targetGeminiMd, '# New Content From Profile');

      await syncProfileSharedFiles('antigravity', profile.path, {
        realHome: tempHome,
        direction: 'from-profile',
      });

      assert.equal(
        fs.readFileSync(sourceGeminiMd, 'utf8'),
        '# New Content From Profile',
      );
    });

    it('syncs bidirectionally based on file mtime', async () => {
      const profile = await initProfile('antigravity', 'personal', { realHome: tempHome });
      const targetGeminiMd = path.join(profile.path, '.gemini', 'GEMINI.md');
      const sourceGeminiMd = path.join(tempHome, '.gemini', 'GEMINI.md');

      // Break hardlink
      fs.unlinkSync(targetGeminiMd);
      fs.writeFileSync(targetGeminiMd, '# Profile Newer Version');

      // Set mtime of target to future
      const futureTime = (Date.now() + 5000) / 1000;
      fs.utimesSync(targetGeminiMd, futureTime, futureTime);

      await syncProfileSharedFiles('antigravity', profile.path, {
        realHome: tempHome,
        direction: 'bidirectional',
      });

      assert.equal(
        fs.readFileSync(sourceGeminiMd, 'utf8'),
        '# Profile Newer Version',
      );
    });
  });

  describe('installGlobalSkill', () => {
    it('always installs skill for Antigravity, and detects other hosts when their home dirs exist', async () => {
      // Create Claude, Codex, and OpenCode config dirs in tempHome
      fs.mkdirSync(path.join(tempHome, '.claude'), { recursive: true });
      fs.mkdirSync(path.join(tempHome, '.codex'), { recursive: true });
      fs.mkdirSync(path.join(tempHome, '.config', 'opencode'), { recursive: true });

      const result = await installGlobalSkill({ realHome: tempHome, silent: true });

      assert.equal(result.installedPaths.length, 4);

      // Verify Antigravity target exists
      const agySkill = path.join(
        tempHome,
        '.gemini',
        'config',
        'plugins',
        'agent-relay',
        'skills',
        'agent-relay',
        'SKILL.md',
      );
      assert.ok(fs.existsSync(agySkill));
      assert.ok(fs.readFileSync(agySkill, 'utf8').includes('name: agent-relay'));

      // Verify Claude target exists
      const claudeSkill = path.join(tempHome, '.claude', 'skills', 'agent-relay', 'SKILL.md');
      assert.ok(fs.existsSync(claudeSkill));

      // Verify Codex target exists
      const codexSkill = path.join(tempHome, '.codex', 'skills', 'agent-relay', 'SKILL.md');
      assert.ok(fs.existsSync(codexSkill));

      // Verify OpenCode target exists
      const opencodeSkill = path.join(
        tempHome,
        '.config',
        'opencode',
        'skills',
        'agent-relay',
        'SKILL.md',
      );
      assert.ok(fs.existsSync(opencodeSkill));
    });

    it('only installs for Antigravity if other host directories do not exist', async () => {
      const result = await installGlobalSkill({ realHome: tempHome, silent: true });
      assert.equal(result.installedPaths.length, 1);
      assert.ok(result.installedPaths[0].includes('.gemini'));
    });
  });
});
