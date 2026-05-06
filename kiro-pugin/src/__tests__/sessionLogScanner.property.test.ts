/**
 * Property-based tests for SessionLogScanner pure functions.
 *
 * Feature: kiro-session-monitor
 * Validates: Requirements 1.1, 1.2, 1.3, 6.2, 6.3
 */
import { describe, it, expect, vi } from "vitest";
import * as fc from "fast-check";
import * as path from "node:path";

// Mock vscode (not available outside the extension host)
vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      get: () => [],
    }),
  },
}));
import {
  SessionLogScanner,
  filterBySessionId,
  filterByTimeWindow,
} from "../sessionLogScanner";
import type { ParseResult } from "../workspacePathEncoder";

// ── Generators ───────────────────────────────────────────────────────

/** Arbitrary platform identifier. */
const platformArb = fc.constantFrom("darwin", "win32", "linux");

/** Arbitrary home directory path (Unix-style or Windows-style). */
const homeDirArb = fc.oneof(
  fc.constant("/Users/dev"),
  fc.constant("/home/user"),
  fc.constant("C:\\Users\\dev"),
  fc.constant("/tmp/test-home"),
  fc.stringMatching(/^\/[a-z]{1,20}(\/[a-z]{1,20}){0,3}$/),
);

/** Arbitrary APPDATA path for Windows. */
const appDataArb = fc.oneof(
  fc.constant("C:\\Users\\dev\\AppData\\Roaming"),
  fc.constant("D:\\AppData"),
  fc.stringMatching(/^[A-Z]:\\[a-zA-Z]{1,20}(\\[a-zA-Z]{1,20}){0,3}$/),
);

/** Arbitrary session ID (UUID-like). */
const sessionIdArb = fc.uuid();

/** Arbitrary timestamp in milliseconds (reasonable range). */
const timestampArb = fc.integer({ min: 1_000_000_000_000, max: 2_000_000_000_000 });

/** Arbitrary positive time window in milliseconds (1 second to 24 hours). */
const windowMsArb = fc.integer({ min: 1_000, max: 86_400_000 });

/** Simple file path arbitrary. */
const simpleFilePathArb = fc.stringMatching(/^[a-z0-9/._-]{1,50}$/);

/** Generate a ParseResult with optional chatSessionId and endTime. */
const parseResultArb = (opts?: {
  chatSessionId?: fc.Arbitrary<string | undefined>;
  endTime?: fc.Arbitrary<number | undefined>;
}): fc.Arbitrary<ParseResult> =>
  fc.record({
    writeActions: fc.array(
      fc.record({
        actionType: fc.constantFrom("replace", "create", "write", "delete"),
        filePath: simpleFilePathArb,
      }),
      { minLength: 0, maxLength: 3 }
    ),
    format: fc.constantFrom("A" as const, "B" as const),
    chatSessionId:
      opts?.chatSessionId ?? fc.option(sessionIdArb, { nil: undefined }),
    endTime: opts?.endTime ?? fc.option(timestampArb, { nil: undefined }),
  });

// ── Property 1: 跨平台 Agent Dir 路径解析 ────────────────────────────

describe("Feature: kiro-session-monitor, Property 1: 跨平台 Agent Dir 路径解析", () => {
  /**
   * **Validates: Requirements 1.1, 1.2, 1.3**
   *
   * For any platform ("darwin"|"win32"|"linux") and any home dir,
   * resolveAgentDir returns a path containing the correct platform-specific suffix.
   */
  it("returns path with correct platform-specific suffix for any platform and home dir", () => {
    fc.assert(
      fc.property(platformArb, homeDirArb, (platform, homeDir) => {
        const result = SessionLogScanner.resolveAgentDir(platform, homeDir);

        // All platforms share the kiro.kiroagent suffix
        expect(result).toContain("kiro.kiroagent");

        switch (platform) {
          case "darwin":
            expect(result).toContain("Library");
            expect(result).toContain("Application Support");
            expect(result).toContain("Kiro");
            expect(result).toContain("User");
            expect(result).toContain("globalStorage");
            break;
          case "win32":
            expect(result).toContain("Kiro");
            expect(result).toContain("User");
            expect(result).toContain("globalStorage");
            break;
          case "linux":
            expect(result).toContain(".config");
            expect(result).toContain("Kiro");
            expect(result).toContain("User");
            expect(result).toContain("globalStorage");
            break;
        }
      }),
      { numRuns: 100 }
    );
  });

  it("macOS path includes the home dir as a prefix component", () => {
    fc.assert(
      fc.property(homeDirArb, (homeDir) => {
        const result = SessionLogScanner.resolveAgentDir("darwin", homeDir);
        // path.join normalizes separators per platform, so use path.join to build expected prefix
        const expectedPrefix = path.join(homeDir, "Library", "Application Support");
        expect(result.startsWith(expectedPrefix)).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it("Linux path includes the home dir as a prefix component", () => {
    fc.assert(
      fc.property(homeDirArb, (homeDir) => {
        const result = SessionLogScanner.resolveAgentDir("linux", homeDir);
        // path.join normalizes separators per platform, so use path.join to build expected prefix
        const expectedPrefix = path.join(homeDir, ".config");
        expect(result.startsWith(expectedPrefix)).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it("Windows path uses provided appData when given", () => {
    fc.assert(
      fc.property(homeDirArb, appDataArb, (homeDir, appData) => {
        const result = SessionLogScanner.resolveAgentDir(
          "win32",
          homeDir,
          appData
        );
        expect(result.startsWith(appData)).toBe(true);
      }),
      { numRuns: 100 }
    );
  });
});

// ── Property 10: 时间窗口过滤 ────────────────────────────────────────

describe("Feature: kiro-session-monitor, Property 10: 时间窗口过滤", () => {
  /**
   * **Validates: Requirements 6.2**
   *
   * For any ParseResult list and time window [beforeTimestamp - windowMs, beforeTimestamp],
   * every result from filterByTimeWindow has endTime within that window.
   */
  it("every returned result has endTime within [beforeTimestamp - windowMs, beforeTimestamp]", () => {
    fc.assert(
      fc.property(
        fc.array(parseResultArb(), { minLength: 0, maxLength: 20 }),
        timestampArb,
        windowMsArb,
        (logs, beforeTimestamp, windowMs) => {
          const results = filterByTimeWindow(logs, beforeTimestamp, windowMs);
          const windowStart = beforeTimestamp - windowMs;

          for (const r of results) {
            expect(r.endTime).toBeDefined();
            expect(r.endTime!).toBeGreaterThanOrEqual(windowStart);
            expect(r.endTime!).toBeLessThanOrEqual(beforeTimestamp);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it("results without endTime are always excluded", () => {
    fc.assert(
      fc.property(
        fc.array(
          parseResultArb({ endTime: fc.constant(undefined) }),
          { minLength: 1, maxLength: 10 }
        ),
        timestampArb,
        windowMsArb,
        (logs, beforeTimestamp, windowMs) => {
          const results = filterByTimeWindow(logs, beforeTimestamp, windowMs);
          expect(results).toHaveLength(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("results with endTime inside the window are included", () => {
    fc.assert(
      fc.property(
        timestampArb,
        windowMsArb,
        (beforeTimestamp, windowMs) => {
          const windowStart = beforeTimestamp - windowMs;
          // Create a log with endTime exactly in the middle of the window
          const midTime = windowStart + Math.floor(windowMs / 2);
          const log: ParseResult = {
            writeActions: [],
            format: "A",
            endTime: midTime,
          };

          const results = filterByTimeWindow([log], beforeTimestamp, windowMs);
          expect(results).toHaveLength(1);
          expect(results[0].endTime).toBe(midTime);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ── Property 11: Session ID 过滤 ─────────────────────────────────────

describe("Feature: kiro-session-monitor, Property 11: Session ID 过滤", () => {
  /**
   * **Validates: Requirements 6.3**
   *
   * For any ParseResult list and session ID set, every result from
   * filterBySessionId has chatSessionId in the set.
   */
  it("every returned result has chatSessionId in the given set", () => {
    fc.assert(
      fc.property(
        fc.array(parseResultArb(), { minLength: 0, maxLength: 20 }),
        fc.array(sessionIdArb, { minLength: 1, maxLength: 5 }),
        (logs, sessionIdList) => {
          const sessionIds = new Set(sessionIdList);
          const results = filterBySessionId(logs, sessionIds);

          for (const r of results) {
            expect(r.chatSessionId).toBeDefined();
            expect(sessionIds.has(r.chatSessionId!)).toBe(true);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it("results without chatSessionId are always excluded", () => {
    fc.assert(
      fc.property(
        fc.array(
          parseResultArb({ chatSessionId: fc.constant(undefined) }),
          { minLength: 1, maxLength: 10 }
        ),
        fc.array(sessionIdArb, { minLength: 1, maxLength: 5 }),
        (logs, sessionIdList) => {
          const sessionIds = new Set(sessionIdList);
          const results = filterBySessionId(logs, sessionIds);
          expect(results).toHaveLength(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("results with matching chatSessionId are included", () => {
    fc.assert(
      fc.property(
        sessionIdArb,
        (sessionId) => {
          const log: ParseResult = {
            writeActions: [],
            format: "A",
            chatSessionId: sessionId,
          };
          const sessionIds = new Set([sessionId]);

          const results = filterBySessionId([log], sessionIds);
          expect(results).toHaveLength(1);
          expect(results[0].chatSessionId).toBe(sessionId);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("results with non-matching chatSessionId are excluded", () => {
    fc.assert(
      fc.property(
        sessionIdArb,
        sessionIdArb,
        (logSessionId, filterSessionId) => {
          fc.pre(logSessionId !== filterSessionId);

          const log: ParseResult = {
            writeActions: [],
            format: "A",
            chatSessionId: logSessionId,
          };
          const sessionIds = new Set([filterSessionId]);

          const results = filterBySessionId([log], sessionIds);
          expect(results).toHaveLength(0);
        }
      ),
      { numRuns: 100 }
    );
  });
});
