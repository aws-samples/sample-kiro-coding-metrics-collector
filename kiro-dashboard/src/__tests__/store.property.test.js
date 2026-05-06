import { describe, it } from "vitest";
import fc from "fast-check";
import { createTestStore } from "./test-helpers.js";

/**
 * Feature: ai-ratio-history-chart, Property 1: Cumulative AI ratio snapshot correctness
 *
 * For any sequence of commit payloads saved to a repository, after each saveStats() call,
 * the most recent ai_ratio_history record for that repository SHALL have ai_ratio equal to
 * SUM(ai_additions) / SUM(ai_additions + human_additions + mixed_additions) computed across
 * all commits for that repository, and the snapshot SHALL contain the correct cumulative
 * ai_additions, human_additions, mixed_additions, and the triggering commit_sha.
 *
 * Validates: Requirements 2.1, 2.2
 */
describe("Feature: ai-ratio-history-chart, Property 1: Cumulative AI ratio snapshot correctness", () => {
  it("cumulative AI ratio snapshot is correct after each saveStats call", () => {
    fc.assert(
      fc.property(
        // Generate a non-empty array of commit payloads with random addition counts
        fc.array(
          fc.record({
            ai_additions: fc.integer({ min: 0, max: 10000 }),
            human_additions: fc.integer({ min: 0, max: 10000 }),
            mixed_additions: fc.integer({ min: 0, max: 10000 }),
          }),
          { minLength: 1, maxLength: 20 }
        ),
        (commits) => {
          // Fresh database for each property iteration
          const store = createTestStore();

          try {
            const repoName = "test-repo";
            let sumAi = 0;
            let sumHuman = 0;
            let sumMixed = 0;

            for (let i = 0; i < commits.length; i++) {
              const c = commits[i];
              sumAi += c.ai_additions;
              sumHuman += c.human_additions;
              sumMixed += c.mixed_additions;

              const commitSha = `sha-${i}`;
              const payload = {
                repo_name: repoName,
                repo_remote_url: "https://example.com/repo",
                branch: "main",
                commit_sha: commitSha,
                machine_id: "test-machine",
                user_name: "tester",
                user_email: "test@example.com",
                reported_at: new Date(Date.now() + i * 1000).toISOString(),
                commit_stats: {
                  human_additions: c.human_additions,
                  ai_additions: c.ai_additions,
                  mixed_additions: c.mixed_additions,
                  ai_accepted: 0,
                  total_ai_additions: 0,
                  total_ai_deletions: 0,
                  time_waiting_for_ai: 0,
                  git_diff_added_lines: 0,
                  git_diff_deleted_lines: 0,
                  tool_model_breakdown: {},
                },
              };

              store.saveStats(payload);

              const total = sumAi + sumHuman + sumMixed;
              const snapshot = store.getLatestAiRatioSnapshot(repoName);

              if (total === 0) {
                // When cumulative total is zero, no snapshot should exist yet
                continue;
              }

              // Snapshot must exist when total > 0
              if (!snapshot) return false;

              const expectedRatio = sumAi / total;

              // Verify ai_ratio with floating point tolerance
              if (Math.abs(snapshot.ai_ratio - expectedRatio) >= 1e-10) return false;

              // Verify cumulative addition counts
              if (snapshot.ai_additions !== sumAi) return false;
              if (snapshot.human_additions !== sumHuman) return false;
              if (snapshot.mixed_additions !== sumMixed) return false;

              // Verify the triggering commit_sha
              if (snapshot.commit_sha !== commitSha) return false;
            }

            return true;
          } finally {
            store.close();
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});


/**
 * Feature: ai-ratio-history-chart, Property 2: History API response ordering and completeness
 *
 * For any repository with AI ratio history records, the response from
 * getAiRatioHistory() SHALL return records sorted by recorded_at in strictly
 * ascending order, and each record SHALL contain the fields recorded_at,
 * ai_ratio, ai_additions, human_additions, mixed_additions, and commit_sha.
 *
 * Validates: Requirements 3.1, 3.2
 */
describe("Feature: ai-ratio-history-chart, Property 2: History API response ordering and completeness", () => {
  it("history records are sorted by recorded_at ascending and contain all required fields", () => {
    const REQUIRED_FIELDS = [
      "recorded_at",
      "ai_ratio",
      "ai_additions",
      "human_additions",
      "mixed_additions",
      "commit_sha",
    ];

    fc.assert(
      fc.property(
        // Generate a non-empty array of history records with random dates
        fc.array(
          fc.record({
            date: fc.date({
              min: new Date("2020-01-01T00:00:00.000Z"),
              max: new Date("2030-12-31T23:59:59.999Z"),
              noInvalidDate: true,
            }),
            ai_ratio: fc.double({ min: 0, max: 1, noNaN: true }),
            ai_additions: fc.integer({ min: 0, max: 100000 }),
            human_additions: fc.integer({ min: 0, max: 100000 }),
            mixed_additions: fc.integer({ min: 0, max: 100000 }),
            commit_sha: fc.stringMatching(/^[0-9a-f]{8,40}$/),
          }),
          { minLength: 1, maxLength: 30 }
        ),
        (records) => {
          const store = createTestStore();

          try {
            const repoName = "prop2-test-repo";

            // Insert records directly into ai_ratio_history with random timestamps
            const insert = store.db.prepare(`
              INSERT INTO ai_ratio_history
                (repo_name, recorded_at, ai_ratio, ai_additions, human_additions, mixed_additions, commit_sha)
              VALUES (?, ?, ?, ?, ?, ?, ?)
            `);

            for (const r of records) {
              insert.run(
                repoName,
                r.date.toISOString(),
                r.ai_ratio,
                r.ai_additions,
                r.human_additions,
                r.mixed_additions,
                r.commit_sha
              );
            }

            // Query via the store API
            const history = store.getAiRatioHistory(repoName);

            // Must return the same number of records we inserted
            if (history.length !== records.length) return false;

            // Verify ascending order by recorded_at
            for (let i = 1; i < history.length; i++) {
              if (history[i].recorded_at < history[i - 1].recorded_at) return false;
            }

            // Verify each record contains all required fields
            for (const record of history) {
              for (const field of REQUIRED_FIELDS) {
                if (!(field in record)) return false;
              }
            }

            return true;
          } finally {
            store.close();
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});


/**
 * Feature: ai-ratio-history-chart, Property 3: Backfill running cumulative ratio correctness
 *
 * For any set of existing commits across one or more repositories, when the backfill function
 * replays commits in reported_at ascending order, each generated snapshot SHALL have ai_ratio
 * equal to the running cumulative SUM(ai_additions) / SUM(ai_additions + human_additions +
 * mixed_additions) for that repository up to and including that commit, and the total number
 * of snapshots SHALL equal the number of commits with non-zero cumulative totals.
 *
 * Validates: Requirements 5.1, 5.2
 */
describe("Feature: ai-ratio-history-chart, Property 3: Backfill running cumulative ratio correctness", () => {
  it("backfill produces correct running cumulative ratios for multi-repo commits", () => {
    fc.assert(
      fc.property(
        // Generate 1-3 repos, each with 1-15 commits
        fc.array(
          fc.record({
            repoIndex: fc.integer({ min: 0, max: 2 }),
            ai_additions: fc.integer({ min: 0, max: 10000 }),
            human_additions: fc.integer({ min: 0, max: 10000 }),
            mixed_additions: fc.integer({ min: 0, max: 10000 }),
          }),
          { minLength: 1, maxLength: 30 }
        ),
        (commits) => {
          const store = createTestStore();

          try {
            const repoNames = ["repo-alpha", "repo-beta", "repo-gamma"];
            const baseTime = new Date("2024-01-01T00:00:00.000Z").getTime();

            // Insert commits directly into the commits table (bypass saveStats to avoid triggering recordAiRatioSnapshot)
            const insertStmt = store.db.prepare(`
              INSERT INTO commits (
                repo_name, repo_remote_url, branch, commit_sha, machine_id,
                user_name, user_email, reported_at,
                human_additions, ai_additions, mixed_additions,
                ai_accepted, total_ai_additions, total_ai_deletions,
                time_waiting_for_ai, git_diff_added_lines, git_diff_deleted_lines
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0)
            `);

            for (let i = 0; i < commits.length; i++) {
              const c = commits[i];
              const repoName = repoNames[c.repoIndex];
              const reportedAt = new Date(baseTime + i * 60000).toISOString();
              insertStmt.run(
                repoName, "https://example.com/" + repoName, "main",
                `sha-${i}`, "machine-1", "tester", "test@example.com",
                reportedAt,
                c.human_additions, c.ai_additions, c.mixed_additions
              );
            }

            // Execute backfill
            store.backfillAiRatioHistory();

            // Compute expected running cumulative ratios per repo
            // Commits are ordered by reported_at ASC, which matches insertion order (incrementing timestamps)
            const accumulators = {};
            const expectedSnapshots = {}; // repoName -> [{ai_ratio, commit_sha}]

            for (let i = 0; i < commits.length; i++) {
              const c = commits[i];
              const repoName = repoNames[c.repoIndex];

              if (!accumulators[repoName]) {
                accumulators[repoName] = { ai: 0, human: 0, mixed: 0 };
                expectedSnapshots[repoName] = [];
              }

              const acc = accumulators[repoName];
              acc.ai += c.ai_additions;
              acc.human += c.human_additions;
              acc.mixed += c.mixed_additions;

              const total = acc.ai + acc.human + acc.mixed;
              if (total === 0) continue;

              const expectedRatio = acc.ai / total;
              expectedSnapshots[repoName].push({
                ai_ratio: expectedRatio,
                commit_sha: `sha-${i}`,
              });
            }

            // Verify each repo's snapshots
            for (const repoName of repoNames) {
              const history = store.getAiRatioHistory(repoName);
              const expected = expectedSnapshots[repoName] || [];

              // Total snapshot count must equal number of commits with non-zero cumulative totals
              if (history.length !== expected.length) return false;

              for (let j = 0; j < history.length; j++) {
                // ai_ratio must match running cumulative ratio (floating point tolerance)
                if (Math.abs(history[j].ai_ratio - expected[j].ai_ratio) >= 1e-10) return false;

                // commit_sha must match
                if (history[j].commit_sha !== expected[j].commit_sha) return false;
              }
            }

            return true;
          } finally {
            store.close();
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
