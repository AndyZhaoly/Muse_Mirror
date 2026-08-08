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
        -> canonical observation + visibility gate
        -> metadata Top-K recall
        -> deterministic contradiction exclusion
        -> candidate-specific real-image verifier (0-3 pairs)
        -> prior-weighted identity decision
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
fresh packet, one person, good three-quarter/full-body coverage, at least one substantially visible garment,
and two consistent garment-track observations. A `barely` visible or coverage-incompatible slot is discarded
before identity resolution and does not make another clear garment ambiguous. Active Agent/image tasks defer the capture, and multi-person observations enter
privacy pause.

The browser's empty-scene guard is a deterministic upload optimization, not a person detector. One
`NO_PERSON_PRESENT` result creates only a candidate. Two similar server-confirmed results are required before
ordinary uploads are suppressed. Low-resolution scene difference immediately clears candidate/confirmed
state, resets capture backoff, and starts a new three-sample stability window. Confirmed empty scenes still
send a forced probe on a configurable TTL (90 seconds by default). Camera pause, capture disable, or MediaStream
replacement clears the guard. The client diagnostic panel exposes confirmation count, skip/probe counts,
scene difference, configured threshold, confirmation time, and observed re-entry latency.

The image model has three non-interchangeable roles: `capture_evidence` is the selected full still,
`garment_appearance` is an independently cropped real garment used for identity and image editing, and
`canonical_product` is a cleaned catalog image. Only a canonical image whose source-crop comparison passes
the product verifier can become `ClosetItem.imageUrl`. Full-person evidence and raw crops never become a
closet card.

`OutfitObservationProvider` reports visual facts only. Its strict schema uses one canonical vocabulary for
color, pattern, fit, sleeve, neckline, length class, and material class; uncertain or legacy values normalize
to `unknown` and cannot trigger a contradiction. Identity uses wide metadata recall, then assigns each
candidate a `strong`, `plausible`, or `fallback` tier. Before spending a visual call, deterministic rules
exclude only explicit color/pattern, distant sleeve, distant neckline-family, or short/long contradictions.
Excluded candidates remain visible in the trace and count as safely ruled out, but a total effective prior of
`0.85` or more still blocks silent item creation. Every visual request compares the current real crop with
exactly one ClosetItem and at most two of that item's recent real appearances. Different ClosetItems are never
sent in the same verifier request, so unrelated fallback candidates cannot change a strong candidate's verdict.
Base fixture items may use their verified catalog image only when no real appearance exists; generated product
images are never the sole identity ground truth for a user item.

The pairwise verifier receives the canonical current descriptor as locked input and repeats its own current
color, sleeve, and neckline reading in strict structured output. A far contradiction between that reading and
the locked descriptor invalidates the verdict as `VERIFIER_INCONSISTENT_CURRENT_READ`. It otherwise returns
structured feature visibility and relations. Server normalization treats covered
or cropped details as `unknown`, caps length/fit/silhouette evidence at weak, and requires jointly visible
medium/strong construction evidence for a safe match or difference. An AI confidence value is a routing signal,
not a calibrated probability. The default match threshold remains `0.88`, and safe same additionally requires
an effective metadata/continuity prior of at least `0.55`. At most three surviving candidates receive visual
verification. Multiple safe matches require a `0.15` prior lead or resolve as ambiguous. The required different threshold rises
from `0.78` with the candidate's effective prior. A candidate seen in the immediately previous same-slot capture
within 60 minutes receives a `0.08` continuity prior; a 12-hour WearEvent receives `0.02`. These priors affect
ranking and auto-create safety only, never establish a match. Only surviving candidates with an effective prior
of at least `0.60` can veto creation; lower-prior uncertainty cannot indefinitely block a clearly new garment.
An effective prior of at least `0.85` prevents
silent auto-creation and yields `ambiguous`. `uncertain` never creates an item, and fallback candidates cannot
decide whether a garment is new.

Each resolution persists a bounded, sanitized `GarmentIdentityDecisionTrace` containing recall scores, tiers,
reference asset IDs, raw and normalized pairwise evidence, downgrade reasons, thresholds, latency, and final
reason codes. The repository retains the latest 200 traces per browser user without image payloads, prompts,
absolute paths, or user IDs. `FASHION_AGENT_TRACE=true` emits the same redacted decision summary to server logs.
The signed-browser diagnostics route exposes only the current user's traces.

When ambient diagnostic retention is enabled (implicitly by `FASHION_AGENT_TRACE=true`, unless explicitly
overridden), the asset service copies each stable identity-attempt frame and its garment crops into an isolated,
per-browser reproduction bundle before business-state resolution. A redacted manifest links frame, observation,
bounding box, and opaque asset IDs without storing raw user IDs or absolute paths. The normal transient assets
are still deleted on ambiguous/failed outcomes; diagnostic copies are separately capped by
`FASHION_AGENT_AMBIENT_CAPTURE_DIAGNOSTIC_LIMIT` and intentionally survive wardrobe reset for local replay.

Observation, garment-track continuity, and identity recall use the same canonical appearance vocabulary.
The structured vision schema includes explicit `unknown` values for color, fit, sleeve, neckline, length, and
material instead of forcing weak
evidence into a named bucket. Legacy and current descriptors are normalized at comparison time; persisted
records are not rewritten. Exact color buckets score `1`, neighboring buckets score `0.6`, and unknown or
unrelated colors score `0`. A neighboring color alone cannot preserve a track without stronger silhouette,
distinctive-detail, or non-generic pattern evidence. Jumpsuits consistently use the one-piece `dress` slot
and are never normalized as accessories.

`JsonUserWardrobeRepository` owns the signed-browser overlay. Stage A atomically writes an active, searchable
`ClosetItem` whose identity is `provisional`, ownership is `unverified`, and image state is `processing`, plus
appearance, capture, wear, evidence, and audit records with an idempotency key. These three state dimensions
are independent. A Stage B verification pass may set only `imageStatus=ready`, `primaryImageAssetId`, and
`imageUrl`; failure sets `imageStatus=needs_review`. Neither outcome confirms identity or ownership, and a
later automatic `matched_existing` observation preserves the record's prior identity/ownership state. Stage B keeps
independent product-image jobs so a restart or developer retry cannot duplicate the wardrobe transaction.
The recommendation runtime reads the same signed-browser overlay as ambient capture. A new-item completion
card displays product images only after all required jobs are verified; repeat recognition reuses existing
primary images without another generation call.

Duplicate repair is an explicit repository transaction, never a direct JSON edit. `previewClosetItemMerge()`
reports every affected reference before mutation. `mergeClosetItems()` is per-user, atomic, and idempotent;
it migrates appearances, assets, wear events, captures and signatures, product jobs, completion summaries,
events, and identity traces. The duplicate remains archived with `identityStatus=merged` and an alias to the
active canonical item. Base fixtures and cross-user IDs cannot be merged. The transaction preserves the
canonical item's ownership and identity status and adopts a duplicate primary image only when the canonical
record lacks a verified ready image.

This is a constrained investor-demo vertical slice, not general wardrobe ingestion. Face ID, household
identity, held-garment capture, changing-clothes detection, multi-person tracking, trained FashionCLIP ReID,
and cross-device persistence remain out of scope. The current visual verifier is an API-backed demo path,
not a production biometric or garment-identification claim.
