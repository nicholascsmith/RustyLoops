# AGENTS.md

This repository is the Rusty Loops fork of Synkopa. Read `FORK.md` first: it lists what the
fork removes, how to make fork changes, and how to sync with upstream.

## Product Standard

Synkopa  is a professional creative tool, not a demo. Solve the musician's
actual workflow problem rather than merely satisfying the literal surface of a
ticket. A smaller, complete feature is better than a broad but shallow one.

Do not ship placeholders, dead or misleading controls, disconnected mock UI, or
happy-path-only behavior. Every visible element must earn the space it consumes
and help the user understand or operate the product.

## Claiming an Issue

Before starting work on a GitHub issue, check its comments and the open pull requests for
someone already on it. If nobody is, leave a short comment on the issue saying you are
working on it (and what part, if only part), so two people or agents do not build the same
change in parallel.

## Substantial Changes Require Research

A substantial change includes any new user workflow or feature, DSP behavior,
public API or data-model change, cross-boundary integration, production
dependency, or material UX, architecture, or performance decision.

Before implementing a substantial change:


1. Research how strong products solve the underlying problem today.
2. Decide on the recommended direction and acceptance criteria, then implement
   it autonomously. Do not stop to ask for approval of a direction the research
   settles.
3. Ask the user (with the question tool) only when a genuinely hard decision
   remains after research: the options trade off things only the user can
   weigh, or the choice is costly to reverse.

The agent may challenge the user's initial solution and implement a better one
when the research supports it. Keep optional additions beyond the request out
of the change; mention them in the final report instead.

Small, isolated corrections such as typos, obvious styling defects, or narrow
regression fixes may proceed after inspecting local context, without ceremonial
market research. If the classification is uncertain, treat the work as
substantial.

## Competitor Reference: Nota

Nota (https://github.com/nota-daw/nota) is a free, open-source DAW for macOS,
Windows, and Linux and a direct competitor. Its core is C++20, its UI is
.NET/Avalonia, and it uses JUCE for plugin hosting. It is licensed AGPL-3.0.
Its code and docs are public, so read them as primary-source research when
comparing workflows, architecture, or performance. Nota's docs are at
https://nota-daw.github.io/nota-docs/.

- Use it to learn what the project does and how, not to copy code. Do not paste
  or port Nota source into Synkopa without an explicit licensing decision from the
  user, because AGPL-3.0 would bind the result.
- Treat it as one input. Follow the Research Standard: compare it with the other
  products and sources, and mark which claims are sourced and which are inferred.

## Research Standard

Research must answer why a design is useful, not just show that a competitor has
it. Prefer current primary sources and verify version-sensitive claims.

- For DAW workflows, compare FL Studio and Ableton Live when relevant. Add the
  strongest task-specific references, such as Bitwig Studio, Logic Pro, REAPER,
  or a specialized tool. Do not force irrelevant comparisons.
- For effects, instruments, and plugin workflows, read official manuals and
  combine them with credible reviews and user discussions. Establish which
  products people value, why they value them, recurring frustrations, and the
  interaction or DSP details behind those opinions.
- For architecture and performance, prioritize specifications, primary
  technical documentation, measurements, and reproducible benchmarks over
  secondary summaries.
- Distinguish sourced evidence, inference, and subjective product preference.
  Where evidence conflicts or is weak, say so.
- Do not cargo-cult a competitor. Extract the user need, then design the best
  fit for Synkopa's architecture, constraints, and audience.

Unless the user asks for a permanent artifact, keep the research summary and
source links in chat rather than adding a research document to the repository.

by default we want to use fl studio like behaviors usually - if possible you can inspect fl studio on computer yourself.

## Product and UX Reasoning

For every substantial user-facing change, reason through the complete journey,
including:

- discoverability, information density, hierarchy, and efficient use of space;
- mouse, keyboard, focus, selection, drag, and undo/redo behavior;
- long names, deep hierarchies, large projects, and realistic data volumes;
- empty, loading, error, unavailable, disabled, and partial-success states;
- feedback, latency perception, accessibility, scaling, and contrast;
- consistency with existing components, tokens, gestures, and terminology.

Prefer information-bearing visuals and controls over decoration. Do not add an
icon, badge, animation, panel, or permanent control unless its user value
outweighs its visual and interaction cost.

## Architecture and Performance

Respect the boundaries described in `docs/architecture.md`. The Rust engine
owns the project and undo; the UI changes it only through ops (`apply_ops`) and
reads it from `state` events. Views do not call Tauri directly: they go through
`ui/src/api/backend.ts`, which has a matching in-browser mock (`ui/src/api/mock.ts`)
that must keep behaving like the engine. The GUI and the `synkopa` CLI share one
implementation of every action (`app/src/actions.rs`). Extend existing
components and patterns instead of creating parallel implementations.

Treat performance as a product feature:

- Prefer lazy, incremental, and bounded work. Virtualize large collections when
  rendering cost would otherwise scale with the full data set.
- Cache expensive derived work only with an explicit cache key, invalidation
  policy, memory bound, and tests for stale-result behavior.
- Measure critical paths and representative worst cases. Do not optimize from
  intuition alone or move avoidable work into a per-frame loop.
- Keep the application responsive during scans, file operations, decoding, and
  other slow or failure-prone work.

The real-time audio callback must not allocate, lock, block, perform I/O, log,
panic, or do unbounded work. Preserve deterministic, glitch-free behavior across
supported sample rates and block sizes. Smooth continuous parameters and handle
discrete changes, bypass, graph swaps, and teardown without clicks or invalid
intermediate states.

## Implementation Standard

Implement an approved feature as a complete vertical slice wherever applicable:
engine and DSP, IPC DTOs and commands, TypeScript backend contracts,
`MockBackend`, state management, UI, project persistence, tests, and user-facing
documentation.

- Map failure modes and acceptance criteria before editing.
- Preserve unrelated user changes and established architectural invariants.
- Keep every drawn control wired to real behavior or visibly disabled with a
  truthful explanation.
- Add regression coverage for the main behavior, realistic edge cases, cache
  invalidation, and failure paths.
- Manually verify the actual user journey, not only isolated functions.
- For DSP or performance work, add objective measurements or deterministic test
  signals where practical.
- When judging how something sounds (DSP, instruments, separation, mixing),
  metrics are not enough: if available, also have the rendered audio checked by
  a model with audio input modality (e.g. Gemini 4 Hydrogen or Carbon), and
  offer the user short MP3 renders to listen to.

## Commits and Pull Requests

Describe the change itself: what changed for the user, why, and how it was
verified. If applicable - add screenshots before / after to the mr description

## Verification and Definition of Done

Run the gates relevant to the touched areas. For a repository-wide or
cross-boundary change, run the full set:

```sh
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all --check
pnpm --dir ui test
pnpm --dir ui build
```

A change is done only when the approved workflow works end to end with realistic
data, relevant edge cases are handled, performance remains appropriate, and no
placeholder or integration gap remains.
