/**
 * Unit tests for SessionLogWatcher.
 *
 * Feature: kiro-session-monitor
 * Validates: Requirements 8.1-8.7
 *
 * Tests cover:
 * - Debounce behavior (rapid file changes are coalesced)
 * - Deduplication (same file size → skip)
 * - Error handling (parse failure does not break watcher)
 * - Dispose cleanup (watchers closed, timers cleared)
 * - Session ID filtering (non-matching sessionId → skip)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

// ── Mock setup (must be before imports that use mocked modules) ──────

// Mock vscode
vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      get: () => [],
    }),
  },
  extensions: {
    getExtension: () => undefined,
  },
}));

// Track calls to callCheckpointAgentV1
const mockCallCheckpointAgentV1 = vi.fn<(...args: unknown[]) => Promise<boolean>>().mockResolvedValue(true);
const mockGetIgnorePatterns = vi.fn<() => string[]>().mockReturnValue([]);
const mockMatchesIgnorePattern = vi.fn<(...args: unknown[]) => boolean>().mockReturnValue(false);

vi.mock("../checkpoint", () => ({
  callCheckpointAgentV1: (...args: unknown[]) => mockCallCheckpointAgentV1(...args),
  getIgnorePatterns: () => mockGetIgnorePatterns(),
  matchesIgnorePattern: (...args: unknown[]) => mockMatchesIgnorePattern(...args),
}));

// Mock buildCheckpointPayload
const mockBuildCheckpointPayload = vi.fn().mockResolvedValue({
  type: "ai_agent",
  repo_working_dir: "/workspace",
  agent_name: "kiro",
  model: "kiro-ai",
  edited_filepaths: ["src/test.ts"],
  dirty_files: { "src/test.ts": "old content" },
  transcript: { messages: [{ type: "assistant", text: "Kiro AI edit" }] },
});

vi.mock("../checkpointPayload", () => ({
  buildCheckpointPayload: (...args: unknown[]) => mockBuildCheckpointPayload(...args),
}));

// ── fs.watch mock infrastructure ─────────────────────────────────────

/** A mock FSWatcher that emits events and tracks close() calls. */
class MockFSWatcher extends EventEmitter {
  closed = false;
  close() {
    this.closed = true;
  }
}

/** Captured fs.watch listeners keyed by directory path. */
let fsWatchCallbacks: Map<string, (eventType: string, filename: string | null) => void>;
let mockWatchers: MockFSWatcher[];

// Track fs.promises.access, readdir, stat calls
const mockAccess = vi.fn().mockResolvedValue(undefined);
const mockReaddir = vi.fn().mockResolvedValue([]);
const mockStat = vi.fn().mockResolvedValue({ size: 100, isDirectory: () => true });

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    default: {
      ...actual,
      watch: (dir: string, cb: (eventType: string, filename: string | null) => void) => {
        const watcher = new MockFSWatcher();
        fsWatchCallbacks.set(dir, cb);
        mockWatchers.push(watcher);
        return watcher;
      },
      promises: {
        access: (...args: unknown[]) => mockAccess(...args),
        readdir: (...args: unknown[]) => mockReaddir(...args),
        stat: (...args: unknown[]) => mockStat(...args),
        readFile: vi.fn().mockResolvedValue("{}"),
      },
    },
    watch: (dir: string, cb: (eventType: string, filename: string | null) => void) => {
      const watcher = new MockFSWatcher();
      fsWatchCallbacks.set(dir, cb);
      mockWatchers.push(watcher);
      return watcher;
    },
    promises: {
      access: (...args: unknown[]) => mockAccess(...args),
      readdir: (...args: unknown[]) => mockReaddir(...args),
      stat: (...args: unknown[]) => mockStat(...args),
      readFile: vi.fn().mockResolvedValue("{}"),
    },
  };
});

// Mock SessionLogScanner
const mockParseExecutionLogFile = vi.fn();
const mockGetWorkspaceSessionIds = vi.fn().mockResolvedValue(new Set(["session-abc"]));
const mockResolveAgentDir = vi.fn().mockReturnValue("/mock-agent-dir");

vi.mock("../sessionLogScanner", () => ({
  SessionLogScanner: class {
    static resolveAgentDir = (...args: unknown[]) => mockResolveAgentDir(...args);
    parseExecutionLogFile = (...args: unknown[]) => mockParseExecutionLogFile(...args);
    getWorkspaceSessionIds = (...args: unknown[]) => mockGetWorkspaceSessionIds(...args);
  },
}));

import { SessionLogWatcher } from "../sessionLogWatcher";

// ── Test helpers ─────────────────────────────────────────────────────

/** A valid ParseResult returned by the mock scanner. */
function makeParseResult(overrides: Record<string, unknown> = {}) {
  return {
    writeActions: [
      {
        actionType: "replace",
        filePath: "src/test.ts",
        originalContent: "old content",
        modifiedContent: "new content",
        emittedAt: 1700000000000,
      },
    ],
    format: "A",
    chatSessionId: "session-abc",
    endTime: 1700000000000,
    ...overrides,
  };
}

/**
 * Set up the mock fs layer so that `start()` discovers one 414d* directory
 * and installs an fs.watch on it.
 */
function setupAgentDirStructure() {
  // access: Agent Dir exists
  mockAccess.mockResolvedValue(undefined);

  // readdir: top-level has one workspace-hash dir
  mockReaddir.mockImplementation(async (dir: string) => {
    if (dir === "/mock-agent-dir") return ["workspace-hash-1"];
    if (dir.endsWith("workspace-hash-1")) return ["414d-exec-log"];
    return [];
  });

  // stat: everything is a directory
  mockStat.mockResolvedValue({ size: 100, isDirectory: () => true });
}

// ── Test lifecycle ───────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers();
  fsWatchCallbacks = new Map();
  mockWatchers = [];

  // Reset all mocks
  mockCallCheckpointAgentV1.mockReset().mockResolvedValue(true);
  mockGetIgnorePatterns.mockReset().mockReturnValue([]);
  mockMatchesIgnorePattern.mockReset().mockReturnValue(false);
  mockBuildCheckpointPayload.mockReset().mockResolvedValue({
    type: "ai_agent",
    repo_working_dir: "/workspace",
    agent_name: "kiro",
    model: "kiro-ai",
    edited_filepaths: ["src/test.ts"],
    dirty_files: { "src/test.ts": "old content" },
    transcript: { messages: [{ type: "assistant", text: "Kiro AI edit" }] },
  });
  mockParseExecutionLogFile.mockReset().mockResolvedValue(makeParseResult());
  mockGetWorkspaceSessionIds.mockReset().mockResolvedValue(new Set(["session-abc"]));
  mockResolveAgentDir.mockReset().mockReturnValue("/mock-agent-dir");
  mockAccess.mockReset().mockResolvedValue(undefined);
  mockReaddir.mockReset().mockResolvedValue([]);
  mockStat.mockReset().mockResolvedValue({ size: 100, isDirectory: () => true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── Helper: create watcher and start with mocked agent dir ───────────

async function createAndStartWatcher(): Promise<SessionLogWatcher> {
  setupAgentDirStructure();
  const watcher = new SessionLogWatcher("/workspace");
  await watcher.start();
  return watcher;
}

/** Trigger a file change event on the 414d* execution log directory watcher. */
function triggerFileChange(filename = "log1.json") {
  const entries = Array.from(fsWatchCallbacks.entries());
  // Find the watcher for the 414d* directory (not the parent dir watcher)
  const execLogEntry = entries.find(([dir]) => dir.includes("414d"));
  if (execLogEntry) {
    const [, cb] = execLogEntry;
    cb("change", filename);
  }
}

// ── Tests ────────────────────────────────────────────────────────────

describe("SessionLogWatcher — start and fs.watch setup", () => {
  /**
   * **Validates: Requirements 8.1**
   *
   * When the extension activates, SessionLogWatcher starts monitoring
   * execution log directories using fs.watch.
   */
  it("sets up fs.watch on 414d* directories during start()", async () => {
    const watcher = await createAndStartWatcher();

    expect(mockWatchers.length).toBeGreaterThanOrEqual(1);
    expect(fsWatchCallbacks.size).toBeGreaterThanOrEqual(1);

    // The watched path should contain the 414d directory
    const watchedPaths = Array.from(fsWatchCallbacks.keys());
    expect(watchedPaths.some((p) => p.includes("414d"))).toBe(true);

    watcher.dispose();
  });

  it("does not start watchers when Agent Dir does not exist", async () => {
    mockAccess.mockRejectedValue(new Error("ENOENT"));
    const watcher = new SessionLogWatcher("/workspace");
    await watcher.start();

    expect(mockWatchers.length).toBe(0);
    watcher.dispose();
  });
});

describe("SessionLogWatcher — debounce behavior", () => {
  /**
   * **Validates: Requirements 8.4**
   *
   * File change events are debounced with a 300ms window. Multiple rapid
   * changes to the same file result in only one processing call.
   */
  it("coalesces rapid file changes into a single processing call", async () => {
    const watcher = await createAndStartWatcher();

    // Trigger 5 rapid file change events for the same file
    for (let i = 0; i < 5; i++) {
      triggerFileChange("log1.json");
    }

    // Before debounce expires, no processing should have happened
    expect(mockParseExecutionLogFile).not.toHaveBeenCalled();

    // Advance past the 300ms debounce window
    await vi.advanceTimersByTimeAsync(350);

    // Should have been called exactly once (debounced)
    expect(mockParseExecutionLogFile).toHaveBeenCalledTimes(1);

    watcher.dispose();
  });

  it("processes different files independently after debounce", async () => {
    const watcher = await createAndStartWatcher();

    // Trigger changes for two different files
    triggerFileChange("log1.json");
    triggerFileChange("log2.json");

    await vi.advanceTimersByTimeAsync(350);

    // Both files should be processed (each debounced independently)
    expect(mockParseExecutionLogFile).toHaveBeenCalledTimes(2);

    watcher.dispose();
  });

  it("processes files without .json extension (Kiro uses hash filenames)", async () => {
    const watcher = await createAndStartWatcher();

    // Kiro execution log files are named by hash without .json extension
    triggerFileChange("f4af2915-f59f-4bea-aa9f-392d10d7d0f2");

    await vi.advanceTimersByTimeAsync(350);

    expect(mockParseExecutionLogFile).toHaveBeenCalledTimes(1);

    watcher.dispose();
  });

  it("ignores null filename events", async () => {
    const watcher = await createAndStartWatcher();

    // Trigger with null filename (can happen on some platforms)
    const entries = Array.from(fsWatchCallbacks.entries());
    const execLogEntry = entries.find(([dir]) => dir.includes("414d"));
    if (execLogEntry) {
      const [, cb] = execLogEntry;
      cb("change", null);
    }

    await vi.advanceTimersByTimeAsync(350);

    expect(mockParseExecutionLogFile).not.toHaveBeenCalled();

    watcher.dispose();
  });
});

describe("SessionLogWatcher — deduplication", () => {
  /**
   * **Validates: Requirements 8.5**
   *
   * SessionLogWatcher tracks file sizes. If a file's size hasn't changed
   * since last processing, it is skipped.
   */
  it("skips processing when file size has not changed", async () => {
    const watcher = await createAndStartWatcher();

    // First change: file size = 100
    mockStat.mockResolvedValue({ size: 100, isDirectory: () => true });
    triggerFileChange("log1.json");
    await vi.advanceTimersByTimeAsync(350);

    expect(mockParseExecutionLogFile).toHaveBeenCalledTimes(1);

    // Second change: same file, same size → should be skipped
    triggerFileChange("log1.json");
    await vi.advanceTimersByTimeAsync(350);

    expect(mockParseExecutionLogFile).toHaveBeenCalledTimes(1); // still 1

    watcher.dispose();
  });

  it("re-processes when file size changes (incremental update)", async () => {
    const watcher = await createAndStartWatcher();

    // First change: file size = 100
    mockStat.mockResolvedValue({ size: 100, isDirectory: () => true });
    triggerFileChange("log1.json");
    await vi.advanceTimersByTimeAsync(350);

    expect(mockParseExecutionLogFile).toHaveBeenCalledTimes(1);

    // Second change: same file, different size → should re-process
    mockStat.mockResolvedValue({ size: 200, isDirectory: () => true });
    triggerFileChange("log1.json");
    await vi.advanceTimersByTimeAsync(350);

    expect(mockParseExecutionLogFile).toHaveBeenCalledTimes(2);

    watcher.dispose();
  });

  it("skips checkpoint when file size changes but actions are the same (metadata append)", async () => {
    const watcher = await createAndStartWatcher();

    // First change: file has 1 action, checkpoint succeeds
    mockStat.mockResolvedValue({ size: 100, isDirectory: () => true });
    triggerFileChange("log1.json");
    await vi.advanceTimersByTimeAsync(350);

    expect(mockCallCheckpointAgentV1).toHaveBeenCalled();
    const callCountAfterFirst = mockCallCheckpointAgentV1.mock.calls.length;

    // Second change: file grew (Kiro appended endTime/metadata) but same action
    // Same emittedAt = same action → should be skipped by action-level dedup
    mockStat.mockResolvedValue({ size: 200, isDirectory: () => true });
    mockParseExecutionLogFile.mockResolvedValueOnce(makeParseResult());
    triggerFileChange("log1.json");
    await vi.advanceTimersByTimeAsync(350);

    // parseExecutionLogFile was called (file size changed), but checkpoint should NOT
    // be called again because the action was already checkpointed
    expect(mockCallCheckpointAgentV1.mock.calls.length).toBe(callCountAfterFirst);

    watcher.dispose();
  });

  it("only checkpoints new actions when file grows with incremental actions", async () => {
    const watcher = await createAndStartWatcher();

    const action1 = {
      actionType: "append",
      filePath: "test1.js",
      originalContent: "old1",
      modifiedContent: "new1",
      emittedAt: 1700000000001,
    };
    const action2 = {
      actionType: "append",
      filePath: "test1.js",
      originalContent: "old2",
      modifiedContent: "new2",
      emittedAt: 1700000000002,
    };

    // First change: 1 action
    mockStat.mockResolvedValue({ size: 100, isDirectory: () => true });
    mockParseExecutionLogFile.mockResolvedValueOnce(
      makeParseResult({ writeActions: [action1] })
    );
    triggerFileChange("log1.json");
    await vi.advanceTimersByTimeAsync(350);

    // Should checkpoint action1
    expect(mockCallCheckpointAgentV1).toHaveBeenCalled();
    const callCountAfterFirst = mockCallCheckpointAgentV1.mock.calls.length;

    // Second change: 2 actions (action1 + action2), file grew
    mockStat.mockResolvedValue({ size: 200, isDirectory: () => true });
    mockParseExecutionLogFile.mockResolvedValueOnce(
      makeParseResult({ writeActions: [action1, action2] })
    );
    triggerFileChange("log1.json");
    await vi.advanceTimersByTimeAsync(350);

    // Should checkpoint only action2 (action1 already done)
    // Verify checkpoint was called again (for the new action)
    expect(mockCallCheckpointAgentV1.mock.calls.length).toBeGreaterThan(callCountAfterFirst);

    // Verify buildCheckpointPayload was called with only the new action
    const lastBuildCall = mockBuildCheckpointPayload.mock.calls[
      mockBuildCheckpointPayload.mock.calls.length - 1
    ];
    const actionsArg = lastBuildCall[1] as Array<{ emittedAt: number }>;
    expect(actionsArg).toHaveLength(1);
    expect(actionsArg[0].emittedAt).toBe(action2.emittedAt);

    watcher.dispose();
  });
});

describe("SessionLogWatcher — session ID filtering", () => {
  /**
   * **Validates: Requirements 8.6**
   *
   * Only execution logs whose chatSessionId matches the current workspace's
   * session IDs are processed.
   */
  it("skips logs with non-matching sessionId", async () => {
    const watcher = await createAndStartWatcher();

    // Return a parse result with a different session ID
    mockParseExecutionLogFile.mockResolvedValue(
      makeParseResult({ chatSessionId: "other-session-xyz" })
    );

    triggerFileChange("log1.json");
    await vi.advanceTimersByTimeAsync(350);

    // parseExecutionLogFile was called, but checkpoint should NOT be called
    // because the sessionId doesn't match
    expect(mockParseExecutionLogFile).toHaveBeenCalledTimes(1);
    expect(mockCallCheckpointAgentV1).not.toHaveBeenCalled();

    watcher.dispose();
  });

  it("processes logs with matching sessionId", async () => {
    const watcher = await createAndStartWatcher();

    // Return a parse result with a matching session ID
    mockParseExecutionLogFile.mockResolvedValue(
      makeParseResult({ chatSessionId: "session-abc" })
    );

    triggerFileChange("log1.json");
    await vi.advanceTimersByTimeAsync(350);

    expect(mockParseExecutionLogFile).toHaveBeenCalledTimes(1);
    // Checkpoint should be called (human + AI = 2 calls)
    expect(mockCallCheckpointAgentV1).toHaveBeenCalled();

    watcher.dispose();
  });

  it("skips logs with undefined chatSessionId when sessionIds are available", async () => {
    const watcher = await createAndStartWatcher();

    mockParseExecutionLogFile.mockResolvedValue(
      makeParseResult({ chatSessionId: undefined })
    );

    triggerFileChange("log1.json");
    await vi.advanceTimersByTimeAsync(350);

    expect(mockCallCheckpointAgentV1).not.toHaveBeenCalled();

    watcher.dispose();
  });

  it("refreshes session IDs on mismatch and processes if new ID matches", async () => {
    const watcher = await createAndStartWatcher();

    const newSessionId = "new-session-xyz";

    // First trigger: log has a new sessionId not in the initial set
    mockParseExecutionLogFile.mockResolvedValueOnce(
      makeParseResult({ chatSessionId: newSessionId })
    );
    // After refresh, getWorkspaceSessionIds returns the new session too
    mockGetWorkspaceSessionIds.mockResolvedValueOnce(
      new Set(["session-abc", newSessionId])
    );

    triggerFileChange("log1.json");
    await vi.advanceTimersByTimeAsync(350);

    // Should have refreshed and then processed the log
    expect(mockCallCheckpointAgentV1).toHaveBeenCalled();

    watcher.dispose();
  });
});

describe("SessionLogWatcher — error handling", () => {
  /**
   * **Validates: Requirements 8.7**
   *
   * If parsing or checkpointing fails for a specific file, the watcher
   * continues monitoring for subsequent changes.
   */
  it("continues monitoring when parseExecutionLogFile returns null", async () => {
    const watcher = await createAndStartWatcher();

    // First file: parse returns null (failure)
    mockParseExecutionLogFile.mockResolvedValueOnce(null);
    triggerFileChange("log1.json");
    await vi.advanceTimersByTimeAsync(350);

    expect(mockCallCheckpointAgentV1).not.toHaveBeenCalled();

    // Second file: parse succeeds — watcher should still be alive
    mockStat.mockResolvedValue({ size: 200, isDirectory: () => true });
    mockParseExecutionLogFile.mockResolvedValueOnce(makeParseResult());
    triggerFileChange("log1.json");
    await vi.advanceTimersByTimeAsync(350);

    expect(mockCallCheckpointAgentV1).toHaveBeenCalled();

    watcher.dispose();
  });

  it("continues monitoring when parseExecutionLogFile throws", async () => {
    const watcher = await createAndStartWatcher();

    // First file: parse throws
    mockParseExecutionLogFile.mockRejectedValueOnce(new Error("parse boom"));
    triggerFileChange("log1.json");
    await vi.advanceTimersByTimeAsync(350);

    expect(mockCallCheckpointAgentV1).not.toHaveBeenCalled();

    // Second file: parse succeeds — watcher should still be alive
    mockStat.mockResolvedValue({ size: 300, isDirectory: () => true });
    mockParseExecutionLogFile.mockResolvedValueOnce(makeParseResult());
    triggerFileChange("log1.json");
    await vi.advanceTimersByTimeAsync(350);

    expect(mockCallCheckpointAgentV1).toHaveBeenCalled();

    watcher.dispose();
  });

  it("continues monitoring when callCheckpointAgentV1 fails", async () => {
    const watcher = await createAndStartWatcher();

    // First call: checkpoint fails (both human and AI)
    mockCallCheckpointAgentV1.mockResolvedValue(false);
    triggerFileChange("log1.json");
    await vi.advanceTimersByTimeAsync(350);

    // Checkpoint was called but returned false
    expect(mockCallCheckpointAgentV1).toHaveBeenCalled();

    // Second trigger: use a DIFFERENT action (different emittedAt) so dedup doesn't skip it
    mockCallCheckpointAgentV1.mockReset().mockResolvedValue(true);
    mockStat.mockResolvedValue({ size: 400, isDirectory: () => true });
    mockParseExecutionLogFile.mockResolvedValueOnce(
      makeParseResult({
        writeActions: [
          {
            actionType: "replace",
            filePath: "src/other.ts",
            originalContent: "old",
            modifiedContent: "new",
            emittedAt: 1700000099999,
          },
        ],
      })
    );
    triggerFileChange("log1.json");
    await vi.advanceTimersByTimeAsync(350);

    expect(mockCallCheckpointAgentV1).toHaveBeenCalled();

    watcher.dispose();
  });

  it("skips files with empty writeActions", async () => {
    const watcher = await createAndStartWatcher();

    mockParseExecutionLogFile.mockResolvedValue(
      makeParseResult({ writeActions: [] })
    );

    triggerFileChange("log1.json");
    await vi.advanceTimersByTimeAsync(350);

    // No checkpoint should be called for empty write actions
    expect(mockCallCheckpointAgentV1).not.toHaveBeenCalled();

    watcher.dispose();
  });

  it("handles stat failure gracefully (file deleted between event and processing)", async () => {
    const watcher = await createAndStartWatcher();

    // stat fails (file was deleted)
    mockStat.mockRejectedValue(new Error("ENOENT"));

    triggerFileChange("log1.json");
    await vi.advanceTimersByTimeAsync(350);

    // Should not crash, and no processing should happen
    expect(mockParseExecutionLogFile).not.toHaveBeenCalled();

    watcher.dispose();
  });
});

describe("SessionLogWatcher — dispose cleanup", () => {
  /**
   * **Validates: Requirements 8.1 (cleanup)**
   *
   * dispose() closes all fs.watch watchers and clears pending timers.
   */
  it("closes all fs.watch watchers on dispose", async () => {
    const watcher = await createAndStartWatcher();

    expect(mockWatchers.length).toBeGreaterThanOrEqual(1);
    const watchersBefore = [...mockWatchers];

    watcher.dispose();

    // All mock watchers should be closed
    for (const w of watchersBefore) {
      expect(w.closed).toBe(true);
    }
  });

  it("clears pending debounce timers on dispose", async () => {
    const watcher = await createAndStartWatcher();

    // Trigger a change but don't let debounce expire
    triggerFileChange("log1.json");

    // Dispose before debounce fires
    watcher.dispose();

    // Advance timers — the debounced callback should NOT fire
    await vi.advanceTimersByTimeAsync(500);

    expect(mockParseExecutionLogFile).not.toHaveBeenCalled();
  });

  it("can be disposed multiple times without error", async () => {
    const watcher = await createAndStartWatcher();

    expect(() => {
      watcher.dispose();
      watcher.dispose();
    }).not.toThrow();
  });
});

describe("SessionLogWatcher — checkpoint flow", () => {
  /**
   * **Validates: Requirements 8.2, 8.3**
   *
   * When write actions are found, SessionLogWatcher builds a payload
   * and calls callCheckpointAgentV1.
   */
  it("calls callCheckpointAgentV1 for human and AI checkpoints", async () => {
    const watcher = await createAndStartWatcher();

    triggerFileChange("log1.json");
    await vi.advanceTimersByTimeAsync(350);

    // Should call checkpoint at least once (AI checkpoint)
    // May also call for human checkpoint if originalContent is present
    expect(mockCallCheckpointAgentV1).toHaveBeenCalled();

    // Verify workspace path is passed correctly
    const firstCallArgs = mockCallCheckpointAgentV1.mock.calls[0];
    expect(firstCallArgs[0]).toBe("/workspace");

    watcher.dispose();
  });

  it("calls buildCheckpointPayload with correct arguments", async () => {
    const watcher = await createAndStartWatcher();

    triggerFileChange("log1.json");
    await vi.advanceTimersByTimeAsync(350);

    expect(mockBuildCheckpointPayload).toHaveBeenCalledWith(
      "/workspace",
      expect.any(Array),
      "session-abc",
      expect.any(Array)
    );

    watcher.dispose();
  });
});

describe("SessionLogWatcher — per-repo checkpoint dispatch", () => {
  /**
   * Feature: repo-aware-checkpoint-routing
   * Validates: Requirements 3.2, 3.3, 4.1, 4.2, 4.3, 4.4, 5.1, 5.2
   *
   * Tests cover per-repository checkpoint dispatch: multi-repo grouping,
   * human/AI ordering per repo, cwd and repo_working_dir correctness,
   * single-repo backward compatibility, and error resilience.
   */

  /**
   * **Validates: Requirements 4.2**
   *
   * WHEN an execution log produces WriteAction groups for multiple repositories,
   * THE SessionLogWatcher SHALL call callCheckpointAgentV1 separately for each
   * Repository's group.
   */
  it("multi-repo workspace dispatches separate checkpoint calls per repo", async () => {
    const watcher = await createAndStartWatcher();

    // Simulate multi-repo workspace: two repos under /workspace
    watcher.repos = [
      { rootPath: "/workspace/repo-a" },
      { rootPath: "/workspace/repo-b" },
    ];

    // Actions spanning two repos (workspace-relative paths)
    mockParseExecutionLogFile.mockResolvedValueOnce(
      makeParseResult({
        writeActions: [
          {
            actionType: "replace",
            filePath: "repo-a/src/file.ts",
            originalContent: "old-a",
            modifiedContent: "new-a",
            emittedAt: 1700000000001,
          },
          {
            actionType: "replace",
            filePath: "repo-b/src/file.ts",
            originalContent: "old-b",
            modifiedContent: "new-b",
            emittedAt: 1700000000002,
          },
        ],
      })
    );

    triggerFileChange("log1.json");
    await vi.advanceTimersByTimeAsync(350);

    // Each repo gets human + AI checkpoint = 2 calls per repo = 4 total
    expect(mockCallCheckpointAgentV1).toHaveBeenCalledTimes(4);

    // Verify both repos received checkpoint calls
    const cwdArgs = mockCallCheckpointAgentV1.mock.calls.map(
      (call) => call[0] as string
    );
    expect(cwdArgs.filter((c) => c === "/workspace/repo-a")).toHaveLength(2);
    expect(cwdArgs.filter((c) => c === "/workspace/repo-b")).toHaveLength(2);

    watcher.dispose();
  });

  /**
   * **Validates: Requirements 4.3**
   *
   * WHEN an execution log produces WriteAction groups for multiple repositories,
   * THE SessionLogWatcher SHALL send the human checkpoint and AI checkpoint pair
   * for each Repository before proceeding to the next Repository.
   */
  it("human + AI checkpoint ordering per repo (human first, then AI)", async () => {
    const watcher = await createAndStartWatcher();

    watcher.repos = [
      { rootPath: "/workspace/repo-a" },
      { rootPath: "/workspace/repo-b" },
    ];

    mockParseExecutionLogFile.mockResolvedValueOnce(
      makeParseResult({
        writeActions: [
          {
            actionType: "replace",
            filePath: "repo-a/src/file.ts",
            originalContent: "old-a",
            modifiedContent: "new-a",
            emittedAt: 1700000000001,
          },
          {
            actionType: "replace",
            filePath: "repo-b/src/file.ts",
            originalContent: "old-b",
            modifiedContent: "new-b",
            emittedAt: 1700000000002,
          },
        ],
      })
    );

    triggerFileChange("log1.json");
    await vi.advanceTimersByTimeAsync(350);

    // 4 calls total: repo-a human, repo-a AI, repo-b human, repo-b AI
    expect(mockCallCheckpointAgentV1).toHaveBeenCalledTimes(4);

    const calls = mockCallCheckpointAgentV1.mock.calls;

    // First two calls should be for the same repo (human then AI)
    const firstRepoCwd = calls[0][0] as string;
    expect(calls[1][0]).toBe(firstRepoCwd);

    // The human payload has type "human"
    const firstPayload = calls[0][1] as Record<string, unknown>;
    expect(firstPayload.type).toBe("human");

    // The AI payload has type "ai_agent"
    const secondPayload = calls[1][1] as Record<string, unknown>;
    expect(secondPayload.type).toBe("ai_agent");

    // Next two calls should be for the other repo (human then AI)
    const secondRepoCwd = calls[2][0] as string;
    expect(secondRepoCwd).not.toBe(firstRepoCwd);
    expect(calls[3][0]).toBe(secondRepoCwd);

    const thirdPayload = calls[2][1] as Record<string, unknown>;
    expect(thirdPayload.type).toBe("human");

    const fourthPayload = calls[3][1] as Record<string, unknown>;
    expect(fourthPayload.type).toBe("ai_agent");

    watcher.dispose();
  });

  /**
   * **Validates: Requirements 4.1**
   *
   * WHEN sending a Checkpoint_Payload to callCheckpointAgentV1,
   * THE SessionLogWatcher SHALL pass the Repository's absolute path as the
   * cwd parameter instead of the Workspace_Root.
   */
  it("cwd parameter is set to repo path, not workspace path", async () => {
    const watcher = await createAndStartWatcher();

    watcher.repos = [
      { rootPath: "/workspace/repo-a" },
    ];

    mockParseExecutionLogFile.mockResolvedValueOnce(
      makeParseResult({
        writeActions: [
          {
            actionType: "replace",
            filePath: "repo-a/src/file.ts",
            originalContent: "old-a",
            modifiedContent: "new-a",
            emittedAt: 1700000000001,
          },
        ],
      })
    );

    triggerFileChange("log1.json");
    await vi.advanceTimersByTimeAsync(350);

    // All checkpoint calls should use repo path as cwd, not workspace path
    for (const call of mockCallCheckpointAgentV1.mock.calls) {
      expect(call[0]).toBe("/workspace/repo-a");
      expect(call[0]).not.toBe("/workspace");
    }

    watcher.dispose();
  });

  /**
   * **Validates: Requirements 3.3**
   *
   * THE SessionLogWatcher SHALL set the repo_working_dir field of the
   * Checkpoint_Payload to the Repository's absolute path.
   */
  it("repo_working_dir in payload is set to repo path", async () => {
    const watcher = await createAndStartWatcher();

    watcher.repos = [
      { rootPath: "/workspace/repo-a" },
    ];

    mockParseExecutionLogFile.mockResolvedValueOnce(
      makeParseResult({
        writeActions: [
          {
            actionType: "replace",
            filePath: "repo-a/src/file.ts",
            originalContent: "old-a",
            modifiedContent: "new-a",
            emittedAt: 1700000000001,
          },
        ],
      })
    );

    triggerFileChange("log1.json");
    await vi.advanceTimersByTimeAsync(350);

    // The human checkpoint payload should have repo_working_dir = repo path
    const humanCall = mockCallCheckpointAgentV1.mock.calls.find(
      (call) => (call[1] as Record<string, unknown>).type === "human"
    );
    expect(humanCall).toBeDefined();
    expect((humanCall![1] as Record<string, unknown>).repo_working_dir).toBe(
      "/workspace/repo-a"
    );

    // buildCheckpointPayload should be called with repo path (not workspace path)
    expect(mockBuildCheckpointPayload).toHaveBeenCalledWith(
      "/workspace/repo-a",
      expect.any(Array),
      "session-abc",
      expect.any(Array)
    );

    watcher.dispose();
  });

  /**
   * **Validates: Requirements 5.1, 5.2**
   *
   * WHEN the Workspace_Root is a git repository root (Single_Repo_Workspace),
   * THE SessionLogWatcher SHALL produce checkpoint payloads with the same cwd,
   * edited_filepaths, dirty_files keys, and repo_working_dir values as the
   * current implementation, and call callCheckpointAgentV1 exactly once per
   * execution log (human + AI pair).
   */
  it("single-repo workspace produces identical behavior to current implementation", async () => {
    const watcher = await createAndStartWatcher();

    // Single-repo: workspace root IS the repo root (default after start)
    // createAndStartWatcher sets workspacePath = "/workspace"
    // and initRepoDiscovery falls back to [{ rootPath: "/workspace" }]
    // since the vscode mock returns undefined for getExtension

    mockParseExecutionLogFile.mockResolvedValueOnce(
      makeParseResult({
        writeActions: [
          {
            actionType: "replace",
            filePath: "src/test.ts",
            originalContent: "old content",
            modifiedContent: "new content",
            emittedAt: 1700000000000,
          },
        ],
      })
    );

    triggerFileChange("log1.json");
    await vi.advanceTimersByTimeAsync(350);

    // Should call checkpoint exactly twice: human + AI (one repo)
    expect(mockCallCheckpointAgentV1).toHaveBeenCalledTimes(2);

    // cwd should be workspace path (same as repo path in single-repo case)
    for (const call of mockCallCheckpointAgentV1.mock.calls) {
      expect(call[0]).toBe("/workspace");
    }

    // buildCheckpointPayload should be called with workspace path
    expect(mockBuildCheckpointPayload).toHaveBeenCalledWith(
      "/workspace",
      expect.any(Array),
      "session-abc",
      expect.any(Array)
    );

    // Paths in the human payload should remain workspace-relative (unchanged)
    const humanCall = mockCallCheckpointAgentV1.mock.calls.find(
      (call) => (call[1] as Record<string, unknown>).type === "human"
    );
    expect(humanCall).toBeDefined();
    const humanPayload = humanCall![1] as Record<string, unknown>;
    expect(humanPayload.repo_working_dir).toBe("/workspace");
    expect(humanPayload.dirty_files).toHaveProperty("src/test.ts");

    watcher.dispose();
  });

  /**
   * **Validates: Requirements 4.4**
   *
   * IF a per-repository checkpoint call fails, THEN THE SessionLogWatcher
   * SHALL log the error and continue processing the remaining repositories.
   */
  it("per-repo failure continues processing remaining repos", async () => {
    const watcher = await createAndStartWatcher();

    watcher.repos = [
      { rootPath: "/workspace/repo-a" },
      { rootPath: "/workspace/repo-b" },
    ];

    mockParseExecutionLogFile.mockResolvedValueOnce(
      makeParseResult({
        writeActions: [
          {
            actionType: "replace",
            filePath: "repo-a/src/file.ts",
            originalContent: "old-a",
            modifiedContent: "new-a",
            emittedAt: 1700000000001,
          },
          {
            actionType: "replace",
            filePath: "repo-b/src/file.ts",
            originalContent: "old-b",
            modifiedContent: "new-b",
            emittedAt: 1700000000002,
          },
        ],
      })
    );

    // Make the first repo's checkpoint calls throw an error
    let callCount = 0;
    mockCallCheckpointAgentV1.mockImplementation(async (...args: unknown[]) => {
      callCount++;
      const cwd = args[0] as string;
      if (cwd === "/workspace/repo-a") {
        throw new Error("repo-a checkpoint failed");
      }
      return true;
    });

    triggerFileChange("log1.json");
    await vi.advanceTimersByTimeAsync(350);

    // Despite repo-a failing, repo-b should still get checkpoint calls
    const repoBCalls = mockCallCheckpointAgentV1.mock.calls.filter(
      (call) => call[0] === "/workspace/repo-b"
    );
    expect(repoBCalls.length).toBeGreaterThanOrEqual(1);

    watcher.dispose();
  });
});
