# @snakez115/agent-relay

> **Multi-host session relay and profile switcher for AI coding agents with zero context loss.**  
> Seamlessly rotate accounts, preserve active plan artifacts, and prevent quota exhaustion across **Antigravity CLI**, **Claude Code**, **OpenAI Codex**, and **OpenCode**.

---

## ⚡ Quick Start for AI Agents

When operating inside a supervised `agent-relay` terminal session, trigger a seamless account rotation whenever quota limits are approaching or when the user requests an account switch:

```bash
agent-relay handoff --summary "Completed Step 2A (database migration). Next step: run integration tests." --trigger-swap
```

The supervisor will capture your active plan artifacts, recent git diffs, and terminal output, then activate the next configured profile with an automatic ignition prompt in the same terminal window.

---

## 🎯 Supported Hosts (v0.1.0)

| Host | ID | CLI Command | Isolation Strategy | Shared Resources |
|---|---|---|---|---|
| **Antigravity CLI** | `agy` | `agy` | Isolated `USERPROFILE` / `HOME` | `~/.gemini/config/` (MCPs, skills), `settings.json`, `GEMINI.md` |
| **Claude Code** | `claude` | `claude` | `CLAUDE_CONFIG_DIR` + Profile `HOME` | `~/.claude/skills/`, `commands/`, `settings.json`, `CLAUDE.md` |
| **OpenAI Codex CLI** | `codex` | `codex` | `CODEX_HOME` + Profile `HOME` | `~/.codex/skills/`, `config.toml`, `AGENTS.md` |
| **OpenCode CLI** | `opencode` | `opencode` | `XDG_CONFIG_HOME` + `XDG_DATA_HOME` | `~/.config/opencode/skills/`, `cli.json`, `AGENTS.md` |

---

## 📦 Installation

```bash
npm install -g @snakez115/agent-relay
```

This registers three global CLI commands:
- `agent-relay`: Multi-host dispatcher and supervisor.
- `agy-switch`: Shortcut defaulting to Antigravity CLI.
- `claude-switch`: Shortcut defaulting to Claude Code.

The global agent skill is installed automatically during postinstall. To manually reinstall or update the skill:

```bash
agent-relay install-skill
```

---

## 🚀 CLI Commands

### 1. Initialize a New Profile
Create an isolated account environment:

```bash
agent-relay init secondary --host agy
agent-relay init work-account --host claude --no-launch
```

### 2. Check Profile Status
Inspect registered profiles and authentication status across all hosts:

```bash
agent-relay status
agent-relay status --host claude --json
```

### 3. Launch a Supervised Session
Start an interactive terminal with automated quota detection and hot-swapping:

```bash
# Default host and active profile
agent-relay

# Specific profile and host
agent-relay run secondary --host agy

# Pass extra flags to underlying binary
agent-relay run work --host claude -- --model claude-3-7-sonnet
```

### 4. Trigger Handoff / Signal Profile Rotation
Preventive handoff triggered by an agent or user:

```bash
# Signal the active supervisor to rotate immediately
agent-relay handoff --summary "Summary of current progress" --trigger-swap

# Generate a static handoff document without rotating
agent-relay handoff --summary "State checkpoint" --json
```

---

## 🛡️ Security & Isolation Architecture

### 1. Filesystem Hardening (SEC-01)
- Profile and session directories (`~/.agent-relay/`) are provisioned with restrictive access permissions:
  - **POSIX:** Strict `0o700` directory and `0o600` file modes.
  - **Windows:** ACLs configured via `icacls` granting exclusive inheritance to the active Windows user and `SYSTEM`.
- Automatic warnings if repository or profile paths reside within cloud synchronization folders (e.g. OneDrive).

### 2. In-Memory Secret Redaction (SEC-02)
- Handoff markdown, git diffs, and circular terminal buffers pass through `redactSecrets()` prior to persistence:
  - OpenAI / Anthropic API keys (`sk-ant-...`, `sk-...`).
  - Google Gemini API keys (`AIza...`).
  - GitHub Personal Access Tokens (`ghp_...`, `github_pat_...`).
  - Authorization headers (`Bearer ...`) and PEM private keys.

### 3. Indirect Prompt Injection Defense (SEC-03)
- Handoff files are wrapped within `<untrusted_session_handoff nonce="...">` containing a cryptographically secure 128-bit hexadecimal nonce.
- Incoming agents are instructed to parse only verified blocks and securely shred the file immediately upon ignition.

### 4. Hybrid Sharing via Junctions & SHA-256 Sync (SEC-04)
- **Directory Junctions / Symlinks:** Read-only access to global skills, tools, and MCP servers without duplicating disk space.
- **SHA-256 Synchronizer:** Shared state files (`settings.json`, `GEMINI.md`, `CLAUDE.md`, `AGENTS.md`) are bidirectional synchronized with content hashing to avoid race conditions.

---

## 🗺️ Roadmap (v0.2.0)

- [ ] **Cross-Agent Failover:** Seamlessly migrate an active task from Antigravity CLI to Claude Code or Codex when all accounts for a specific provider are exhausted.
- [ ] **Budget & Usage Analytics:** Dashboard tracking token spend and remaining rate limits per profile.
- [ ] **Custom Host Adapter SDK:** Plugin system allowing custom enterprise internal agent CLIs.

---

## 📄 License

MIT © SnakeZ115
