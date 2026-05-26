// Scan Kiro Agent Dir for all workspace-hash/414d* directories
// Usage: node scripts/scan-agent-dir.js
const fs = require("fs");
const path = require("path");

const agentDir = path.join(
  process.env.APPDATA,
  "Kiro", "User", "globalStorage", "kiro.kiroagent"
);

console.log("Agent Dir:", agentDir);
console.log("");

const entries = fs.readdirSync(agentDir);
const skip = new Set([
  "workspace-sessions", "sessions", "default",
  "dev_data", "index", ".diffs", ".migrations", ".utils"
]);

for (const hash of entries) {
  if (skip.has(hash) || hash.startsWith(".")) continue;
  const hashPath = path.join(agentDir, hash);
  try {
    if (!fs.statSync(hashPath).isDirectory()) continue;
  } catch { continue; }

  const subs = fs.readdirSync(hashPath).filter(s => s.startsWith("414d"));
  for (const sub of subs) {
    const subPath = path.join(hashPath, sub);
    try {
      if (!fs.statSync(subPath).isDirectory()) continue;
    } catch { continue; }

    const files = fs.readdirSync(subPath);
    const recent = files
      .map(f => {
        try {
          const st = fs.statSync(path.join(subPath, f));
          return { name: f, mtime: st.mtimeMs };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 3);

    console.log(hash + "/" + sub + " (" + files.length + " files)");
    for (const f of recent) {
      console.log("  " + f.name + "  " + new Date(f.mtime).toISOString());
    }
    console.log("");
  }
}
