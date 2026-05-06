/**
 * Download the git-ai binary from GitHub Releases for a specific platform.
 *
 * Usage:
 *   npx ts-node scripts/download-binary.ts <version> <platform>
 *
 * Where:
 *   version  = GitHub release tag, e.g. "v1.2.6"
 *   platform = "darwin-arm64" | "win32-x64"
 *
 * The binary is saved to bin/git-ai (or bin/git-ai.exe on Windows).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as https from "node:https";

const REPO = "git-ai-project/git-ai";

/** Map VS Code platform target to GitHub release asset name. */
const ASSET_MAP: Record<string, { asset: string; binary: string }> = {
  "darwin-arm64": {
    asset: "git-ai-macos-arm64",
    binary: "git-ai",
  },
  "win32-x64": {
    asset: "git-ai-windows-x64.exe",
    binary: "git-ai.exe",
  },
};

async function main() {
  const [, , version, platform] = process.argv;

  if (!version || !platform) {
    console.error("Usage: ts-node download-binary.ts <version> <platform>");
    console.error("  version:  e.g. v1.2.6");
    console.error("  platform: darwin-arm64 | win32-x64");
    process.exit(1);
  }

  const entry = ASSET_MAP[platform];
  if (!entry) {
    console.error(`Unsupported platform: ${platform}`);
    console.error(`Supported: ${Object.keys(ASSET_MAP).join(", ")}`);
    process.exit(1);
  }

  const url = `https://github.com/${REPO}/releases/download/${version}/${entry.asset}`;
  const binDir = path.resolve(__dirname, "..", "bin");
  const destPath = path.join(binDir, entry.binary);

  fs.mkdirSync(binDir, { recursive: true });

  console.log(`Downloading ${url} ...`);
  await download(url, destPath);

  // Make executable on Unix
  if (platform.startsWith("darwin") || platform.startsWith("linux")) {
    fs.chmodSync(destPath, 0o755);
  }

  const size = fs.statSync(destPath).size;
  console.log(`Saved to ${destPath} (${(size / 1024 / 1024).toFixed(1)} MB)`);
}

/**
 * Download a URL to a local file, following redirects (GitHub releases return
 * 302 redirects to the actual asset URL).
 */
function download(url: string, dest: string, maxRedirects = 5): Promise<void> {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) {
      reject(new Error("Too many redirects"));
      return;
    }

    const get = url.startsWith("https") ? https.get : require("node:http").get;

    get(url, (res: any) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); // consume response to free socket
        download(res.headers.location, dest, maxRedirects - 1)
          .then(resolve)
          .catch(reject);
        return;
      }

      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }

      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on("finish", () => {
        file.close();
        resolve();
      });
      file.on("error", (err: Error) => {
        fs.unlink(dest, () => {}); // cleanup partial file
        reject(err);
      });
    }).on("error", reject);
  });
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  process.exit(1);
});
