# Skill / Tool / Policy decision matrix

## Fast decision rule

Ask in order:

1. Must this behavior apply every turn? → **System prompt**.
2. Is it a stable, reusable professional method? → **Skill**.
3. Does it read/change external state, call a provider, generate an artifact, persist data, or perform an independent service? → **Tool**.
4. Must it be enforced regardless of model judgment? → **Policy / code**.
5. Is it a large or frequently changing fact set? → **Database or retrieval Tool**.

## This project

| Capability | Layer | Why |
|---|---|---|
| Respectful body language, chat-first behavior | System | Always on |
| Color/silhouette/proportion diagnosis | Skill | Stable method |
| Occasion and dress-code planning | Skill | Reusable method |
| Ordinary complete-look self-review | Skill | Internal method |
| Current camera/photo analysis via separate vision provider | Tool | External service |
| Closet and real garment images | Tool + data | External user data |
| Weather | Tool | Current external fact |
| Product inventory, image, price, link | Tool + catalog | Mutable external data |
| Independent structured outfit verification | Tool | Separate deterministic/service check |
| AI outfit visual / try-on / edit | Tool | Generates artifact and incurs cost |
| Save persistent preference | Tool | Writes state |
| Photo consent, image ownership, budget | Policy | Must be enforced |
| Session references such as “the first look” | State | Current conversational fact |

## Important implementation nuance

The Agents SDK does not need to treat every professional thought as a function. This repository uses `load_fashion_skill` as a deferred instruction loader so the main agent can choose a focused Skill without putting every manual in the system prompt. It is technically exposed through the tool-calling transport, but its payload is an instruction bundle and it performs no business-side I/O or action.
