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
