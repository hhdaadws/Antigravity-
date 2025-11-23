import crypto from 'crypto';
import db from '../database/db.js';
import logger from '../utils/logger.js';

// 生成随机 API 密钥
function generateApiKey() {
  return 'sk-' + crypto.randomBytes(32).toString('hex');
}

// 加载所有密钥
export async function loadKeys() {
  try {
    const stmt = db.prepare(`
      SELECT
        key, name, created, last_used, requests,
        rate_limit_enabled, rate_limit_max_requests, rate_limit_window_ms,
        balance, max_balance, total_spent, is_unlimited
      FROM api_keys
      ORDER BY created DESC
    `);
    const rows = stmt.all();

    return rows.map(row => ({
      key: row.key,
      name: row.name,
      created: row.created,
      lastUsed: row.last_used,
      requests: row.requests,
      rateLimit: {
        enabled: row.rate_limit_enabled === 1,
        maxRequests: row.rate_limit_max_requests,
        windowMs: row.rate_limit_window_ms
      },
      usage: {},  // 使用记录从 api_key_usage 表获取
      balance: row.balance,
      maxBalance: row.max_balance,
      totalSpent: row.total_spent,
      isUnlimited: row.is_unlimited === 1
    }));
  } catch (error) {
    logger.error('加载密钥失败:', error.message);
    return [];
  }
}

// 创建新密钥
export async function createKey(name = '未命名', rateLimit = null, maxBalance = null) {
  const key = generateApiKey();
  const now = new Date().toISOString();

  try {
    const stmt = db.prepare(`
      INSERT INTO api_keys (
        key, name, created, last_used, requests,
        rate_limit_enabled, rate_limit_max_requests, rate_limit_window_ms,
        balance, max_balance, total_spent, is_unlimited
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const rl = rateLimit || { enabled: false, maxRequests: 100, windowMs: 60000 };
    const isUnlimited = maxBalance === null || maxBalance === -1;
    const actualMaxBalance = isUnlimited ? -1 : (maxBalance || 10);
    const actualBalance = isUnlimited ? 0 : actualMaxBalance;

    stmt.run(
      key,
      name,
      now,
      null,
      0,
      rl.enabled ? 1 : 0,
      rl.maxRequests,
      rl.windowMs,
      actualBalance,
      actualMaxBalance,
      0,
      isUnlimited ? 1 : 0
    );

    logger.info(`新密钥已创建: ${name}, 额度: ${isUnlimited ? '无限' : '$' + actualMaxBalance}`);

    return {
      key,
      name,
      created: now,
      lastUsed: null,
      requests: 0,
      rateLimit: rl,
      usage: {},
      balance: actualBalance,
      maxBalance: actualMaxBalance,
      totalSpent: 0,
      isUnlimited
    };
  } catch (error) {
    logger.error('创建密钥失败:', error.message);
    throw error;
  }
}

// 删除密钥
export async function deleteKey(keyToDelete) {
  try {
    const stmt = db.prepare('DELETE FROM api_keys WHERE key = ?');
    const result = stmt.run(keyToDelete);

    if (result.changes === 0) {
      throw new Error('密钥不存在');
    }

    logger.info(`密钥已删除: ${keyToDelete.substring(0, 10)}...`);
    return true;
  } catch (error) {
    logger.error('删除密钥失败:', error.message);
    throw error;
  }
}

// 验证密钥
export async function validateKey(keyToCheck) {
  try {
    const stmt = db.prepare('SELECT key FROM api_keys WHERE key = ?');
    const key = stmt.get(keyToCheck);

    if (key) {
      // 更新使用信息
      const updateStmt = db.prepare(`
        UPDATE api_keys
        SET last_used = ?, requests = requests + 1
        WHERE key = ?
      `);
      updateStmt.run(new Date().toISOString(), keyToCheck);
      return true;
    }
    return false;
  } catch (error) {
    logger.error('验证密钥失败:', error.message);
    return false;
  }
}

// 获取密钥统计
export async function getKeyStats() {
  try {
    const stmt = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN last_used IS NOT NULL THEN 1 ELSE 0 END) as active,
        SUM(requests) as totalRequests
      FROM api_keys
    `);
    const stats = stmt.get();

    return {
      total: stats.total,
      active: stats.active,
      totalRequests: stats.totalRequests || 0
    };
  } catch (error) {
    logger.error('获取密钥统计失败:', error.message);
    return { total: 0, active: 0, totalRequests: 0 };
  }
}

// 更新密钥频率限制
export async function updateKeyRateLimit(keyToUpdate, rateLimit) {
  try {
    const stmt = db.prepare(`
      UPDATE api_keys
      SET rate_limit_enabled = ?,
          rate_limit_max_requests = ?,
          rate_limit_window_ms = ?
      WHERE key = ?
    `);

    const result = stmt.run(
      rateLimit.enabled ? 1 : 0,
      rateLimit.maxRequests,
      rateLimit.windowMs,
      keyToUpdate
    );

    if (result.changes === 0) {
      throw new Error('密钥不存在');
    }

    logger.info(`密钥频率限制已更新: ${keyToUpdate.substring(0, 10)}...`);

    const key = await getKey(keyToUpdate);
    return key;
  } catch (error) {
    logger.error('更新频率限制失败:', error.message);
    throw error;
  }
}

// 检查频率限制
export async function checkRateLimit(keyToCheck) {
  try {
    const keyStmt = db.prepare(`
      SELECT rate_limit_enabled, rate_limit_max_requests, rate_limit_window_ms
      FROM api_keys WHERE key = ?
    `);
    const key = keyStmt.get(keyToCheck);

    if (!key) {
      return { allowed: false, error: '密钥不存在' };
    }

    // 如果未启用频率限制，直接允许
    if (!key.rate_limit_enabled) {
      return { allowed: true };
    }

    const now = Date.now();
    const windowMs = key.rate_limit_window_ms || 60000;
    const maxRequests = key.rate_limit_max_requests || 100;
    const cutoffTime = now - windowMs;

    // 清理过期记录
    const cleanupStmt = db.prepare('DELETE FROM api_key_usage WHERE key = ? AND timestamp < ?');
    cleanupStmt.run(keyToCheck, cutoffTime);

    // 计算当前时间窗口内的请求数
    const countStmt = db.prepare(`
      SELECT SUM(count) as total
      FROM api_key_usage
      WHERE key = ? AND timestamp >= ?
    `);
    const usage = countStmt.get(keyToCheck, cutoffTime);
    const requestCount = usage.total || 0;

    // 检查是否超过限制
    if (requestCount >= maxRequests) {
      const minTimeStmt = db.prepare(`
        SELECT MIN(timestamp) as minTime
        FROM api_key_usage
        WHERE key = ?
      `);
      const minTime = minTimeStmt.get(keyToCheck);
      const resetTime = (minTime.minTime || now) + windowMs;
      const waitSeconds = Math.ceil((resetTime - now) / 1000);

      return {
        allowed: false,
        error: '请求频率超限',
        resetIn: waitSeconds,
        limit: maxRequests,
        remaining: 0
      };
    }

    // 记录本次请求
    const minute = Math.floor(now / 10000) * 10000; // 按10秒分组
    const insertStmt = db.prepare(`
      INSERT INTO api_key_usage (key, timestamp, count)
      VALUES (?, ?, 1)
      ON CONFLICT(key, timestamp)
      DO UPDATE SET count = count + 1
    `);
    insertStmt.run(keyToCheck, minute);

    return {
      allowed: true,
      limit: maxRequests,
      remaining: maxRequests - requestCount - 1
    };
  } catch (error) {
    logger.error('检查频率限制失败:', error.message);
    return { allowed: false, error: '系统错误' };
  }
}

// ========== 计费相关功能 ==========

// 根据key获取完整信息
export async function getKey(keyToFind) {
  try {
    const stmt = db.prepare(`
      SELECT
        key, name, created, last_used, requests,
        rate_limit_enabled, rate_limit_max_requests, rate_limit_window_ms,
        balance, max_balance, total_spent, is_unlimited
      FROM api_keys WHERE key = ?
    `);
    const row = stmt.get(keyToFind);

    if (!row) return null;

    return {
      key: row.key,
      name: row.name,
      created: row.created,
      lastUsed: row.last_used,
      requests: row.requests,
      rateLimit: {
        enabled: row.rate_limit_enabled === 1,
        maxRequests: row.rate_limit_max_requests,
        windowMs: row.rate_limit_window_ms
      },
      usage: {},
      balance: row.balance,
      maxBalance: row.max_balance,
      totalSpent: row.total_spent,
      isUnlimited: row.is_unlimited === 1
    };
  } catch (error) {
    logger.error('获取密钥失败:', error.message);
    return null;
  }
}

// 检查余额是否足够
export async function checkBalance(keyToCheck) {
  const key = await getKey(keyToCheck);
  if (!key) {
    return { allowed: false, error: '密钥不存在' };
  }

  // 无限额度的key直接允许
  if (key.isUnlimited) {
    return { allowed: true, unlimited: true };
  }

  // 检查余额是否充足
  if (key.balance <= 0) {
    return {
      allowed: false,
      error: '余额不足',
      balance: key.balance,
      maxBalance: key.maxBalance
    };
  }

  return {
    allowed: true,
    balance: key.balance,
    maxBalance: key.maxBalance
  };
}

// 扣除余额
export async function deductBalance(keyToUpdate, amount) {
  try {
    const key = await getKey(keyToUpdate);
    if (!key) {
      throw new Error('密钥不存在');
    }

    // 无限额度的key不扣费
    if (key.isUnlimited) {
      return key;
    }

    const stmt = db.prepare(`
      UPDATE api_keys
      SET balance = MAX(0, balance - ?),
          total_spent = total_spent + ?
      WHERE key = ?
    `);
    stmt.run(amount, amount, keyToUpdate);

    return await getKey(keyToUpdate);
  } catch (error) {
    logger.error('扣除余额失败:', error.message);
    throw error;
  }
}

// 充值（增加余额）
export async function addBalance(keyToUpdate, amount) {
  try {
    const key = await getKey(keyToUpdate);
    if (!key) {
      throw new Error('密钥不存在');
    }

    const stmt = db.prepare(`
      UPDATE api_keys
      SET balance = MIN(max_balance, balance + ?)
      WHERE key = ?
    `);
    stmt.run(amount, keyToUpdate);

    logger.info(`密钥 ${keyToUpdate.substring(0, 10)}... 已充值 $${amount}`);
    return await getKey(keyToUpdate);
  } catch (error) {
    logger.error('充值失败:', error.message);
    throw error;
  }
}

// 更新密钥余额上限
export async function updateKeyBalance(keyToUpdate, maxBalance) {
  try {
    const key = await getKey(keyToUpdate);
    if (!key) {
      throw new Error('密钥不存在');
    }

    const isUnlimited = maxBalance === null || maxBalance === -1;
    const actualMaxBalance = isUnlimited ? -1 : maxBalance;

    const stmt = db.prepare(`
      UPDATE api_keys
      SET max_balance = ?,
          is_unlimited = ?,
          balance = CASE
            WHEN ? = 1 THEN 0  -- 无限额度，余额设为0
            WHEN ? > max_balance THEN MIN(?, balance + (? - max_balance))  -- 新上限更高，补充余额
            WHEN ? < balance THEN ?  -- 新上限更低，限制当前余额
            ELSE balance
          END
      WHERE key = ?
    `);

    stmt.run(
      actualMaxBalance,
      isUnlimited ? 1 : 0,
      isUnlimited ? 1 : 0,
      actualMaxBalance,
      actualMaxBalance,
      actualMaxBalance,
      actualMaxBalance,
      actualMaxBalance,
      keyToUpdate
    );

    logger.info(`密钥 ${keyToUpdate.substring(0, 10)}... 额度已更新: ${isUnlimited ? '无限' : '$' + actualMaxBalance}`);
    return await getKey(keyToUpdate);
  } catch (error) {
    logger.error('更新余额上限失败:', error.message);
    throw error;
  }
}
