# Migration from v0.4 to v0.5

## Removed

- Static `knowledge/` folder as a generic retrieval source.
- `StyleKnowledgeService` and `retrieve_style_knowledge` business tool.
- The implication that routine styling judgment requires a service call.
- Tool name `evaluate_outfit`, which blurred self-review and independent verification.

## Added

- Runtime fashion bundles under `skills/` with standard `SKILL.md` manifests and references.
- `FashionSkillRegistry` and a focused `load_fashion_skill` deferred instruction loader.
- `.agents/skills/` for Codex development workflows.
- Root `AGENTS.md` to preserve architectural boundaries.
- `verify_outfit_quality` for optional independent structured verification.
- Skill manifest validation, registry tests, and explicit Skill/Tool/Policy documentation.

## Kept

- One conversational main agent with automatic zero/one/many capability choice.
- No keyword intent router or fixed user workflow.
- Vision, closet, weather, product, image generation, state, and memory tools.
- Approval interruption and resumable run state.
- UI artifacts separated from natural-language output.

## Vision note

The current MVP keeps `analyze_current_view` because images are registered in application storage and analyzed by a separate vision service. If the application sends the image directly as multimodal input to the main agent, remove that extra tool call and let `style-diagnosis` guide the main model's observation instead.
