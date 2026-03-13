# Changelog

## [0.4.0] - 2026-03-13

### Added

- Inline `<if-model is="...">...</if-model>` blocks with optional `<else>` branches inside prompt bodies.
- Provider wildcard matching in conditionals with syntax like `anthropic/*`.
- Conditional rendering now happens after model fallback resolution for both single prompt commands and `/chain-prompts`.
- Prompt argument substitution now mirrors pi core more closely, including `${@:N}` and `${@:N:L}` slice syntax. See README for full placeholder reference.

### Fixed

- Model fallback now preserves the currently active model whenever it matches any listed fallback candidate, including ambiguous bare model IDs that would otherwise resolve through provider preference, instead of switching to an earlier candidate unnecessarily.
- Prompt templates that collide with reserved slash commands, including built-ins like `/model` and the extension’s own `/chain-prompts`, are now skipped with a warning instead of being silently shadowed.
- Prompt discovery is now deterministic in a locale-independent way, and duplicate model-enabled prompt names within the same source layer are skipped with a warning instead of silently depending on traversal order.
- Invalid `model` frontmatter declarations are now rejected during prompt loading with diagnostics instead of failing later at execution time.
- Literal tags like `<elsewhere>` and `</if-modeling>` no longer get misparsed as malformed conditional directives.
- Non-interactive notifications now go to stderr so print-mode stdout stays clean.
- Bare model IDs with multiple providers can now still resolve through OAuth-backed auth checks even when fast availability checks alone are inconclusive.
- Optional string frontmatter fields are now trimmed so quoted values like `thinking: " high "` and `skill: " tmux "` behave as expected.
- Existing prompt commands now refresh prompt files before execution, so edits made during a session take effect on the next run instead of waiting for a new session.
- Skill-loaded custom messages now fail safe if their details payload is missing instead of crashing the renderer.
- Frontmatter `model` specs and inline conditional `is` specs now reject internal whitespace like `anthropic /model` or `anthropic /*` instead of silently registering values that can never match.
- Recursive prompt discovery now detects already-visited directories and skips symlink loops instead of risking infinite recursion or duplicate traversal.
- Bare model IDs now honor provider priority across all auth-capable candidates, including OAuth-backed providers, instead of incorrectly favoring a lower-priority provider just because it appeared in the fast-available set.
- Prompt loading now rejects non-object YAML frontmatter roots, like lists, with a diagnostic instead of silently treating them as missing `model` fields.
- `/chain-prompts` now only restores model and thinking when they actually changed, avoiding redundant state writes and noisy restore notifications on no-op chains.
- `/chain-prompts` now tracks thinking changes caused by model switches even when a step does not set `thinking`, so final restoration stays correct when the runtime clamps or resets thinking during a model change.
- `/chain-prompts` now rejects empty or quote-only step segments explicitly instead of treating them as blank template names.
- Single-command auto-restore now also skips no-op thinking restores and notifications when the runtime is already back on the original thinking level.
- Removed unnecessary exports: `modelSpecMatches` from model-selection.ts and `VALID_THINKING_LEVELS` from prompt-loader.ts are now internal implementation details.
- `/chain-prompts` now correctly ignores ` -- ` and `->` inside quoted per-step arguments instead of misinterpreting them as separators.
- `</else>` is now explicitly rejected with a helpful error message explaining that `<else>` is a separator, not a container.
- Fast-path optimization now correctly includes `</else>` check so standalone invalid tags are caught.
- Empty prompt abort in single-command mode now notifies as "error" instead of "warning" for consistency with chain mode.

## [0.3.1] - 2026-02-08

### Fixed

- Prompts map now initialized at extension load instead of waiting for `session_start`. Commands invoked before the first session event no longer fail with stale empty state.

## [0.3.0] - 2026-02-08

### Added

- **Chain command**: `/chain-prompts` orchestrates multiple prompt templates sequentially, each with its own model, skill, and thinking level. Conversation context flows between steps naturally.
- Per-step args override shared args: `/chain-prompts analyze "error handling" -> fix-plan "focus on perf" -> summarize -- src/main.ts`
- Mid-chain failure rolls back to the original model and thinking level
- Step progress notifications show which step is running
- State isolation: chain uses local variables, never interferes with single-command restore behavior

## [0.2.1] - 2026-01-31

### Fixed

- Thinking level now correctly restored after commands that switch model without a `thinking` field. Previously, running a prompt template that only specified `model` would reset thinking to "off" instead of restoring the original level (e.g., "high").

## [0.2.0] - 2025-01-31

### Added

- **Model fallback**: The `model` field now accepts a comma-separated list of models tried in order
- First model that resolves and has auth configured is used
- Supports mixing bare model IDs and explicit `provider/model-id` specs
- If the current model matches any candidate, it's used without switching
- Single consolidated error when all candidates fail
- Autocomplete shows fallback chain with pipe separator: `[haiku|sonnet]`
- Banner image

## [0.1.0] - 2025-01-12

### Added

- **Model switching** via `model` frontmatter in prompt templates
- **Print mode support**: Commands work with `pi -p "/command args"` for scripting
- **Thinking level control**: `thinking` frontmatter field with levels `off`, `minimal`, `low`, `medium`, `high`, `xhigh`
- **Skill injection**: `skill` frontmatter field injects skill content into system prompt via `<skill>` tags
- **Subdirectory support**: Recursive scanning creates namespaced commands like `(user:subdir)`
- **Auto-restore**: Previous model and thinking level restored after response (configurable via `restore: false`)
- **Provider resolution** with priority fallback (anthropic, github-copilot, openrouter)
- Support for explicit `provider/model-id` format
- Fancy TUI display for skill loading with expandable content preview
