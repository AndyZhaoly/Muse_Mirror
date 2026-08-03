# API contract

The public turn and approval-resume API remains compatible with v0.4. Skill loading is internal and does not add a user-facing workflow.

## Start a turn

```ts
import { runFashionTurn } from './src/index.js';

const result = await runFashionTurn({
  sessionId: 'session_123',
  userId: 'user_123',
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
    "resourceId": "volc.seedasr.sauc.duration"
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

Activity, commentary, deltas, artifacts, errors, and approval prompts are never sent to TTS. Only the completed turn's `result.text` is spoken.
