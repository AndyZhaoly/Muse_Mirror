# Start here for Codex

This package already contains:

- the v0.5/v0.6 chat-first Fashion Agent backend;
- runtime fashion Skills, external Tools, and Policy gates;
- Nano Banana/Gemini image adapters;
- a runnable React + TypeScript + Vite camera-first web shell under `web/`.

## Read in this order

1. `AGENTS.md`
2. `CODEX_UI_TASK.md`
3. `UI_SPEC.md`
4. `ARCHITECTURE.md`
5. `API_CONTRACT.md`
6. `SKILL_TOOL_POLICY_MATRIX.md`

Use `.agents/skills/build-camera-first-fashion-ui/SKILL.md` for frontend work.

## Product invariant

The user is chatting with one autonomous styling Agent, not operating a fixed workflow.

- Desktop left: dominant live camera / visual mirror / image-result stage.
- Desktop right: natural Agent conversation, recommendations, approvals, and composer.
- Mobile: visual stage above chat, composer at the bottom.
- The main model decides whether to answer directly or use zero, one, or many capabilities.
- Do not add a fixed intent classifier, keyword router, mode enum, or mandatory user journey.

## Run the current package

```bash
npm install
npm run check
npm --prefix web install
npm --prefix web run typecheck
npm --prefix web run build
npm run web:dev
```

The current web app is a polished Mock starter. Replace presentation fixtures with a small adapter to the existing turn/resume API while preserving Mock mode.

## Camera and try-on rules

- Live video remains local in the browser.
- Do not continuously send every frame to the model.
- Capture a still only when the user requests visual analysis or taps `拍照分析`.
- Try-on requires backend-enforced photo-use and image-generation approval.
- Real closet/product images and AI-generated images must remain visibly distinct.
- Large visual artifacts belong on the left stage; explanations and actions belong on the right.

## Finish only after

```bash
npm run check:all
```

Also manually verify desktop and mobile layouts, camera-denied fallback, approval/rejection, AI-image provenance, and error recovery.
