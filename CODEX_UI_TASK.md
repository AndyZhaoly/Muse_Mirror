# Codex task: finish and integrate the camera-first web shell

## Read first

1. `AGENTS.md`
2. `README.md`
3. `UI_SPEC.md`
4. `ARCHITECTURE.md`
5. `API_CONTRACT.md`

Use `.agents/skills/build-camera-first-fashion-ui/SKILL.md` for frontend work.

## Starting point

A runnable React + TypeScript + Vite implementation already exists under `web/`. Treat it as a visual and interaction starter, not as the final production transport.

Run:

```bash
npm install
npm run check
npm --prefix web install
npm --prefix web run typecheck
npm --prefix web run build
npm run web:dev
```

## Tasks

1. Preserve the current desktop composition: dominant camera/visual stage on the left, natural Agent chat on the right. Preserve mobile stacking.
2. Keep the warm editorial design direction; refine it rather than replacing it with a generic component-library dashboard.
3. Create a small frontend Agent adapter that can switch between mock mode and the existing turn/resume API.
4. Replace mock scenario responses with real `runFashionTurn` and approval-resume results.
5. Keep live video local. Upload/capture a still only when the request actually needs the current view.
6. Render natural-language text and `UiArtifact` results separately.
7. Map large image artifacts into the left visual stage and compact summaries/actions into chat.
8. Implement real approval interruption and serialized-run-state resume for try-on.
9. Keep closet/product images factual and AI concepts/try-ons clearly labeled.
10. Add tests for camera fallback, artifact mapping, consent/rejection, approval resume, error recovery, and mobile layout behavior.

## Architectural prohibitions

Do not add:

- fixed intent classifier;
- keyword-based production router;
- user-visible workflow steps;
- mandatory mode enum controlling the Agent;
- continuous camera-frame transmission;
- client-only consent that bypasses backend Policy;
- raw Tool/Skill names or JSON in UI.

The quick-action buttons in the starter submit normal user messages and remain optional UI shortcuts.

## Completion

Run:

```bash
npm run check
npm --prefix web run typecheck
npm --prefix web run build
```

Report which checks were actually run and whether real OpenAI/Gemini calls were executed. Do not claim network-provider validation without credentials and an actual request.
