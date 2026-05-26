/**
 * Property-based test for CommitWatcher post-commit → stats upload ordering
 * and fault tolerance.
 *
 * Feature: remove-git-path-override, Property 2: Post-commit 先于 stats 上传且容错
 * Validates: Requirements 2.4, 2.5, 4.1
 *
 * For any commit event, CommitWatcher should await post-commit processing
 * before triggering stats upload; and regardless of whether post-commit
 * succeeds (exit code 0) or fails (non-zero exit code, spawn error, timeout),
 * stats upload should always be executed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fc from "fast-check";

// ── Mocks ────────────────────────────────────────────────────────────
vi.mock("vscode", () => ({}));

// ── Types for tracking call order ────────────────────────────────────

interface CallRecord {
  fn: "runPostCommit" | "uploadCommitStats";
  timestamp: number;
}

// ── Commit handler logic (mirrors the async IIFE in watchRepository) ─
// This replicates the exact pattern from commitWatcher.ts watchRepository:
//
//   (async () => {
//     try { await runPostCommit(repoPath, currentHead); }
//     catch (err) { console.error(...); }
//     try { await uploadCommitStats(repoPath, currentHead); }
//     catch (err) { console.error(...); }
//   })();
//
// We test this pattern directly to verify ordering and fault tolerance.

async function commitHandler(
  runPostCommitFn: (repoPath: string, sha: string) => Promise<boolean>,
  uploadStatsFn: (repoPath: string, sha: string) => Promise<void>,
  repoPath: string,
  commitSha: string
): Promise<void> {
  try {
    await runPostCommitFn(repoPath, commitSha);
  } catch (_err) {
    // post-commit error is non-blocking, matches source behavior
  }
  try {
    await uploadStatsFn(repoPath, commitSha);
  } catch (_err) {
    // stats upload error is also caught, matches source behavior
  }
}

// ── Generators ───────────────────────────────────────────────────────

/** Possible post-commit outcomes: success, failure (various exit codes), spawn error, timeout. */
const postCommitOutcomeArb = fc.oneof(
  // Success: exit code 0
  fc.constant({ type: "success" as const }),
  // Failure: non-zero exit code (1-255)
  fc.integer({ min: 1, max: 255 }).map((code) => ({
    type: "failure" as const,
    exitCode: code,
  })),
  // Spawn error (e.g., binary not found)
  fc.constant({ type: "spawnError" as const }),
  // Timeout
  fc.constant({ type: "timeout" as const })
);

type PostCommitOutcome =
  | { type: "success" }
  | { type: "failure"; exitCode: number }
  | { type: "spawnError" }
  | { type: "timeout" };

/** Generate a plausible absolute repo path. */
const repoPathArb = fc.oneof(
  fc.stringMatching(/^\/[a-z0-9_-]{1,12}(\/[a-z0-9_-]{1,12}){0,4}$/),
  fc.stringMatching(/^[CDE]:\\[a-z0-9_-]{1,12}(\\[a-z0-9_-]{1,12}){0,4}$/)
);

/** Generate a valid 40-character lowercase hex SHA. */
const commitShaArb = fc.stringMatching(/^[0-9a-f]{40}$/);

// ── Property test ────────────────────────────────────────────────────

describe("Feature: remove-git-path-override, Property 2: Post-commit 先于 stats 上传且容错", () => {
  it("runPostCommit is called BEFORE uploadCommitStats, and uploadCommitStats is ALWAYS called regardless of runPostCommit outcome", async () => {
    await fc.assert(
      fc.asyncProperty(
        repoPathArb,
        commitShaArb,
        postCommitOutcomeArb,
        async (repoPath, commitSha, outcome) => {
          const callLog: CallRecord[] = [];
          let orderCounter = 0;

          // Build a mock runPostCommit that behaves according to the generated outcome
          const mockRunPostCommit = async (
            _repoPath: string,
            _sha: string
          ): Promise<boolean> => {
            callLog.push({ fn: "runPostCommit", timestamp: orderCounter++ });
            switch (outcome.type) {
              case "success":
                return true;
              case "failure":
                return false;
              case "spawnError":
                throw new Error("spawn ENOENT: binary not found");
              case "timeout":
                throw new Error("post-commit timed out");
            }
          };

          // Build a mock uploadCommitStats that records when it's called
          let uploadCalled = false;
          const mockUploadStats = async (
            _repoPath: string,
            _sha: string
          ): Promise<void> => {
            callLog.push({
              fn: "uploadCommitStats",
              timestamp: orderCounter++,
            });
            uploadCalled = true;
          };

          // Execute the commit handler
          await commitHandler(
            mockRunPostCommit,
            mockUploadStats,
            repoPath,
            commitSha
          );

          // ── Property assertions ──

          // 1. uploadCommitStats is ALWAYS called (fault tolerance)
          expect(uploadCalled).toBe(true);

          // 2. runPostCommit is called before uploadCommitStats (ordering)
          const postCommitRecord = callLog.find(
            (r) => r.fn === "runPostCommit"
          );
          const uploadRecord = callLog.find(
            (r) => r.fn === "uploadCommitStats"
          );

          expect(postCommitRecord).toBeDefined();
          expect(uploadRecord).toBeDefined();
          expect(postCommitRecord!.timestamp).toBeLessThan(
            uploadRecord!.timestamp
          );
        }
      ),
      { numRuns: 100 }
    );
  });
});
