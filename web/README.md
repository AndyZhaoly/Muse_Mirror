# Camera-first web shell

This directory contains a runnable React + TypeScript + Vite starter for the Fashion Agent demo.

It already demonstrates:

- browser-local live camera permission and preview;
- pause, mirror, and snapshot capture;
- analysis loading and compact visual chips;
- camera-left / Agent-right desktop layout;
- stacked mobile layout;
- mock outfit recommendation;
- try-on consent card;
- mock AI try-on and follow-up color edit;
- accessible focus states and reduced-motion support.

The scenario handlers inside `App.tsx` are presentation fixtures only. Codex should replace them with a small Agent API adapter, not convert them into a production keyword router or fixed workflow.

## Run

```bash
npm install
npm run dev
```

## Validate

```bash
npm run typecheck
npm run build
```

## Integration target

Connect ordinary chat turns to the existing Agent turn/resume API. Keep:

- local camera preview separate from captured attachments;
- Agent text separate from UI artifacts;
- approval interruption/resume for protected try-on actions;
- real image and AI image provenance visible;
- large visual artifacts on the left stage.
