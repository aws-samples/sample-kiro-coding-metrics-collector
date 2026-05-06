/**
 * Property-based tests for WorkspacePathEncoder.
 *
 * Feature: kiro-session-monitor
 * Validates: Requirements 2.1, 2.3, 2.4, 2.5
 */
import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  encodeWorkspacePath,
  decodeWorkspacePath,
} from "../workspacePathEncoder";

// ── Generators ───────────────────────────────────────────────────────

/** Arbitrary Unicode strings including typical workspace path characters. */
const workspacePathArb = fc.oneof(
  fc.string(), // general Unicode strings
  fc.constantFrom(
    "/Users/dev/project",
    "/home/user/workspace",
    "d:\\code\\project",
    "C:\\Users\\dev\\my project",
    "/tmp/path with spaces/repo",
    "/路径/中文/项目",
    ""
  )
);

// ── Property tests ───────────────────────────────────────────────────

describe("Feature: kiro-session-monitor, Property 2: 工作区路径编码 round-trip", () => {
  /**
   * **Validates: Requirements 2.3, 2.4, 2.5**
   *
   * For any string (including Windows backslash paths and Unix forward-slash
   * paths), decode(encode(s)) === s.
   */
  it("decode(encode(s)) === s for arbitrary strings", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(decodeWorkspacePath(encodeWorkspacePath(s))).toBe(s);
      }),
      { numRuns: 100 }
    );
  });

  it("round-trips Windows paths with backslashes", () => {
    fc.assert(
      fc.property(workspacePathArb, (p) => {
        expect(decodeWorkspacePath(encodeWorkspacePath(p))).toBe(p);
      }),
      { numRuns: 100 }
    );
  });
});

describe("Feature: kiro-session-monitor, Property 3: URL-safe Base64 字符集", () => {
  /**
   * **Validates: Requirements 2.1**
   *
   * For any string, encodeWorkspacePath output contains only URL-safe
   * Base64 characters [A-Za-z0-9_-] — no `+`, `/`, or trailing `=`.
   */
  it("encoded output contains only [A-Za-z0-9_-]", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const encoded = encodeWorkspacePath(s);
        expect(encoded).toMatch(/^[A-Za-z0-9_-]*$/);
      }),
      { numRuns: 100 }
    );
  });

  it("encoded output never contains +, /, or = characters", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const encoded = encodeWorkspacePath(s);
        expect(encoded).not.toContain("+");
        expect(encoded).not.toContain("/");
        expect(encoded).not.toContain("=");
      }),
      { numRuns: 100 }
    );
  });
});
