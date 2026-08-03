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
