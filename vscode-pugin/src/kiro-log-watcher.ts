/**
 * KiroLogWatcher - 通过监听 Kiro Logs 磁盘文件检测 AI 编辑
 *
 * Kiro 的 agent 日志写入磁盘文件：
 *   ~/Library/Application Support/Kiro/User/globalStorage/kiro.kiroagent/Kiro Logs.log (macOS)
 *   ~/.config/Kiro/User/globalStorage/kiro.kiroagent/Kiro Logs.log (Linux)
 *   %APPDATA%/Kiro/User/globalStorage/kiro.kiroagent/Kiro Logs.log (Windows)
 *
 * 用 fs.watchFile 轮询文件变化，读取新增行，解析 [WriteFile] 和 [AgentIterator] 等关键字。
 * 完全不依赖 Output 面板是否打开。
 */

import * as fs from "fs";
import * as path from "path";
import { homedir } from "os";

export type KiroLogCallback = (line: string) => void;

export class KiroLogWatcher {
  private watchers: string[] = []; // 被监听的文件路径
  private lastSizes = new Map<string, number>();
  private callback: KiroLogCallback | null = null;
  private retryTimer: NodeJS.Timeout | null = null;

  /**
   * 开始监听所有 Kiro Logs 文件
   */
  start(callback: KiroLogCallback): void {
    this.callback = callback;
    const logFiles = this.findAllLogFiles();

    if (logFiles.length > 0) {
      for (const f of logFiles) this.startWatchingFile(f);
      console.log(`[kiro-ai-coverage] 监听 ${logFiles.length} 个 Kiro Logs 文件`);
    } else {
      console.log("[kiro-ai-coverage] Kiro Logs 文件未找到，将每 30 秒重试");
      this.retryTimer = setInterval(() => {
        const found = this.findAllLogFiles();
        if (found.length > 0) {
          for (const f of found) {
            if (!this.watchers.includes(f)) this.startWatchingFile(f);
          }
          if (this.retryTimer) {
            clearInterval(this.retryTimer);
            this.retryTimer = null;
          }
        }
      }, 30_000);
    }
  }

  stop(): void {
    for (const f of this.watchers) {
      fs.unwatchFile(f);
    }
    this.watchers = [];
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private startWatchingFile(filePath: string): void {
    try {
      const stat = fs.statSync(filePath);
      this.lastSizes.set(filePath, stat.size);
    } catch {
      this.lastSizes.set(filePath, 0);
    }

    this.watchers.push(filePath);
    console.log(`[kiro-ai-coverage] 监听: ${filePath}`);

    fs.watchFile(filePath, { interval: 300 }, (curr) => {
      const lastSize = this.lastSizes.get(filePath) || 0;
      if (curr.size > lastSize) {
        this.readNewLines(filePath, lastSize, curr.size);
        this.lastSizes.set(filePath, curr.size);
      } else if (curr.size < lastSize) {
        this.lastSizes.set(filePath, 0);
        this.readNewLines(filePath, 0, curr.size);
        this.lastSizes.set(filePath, curr.size);
      }
    });
  }

  private readNewLines(filePath: string, start: number, end: number): void {
    try {
      const fd = fs.openSync(filePath, "r");
      const buf = Buffer.alloc(end - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      fs.closeSync(fd);

      const text = buf.toString("utf-8");
      const lines = text.split("\n");
      for (const line of lines) {
        if (line.trim() && this.callback) {
          this.callback(line);
        }
      }
    } catch (err) {
      console.error("[kiro-ai-coverage] 读取 Kiro Logs 失败:", err);
    }
  }

  /** 查找所有 Kiro Logs 文件路径 */
  private findAllLogFiles(): string[] {
    const results: string[] = [];

    // 检查 globalStorage 路径
    const basePath = getKiroLogBasePath();
    const directPath = path.join(basePath, "Kiro Logs.log");
    if (fs.existsSync(directPath)) {
      results.push(directPath);
    }

    // 检查 logs 目录下最新 session 的所有 window
    const sessionFiles = this.getAllSessionLogFiles();
    for (const f of sessionFiles) {
      if (!results.includes(f)) results.push(f);
    }

    return results;
  }

  /** 获取最新 session 下所有 window 的 Kiro Logs.log */
  private getAllSessionLogFiles(): string[] {
    const home = homedir();
    const platform = process.platform;
    let logsDir: string;

    switch (platform) {
      case "darwin":
        logsDir = path.join(home, "Library", "Application Support", "Kiro", "logs");
        break;
      case "linux":
        logsDir = path.join(home, ".config", "Kiro", "logs");
        break;
      case "win32": {
        const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
        logsDir = path.join(appData, "Kiro", "logs");
        break;
      }
      default:
        return [];
    }

    if (!fs.existsSync(logsDir)) return [];

    try {
      const sessions = fs.readdirSync(logsDir)
        .filter((d) => /^\d{8}T\d{6}$/.test(d))
        .sort()
        .reverse();

      // 只看最新的 session
      for (const session of sessions.slice(0, 1)) {
        const sessionDir = path.join(logsDir, session);
        const windows = fs.readdirSync(sessionDir)
          .filter((d) => d.startsWith("window"));

        const files: string[] = [];
        for (const win of windows) {
          const logFile = path.join(sessionDir, win, "exthost", "kiro.kiroAgent", "Kiro Logs.log");
          if (fs.existsSync(logFile)) {
            files.push(logFile);
          }
        }
        if (files.length > 0) return files;
      }
    } catch { /* */ }

    return [];
  }
}

function getKiroLogBasePath(): string {
  const home = homedir();
  const platform = process.platform;
  switch (platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support", "Kiro", "User", "globalStorage", "kiro.kiroagent");
    case "linux":
      return path.join(home, ".config", "Kiro", "User", "globalStorage", "kiro.kiroagent");
    case "win32": {
      const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
      return path.join(appData, "Kiro", "User", "globalStorage", "kiro.kiroagent");
    }
    default:
      return path.join(home, ".config", "Kiro", "User", "globalStorage", "kiro.kiroagent");
  }
}
