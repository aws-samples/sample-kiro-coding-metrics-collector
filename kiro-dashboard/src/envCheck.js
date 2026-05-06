/**
 * 环境变量检查 — 启动时验证所有必须的环境变量已配置。
 * 缺少任何一个都会打印错误并退出进程。
 */

const REQUIRED_ENV = [
  { name: "AWS_REGION",            desc: "AWS 区域（如 us-east-1）" },
  { name: "IDENTITY_STORE_ID",     desc: "IAM Identity Center Identity Store ID（如 d-xxx）" },
  { name: "KIRO_S3_BUCKET",        desc: "Kiro User Activity Report 的 S3 桶名" },
  { name: "KIRO_S3_PREFIX",        desc: "S3 桶中的前缀路径（如 kiro-logs/）" },
  { name: "KIRO_ACCOUNT_ID",       desc: "AWS 账号 ID" },
  { name: "AWS_ACCESS_KEY_ID",     desc: "AWS Access Key ID" },
  { name: "AWS_SECRET_ACCESS_KEY", desc: "AWS Secret Access Key" },
];

function checkEnv() {
  const missing = REQUIRED_ENV.filter((e) => !process.env[e.name]);

  if (missing.length > 0) {
    console.error("\n[ERROR] 以下必须的环境变量未配置:\n");
    for (const e of missing) {
      console.error(`  ${e.name}  — ${e.desc}`);
    }
    console.error("\n示例:");
    console.error("  export AWS_REGION=us-east-1");
    console.error("  export IDENTITY_STORE_ID=d-xxx");
    console.error("  export KIRO_S3_BUCKET=xxx");
    console.error("  export KIRO_S3_PREFIX=xxx/");
    console.error("  export KIRO_ACCOUNT_ID=xxx");
    console.error("  export AWS_ACCESS_KEY_ID=xxx");
    console.error("  export AWS_SECRET_ACCESS_KEY=xxx\n");
    process.exit(1);
  }

  console.log("[env] All required environment variables OK:");
  for (const e of REQUIRED_ENV) {
    const val = process.env[e.name];
    // 对敏感值只显示前 4 位
    const display = e.name.includes("SECRET") ? val.slice(0, 4) + "****" : val;
    console.log(`  ${e.name}=${display}`);
  }
}

module.exports = { checkEnv };
