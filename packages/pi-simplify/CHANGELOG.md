# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.1.2] - 2026-07-26

### Changed

- Move package development and trusted publishing to the `geminixiang/pi-stuff` monorepo.
- Declare Pi runtime packages as peer dependencies to follow Pi package conventions.

## [0.1.1] - 2026-06-09

### Added

- Add `/simplify previous` mode to review only the last commit (`HEAD~1..HEAD`), with aliases for `previous-commit`, `prev`, and `last-commit`.

## [0.1.0] - 2026-06-03

### Added

- Add `/code-smell` command: finds structural problems with programmatic checks (debug remnants, commented-out code, duplication, complex functions) plus agent review across complexity, duplication, coupling, state, errors, performance, and maintainability smell families.
- Programmatic scanner runs deterministically before agent review; findings are verified by reading files before surfacing them.
- Interactive findings selector: ranked by severity, auto-selects high-severity / high-confidence items, shows cause-effect chain inline.

### Fixed

- Skip redundant `## Scope` section in the agent prompt when scanning the repository root.

### Changed

- Reorganise source into `src/simplify/` and `src/code-smell/` subdirectories.

## [0.0.11] - 2026-06-03

### Changed

- Add thin-wrapper review heuristics so `/simplify` flags rename-only wrappers, pass-through factories, single-call-site helpers, duplicated write APIs, and test-only exports only when they create real maintenance cost.

## [0.0.10] - 2026-05-30

### Changed

- Replace each candidate's single `reason` with a three-part cause-and-effect chain — **root issue**, **consequence**, and **benefit after fix** — so findings explain _why_ they matter, not just _what_ to change.
- Require a real, non-trivial consequence for every finding; items that only make code "slightly shorter" are no longer flagged.
- Show the full root issue → consequence → benefit chain in the findings selector, and pass the root issue and goal to the apply step.

## [0.0.9] - 2026-05-27

### Added

- Support simplifying specific folders and files as snapshot reviews.
- Add a preset selector for choosing uncommitted changes or folder snapshot mode.

### Fixed

- Respect configured selection keybindings in simplify TUI selectors.
- Keep release tags and GitHub release titles v-prefixed.

## [0.0.8] - 2026-05-25

### Added

- Support simplifying specific folders and files as snapshot reviews.
- Add a preset selector for choosing uncommitted changes or folder snapshot mode.

### Fixed

- Keep release tags and GitHub release titles v-prefixed.

## [0.0.7] - 2026-05-25

### Changed

- Use pi's native select list for findings selection.
- Wrap long finding recommendations in the selection menu.
- Split the simplify extension into prompt, selector, workflow, and shared type modules.
- Update dependencies to the current `@earendil-works` pi packages.

### Removed

- Remove the `/simplify-quick` command and its documentation.

### Added

- Add a project release workflow skill for future releases.
