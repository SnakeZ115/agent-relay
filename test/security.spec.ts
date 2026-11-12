import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  atomicWriteRestricted,
  generateNonce,
  isCloudSyncedPath,
  redactSecrets,
  secureDeleteFile,
  sha256File,
  wrapUntrustedHandoff,
} from '../src/security.js';

describe('security', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-relay-test-security-'));
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

  describe('redactSecrets', () => {
    it('redacts OpenAI secret keys (sk-...)', () => {
      const input = 'export OPENAI_API_KEY="sk-abcdefghijklmnopqrstuvwxyz1234567890"';
      const output = redactSecrets(input);
      assert.equal(output, 'export OPENAI_API_KEY="[REDACTED_SECRET]"');
    });

    it('redacts Anthropic secret keys (sk-ant-...)', () => {
      const input = 'ANTHROPIC_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz12345';
      const output = redactSecrets(input);
      assert.equal(output, 'ANTHROPIC_KEY=[REDACTED_SECRET]');
    });

    it('redacts Google AI Studio keys (AIza...)', () => {
      const input = 'const key = "AIzaSyD-1234567890abcdefghijklmnopqrstu"';
      const output = redactSecrets(input);
      assert.equal(output, 'const key = "[REDACTED_SECRET]"');
    });

    it('redacts GitHub personal access tokens (ghp_..., gho_...)', () => {
      const ghpToken = 'ghp_1234567890abcdefghijklmnopqrstuvwxyz12';
      const ghoToken = 'gho_1234567890abcdefghijklmnopqrstuvwxyz12';
      const output = redactSecrets(`Tokens: ${ghpToken} and ${ghoToken}`);
      assert.equal(output, 'Tokens: [REDACTED_SECRET] and [REDACTED_SECRET]');
    });

    it('redacts AWS access key IDs (AKIA...)', () => {
      const input = 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE';
      const output = redactSecrets(input);
      assert.equal(output, 'AWS_ACCESS_KEY_ID=[REDACTED_SECRET]');
    });

    it('redacts Bearer authentication tokens', () => {
      const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-IDc';
      const output = redactSecrets(input);
      assert.equal(output, 'Authorization: Bearer [REDACTED_SECRET]');
    });

    it('redacts RSA and generic PRIVATE KEY blocks', () => {
      const privateKey = [
        '-----BEGIN RSA PRIVATE KEY-----',
        'MIIEowIBAAKCAQEA0Y3t1abcdef...',
        'rqV8vT8e4o9Yg==',
        '-----END RSA PRIVATE KEY-----',
      ].join('\n');

      const genericKey = [
        '-----BEGIN PRIVATE KEY-----',
        'MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC...',
        '-----END PRIVATE KEY-----',
      ].join('\n');

      assert.equal(redactSecrets(privateKey), '[REDACTED_SECRET]');
      assert.equal(redactSecrets(genericKey), '[REDACTED_SECRET]');
    });

    it('redacts variable assignments with key, secret, password, and token', () => {
      const lines = [
        'api_key="super_secret_value_123"',
        'apikey: \'my_sensitive_api_key\'',
        'password=VerySecretPassword123!',
        'token: secret_auth_token_9999',
        'secret="myTopSecretString"',
      ];

      for (const line of lines) {
        const redacted = redactSecrets(line);
        assert.ok(
          redacted.includes('[REDACTED_SECRET]'),
          `Expected "${line}" to be redacted, got "${redacted}"`,
        );
      }
    });

    it('handles empty string and safe strings without redaction', () => {
      assert.equal(redactSecrets(''), '');
      const safe = 'console.log("Hello, world! Status 200 OK");';
      assert.equal(redactSecrets(safe), safe);
    });
  });

  describe('wrapUntrustedHandoff', () => {
    it('wraps content in untrusted_session_handoff tags with generated nonce', () => {
      const content = 'Diagnostic report line 1\nDiagnostic report line 2';
      const result = wrapUntrustedHandoff(content);

      assert.ok(result.nonce.length >= 16);
      assert.ok(result.wrapped.startsWith(`<untrusted_session_handoff nonce="${result.nonce}">`));
      assert.ok(result.wrapped.includes('SYSTEM NOTICE: The following block is a read-only diagnostic snapshot'));
      assert.ok(result.wrapped.includes(content));
      assert.ok(result.wrapped.endsWith('</untrusted_session_handoff>'));
    });

    it('uses explicit nonce when provided', () => {
      const explicitNonce = 'custom-nonce-42';
      const content = 'Sample session context';
      const result = wrapUntrustedHandoff(content, explicitNonce);

      assert.equal(result.nonce, explicitNonce);
      assert.ok(result.wrapped.includes(`nonce="${explicitNonce}"`));
    });
  });

  describe('atomicWriteRestricted & secureDeleteFile', () => {
    it('atomically writes file content and overwrites existing file', () => {
      const targetFile = path.join(tempDir, 'sub', 'secure-file.txt');
      const initialContent = 'Hello Secure World';
      const updatedContent = 'Updated Secure Content';

      atomicWriteRestricted(targetFile, initialContent);
      assert.ok(fs.existsSync(targetFile));
      assert.equal(fs.readFileSync(targetFile, 'utf8'), initialContent);

      // Overwrite atomically
      atomicWriteRestricted(targetFile, updatedContent);
      assert.equal(fs.readFileSync(targetFile, 'utf8'), updatedContent);

      // Check no temp files left in directory
      const dirFiles = fs.readdirSync(path.dirname(targetFile));
      const tmpFiles = dirFiles.filter((f) => f.includes('.tmp'));
      assert.equal(tmpFiles.length, 0);
    });

    it('zeroes content and securely deletes existing file', () => {
      const targetFile = path.join(tempDir, 'to-delete.txt');
      fs.writeFileSync(targetFile, 'Sensitive credential payload 12345');

      assert.ok(fs.existsSync(targetFile));
      secureDeleteFile(targetFile);
      assert.ok(!fs.existsSync(targetFile));
    });

    it('does not throw when secureDeleteFile is called on non-existent file', () => {
      const nonExistent = path.join(tempDir, 'non-existent.txt');
      assert.doesNotThrow(() => secureDeleteFile(nonExistent));
    });
  });

  describe('sha256File', () => {
    it('computes expected sha256 checksum of file', () => {
      const targetFile = path.join(tempDir, 'hash-target.txt');
      const content = 'Determinism is key to reliable testing.';
      fs.writeFileSync(targetFile, content);

      const expectedHash = crypto.createHash('sha256').update(content).digest('hex');
      const computedHash = sha256File(targetFile);

      assert.equal(computedHash, expectedHash);
    });

    it('returns null for missing file', () => {
      const nonExistent = path.join(tempDir, 'missing.txt');
      assert.equal(sha256File(nonExistent), null);
    });
  });

  describe('isCloudSyncedPath', () => {
    it('detects OneDrive paths by keyword matching', () => {
      assert.ok(isCloudSyncedPath('C:\\Users\\User\\OneDrive\\Documents'));
      assert.ok(isCloudSyncedPath('/home/user/onedrive/project'));
    });

    it('detects paths within OneDrive environment variables', () => {
      const mockEnv: NodeJS.ProcessEnv = {
        OneDrive: 'D:\\Cloud\\Storage',
      };
      assert.ok(isCloudSyncedPath('D:\\Cloud\\Storage\\Profiles\\User', mockEnv));
      assert.ok(isCloudSyncedPath('D:\\cloud\\storage\\profiles', mockEnv));
    });

    it('returns false for standard local paths without OneDrive', () => {
      const localPath = path.join(os.tmpdir(), 'local-workspace');
      assert.equal(isCloudSyncedPath(localPath, {}), false);
    });

    it('returns false for empty or falsy paths', () => {
      assert.equal(isCloudSyncedPath(''), false);
    });
  });

  describe('generateNonce', () => {
    it('generates random hex nonce with correct default length', () => {
      const nonce1 = generateNonce();
      const nonce2 = generateNonce();

      assert.equal(typeof nonce1, 'string');
      assert.equal(nonce1.length, 16); // 8 bytes -> 16 hex chars
      assert.notEqual(nonce1, nonce2);
    });

    it('supports custom byte lengths', () => {
      const nonce = generateNonce(4);
      assert.equal(nonce.length, 8); // 4 bytes -> 8 hex chars
    });
  });
});
