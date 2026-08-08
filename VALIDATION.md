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

Mirror Situation policy tests use only static observations and episode events. They cover privacy priority,
stale and limited observations, motion, active-task deferral, matched garments, unknown ownership, one-time
ownership questions, explicit ownership confirmation, candidate eligibility, permission-gated persistence,
episode stability, immutability, and deterministic replay. The golden scenario catalog contains at least
twelve cases and can be inspected without any provider credentials:

```bash
npm run simulate:mirror-situations
node --import tsx --test tests/mirrorSituationPolicy.test.ts tests/mirrorSituationScenarios.test.ts
```

For the development UI smoke, run `npm run server` and `npm run web:dev`, then select a fixture in the
`DEVELOPER ONLY` situation panel. Verify that the policy result appears without camera capture, Agent
Activity, TTS, a network request, or closet mutation. The panel must not exist in the production build.

Ambient capture tests use real-provider-shaped structured observations, real Sharp image fixtures, fake
image-edit/visual-verifier providers, and a durable temporary JSON repository. They cover independent crops,
the three required rounds (new outfit, repeated outfit after repository reload, and mixed new/existing
items), Stage A/Stage B state, provider-disabled failure, explicit grant gating, stale packets, garment-track
stability, ambiguous identity rollback, signed-browser isolation, protected asset routes, overlay recommendation
retrieval, and local pixel stability. The dedicated image-pipeline test deliberately changes Round 2 color,
pattern, fit, silhouette, placement, and brightness labels while requiring the verifier to receive Round 1's
real appearance crops. It also asserts that product-image pass/fail and repeat matching never promote
provisional identity or unverified ownership:

```bash
node --import tsx --test \
  tests/ambientCapture.test.ts \
  tests/ambientCaptureImagePipeline.test.ts \
  tests/garmentIdentityProvider.test.ts \
  tests/identityDecisionTrace.test.ts \
  tests/closetItemMerge.test.ts \
  tests/ambientFrameStability.test.ts \
  tests/ambientCaptureUi.test.ts
```

The layered identity suite additionally verifies canonical English/Chinese sleeve, neckline, length, and
material values; physical-only hard exclusions and soft color/length contradictions; locked-current descriptor
sentinels; server-controlled class-level versus instance-specific evidence; strict historical and catalog-only
Safe Same gates; the `0.60` weighted creation-veto floor; always-ambiguous multiple safe matches; and the `0.85`
high-prior auto-create block. It also verifies that a `barely`
visible slot is dropped while another clear garment completes capture. These thresholds are deterministic
routing controls, not calibrated probabilities:

```bash
node --import tsx --test \
  tests/garmentVocabulary.test.ts \
  tests/garmentIdentityEvidence.test.ts \
  tests/garmentIdentityProvider.test.ts \
  tests/ambientCapture.test.ts
```

`tests/garmentVocabulary.test.ts` separately verifies English/Chinese appearance normalization, longest-phrase
matching without substring errors, observable `unknown` values, graded color similarity, consistent jumpsuit
slotting, and the rule that neighboring color evidence alone cannot preserve a garment track.

`tests/ambientFrameStability.test.ts` verifies the empty-scene state machine: one false no-person result does
not suppress uploads, two matching confirmations do, changed scenes cancel candidates, small light flicker
stays below the configured threshold, forced probes resume at the TTL, and a person result clears suppression.
`tests/emptySceneConfig.test.ts` covers defaults and environment bounds. `tests/ambientCaptureUi.test.ts` keeps
camera/feature/stream cleanup, hidden-tab handling, timer cleanup, and safe diagnostics wired into the client.

Physical empty-scene threshold calibration remains required before declaring production readiness. With a
real camera, observe an empty room for 3-5 minutes, verify ordinary request suppression after two server
confirmations, then enter the frame and record the time to resumed capture eligibility. Repeat under material
lighting changes; do not report `0.03` as calibrated from deterministic fixtures alone.

For a real local smoke, configure a real vision provider, open the camera, accept the one-time automatic
recording grant, set `FASHION_AGENT_PRODUCT_IMAGE_PROVIDER=openai`, and use a clearly distinct top and bottom
under good lighting. Verify Round 1 produces two different real crops and two verified product images. Leave
the frame or pause the camera, return in the same outfit for Round 2, then change only the top for Round 3.
Confirm counts are `2 new`, `0 new/2 matched`, then `1 new/1 matched`, and that product-image generation
counts are `2`, `0`, then `1`. Use `?ambientDebug=1` for safe diagnostics. Do not claim this live acceptance
unless all three physical-camera rounds were actually executed.

For the 37-item identity-funnel acceptance, inspect each identity trace as well as final item counts. Round 1
should hard-exclude most incompatible candidates and issue no more than three pairwise verifier calls per
garment. Round 2 should reuse each Round 1 item, normally with one pairwise call. A real run may still return
`ambiguous` when evidence is genuinely insufficient; the safety requirement is zero silent duplicate creation
and zero false merge, not a fabricated zero-ambiguity claim.

For a reproducible local camera run, start the server with `FASHION_AGENT_TRACE=true`. After each stable frame
that enters identity resolution, inspect `out/diagnostics/ambient-captures/<browser-hash>/<capture>/manifest.json`.
The same directory must contain one normalized full-frame image and one image per successfully cropped garment,
including when the final identity result is `ambiguous`. Deleting transient business assets or using the developer
wardrobe reset must not remove these diagnostic copies. Keep the default rolling limit bounded and disable this
mode on shared production deployments unless the photo-retention policy explicitly allows it.

Identity safety fixtures also verify that generic style similarity and VLM confidence cannot establish physical
identity, metadata/continuity prior cannot establish a match, multiple safe candidates remain ambiguous, and a
fallback candidate cannot auto-match. Multi-frame fixtures verify first-frame ephemeral retention, two-frame
pairwise input, cross-frame consistency/mixed evidence, perceptual/bounding-box/coverage-gated recheck, the
one-recheck limit, cross-episode deferral, and cleanup on episode end/privacy pause. Progressive-commit fixtures
also require that one ambiguous garment does not block resolved garments, that an OutfitCapture persists the
pending item reference, and that later resolution migrates that reference and creates at most one WearEvent.
They additionally cover unique physical item IDs for equal fingerprints, atomic pending/capture reconciliation,
same-slot garment replacement, recheck-budget preservation after episode departure, pending expiry, bounded live
candidate windows, one-to-one track assignment, and truthful partial-completion UI copy.

Private real-camera cases can be summarized without committing photos:

```bash
npm run identity:eval
# or: npm run identity:eval -- /absolute/path/to/private/cases
```

Each JSON case contains `caseId`, `expected` (`same`, `different`, or `ambiguous`) and either `actual` or a
sanitized identity `trace.finalDecision`. Keep associated images in `.local/identity-eval/`, which is gitignored.
The report includes `falseExisting`, `falseNew`, `autoMatchPrecision`, `autoNewPrecision`, and automation coverage.
Do not quote precision when no automated decisions exist or when the physical sample is too small.

Before merge, repeat five physical checks: a new generic basic against similar Base Closet items; a true Base
Closet item; a user item with a historical appearance; two visually similar but physically distinct basics; and
the same trousers with waistband occlusion. Ambiguous is acceptable when instance evidence is insufficient.
False-existing and silent duplicate creation are not. Record these as unexecuted unless a real camera run actually
occurred in the current validation session.

If items were recorded while the product-image provider was disabled, use the visible “生成衣橱单品图” action.
The browser-scoped backfill processes only that user's active mirror-captured items, keeps failed verification
results hidden, and exposes each verified result as soon as it is ready. Confirm the card says “AI 整理图” and
does not present the generated asset as a merchant product photo.

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
