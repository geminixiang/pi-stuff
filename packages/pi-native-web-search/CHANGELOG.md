# Changelog

All notable changes to this package will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed

- Fail fast when the active provider has no native web search. The script prints `web search unavailable for <provider>/<model>` and does not call `/responses`. An HTTP 404 from `/responses`, or an HTTP 400 that says the `web_search` tool is missing, uses the same message.

## [0.2.0] - 2026-10-06

### Changed

- Require Pi AI 1.x (>=1.0.0 <2.0.0); verify against the repository's Pi 1.0.4 baseline.
- Prefer the provider and model active in the current Pi session.
- Resolve custom active providers by their configured ID instead of exposing an internal provider name.

## [0.1.0] - 2026-08-06

### Added

- Vendor the Apache-2.0 `native-web-search` skill from `mitsuhiko/agent-stuff` for independent maintenance.
- Support Pi's `@earendil-works/pi-ai` package while retaining compatibility with legacy `@mariozechner/pi-ai` installations.
- Add focused tests for argument parsing, provider selection, token expiry, model selection, endpoint construction, and stream event parsing.
