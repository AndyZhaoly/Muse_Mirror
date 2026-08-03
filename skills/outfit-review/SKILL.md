---
name: outfit-review
description: Self-review a complete outfit for hard styling issues and propose the smallest repair before an important recommendation. Load for complete looks, important occasions, shopping decisions, or pre-generation checks; do not load for every casual fashion question.
---

# Outfit review

Use this skill as an internal quality pass after a complete outfit exists or when the consequence of a poor recommendation is meaningful.

## Review dimensions

Consider only what is relevant:

- occasion and dress-code fit;
- color hierarchy and coherence;
- silhouette and volume balance;
- proportion and garment-length relationships;
- fit, fabric, neatness, weather, and comfort;
- footwear, bag, and accessory completion;
- consistency with explicit user preferences and available items.

## Decision rule

1. Identify hard issues before minor refinements.
2. If the outfit works, say why in one or two useful points rather than inventing faults.
3. If it fails, repair it with the smallest realistic change.
4. Do not force numerical scores into the user response.
5. Use `verify_outfit_quality` only when an independent structured check, logging, repeatability, or a higher-stakes action justifies an external evaluator. The skill itself is sufficient for ordinary self-review.
6. Before AI try-on or shopping recommendations, verify that the outfit description is complete enough to execute accurately.

Read `references/evaluation-rubric.md` when a structured review is needed.
