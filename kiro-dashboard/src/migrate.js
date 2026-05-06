#!/usr/bin/env node

/**
 * Migration script: reads existing JSON files from data/ directory
 * and imports them into the SQLite database via saveStats().
 *
 * Usage: node src/migrate.js
 *
 * - Skips .idempotency/ directory and stats.db files
 * - Uses commit_sha for deduplication (won't import duplicates)
 * - Logs progress: files found, imported, skipped, errors
 */

const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const { saveStats } = require("./store.js");

const DATA_DIR = path.resolve(__dirname, "..", "data");
const DB_PATH = path.join(DATA_DIR, "stats.db");

// Open a separate db connection for dedup checks
const db = new Database(DB_PATH);
const checkCommitExists = db.prepare(
  "SELECT 1 FROM commits WHERE commit_sha = ? LIMIT 1"
);

/**
 * Recursively find all .json files under a directory,
 * skipping .idempotency/ and stats.db related files.
 */
function findJsonFiles(dir) {
  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    console.error(`  [warn] Cannot read directory ${dir}: ${err.message}`);
    return results;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      // Skip .idempotency directory
      if (entry.name === ".idempotency") continue;
      results.push(...findJsonFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      // Skip stats.db related files
      if (entry.name.startsWith("stats.db")) continue;
      results.push(fullPath);
    }
  }

  return results;
}

function migrate() {
  console.log(`Migration: scanning ${DATA_DIR} for JSON files...`);

  const jsonFiles = findJsonFiles(DATA_DIR);
  console.log(`Found ${jsonFiles.length} JSON file(s).`);

  let imported = 0;
  let skipped = 0;
  let errors = 0;

  for (const filePath of jsonFiles) {
    const relPath = path.relative(DATA_DIR, filePath);
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const payload = JSON.parse(raw);

      if (!payload.commit_sha) {
        console.warn(`  [skip] ${relPath}: missing commit_sha`);
        skipped++;
        continue;
      }

      // Dedup check
      const exists = checkCommitExists.get(payload.commit_sha);
      if (exists) {
        skipped++;
        continue;
      }

      saveStats(payload);
      imported++;
    } catch (err) {
      console.error(`  [error] ${relPath}: ${err.message}`);
      errors++;
    }
  }

  console.log(
    `\nMigration complete: ${imported} imported, ${skipped} skipped (duplicates), ${errors} error(s).`
  );
}

migrate();
db.close();
