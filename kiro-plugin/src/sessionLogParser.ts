/**
 * SessionLogParser — pure-function module for parsing Kiro Execution Logs.
 *
 * Supports two log formats:
 * - Format A: `actions` array with full originalContent/modifiedContent (Autopilot/Spec workflows)
 * - Format B: `context.messages` with toolUse entries (Chat workflows)
 *
 * All functions are pure (no I/O, no VS Code API dependencies) and never throw.
 */

import type { WriteAction, ParseResult } from "./workspacePathEncoder";

// ── Format B Constants ───────────────────────────────────────────────

/**
 * Set of tool names that represent file-writing operations in Format B logs.
 * Only toolUse entries with these names are extracted from context.messages.
 */
export const FORMAT_B_TOOL_NAMES = new Set<string>([
  "fsWrite",
  "strReplace",
  "fsAppend",
  "deleteFile",
]);

// ── Constants ────────────────────────────────────────────────────────

/**
 * Set of actionType values that represent file-writing operations.
 * Only actions with these types are extracted from Format A logs.
 */
export const WRITE_ACTION_TYPES = new Set<string>([
  "replace",
  "create",
  "write",
  "append",
  "editCode",
  "delete",
  "smartRelocate",
]);

// ── Format A Extraction ──────────────────────────────────────────────

/**
 * Extract WriteAction records from a Format A `actions` array.
 *
 * Rules:
 * - Only actions with `actionState === "Accepted"` are included
 * - Only actions with `actionType` in WRITE_ACTION_TYPES are included
 * - `file`, `originalContent`, `modifiedContent` are read from `input`
 * - `create` actions have `originalContent` set to empty string
 * - `delete` actions have `modifiedContent` set to empty string
 * - Results are sorted by `emittedAt` ascending
 */
export function extractFormatAWriteActions(actions: unknown[]): WriteAction[] {
  const results: WriteAction[] = [];

  for (const action of actions) {
    if (action == null || typeof action !== "object") {
      continue;
    }

    const a = action as Record<string, unknown>;

    // Filter: only Accepted (or Success for delete) actions with a write actionType
    if (a.actionState !== "Accepted" && !(a.actionState === "Success" && a.actionType === "delete")) {
      continue;
    }

    const actionType = a.actionType;
    if (typeof actionType !== "string" || !WRITE_ACTION_TYPES.has(actionType)) {
      continue;
    }

    // Extract fields from input object
    const input = a.input;
    if (input == null || typeof input !== "object") {
      continue;
    }

    const inp = input as Record<string, unknown>;
    const file = inp.file;
    if (typeof file !== "string") {
      continue;
    }

    // Determine originalContent and modifiedContent based on actionType
    let originalContent: string | undefined;
    let modifiedContent: string | undefined;

    if (actionType === "create") {
      // create: originalContent is always empty string
      originalContent = "";
      modifiedContent =
        typeof inp.modifiedContent === "string"
          ? inp.modifiedContent
          : undefined;
    } else if (actionType === "delete") {
      // delete: modifiedContent is always empty string
      originalContent =
        typeof inp.originalContent === "string"
          ? inp.originalContent
          : undefined;
      modifiedContent = "";
    } else {
      // replace, write, append, editCode, smartRelocate
      originalContent =
        typeof inp.originalContent === "string"
          ? inp.originalContent
          : undefined;
      modifiedContent =
        typeof inp.modifiedContent === "string"
          ? inp.modifiedContent
          : undefined;
    }

    // Extract emittedAt timestamp
    const emittedAt =
      typeof a.emittedAt === "number" ? a.emittedAt : undefined;

    results.push({
      actionType,
      filePath: file,
      originalContent,
      modifiedContent,
      emittedAt,
    });
  }

  // Sort by emittedAt ascending (actions without emittedAt go to the end)
  results.sort((a, b) => {
    const ta = a.emittedAt ?? Number.MAX_SAFE_INTEGER;
    const tb = b.emittedAt ?? Number.MAX_SAFE_INTEGER;
    return ta - tb;
  });

  return results;
}

// ── Format B Extraction ──────────────────────────────────────────────

/**
 * Map a Format B tool name to a WriteAction actionType and extract the file path.
 * Returns null if the tool name is not recognized or args are invalid.
 */
function extractFormatBFields(
  name: string,
  args: Record<string, unknown>
): { actionType: string; filePath: string; modifiedContent?: string } | null {
  switch (name) {
    case "fsWrite": {
      const filePath = args.path;
      if (typeof filePath !== "string") return null;
      return {
        actionType: "write",
        filePath,
        modifiedContent:
          typeof args.text === "string" ? args.text : undefined,
      };
    }
    case "strReplace": {
      const filePath = args.path;
      if (typeof filePath !== "string") return null;
      return { actionType: "replace", filePath };
    }
    case "fsAppend": {
      const filePath = args.path;
      if (typeof filePath !== "string") return null;
      return {
        actionType: "append",
        filePath,
        modifiedContent:
          typeof args.text === "string" ? args.text : undefined,
      };
    }
    case "deleteFile": {
      const filePath = args.targetFile;
      if (typeof filePath !== "string") return null;
      return { actionType: "delete", filePath, modifiedContent: "" };
    }
    default:
      return null;
  }
}

/**
 * Extract WriteAction records from Format B `context.messages` array.
 *
 * Rules:
 * - Scan `role: "bot"` messages for `entries` with `type: "toolUse"`
 *   and `name` in FORMAT_B_TOOL_NAMES
 * - Match each toolUse entry with a corresponding `toolUseResponse`
 *   (via `id` field) — only keep calls where `success === true`
 * - Field mapping:
 *   - fsWrite: args.path → filePath, args.text → modifiedContent
 *   - strReplace: args.path → filePath
 *   - fsAppend: args.path → filePath, args.text → modifiedContent
 *   - deleteFile: args.targetFile → filePath, modifiedContent → ""
 */
export function extractFormatBWriteActions(messages: unknown[]): WriteAction[] {
  // First pass: collect all toolUseResponse entries keyed by id,
  // so we can check success status when processing toolUse entries.
  const responseMap = new Map<string, boolean>();

  for (const msg of messages) {
    if (msg == null || typeof msg !== "object") continue;
    const m = msg as Record<string, unknown>;

    const entries = m.entries;
    if (!Array.isArray(entries)) continue;

    for (const entry of entries) {
      if (entry == null || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;

      if (e.type === "toolUseResponse" && typeof e.id === "string") {
        responseMap.set(e.id, e.success === true);
      }
    }
  }

  // Second pass: extract toolUse entries from bot messages
  const results: WriteAction[] = [];

  for (const msg of messages) {
    if (msg == null || typeof msg !== "object") continue;
    const m = msg as Record<string, unknown>;

    // Only scan bot messages
    if (m.role !== "bot") continue;

    const entries = m.entries;
    if (!Array.isArray(entries)) continue;

    for (const entry of entries) {
      if (entry == null || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;

      // Must be a toolUse entry with a recognized write tool name
      if (e.type !== "toolUse") continue;
      const name = e.name;
      if (typeof name !== "string" || !FORMAT_B_TOOL_NAMES.has(name)) continue;

      // Must have an id for matching with toolUseResponse
      const id = e.id;
      if (typeof id !== "string") continue;

      // Only include if the corresponding toolUseResponse has success === true
      const success = responseMap.get(id);
      if (success !== true) continue;

      // Extract args
      const args = e.args;
      if (args == null || typeof args !== "object") continue;

      const fields = extractFormatBFields(
        name,
        args as Record<string, unknown>
      );
      if (fields == null) continue;

      results.push({
        actionType: fields.actionType,
        filePath: fields.filePath,
        modifiedContent: fields.modifiedContent,
      });
    }
  }

  return results;
}

// ── Main Entry Point ─────────────────────────────────────────────────

/**
 * Parse an Execution Log JSON string and extract WriteAction records.
 *
 * Auto-detects the log format:
 * - If JSON contains a non-empty `actions` array → Format A extraction
 * - Otherwise checks `context.messages` → Format B extraction
 * - Any parse error → returns empty result, never throws
 */
export function parseExecutionLog(jsonString: string): ParseResult {
  const emptyResult: ParseResult = {
    writeActions: [],
    format: "B",
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonString);
  } catch {
    return emptyResult;
  }

  if (parsed == null || typeof parsed !== "object") {
    return emptyResult;
  }

  const obj = parsed as Record<string, unknown>;

  // Extract common metadata
  const chatSessionId =
    typeof obj.chatSessionId === "string" ? obj.chatSessionId : undefined;
  const endTime = typeof obj.endTime === "number" ? obj.endTime : undefined;

  // Format detection: non-empty actions array → Format A
  const actions = obj.actions;
  if (Array.isArray(actions) && actions.length > 0) {
    return {
      writeActions: extractFormatAWriteActions(actions),
      format: "A",
      chatSessionId,
      endTime,
    };
  }

  // Fallback: context.messages → Format B
  const context = obj.context;
  if (context != null && typeof context === "object") {
    const ctx = context as Record<string, unknown>;
    const messages = ctx.messages;
    if (Array.isArray(messages)) {
      return {
        writeActions: extractFormatBWriteActions(messages),
        format: "B",
        chatSessionId,
        endTime,
      };
    }
  }

  // No recognizable format
  return {
    writeActions: [],
    format: "B",
    chatSessionId,
    endTime,
  };
}

// ── Format C Extraction (New Kiro JSONL sessions) ───────────────────

/**
 * Set of tool names that represent file-writing operations in Format C logs.
 * Format C uses the new Kiro JSONL session format (~/.kiro/sessions/...).
 */
export const FORMAT_C_WRITE_TOOL_NAMES = new Set<string>([
  "str_replace",
  "write_file",
  "create_file",
  "delete_file",
  "write_to_file",
  "insert_code",
  "fs_write",
]);

/**
 * Extract WriteAction records from Format C JSONL lines.
 *
 * Format C is the new Kiro IDE session format where each line is a JSON object:
 *   {id, timestamp, payload: {type: "tool_call"|"tool_result", toolCallId, toolName, args, ...}}
 *
 * Rules:
 * - Extract lines with `payload.type === "tool_call"` and either:
 *   - `payload.kind === "edit"`, OR
 *   - `payload.toolName` in FORMAT_C_WRITE_TOOL_NAMES
 * - Match each tool_call with its tool_result (via toolCallId) where `success === true`
 * - Use `payload.actionType` if present, otherwise infer from toolName
 * - `args.path` → filePath
 * - `args.newStr` or `args.content` → modifiedContent
 * - `args.oldStr` → originalContent (str_replace only)
 */
export function extractFormatCWriteActions(lines: string[]): WriteAction[] {
  // First pass: collect tool_result success status by toolCallId
  const resultMap = new Map<string, boolean>();

  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const payload = entry.payload;
    if (payload == null || typeof payload !== "object") continue;
    const p = payload as Record<string, unknown>;

    if (p.type === "tool_result" && typeof p.toolCallId === "string") {
      resultMap.set(p.toolCallId, p.success === true);
    }
  }

  // Second pass: extract tool_call entries that are write operations
  const results: WriteAction[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const payload = entry.payload;
    if (payload == null || typeof payload !== "object") continue;
    const p = payload as Record<string, unknown>;

    if (p.type !== "tool_call") continue;

    const toolName = p.toolName;
    if (typeof toolName !== "string") continue;

    // Filter: must be a write/edit operation
    const isEditKind = p.kind === "edit";
    const isWriteTool = FORMAT_C_WRITE_TOOL_NAMES.has(toolName);
    if (!isEditKind && !isWriteTool) continue;

    // Must have a toolCallId for matching with tool_result
    const toolCallId = p.toolCallId;
    if (typeof toolCallId !== "string") continue;

    // Only include if the corresponding tool_result has success === true
    const success = resultMap.get(toolCallId);
    if (success !== true) continue;

    // Extract args
    const args = p.args;
    if (args == null || typeof args !== "object") continue;
    const a = args as Record<string, unknown>;

    // File path from args.path
    const filePath = a.path;
    if (typeof filePath !== "string") continue;

    // Determine actionType: prefer payload.actionType, fallback to inference
    let actionType: string;
    if (typeof p.actionType === "string" && WRITE_ACTION_TYPES.has(p.actionType)) {
      actionType = p.actionType;
    } else {
      // Infer from toolName
      switch (toolName) {
        case "str_replace":
          actionType = "replace";
          break;
        case "write_file":
        case "write_to_file":
        case "create_file":
        case "fs_write":
          actionType = "create";
          break;
        case "insert_code":
          actionType = "write";
          break;
        case "delete_file":
          actionType = "delete";
          break;
        default:
          actionType = "write";
      }
    }

    // Extract content fields
    let originalContent: string | undefined;
    let modifiedContent: string | undefined;

    if (toolName === "str_replace") {
      if (typeof a.oldStr === "string") originalContent = a.oldStr;
      if (typeof a.newStr === "string") modifiedContent = a.newStr;
    } else if (actionType === "delete") {
      modifiedContent = "";
    } else {
      // write_file / create_file: args.content or args.text
      const content = a.content ?? a.text;
      if (typeof content === "string") modifiedContent = content;
    }

    // Extract timestamp
    const timestamp = entry.timestamp;
    let emittedAt: number | undefined;
    if (typeof timestamp === "string") {
      const ms = new Date(timestamp).getTime();
      if (!isNaN(ms)) emittedAt = ms;
    }

    results.push({
      actionType,
      filePath,
      originalContent,
      modifiedContent,
      emittedAt,
    });
  }

  return results;
}

/**
 * Parse a Format C JSONL string (entire file content or incremental chunk)
 * and return a ParseResult.
 *
 * Unlike Format A/B which is a single JSON object, Format C is line-delimited.
 * The session ID is extracted from session.json separately, so chatSessionId
 * is not extracted here.
 */
export function parseFormatCLog(jsonlContent: string): ParseResult {
  const lines = jsonlContent.split("\n");
  const writeActions = extractFormatCWriteActions(lines);

  // Extract the latest timestamp as endTime
  let endTime: number | undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (typeof entry.timestamp === "string") {
        const ms = new Date(entry.timestamp).getTime();
        if (!isNaN(ms)) {
          endTime = ms;
          break;
        }
      }
    } catch {
      continue;
    }
  }

  return {
    writeActions,
    format: "C",
    endTime,
  };
}

// ── Session ID Parsing ───────────────────────────────────────────────

/**
 * Parse a sessions.json string and extract session ID list.
 *
 * Expected format: array of objects with `sessionId` string field.
 * Returns empty array on any parse error, never throws.
 */
export function parseSessionsJson(jsonString: string): string[] {
  try {
    const parsed = JSON.parse(jsonString);
    if (!Array.isArray(parsed)) {
      return [];
    }

    const ids: string[] = [];
    for (const item of parsed) {
      if (item != null && typeof item === "object") {
        const obj = item as Record<string, unknown>;
        if (typeof obj.sessionId === "string") {
          ids.push(obj.sessionId);
        }
      }
    }
    return ids;
  } catch {
    return [];
  }
}

// ── Serialization ────────────────────────────────────────────────────

/**
 * Serialize a WriteAction list to a JSON string.
 * Returns "[]" if serialization fails, never throws.
 */
export function serializeWriteActions(actions: WriteAction[]): string {
  try {
    return JSON.stringify(actions);
  } catch {
    return "[]";
  }
}

/**
 * Deserialize a JSON string back to a WriteAction list.
 * Returns empty array if deserialization fails, never throws.
 */
export function deserializeWriteActions(jsonString: string): WriteAction[] {
  try {
    const parsed = JSON.parse(jsonString);
    if (!Array.isArray(parsed)) {
      return [];
    }

    const results: WriteAction[] = [];
    for (const item of parsed) {
      if (item == null || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;

      // Require minimum fields: actionType and filePath must be strings
      if (typeof obj.actionType !== "string") continue;
      if (typeof obj.filePath !== "string") continue;

      const action: WriteAction = {
        actionType: obj.actionType,
        filePath: obj.filePath,
      };

      if (typeof obj.originalContent === "string") {
        action.originalContent = obj.originalContent;
      }
      if (typeof obj.modifiedContent === "string") {
        action.modifiedContent = obj.modifiedContent;
      }
      if (typeof obj.emittedAt === "number") {
        action.emittedAt = obj.emittedAt;
      }

      results.push(action);
    }
    return results;
  } catch {
    return [];
  }
}
