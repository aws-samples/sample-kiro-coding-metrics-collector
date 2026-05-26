/**
 * CheckpointPayloadBuilder — builds AICheckpointPayload from WriteAction lists.
 *
 * Converts extracted WriteAction records into the payload format expected by
 * `callCheckpointAgentV1` (git-ai checkpoint agent-v1).
 *
 * dirty_files strategy:
 * - Format A (has originalContent): use originalContent as dirty_files value
 * - Format B (no originalContent): read current file content from disk as fallback
 * - When multiple WriteActions modify the same file, use the one with the latest
 *   emittedAt timestamp for modifiedContent
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { WriteAction, AICheckpointPayload } from "./workspacePathEncoder";
import { matchesIgnorePattern } from "./checkpoint";

/**
 * Build an AICheckpointPayload from a list of WriteAction records.
 *
 * @param workspacePath - Absolute path to the workspace root
 * @param actions - List of WriteAction records extracted from Execution Logs
 * @param chatSessionId - Optional chat session ID for conversation tracking
 * @param ignorePatterns - Optional list of ignore patterns to filter file paths
 * @returns AICheckpointPayload ready for callCheckpointAgentV1
 */
export async function buildCheckpointPayload(
  workspacePath: string,
  actions: WriteAction[],
  chatSessionId?: string,
  ignorePatterns?: string[]
): Promise<AICheckpointPayload> {
  const patterns = ignorePatterns ?? [];

  // Filter out actions whose file paths match ignore patterns
  const filteredActions = patterns.length > 0
    ? actions.filter((a) => !matchesIgnorePattern(a.filePath, patterns))
    : actions;

  // Deduplicate file paths for edited_filepaths
  const editedFilePathsSet = new Set<string>();
  for (const action of filteredActions) {
    editedFilePathsSet.add(action.filePath);
  }
  const editedFilepaths = [...editedFilePathsSet];

  // Build dirty_files: for each unique file, pick the action with the latest
  // emittedAt timestamp to get the most recent modifiedContent.
  // Use originalContent (Format A) as the dirty_files value, or fall back to
  // reading the current file from disk (Format B).
  const dirtyFiles: Record<string, string> = {};

  // Group actions by filePath, keeping the one with the latest emittedAt
  const latestByFile = new Map<string, WriteAction>();
  for (const action of filteredActions) {
    const existing = latestByFile.get(action.filePath);
    if (!existing) {
      latestByFile.set(action.filePath, action);
    } else {
      // Use the action with the latest emittedAt timestamp
      const existingTime = existing.emittedAt ?? 0;
      const currentTime = action.emittedAt ?? 0;
      if (currentTime >= existingTime) {
        latestByFile.set(action.filePath, action);
      }
    }
  }

  // Build dirty_files from the latest action per file
  for (const [filePath, action] of latestByFile) {
    if (action.originalContent !== undefined) {
      // Format A: use originalContent as the pre-edit baseline
      dirtyFiles[filePath] = action.originalContent;
    } else {
      // Format B fallback: read current file content from disk
      try {
        const absolutePath = path.resolve(workspacePath, filePath);
        const content = await fs.promises.readFile(absolutePath, "utf-8");
        dirtyFiles[filePath] = content;
      } catch {
        // If file cannot be read (deleted, permissions, etc.), skip it
        // Silent degradation per error handling strategy
        console.log(
          `[git-ai-kiro] Could not read file for dirty_files: ${filePath}`
        );
      }
    }
  }

  return {
    type: "ai_agent",
    repo_working_dir: workspacePath,
    agent_name: "kiro",
    model: "kiro-ai",
    conversation_id: chatSessionId,
    edited_filepaths: editedFilepaths,
    dirty_files: dirtyFiles,
    transcript: {
      messages: [{ type: "assistant", text: "Kiro AI edit" }],
    },
  };
}
