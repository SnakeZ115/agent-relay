---
name: agent-relay
description: Multi-host session relay and account switcher for Antigravity CLI, Claude Code, Codex, and OpenCode. Use to trigger seamless profile rotation and preventive context handoffs.
---

# Agent Relay Skill (`agent-relay`)

This skill allows an AI agent operating inside **Antigravity CLI (`agy`)**, **Claude Code (`claude`)**, **OpenAI Codex CLI (`codex`)**, or **OpenCode (`opencode`)** to gracefully rotate to another active profile or account without losing context, active plan artifacts, or uncommitted git progress.

---

## When to Trigger a Handoff

Invoke the relay under any of the following triggers:

1. **Explicit User Instruction:**
   - The user asks to rotate accounts, switch credentials, or use another profile (e.g., *"cambia de cuenta"*, *"usa otro perfil"*, *"switch profile"*).
2. **Preventive Quota Management:**
   - When reaching 80–90% of model context limits or hourly/daily rate quota limits.
   - When receiving early warnings of token depletion.
3. **HTTP 429 / Rate Limit Detection:**
   - If an API call fails with `429`, `RESOURCE_EXHAUSTED`, `rate_limit_error`, or `insufficient_quota`.

---

## How to Trigger a Profile Swap

Execute the CLI command via your terminal or bash tool:

```bash
agent-relay handoff --summary "<Concise explanation of current task, what was completed, and the immediate next step>" --trigger-swap
```

### Example

```bash
agent-relay handoff --summary "Implemented user authentication service and database migration. Next step: run unit tests in test/auth.spec.ts." --trigger-swap
```

---

## What Happens Under the Hood

When `--trigger-swap` is executed:

1. **Signal Dispatch:** A secure atomic trigger is written to the session runtime directory (`~/.agent-relay/.runtime/<sessionId>/trigger-swap.json`).
2. **Context Assembly (4-Level Cascade):**
   - **Level 1 — Agent Summary:** The summary provided in `--summary` (sanitized of API keys and bearer tokens).
   - **Level 2 — Active Plan Artifacts:** Current session plans, task checklists, and architectural markdown documents.
   - **Level 3 — Git Repository State:** Working tree status (`git status --short`) and staged/unstaged diffs (`git diff --stat`).
   - **Level 4 — Terminal Snapshot:** The last 150 lines of clean terminal output from the circular PTY buffer.
3. **Security Encapsulation:** Wrapped in `<untrusted_session_handoff nonce="...">` to mitigate prompt injection.
4. **State Synchronization:** Shared skills, MCP configurations, and global agent rules are bidirectionally synced between profiles.
5. **Seamless Ignition:** The supervisor terminates the exhausted process, activates the next profile, and launches the incoming session with an ignition prompt pointing directly to `handoff.md`.

---

## Instructions for the Incoming Agent

If you start with an ignition message like:
> `CRITICAL SESSION HANDOFF: Read the state transfer instructions in "~/.agent-relay/.runtime/<sessionId>/handoff.md"...`

1. **Read the handoff file** at the indicated path immediately.
2. **Extract the pending tasks** from Level 1 (Summary) and Level 2 (Plan Artifacts).
3. **Delete the handoff file** to prevent residual data retention.
4. **Resume execution immediately** on the next pending task without asking the user for redundant confirmations.
