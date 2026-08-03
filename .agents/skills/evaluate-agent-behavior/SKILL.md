---
name: evaluate-agent-behavior
description: Use when prompts, skill descriptions, tool descriptions, permissions, or agent-loop behavior change. Test direct answers, skill loading, correct tool choice, non-use, approvals, multi-turn edits, and artifact boundaries.
---

# Evaluate fashion-agent behavior

Review `examples/demo-turns.json` and `CODEX_TASK.md`.

Cover at least:

- a simple theory question answered with no tool and usually no skill load;
- a current-look diagnosis that loads `style-diagnosis` and uses vision only when the image is not directly in model context;
- an occasion request that may load `occasion-styling` and calls weather/closet only when useful;
- a complete important look using `outfit-review`, with independent verification only when justified;
- a real garment-image request that never calls AI generation;
- AI concept, try-on, and edit requests choosing distinct image tools;
- permission interruption and resume;
- a request that should not save persistent memory.

Record tool calls and loaded skills separately. A correct final answer with unnecessary tools is still a failure.
