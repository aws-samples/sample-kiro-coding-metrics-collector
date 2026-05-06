/**
 * Property-based tests for CheckpointPayloadBuilder.
 *
 * Feature: kiro-session-monitor
 * Validates: Requirements 7.2, 7.3, 7.6
 */
import { describe, it, expect, vi } from "vitest";
import * as fc from "fast-check";

// Mock vscode before importing modules that depend on it
vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      get: () => [],
    }),
  },
}));

import { buildCheckpointPayload } from "../checkpointPayload";
import type { WriteAction } from "../workspacePathEncoder";

// ── Generators ───────────────────────────────────────────────────────

/** Arbitrary simple file path (no ignore-pattern matches). */
const filePathArb = fc.stringMatching(/^src\/[a-z][a-z0-9]{0,15}\.[a-z]{1,4}$/);

/** Arbitrary action type from the known write action types. */
const actionTypeArb = fc.constantFrom(
  "replace",
  "create",
  "write",
  "append",
  "editCode",
  "delete",
  "smartRelocate"
);

/** Arbitrary file content string. */
const contentArb = fc.string({ minLength: 0, maxLength: 200 });

/** Arbitrary timestamp in milliseconds. */
const timestampArb = fc.integer({ min: 1_000_000_000_000, max: 2_000_000_000_000 });

/**
 * Generate a WriteAction with originalContent set (Format A style)
 * to avoid file system reads in the builder.
 */
const writeActionArb: fc.Arbitrary<WriteAction> = fc.record({
  actionType: actionTypeArb,
  filePath: filePathArb,
  originalContent: contentArb,
  modifiedContent: contentArb,
  emittedAt: timestampArb,
});

/** Arbitrary workspace path (Unix or Windows style). */
const workspacePathArb = fc.oneof(
  fc.constant("/Users/dev/project"),
  fc.constant("/home/user/workspace"),
  fc.constant("C:\\Users\\dev\\my-project"),
  fc.stringMatching(/^\/[a-z]{1,10}(\/[a-z]{1,10}){0,3}$/),
);

/** Arbitrary chat session ID (UUID-like). */
const chatSessionIdArb = fc.uuid();

// ── Property 12: Checkpoint Payload 固定字段与结构 ────────────────────

describe("Feature: kiro-session-monitor, Property 12: Checkpoint Payload 固定字段与结构", () => {
  /**
   * **Validates: Requirements 7.2, 7.3**
   *
   * For any WriteAction list and workspace path, buildCheckpointPayload
   * always sets type === "ai_agent", agent_name === "kiro", model === "kiro-ai".
   */
  it("type is always 'ai_agent'", () => {
    fc.assert(
      fc.asyncProperty(
        workspacePathArb,
        fc.array(writeActionArb, { minLength: 0, maxLength: 10 }),
        async (workspacePath, actions) => {
          const payload = await buildCheckpointPayload(workspacePath, actions);
          expect(payload.type).toBe("ai_agent");
        }
      ),
      { numRuns: 100 }
    );
  });

  it("agent_name is always 'kiro'", () => {
    fc.assert(
      fc.asyncProperty(
        workspacePathArb,
        fc.array(writeActionArb, { minLength: 0, maxLength: 10 }),
        async (workspacePath, actions) => {
          const payload = await buildCheckpointPayload(workspacePath, actions);
          expect(payload.agent_name).toBe("kiro");
        }
      ),
      { numRuns: 100 }
    );
  });

  it("model is always 'kiro-ai'", () => {
    fc.assert(
      fc.asyncProperty(
        workspacePathArb,
        fc.array(writeActionArb, { minLength: 0, maxLength: 10 }),
        async (workspacePath, actions) => {
          const payload = await buildCheckpointPayload(workspacePath, actions);
          expect(payload.model).toBe("kiro-ai");
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 7.3**
   *
   * repo_working_dir always equals the input workspace path.
   */
  it("repo_working_dir equals the input workspace path", () => {
    fc.assert(
      fc.asyncProperty(
        workspacePathArb,
        fc.array(writeActionArb, { minLength: 0, maxLength: 10 }),
        async (workspacePath, actions) => {
          const payload = await buildCheckpointPayload(workspacePath, actions);
          expect(payload.repo_working_dir).toBe(workspacePath);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 7.6**
   *
   * edited_filepaths has no duplicates, even when multiple WriteActions
   * share the same filePath.
   */
  it("edited_filepaths contains no duplicates", () => {
    fc.assert(
      fc.asyncProperty(
        workspacePathArb,
        fc.array(writeActionArb, { minLength: 0, maxLength: 20 }),
        async (workspacePath, actions) => {
          const payload = await buildCheckpointPayload(workspacePath, actions);
          const unique = new Set(payload.edited_filepaths);
          expect(payload.edited_filepaths.length).toBe(unique.size);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("edited_filepaths contains no duplicates even with repeated file paths", () => {
    fc.assert(
      fc.asyncProperty(
        workspacePathArb,
        filePathArb,
        fc.array(writeActionArb, { minLength: 1, maxLength: 5 }),
        async (workspacePath, sharedPath, extraActions) => {
          // Create multiple actions with the same filePath
          const duplicateActions: WriteAction[] = extraActions.map((a) => ({
            ...a,
            filePath: sharedPath,
          }));
          const allActions = [...duplicateActions, ...extraActions];

          const payload = await buildCheckpointPayload(workspacePath, allActions);
          const unique = new Set(payload.edited_filepaths);
          expect(payload.edited_filepaths.length).toBe(unique.size);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * conversation_id equals chatSessionId when provided.
   */
  it("conversation_id equals chatSessionId when provided", () => {
    fc.assert(
      fc.asyncProperty(
        workspacePathArb,
        fc.array(writeActionArb, { minLength: 0, maxLength: 5 }),
        chatSessionIdArb,
        async (workspacePath, actions, chatSessionId) => {
          const payload = await buildCheckpointPayload(
            workspacePath,
            actions,
            chatSessionId
          );
          expect(payload.conversation_id).toBe(chatSessionId);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("conversation_id is undefined when chatSessionId is not provided", () => {
    fc.assert(
      fc.asyncProperty(
        workspacePathArb,
        fc.array(writeActionArb, { minLength: 0, maxLength: 5 }),
        async (workspacePath, actions) => {
          const payload = await buildCheckpointPayload(workspacePath, actions);
          expect(payload.conversation_id).toBeUndefined();
        }
      ),
      { numRuns: 100 }
    );
  });
});
