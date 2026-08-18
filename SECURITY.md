# Security Policy

## Supported Versions

Only the **latest published npm release** (`@proactive-agent/mcp`) is supported for security fixes.
Older versions should be upgraded as soon as possible.

| Version | Supported |
| --- | --- |
| latest npm release | ✅ |
| earlier versions | ❌ |

## Security Design (summary)

ProactiveAgent is designed with a **local-first, anti-poisoning** security posture:

- **Anti-poisoning memory**: memories extracted automatically are `pending` by default — they only enter recall after the user explicitly confirms. Malicious or erroneous content cannot silently pollute later sessions.
- **LLM same-origin principle**: the configured `apiKey` determines the trust source; the engine never mixes keys across providers, preventing key hijacking.
- **Local-first data**: memory lives in `~/.proma-proactive/` as plain local files (JSONL/markdown). No cloud sync, no server.
- **Zero outbound by default**: `memory_capture`, `memory_recall`, `suggest_*` are pure local rules and never call out. `memory_extract`'s rule mode is zero outbound; LLM mode only sends the current conversation snippet to the LLM endpoint **you** configured (DeepSeek-compatible by default).
- **Secrets never echoed**: LLM config is read from `.env` / environment variables and is never printed to logs or returned by tools.

## Reporting a Vulnerability

Please report vulnerabilities privately via **GitHub Security Advisory**:

<https://github.com/ConradLu2740/ProactiveAgent/security/advisories>

Do **not** open a public issue for security problems.

We will acknowledge receipt within 48 hours, and work on a fix as soon as possible. You may be credited in the advisory if you wish.
