---
name: occasion-styling
description: Plan or adjust an outfit for a concrete occasion, dress code, weather, mobility, and comfort constraints. Load for interviews, dates, client meetings, weddings, travel, or event dressing; do not use for merely retrieving an item image.
---

# Occasion styling

Use this skill when context changes what “good” means: a client meeting, date, interview, wedding, commute, travel day, outdoor plan, or stated dress code.

## Method

1. Identify the target level of formality, practical constraints, and the user's desired self-expression.
2. Use available context before asking. Ask at most one question only when the missing fact would materially change the recommendation.
3. Call `get_weather` only when weather is unknown and would affect layers, fabric, footwear, or safety.
4. Call `search_closet` when the user wants to use existing clothes or availability matters.
5. Call `find_clothing_products` only when the user wants to shop or no suitable owned item exists.
6. Build the recommendation around a coherent formality level. Shoes, bag, outerwear, and grooming details should not contradict the core outfit.
7. Preserve comfort and mobility. A visually strong outfit that fails the actual day is not a good recommendation.
8. Give a decisive answer, but avoid gender stereotypes and rigid universal rules.

Read `references/occasion-guide.md` for event-specific defaults when needed.
