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

Deployment-focused coverage additionally verifies:

- provider-independent `/healthz` output;
- access-code rejection and signed-cookie acceptance;
- tampered-cookie and unauthenticated HTTP rejection;
- unauthenticated ASR/TTS WebSocket upgrade rejection;
- persistent per-browser `team_demo_<uuid>` identity and storage fallback;
- same-origin `ws://` locally and `wss://` on HTTPS.

Parse and inspect the Render Blueprint without contacting Render:

```bash
ruby -e 'require "yaml"; YAML.safe_load(File.read("render.yaml"), aliases: true); puts "render.yaml parsed"'
```

If the Render CLI is installed and authenticated, use its official Blueprint validation command as an additional check. A local YAML parse is not equivalent to Render platform validation.

Voice protocol tests use deterministic binary fixtures and fake WebSocket provider sessions. They do not require Volcengine credentials and cover configuration defaults, the 500 ms endpoint window and safe invalid-value fallback, status redaction, ASR/TTS framing, provider error parsing, and connection cleanup.

Voice-response tests verify that text mode remains unchanged, voice-only instructions are present only for ASR turns, unsupported `minimal` reasoning is never sent to `gpt-5.4`, `spokenText` is derived from the authoritative grounded answer, Markdown/URLs/IDs and empty labels are removed, critical visual/closet/fit notices survive voice limits, history stores only authoritative `text`, and TTS selection prefers `spokenText` without a second model request.

OpenAI final-answer streaming tests use deterministic async iterables through the runtime's `responseCreate` injection. They verify that final-answer deltas arrive before `response.completed`, commentary remains separate, tool-following rounds stream, unknown phases buffer safely, retry cannot duplicate visible text, final grounding remains authoritative, and SSE preserves delta order before `result`.

Run the focused streaming suite with:

```bash
node --import tsx --test tests/openAiMuseStreaming.test.ts
```

With `FASHION_AGENT_TRACE=true`, server logs include safe `[MuseLatency]` milestones such as model-round start, first model stream event, tool start/completion, first final-answer delta, and final-result readiness. Timing logs contain opaque IDs, mode, elapsed milliseconds, round counts, character counts, and token counts when available—not user text, answer text, images, reasoning, credentials, cookies, or audio.

For a browser-side end-to-end summary, open the app with `?latency=1` or set `localStorage.muse_latency_debug = "1"`. Complete one voice turn and inspect the console for `[MuseLatency]`. With a provider `utterance_end`, verify `speechEndSource: "provider_utterance_end"` and a non-negative `asrFinalizeMs`. Without that event, verify `speechEndSource: "unavailable"` and no `asrFinalizeMs`; zero must not be synthesized. Check `firstFinalDeltaMs`, `resultReadyMs`, `firstAudioMs`, and `playbackCompleteMs` where their stages completed. Measure warm requests separately from Render cold starts.

For a manual local voice smoke test:

```bash
npm run server
# in another terminal
npm run web:dev
```

Then open `http://localhost:5173`, enable voice mode, allow microphone access, speak one utterance, and verify the visible sequence `listening -> thinking -> speaking -> listening`. Confirm the final transcript appears exactly once in the same conversation history as typed messages.

Compare the same prompt in typed and voice modes. Typed mode should retain the detailed screen-oriented response. Voice mode currently keeps both screen text and spoken text concise (normally about two sentences; Chinese hard cap 80 characters), while artifacts and cards carry structured detail. Confirm that mandatory grounding notices are present in both authoritative text and speech when applicable.

For the production-build server path:

```bash
npm run demo:web
```

Validate `GET /api/voice/status` before testing real speech. A remote smoke test requires HTTPS/WSS because browsers restrict microphone access on insecure origins. Missing speech configuration must leave text chat fully operational.

The current product configuration defaults to real providers and never falls back to fabricated visual or generated-image results. Missing provider credentials leave `/healthz` available and report the affected capability as unavailable.

Real OpenAI and Gemini provider requests require user-supplied credentials and must not be claimed as tested unless actual network calls were executed.

Real Volcengine ASR/TTS calls likewise require user-supplied credentials, an enabled resource ID, and a valid speaker ID. Do not claim provider-level audio validation when only deterministic fixtures were run.

## Docker smoke test

```bash
docker build -t muse-mirror-team-demo .
docker run --rm -p 8080:8080 -e PORT=8080 -e NODE_ENV=production muse-mirror-team-demo
curl -i http://localhost:8080/healthz
```

When testing access control, configure both `MUSE_TEAM_DEMO_ACCESS_CODE` and `MUSE_TEAM_DEMO_SESSION_SECRET`, then verify `/healthz` remains `200` and unauthenticated `/api/fashion/status` returns `401`. See [DEPLOY_RENDER.md](DEPLOY_RENDER.md) for the complete local and online smoke checklist.
