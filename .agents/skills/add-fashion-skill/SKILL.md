---
name: add-fashion-skill
description: Use when adding or revising a runtime fashion skill under skills/. Create a focused SKILL.md with clear trigger and non-trigger boundaries, optional references, registry support, and tests; do not put external API calls or mutable user data in a skill.
---

# Add a runtime fashion skill

1. Confirm the capability is a reusable method or stable domain procedure, not external data or an action.
2. Create `skills/<name>/SKILL.md` with YAML front matter containing `name` and a concise `description` that states when it should and should not load.
3. Keep the main instructions focused. Put long details in `references/`.
4. Add the name to `runtimeFashionSkillNames` in `src/services/skillRegistry.ts`.
5. Update the system skill catalog only through the registry; do not paste the full skill into the system prompt.
6. Add tests for manifest parsing, safe reference access, and selection boundaries.
7. Update `SKILL_TOOL_POLICY_MATRIX.md` if the responsibility boundary changes.
8. Run `npm run validate:skills` and `npm run check`.
