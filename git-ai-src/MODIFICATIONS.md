# Modifications to git-ai

This file documents the modifications made to the original git-ai project
(https://github.com/nicolo-ribaudo/git-ai) for use in the KIRO Coding Metrics Collector project.

**Original Project**: git-ai  
**Original Author**: Aidan Cunniffe  
**Original License**: Apache License 2.0  
**Original Repository**: https://github.com/nicolo-ribaudo/git-ai

## Summary of Changes

The following modifications were made to adapt git-ai for integration with
Kiro IDE as a bundled binary within the plugin:

### 1. Kiro IDE Integration (agent-v1 preset)

- Added `agent-v1` preset support for checkpoint calls from the Kiro plugin
- Modified checkpoint input handling to accept structured payloads from the
  plugin's SessionLogWatcher

### 2. Post-Commit Hook Compatibility

- Adjusted post-commit processing to work with the plugin's hook installation
  mechanism (both Unix bash and Windows PowerShell)
- Modified stats output format to include additional fields required by the
  Dashboard ingest API (`ai_deletions`, `human_deletions`)

### 3. Diff JSON Output Enhancement

- Enhanced `git-ai diff --json` output to include `prompt_id` in hunk data,
  enabling precise AI/human deletion attribution in the post-commit hook

### 4. Amend Commit Support in `post-commit` CLI

- Extended `git-ai post-commit` CLI to accept an optional `--amend-from <original_sha>`
  flag. When provided, the command emits a `CommitAmend` rewrite event instead of a
  plain `Commit` event. This routes processing through
  `rewrite_authorship_after_commit_amend_with_snapshot`, which correctly merges AI
  attribution from the original commit's note with the amended diff. Previously the
  CLI always used `Commit` events, so `git commit --amend` lost all AI attribution.

## Files Modified

Key source files that were modified (non-exhaustive):

- `src/authorship/` — Attribution tracking logic adjustments
- `src/cli/` — CLI command modifications for agent-v1 preset
- `src/hooks/` — Post-commit hook output format changes
- `Cargo.toml` — Dependency updates and feature flag changes

## Compliance Note

The original Apache 2.0 license is preserved in `LICENSE` within this directory.
All modifications are clearly documented in this file as required by Section 4
of the Apache License 2.0:

> "You must cause any modified files to carry prominent notices stating that
> You changed the files"
