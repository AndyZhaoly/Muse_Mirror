---
name: build-camera-first-fashion-ui
description: Use when creating or revising the fashion-agent web shell. Preserve the live-camera-left and conversational-agent-right layout, warm editorial visual system, explicit try-on consent, artifact boundaries, responsive behavior, and the chat-first autonomous backend architecture.
---

# Build the camera-first fashion UI

Read `START_HERE_FOR_CODEX.md`, `UI_SPEC.md`, `API_CONTRACT.md`, and the current `web/` implementation before editing.

## Product invariant

The interface is a styling mirror with a conversational expert beside it:

- desktop left: dominant live mirror and visual results;
- desktop right: Agent conversation and controls;
- mobile: mirror first, conversation second.

Do not turn the product into a dashboard, wizard, or generic chatbot.

## Architecture invariant

UI shortcuts submit normal chat messages. They are not an intent router.

The production Agent decides whether to answer directly, use a runtime fashion Skill, call an external Tool, or ask one necessary question. The UI must not reimplement that decision process with keywords, fixed modes, or mandatory steps.

## Camera invariant

Keep live video local. Capture a still frame only on explicit analysis or when the current request genuinely requires visual context. Never continuously send all frames.

## Visual artifact invariant

- real closet and product images remain factual;
- AI outfit visuals and try-on previews are labeled;
- large visual output appears in the left stage;
- explanation and actions appear in the right conversation;
- no internal tool names, JSON, logs, or serialized run state are shown.

## Try-on invariant

Do not generate a user try-on before photo-use and image-generation permission is approved. Use the backend interruption/resume path rather than faking approval only in the browser.

## Quality bar

- warm-neutral editorial palette;
- spacious visual hierarchy;
- refined typography;
- clear empty/loading/error/permission states;
- visible keyboard focus;
- responsive without horizontal overflow;
- reduced-motion support;
- realistic Mock mode without credentials.

Before finishing, run root checks plus web typecheck/build and manually inspect desktop and mobile layouts.
