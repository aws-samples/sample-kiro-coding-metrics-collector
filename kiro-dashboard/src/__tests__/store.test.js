import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestStore } from "./test-helpers.js";

/**
 * Unit tests for store layer — AI ratio history snapshot logic.
 */
describe("ai_ratio_history — zero cumulative total", () => {
  let store;

  beforeEach(() => {
    store = createTestStore();
  });

  afterEach(() => {
    store.close();
  });

  /**
   * When all commit additions (ai + human + mixed) are zero,
   * no snapshot should be inserted into ai_ratio_history.
   *
   * Validates: Requirements 2.3
   */
  it("should not insert a snapshot when ai + human + mixed are all zero", () => {
    store.saveStats({
      repo_name: "zero-repo",
      repo_remote_url: "https://example.com/zero-repo",
      branch: "main",
      commit_sha: "abc123",
      machine_id: "machine-1",
      user_name: "tester",
      user_email: "test@example.com",
      reported_at: new Date().toISOString(),
      commit_stats: {
        human_additions: 0,
        ai_additions: 0,
        mixed_additions: 0,
        ai_accepted: 0,
        total_ai_additions: 0,
        total_ai_deletions: 0,
        time_waiting_for_ai: 0,
        git_diff_added_lines: 0,
        git_diff_deleted_lines: 0,
        tool_model_breakdown: {},
      },
    });

    const rows = store.db
      .prepare("SELECT COUNT(*) AS cnt FROM ai_ratio_history")
      .get();

    expect(rows.cnt).toBe(0);
  });
});


/**
 * Unit tests for store layer — query and backfill edge cases.
 */
describe("ai_ratio_history — query and backfill edge cases", () => {
  let store;

  beforeEach(() => {
    store = createTestStore();
  });

  afterEach(() => {
    store.close();
  });

  /**
   * A repo that has commits but no ai_ratio_history records
   * should return an empty array from getAiRatioHistory.
   *
   * Validates: Requirements 3.3
   */
  it("should return empty array for repo with no history records", () => {
    // Insert a commit with all-zero additions so no snapshot is created
    store.saveStats({
      repo_name: "empty-history-repo",
      repo_remote_url: "https://example.com/empty-history-repo",
      branch: "main",
      commit_sha: "aaa111",
      machine_id: "m1",
      user_name: "tester",
      user_email: "test@example.com",
      reported_at: new Date().toISOString(),
      commit_stats: {
        human_additions: 0,
        ai_additions: 0,
        mixed_additions: 0,
        ai_accepted: 0,
        total_ai_additions: 0,
        total_ai_deletions: 0,
        time_waiting_for_ai: 0,
        git_diff_added_lines: 0,
        git_diff_deleted_lines: 0,
        tool_model_breakdown: {},
      },
    });

    // Repo exists in commits table but has no history snapshots
    const history = store.getAiRatioHistory("empty-history-repo");
    expect(history).toEqual([]);
  });

  /**
   * A repo that doesn't exist at all should return an empty array.
   *
   * Validates: Requirements 3.4
   */
  it("should return empty array for non-existent repo", () => {
    const history = store.getAiRatioHistory("repo-that-does-not-exist");
    expect(history).toEqual([]);
  });

  /**
   * Backfill should be idempotent: calling it a second time
   * should not insert any additional records.
   *
   * Validates: Requirements 5.3
   */
  it("backfill should be idempotent — second call adds no records", () => {
    // Insert some commits directly into the commits table
    const insertCommit = store.db.prepare(`
      INSERT INTO commits (repo_name, commit_sha, reported_at,
        ai_additions, human_additions, mixed_additions)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    insertCommit.run("idempotent-repo", "sha1", "2024-01-01T00:00:00Z", 10, 20, 5);
    insertCommit.run("idempotent-repo", "sha2", "2024-01-02T00:00:00Z", 15, 25, 10);

    // First backfill — should insert snapshots
    store.backfillAiRatioHistory();
    const countAfterFirst = store.db
      .prepare("SELECT COUNT(*) AS cnt FROM ai_ratio_history")
      .get().cnt;

    expect(countAfterFirst).toBeGreaterThan(0);

    // Second backfill — should be a no-op
    store.backfillAiRatioHistory();
    const countAfterSecond = store.db
      .prepare("SELECT COUNT(*) AS cnt FROM ai_ratio_history")
      .get().cnt;

    expect(countAfterSecond).toBe(countAfterFirst);
  });
});
