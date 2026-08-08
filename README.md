# Muse Mirror

Muse Mirror is a camera-first conversational fashion agent demo. It combines a React mirror UI, an OpenAI Responses API tool loop, grounded wardrobe recommendations, visual observation, AI concept images, try-on previews, conversation history, and explicit user memory.

This repository is a standalone snapshot of the investor demo. It includes the demo wardrobe metadata and 37 canonical garment images required to reproduce the closet experience. It does not include API keys, user photos, generated images, or conversation data.

## What is included

- One Muse main agent with no keyword router or separate planning-model call.
- OpenAI Responses API streaming and native function-calling loop.
- Optional Volcengine streaming ASR and TTS in a semi-duplex voice loop.
- Live local camera preview with low-frequency still-frame observation.
- Opt-in ambient outfit capture with real worn-garment vision, repeat recognition, and a durable per-browser closet overlay.
- A grounded 37-item demo wardrobe with canonical item images.
- Wardrobe recommendation, real item cards, weather, and optional product tools.
- AI concept items, item collections, outfit heroes, Look Boards, and try-on previews.
- Photo-use approval, visual scope constraints, artifact provenance, and version history.
- SSE commentary, text deltas, real tool activity, artifacts, results, and productized errors.
- Local conversation history, Temporary Chat, context overrides, and explicit memory management.
- Legacy Gemma/Ollama runtime support behind configuration.

## Architecture

```text
React mirror + chat UI
        |
        +--> microphone PCM -> Volcengine ASR
        +--> final Muse text -> Volcengine TTS -> queued PCM playback
        |
        v
Node API / SSE gateway
        |
        +--> conversation and memory store
        |
        v
Muse main agent (OpenAI Responses API)
        |
        +--> observe_current_frame
        +--> recommend_from_closet
        +--> get_item_images
        +--> get_weather
        +--> commit_outfit
        +--> create_style_visual
        +--> update_style_visual
        +--> search_products (only when configured)
        |
        v
Runtime policy + tool ledger + grounding + UI artifacts
```

The opt-in ambient path runs beside, not inside, the Muse Agent:

```text
stable real camera still -> situation policy -> worn-outfit vision
  -> independent garment crops -> metadata recall + visual ReID
  -> atomic wardrobe overlay -> verified catalog image jobs -> Mirror Screen event
```

It never adds a hidden intent router or Agent tool. New garments immediately enter the merged closet as
usable `provisional` records with `unverified` ownership while their image status is `processing`; their real
appearance crops are edited into clean catalog images and compared back to the source. Only verified images
become closet-card primary images. Product-image verification changes image state only: it never confirms
garment identity or ownership. Repeat recognition uses historical real appearances, tolerates metadata label
drift, preserves provisional/unverified status, and does not generate another product image. Observation,
tracking, and recall share a canonical appearance vocabulary for color, pattern, and fit. Free-form English
and Chinese labels are normalized only at comparison time, while visually uncertain color, fit, sleeve,
neckline, length, and material stay
`unknown` and contribute no identity similarity.

Identity resolution keeps recall broad, deterministically removes explicit attribute contradictions, and then
verifies at most three surviving ClosetItems one at a time. The current descriptor is locked before each visual
comparison, and a verifier that changes its reading of the current color/sleeve/neckline is downgraded to
uncertain. Only jointly visible
construction evidence can establish a safe match or difference; occlusion, crop, length, fit, and silhouette
drift cannot silently create a duplicate. Safe same requires both visual evidence and a minimum prior; low-prior
uncertainty no longer blocks a clearly new item, while recent wear raises a candidate's prior without proving
identity and a strong prior vetoes automatic creation. Ambiguous evidence writes no ClosetItem. The latest 200
sanitized decision traces remain available to the signed browser identity for diagnostics.
Duplicate overlay items can be repaired through a dry-run-first, atomic repository merge; the duplicate is
archived as an alias and is excluded from recommendation without deleting its historical appearances or wear.

After two similar frames are independently confirmed by the server as `NO_PERSON_PRESENT`, the browser keeps
a low-resolution empty-scene reference and suppresses ordinary high-resolution ambient uploads. A changed
scene clears suppression and starts a fresh three-sample stability window; a configurable forced probe still
runs every 90 seconds by default so one bad observation cannot silence capture permanently. This guard is
client-local and stores no additional camera image on the server.

More detail is available in [ARCHITECTURE.md](ARCHITECTURE.md), [API_CONTRACT.md](API_CONTRACT.md), and [SKILL_TOOL_POLICY_MATRIX.md](SKILL_TOOL_POLICY_MATRIX.md).

## Requirements

- Node.js 20 or 22. Node 24 is not part of this frozen demo's verified runtime range.
- npm 10. The repository pins `npm@10.9.2`; npm 11 is not part of the verified toolchain.
- An OpenAI API key with access to the configured text, vision, and image models.
- A browser that supports `getUserMedia` for the mirror experience.
- Optional: Volcengine Speech credentials and an enabled TTS speaker for voice mode.

The default model names match the original demo configuration. If one is unavailable to your account, change the corresponding environment variable to a compatible model available to you.

## Quick start

```bash
git clone https://github.com/AndyZhaoly/Muse_Mirror.git
cd Muse_Mirror
npm ci
npm --prefix web ci
cp .env.example .env.local
```

Add a newly created API key to `.env.local`:

```bash
OPENAI_API_KEY=your_key_here
```

Build and launch the single-server demo:

```bash
npm run demo:web
```

Open [http://localhost:8787](http://localhost:8787).

Camera access works on `localhost`. A remote deployment must use HTTPS for browser camera permission.

For the Free Render team-demo Blueprint, shared-passcode protection, required secrets, and smoke-test procedure, see [DEPLOY_RENDER.md](DEPLOY_RENDER.md).

### Optional voice mode

Voice mode is a transport around the same Muse turn API, session, approvals, memory, and conversation history. It does not add a voice agent, planner, or intent router. The browser sends 16 kHz mono PCM to the backend ASR gateway; only the final transcript is submitted through the existing `/api/fashion/turn/stream` flow with `inputSource: "voice"`.

Voice turns add a short-response contract to the same Muse Agent. In the current implementation, both the screen's grounded `result.text` and TTS-safe `result.spokenText` stay concise for voice turns; structured detail remains available in artifacts and cards. Text turns keep the detailed screen-oriented behavior. `spokenText` is deterministically derived after all runtime grounding, including mandatory visual, closet-gap, and fit-uncertainty notices. It never comes from partial deltas or a second LLM call, and conversation history stores only authoritative `result.text`. A future structured dual-output contract may let one model response independently author detailed `text` and short `spokenText`.

Enable it in `.env.local`:

```bash
FASHION_AGENT_ASR_PROVIDER=volcengine
FASHION_AGENT_TTS_PROVIDER=volcengine
VOLC_SPEECH_APP_ID=your_app_id
VOLC_SPEECH_APP_KEY=your_app_key
VOLC_SPEECH_ACCESS_KEY=your_access_key
VOLC_TTS_SPEAKER_ID=your_enabled_speaker_id
VOLC_ASR_END_WINDOW_MS=500
OPENAI_VOICE_REASONING_EFFORT=minimal
```

Accounts may be provisioned with different ASR resource IDs. Keep `VOLC_ASR_RESOURCE_ID` aligned with the resource enabled in the Volcengine console. `VOLC_ASR_END_WINDOW_MS` maps to Volcengine `end_window_size`, accepts 200–2000 ms, and defaults to 500 ms. Invalid values safely fall back to 500 ms. The implementation follows the official [streaming ASR protocol](https://www.volcengine.com/docs/6561/1354869) and [streaming TTS protocol](https://www.volcengine.com/docs/6561/1719100).

`OPENAI_VOICE_REASONING_EFFORT` applies only to voice turns. If the selected Agent model does not support the configured effort, Muse uses the global `OPENAI_REASONING_EFFORT` instead of sending an invalid provider request. Text turns always keep the global effort.

The first click on the microphone requests browser permission. Muse then uses a semi-duplex loop: listening, recognizing, thinking, speaking, then listening again. ASR is stopped while TTS is playing. Full-duplex interruption and wake-word listening are intentionally not part of this version.

For local latency diagnostics, add `?latency=1` to the page URL or set `localStorage.muse_latency_debug = "1"`. The browser logs one safe `[MuseLatency]` summary per voice turn, covering provider utterance end, ASR final, first final-answer delta, result readiness, first TTS audio, playback completion, model rounds, vision usage, character counts, and provider token counts when available. `speech_end` is recorded only from the provider's `utterance_end` event. If that event is absent or late, `speechEndSource` is `unavailable` and `asrFinalizeMs` is omitted rather than fabricated as zero. The logs never include transcript text, answer text, images, audio, cookies, credentials, or reasoning content. Set `FASHION_AGENT_TRACE=true` for matching backend milestones.

## Development mode

Run the API and web app in separate terminals:

```bash
npm run server
```

```bash
npm run web:dev
```

Open [http://localhost:5173](http://localhost:5173). Vite proxies API and generated-asset requests to port `8787`.
The `/api` proxy also forwards WebSocket upgrades for local ASR and TTS development.

Development builds also include a disabled-by-default Mirror Situation policy simulator above the main
workspace. It replays static observations through the pure Outfit Episode reducer and situation policy;
it is not connected to the real camera or closet. Run the same fixtures in the terminal with
`npm run simulate:mirror-situations`.

## Configuration

The checked-in `.env.example` is the complete local template. Important defaults are:

```bash
FASHION_AGENT_RUNTIME=muse
FASHION_AGENT_LLM_PROVIDER=openai
FASHION_AGENT_VISION_PROVIDER=openai
FASHION_AGENT_IMAGE_PROVIDER=openai
FASHION_AGENT_CLOSET_PROVIDER=local
FASHION_AGENT_WEATHER_PROVIDER=mock
FASHION_AGENT_PRODUCT_PROVIDER=disabled
FASHION_AGENT_MOCK_TOOLS=false

FASHION_AGENT_CLOSET_DATA=./data/demo2-wardrobe/wardrobe.json
FASHION_AGENT_DEMO2_PRODUCT_IMAGE_DIR=./data/demo2-product-images
FASHION_AGENT_OUTPUT_DIR=./out
FASHION_AGENT_MEMORY_DATA=./out/muse-memory-v1.json
FASHION_AGENT_AMBIENT_WARDROBE_DATA=./out/ambient-wardrobe-v1.json
FASHION_AGENT_EMPTY_SCENE_THRESHOLD=0.03
FASHION_AGENT_EMPTY_SCENE_CONFIRMATIONS=2
FASHION_AGENT_EMPTY_SCENE_FORCE_PROBE_MS=90000
FASHION_AGENT_PRODUCT_IMAGE_PROVIDER=openai
OPENAI_PRODUCT_IMAGE_MODEL=gpt-image-2
OPENAI_PRODUCT_IMAGE_QUALITY=medium
OPENAI_PRODUCT_IMAGE_SIZE=1024x1024
FASHION_AGENT_PRODUCT_IMAGE_VERIFY_CONFIDENCE=0.84
FASHION_AGENT_IDENTITY_TOP_K=4
FASHION_AGENT_IDENTITY_PAIR_MATCH_CONFIDENCE=0.88
FASHION_AGENT_IDENTITY_SAFE_SAME_MIN_PRIOR=0.55
FASHION_AGENT_IDENTITY_VETO_MIN_PRIOR=0.60
FASHION_AGENT_IDENTITY_MULTIPLE_SAFE_MATCH_MARGIN=0.15
FASHION_AGENT_IDENTITY_MAX_VISUAL_CANDIDATES=3
FASHION_AGENT_IDENTITY_BASE_NEW_CONFIDENCE=0.78
FASHION_AGENT_IDENTITY_STRONG_PRIOR_VETO=0.85
FASHION_AGENT_IDENTITY_NEW_CONFIDENCE_CEILING=0.9
FASHION_AGENT_IDENTITY_TRACE_LIMIT=200
FASHION_AGENT_IDENTITY_STRONG_CONTINUITY_WINDOW_MS=3600000
FASHION_AGENT_IDENTITY_WEAK_CONTINUITY_WINDOW_MS=43200000
FASHION_AGENT_IDENTITY_STRONG_CONTINUITY_WEIGHT=0.08
FASHION_AGENT_IDENTITY_WEAK_CONTINUITY_WEIGHT=0.02

FASHION_AGENT_ASR_PROVIDER=disabled
FASHION_AGENT_TTS_PROVIDER=disabled

# Optional for a public team-demo URL
MUSE_TEAM_DEMO_ACCESS_CODE=
MUSE_TEAM_DEMO_SESSION_SECRET=
```

`FASHION_AGENT_VISUAL_QC=false` reproduces the time-constrained demo behavior in which image QC does not block a generated result. Set it to `true` when you want failed visual checks to block artifacts.

Real product search is disabled by default. The application will not fabricate product prices, brands, purchase links, or availability when no product provider is configured.

Ambient catalog-image generation is a separate capability. The demo configuration enables it with
`FASHION_AGENT_PRODUCT_IMAGE_PROVIDER=openai`: OpenAI edits the stored real garment crop into an isolated
catalog view, then an OpenAI vision comparison must pass before the image is promoted. The UI labels these as
AI-organized closet images rather than merchant product photos. Existing failed items can be regenerated from
the wardrobe card; verified images remain visible after the capture-completion notice disappears. This adds
image-generation and verification cost and never uses text-only generation for closet primary images.

## Validation

Run the complete server and web verification suite:

```bash
npm run check:all
```

This runs skill validation, UI validation, TypeScript checks, unit tests, the server build, service smoke checks, the web typecheck, and the production web build.

## Docker

```bash
docker build -t muse-mirror .
docker run --rm -p 8080:8080 --env-file .env.local muse-mirror
```

Open [http://localhost:8080](http://localhost:8080).

The Docker image includes the standalone wardrobe fixture and canonical garment images. Mount `/app/out` if you want generated artifacts and local conversation data to survive container replacement.

The production server reads Render's `PORT`, binds `0.0.0.0`, and serves React, HTTP APIs, SSE, and ASR/TTS WebSockets from the same process. `GET /healthz` is intentionally independent of OpenAI and Volcengine readiness.

## Data and privacy boundaries

- Continuous live video stays in the browser. While the mirror is active, the app can upload low-frequency still frames to the configured vision provider to maintain a current observation.
- Ambient outfit capture is off until the user accepts its one-time grant. It analyzes only stable single-person worn-outfit frames; it does not record continuous video or treat held/background garments as owned.
- A successful ambient capture stores the selected still as private evidence plus separate real garment crops, provisional closet items, outfit captures, and wear events. Generated catalog images remain `processing`/`needs_review` until source-image verification passes. Revoking the grant stops future capture; the developer reset deletes the current browser user's overlay.
- The camera does not record audio. Microphone access begins only after voice mode is enabled.
- Raw ASR audio and streamed TTS audio are kept in memory only and are not written to disk by Muse Mirror.
- Speech credentials remain on the backend and are never included in `/api/voice/status`.
- OpenAI Responses calls use `store: false` in the Muse runtime.
- Try-on requires photo-use permission. Synthetic full-body extension has a separate confirmation path.
- Generated images, captured frames, memory data, and conversation data are written under ignored local directories and are not committed.
- Team-demo access uses a signed HttpOnly cookie when `MUSE_TEAM_DEMO_ACCESS_CODE` is configured. The access code is never stored in browser localStorage.
- Ambient data and private garment assets use a server-signed, HttpOnly browser identity tied to the team session. The client UUID still groups text/voice history, but it cannot select another ambient owner.
- AI concept items are labeled and are never presented as real products or closet items.
- Try-on output is a styling preview, not a sizing, tailoring, or body-measurement guarantee.
- Never commit `.env.local`. Rotate any API key that has appeared in chat, logs, screenshots, or terminal output.

## Persistence and demo limitations

- Conversation history and explicit memories use a local JSON store under `out/`.
- Ambient closet overlays and capture history use `FASHION_AGENT_AMBIENT_WARDROBE_DATA` under `out/` by default.
- Render Free storage is ephemeral; restarts, redeploys, and spin-down lifecycle events can remove `out/` data.
- Live session, pending visual requests, approvals, and visual-version pointers are in memory and reset when the server restarts.
- Weather is mocked by default.
- Product search is disabled by default.
- The current closet service generates and ranks a small set of grounded candidates before Muse makes the final natural-language selection.
- This is an investor-demo codebase, not a production virtual try-on or production memory platform.
- Voice mode is semi-duplex and starts TTS only after the final grounded result. It does not implement barge-in, wake words, acoustic echo cancellation beyond browser constraints, sentence-level early TTS, or token-by-token speech.

## Repository layout

```text
src/server/       Muse runtimes, API server, provider readiness
src/services/     closet, vision, image, weather, product, skill services
src/runtime/      session state, memory store, artifacts, tool logging
src/tools/        legacy and reusable tool implementations
skills/           fashion-domain skill documents
web/              React mirror and conversation UI
data/             standalone wardrobe, item images, mock providers
tests/            runtime, policy, grounding, memory, and replay tests
out/              ignored generated artifacts and local state
```

## Security note

This repository intentionally contains no credentials. Use a fresh API key in `.env.local` or your deployment platform's secret manager. If a key was ever shared in a chat or log, revoke it before running this project.
