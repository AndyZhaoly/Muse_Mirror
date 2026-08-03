# Codex backend task: Fashion Agent v0.6

Read first:

> For the Web UI, begin with `START_HERE_FOR_CODEX.md` and `CODEX_UI_TASK.md`. This file remains the backend/agent behavior task.


1. `AGENTS.md`
2. `README.md`
3. `ARCHITECTURE.md`
4. `SKILL_TOOL_POLICY_MATRIX.md`
5. `MIGRATION_V04_TO_V05.md`
6. `API_CONTRACT.md`
7. `UI_SPEC.md`
8. `CODEX_UI_TASK.md`

Use the relevant development Skills under `.agents/skills/` when modifying architecture, Skills, Tools, or evals.

## Goal

Finish and validate a chat-first fashion agent in which the main model autonomously chooses among:

- direct answer;
- loading a runtime fashion Skill;
- calling zero, one, or many external Tools;
- continuing after results;
- asking one necessary question.

Do not add a fixed intent classifier, keyword routing, mandatory mode enum, or a user-visible workflow.

## Required separation

- Always-on behavior → `prompts/system_prompt.md`.
- Stable styling methods → `skills/`.
- External I/O, provider calls, artifact generation, persistence, independent verification → `src/tools/` + `src/services/`.
- Consent, ownership, privacy, limits, and future transactions → policy/code.
- Mutable catalogs and user data → databases/services, not Skills.

## First commands

```bash
npm install
npm run check
```

Fix all failures before changing behavior.

## Required behavioral scenarios

### 1. Direct answer

User: `黑色是不是一定比卡其更正式？`

Expected: answer directly. No external Tool. A Skill load is optional only if genuinely needed; unnecessary loading is a negative signal.

### 2. Current-look diagnosis

User: `我这身去见客户可以吗？`

Expected: load `style-diagnosis` when useful. In the current stored-image architecture, call `analyze_current_view`; if converting to direct multimodal input, do not call a redundant vision Tool.

### 3. Occasion + owned clothes

User: `晚上约会，用我衣柜里的衣服搭一套，外面大概 15 度。`

Expected: likely load `occasion-styling`, query closet, and avoid weather lookup because sufficient weather was supplied. No fixed call order.

### 4. Important complete look

User: `这是明天面试的完整搭配，帮我最后把关。`

Expected: load `outfit-review`. Call `verify_outfit_quality` only if independent structured verification adds value.

### 5. Real garment image

User: `你说的是哪件夹克？给我看看。`

Expected: `get_item_images`; never AI generation.

### 6. AI outfit concept

User: `把这整套做成一张平铺图给我看。`

Expected: load `try-on-preparation` if useful, call `generate_outfit_visual`, return an AI-labeled artifact.

### 7. On-body preview

User: `那我穿上是什么样？`

Expected: load `try-on-preparation`, use the active outfit and authorized user image, call `generate_try_on_preview`; pause for approval when permission is missing.

### 8. Follow-up edit

User: `外套换成黑色，鞋别动。`

Expected: call `edit_try_on_preview`, preserving everything not requested.

### 9. Preference memory

User: `今天先别推荐高跟鞋。`

Expected: session preference only; do not persist long-term.

User: `以后都不要给我推荐高跟鞋。`

Expected: persistent-memory tool, with approval when permission is absent.

## Engineering acceptance

- Validate both `.agents/skills/` and runtime `skills/` manifests.
- Keep full Skill content out of the base system prompt.
- Keep Tool descriptions narrow and mutually distinguishable.
- Record Skill loads and business Tool calls separately in behavior evals, even though the current transport exposes the Skill loader as a function tool.
- Add tests before changing a boundary.
- Preserve approval interruption and RunState resume.
- Do not place API keys or service objects in serialized run context.


## Web-shell track

For camera-first frontend implementation, follow `CODEX_UI_TASK.md` and use `.agents/skills/build-fashion-mirror-ui`. Do not move production intent routing into frontend button or keyword handlers. The included `ui-prototype/` is a visual/state reference that runs with mock interactions.
