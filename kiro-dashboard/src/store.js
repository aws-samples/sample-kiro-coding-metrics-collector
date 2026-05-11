const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

const DATA_DIR = path.resolve(__dirname, "..", "data");
const DB_PATH = path.join(DATA_DIR, "stats.db");

// Ensure data directory exists
fs.mkdirSync(DATA_DIR, { recursive: true });

// Initialize SQLite database
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// Create tables
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
    commit_msg TEXT DEFAULT '',
    human_additions INTEGER DEFAULT 0,
    ai_additions INTEGER DEFAULT 0,
    mixed_additions INTEGER DEFAULT 0,
    ai_accepted INTEGER DEFAULT 0,
    total_ai_additions INTEGER DEFAULT 0,
    total_ai_deletions INTEGER DEFAULT 0,
    time_waiting_for_ai INTEGER DEFAULT 0,
    git_diff_added_lines INTEGER DEFAULT 0,
    git_diff_deleted_lines INTEGER DEFAULT 0,
    ai_deletions INTEGER DEFAULT 0,
    human_deletions INTEGER DEFAULT 0,
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

// Schema migration: add ai_deletions/human_deletions columns to commits table
try { db.exec("ALTER TABLE commits ADD COLUMN ai_deletions INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE commits ADD COLUMN human_deletions INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE commits ADD COLUMN commit_msg TEXT DEFAULT ''"); } catch {}

/**
 * Backfill ai_ratio_history from existing commits.
 * Only runs when the table is empty. Replays commits in chronological order,
 * maintaining a running cumulative ratio per repository.
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

      const total = acc.ai + acc.human - acc.mixed;
      if (total === 0) continue;

      const ratio = (acc.ai - acc.mixed * 0.5) / total;
      insertSnapshot.run(
        commit.repo_name, commit.effective_at, ratio,
        acc.ai, acc.human, acc.mixed, commit.commit_sha
      );
    }
  });

  runBackfill();
}

try {
  backfillAiRatioHistory();
} catch (err) {
  console.error("backfillAiRatioHistory: failed:", err);
}

/**
 * Check if an idempotency key has already been processed.
 */
function hasIdempotencyKey(key) {
  try {
    const row = db.prepare("SELECT 1 FROM idempotency_keys WHERE key = ?").get(key);
    return !!row;
  } catch (err) {
    console.error("hasIdempotencyKey: query failed:", err);
    return false;
  }
}

/**
 * Mark an idempotency key as processed.
 */
function setIdempotencyKey(key) {
  db.prepare("INSERT OR IGNORE INTO idempotency_keys (key, created_at) VALUES (?, ?)")
    .run(key, new Date().toISOString());
}

/**
 * Save a commit stats payload into SQLite.
 * Uses a transaction to atomically insert into commits and tool_model_stats tables.
 */
function saveStats(payload) {
  const insertCommit = db.prepare(`
    INSERT INTO commits (
      repo_name, repo_remote_url, branch, commit_sha, machine_id,
      user_name, user_email, reported_at, commit_msg,
      human_additions, ai_additions, mixed_additions,
      ai_accepted, total_ai_additions, total_ai_deletions,
      time_waiting_for_ai, git_diff_added_lines, git_diff_deleted_lines,
      ai_deletions, human_deletions
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertToolModel = db.prepare(`
    INSERT INTO tool_model_stats (
      commit_id, tool_model,
      ai_additions, mixed_additions, ai_accepted,
      total_ai_additions, total_ai_deletions, time_waiting_for_ai
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const transaction = db.transaction((p) => {
    const cs = p.commit_stats || {};
    const info = insertCommit.run(
      p.repo_name, p.repo_remote_url, p.branch,
      p.commit_sha, p.machine_id,
      p.user_name, p.user_email, p.reported_at, p.commit_msg || "",
      cs.human_additions, cs.ai_additions, cs.mixed_additions,
      cs.ai_accepted, cs.total_ai_additions, cs.total_ai_deletions,
      cs.time_waiting_for_ai, cs.git_diff_added_lines, cs.git_diff_deleted_lines,
      cs.ai_deletions || 0, cs.human_deletions || 0
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
 * List all repos that have stats data.
 */
function listRepos() {
  try {
    const rows = db.prepare("SELECT DISTINCT repo_name FROM commits ORDER BY repo_name").all();
    return rows.map(r => r.repo_name);
  } catch (err) {
    console.error("listRepos: query failed:", err);
    return [];
  }
}

/**
 * Get all commit records for a repo (across all users),
 * sorted by reported_at descending.
 */
function getRepoStats(repoName) {
  try {
    const commits = db.prepare(
      "SELECT * FROM commits WHERE repo_name = ? ORDER BY reported_at DESC"
    ).all(repoName);

    const selectToolModels = db.prepare(
      "SELECT tool_model, ai_additions, mixed_additions, ai_accepted, total_ai_additions, total_ai_deletions, time_waiting_for_ai FROM tool_model_stats WHERE commit_id = ?"
    );

    return commits.map((row) => {
      const toolModelRows = selectToolModels.all(row.id);
      const tool_model_breakdown = {};
      for (const tm of toolModelRows) {
        tool_model_breakdown[tm.tool_model] = {
          ai_additions: tm.ai_additions,
          mixed_additions: tm.mixed_additions,
          ai_accepted: tm.ai_accepted,
          total_ai_additions: tm.total_ai_additions,
          total_ai_deletions: tm.total_ai_deletions,
          time_waiting_for_ai: tm.time_waiting_for_ai,
        };
      }

      return {
        repo_name: row.repo_name,
        repo_remote_url: row.repo_remote_url,
        branch: row.branch,
        commit_sha: row.commit_sha,
        commit_msg: row.commit_msg || "",
        machine_id: row.machine_id,
        user_name: row.user_name,
        user_email: row.user_email,
        reported_at: row.reported_at,
        commit_stats: {
          human_additions: row.human_additions,
          ai_additions: row.ai_additions,
          mixed_additions: row.mixed_additions,
          ai_accepted: row.ai_accepted,
          total_ai_additions: row.total_ai_additions,
          total_ai_deletions: row.total_ai_deletions,
          time_waiting_for_ai: row.time_waiting_for_ai,
          git_diff_added_lines: row.git_diff_added_lines,
          git_diff_deleted_lines: row.git_diff_deleted_lines,
          tool_model_breakdown,
        },
      };
    });
  } catch (err) {
    console.error("getRepoStats: query failed:", err);
    return [];
  }
}

/**
 * Aggregate all commit records for a repo into a summary.
 * Uses SQL SUM() aggregation for efficiency.
 */
function aggregateRepoStats(repoName) {
  try {
    // Get totals via SQL SUM()
    const totalsRow = db.prepare(`
    SELECT
      COALESCE(SUM(human_additions), 0) AS human_additions,
      COALESCE(SUM(ai_additions), 0) AS ai_additions,
      COALESCE(SUM(mixed_additions), 0) AS mixed_additions,
      COALESCE(SUM(ai_accepted), 0) AS ai_accepted,
      COALESCE(SUM(total_ai_additions), 0) AS total_ai_additions,
      COALESCE(SUM(total_ai_deletions), 0) AS total_ai_deletions,
      COALESCE(SUM(time_waiting_for_ai), 0) AS time_waiting_for_ai,
      COALESCE(SUM(git_diff_added_lines), 0) AS git_diff_added_lines,
      COALESCE(SUM(git_diff_deleted_lines), 0) AS git_diff_deleted_lines,
      COALESCE(SUM(ai_deletions), 0) AS ai_deletions,
      COALESCE(SUM(human_deletions), 0) AS human_deletions,
      COUNT(*) AS commit_count
    FROM commits WHERE repo_name = ?
    `).get(repoName);

    if (!totalsRow || totalsRow.commit_count === 0) {
      return null;
    }

    // Get latest record's branch, commit_sha, reported_at
    const latestRow = db.prepare(
    "SELECT branch, commit_sha, reported_at FROM commits WHERE repo_name = ? ORDER BY reported_at DESC LIMIT 1"
    ).get(repoName);

    // Aggregate by user using SQL GROUP BY
    // Use NULLIF to treat empty strings as NULL, matching the original JS || logic
    const userRows = db.prepare(`
    SELECT
      COALESCE(NULLIF(user_email, ''), NULLIF(user_name, ''), 'anonymous') AS user_key,
      COALESCE(MAX(user_name), '') AS user_name,
      COALESCE(MAX(user_email), '') AS user_email,
      COALESCE(SUM(human_additions), 0) AS human_additions,
      COALESCE(SUM(ai_additions), 0) AS ai_additions,
      COALESCE(SUM(mixed_additions), 0) AS mixed_additions,
      COALESCE(SUM(ai_accepted), 0) AS ai_accepted,
      COALESCE(SUM(git_diff_added_lines), 0) AS git_diff_added_lines,
      COUNT(*) AS commit_count,
      COALESCE(SUM(time_waiting_for_ai), 0) AS time_waiting_for_ai
    FROM commits WHERE repo_name = ?
    GROUP BY user_key
    `).all(repoName);

    const byUser = {};
    for (const row of userRows) {
      byUser[row.user_key] = {
        user_name: row.user_name,
        user_email: row.user_email,
        human_additions: row.human_additions,
        ai_additions: row.ai_additions,
        mixed_additions: row.mixed_additions,
        ai_accepted: row.ai_accepted,
        git_diff_added_lines: row.git_diff_added_lines,
        commit_count: row.commit_count,
        time_waiting_for_ai: row.time_waiting_for_ai,
      };
    }

    // Aggregate by tool_model using SQL GROUP BY on tool_model_stats
    const toolModelRows = db.prepare(`
    SELECT
      tms.tool_model,
      COALESCE(SUM(tms.ai_additions), 0) AS ai_additions,
      COALESCE(SUM(tms.mixed_additions), 0) AS mixed_additions,
      COALESCE(SUM(tms.ai_accepted), 0) AS ai_accepted,
      COALESCE(SUM(tms.total_ai_additions), 0) AS total_ai_additions,
      COALESCE(SUM(tms.total_ai_deletions), 0) AS total_ai_deletions,
      COALESCE(SUM(tms.time_waiting_for_ai), 0) AS time_waiting_for_ai
    FROM tool_model_stats tms
    JOIN commits c ON tms.commit_id = c.id
    WHERE c.repo_name = ?
    GROUP BY tms.tool_model
    `).all(repoName);

    const byToolModel = {};
    for (const row of toolModelRows) {
      byToolModel[row.tool_model] = {
        ai_additions: row.ai_additions,
        mixed_additions: row.mixed_additions,
        ai_accepted: row.ai_accepted,
        total_ai_additions: row.total_ai_additions,
        total_ai_deletions: row.total_ai_deletions,
        time_waiting_for_ai: row.time_waiting_for_ai,
      };
    }

    return {
      repo_name: repoName,
      branch: latestRow.branch,
      commit_sha: latestRow.commit_sha,
      reported_at: latestRow.reported_at,
      totals: {
        human_additions: totalsRow.human_additions,
        ai_additions: totalsRow.ai_additions,
        mixed_additions: totalsRow.mixed_additions,
        ai_accepted: totalsRow.ai_accepted,
        total_ai_additions: totalsRow.total_ai_additions,
        total_ai_deletions: totalsRow.total_ai_deletions,
        time_waiting_for_ai: totalsRow.time_waiting_for_ai,
        git_diff_added_lines: totalsRow.git_diff_added_lines,
        git_diff_deleted_lines: totalsRow.git_diff_deleted_lines,
        ai_deletions: totalsRow.ai_deletions,
        human_deletions: totalsRow.human_deletions,
        commit_count: totalsRow.commit_count,
      },
      by_user: byUser,
      by_tool_model: byToolModel,
    };
  } catch (err) {
    console.error("aggregateRepoStats: query failed:", err);
    return null;
  }
}

/**
 * Get a summary of all repos with aggregated stats.
 */
function getAllReposSummary() {
  try {
    const repos = listRepos();
    return repos
      .map((name) => {
        const agg = aggregateRepoStats(name);
        if (!agg) {
          return { repo_name: name };
        }
        const t = agg.totals;
        return {
          repo_name: name,
          branch: agg.branch,
          commit_sha: agg.commit_sha,
          reported_at: agg.reported_at,
          human_additions: t.human_additions,
          ai_additions: t.ai_additions,
          mixed_additions: t.mixed_additions,
          ai_accepted: t.ai_accepted,
          git_diff_added_lines: t.git_diff_added_lines,
          commit_count: t.commit_count,
          time_waiting_for_ai: t.time_waiting_for_ai,
          user_count: Object.keys(agg.by_user).length,
          by_tool_model: agg.by_tool_model,
        };
      })
      .filter((r) => r.commit_count !== undefined);
  } catch (err) {
    console.error("getAllReposSummary: query failed:", err);
    return [];
  }
}

/**
 * Record a cumulative AI ratio snapshot for a repository.
 * Designed to be called within an existing transaction — does NOT open its own.
 */
function recordAiRatioSnapshot(repoName, commitSha) {
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(ai_additions), 0) AS ai,
      COALESCE(SUM(human_additions), 0) AS human,
      COALESCE(SUM(mixed_additions), 0) AS mixed
    FROM commits WHERE repo_name = ?
  `).get(repoName);

  const total = row.ai + row.human - row.mixed;
  if (total === 0) return;

  const ratio = (row.ai - row.mixed * 0.5) / total;

  db.prepare(`
    INSERT INTO ai_ratio_history
      (repo_name, recorded_at, ai_ratio, ai_additions, human_additions, mixed_additions, commit_sha)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(repoName, new Date().toISOString(), ratio, row.ai, row.human, row.mixed, commitSha);
}

/**
 * Get AI ratio history for a repository, sorted by recorded_at ascending.
 */
function getAiRatioHistory(repoName) {
  try {
    return db.prepare(`
      SELECT recorded_at, ai_ratio, ai_additions, human_additions, mixed_additions, commit_sha
      FROM ai_ratio_history
      WHERE repo_name = ?
      ORDER BY recorded_at ASC
    `).all(repoName);
  } catch (err) {
    console.error("getAiRatioHistory: query failed:", err);
    return [];
  }
}

// ==================== 用户管理 (userManagement) ====================

// 建表（含 schema 迁移）
db.exec(`
  CREATE TABLE IF NOT EXISTS kiro_user (
    user_name      TEXT PRIMARY KEY,
    user_id        TEXT DEFAULT '',
    created_at     TEXT NOT NULL,
    user_ip        TEXT DEFAULT '',
    credit_used    TEXT DEFAULT '{}',
    updated_at     TEXT NOT NULL,
    plugin_added   INTEGER DEFAULT 0
  )
`);

// Schema 迁移：为旧表添加新列（如果不存在）
try { db.exec("ALTER TABLE kiro_user ADD COLUMN user_id TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE kiro_user ADD COLUMN plugin_added INTEGER DEFAULT 0"); } catch {}

// ==================== sessions 表（CloudTrail SSO 登录会话） ====================
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    session_id     TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL,
    expire_time    TEXT NOT NULL
  )
`);
db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)");

// ==================== plugins 表（插件活跃设备） ====================
db.exec(`
  CREATE TABLE IF NOT EXISTS plugins (
    hostname       TEXT PRIMARY KEY,
    user_name      TEXT NOT NULL,
    ip             TEXT DEFAULT '',
    last_updated   TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);
db.exec("CREATE INDEX IF NOT EXISTS idx_plugins_user_name ON plugins(user_name)");
// 迁移：如果旧表用 mac_address 做主键，重建为 hostname 主键
try { db.exec("ALTER TABLE plugins RENAME COLUMN mac_address TO hostname"); } catch {}

const stmtGetUser = db.prepare("SELECT * FROM kiro_user WHERE user_name = ?");
const stmtAllUsers = db.prepare("SELECT * FROM kiro_user ORDER BY updated_at DESC");
const stmtInsertUser = db.prepare(`
  INSERT OR IGNORE INTO kiro_user (user_name, user_id, created_at, user_ip, credit_used, updated_at, plugin_added)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const stmtUpdateUser = db.prepare(`
  UPDATE kiro_user SET user_ip = ?, credit_used = ?, updated_at = ?, plugin_added = ?
  WHERE user_name = ?
`);
const stmtUpdateCreditsOnly = db.prepare(`
  UPDATE kiro_user SET credit_used = ?
  WHERE user_name = ?
`);

function getUser(userName) {
  const row = stmtGetUser.get(userName);
  return row ? { ...row, credit_used: safeParseJson(row.credit_used), plugin_added: !!row.plugin_added } : null;
}

function getAllUsers() {
  return stmtAllUsers.all().map((row) => ({
    ...row,
    credit_used: safeParseJson(row.credit_used),
    plugin_added: !!row.plugin_added,
  }));
}

/**
 * 从 IAM Identity Center 用户列表同步到本地表。
 * 只插入不存在的用户（INSERT OR IGNORE），不覆盖已有数据。
 */
function syncIdCUsersToLocal(idcUsers) {
  const now = new Date().toISOString();
  const insertBatch = db.transaction((users) => {
    for (const u of users) {
      stmtInsertUser.run(u.userName, u.userId, now, "", "{}", 0, 0);
    }
  });
  insertBatch(idcUsers);
  console.log(`[userManagement] Synced ${idcUsers.length} IdC user(s) to local table`);
}

/**
 * userSync: 更新用户记录。
 * - 插件调用（_overwrite_credits 为 falsy）：更新 ip、updated_at、plugin_added=1，credits 累加
 *   同时如果有 hostname，upsert 到 plugins 表
 * - S3 同步（_overwrite_credits=true）：只更新 credit_used（覆盖），不动 updated_at 和 plugin_added
 */
function userSync(payload) {
  const { user_name, user_ip, credit_used, _overwrite_credits, hostname } = payload;
  if (!user_name) { throw new Error("user_name is required"); }

  const now = new Date().toISOString();
  const existing = getUser(user_name);

  if (!existing) {
    const isPlugin = !_overwrite_credits;
    stmtInsertUser.run(user_name, "", now, user_ip || "", JSON.stringify(credit_used || {}), now, isPlugin ? 1 : 0);
    console.log(`[userManagement] Created user: ${user_name} (source=${isPlugin ? "plugin" : "s3"})`);
  } else {
    const existingCredits = existing.credit_used || {};
    const incomingCredits = credit_used || {};

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    if (_overwrite_credits) {
      const merged = { ...existingCredits, ...Object.fromEntries(Object.entries(incomingCredits).filter(([, v]) => typeof v === "number")) };
      const trimmed = Object.fromEntries(Object.entries(merged).filter(([d]) => d >= cutoffStr));
      stmtUpdateCreditsOnly.run(JSON.stringify(trimmed), user_name);
      console.log(`[userManagement] Updated credits (s3): ${user_name}`);
    } else {
      const merged = Object.entries(incomingCredits).reduce((acc, [d, v]) => {
        acc[d] = (acc[d] || 0) + (typeof v === "number" ? v : 0); return acc;
      }, { ...existingCredits });
      const trimmed = Object.fromEntries(Object.entries(merged).filter(([d]) => d >= cutoffStr));
      stmtUpdateUser.run(user_ip || existing.user_ip || "", JSON.stringify(trimmed), now, 1, user_name);
      console.log(`[userManagement] Updated user (plugin): ${user_name}`);
    }
  }

  // 插件调用时，如果有 hostname，upsert 到 plugins 表
  if (!_overwrite_credits && hostname) {
    upsertPlugin(hostname, user_name, user_ip || "");
  }
}

function safeParseJson(str) {
  try { return JSON.parse(str || "{}"); } catch { return {}; }
}

// ==================== sessions 表操作 ====================

/**
 * 批量 upsert session 记录
 */
function upsertSessions(sessions) {
  const stmt = db.prepare(`
    INSERT INTO sessions (session_id, user_id, expire_time)
    VALUES (?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET user_id = excluded.user_id, expire_time = excluded.expire_time
  `);
  const batch = db.transaction((rows) => {
    for (const s of rows) {
      stmt.run(s.session_id, s.user_id, s.expire_time);
    }
  });
  batch(sessions);
}

/**
 * 删除已过期的 session（expire_time < 当前时间）
 */
function deleteExpiredSessions() {
  const now = new Date().toISOString();
  const info = db.prepare("DELETE FROM sessions WHERE expire_time < ?").run(now);
  return info.changes;
}

/**
 * 按 user_id 查询活跃 session 数
 */
function countSessionsByUserId(userId) {
  const row = db.prepare("SELECT COUNT(*) AS cnt FROM sessions WHERE user_id = ?").get(userId);
  return row ? row.cnt : 0;
}

/**
 * 获取 session 表总行数
 */
function getTotalSessionCount() {
  const row = db.prepare("SELECT COUNT(*) AS cnt FROM sessions").get();
  return row ? row.cnt : 0;
}

// ==================== plugins 表操作 ====================

/**
 * upsert 一条 plugin 记录
 */
function upsertPlugin(hostname, userName, ip) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO plugins (hostname, user_name, ip, last_updated)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(hostname) DO UPDATE SET user_name = excluded.user_name, ip = excluded.ip, last_updated = excluded.last_updated
  `).run(hostname, userName, ip, now);
}

/**
 * 按 user_name 查询活跃插件数
 */
function countPluginsByUserName(userName) {
  const row = db.prepare("SELECT COUNT(*) AS cnt FROM plugins WHERE user_name = ?").get(userName);
  return row ? row.cnt : 0;
}

/**
 * 获取 plugins 表总行数
 */
function getTotalPluginCount() {
  const row = db.prepare("SELECT COUNT(*) AS cnt FROM plugins").get();
  return row ? row.cnt : 0;
}

module.exports = {
  hasIdempotencyKey,
  setIdempotencyKey,
  saveStats,
  listRepos,
  getRepoStats,
  aggregateRepoStats,
  getAllReposSummary,
  getAiRatioHistory,
  // 用户管理
  getUser,
  getAllUsers,
  userSync,
  syncIdCUsersToLocal,
  // sessions
  upsertSessions,
  deleteExpiredSessions,
  countSessionsByUserId,
  getTotalSessionCount,
  // plugins
  upsertPlugin,
  countPluginsByUserName,
  getTotalPluginCount,
};
