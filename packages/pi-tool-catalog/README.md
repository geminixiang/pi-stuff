# Pi Tool Catalog

Deferred tool discovery and activation for Pi.

The extension builds descriptors from `pi.getAllTools()` and merges optional catalogs from:

- `~/.pi/agent/tool-catalog.json`
- `<project>/.pi/tool-catalog.json`

Only tools explicitly configured with `deferred: true` start inactive. Existing active tools are otherwise preserved. Automatic activation additionally requires `activationPolicy: "automatic"`, trusted metadata, read-only or no side effects, and an available health state. Derived tools are searchable but cannot be activated by the catalog.

Project catalog entries are treated as untrusted unless the project is trusted by Pi. Untrusted project entries cannot promote themselves to trusted or automatic activation. Manual, untrusted, write, network, or unknown tools require an interactive confirmation that displays their source and side effects; activation is refused without a UI.

## Configuration

```json
{
  "tools": {
    "browser": {
      "deferred": true,
      "activationPolicy": "manual",
      "keywords": ["web", "page"],
      "trust": "trusted",
      "sideEffects": "network",
      "health": "healthy"
    }
  }
}
```

Metadata values:

- `activationPolicy`: `automatic` or `manual`
- `trust`: `trusted` or `untrusted`
- `sideEffects`: `none`, `read`, `write`, `network`, or `unknown`
- `health`: `healthy`, `degraded`, `unavailable`, or `unknown`

Project entries override global fields. Keywords are replaced when specified.

## Interface

- `search_tools`: lexical search; only safe entries with `activationPolicy: "automatic"` are activated by default
- `tool_catalog`: `list`, `activate`, or `deactivate`; risky activation requires interactive confirmation
- `/tool-catalog [list|search <query>|activate <names>|deactivate <names>|reload]`

## Active-tool ownership limitation

Pi currently exposes a global active-tool set rather than scoped activation leases. The controller applies additive changes against the latest set and only deactivates tools it activated itself, but another extension can still write the set concurrently. In that race, the last writer wins. Reloading the catalog does not intentionally remove tools that another extension re-enabled.
