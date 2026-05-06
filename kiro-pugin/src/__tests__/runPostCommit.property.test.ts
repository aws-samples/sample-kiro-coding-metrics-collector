/**
 * Property-based test for runPostCommit command argument correctness.
 *
 * Feature: remove-git-path-override, Property 1: Post-commit 命令参数正确性
 * Validates: Requirements 2.2
 *
 * For any valid repo path and commit SHA, when CommitWatcher invokes the
 * git-ai binary, the generated command arguments should contain
 * `post-commit <commitSha>`, cwd should be set to repoPath, and the SHA
 * should match the detected value exactly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fc from "fast-check";

// ── Mocks ────────────────────────────────────────────────────────────
// Must be set up before importing the module under test.

// Mock vscode (not available outside the extension host)
vi.mock("vscode", () => ({}));

// Track spawn calls
const spawnCalls: Array<{
  command: string;
  args: string[];
  options: Record<string, unknown>;
}> = [];

// Create a fake ChildProcess that immediately emits "close" with code 0
function makeFakeProc() {
  const listeners: Record<string, Function[]> = {};
  return {
    stdout: {
      on(_event: string, _cb: Function) {},
    },
    stderr: {
      on(_event: string, _cb: Function) {},
    },
    on(event: string, cb: Function) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(cb);
      // Emit "close" with code 0 on next tick so the promise resolves
      if (event === "close") {
        setTimeout(() => cb(0), 0);
      }
    },
    kill() {},
  };
}

vi.mock("node:child_process", () => ({
  spawn: (command: string, args: string[], options: Record<string, unknown>) => {
    spawnCalls.push({ command, args, options });
    return makeFakeProc();
  },
  execFileSync: vi.fn(),
}));

// Mock getGitAiBinary – returns a deterministic path so we can assert on it
const FAKE_BINARY = "/mock/bin/git-ai";
vi.mock("../checkpoint", () => ({
  getGitAiBinary: () => FAKE_BINARY,
}));

// Mock statsUploader (imported transitively by commitWatcher)
vi.mock("../statsUploader", () => ({
  uploadCommitStats: vi.fn().mockResolvedValue(undefined),
}));

// ── Import module under test AFTER mocks are registered ──────────────
import { runPostCommit } from "../commitWatcher";

// ── Generators ───────────────────────────────────────────────────────

/** Generate a plausible absolute repo path (Unix or Windows style). */
const repoPathArb = fc.oneof(
  // Unix-style paths: /seg1/seg2/...
  fc.stringMatching(/^\/[a-z0-9_-]{1,12}(\/[a-z0-9_-]{1,12}){0,4}$/),
  // Windows-style paths: C:\seg1\seg2\...
  fc.stringMatching(/^[CDE]:\\[a-z0-9_-]{1,12}(\\[a-z0-9_-]{1,12}){0,4}$/)
);

/** Generate a valid 40-character lowercase hex SHA. */
const commitShaArb = fc.stringMatching(/^[0-9a-f]{40}$/);

// ── Property test ────────────────────────────────────────────────────

describe("Feature: remove-git-path-override, Property 1: Post-commit 命令参数正确性", () => {
  beforeEach(() => {
    spawnCalls.length = 0;
  });

  it("spawn receives correct binary, args ['post-commit', commitSha], and cwd = repoPath", async () => {
    await fc.assert(
      fc.asyncProperty(repoPathArb, commitShaArb, async (repoPath, commitSha) => {
        spawnCalls.length = 0;

        const result = await runPostCommit(repoPath, commitSha);

        // Should have called spawn exactly once
        expect(spawnCalls).toHaveLength(1);

        const call = spawnCalls[0];

        // Binary path matches what getGitAiBinary returns
        expect(call.command).toBe(FAKE_BINARY);

        // Args are exactly ["post-commit", <commitSha>]
        expect(call.args).toEqual(["post-commit", commitSha]);

        // cwd is set to the provided repoPath
        expect(call.options.cwd).toBe(repoPath);

        // Process exited with code 0 → should return true
        expect(result).toBe(true);
      }),
      { numRuns: 100 }
    );
  });
});
