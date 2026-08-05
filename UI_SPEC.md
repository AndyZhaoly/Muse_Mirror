# Camera-first Fashion Agent UI specification

## Product intent

This is a real conversational styling Agent with a visual mirror—not a fixed wizard, chatbot clone, ecommerce page, or admin dashboard.

The user talks naturally. The main model decides whether to answer directly, load a focused fashion Skill, call zero, one, or several external Tools, or ask one necessary question. The frontend must not recreate this decision process with a keyword router, intent-classifier pipeline, mode enum, or mandatory sequence.

## Required layout

### Desktop

- **Upper left, 58–64%:** dominant `LiveMirrorPanel`
  - local real-time camera;
  - analyzed snapshot;
  - outfit visual;
  - AI try-on preview;
  - visual provenance and controls.
- **Upper right, 36–42%:** current-moment `MirrorAgentCanvas`
  - the latest user request;
  - Muse's current commentary, streamed answer, or local typing state;
  - one current approval interruption when action is required;
  - a compact reference to the latest visual result;
  - voice state and composer fixed to the Canvas bottom.
- **Below both columns:** expandable `ConversationDrawer`
  - the complete message history;
  - tool Activity, recommendation explanations, memory disclosures, and compact artifacts;
  - collapsed by default so history does not compete with the mirror task.

### Mobile

1. mirror / visual result at top;
2. current-moment Agent Canvas below it;
3. expandable complete-conversation drawer after the Canvas;
4. composer at the bottom of the current-moment Canvas.

No horizontal overflow.

## Visual direction

Aim for a calm editorial styling studio:

- warm off-white, stone, taupe, espresso, muted olive, and denim accents;
- charcoal body text;
- generous image surfaces;
- refined serif display type with readable system sans-serif text;
- subtle borders, depth, and motion;
- premium but approachable.

Avoid:

- blue-purple “AI SaaS” gradients;
- dense dashboard chrome;
- neon glow;
- excessive glassmorphism;
- small cramped product tiles;
- exposed JSON, logs, Skill names, Tool names, or internal orchestration.

## Camera behavior

The browser `<video>` is a local real-time preview. Do not continuously send frames to the model.

Capture a still only when:

- the user clicks `拍照分析`;
- the current request genuinely requires visual context;
- an optional throttled auto-analysis setting is explicitly enabled.

Default camera rules:

- no audio;
- front camera mirrored by default;
- clear permission explanation;
- pause/resume, snapshot, mirror, upload fallback, and retry;
- visible local-preview status;
- camera denial and unavailable-device fallback.

## Left visual-stage states

Support and clearly differentiate:

1. permission required;
2. camera starting;
3. live local preview;
4. paused preview;
5. snapshot analyzing;
6. analyzed snapshot with compact chips;
7. selected outfit / flat-lay concept;
8. real closet-item image;
9. real product image;
10. AI outfit concept;
11. AI try-on preview;
12. image-generation loading;
13. recoverable error.

Provenance labels:

- `实时镜子`
- `已分析快照`
- `衣柜实拍`
- `真实商品图`
- `AI 搭配示意 · 仅供风格参考`
- `AI 上身预览 · 仅供视觉参考`

Try-on disclaimer:

> 重点参考颜色、层次和整体感觉；实际尺码、面料垂坠和剪裁以真实试穿为准。

Never present an AI image as a real garment or product image.

## Mirror Agent Canvas states

Support:

- the latest user text, without replaying the full user history;
- current assistant commentary or final-answer streaming;
- a local typing indicator before the first server event;
- one approval/consent interruption;
- current voice capture/transcript state;
- compact latest-artifact acknowledgement;
- persistent composer.

The Canvas is not a second transcript. It must not render `MessageBubble`, full Activity history,
decision summaries, memory disclosures, or every past artifact. Those belong in the
`ConversationDrawer`. Commentary may temporarily replace the current Muse caption while a tool
turn is active, but it does not become a persisted assistant answer.

## Complete conversation drawer

The lower drawer preserves the existing conversation experience without making it the primary
mirror surface:

- every assistant and user message remains available;
- MessageBubble rendering, ActivityTimeline, recommendation details, memory usage, notices, and
  artifact strips retain their existing behavior;
- the drawer is collapsed by default and remains mounted as part of the current page;
- its toggle exposes `aria-expanded` and `aria-controls`, and the controlled region has a stable ID;
- pending photo approval appears only in the current-moment Canvas, never as a duplicate in the
  drawer.

Suggested quick actions:

- 我这样可以吗？
- 帮我搭一套
- 看上身效果
- 换个更松弛的版本
- 找类似单品

Quick actions submit ordinary user messages. They are discovery shortcuts, not production routing logic.

## Try-on consent and resume

When the user asks to see themselves wearing an outfit:

1. if photo-use or AI-generation permission is missing, show an approval card in chat;
2. do not call the image provider before approval;
3. in production, resume the same serialized Agent run after the decision;
4. show generation loading on the left stage;
5. render the generated try-on on the left;
6. keep explanation and actions on the right.

Consent copy:

> 生成上身预览需要使用当前照片。默认不长期保存原图。AI 预览仅供视觉参考，不代表真实尺码、面料垂坠或剪裁。

Actions:

- `同意并生成`
- `取消`

Browser-only approval UI is not sufficient; the backend Policy layer must enforce permission, ownership, session scope, and generation budget.

## Artifact placement

Large visual artifacts belong on the left:

- current snapshot;
- selected real garment/product image;
- AI outfit concept;
- AI try-on preview.

Compact historical content belongs in the complete conversation drawer:

- recommendation summary;
- item thumbnails;
- product metadata;
- explanation;
- next-action buttons.

The currently actionable approval card belongs in the Mirror Agent Canvas and is rendered once.

Existing backend `UiArtifact` mapping:

- `item_grid` → real closet thumbnails, selectable into left stage;
- `product_cards` → factual product cards;
- `image` + `ai_outfit_visual` → left stage with AI concept label;
- `image` + `ai_try_on` → left stage with AI try-on label/disclaimer;
- `notice` → calm inline status/error.

## Included React starter

`web/` contains a runnable Vite + React + TypeScript shell with:

- local camera permission and preview;
- pause, mirror, and snapshot controls;
- analysis animation and chips;
- outfit recommendation card;
- try-on consent card;
- mock try-on and color edit;
- responsive mirror-left / current-moment Canvas-right / full-conversation-below layout;
- accessible focus states and reduced-motion support.

The scenario functions are UI fixtures only. Replace them with one adapter to the existing autonomous turn and approval-resume APIs. Do not promote mock handlers into an intent router.

## Integration contract

Conceptual endpoints:

```text
POST /api/fashion/turn
POST /api/fashion/resume
```

The frontend sends:

- session and user IDs;
- ordinary user text;
- optional captured-frame attachment or stored image ID;
- explicit turn-level permissions.

The frontend renders:

- natural-language reply;
- artifacts separately from text;
- approval interruption;
- resumed result after a decision.

The end user must never see raw tool calls, internal Skill selection, serialized run state, or debug JSON.

## Quality and acceptance

Required commands:

```bash
npm run check
npm --prefix web run typecheck
npm --prefix web run build
```

Manual acceptance:

- desktop camera is dominant on the left and Agent is on the right;
- the right Canvas shows the current interaction instead of duplicating the full transcript;
- complete history expands below both primary surfaces and is collapsed by default;
- approval is rendered once in the current-moment Canvas;
- permission, denial, live, pause, snapshot, retry, and upload fallback are handled;
- mock analysis, recommendation, consent, try-on, and edit work;
- real and AI image sources are visibly distinct;
- try-on requires approval;
- mobile layout is usable;
- keyboard focus is visible;
- reduced-motion is respected;
- no internal tool names or JSON appear;
- visual result feels like a modern styling mirror, not a SaaS dashboard.
