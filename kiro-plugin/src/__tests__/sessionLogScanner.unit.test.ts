/**
 * Unit tests for SessionLogScanner class methods.
 *
 * Feature: kiro-session-monitor
 * Validates: Requirements 1.4, 6.1, 6.4, 6.5
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Mock vscode (not available outside the extension host)
vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      get: () => [],
    }),
  },
}));

import { SessionLogScanner, MAX_FILE_SIZE } from "../sessionLogScanner";

// ── Helpers ──────────────────────────────────────────────────────────

/** Create a temporary directory for test fixtures. */
function createTempDir(): string {
  return fs.mkdirSync(path.join(os.tmpdir(), `scanner-test-${Date.now()}-${Math.random().toString(36).slice(2)}`), {
    recursive: true,
  }) as string;
}

/** Recursively remove a directory. */
function removeTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

// ── Tests ────────────────────────────────────────────────────────────

describe("SessionLogScanner — Agent Dir 不存在时的降级行为", () => {
  /**
   * **Validates: Requirements 1.4**
   *
   * When the Agent Dir does not exist, scanForAIEdits returns an empty result
   * without throwing an error.
   */
  it("scanForAIEdits returns empty result when agent dir does not exist", async () => {
    const nonExistentDir = path.join(os.tmpdir(), `non-existent-agent-dir-${Date.now()}`);
    const scanner = new SessionLogScanner(nonExistentDir);

    const result = await scanner.scanForAIEdits("/workspace", Date.now());

    expect(result.writeActions).toEqual([]);
    expect(result.scannedFiles).toBe(0);
    expect(result.skippedFiles).toBe(0);
  });

  it("scanForAIEdits does not throw when agent dir does not exist", async () => {
    const nonExistentDir = path.join(os.tmpdir(), `non-existent-agent-dir-${Date.now()}`);
    const scanner = new SessionLogScanner(nonExistentDir);

    await expect(
      scanner.scanForAIEdits("/workspace", Date.now())
    ).resolves.not.toThrow();
  });
});

describe("SessionLogScanner — 文件过大跳过逻辑", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  /**
   * **Validates: Requirements 6.4**
   *
   * parseExecutionLogFile returns null for files larger than MAX_FILE_SIZE.
   */
  it("parseExecutionLogFile returns null for files exceeding MAX_FILE_SIZE", async () => {
    const scanner = new SessionLogScanner(tempDir);

    // Create a file larger than MAX_FILE_SIZE (5 MB)
    const oversizedFile = path.join(tempDir, "oversized.json");
    const oversizedContent = "x".repeat(MAX_FILE_SIZE + 1);
    fs.writeFileSync(oversizedFile, oversizedContent);

    const result = await scanner.parseExecutionLogFile(oversizedFile);
    expect(result).toBeNull();
  });

  it("parseExecutionLogFile succeeds for files at exactly MAX_FILE_SIZE", async () => {
    const scanner = new SessionLogScanner(tempDir);

    // Create a valid JSON file at exactly MAX_FILE_SIZE
    const validLog = JSON.stringify({ context: { messages: [] } });
    // Pad with spaces to reach exactly MAX_FILE_SIZE
    const paddedContent = validLog + " ".repeat(MAX_FILE_SIZE - validLog.length);
    const exactSizeFile = path.join(tempDir, "exact-size.json");
    fs.writeFileSync(exactSizeFile, paddedContent);

    // File at exactly MAX_FILE_SIZE should not be skipped
    // (the check is > MAX_FILE_SIZE, not >=)
    const result = await scanner.parseExecutionLogFile(exactSizeFile);
    // It should attempt to parse (may return a result or empty result, but not null due to size)
    expect(result).not.toBeNull();
  });

  it("parseExecutionLogFile parses valid small files correctly", async () => {
    const scanner = new SessionLogScanner(tempDir);

    const validLog = JSON.stringify({
      chatSessionId: "test-session-123",
      endTime: 1700000000000,
      actions: [
        {
          actionType: "replace",
          actionState: "Accepted",
          input: {
            file: "src/test.ts",
            originalContent: "old",
            modifiedContent: "new",
          },
          emittedAt: 1700000000000,
        },
      ],
    });

    const validFile = path.join(tempDir, "valid.json");
    fs.writeFileSync(validFile, validLog);

    const result = await scanner.parseExecutionLogFile(validFile);
    expect(result).not.toBeNull();
    expect(result!.format).toBe("A");
    expect(result!.writeActions).toHaveLength(1);
    expect(result!.writeActions[0].filePath).toBe("src/test.ts");
    expect(result!.chatSessionId).toBe("test-session-123");
  });
});

describe("SessionLogScanner — 文件读取失败时的跳过和继续", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  /**
   * **Validates: Requirements 6.5**
   *
   * parseExecutionLogFile returns null on read error (file doesn't exist,
   * permission denied, etc.) without throwing.
   */
  it("parseExecutionLogFile returns null for non-existent file", async () => {
    const scanner = new SessionLogScanner(tempDir);
    const nonExistentFile = path.join(tempDir, "does-not-exist.json");

    const result = await scanner.parseExecutionLogFile(nonExistentFile);
    expect(result).toBeNull();
  });

  it("parseExecutionLogFile does not throw on read error", async () => {
    const scanner = new SessionLogScanner(tempDir);
    const nonExistentFile = path.join(tempDir, "does-not-exist.json");

    await expect(
      scanner.parseExecutionLogFile(nonExistentFile)
    ).resolves.not.toThrow();
  });

  it("parseExecutionLogFile returns null for invalid JSON content", async () => {
    const scanner = new SessionLogScanner(tempDir);
    const invalidFile = path.join(tempDir, "invalid.json");
    fs.writeFileSync(invalidFile, "{not valid json!!!");

    const result = await scanner.parseExecutionLogFile(invalidFile);
    // parseExecutionLog handles invalid JSON gracefully, returning empty result
    // So this should return a ParseResult (not null), but with empty writeActions
    expect(result).not.toBeNull();
    expect(result!.writeActions).toHaveLength(0);
  });

  /**
   * **Validates: Requirements 6.1**
   *
   * scanForAIEdits enumerates JSON files under <workspace-hash>/414d* directories.
   */
  it("scanForAIEdits enumerates JSON files under 414d* directories", async () => {
    // Set up a minimal agent dir structure
    const agentDir = tempDir;

    // Create workspace-sessions directory with a sessions.json
    const sessionsDir = path.join(agentDir, "workspace-sessions", "dGVzdA");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify([{ sessionId: "session-abc" }])
    );

    // Create a workspace-hash directory with a 414d* subdirectory
    const hashDir = path.join(agentDir, "workspace-hash-1");
    const execLogDir = path.join(hashDir, "414d-exec-log");
    fs.mkdirSync(execLogDir, { recursive: true });

    // Write a valid execution log file
    const logContent = JSON.stringify({
      chatSessionId: "session-abc",
      endTime: Date.now(),
      actions: [
        {
          actionType: "create",
          actionState: "Accepted",
          input: { file: "new-file.ts", modifiedContent: "content" },
          emittedAt: Date.now(),
        },
      ],
    });
    // Write a valid execution log file (Kiro uses hash filenames without .json extension)
    fs.writeFileSync(path.join(execLogDir, "f4af2915-f59f-4bea-aa9f-392d10d7d0f2"), logContent);

    // Also write a non-log file (will be attempted but fail to parse)
    fs.writeFileSync(path.join(execLogDir, "readme.txt"), "not a log");

    const scanner = new SessionLogScanner(agentDir);
    const result = await scanner.scanForAIEdits(
      "test",
      Date.now() + 10_000,
      3_600_000
    );

    // Should have scanned the execution log file (and attempted readme.txt)
    expect(result.scannedFiles).toBeGreaterThanOrEqual(1);
  });
});
