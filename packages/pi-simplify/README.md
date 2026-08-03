# pi-simplify

[![npm version](https://img.shields.io/npm/v/@geminixiang/pi-simplify.svg)](https://www.npmjs.com/package/@geminixiang/pi-simplify)

A [pi coding agent](https://github.com/mariozechner/pi) extension that cleans up leftover code after feature implementation.

## What it does

After implementing a feature, your code often accumulates:

- **Dead code** - unused exports, orphaned files, zombie variables
- **Debug remnants** - console.log, debugger statements, temp flags
- **Commented-out code** - old logic left in comments
- **Over-engineering** - "might use later" abstractions never used
- **Duplicate logic** - repeated if-else blocks doing the same thing

`/simplify` finds these and removes them.

`/code-smell` goes deeper — it runs programmatic checks plus agent review to surface structural problems like coupling, error handling gaps, and performance issues.

## Installation

```sh
pi install npm:@geminixiang/pi-simplify
```

## Usage

### Code Smell Analysis

```
/code-smell
```

Opens a scope selector. Choose to scan the repository or specific paths.

Runs programmatic checks (debug remnants, commented-out code, duplication, complex functions) then agent review across seven smell families:

- **Complexity** - long functions, deep nesting, mixed responsibilities
- **Duplication** - copy-paste blocks, repeated condition chains
- **Coupling** - cross-layer reach-through, boundary violations
- **State** - redundant derived state, multiple sources of truth
- **Errors** - swallowed errors, empty catches, inconsistent mapping
- **Performance** - N+1 loops, sequential independent awaits
- **Maintainability** - debug remnants, TODO/HACK markers, stringly-typed constants

Findings are ranked by severity. Select which to fix and the agent applies small, behavior-preserving cleanups.

```
/code-smell src lib
```

Scans specific paths directly.

### Full Simplify

```
/simplify
```

Opens a preset selector. Choose uncommitted changes, the previous commit, or a folder snapshot.

Uncommitted mode analyzes all git changes and presents cleanup candidates:

- **Safe** (green) - auto-selected, will be deleted
- **Confirm** (yellow) - delete after user confirms
- **Review** (orange) - user should review first

### Simplify Previous Commit

```
/simplify previous
```

Analyzes only the last commit (`git diff HEAD~1..HEAD`), even if there are uncommitted local changes.

Aliases: `/simplify previous-commit`, `/simplify prev`, `/simplify last-commit`.

### Simplify Folders

```
/simplify folder src docs
```

Analyzes the specified folders/files as a snapshot (not a diff), even when there are no local git changes.

### With Focus

```
/simplify focus on the utils folder
/simplify focus on removing debug code
```

## Commands

| Command                    | Purpose                                                                     |
| -------------------------- | --------------------------------------------------------------------------- |
| `/simplify`                | Delete excess after a feature: dead code, debug remnants, thin wrappers     |
| `/simplify previous`       | Same as above but scoped to the previous commit (`HEAD~1..HEAD`)            |
| `/simplify folder <paths>` | Same as above but snapshot mode (no git diff needed)                        |
| `/code-smell`              | Find structural problems: coupling, complexity, error handling, performance |
| `/code-smell <paths>`      | Scan specific paths for code smells                                         |

## Comparison with pi-review

|              | pi-review                   | pi-simplify           |
| ------------ | --------------------------- | --------------------- |
| **Goal**     | Find problems               | Delete excess         |
| **Attitude** | Conservative (marks issues) | Active (removes junk) |
| **Output**   | Findings list               | Deletion plan         |
| **Trigger**  | Manual review               | Post-feature cleanup  |

## License

MIT
