/**
 * Copy the locally-built git-ai binary from the Cargo release output
 * into the extension's bin/ directory.
 *
 * Automatically detects the current platform and picks the correct
 * binary name (git-ai / git-ai.exe).
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const isWindows = os.platform() === "win32";
const binaryName = isWindows ? "git-ai.exe" : "git-ai";

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const src = path.join(repoRoot, "target", "release", binaryName);
const destDir = path.join(__dirname, "..", "bin");
const dest = path.join(destDir, binaryName);

if (!fs.existsSync(src)) {
  console.error(`ERROR: Compiled binary not found at ${src}`);
  console.error("Make sure 'cargo build --release' completed successfully.");
  process.exit(1);
}

fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(src, dest);

if (!isWindows) {
  fs.chmodSync(dest, 0o755);
}

const sizeMB = (fs.statSync(dest).size / 1024 / 1024).toFixed(1);
console.log(`Copied ${src} -> ${dest} (${sizeMB} MB)`);
