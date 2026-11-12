import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CircularLineBuffer, detectQuotaExhaustion } from '../src/watcher.js';
import { getAdapter } from '../src/adapters/index.js';

describe('watcher', () => {
  describe('CircularLineBuffer', () => {
    it('buffers lines up to maximum capacity and discards oldest lines', () => {
      const buffer = new CircularLineBuffer(3, 50);

      buffer.pushChunk('Line 1\nLine 2\nLine 3\n');
      assert.deepEqual(buffer.getLines(), ['Line 1', 'Line 2', 'Line 3']);

      buffer.pushChunk('Line 4\n');
      assert.deepEqual(buffer.getLines(), ['Line 2', 'Line 3', 'Line 4']);

      buffer.pushChunk('Line 5\nLine 6\n');
      assert.deepEqual(buffer.getLines(), ['Line 4', 'Line 5', 'Line 6']);
    });

    it('strips ANSI color escapes from pushed chunks', () => {
      const buffer = new CircularLineBuffer(5, 100);
      buffer.pushChunk('\u001b[31;1mError: \u001b[32m429 Quota Exceeded\u001b[0m\n');

      assert.deepEqual(buffer.getLines(), ['Error: 429 Quota Exceeded']);
    });

    it('truncates lines that exceed maxLineChars', () => {
      const buffer = new CircularLineBuffer(5, 10);
      buffer.pushChunk('0123456789ABCDEF\n');

      assert.deepEqual(buffer.getLines(), ['0123456789']);
    });

    it('handles chunk fragments across multiple push calls', () => {
      const buffer = new CircularLineBuffer(5, 50);
      buffer.pushChunk('Starting par');
      buffer.pushChunk('tial line\n');

      assert.deepEqual(buffer.getLines(), ['Starting partial line']);
    });

    it('includes remainder in getLines without losing trailing content', () => {
      const buffer = new CircularLineBuffer(5, 50);
      buffer.pushChunk('Line 1\nTrailing without newline');

      assert.deepEqual(buffer.getLines(), ['Line 1', 'Trailing without newline']);
    });

    it('clears all buffered lines and remainder on clear()', () => {
      const buffer = new CircularLineBuffer(5, 50);
      buffer.pushChunk('Line 1\nLine 2\nPartial');
      assert.equal(buffer.getLines().length, 3);

      buffer.clear();
      assert.deepEqual(buffer.getLines(), []);

      buffer.pushChunk('Fresh line\n');
      assert.deepEqual(buffer.getLines(), ['Fresh line']);
    });
  });

  describe('detectQuotaExhaustion', () => {
    describe('Antigravity host', () => {
      const adapter = getAdapter('antigravity');

      it('detects real quota exhaustion errors', () => {
        const errorSamples = [
          'Error: RESOURCE_EXHAUSTED: Quota exceeded for quota metric "GenerateContentRequests"',
          'Quota exceeded for quota metric GenerateContentRequestsPerMinute',
          'GoogleGenerativeAIError: quota exceeded for current model tier',
          '429 Too Many Requests: Rate limit exceeded',
          'rate limit exceeded due to quota limits on project',
        ];

        for (const sample of errorSamples) {
          assert.equal(
            detectQuotaExhaustion(sample, adapter),
            true,
            `Expected "${sample}" to be detected as quota exhaustion`,
          );
        }
      });

      it('does NOT trigger on test assertions and source code lines (false positives)', () => {
        const falsePositives = [
          '  expect(res.status).toBe(429);',
          'expect(err.message).toContain("RESOURCE_EXHAUSTED");',
          'assert.equal(status, 429);',
          'assert.match(err, /Quota exceeded for quota metric/);',
          'it("handles 429 Quota exceeded", () => {})',
          'it(\'detects RESOURCE_EXHAUSTED\', async () => {})',
          'test("RESOURCE_EXHAUSTED handling in retry loop", () => {})',
          'describe("429 Too Many Requests handling", () => {})',
          '// Quota exceeded for quota metric comment',
          '/* RESOURCE_EXHAUSTED block comment */',
          '* RESOURCE_EXHAUSTED in JSDoc comment',
          '✔ 429 Too Many Requests test passed',
          '✓ Quota exceeded for quota metric verified',
          '✖ RESOURCE_EXHAUSTED simulated failure',
          '✕ 429 Too Many Requests test failed as expected',
          '▶ 429 Too Many Requests suite running',
          '# 429 Too Many Requests TAP line',
        ];

        for (const sample of falsePositives) {
          assert.equal(
            detectQuotaExhaustion(sample, adapter),
            false,
            `Expected "${sample}" to NOT trigger false positive`,
          );
        }
      });
    });

    describe('Claude host', () => {
      const adapter = getAdapter('claude');

      it('detects real Claude rate limit and usage errors', () => {
        const errorSamples = [
          'API error: rate_limit_error: usage limit reached for the current billing cycle',
          'Claude AI usage limit reached for today. Reset at midnight.',
          '429 Too Many Requests',
        ];

        for (const sample of errorSamples) {
          assert.equal(
            detectQuotaExhaustion(sample, adapter),
            true,
            `Expected Claude sample "${sample}" to trigger`,
          );
        }
      });

      it('does NOT trigger on test assertions for Claude', () => {
        const falsePositives = [
          'expect(err).toHaveProperty("rate_limit_error");',
          'it("handles Claude AI usage limit gracefully", () => {})',
          'describe("rate_limit_error suite", () => {})',
          '// usage limit reached mock test',
        ];

        for (const sample of falsePositives) {
          assert.equal(
            detectQuotaExhaustion(sample, adapter),
            false,
            `Expected Claude sample "${sample}" to NOT trigger`,
          );
        }
      });
    });

    describe('Codex host', () => {
      const adapter = getAdapter('codex');

      it('detects real Codex rate limit and quota errors', () => {
        const errorSamples = [
          'Error: rate_limit_exceeded: Please reduce request rate',
          'insufficient_quota: You exceeded your current quota, please check your plan',
          'You exceeded your current quota. Check your balance.',
          '429 Too Many Requests',
        ];

        for (const sample of errorSamples) {
          assert.equal(
            detectQuotaExhaustion(sample, adapter),
            true,
            `Expected Codex sample "${sample}" to trigger`,
          );
        }
      });

      it('does NOT trigger on test assertions for Codex', () => {
        const falsePositives = [
          'expect(code).toBe("rate_limit_exceeded");',
          'test("insufficient_quota error handling", () => {})',
          'it("handles You exceeded your current quota", () => {})',
          '// rate_limit_exceeded check in client',
        ];

        for (const sample of falsePositives) {
          assert.equal(
            detectQuotaExhaustion(sample, adapter),
            false,
            `Expected Codex sample "${sample}" to NOT trigger`,
          );
        }
      });
    });

    describe('OpenCode host', () => {
      const adapter = getAdapter('opencode');

      it('detects real OpenCode rate limit and quota errors', () => {
        const errorSamples = [
          'rate_limit_exceeded: Maximum concurrent requests reached',
          'API quota exceeded for tier',
          '429 Too Many Requests',
        ];

        for (const sample of errorSamples) {
          assert.equal(
            detectQuotaExhaustion(sample, adapter),
            true,
            `Expected OpenCode sample "${sample}" to trigger`,
          );
        }
      });

      it('does NOT trigger on test assertions for OpenCode', () => {
        const falsePositives = [
          'expect(res).toBe("rate_limit_exceeded");',
          'test("quota exceeded handler", () => {})',
          '// rate_limit_exceeded assertion',
        ];

        for (const sample of falsePositives) {
          assert.equal(
            detectQuotaExhaustion(sample, adapter),
            false,
            `Expected OpenCode sample "${sample}" to NOT trigger`,
          );
        }
      });
    });
  });
});
