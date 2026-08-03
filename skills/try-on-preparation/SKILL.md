---
name: try-on-preparation
description: Prepare accurate garment descriptions and preservation constraints for AI outfit visuals, virtual try-on, and follow-up image edits. Load only when generating or editing AI fashion imagery; do not use when the user wants a real closet or product image.
---

# Try-on preparation

Use this skill immediately before an AI outfit visualization, on-body preview, or edit.

## First choose the correct visual capability

- Real owned garment image → `get_item_images`.
- Real purchasable product image → `find_clothing_products`.
- AI flat lay, moodboard, or mannequin concept without the user's identity → `generate_outfit_visual`.
- The user explicitly asks to see themselves wearing the look → `generate_try_on_preview`.
- The user requests a change to the previous generated preview → `edit_try_on_preview`.

Never use AI generation to impersonate a real catalog image.

## Prepare the request

1. Resolve the selected outfit and specify garment type, color, fit, length, fabric feel when known, and accessories.
2. State what must remain unchanged: identity, face, hair, skin tone, body shape and proportions, pose, camera angle, and lighting unless the user explicitly asks for an allowed styling change.
3. For edits, enumerate only the requested changes and explicitly preserve everything else.
4. Do not promise exact sizing, tailoring, fabric drape, or product fidelity.
5. The policy layer—not the model—must verify consent, image ownership, session scope, and generation budget.

Read `references/image-preservation.md` for prompt constraints.
