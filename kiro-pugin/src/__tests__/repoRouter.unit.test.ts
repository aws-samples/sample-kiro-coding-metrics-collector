/**
 * Unit tests for git extension API discovery in SessionLogWatcher.
 *
 * Feature: repo-aware-checkpoint-routing
 * Validates: Requirements 1.1, 1.2, 1.3, 1.4, 6.1, 6.2, 6.3
 *
 * Tests cover:
 * - Git API available → repos populated from git.repositories
 * - Git API unavailable → falls back to workspace root
 * - onDidOpenRepository adds new repo to tracked set
 * - Deferred initialization (API not active at start, becomes active later)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Configurable vscode mock ─────────────────────────────────────────

/** Factory that returns the mock git extension. Reconfigured per test. */
let mockGetExtension: ReturnType<typeof vi.fn>;

vi.mock("vscode", () => {
  return {
    workspace: {
      getConfiguration: () => ({
        get: () => [],
      }),
    },
    extensions: {
      getExtension: (...args: unknown[]) => (mockGetExtension as Function)(...args),
    },
  };
});

// ── Stub out modules that SessionLogWatcher imports but we don't need ──

vi.mock("../checkpoint", () => ({
  callCheckpointAgentV1: vi.fn().mockResolvedValue(true),
  getIgnorePatterns: vi.fn().mockReturnValue([]),
  matchesIgnorePattern: vi.fn().mockReturnValue(false),
}));

vi.mock("../checkpointPayload", () => ({
  buildCheckpointPayload: vi.fn().mockResolvedValue({
    type: "ai_agent",
    repo_working_dir: "/workspace",
    agent_name: "kiro",
    model: "kiro-ai",
    edited_filepaths: [],
    dirty_files: {},
    transcript: { messages: [] },
  }),
}));

vi.mock("../sessionLogScanner", () => ({
  SessionLogScanner: class {
    static resolveAgentDir = vi.fn().mockReturnValue("/mock-agent-dir");
    parseExecutionLogFile = vi.fn().mockResolvedValue(null);
    getWorkspaceSessionIds = vi.fn().mockResolvedValue(new Set());
  },
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    default: {
      ...actual,
      watch: () => ({ on: vi.fn(), close: vi.fn() }),
      promises: {
        access: vi.fn().mockRejectedValue(new Error("ENOENT")),
        readdir: vi.fn().mockResolvedValue([]),
        stat: vi.fn().mockResolvedValue({ size: 0, isDirectory: () => true }),
        readFile: vi.fn().mockResolvedValue("{}"),
      },
    },
    watch: () => ({ on: vi.fn(), close: vi.fn() }),
    promises: {
      access: vi.fn().mockRejectedValue(new Error("ENOENT")),
      readdir: vi.fn().mockResolvedValue([]),
      stat: vi.fn().mockResolvedValue({ size: 0, isDirectory: () => true }),
      readFile: vi.fn().mockResolvedValue("{}"),
    },
  };
});

import { SessionLogWatcher } from "../sessionLogWatcher";

// ── Test helpers ─────────────────────────────────────────────────────

/** Create a mock git repository object with the given rootUri.fsPath. */
function mockRepo(fsPath: string) {
  return {
    rootUri: { fsPath },
  };
}

/**
 * Create a mock git extension with configurable behavior.
 *
 * @param opts.isActive - Whether the extension is active
 * @param opts.repositories - Array of mock repositories
 * @param opts.onDidOpenRepositoryFn - Optional custom onDidOpenRepository implementation
 */
function createMockGitExtension(opts: {
  isActive: boolean;
  repositories?: Array<{ rootUri: { fsPath: string } }>;
  onDidOpenRepositoryFn?: (handler: (repo: { rootUri: { fsPath: string } }) => void) => { dispose: () => void };
}) {
  const repos = opts.repositories ?? [];
  const onDidOpenRepoFn = opts.onDidOpenRepositoryFn ?? (() => ({ dispose: () => {} }));

  return {
    isActive: opts.isActive,
    exports: {
      getAPI: (_version: number) => ({
        repositories: repos,
        onDidOpenRepository: onDidOpenRepoFn,
      }),
    },
  };
}

// ── Lifecycle ────────────────────────────────────────────────────────

beforeEach(() => {
  mockGetExtension = vi.fn().mockReturnValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────

describe("SessionLogWatcher — git extension API discovery", () => {
  /**
   * **Validates: Requirements 1.1**
   *
   * WHEN the SessionLogWatcher starts, it SHALL query the Git Extension API
   * for all currently known repositories.
   */
  it("populates repos from git.repositories when git API is available", () => {
    const ext = createMockGitExtension({
      isActive: true,
      repositories: [
        mockRepo("/workspace/repo-a"),
        mockRepo("/workspace/repo-b"),
      ],
    });
    mockGetExtension.mockReturnValue(ext);

    const watcher = new SessionLogWatcher("/workspace");
    watcher.initRepoDiscovery();

    expect(watcher.repos).toHaveLength(2);
    expect(watcher.repos[0].rootPath).toBe("/workspace/repo-a");
    expect(watcher.repos[1].rootPath).toBe("/workspace/repo-b");

    watcher.dispose();
  });

  /**
   * **Validates: Requirements 1.3, 1.4**
   *
   * IF the Git Extension API is not available, THEN the SessionLogWatcher
   * SHALL fall back to treating the Workspace_Root as the sole Repository root
   * and log a warning.
   */
  it("falls back to workspace root when git extension is not found", () => {
    mockGetExtension.mockReturnValue(undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const watcher = new SessionLogWatcher("/workspace");
    watcher.initRepoDiscovery();

    expect(watcher.repos).toHaveLength(1);
    expect(watcher.repos[0].rootPath).toBe("/workspace");

    // Should log a warning with [git-ai-kiro] prefix
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[git-ai-kiro]")
    );

    watcher.dispose();
  });

  /**
   * **Validates: Requirements 1.2**
   *
   * WHEN the Git Extension API reports a new repository after initial startup,
   * the SessionLogWatcher SHALL add the new Repository to its tracked set.
   */
  it("adds new repo via onDidOpenRepository event", () => {
    let capturedHandler: ((repo: { rootUri: { fsPath: string } }) => void) | null = null;

    const ext = createMockGitExtension({
      isActive: true,
      repositories: [mockRepo("/workspace/repo-a")],
      onDidOpenRepositoryFn: (handler) => {
        capturedHandler = handler;
        return { dispose: () => {} };
      },
    });
    mockGetExtension.mockReturnValue(ext);

    const watcher = new SessionLogWatcher("/workspace");
    watcher.initRepoDiscovery();

    // Initially one repo
    expect(watcher.repos).toHaveLength(1);

    // Simulate a new repo being opened
    expect(capturedHandler).not.toBeNull();
    capturedHandler!({ rootUri: { fsPath: "/workspace/repo-b" } });

    // Now two repos
    expect(watcher.repos).toHaveLength(2);
    expect(watcher.repos[1].rootPath).toBe("/workspace/repo-b");

    watcher.dispose();
  });

  /**
   * **Validates: Requirements 1.2 (dedup)**
   *
   * onDidOpenRepository should not add duplicate repos.
   */
  it("does not add duplicate repos via onDidOpenRepository", () => {
    let capturedHandler: ((repo: { rootUri: { fsPath: string } }) => void) | null = null;

    const ext = createMockGitExtension({
      isActive: true,
      repositories: [mockRepo("/workspace/repo-a")],
      onDidOpenRepositoryFn: (handler) => {
        capturedHandler = handler;
        return { dispose: () => {} };
      },
    });
    mockGetExtension.mockReturnValue(ext);

    const watcher = new SessionLogWatcher("/workspace");
    watcher.initRepoDiscovery();

    // Fire the same repo path again
    capturedHandler!({ rootUri: { fsPath: "/workspace/repo-a" } });

    // Should still be 1 repo (no duplicate)
    expect(watcher.repos).toHaveLength(1);

    watcher.dispose();
  });

  /**
   * **Validates: Requirements 6.1, 6.3**
   *
   * IF the Git Extension API is not active when the SessionLogWatcher starts,
   * THEN it SHALL use the Workspace_Root as the initial Repository root
   * and log a message indicating deferred initialization.
   */
  it("falls back to workspace root when git API exists but is not active (deferred init)", () => {
    const ext = {
      isActive: false,
      exports: {
        getAPI: () => null,
      },
    };
    mockGetExtension.mockReturnValue(ext);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const watcher = new SessionLogWatcher("/workspace");
    watcher.initRepoDiscovery();

    // Should fall back to workspace root
    expect(watcher.repos).toHaveLength(1);
    expect(watcher.repos[0].rootPath).toBe("/workspace");

    // Should log about deferred initialization
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("deferred initialization")
    );

    watcher.dispose();
  });

  /**
   * **Validates: Requirements 1.1, 1.3**
   *
   * When git API is active but has zero repositories, fall back to workspace root.
   */
  it("falls back to workspace root when git API is active but has no repositories", () => {
    const ext = createMockGitExtension({
      isActive: true,
      repositories: [],
    });
    mockGetExtension.mockReturnValue(ext);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const watcher = new SessionLogWatcher("/workspace");
    watcher.initRepoDiscovery();

    expect(watcher.repos).toHaveLength(1);
    expect(watcher.repos[0].rootPath).toBe("/workspace");

    // Should log a warning about no repos found
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[git-ai-kiro]")
    );

    watcher.dispose();
  });

  /**
   * **Validates: Requirements 1.1 (path normalization)**
   *
   * Repos discovered from git API should have their paths normalized
   * (backslashes → forward slashes).
   */
  it("normalizes Windows-style backslash paths from git API", () => {
    const ext = createMockGitExtension({
      isActive: true,
      repositories: [mockRepo("C:\\Users\\dev\\workspace\\repo-a")],
    });
    mockGetExtension.mockReturnValue(ext);

    const watcher = new SessionLogWatcher("C:\\Users\\dev\\workspace");
    watcher.initRepoDiscovery();

    expect(watcher.repos).toHaveLength(1);
    expect(watcher.repos[0].rootPath).toBe("C:/Users/dev/workspace/repo-a");
    expect(watcher.repos[0].rootPath).not.toContain("\\");

    watcher.dispose();
  });

  /**
   * **Validates: Requirements 6.2**
   *
   * When the git API is active but has no repos at startup, the watcher
   * falls back to workspace root AND subscribes to onDidOpenRepository.
   * When a repo is later opened, it is added to the tracked set.
   */
  it("onDidOpenRepository adds repos discovered after initial startup (active API, zero repos)", () => {
    let capturedHandler: ((repo: { rootUri: { fsPath: string } }) => void) | null = null;

    const ext = createMockGitExtension({
      isActive: true,
      repositories: [], // No repos at startup
      onDidOpenRepositoryFn: (handler) => {
        capturedHandler = handler;
        return { dispose: () => {} };
      },
    });
    mockGetExtension.mockReturnValue(ext);

    const watcher = new SessionLogWatcher("/workspace");
    watcher.initRepoDiscovery();

    // Initially falls back to workspace root (no repos from API)
    expect(watcher.repos).toHaveLength(1);
    expect(watcher.repos[0].rootPath).toBe("/workspace");

    // The subscription IS set up (before the empty-repos fallback check)
    expect(capturedHandler).not.toBeNull();

    // Later, a repo is opened via onDidOpenRepository
    capturedHandler!({ rootUri: { fsPath: "/workspace/repo-new" } });

    // The new repo is added alongside the workspace root fallback
    expect(watcher.repos).toHaveLength(2);
    expect(watcher.repos[1].rootPath).toBe("/workspace/repo-new");

    watcher.dispose();
  });

  /**
   * **Validates: Requirements 1.2 (cleanup)**
   *
   * dispose() should clean up the git API subscription.
   */
  it("disposes git API subscription on dispose()", () => {
    const disposeFn = vi.fn();

    const ext = createMockGitExtension({
      isActive: true,
      repositories: [mockRepo("/workspace/repo-a")],
      onDidOpenRepositoryFn: () => ({ dispose: disposeFn }),
    });
    mockGetExtension.mockReturnValue(ext);

    const watcher = new SessionLogWatcher("/workspace");
    watcher.initRepoDiscovery();

    watcher.dispose();

    expect(disposeFn).toHaveBeenCalledTimes(1);
    expect(watcher.repos).toHaveLength(0);
  });
});
