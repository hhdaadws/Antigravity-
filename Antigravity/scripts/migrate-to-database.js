import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

const DATA_DIR = path.join(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'antigravity.db');
const BACKUP_DIR = path.join(DATA_DIR, 'json_backup_' + Date.now());

// 读取JSON文件
function readJSON(filename) {
  try {
    const filePath = path.join(DATA_DIR, filename);
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error(`读取 ${filename} 失败:`, error.message);
  }
  return null;
}

// 备份JSON文件
function backupJSONFiles() {
  console.log('备份JSON文件...');
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }

  const files = fs.readdirSync(DATA_DIR);
  for (const file of files) {
    if (file.endsWith('.json')) {
      const src = path.join(DATA_DIR, file);
      const dest = path.join(BACKUP_DIR, file);
      fs.copyFileSync(src, dest);
      console.log(`  已备份: ${file}`);
    }
  }
  console.log(`JSON文件已备份到: ${BACKUP_DIR}\n`);
}

// 迁移数据
function migrateData() {
  console.log('开始数据迁移...\n');

  // 初始化数据库（会自动创建表结构）
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  // 迁移用户数据
  console.log('迁移用户数据...');
  const users = readJSON('users.json') || [];
  const insertUser = db.prepare(`
    INSERT OR REPLACE INTO users (id, username, password, email, google_id, system_prompt, created, last_login, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertUserApiKey = db.prepare(`
    INSERT OR REPLACE INTO user_api_keys (id, user_id, key, name, created, last_used, requests)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertGoogleToken = db.prepare(`
    INSERT OR REPLACE INTO google_tokens (
      user_id, access_token, refresh_token, expires_in, timestamp, email, enabled,
      is_shared, daily_limit, usage_today, last_reset_date, proxy_id,
      disabled_until, quota_exhausted, total_cost, daily_cost, last_reset_time, total_requests
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const migrateUsers = db.transaction(() => {
    for (const user of users) {
      insertUser.run(
        user.id,
        user.username,
        user.password,
        user.email || null,
        user.googleId || null,
        user.systemPrompt || null,
        user.created,
        user.lastLogin || null,
        user.enabled ? 1 : 0
      );

      // 迁移用户的API密钥
      if (user.apiKeys && Array.isArray(user.apiKeys)) {
        for (const apiKey of user.apiKeys) {
          insertUserApiKey.run(
            apiKey.id,
            user.id,
            apiKey.key,
            apiKey.name,
            apiKey.created,
            apiKey.lastUsed || null,
            apiKey.requests || 0
          );
        }
      }

      // 迁移用户的Google Token
      if (user.googleTokens && Array.isArray(user.googleTokens)) {
        for (const token of user.googleTokens) {
          insertGoogleToken.run(
            user.id,
            token.access_token,
            token.refresh_token || null,
            token.expires_in || 3600,
            token.timestamp || Date.now(),
            token.email || null,
            token.enable !== false ? 1 : 0,
            token.isShared ? 1 : 0,
            token.dailyLimit || 100,
            token.usageToday || 0,
            token.lastResetDate || new Date().toDateString(),
            token.proxyId || null,
            token.disabledUntil || null,
            token.quotaExhausted ? 1 : 0,
            token.totalCost || 0,
            token.dailyCost || 0,
            token.lastResetTime || 0,
            token.totalRequests || 0
          );
        }
      }
    }
  });
  migrateUsers();
  console.log(`  已迁移 ${users.length} 个用户\n`);

  // 迁移管理员Token（accounts.json）
  console.log('迁移管理员Token...');
  const accounts = readJSON('accounts.json') || [];
  const migrateAccounts = db.transaction(() => {
    for (const token of accounts) {
      insertGoogleToken.run(
        null, // user_id为null表示管理员token
        token.access_token,
        token.refresh_token || null,
        token.expires_in || 3600,
        token.timestamp || Date.now(),
        token.email || null,
        token.enable !== false ? 1 : 0,
        0, // 管理员token不共享
        0,
        0,
        new Date().toDateString(),
        token.proxyId || null,
        token.disabledUntil || null,
        token.quotaExhausted ? 1 : 0,
        token.totalCost || 0,
        token.dailyCost || 0,
        token.lastResetTime || 0,
        token.totalRequests || 0
      );
    }
  });
  migrateAccounts();
  console.log(`  已迁移 ${accounts.length} 个管理员Token\n`);

  // 迁移API密钥
  console.log('迁移API密钥...');
  const apiKeys = readJSON('api_keys.json') || [];
  const insertApiKey = db.prepare(`
    INSERT OR REPLACE INTO api_keys (
      key, name, created, last_used, requests,
      rate_limit_enabled, rate_limit_max_requests, rate_limit_window_ms,
      balance, max_balance, total_spent, is_unlimited
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertApiKeyUsage = db.prepare(`
    INSERT OR REPLACE INTO api_key_usage (key, timestamp, count) VALUES (?, ?, ?)
  `);

  const migrateApiKeys = db.transaction(() => {
    for (const key of apiKeys) {
      insertApiKey.run(
        key.key,
        key.name,
        key.created,
        key.lastUsed || null,
        key.requests || 0,
        key.rateLimit?.enabled ? 1 : 0,
        key.rateLimit?.maxRequests || 100,
        key.rateLimit?.windowMs || 60000,
        key.balance || 0,
        key.maxBalance || 10,
        key.totalSpent || 0,
        key.isUnlimited ? 1 : 0
      );

      // 迁移使用记录
      if (key.usage && typeof key.usage === 'object') {
        for (const [timestamp, count] of Object.entries(key.usage)) {
          insertApiKeyUsage.run(key.key, parseInt(timestamp), count);
        }
      }
    }
  });
  migrateApiKeys();
  console.log(`  已迁移 ${apiKeys.length} 个API密钥\n`);

  // 迁移使用日志
  console.log('迁移使用日志...');
  const usageLogs = readJSON('usage_logs.json') || [];
  const insertUsageLog = db.prepare(`
    INSERT OR REPLACE INTO usage_logs (
      id, timestamp, key_id, model, input_tokens, output_tokens, total_tokens,
      cost, input_cost, output_cost, session_id, request_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const migrateUsageLogs = db.transaction(() => {
    for (const log of usageLogs) {
      insertUsageLog.run(
        log.id,
        log.timestamp,
        log.keyId,
        log.model,
        log.inputTokens || 0,
        log.outputTokens || 0,
        log.totalTokens || 0,
        log.cost || 0,
        log.inputCost || 0,
        log.outputCost || 0,
        log.sessionId || null,
        log.requestId || null
      );
    }
  });
  migrateUsageLogs();
  console.log(`  已迁移 ${usageLogs.length} 条使用日志\n`);

  // 迁移应用日志
  console.log('迁移应用日志...');
  const appLogs = readJSON('app_logs.json') || [];
  const insertAppLog = db.prepare(`
    INSERT INTO app_logs (timestamp, level, message, details) VALUES (?, ?, ?, ?)
  `);

  const migrateAppLogs = db.transaction(() => {
    for (const log of appLogs) {
      insertAppLog.run(
        log.timestamp,
        log.level,
        log.message,
        log.details ? JSON.stringify(log.details) : null
      );
    }
  });
  migrateAppLogs();
  console.log(`  已迁移 ${appLogs.length} 条应用日志\n`);

  // 迁移模型数据
  console.log('迁移模型数据...');
  const models = readJSON('models.json') || [];
  const insertModel = db.prepare(`
    INSERT OR REPLACE INTO models (id, name, quota, enabled) VALUES (?, ?, ?, ?)
  `);

  const migrateModels = db.transaction(() => {
    for (const model of models) {
      insertModel.run(
        model.id,
        model.name || model.id,
        model.quota ?? -1,
        model.enabled !== false ? 1 : 0
      );
    }
  });
  migrateModels();
  console.log(`  已迁移 ${models.length} 个模型\n`);

  // 迁移模型使用统计
  console.log('迁移模型使用统计...');
  const modelUsage = readJSON('model_usage.json') || {};
  const insertModelUsage = db.prepare(`
    INSERT OR REPLACE INTO model_usage (model_id, date, usage) VALUES (?, ?, ?)
  `);

  const migrateModelUsage = db.transaction(() => {
    for (const [modelId, usageData] of Object.entries(modelUsage)) {
      if (typeof usageData === 'object') {
        for (const [date, usage] of Object.entries(usageData)) {
          insertModelUsage.run(modelId, date, usage);
        }
      }
    }
  });
  migrateModelUsage();
  console.log(`  已迁移模型使用统计\n`);

  // 迁移定价数据
  console.log('迁移定价数据...');
  const pricing = readJSON('pricing.json') || {};
  const insertPricing = db.prepare(`
    INSERT OR REPLACE INTO pricing (model, input_price, output_price) VALUES (?, ?, ?)
  `);

  const migratePricing = db.transaction(() => {
    for (const [model, prices] of Object.entries(pricing)) {
      insertPricing.run(model, prices.input, prices.output);
    }
  });
  migratePricing();
  console.log(`  已迁移 ${Object.keys(pricing).length} 个定价配置\n`);

  // 迁移代理池
  console.log('迁移代理池...');
  const proxies = readJSON('proxy_pool.json') || [];
  const insertProxy = db.prepare(`
    INSERT OR REPLACE INTO proxies (id, name, type, host, port, username, password, enabled, created)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const migrateProxies = db.transaction(() => {
    for (const proxy of proxies) {
      insertProxy.run(
        proxy.id,
        proxy.name || 'Unnamed Proxy',
        proxy.type || proxy.protocol || 'http',
        proxy.host,
        proxy.port || 8080,
        proxy.username || null,
        proxy.password || null,
        proxy.enabled !== false ? 1 : 0,
        proxy.created || Date.now()
      );
    }
  });
  migrateProxies();
  console.log(`  已迁移 ${proxies.length} 个代理\n`);

  // 迁移共享数据
  console.log('迁移共享数据...');
  const shareData = readJSON('share_data.json') || {};

  const insertShareBan = db.prepare(`
    INSERT OR REPLACE INTO share_bans (user_id, ban_until, reason, created) VALUES (?, ?, ?, ?)
  `);
  const insertShareUsage = db.prepare(`
    INSERT OR REPLACE INTO share_usage (user_id, timestamp) VALUES (?, ?)
  `);
  const insertShareVote = db.prepare(`
    INSERT OR REPLACE INTO share_votes (voter_id, owner_id, token_index, vote_type, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertShareBlacklist = db.prepare(`
    INSERT OR REPLACE INTO share_blacklist (owner_id, token_index, blocked_user_id, timestamp)
    VALUES (?, ?, ?, ?)
  `);

  const migrateShareData = db.transaction(() => {
    // 迁移封禁记录
    if (shareData.bans) {
      for (const [userId, banData] of Object.entries(shareData.bans)) {
        insertShareBan.run(userId, banData.banUntil, banData.reason || null, banData.created || Date.now());
      }
    }

    // 迁移使用记录
    if (shareData.usage && typeof shareData.usage === 'object') {
      for (const [userId, timestamps] of Object.entries(shareData.usage)) {
        if (Array.isArray(timestamps)) {
          for (const timestamp of timestamps) {
            insertShareUsage.run(userId, timestamp);
          }
        }
      }
    }

    // 迁移投票记录
    if (shareData.votes && typeof shareData.votes === 'object') {
      for (const [voterId, votes] of Object.entries(shareData.votes)) {
        if (typeof votes === 'object') {
          for (const [key, voteData] of Object.entries(votes)) {
            const [ownerId, tokenIndex] = key.split('_');
            insertShareVote.run(voterId, ownerId, parseInt(tokenIndex), voteData.type, voteData.timestamp);
          }
        }
      }
    }

    // 迁移黑名单
    if (shareData.blacklists && typeof shareData.blacklists === 'object') {
      for (const [ownerId, tokenBlacklists] of Object.entries(shareData.blacklists)) {
        if (typeof tokenBlacklists === 'object') {
          for (const [tokenIndex, blockedUsers] of Object.entries(tokenBlacklists)) {
            if (Array.isArray(blockedUsers)) {
              for (const blockedUserId of blockedUsers) {
                insertShareBlacklist.run(ownerId, parseInt(tokenIndex), blockedUserId, Date.now());
              }
            }
          }
        }
      }
    }
  });
  migrateShareData();
  console.log('  已迁移共享数据\n');

  db.close();
  console.log('✅ 数据迁移完成！\n');
  console.log(`数据库文件: ${DB_PATH}`);
  console.log(`备份目录: ${BACKUP_DIR}`);
}

// 主函数
function main() {
  console.log('='.repeat(60));
  console.log('数据库迁移工具 - JSON -> SQLite');
  console.log('='.repeat(60));
  console.log();

  // 备份JSON文件
  backupJSONFiles();

  // 迁移数据
  migrateData();

  console.log();
  console.log('说明:');
  console.log('1. 原JSON文件已备份，可以安全删除');
  console.log('2. 应用会自动使用新的数据库');
  console.log('3. 如需回滚，可从备份目录恢复JSON文件');
  console.log();
}

main();
