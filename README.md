# Muse Mirror

Muse Mirror is a camera-first conversational fashion agent demo. It combines a React mirror UI, an OpenAI Responses API tool loop, grounded wardrobe recommendations, visual observation, AI concept images, try-on previews, conversation history, and explicit user memory.

This repository is a standalone snapshot of the investor demo. It includes the demo wardrobe metadata and 37 canonical garment images required to reproduce the closet experience. It does not include API keys, user photos, generated images, or conversation data.

## What is included

- One Muse main agent with no keyword router or separate planning-model call.
- OpenAI Responses API streaming and native function-calling loop.
- Optional Volcengine streaming ASR and TTS in a semi-duplex voice loop.
- Live local camera preview with low-frequency still-frame observation.
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

### Optional voice mode

Voice mode is a transport around the same Muse turn API and conversation history. It does not add a voice agent, planner, or intent router. The browser sends 16 kHz mono PCM to the backend ASR gateway; only the final transcript is submitted through the existing `/api/fashion/turn/stream` flow. After the turn completes, only `result.text` is sent to TTS and played as 24 kHz mono PCM.

Enable it in `.env.local`:

```bash
FASHION_AGENT_ASR_PROVIDER=volcengine
FASHION_AGENT_TTS_PROVIDER=volcengine
VOLC_SPEECH_APP_ID=your_app_id
VOLC_SPEECH_APP_KEY=your_app_key
VOLC_SPEECH_ACCESS_KEY=your_access_key
VOLC_TTS_SPEAKER_ID=your_enabled_speaker_id
```

Accounts may be provisioned with different ASR resource IDs. Keep `VOLC_ASR_RESOURCE_ID` aligned with the resource enabled in the Volcengine console. The implementation follows the official [streaming ASR protocol](https://www.volcengine.com/docs/6561/1354869) and [streaming TTS protocol](https://www.volcengine.com/docs/6561/1719100).

The first click on the microphone requests browser permission. Muse then uses a semi-duplex loop: listening, recognizing, thinking, speaking, then listening again. ASR is stopped while TTS is playing. Full-duplex interruption and wake-word listening are intentionally not part of this version.

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

FASHION_AGENT_ASR_PROVIDER=disabled
FASHION_AGENT_TTS_PROVIDER=disabled
```

`FASHION_AGENT_VISUAL_QC=false` reproduces the time-constrained demo behavior in which image QC does not block a generated result. Set it to `true` when you want failed visual checks to block artifacts.

Real product search is disabled by default. The application will not fabricate product prices, brands, purchase links, or availability when no product provider is configured.

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

## Data and privacy boundaries

- Live video stays in the browser. The app uploads individual still frames only when visual capability is active.
- The camera does not record audio. Microphone access begins only after voice mode is enabled.
- Raw ASR audio and streamed TTS audio are kept in memory only and are not written to disk by Muse Mirror.
- Speech credentials remain on the backend and are never included in `/api/voice/status`.
- OpenAI Responses calls use `store: false` in the Muse runtime.
- Try-on requires photo-use permission. Synthetic full-body extension has a separate confirmation path.
- Generated images, captured frames, memory data, and conversation data are written under ignored local directories and are not committed.
- AI concept items are labeled and are never presented as real products or closet items.
- Try-on output is a styling preview, not a sizing, tailoring, or body-measurement guarantee.
- Never commit `.env.local`. Rotate any API key that has appeared in chat, logs, screenshots, or terminal output.

## Persistence and demo limitations

- Conversation history and explicit memories use a local JSON store under `out/`.
- Live session, pending visual requests, approvals, and visual-version pointers are in memory and reset when the server restarts.
- Weather is mocked by default.
- Product search is disabled by default.
- The current closet service generates and ranks a small set of grounded candidates before Muse makes the final natural-language selection.
- This is an investor-demo codebase, not a production virtual try-on or production memory platform.
- Voice mode is semi-duplex. It does not implement barge-in, wake words, acoustic echo cancellation beyond browser constraints, or token-by-token speech.

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
