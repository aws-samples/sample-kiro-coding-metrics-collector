/**
 * Test helper that replicates store.js logic using an in-memory SQLite database.
 * This avoids importing store.js directly (which has module-level side effects
 * that create a real database file).
 */
const Database = require("better-sqlite3");

/**
 * Create a fresh in-memory database with the same schema as store.js
 * and return store-like functions bound to it.
 */
function createTestStore() {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS commits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_name TEXT NOT NULL,
      repo_remote_url TEXT,
      branch TEXT,
      commit_sha TEXT NOT NULL,
      machine_id TEXT,
      user_name TEXT,
      user_email TEXT,
      reported_at TEXT,
      human_additions INTEGER DEFAULT 0,
      ai_additions INTEGER DEFAULT 0,
      mixed_additions INTEGER DEFAULT 0,
      ai_accepted INTEGER DEFAULT 0,
      total_ai_additions INTEGER DEFAULT 0,
      total_ai_deletions INTEGER DEFAULT 0,
      time_waiting_for_ai INTEGER DEFAULT 0,
      git_diff_added_lines INTEGER DEFAULT 0,
      git_diff_deleted_lines INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tool_model_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      commit_id INTEGER NOT NULL REFERENCES commits(id),
      tool_model TEXT NOT NULL,
      ai_additions INTEGER DEFAULT 0,
      mixed_additions INTEGER DEFAULT 0,
      ai_accepted INTEGER DEFAULT 0,
      total_ai_additions INTEGER DEFAULT 0,
      total_ai_deletions INTEGER DEFAULT 0,
      time_waiting_for_ai INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_commits_repo_name ON commits(repo_name);
    CREATE INDEX IF NOT EXISTS idx_commits_user_email ON commits(user_email);
    CREATE INDEX IF NOT EXISTS idx_commits_reported_at ON commits(reported_at);
    CREATE INDEX IF NOT EXISTS idx_tool_model_stats_commit_id ON tool_model_stats(commit_id);

    CREATE TABLE IF NOT EXISTS ai_ratio_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_name TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      ai_ratio REAL NOT NULL,
      ai_additions INTEGER NOT NULL,
      human_additions INTEGER NOT NULL,
      mixed_additions INTEGER NOT NULL,
      commit_sha TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_ai_ratio_history_repo_time
      ON ai_ratio_history(repo_name, recorded_at);
  `);

  // Prepared statements
  const insertCommit = db.prepare(`
    INSERT INTO commits (
      repo_name, repo_remote_url, branch, commit_sha, machine_id,
      user_name, user_email, reported_at,
      human_additions, ai_additions, mixed_additions,
      ai_accepted, total_ai_additions, total_ai_deletions,
      time_waiting_for_ai, git_diff_added_lines, git_diff_deleted_lines
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertToolModel = db.prepare(`
    INSERT INTO tool_model_stats (
      commit_id, tool_model,
      ai_additions, mixed_additions, ai_accepted,
      total_ai_additions, total_ai_deletions, time_waiting_for_ai
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  /**
   * Record a cumulative AI ratio snapshot for a repository.
   * Designed to be called within an existing transaction.
   */
  function recordAiRatioSnapshot(repoName, commitSha) {
    const row = db.prepare(`
      SELECT
        COALESCE(SUM(ai_additions), 0) AS ai,
        COALESCE(SUM(human_additions), 0) AS human,
        COALESCE(SUM(mixed_additions), 0) AS mixed
      FROM commits WHERE repo_name = ?
    `).get(repoName);

    const total = row.ai + row.human + row.mixed;
    if (total === 0) return;

    const ratio = row.ai / total;

    db.prepare(`
      INSERT INTO ai_ratio_history
        (repo_name, recorded_at, ai_ratio, ai_additions, human_additions, mixed_additions, commit_sha)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(repoName, new Date().toISOString(), ratio, row.ai, row.human, row.mixed, commitSha);
  }

  /**
   * Save a commit stats payload into SQLite (mirrors store.js saveStats).
   */
  function saveStats(payload) {
    const transaction = db.transaction((p) => {
      const cs = p.commit_stats || {};
      const info = insertCommit.run(
        p.repo_name, p.repo_remote_url, p.branch,
        p.commit_sha, p.machine_id,
        p.user_name, p.user_email, p.reported_at,
        cs.human_additions, cs.ai_additions, cs.mixed_additions,
        cs.ai_accepted, cs.total_ai_additions, cs.total_ai_deletions,
        cs.time_waiting_for_ai, cs.git_diff_added_lines, cs.git_diff_deleted_lines
      );
      const commitId = info.lastInsertRowid;

      const tmb = cs.tool_model_breakdown || {};
      for (const [toolModel, stats] of Object.entries(tmb)) {
        insertToolModel.run(
          commitId, toolModel,
          stats.ai_additions, stats.mixed_additions, stats.ai_accepted,
          stats.total_ai_additions, stats.total_ai_deletions,
          stats.time_waiting_for_ai
        );
      }

      recordAiRatioSnapshot(p.repo_name, p.commit_sha);
    });

    transaction(payload);
  }

  /**
   * Get the latest ai_ratio_history record for a repo.
   */
  function getLatestAiRatioSnapshot(repoName) {
    return db.prepare(`
      SELECT * FROM ai_ratio_history
      WHERE repo_name = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(repoName);
  }

  /**
   * Backfill ai_ratio_history from existing commits.
   * Only runs when the table is empty.
   */
  function backfillAiRatioHistory() {
    const count = db.prepare("SELECT COUNT(*) AS cnt FROM ai_ratio_history").get().cnt;
    if (count > 0) return;

    const commits = db.prepare(`
      SELECT repo_name, commit_sha,
             COALESCE(reported_at, created_at) AS effective_at,
             ai_additions, human_additions, mixed_additions
      FROM commits
      WHERE COALESCE(reported_at, created_at) IS NOT NULL
      ORDER BY COALESCE(reported_at, created_at) ASC
    `).all();

    if (commits.length === 0) return;

    const accumulators = {};

    const insertSnapshot = db.prepare(`
      INSERT INTO ai_ratio_history
        (repo_name, recorded_at, ai_ratio, ai_additions, human_additions, mixed_additions, commit_sha)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const runBackfill = db.transaction(() => {
      for (const commit of commits) {
        if (!accumulators[commit.repo_name]) {
          accumulators[commit.repo_name] = { ai: 0, human: 0, mixed: 0 };
        }
        const acc = accumulators[commit.repo_name];
        acc.ai += commit.ai_additions;
        acc.human += commit.human_additions;
        acc.mixed += commit.mixed_additions;

        const total = acc.ai + acc.human + acc.mixed;
        if (total === 0) continue;

        const ratio = acc.ai / total;
        insertSnapshot.run(
          commit.repo_name, commit.effective_at, ratio,
          acc.ai, acc.human, acc.mixed, commit.commit_sha
        );
      }
    });

    runBackfill();
  }

  /**
   * Get all ai_ratio_history records for a repo.
   */
  function getAiRatioHistory(repoName) {
    return db.prepare(`
      SELECT recorded_at, ai_ratio, ai_additions, human_additions, mixed_additions, commit_sha
      FROM ai_ratio_history
      WHERE repo_name = ?
      ORDER BY recorded_at ASC
    `).all(repoName);
  }

  function close() {
    db.close();
  }

  return {
    db,
    saveStats,
    recordAiRatioSnapshot,
    getLatestAiRatioSnapshot,
    getAiRatioHistory,
    backfillAiRatioHistory,
    close,
  };
}

module.exports = { createTestStore };
