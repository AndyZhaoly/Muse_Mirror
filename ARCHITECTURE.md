# Architecture v0.5

## Goal

The user talks to one natural stylist. There is no visible workflow and no deterministic intent router.

```text
Conversation + session state + skill catalog + tool catalog
                         ↓
                    Main LLM
          ┌──────────────┼──────────────┐
      direct answer   load Skill   call Tool(s)
                                      ↓
                              Policy / validation
                                      ↓
                           provider, data, artifact
```

## Five layers

### 1. System

`prompts/system_prompt.md` contains always-on identity, interaction, safety, and capability-boundary rules. Keep it compact enough to apply every turn.

### 2. Runtime Skills

`skills/` contains stable professional methods:

- `style-diagnosis`
- `occasion-styling`
- `outfit-review`
- `try-on-preparation`

The main prompt receives only metadata. `load_fashion_skill` loads full instructions or a reference when the model decides they are useful. This is progressive disclosure, not a fixed router.

### 3. Tools and services

`src/tools/` exposes narrow capabilities. `src/services/` owns provider or data implementations. Tools cover external vision, closet, weather, catalog, image generation, state changes, and independent verification.

### 4. State and data

Agents SDK Session stores conversation history. `SessionStateStore` stores current images, selected outfit, previous generated image, preferences, pending UI artifacts, and logs. Catalogs and closets remain data, not Skills.

### 5. Policy

Consent, user/session ownership, path isolation, persistent-memory approval, AI-image permission, and future cost/transaction rules are enforced in code. The model may request an action but cannot grant itself permission.

## Two distinct skill directories

- `.agents/skills/` helps Codex modify this codebase consistently.
- `skills/` is loaded by the product fashion agent at runtime.

## Independent verifier

Ordinary outfit review is a Skill. `verify_outfit_quality` remains a Tool only for structured, repeatable, logged verification, such as important occasions, shopping, or pre-generation checks.

## Vision modes

- Stored image + separate vision provider: use `analyze_current_view` Tool.
- Image directly in main model multimodal input: analyze directly under `style-diagnosis`; the vision Tool becomes unnecessary.

## Approval resume

Sensitive tools can pause the run through Agents SDK approvals. The serialized RunState is resumed after a user decision rather than restarting the conversation turn.

## OpenAI final-answer streaming

The Muse OpenAI runtime keeps one Responses API tool loop and tracks every streamed message item by `item_id` / `output_index` and assistant `phase`.

```text
Responses stream
  ├─ commentary message       → commentary UI only
  ├─ function call            → runtime tool lifecycle
  └─ final_answer text delta  → onDelta → SSE delta → live assistant text
                                      ↓
                              response completed
                                      ↓
                     grounding and product-policy calibration
                                      ↓
                          authoritative result.text
```

Only text explicitly associated with `phase: "final_answer"` is emitted incrementally. Unknown-phase text is buffered until its phase is known; unresolved text is never guessed from wording and falls back to one complete response after completion. The runtime still collects the complete response output for stateless tool replay, incomplete handling, grounding, history, and final result construction.

Automatic retry is allowed only before any final-answer delta has become visible. Once visible text has been emitted, a failed stream ends safely instead of silently restarting and duplicating the answer. Trace mode records timing milestones and opaque IDs only; it never records prompts, reasoning, images, credentials, or audio.

## Voice-first response mode

Voice is a semi-duplex transport over the same Muse Agent and conversation path:

```text
Volcengine ASR final transcript
        ↓ inputSource: voice + traceId
same Responses API tool loop + voice-only short-answer contract
        ↓
grounded authoritative result.text + deterministic result.spokenText
        ↓
screen uses text; Volcengine TTS uses spokenText ?? text
```

The browser never sends ASR partials into the Agent and never speaks streamed model deltas. Voice turns currently produce concise screen text and concise spoken text, while artifacts carry structured detail; text turns retain detailed screen-oriented responses. `spokenText` is built only after visual/closet/fit grounding, preserves priority-ordered critical notices, and is not stored as a second history message. It uses deterministic cleanup rather than a second model request. A future one-response structured dual-output contract may independently author detailed `text` and short `spokenText`. `OPENAI_VOICE_REASONING_EFFORT` is resolved against model capability before each voice request; text turns retain the global effort. Volcengine endpoint detection uses the backend-configured `end_window_size` (500 ms by default).

One safe trace ID links browser speech/ASR/TTS milestones to backend model/tool milestones. Browser `speech_end` is recorded only from the provider's `utterance_end`; if unavailable, ASR finalization latency is omitted rather than inferred. Detailed summaries are opt-in (`?latency=1` or localStorage), while backend emission reuses `FASHION_AGENT_TRACE`. Neither side records transcript or answer content, media, credentials, cookies, or reasoning.

## Mirror Situation policy simulator

PR7 introduces a provider-independent policy seam for future camera-first behavior. It is deliberately
separate from the Muse Agent, vision providers, closet services, and persistence:

```text
MirrorSituationObservation (fixture/upstream facts only)
                    ↓
          OutfitEpisode reducer
                    ↓
      decideMirrorSituation() pure policy
                    ↓
        MirrorSituationDecision
                    ↓
developer simulator + optional Mirror Screen presentation hint
```

`MirrorSituationObservation` may state upstream facts or inferences such as person count, whether the
person is believed to be the known user, motion, worn versus held garments, frame quality, closet-match
status, current Agent task, and privacy risk. It never states that an item should be saved, that the user
owns it, or that Muse should interrupt. In particular, `closetMatch: "unmatched"` is not ownership evidence.

`OutfitEpisode` is an in-memory domain value in this PR. Its reducer accepts explicit events and reaches
`stable` only after consecutive reliable observations with the same garment-presentation signal. It does
not call a clock, provider, storage, or session service and is not persisted.

The situation policy is deterministic and read-only. It returns an action, reason codes, interruption
posture, observation/privacy state, and eligibility for a wear record, temporary garment candidate, or
future closet persistence. `eligible` remains a decision only: PR7 does not write a wear event, candidate,
episode, or closet item. Closet persistence additionally requires confirmed ownership and explicit
permission.

Fixed scenarios live in `src/policy/mirrorSituationScenarios.ts` and can be run with:

```bash
npm run simulate:mirror-situations
```

Vite development mode exposes the same fixtures in a developer-only selector. The selector is off by
default and only projects the selected decision through `deriveMirrorScreenState()`. It performs no camera
capture, model call, Agent turn, tool call, browser persistence, or business-state mutation. No situation
observation is connected to the real camera in this PR.

## Ambient outfit capture vertical slice

PR8 connects a narrowly supported, explicitly authorized background capture path to the PR7 policy seam.
It remains separate from the Muse Agent and adds no Agent tool or language router:

```text
real browser camera
        -> local pixel stability detector
        -> high-quality still capture packet
        -> deterministic situation-policy preflight
        -> real worn-outfit observation provider
        -> independent Sharp garment crops (appearance evidence)
        -> metadata Top-K recall
        -> real-image garment verifier
        -> deterministic capture proposal validator
        -> Stage A atomic per-browser wardrobe commit
        -> Stage B image-edit product generation + visual verification
        -> verified primary image update
        -> OutfitCaptureCompletedEvent / processing state
        -> Mirror Screen completion card
```

The path runs only after a one-time `ambient-worn-garments-v1` grant. The grant narrowly means that,
in the single-user demo context, garments visibly worn by the browser user may be recorded as provisional
closet items. It does not cover held garments, guests, multi-person frames, identity inference, or continuous
video recording. The client uploads a still only after three stable local pixel samples; the server requires a
fresh packet, one person, good three-quarter/full-body coverage, a complete worn outfit, and two consistent
garment-track observations. Active Agent/image tasks defer the capture, and multi-person observations enter
privacy pause.

The image model has three non-interchangeable roles: `capture_evidence` is the selected full still,
`garment_appearance` is an independently cropped real garment used for identity and image editing, and
`canonical_product` is a cleaned catalog image. Only a canonical image whose source-crop comparison passes
the product verifier can become `ClosetItem.imageUrl`. Full-person evidence and raw crops never become a
closet card.

`OutfitObservationProvider` reports visual facts only. Identity first recalls a small Top-K set from slot,
category, color, and pattern, then compares the current real crop with historical real appearances in one
strict visual-verifier call. Base catalog images are a fallback for fixture items. Generated product images
may assist display but are never the sole identity ground truth. `same`, `different`, and `uncertain` map to
`matched_existing`, `new_to_closet`, or `ambiguous` under configured thresholds; ambiguous outcomes write
nothing.

`JsonUserWardrobeRepository` owns the signed-browser overlay. Stage A atomically writes provisional
`ClosetItem`, appearance, capture, wear, evidence, and audit records with an idempotency key. Stage B keeps
independent product-image jobs so a restart or developer retry cannot duplicate the wardrobe transaction.
The recommendation runtime reads the same signed-browser overlay as ambient capture. A new-item completion
card displays product images only after all required jobs are verified; repeat recognition reuses existing
primary images without another generation call.

This is a constrained investor-demo vertical slice, not general wardrobe ingestion. Face ID, household
identity, held-garment capture, changing-clothes detection, multi-person tracking, trained FashionCLIP ReID,
and cross-device persistence remain out of scope. The current visual verifier is an API-backed demo path,
not a production biometric or garment-identification claim.
