---
name: add-fashion-tool
description: Use when adding an external capability such as camera access, weather, closet/catalog lookup, image generation, storage, or an independent evaluator. Define a narrow schema, explicit use/non-use description, policy checks, artifacts, logs, and tests.
---

# Add a fashion tool

1. Confirm the capability reads or changes external state, calls a provider, generates an artifact, persists data, or performs an independent verification.
2. Give it one responsibility and a description that distinguishes it from neighboring tools.
3. Use strict Zod parameters and validate ownership or state again inside `execute`.
4. Add `needsApproval` for sensitive photo use, AI generation, persistence, cost, or future purchase actions.
5. Keep provider code in `src/services/`; keep the tool as a thin policy-aware adapter.
6. Return stable JSON to the model and use `UiArtifact` for user-visible images or product cards.
7. Never hide policy only in prompt text.
8. Add boundary, policy, and failure tests plus at least one behavior-eval case.
9. Run `npm run check`.
