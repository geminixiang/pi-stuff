# Changelog

All notable changes to this package will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed

- Prefer the provider and model active in the current Pi session.
- Resolve custom active providers by their configured ID instead of exposing an internal provider name.

## [0.1.0] - 2026-08-06

### Added

- Vendor the Apache-2.0 `native-web-search` skill from `mitsuhiko/agent-stuff` for independent maintenance.
- Support Pi's `@earendil-works/pi-ai` package while retaining compatibility with legacy `@mariozechner/pi-ai` installations.
- Add focused tests for argument parsing, provider selection, token expiry, model selection, endpoint construction, and stream event parsing.
