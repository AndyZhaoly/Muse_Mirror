# Repository instructions for Codex

Read `README.md`, `ARCHITECTURE.md`, `SKILL_TOOL_POLICY_MATRIX.md`, `CODEX_TASK.md`, `UI_SPEC.md`, and `CODEX_UI_TASK.md` before architectural or frontend changes.

This repository contains two different Skill sets:

- `.agents/skills/`: development Skills for Codex while editing the repository;
- `skills/`: runtime fashion-method bundles that the product Agent may load on demand.

Do not confuse either with external business Tools under `src/tools/`.

## Product invariants

- Keep one natural, chat-first Agent that may answer directly or choose zero, one, or many capabilities.
- Do not add fixed intent routing, keyword routing, mandatory mode enums, or user-visible workflows.
- Stable professional method → runtime Skill.
- External data, action, provider, generation, persistence, or independent verification → Tool/Service.
- Mandatory consent, ownership, privacy, budget, and transaction controls → Policy/code.
- Large mutable facts → database or retrieval Tool.
- Clothing presentation preference is explicit user/session/demo state, not camera-inferred identity; closet compatibility belongs in one domain policy, not keyword routing.

## Web-shell invariants

- Desktop left is the dominant live mirror / visual stage; desktop right is the Agent panel.
- Continuous camera video stays local by default; capture a still only when needed.
- Large visual artifacts render on the left; explanations, approvals, and actions render on the right.
- Real closet/product images and AI-generated images remain clearly distinguishable.
- Try-on requires backend-enforced approval before photo use and generation.
- Quick actions submit normal messages; they are not a production router.
- Never expose Skill names, Tool names, raw calls, serialized state, JSON, or internal reasoning to users.
- Follow `UI_SPEC.md` and use `.agents/skills/build-camera-first-fashion-ui/SKILL.md` for frontend work.

Run `npm run check` before finalizing root changes. For web changes also run:

```bash
npm --prefix web run typecheck
npm --prefix web run build
```
