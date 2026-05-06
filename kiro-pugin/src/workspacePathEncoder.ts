/**
 * WorkspacePathEncoder — pure-function module for workspace path encoding
 * and shared type definitions used across the Kiro Session Monitor modules.
 *
 * Uses Node.js built-in URL-safe Base64 encoding (base64url) which replaces
 * `+` with `-`, `/` with `_`, and omits trailing `=` padding. This matches
 * the encoding Kiro IDE uses for workspace-sessions directory names.
 */

// ── Shared Type Definitions ──────────────────────────────────────────

/** A single AI write operation extracted from an Execution Log. */
export interface WriteAction {
  /** Operation type: replace, create, write, append, editCode, delete, smartRelocate */
  actionType: string;
  /** File path relative to the workspace root */
  filePath: string;
  /** Full file content before modification (Format A only) */
  originalContent?: string;
  /** Full file content after modification */
  modifiedContent?: string;
  /** Timestamp in milliseconds (Format A only) */
  emittedAt?: number;
}

/** Result of parsing a single Execution Log file. */
export interface ParseResult {
  /** Extracted write actions */
  writeActions: WriteAction[];
  /** Detected log format */
  format: "A" | "B";
  /** Associated chat session ID */
  chatSessionId?: string;
  /** Execution end timestamp in milliseconds */
  endTime?: number;
}

/** Result of scanning multiple Execution Log files. */
export interface ScanResult {
  /** Aggregated write actions (filtered) */
  writeActions: WriteAction[];
  /** Number of files successfully scanned */
  scannedFiles: number;
  /** Number of files skipped (read failure, too large, etc.) */
  skippedFiles: number;
}

/** Payload format for git-ai checkpoint agent-v1. */
export interface AICheckpointPayload {
  type: "ai_agent";
  repo_working_dir: string;
  agent_name: "kiro";
  model: "kiro-ai";
  conversation_id?: string;
  edited_filepaths: string[];
  dirty_files: Record<string, string>;
  transcript: {
    messages: Array<{ type: string; text: string }>;
  };
}

// ── Encoding Functions ───────────────────────────────────────────────

/**
 * Encode a workspace absolute path to a URL-safe Base64 string.
 *
 * Uses Node.js built-in `base64url` encoding:
 * - `-` replaces `+`
 * - `_` replaces `/`
 * - No trailing `=` padding
 *
 * Path characters (backslashes on Windows, forward slashes on Unix)
 * are preserved as-is in the encoded representation.
 */
export function encodeWorkspacePath(workspacePath: string): string {
  return Buffer.from(workspacePath).toString("base64url");
}

/**
 * Decode a URL-safe Base64 string back to the original workspace absolute path.
 */
export function decodeWorkspacePath(encoded: string): string {
  return Buffer.from(encoded, "base64url").toString();
}
