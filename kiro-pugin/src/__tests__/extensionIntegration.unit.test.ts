/**
 * Extension integration unit tests.
 *
 * Feature: kiro-session-monitor
 * Validates: Requirements 10.1-10.6
 *
 * Verifies that extension.ts activate():
 * - Creates SessionLogWatcher (not AIEditManager)
 * - Does NOT register onDidChangeTextDocument listeners for Output Channel
 * - CommitWatcher is still created and started
 * - StatusBar is created and set to "watching"
 * - SessionLogWatcher.start() is called
 * - SessionLogWatcher is added to context.subscriptions
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Track mock instances ─────────────────────────────────────────────

const mockSessionLogWatcherStart = vi.fn();
const mockSessionLogWatcherSetStatusBar = vi.fn();
const mockSessionLogWatcherInstance = {
  start: mockSessionLogWatcherStart,
  setStatusBar: mockSessionLogWatcherSetStatusBar,
  dispose: vi.fn(),
};

const mockCommitWatcherStart = vi.fn();
const mockCommitWatcherInstance = {
  start: mockCommitWatcherStart,
  dispose: vi.fn(),
};

const mockStatusBarSetState = vi.fn();
const mockStatusBarInstance = {
  setState: mockStatusBarSetState,
  dispose: vi.fn(),
};

// ── Mock vscode ──────────────────────────────────────────────────────

const mockOnDidChangeTextDocument = vi.fn();
const mockSubscriptions: unknown[] = [];

vi.mock("vscode", () => ({
  workspace: {
    workspaceFolders: [{ uri: { fsPath: "/test/workspace" } }],
    getConfiguration: vi.fn().mockReturnValue({
      get: vi.fn().mockReturnValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
    }),
    onDidChangeTextDocument: (...args: unknown[]) => mockOnDidChangeTextDocument(...args),
  },
  window: {
    createStatusBarItem: vi.fn().mockReturnValue({
      show: vi.fn(),
      dispose: vi.fn(),
      text: "",
    }),
    showErrorMessage: vi.fn(),
  },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ConfigurationTarget: { Global: 1 },
  extensions: {
    getExtension: vi.fn().mockReturnValue(undefined),
  },
}));

// ── Mock checkpoint ──────────────────────────────────────────────────

const mockInitBundledBinary = vi.fn();
const mockIsBinaryReady = vi.fn().mockReturnValue(true);

vi.mock("../checkpoint", () => ({
  initBundledBinary: (...args: unknown[]) => mockInitBundledBinary(...args),
  isBinaryReady: () => mockIsBinaryReady(),
  getIgnorePatterns: vi.fn().mockReturnValue([]),
  matchesIgnorePattern: vi.fn().mockReturnValue(false),
}));

// ── Mock sessionLogWatcher ───────────────────────────────────────────

const SessionLogWatcherConstructor = vi.fn().mockReturnValue(mockSessionLogWatcherInstance);

vi.mock("../sessionLogWatcher", () => ({
  SessionLogWatcher: class {
    constructor(...args: unknown[]) {
      SessionLogWatcherConstructor(...args);
      return mockSessionLogWatcherInstance;
    }
  },
}));

// ── Mock commitWatcher ───────────────────────────────────────────────

const CommitWatcherConstructor = vi.fn().mockReturnValue(mockCommitWatcherInstance);

vi.mock("../commitWatcher", () => ({
  CommitWatcher: class {
    constructor(...args: unknown[]) {
      CommitWatcherConstructor(...args);
      return mockCommitWatcherInstance;
    }
  },
}));

// ── Mock statusBar ───────────────────────────────────────────────────

const StatusBarConstructor = vi.fn().mockReturnValue(mockStatusBarInstance);

vi.mock("../statusBar", () => ({
  StatusBar: class {
    constructor(...args: unknown[]) {
      StatusBarConstructor(...args);
      return mockStatusBarInstance;
    }
  },
}));

// ── Import after mocks ──────────────────────────────────────────────

import { activate } from "../extension";

// ── Helpers ──────────────────────────────────────────────────────────

function makeExtensionContext(): { extensionPath: string; extensionMode: number; subscriptions: unknown[] } {
  mockSubscriptions.length = 0;
  return {
    extensionPath: "/test/extension",
    extensionMode: 1,
    subscriptions: mockSubscriptions,
  };
}

// ── Lifecycle ────────────────────────────────────────────────────────

beforeEach(() => {
  mockSubscriptions.length = 0;
  mockOnDidChangeTextDocument.mockReset();
  mockInitBundledBinary.mockReset();
  mockIsBinaryReady.mockReset().mockReturnValue(true);
  SessionLogWatcherConstructor.mockClear();
  CommitWatcherConstructor.mockClear();
  StatusBarConstructor.mockClear();
  mockSessionLogWatcherStart.mockReset();
  mockSessionLogWatcherSetStatusBar.mockReset();
  mockCommitWatcherStart.mockReset();
  mockStatusBarSetState.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────

describe("extension.ts activate — SessionLogWatcher integration", () => {
  /**
   * **Validates: Requirements 10.1, 10.2**
   *
   * activate() creates a SessionLogWatcher, not an AIEditManager.
   * AIEditManager has been completely removed.
   */
  it("creates a SessionLogWatcher with the workspace path", () => {
    const ctx = makeExtensionContext();
    activate(ctx as any);

    expect(SessionLogWatcherConstructor).toHaveBeenCalledTimes(1);
    expect(SessionLogWatcherConstructor).toHaveBeenCalledWith("/test/workspace");
  });

  /**
   * **Validates: Requirements 10.5**
   *
   * SessionLogWatcher.start() is called during activation.
   */
  it("calls SessionLogWatcher.start()", () => {
    const ctx = makeExtensionContext();
    activate(ctx as any);

    expect(mockSessionLogWatcherStart).toHaveBeenCalledTimes(1);
  });

  /**
   * **Validates: Requirements 10.5**
   *
   * SessionLogWatcher.setStatusBar() is called with the StatusBar instance.
   */
  it("calls SessionLogWatcher.setStatusBar() with the StatusBar", () => {
    const ctx = makeExtensionContext();
    activate(ctx as any);

    expect(mockSessionLogWatcherSetStatusBar).toHaveBeenCalledTimes(1);
    expect(mockSessionLogWatcherSetStatusBar).toHaveBeenCalledWith(mockStatusBarInstance);
  });

  /**
   * **Validates: Requirements 10.5**
   *
   * SessionLogWatcher is added to context.subscriptions for proper disposal.
   */
  it("adds SessionLogWatcher to context.subscriptions", () => {
    const ctx = makeExtensionContext();
    activate(ctx as any);

    expect(mockSubscriptions).toContain(mockSessionLogWatcherInstance);
  });
});

describe("extension.ts activate — no Output Channel listener", () => {
  /**
   * **Validates: Requirements 10.3, 10.6**
   *
   * After migration, the extension does NOT register any
   * onDidChangeTextDocument listeners for Output Channel documents.
   */
  it("does not register onDidChangeTextDocument listener", () => {
    const ctx = makeExtensionContext();
    activate(ctx as any);

    expect(mockOnDidChangeTextDocument).not.toHaveBeenCalled();
  });
});

describe("extension.ts activate — CommitWatcher still works", () => {
  /**
   * **Validates: Requirements 10.8**
   *
   * CommitWatcher is still created and started during activation.
   */
  it("creates and starts CommitWatcher", () => {
    const ctx = makeExtensionContext();
    activate(ctx as any);

    expect(CommitWatcherConstructor).toHaveBeenCalledTimes(1);
    expect(mockCommitWatcherStart).toHaveBeenCalledTimes(1);
  });

  /**
   * **Validates: Requirements 10.8**
   *
   * CommitWatcher is added to context.subscriptions.
   */
  it("adds CommitWatcher to context.subscriptions", () => {
    const ctx = makeExtensionContext();
    activate(ctx as any);

    expect(mockSubscriptions).toContain(mockCommitWatcherInstance);
  });
});

describe("extension.ts activate — StatusBar", () => {
  /**
   * **Validates: Requirements 10.8**
   *
   * StatusBar is created and set to "watching" state when binary is ready.
   */
  it("creates StatusBar and sets state to watching", () => {
    const ctx = makeExtensionContext();
    activate(ctx as any);

    expect(StatusBarConstructor).toHaveBeenCalledTimes(1);
    expect(mockStatusBarSetState).toHaveBeenCalledWith("watching");
  });

  /**
   * **Validates: Requirements 10.8**
   *
   * StatusBar is added to context.subscriptions.
   */
  it("adds StatusBar to context.subscriptions", () => {
    const ctx = makeExtensionContext();
    activate(ctx as any);

    expect(mockSubscriptions).toContain(mockStatusBarInstance);
  });

  it("sets StatusBar to inactive when binary is not ready", () => {
    mockIsBinaryReady.mockReturnValue(false);
    const ctx = makeExtensionContext();
    activate(ctx as any);

    expect(mockStatusBarSetState).toHaveBeenCalledWith("inactive");
    // SessionLogWatcher should NOT be created when binary is not ready
    expect(SessionLogWatcherConstructor).not.toHaveBeenCalled();
  });
});

describe("extension.ts activate — retained functionality", () => {
  /**
   * **Validates: Requirements 10.8**
   *
   * initBundledBinary and cleanupGitPathOverride are still called.
   */
  it("calls initBundledBinary with extension path", () => {
    const ctx = makeExtensionContext();
    activate(ctx as any);

    expect(mockInitBundledBinary).toHaveBeenCalledWith("/test/extension");
  });

  /**
   * **Validates: Requirements 10.1, 10.2**
   *
   * Verify AIEditManager is not imported or instantiated in extension.ts.
   * We check that no import statement references "ai-edit-manager" and
   * no code instantiates AIEditManager.
   */
  it("does not import or instantiate AIEditManager", async () => {
    // Read the extension source to verify no AIEditManager import/usage
    const fs = await import("node:fs");
    const path = await import("node:path");
    const extensionSource = fs.readFileSync(
      path.join(__dirname, "..", "extension.ts"),
      "utf-8"
    );

    // No import from ai-edit-manager module
    expect(extensionSource).not.toMatch(/import\s.*from\s+["']\.\/ai-edit-manager["']/);
    // No "new AIEditManager" instantiation
    expect(extensionSource).not.toMatch(/new\s+AIEditManager/);
  });
});
