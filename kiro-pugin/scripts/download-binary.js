"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const https = __importStar(require("node:https"));
const REPO = "git-ai-project/git-ai";
/** Map VS Code platform target to GitHub release asset name. */
const ASSET_MAP = {
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
function download(url, dest, maxRedirects = 5) {
    return new Promise((resolve, reject) => {
        if (maxRedirects <= 0) {
            reject(new Error("Too many redirects"));
            return;
        }
        const get = url.startsWith("https") ? https.get : require("node:http").get;
        get(url, (res) => {
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
            file.on("error", (err) => {
                fs.unlink(dest, () => { }); // cleanup partial file
                reject(err);
            });
        }).on("error", reject);
    });
}
main().catch((err) => {
    console.error("Error:", err.message || err);
    process.exit(1);
});
//# sourceMappingURL=download-binary.js.map