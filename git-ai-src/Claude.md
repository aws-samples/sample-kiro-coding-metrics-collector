# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Test Commands

```bash
# Build
cargo build                              # debug build (used by integration tests)
cargo build --release                    # release build

# Test
cargo test                               # all tests (parallel)
cargo test -- --test-threads=8           # CI thread count
cargo test <test_name>                   # single test by function name substring

# Run a single test file (preferred - skips building other test files):
cargo test --package git-ai --test <test_file_name> -- --nocapture

# Lint & Format (CI uses Rust 1.93.0, RUSTFLAGS="-D warnings")
cargo clippy
cargo fmt -- --check
cargo fmt

# Snapshot management (insta crate)
cargo insta review                       # interactively review snapshot changes
cargo insta accept                       # accept all pending snapshots

# E2E tests (requires bats)
bats tests/e2e/user-scenarios.bats

# Taskfile shortcuts
task build          # release build
task test           # unit tests
task lint           # clippy
task coverage       # coverage report (50% minimum enforced in CI)
```

**Dev environment**: `nix develop` provides the pinned Rust 1.93.0 toolchain with wrappers (`git` -> debug binary, `git-ai` -> debug binary, `git-og` -> real git).

## Architecture

### Binary dispatch (src/main.rs)

Single binary, two roles based on `argv[0]`:
- **`argv[0] == "git"`** -> `commands::git_handlers::handle_git()` -- proxies to real git with pre/post hooks
- **`argv[0] == "git-ai"`** -> `commands::git_ai_handlers::handle_git_ai()` -- direct subcommands (checkpoint, blame, diff, stats, etc.)
- **Debug-only**: `GIT_AI=git` env var forces git proxy mode (how integration tests work)

### Core data flow: checkpoint -> working log -> authorship note

1. **Checkpoint**: AI agent calls `git-ai checkpoint <agent>`. Agent preset (`src/commands/checkpoint_agent/agent_presets.rs`) extracts edited paths, transcript, model. Checkpoint diffs working tree against HEAD for character-level attributions.
2. **Working log**: Written to `.git/ai/working_logs/<base_commit>/` as JSON. Records per-file line attributions (AI vs human) and prompt metadata.
3. **Post-commit hook**: Reads working logs, generates `AuthorshipLog` (schema `authorship/3.0.0`), stores as Git Note under `refs/notes/ai`.
4. **Rewrite tracking**: `.git/ai/rewrite_log` records history-rewriting ops. Post-hooks use `rebase_authorship.rs` to rewrite authorship notes so attribution follows code through rebases/cherry-picks/etc.

### Git proxy hook architecture (src/commands/hooks/)

Each git subcommand has dedicated pre/post hooks:
- `commit_hooks` -- pre: capture virtual attributions; post: generate authorship note
- `rebase_hooks` -- pre: record HEAD/onto; post: rewrite authorship notes
- `cherry_pick_hooks` -- post: copy/adapt authorship from source
- `reset_hooks` -- post: reconstruct working logs when commits undone
- `stash_hooks` -- preserve uncommitted AI attributions across stash/pop
- Also: `merge_hooks`, `checkout_hooks`, `switch_hooks`, `fetch_hooks`, `push_hooks`, `clone_hooks`

Unix signal forwarding: git proxy installs handlers (SIGTERM/SIGINT/SIGHUP/SIGQUIT) that forward to child git process group.

### Config singleton

`Config` is a global `OnceLock` via `Config::get()`, reads from `~/.git-ai/config.json`. Feature flags have separate debug/release defaults via `define_feature_flags!` macro in `src/feature_flags.rs`. Precedence: env vars (`GIT_AI_*`) > config file > defaults.

### Error handling

`GitAiError` in `src/error.rs` -- manual `Display`/`From` impls (no thiserror). `GitError(git2::Error)` variant only behind `#[cfg(feature = "test-support")]`.

### Async/daemon mode

In release builds, `async_mode` defaults to true: wrapper is a pure git passthrough, captures state sent to a daemon. Daemon processes trace2 events via `trace_normalizer.rs` using an actor model (`global_actor` + `family_actor` per-repo). Uses `smol` runtime (not tokio).

## Test Infrastructure

### Integration test framework (tests/repos/)

- **`test_repo.rs`** -- `TestRepo`: creates temp git repos, runs git-ai as subprocess with `GIT_AI=git` env var
- **`test_file.rs`** -- `TestFile` fluent API; `lines!` macro + `.ai()`/`.human()` for attribution expectations
- **`mod.rs`** -- `subdir_test_variants!` macro generates variants testing from subdirectory and with `-C` flag

```rust
#[test]
fn test_example() {
    let repo = TestRepo::new();
    let mut file = repo.filename("test.txt");
    file.set_contents(lines!["Line 1", "AI line".ai()]);
    repo.stage_all_and_commit("Initial commit").unwrap();
    file.assert_lines_and_blame(lines!["Line 1".human(), "AI line".ai()]);
}
```

### Test isolation

- Each `TestRepo` gets random temp dir + separate `GIT_AI_TEST_DB_PATH` (SQLite DB as sibling to repo, not inside `.git/`)
- `GIT_AI_TEST_CONFIG_PATCH` env var passes JSON config overrides to subprocess
- Background flush skipped when `GIT_AI_TEST_DB_PATH` set
- Use `#[serial_test::serial]` for tests that conflict on shared env vars

## Key Conventions

- **Rust 2024 edition** (1.93.0) -- uses let-chains (`if let Some(x) = foo && condition`)
- **Git CLI over libgit2 in production**: all git ops use `std::process::Command`. `git2` is test-only (`test-support` feature)
- **`debug_log()`** for debug output: `[git-ai]` prefixed stderr when `cfg!(debug_assertions)` or `GIT_AI_DEBUG=1`
- **POSIX-normalized paths**: `normalize_to_posix()` converts Windows backslashes everywhere
- **Cross-platform**: `#[cfg(unix)]`/`#[cfg(windows)]` throughout for signal handling, process flags, paths

## Gotchas

- **argv[0] dispatch is load-bearing** -- binary behavior entirely determined by invocation name. Breaking dispatch breaks everything.
- **Config is process-global** -- `OnceLock`, initialized once. Tests override via `GIT_AI_TEST_CONFIG_PATCH` env var in subprocess.
- **Feature flag debug/release divergence** -- `rewrite_stash` is true in debug, false in release. Tests use debug builds.
- **Working log base commit** -- keyed by HEAD at checkpoint time. If HEAD changes between checkpoint and commit, post-hook must reconcile.
- **Large source files** -- `rebase_authorship.rs` (~119K), `agent_presets.rs` (~101K), `repository.rs` (~96K). Navigate with grep.
- **Git notes namespace** -- `refs/notes/ai`. Use `git notes --ref=ai list` or `git log --notes=ai` (default `git notes` won't show it).
- **Snapshot cascades** -- changing attribution logic can invalidate many snapshots. Use `cargo insta review`.
- **Test binary auto-compilation** -- integration tests trigger `cargo build --bin git-ai --features test-support` on first run via `OnceLock`.
