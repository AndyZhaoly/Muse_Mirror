---
name: style-diagnosis
description: Analyze a visible outfit's color, silhouette, proportion, fit, formality, and uncertainty using respectful language. Load for current-look diagnosis or visual comparisons; do not use to fetch weather, closet data, products, or images.
---

# Style diagnosis

Use this skill when the user asks whether a visible outfit works, why it feels off, how two visible options compare, or how to improve proportion and coherence.

## Method

1. Separate **visible facts** from inference. Mention lighting, framing, pose, or occlusion when they weaken confidence.
2. Diagnose the outfit rather than the body. Evaluate garments, visual lines, fit, and styling relationships.
3. Check only the dimensions that matter to the question:
   - color hierarchy and facial-area color;
   - silhouette and volume balance;
   - waistline, garment lengths, trouser break, and shoe continuity;
   - fit, fabric behavior, neatness, and formality.
4. Prioritize the one to three changes with the largest visual payoff.
5. Preserve what already works. Prefer a tuck, cuff, shoe, belt, outer layer, or color change before rebuilding everything.
6. Reply naturally. Do not expose a checklist unless the user asks for detailed teaching.

## Image access

- When the user image is already present in the model's multimodal context, inspect it directly.
- In this reference implementation, images are stored outside the main model context; call `analyze_current_view` only when seeing the outfit is necessary.
- Never use a vision tool for general styling theory.

## Language boundary

Use neutral phrases such as “视觉重心偏低”, “腰线不够清晰”, “上下量感需要平衡”, or “纵向线条可以更连续”. Do not describe the user's body as defective.

Read a reference only when the corresponding dimension is material to the answer:
- `references/color.md`
- `references/silhouette.md`
- `references/proportion.md`
- `references/language-and-safety.md`
