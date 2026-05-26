/**
 * Property-based test for git.path cleanup correctness.
 *
 * Feature: remove-git-path-override, Property 4: git.path 清理正确性
 * Validates: Requirements 6.2, 6.4
 *
 * For any git.path configuration value and extension path, the extension
 * should reset git.path to undefined if and only if it points to a path
 * inside the extension's bin/ directory. If git.path points elsewhere,
 * it must not be modified.
 */
import * as path from "node:path";
import { describe, it, expect, vi } from "vitest";
import * as fc from "fast-check";

// ── Mocks ────────────────────────────────────────────────────────────
// Must be set up before importing the module under test.
vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      get: () => undefined,
      update: () => Promise.resolve(),
    }),
  },
  ConfigurationTarget: { Global: 1 },
}));

// ── Import module under test AFTER mocks are registered ──────────────
import { shouldCleanupGitPath } from "../extension";

// ── Generators ───────────────────────────────────────────────────────

/** A path segment that is safe for use in file paths. */
const segmentArb = fc.stringMatching(/^[a-zA-Z0-9_-]{1,12}$/);

/** Generate a plausible absolute directory path (Unix-style). */
const unixDirArb = fc
  .array(segmentArb, { minLength: 1, maxLength: 5 })
  .map((segs) => "/" + segs.join("/"));

/** Generate a plausible absolute directory path (Windows-style). */
const winDirArb = fc
  .tuple(
    fc.constantFrom("C:", "D:", "E:"),
    fc.array(segmentArb, { minLength: 1, maxLength: 5 })
  )
  .map(([drive, segs]) => drive + "\\" + segs.join("\\"));

/** Generate an extension path appropriate for the current platform. */
const extensionPathArb = process.platform === "win32" ? winDirArb : unixDirArb;

/** Generate a filename (used inside bin/). Excludes "." and ".." which are not real filenames. */
const filenameArb = fc
  .stringMatching(/^[a-zA-Z0-9_.-]{1,16}$/)
  .filter((s) => s !== "." && s !== "..");

// ── Property test ────────────────────────────────────────────────────

describe("Feature: remove-git-path-override, Property 4: git.path 清理正确性", () => {
  it("returns true (should cleanup) when git.path points inside extension bin/ directory", async () => {
    await fc.assert(
      fc.asyncProperty(extensionPathArb, filenameArb, async (extPath, filename) => {
        // git.path points to a file inside the extension's bin/ directory
        const gitPath = path.join(extPath, "bin", filename);
        expect(shouldCleanupGitPath(extPath, gitPath)).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it("returns true (should cleanup) when git.path points to a nested path inside extension bin/ directory", async () => {
    await fc.assert(
      fc.asyncProperty(
        extensionPathArb,
        fc.array(segmentArb, { minLength: 1, maxLength: 3 }),
        filenameArb,
        async (extPath, subDirs, filename) => {
          // git.path points to a deeply nested file inside bin/
          const gitPath = path.join(extPath, "bin", ...subDirs, filename);
          expect(shouldCleanupGitPath(extPath, gitPath)).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("returns true (should cleanup) when git.path equals the bin/ directory itself", async () => {
    await fc.assert(
      fc.asyncProperty(extensionPathArb, async (extPath) => {
        const gitPath = path.join(extPath, "bin");
        expect(shouldCleanupGitPath(extPath, gitPath)).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it("returns false (should NOT cleanup) when git.path points outside the extension directory", async () => {
    await fc.assert(
      fc.asyncProperty(
        extensionPathArb,
        extensionPathArb,
        filenameArb,
        async (extPath, otherBase, filename) => {
          // Build a git.path that is clearly outside the extension's bin/ dir
          const gitPath = path.join(otherBase, "other-ext", "bin", filename);
          // Only assert when the path genuinely doesn't start with the bin dir
          const binDir = path.normalize(path.join(extPath, "bin"));
          const normalizedGitPath = path.normalize(gitPath);
          // Filter: skip if it accidentally matches
          fc.pre(
            !normalizedGitPath.startsWith(binDir + path.sep) &&
              normalizedGitPath !== binDir
          );
          expect(shouldCleanupGitPath(extPath, gitPath)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("returns false (should NOT cleanup) when git.path is a sibling directory with 'bin' prefix", async () => {
    await fc.assert(
      fc.asyncProperty(extensionPathArb, filenameArb, async (extPath, filename) => {
        // e.g., extensionPath/bin-other/git — should NOT match extensionPath/bin/
        const gitPath = path.join(extPath, "bin-other", filename);
        expect(shouldCleanupGitPath(extPath, gitPath)).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  it("returns false (should NOT cleanup) when git.path is a system git path", async () => {
    await fc.assert(
      fc.asyncProperty(extensionPathArb, async (extPath) => {
        // Common system git paths that should never be cleaned up
        const systemPaths =
          process.platform === "win32"
            ? ["C:\\Program Files\\Git\\cmd\\git.exe", "C:\\Git\\bin\\git.exe"]
            : ["/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git"];

        for (const sysPath of systemPaths) {
          expect(shouldCleanupGitPath(extPath, sysPath)).toBe(false);
        }
      }),
      { numRuns: 100 }
    );
  });
});
