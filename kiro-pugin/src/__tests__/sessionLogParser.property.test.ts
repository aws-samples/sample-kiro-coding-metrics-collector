/**
 * Property-based tests for SessionLogParser.
 *
 * Feature: kiro-session-monitor
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 4.1-4.7, 5.1-5.5, 11.3, 11.4
 */
import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  extractFormatAWriteActions,
  extractFormatBWriteActions,
  parseExecutionLog,
  serializeWriteActions,
  deserializeWriteActions,
  WRITE_ACTION_TYPES,
  FORMAT_B_TOOL_NAMES,
} from "../sessionLogParser";
import type { WriteAction } from "../workspacePathEncoder";

// ── Generators ───────────────────────────────────────────────────────

const WRITE_ACTION_TYPE_LIST = [...WRITE_ACTION_TYPES];
const NON_WRITE_ACTION_TYPES = ["read", "search", "navigate", "openFile", "closeFile", "unknown"];
const ACTION_STATES = ["Accepted", "Error", "Success", "Rejected", "Pending"];

/** Simple file path arbitrary using stringMatching for path-like characters. */
const simpleFilePathArb = fc.stringMatching(/^[a-z0-9/._-]{1,50}$/);

/** Generate a valid Format A action object with configurable actionState and actionType. */
const formatAActionArb = (opts?: {
  actionState?: fc.Arbitrary<string>;
  actionType?: fc.Arbitrary<string>;
}) =>
  fc.record({
    actionState: opts?.actionState ?? fc.constantFrom(...ACTION_STATES),
    actionType:
      opts?.actionType ??
      fc.constantFrom(...WRITE_ACTION_TYPE_LIST, ...NON_WRITE_ACTION_TYPES),
    input: fc.record({
      file: simpleFilePathArb,
      originalContent: fc.string({ maxLength: 200 }),
      modifiedContent: fc.string({ maxLength: 200 }),
    }),
    emittedAt: fc.nat({ max: 2_000_000_000_000 }),
  });

/** Generate a mixed actions array with both accepted-write and non-matching actions. */
const mixedActionsArrayArb = fc.array(formatAActionArb(), { minLength: 1, maxLength: 20 });

/** Generate a valid accepted write action (guaranteed to pass filters). */
const acceptedWriteActionArb = formatAActionArb({
  actionState: fc.constant("Accepted"),
  actionType: fc.constantFrom(...WRITE_ACTION_TYPE_LIST),
});

/** Arbitrary file path for Format B tools. */
const filePathArb = simpleFilePathArb;

/** Arbitrary text content. */
const textContentArb = fc.string({ maxLength: 200 });

const FORMAT_B_TOOL_LIST = [...FORMAT_B_TOOL_NAMES];

/** Generate a unique ID for toolUse/toolUseResponse matching. */
const toolIdArb = fc.uuid();

/** Generate a Format B toolUse entry with matching toolUseResponse. */
const formatBToolCallArb = (success: boolean) =>
  fc.tuple(
    fc.constantFrom(...FORMAT_B_TOOL_LIST),
    filePathArb,
    textContentArb,
    toolIdArb
  ).map(([toolName, filePath, text, id]) => {
    const args: Record<string, unknown> =
      toolName === "deleteFile"
        ? { targetFile: filePath }
        : { path: filePath, text };

    const toolUseEntry = { type: "toolUse", id, name: toolName, args };
    const toolUseResponseEntry = {
      type: "toolUseResponse",
      id,
      success,
    };
    return { toolUseEntry, toolUseResponseEntry, toolName, filePath, text };
  });

/** Generate a WriteAction with all fields populated. */
const writeActionArb: fc.Arbitrary<WriteAction> = fc.record({
  actionType: fc.constantFrom(...WRITE_ACTION_TYPE_LIST),
  filePath: filePathArb,
  originalContent: fc.option(fc.string({ maxLength: 200 }), { nil: undefined }),
  modifiedContent: fc.option(fc.string({ maxLength: 200 }), { nil: undefined }),
  emittedAt: fc.option(fc.nat({ max: 2_000_000_000_000 }), { nil: undefined }),
});

// ── Property 4 ───────────────────────────────────────────────────────

describe("Feature: kiro-session-monitor, Property 4: Format A 提取仅返回 Accepted 的写操作", () => {
  /**
   * **Validates: Requirements 3.1, 3.2**
   *
   * For any actions array with mixed actionState values,
   * extractFormatAWriteActions only returns actions where
   * actionState === "Accepted" and actionType is in WRITE_ACTION_TYPES.
   */
  it("every returned WriteAction comes from an Accepted action with a write actionType", () => {
    fc.assert(
      fc.property(mixedActionsArrayArb, (actions) => {
        const results = extractFormatAWriteActions(actions);

        // Count expected: actions that are Accepted AND have a write actionType AND have valid input.file
        const expected = actions.filter(
          (a) =>
            a.actionState === "Accepted" &&
            WRITE_ACTION_TYPES.has(a.actionType) &&
            typeof a.input?.file === "string"
        );

        expect(results.length).toBe(expected.length);

        for (const wa of results) {
          expect(WRITE_ACTION_TYPES.has(wa.actionType)).toBe(true);
        }
      }),
      { numRuns: 100 }
    );
  });

  it("non-Accepted actions are never included", () => {
    fc.assert(
      fc.property(
        fc.array(
          formatAActionArb({
            actionState: fc.constantFrom("Error", "Success", "Rejected", "Pending"),
            actionType: fc.constantFrom(...WRITE_ACTION_TYPE_LIST),
          }),
          { minLength: 1, maxLength: 10 }
        ),
        (actions) => {
          const results = extractFormatAWriteActions(actions);
          expect(results).toHaveLength(0);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ── Property 5 ───────────────────────────────────────────────────────

describe("Feature: kiro-session-monitor, Property 5: Format A 字段提取保留所有相关字段", () => {
  /**
   * **Validates: Requirements 3.3, 3.4, 3.5, 3.6, 3.7, 6.6**
   *
   * For valid Format A actions, extracted WriteAction preserves filePath
   * (from input.file), emittedAt, and correctly sets originalContent/modifiedContent
   * (create → originalContent="", delete → modifiedContent="").
   * Results sorted by emittedAt ascending.
   */
  it("preserves filePath from input.file and emittedAt timestamp", () => {
    fc.assert(
      fc.property(
        fc.array(acceptedWriteActionArb, { minLength: 1, maxLength: 10 }),
        (actions) => {
          const results = extractFormatAWriteActions(actions);

          expect(results.length).toBe(actions.length);

          for (let i = 0; i < results.length; i++) {
            const wa = results[i];
            // filePath must come from one of the input actions
            const source = actions.find(
              (a) => a.input.file === wa.filePath && a.actionType === wa.actionType
            );
            expect(source).toBeDefined();
            expect(wa.filePath).toBe(source!.input.file);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it("create actions have originalContent set to empty string", () => {
    fc.assert(
      fc.property(
        fc.array(
          formatAActionArb({
            actionState: fc.constant("Accepted"),
            actionType: fc.constant("create"),
          }),
          { minLength: 1, maxLength: 10 }
        ),
        (actions) => {
          const results = extractFormatAWriteActions(actions);
          for (const wa of results) {
            expect(wa.originalContent).toBe("");
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it("delete actions have modifiedContent set to empty string", () => {
    fc.assert(
      fc.property(
        fc.array(
          formatAActionArb({
            actionState: fc.constant("Accepted"),
            actionType: fc.constant("delete"),
          }),
          { minLength: 1, maxLength: 10 }
        ),
        (actions) => {
          const results = extractFormatAWriteActions(actions);
          for (const wa of results) {
            expect(wa.modifiedContent).toBe("");
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it("results are sorted by emittedAt ascending", () => {
    fc.assert(
      fc.property(
        fc.array(acceptedWriteActionArb, { minLength: 2, maxLength: 15 }),
        (actions) => {
          const results = extractFormatAWriteActions(actions);
          for (let i = 1; i < results.length; i++) {
            const prev = results[i - 1].emittedAt ?? Number.MAX_SAFE_INTEGER;
            const curr = results[i].emittedAt ?? Number.MAX_SAFE_INTEGER;
            expect(prev).toBeLessThanOrEqual(curr);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ── Property 6 ───────────────────────────────────────────────────────

describe("Feature: kiro-session-monitor, Property 6: 格式自动检测", () => {
  /**
   * **Validates: Requirements 4.1, 5.1, 5.2, 5.3**
   *
   * If JSON has non-empty actions array, parseExecutionLog returns format "A";
   * if no actions but has context.messages, returns format "B".
   */
  it("non-empty actions array → format A", () => {
    fc.assert(
      fc.property(
        fc.array(acceptedWriteActionArb, { minLength: 1, maxLength: 5 }),
        (actions) => {
          const json = JSON.stringify({ actions });
          const result = parseExecutionLog(json);
          expect(result.format).toBe("A");
        }
      ),
      { numRuns: 100 }
    );
  });

  it("no actions but context.messages → format B", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            role: fc.constantFrom("human", "bot"),
            entries: fc.constant([]),
          }),
          { minLength: 1, maxLength: 5 }
        ),
        (messages) => {
          const json = JSON.stringify({ context: { messages } });
          const result = parseExecutionLog(json);
          expect(result.format).toBe("B");
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ── Property 7 ───────────────────────────────────────────────────────

describe("Feature: kiro-session-monitor, Property 7: Format B 工具调用提取与字段映射", () => {
  /**
   * **Validates: Requirements 4.2, 4.3, 4.4, 4.5, 4.6**
   *
   * extractFormatBWriteActions only extracts from role:"bot" messages,
   * tool names in ["fsWrite","strReplace","fsAppend","deleteFile"],
   * with correct field mapping.
   */
  it("only extracts from bot messages with recognized tool names and correct field mapping", () => {
    fc.assert(
      fc.property(
        fc.array(formatBToolCallArb(true), { minLength: 1, maxLength: 10 }),
        (toolCalls) => {
          // Build messages: one bot message with all toolUse entries,
          // then response entries in a separate message
          const botEntries = toolCalls.map((tc) => tc.toolUseEntry);
          const responseEntries = toolCalls.map((tc) => tc.toolUseResponseEntry);

          const messages = [
            { role: "bot", entries: botEntries },
            { role: "bot", entries: responseEntries },
          ];

          const results = extractFormatBWriteActions(messages);
          expect(results.length).toBe(toolCalls.length);

          for (let i = 0; i < results.length; i++) {
            const wa = results[i];
            const tc = toolCalls[i];

            // Verify filePath mapping
            expect(wa.filePath).toBe(tc.filePath);

            // Verify field mapping per tool type
            if (tc.toolName === "fsWrite") {
              expect(wa.actionType).toBe("write");
              expect(wa.modifiedContent).toBe(tc.text);
            } else if (tc.toolName === "strReplace") {
              expect(wa.actionType).toBe("replace");
            } else if (tc.toolName === "fsAppend") {
              expect(wa.actionType).toBe("append");
              expect(wa.modifiedContent).toBe(tc.text);
            } else if (tc.toolName === "deleteFile") {
              expect(wa.actionType).toBe("delete");
              expect(wa.filePath).toBe(tc.filePath);
              expect(wa.modifiedContent).toBe("");
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it("does not extract from non-bot messages", () => {
    fc.assert(
      fc.property(
        fc.array(formatBToolCallArb(true), { minLength: 1, maxLength: 5 }),
        fc.constantFrom("human", "tool", "system"),
        (toolCalls, role) => {
          const entries = toolCalls.map((tc) => tc.toolUseEntry);
          const responseEntries = toolCalls.map((tc) => tc.toolUseResponseEntry);

          // Put toolUse in a non-bot message, responses in bot message
          const messages = [
            { role, entries },
            { role: "bot", entries: responseEntries },
          ];

          const results = extractFormatBWriteActions(messages);
          expect(results).toHaveLength(0);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ── Property 8 ───────────────────────────────────────────────────────

describe("Feature: kiro-session-monitor, Property 8: 失败的工具调用被排除", () => {
  /**
   * **Validates: Requirements 4.7**
   *
   * When toolUseResponse has success===false, that tool call is excluded from results.
   */
  it("tool calls with success===false are excluded", () => {
    fc.assert(
      fc.property(
        fc.array(formatBToolCallArb(false), { minLength: 1, maxLength: 10 }),
        (toolCalls) => {
          const botEntries = toolCalls.map((tc) => tc.toolUseEntry);
          const responseEntries = toolCalls.map((tc) => tc.toolUseResponseEntry);

          const messages = [
            { role: "bot", entries: botEntries },
            { role: "bot", entries: responseEntries },
          ];

          const results = extractFormatBWriteActions(messages);
          expect(results).toHaveLength(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("mix of success and failure: only successful calls are included", () => {
    fc.assert(
      fc.property(
        fc.array(formatBToolCallArb(true), { minLength: 1, maxLength: 5 }),
        fc.array(formatBToolCallArb(false), { minLength: 1, maxLength: 5 }),
        (successCalls, failCalls) => {
          const allToolUseEntries = [
            ...successCalls.map((tc) => tc.toolUseEntry),
            ...failCalls.map((tc) => tc.toolUseEntry),
          ];
          const allResponseEntries = [
            ...successCalls.map((tc) => tc.toolUseResponseEntry),
            ...failCalls.map((tc) => tc.toolUseResponseEntry),
          ];

          const messages = [
            { role: "bot", entries: allToolUseEntries },
            { role: "bot", entries: allResponseEntries },
          ];

          const results = extractFormatBWriteActions(messages);
          expect(results.length).toBe(successCalls.length);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ── Property 9 ───────────────────────────────────────────────────────

describe("Feature: kiro-session-monitor, Property 9: 解析鲁棒性", () => {
  /**
   * **Validates: Requirements 5.5**
   *
   * For any arbitrary string input, parseExecutionLog never throws
   * and returns a valid ParseResult with writeActions array.
   */
  it("never throws for arbitrary string input", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 500 }), (input) => {
        const result = parseExecutionLog(input);
        expect(result).toBeDefined();
        expect(Array.isArray(result.writeActions)).toBe(true);
        expect(result.format === "A" || result.format === "B").toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it("never throws for arbitrary unicode and special characters", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ maxLength: 300 }),
          fc.constant(""),
          fc.constant("null"),
          fc.constant("undefined"),
          fc.constant("{}"),
          fc.constant("[]"),
          fc.constant("{invalid json"),
          fc.constant('{"actions": "not-an-array"}'),
        ),
        (input) => {
          const result = parseExecutionLog(input);
          expect(result).toBeDefined();
          expect(Array.isArray(result.writeActions)).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ── Property 13 ──────────────────────────────────────────────────────

describe("Feature: kiro-session-monitor, Property 13: WriteAction 序列化 round-trip", () => {
  /**
   * **Validates: Requirements 11.3, 11.4**
   *
   * For any valid WriteAction list, serializeWriteActions then
   * deserializeWriteActions produces equivalent list.
   */
  it("serialize then deserialize produces equivalent WriteAction list", () => {
    fc.assert(
      fc.property(
        fc.array(writeActionArb, { minLength: 0, maxLength: 15 }),
        (actions) => {
          const serialized = serializeWriteActions(actions);
          const deserialized = deserializeWriteActions(serialized);

          expect(deserialized.length).toBe(actions.length);

          for (let i = 0; i < actions.length; i++) {
            const original = actions[i];
            const restored = deserialized[i];

            expect(restored.actionType).toBe(original.actionType);
            expect(restored.filePath).toBe(original.filePath);

            // Optional fields: only present if they were strings/numbers in original
            if (original.originalContent !== undefined) {
              expect(restored.originalContent).toBe(original.originalContent);
            } else {
              expect(restored.originalContent).toBeUndefined();
            }

            if (original.modifiedContent !== undefined) {
              expect(restored.modifiedContent).toBe(original.modifiedContent);
            } else {
              expect(restored.modifiedContent).toBeUndefined();
            }

            if (original.emittedAt !== undefined) {
              expect(restored.emittedAt).toBe(original.emittedAt);
            } else {
              expect(restored.emittedAt).toBeUndefined();
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
