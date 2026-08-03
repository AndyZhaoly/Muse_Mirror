---
name: fashion-agent-architecture
description: Use when changing this repository's agent architecture, orchestration, state, prompts, or tool selection. Preserve chat-first autonomous choice and the System/Skill/Tool/Policy/Data separation; do not introduce keyword routers or fixed user workflows.
---

# Fashion agent architecture guard

Before changing orchestration, read `ARCHITECTURE.md`, `SKILL_TOOL_POLICY_MATRIX.md`, and `MIGRATION_V04_TO_V05.md`.

Rules:

1. The user interacts with one natural conversational agent.
2. Do not add an intent-classifier pipeline, fixed mode enum, or `if message.includes(...)` routing.
3. Put always-on behavior in the system prompt.
4. Put stable professional methods in runtime `skills/`.
5. Put external I/O, generation, persistence, or independent services in `src/tools/` and `src/services/`.
6. Put mandatory authorization, ownership, privacy, and budget checks in `src/policy/` or service validation.
7. Keep conversation history separate from application state.
8. Add or update behavioral evals whenever tool descriptions or selection logic change.
9. Run `npm run check` before finishing.
