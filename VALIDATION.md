# Validation

Validated locally for this package:

```bash
npm run validate:skills
npm run validate:ui
npm run typecheck
npm test
npm run build
npm run demo:services
npm --prefix web run typecheck
npm --prefix web run build
```

Voice protocol tests use deterministic binary fixtures and fake WebSocket provider sessions. They do not require Volcengine credentials and cover configuration defaults, status redaction, ASR/TTS framing, provider error parsing, and connection cleanup.

For a manual local voice smoke test:

```bash
npm run server
# in another terminal
npm run web:dev
```

Then open `http://localhost:5173`, enable voice mode, allow microphone access, speak one utterance, and verify the visible sequence `listening -> thinking -> speaking -> listening`. Confirm the final transcript appears exactly once in the same conversation history as typed messages.

For the production-build server path:

```bash
npm run demo:web
```

Validate `GET /api/voice/status` before testing real speech. A remote smoke test requires HTTPS/WSS because browsers restrict microphone access on insecure origins. Missing speech configuration must leave text chat fully operational.

The React shell is Mock-first and does not require credentials.

Real OpenAI and Gemini provider requests require user-supplied credentials and must not be claimed as tested unless actual network calls were executed.

Real Volcengine ASR/TTS calls likewise require user-supplied credentials, an enabled resource ID, and a valid speaker ID. Do not claim provider-level audio validation when only deterministic fixtures were run.
