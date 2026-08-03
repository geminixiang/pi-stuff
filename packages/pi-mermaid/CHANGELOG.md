# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.1.2] - 2026-07-26

### Changed

- Move package development and trusted publishing to the `geminixiang/pi-stuff` monorepo.
- Update package repository metadata for the new workspace location.

## [0.1.1] - 2026-07-26

### Added

- Render Mermaid flowcharts, state diagrams, sequence diagrams, class diagrams, ER diagrams, and XY charts as terminal-friendly Unicode art.
- Automatically preview Mermaid fenced blocks from assistant responses.
- Provide `/mermaid` and `render_mermaid` interfaces for direct rendering.
- Compensate for double-width CJK characters to keep boxes and arrows aligned.
- Include npm installation instructions and a terminal screenshot in the README.

### Changed

- Publish under the scoped package name `@geminixiang/pi-mermaid`.

### Tests

- Cover Mermaid fence extraction, Unicode and ASCII rendering, and CJK alignment.
