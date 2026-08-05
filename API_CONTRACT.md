# API contract

The public turn and approval-resume API remains compatible with v0.4. Skill loading is internal and does not add a user-facing workflow.

## Deployment health and team access

`GET /healthz` is always public and returns a fast provider-independent response:

```json
{
  "ok": true,
  "service": "muse-mirror",
  "version": "<commit-or-package-version>",
  "timestamp": "<ISO timestamp>"
}
```

When `MUSE_TEAM_DEMO_ACCESS_CODE` is configured, the following bootstrap endpoints remain public:

- `GET /api/demo-auth/status`
- `POST /api/demo-auth/login` with `{ "accessCode": "..." }`
- `POST /api/demo-auth/logout`

A successful login sets a signed HttpOnly, SameSite=Lax session cookie. It is Secure in production. All fashion, conversation, memory, generated-asset, SSE, ASR WebSocket, and TTS WebSocket requests require that cookie. Access codes and session secrets are never returned by an API.

When the access code is not configured, the gate is disabled for local development.

## Ambient outfit capture

Ambient capture is an authenticated background capability outside the Muse Agent tool loop. All endpoints
are scoped by the browser `userId`; production deployments with the team gate also require its signed cookie.

- `GET /api/ambient-capture/state?userId=...` returns grant state, counts, current episode, and the last safe outcome.
- `POST /api/ambient-capture/grant` with `{ userId, enabled }` creates or revokes the one-time grant.
- `POST /api/ambient-capture/frame` accepts a real camera still, frame metadata, local stability evidence, and active-task status.
- `POST /api/ambient-capture/episode/end` ends the current session episode when the user leaves or pauses the mirror.
- `POST /api/ambient-capture/debug/reset` deletes only the requesting user's ambient overlay and capture records.

The frame endpoint may return `disabled`, `observing`, `deferred`, `privacy_paused`,
`insufficient_evidence`, `ambiguous`, `committed`, `recognized`, `mixed`, `already_committed`,
`episode_ended`, or `unavailable`. Only committed/recognized outcomes may carry an
`OutfitCaptureCompletedEvent`; the UI must never synthesize that event from a model answer or an optimistic
client state. Uploaded request frames are temporary. A selected evidence image is copied into generated
storage only as part of a successful capture proposal.

## Start a turn

```ts
import { runFashionTurn } from './src/index.js';

const result = await runFashionTurn({
  sessionId: 'session_123',
  userId: 'user_123',
  inputSource: 'text',
  message: '那我穿上是什么样？',
  attachments: [
    {
      id: 'photo_1',
      kind: 'user_photo',
      localPath: './examples/mock_user_photo.jpg',
      mimeType: 'image/jpeg',
      makeCurrent: true,
    },
  ],
  permissions: {
    allowVisualAnalysis: true,
    allowAiImageGeneration: true,
    allowPhotoUseForTryOn: true,
    allowPersistentMemory: false,
  },
});
```

## Completed result

```json
{
  "status": "completed",
  "text": "我给你做了这套的上身预览……",
  "spokenText": "上身预览已经放在屏幕上了。",
  "artifacts": [
    {
      "type": "image",
      "source": "ai_try_on",
      "url": "./out/tryon_x.png",
      "aiGenerated": true,
      "disclaimer": "AI 预览仅供风格参考……"
    }
  ],
  "state": {
    "activeOutfitId": "outfit_1",
    "lastGeneratedImageId": "image_9"
  }
}
```

`inputSource` is the canonical interaction-mode field. It accepts `text` or `voice` and defaults to `text` for older clients. Both modes use the same session, conversation, memory, approval, tool, and grounding path.

`text` is the authoritative grounded answer shown on screen and saved in conversation history. Voice turns additionally return `spokenText`, a deterministic TTS-safe form of the final `text`. Text turns may omit it. Clients must not synthesize commentary, activity, artifacts, streamed deltas, or an ungrounded intermediate answer.

## Streaming turn events

`POST /api/fashion/turn/stream` uses the existing SSE event names:

- `commentary`: an optional public pre-tool sentence; it is not assistant message text.
- `activity`: actual runtime/tool lifecycle events.
- `delta`: an incremental OpenAI `final_answer` text fragment, written as soon as it arrives.
- `artifact`: grounded UI artifacts.
- `result`: the completed, authoritative turn result.
- `error`: a product-safe failure.

Clients may concatenate `delta` payloads for immediate display, but must replace that temporary text with `result.text` when `result` arrives. `result.text` may differ because the runtime applies visual grounding, closet-gap, and fit-uncertainty guards after model completion. Only `result.text` is stored in conversation history.

If the provider does not expose a stream or an output item's phase cannot be safely identified, the server sends one complete `delta` after completion. Commentary, reasoning, function arguments, and encrypted reasoning content never enter `delta`.

## Approval required and resume

Sensitive Tools can return `status: "approval_required"`, approval items, and `serializedRunState`. Resume with `resumeFashionTurn(...)` and the user's decisions. Skill loading itself requires no approval because it reads bundled instructions and performs no external action.

## UI artifacts

- `item_grid`: real owned-item images;
- `product_cards`: real catalog products;
- `image`: AI outfit concept or try-on preview;
- `notice`: limitation, error, or disclaimer.

The model should not hand-write artifact URLs in its natural-language response.

## Voice transport

Voice input and output wrap the existing turn API; they do not create a second conversation or a second Agent runtime.

On HTTPS deployments, clients connect with `wss://` to the same host and port. When the team gate is enabled, both WebSocket upgrade requests require the same signed session cookie as HTTP APIs.

### Capability status

`GET /api/voice/status` returns provider-independent readiness without credentials:

```json
{
  "ok": true,
  "mode": "semi_duplex",
  "asr": {
    "provider": "volcengine",
    "configured": true,
    "ready": true,
    "sampleRate": 16000,
    "resourceId": "volc.seedasr.sauc.duration",
    "endWindowMs": 500
  },
  "tts": {
    "provider": "volcengine",
    "configured": true,
    "ready": true,
    "sampleRate": 24000,
    "model": "seed-tts-2.0-standard",
    "resourceId": "seed-tts-2.0",
    "speakerConfigured": true
  }
}
```

### Streaming ASR WebSocket

Connect to `WS /api/voice/asr` and send:

```json
{"type":"start","language":"zh-CN","format":"pcm_s16le","sampleRate":16000,"channels":1}
```

After `{"type":"ready"}`, send binary PCM16LE mono chunks. End the utterance with `{"type":"stop"}`. Server JSON events are `ready`, `partial`, `final`, `utterance_end`, and `error`. Only a non-empty `final` transcript enters `/api/fashion/turn/stream`; partial transcripts are temporary UI state.

### Streaming TTS WebSocket

Connect to `WS /api/voice/tts` and send:

```json
{"type":"start","text":"Muse 的最终回答"}
```

The server returns `ready` with PCM format metadata, binary PCM16LE audio chunks, then `done`; failures use `error`. The browser must wait until all queued PCM buffers finish playing before resuming ASR.

Activity, commentary, deltas, artifacts, errors, and approval prompts are never sent to TTS. Only the completed turn's `result.spokenText ?? result.text` is spoken. The screen and history continue to use authoritative `result.text`.

Current voice behavior keeps both the screen answer and spoken answer concise; cards and artifacts carry structured detail. Text turns retain detailed screen-oriented answers. `spokenText` is assembled deterministically after grounding so mandatory visual-unavailable, closet-gap, and fit-uncertainty facts cannot be lost to sentence limits. A future one-response structured dual-output design may independently author detailed `text` and short `spokenText`; this version does not make a second model request.

Real-time final-answer deltas improve webpage time to first visible text. They do not reduce tool/model completion time, and TTS still waits for the complete authoritative result.

Voice turn requests may include a safe `traceId`. Completed results can include latency telemetry with relative millisecond milestones, model round count, whether vision ran, response character counts, and provider token counts when available. Browser `speech_end` means a provider `utterance_end` event only. Without that event, `speechEndSource` is `unavailable` and `asrFinalizeMs` is omitted. Telemetry never contains the user transcript, answer body, image/audio data, credentials, cookies, or reasoning content.
