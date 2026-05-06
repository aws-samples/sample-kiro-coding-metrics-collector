/**
 * IAM Identity Center 用户查询
 */
const { IdentitystoreClient, ListUsersCommand } = require("@aws-sdk/client-identitystore");

const REGION = process.env.AWS_REGION;
const IDENTITY_STORE_ID = process.env.IDENTITY_STORE_ID;

const client = new IdentitystoreClient({ region: REGION });

/**
 * 获取 IAM Identity Center 中的所有用户
 * 返回: [{ userName, displayName, status, userId }]
 */
async function listIdCUsers() {
  const users = [];
  let nextToken;

  do {
    const resp = await client.send(new ListUsersCommand({
      IdentityStoreId: IDENTITY_STORE_ID,
      ...(nextToken ? { NextToken: nextToken } : {}),
    }));

    for (const u of resp.Users || []) {
      users.push({
        userName: u.UserName || "",
        displayName: u.DisplayName || "",
        status: u.UserStatus || "UNKNOWN",
        userId: u.UserId || "",
      });
    }
    nextToken = resp.NextToken;
  } while (nextToken);

  return users;
}

module.exports = { listIdCUsers };
