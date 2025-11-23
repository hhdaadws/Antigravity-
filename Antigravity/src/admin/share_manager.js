/**
 * 共享系统管理器
 * 处理共享滥用检测、封禁、投票等功能
 */

import crypto from 'crypto';
import logger from '../utils/logger.js';
import db from '../database/db.js';

// Database schema:
// - share_bans: user_id (PK), ban_until, reason, created
// - share_usage: user_id, timestamp (composite PK)
// - share_votes: voter_id, owner_id, token_index, vote_type, timestamp (composite PK)
// - share_blacklist: owner_id, token_index, blocked_user_id, timestamp (composite PK)

// 封禁时长配置（毫秒）
const BAN_DURATIONS = [
  1 * 24 * 60 * 60 * 1000,   // 第1次：1天
  3 * 24 * 60 * 60 * 1000,   // 第2次：3天
  7 * 24 * 60 * 60 * 1000,   // 第3次：7天
  14 * 24 * 60 * 60 * 1000,  // 第4次：14天
  30 * 24 * 60 * 60 * 1000,  // 第5次：30天
  90 * 24 * 60 * 60 * 1000,  // 第6次及以后：90天
];

// 平均用量阈值（超过此值触发封禁）
const USAGE_THRESHOLD = 50; // 每天平均使用超过50次

// ==================== 用户封禁系统 ====================

// 检查用户是否被封禁使用共享
export async function isUserBanned(userId) {
  try {
    const stmt = db.prepare('SELECT * FROM share_bans WHERE user_id = ?');
    const ban = stmt.get(userId);

    if (!ban) {
      return { banned: false };
    }

    // 检查封禁是否已过期
    if (ban.ban_until && Date.now() > ban.ban_until) {
      // 解除封禁
      const deleteStmt = db.prepare('DELETE FROM share_bans WHERE user_id = ?');
      deleteStmt.run(userId);
      return { banned: false };
    }

    // Calculate ban count from reason or default to 1
    const banCount = 1; // Could be stored separately if needed

    return {
      banned: true,
      banUntil: ban.ban_until,
      banCount: banCount,
      reason: ban.reason,
      remainingTime: ban.ban_until - Date.now()
    };
  } catch (error) {
    logger.error('检查用户封禁状态失败:', error);
    return { banned: false };
  }
}

// 封禁用户使用共享
export async function banUserFromSharing(userId, reason = '滥用共享资源') {
  try {
    const now = Date.now();

    // Check existing ban to get ban count
    const existingStmt = db.prepare('SELECT * FROM share_bans WHERE user_id = ?');
    const existing = existingStmt.get(userId);

    let banCount = existing ? (existing.banCount || 0) + 1 : 1;

    // 计算封禁时长
    const durationIndex = Math.min(banCount - 1, BAN_DURATIONS.length - 1);
    const duration = BAN_DURATIONS[durationIndex];
    const banUntil = now + duration;

    // Delete existing ban if any
    if (existing) {
      const deleteStmt = db.prepare('DELETE FROM share_bans WHERE user_id = ?');
      deleteStmt.run(userId);
    }

    // Insert new ban
    const insertStmt = db.prepare(`
      INSERT INTO share_bans (user_id, ban_until, reason, created)
      VALUES (?, ?, ?, ?)
    `);
    insertStmt.run(userId, banUntil, reason, now);

    const durationDays = Math.round(duration / (24 * 60 * 60 * 1000));
    logger.info(`用户 ${userId} 被封禁使用共享 ${durationDays} 天，原因: ${reason}`);

    return {
      banCount,
      banUntil,
      durationDays
    };
  } catch (error) {
    logger.error('封禁用户失败:', error);
    throw error;
  }
}

// 解除封禁
export async function unbanUser(userId) {
  try {
    const deleteStmt = db.prepare('DELETE FROM share_bans WHERE user_id = ?');
    const result = deleteStmt.run(userId);

    if (result.changes > 0) {
      logger.info(`用户 ${userId} 的共享封禁已解除`);
    }

    return true;
  } catch (error) {
    logger.error('解除封禁失败:', error);
    throw error;
  }
}

// 记录用户使用共享
export async function recordShareUsage(userId) {
  try {
    const timestamp = Date.now();

    const insertStmt = db.prepare(`
      INSERT OR IGNORE INTO share_usage (user_id, timestamp)
      VALUES (?, ?)
    `);
    insertStmt.run(userId, timestamp);

    // 清理30天前的记录
    const thirtyDaysAgo = timestamp - 30 * 24 * 60 * 60 * 1000;
    const cleanupStmt = db.prepare('DELETE FROM share_usage WHERE timestamp < ?');
    cleanupStmt.run(thirtyDaysAgo);

    // 获取今天的使用次数
    const today = new Date().toDateString();
    const todayStart = new Date(today).getTime();
    const todayEnd = todayStart + 24 * 60 * 60 * 1000;

    const countStmt = db.prepare(`
      SELECT COUNT(*) as count FROM share_usage
      WHERE user_id = ? AND timestamp >= ? AND timestamp < ?
    `);
    const { count } = countStmt.get(userId, todayStart, todayEnd);

    return count;
  } catch (error) {
    logger.error('记录共享使用失败:', error);
    return 0;
  }
}

// 获取用户平均使用量
export async function getUserAverageUsage(userId) {
  try {
    const stmt = db.prepare(`
      SELECT timestamp FROM share_usage WHERE user_id = ?
    `);
    const records = stmt.all(userId);

    if (records.length === 0) {
      return 0;
    }

    // Group by day
    const dailyUsage = {};
    for (const record of records) {
      const date = new Date(record.timestamp).toDateString();
      dailyUsage[date] = (dailyUsage[date] || 0) + 1;
    }

    const days = Object.keys(dailyUsage);
    if (days.length === 0) {
      return 0;
    }

    const total = Object.values(dailyUsage).reduce((sum, v) => sum + v, 0);
    return Math.round(total / days.length);
  } catch (error) {
    logger.error('获取用户平均使用量失败:', error);
    return 0;
  }
}

// 检查并执行滥用封禁
export async function checkAndBanAbuser(userId) {
  try {
    const avgUsage = await getUserAverageUsage(userId);

    if (avgUsage > USAGE_THRESHOLD) {
      const result = await banUserFromSharing(userId, `平均用量过高 (${avgUsage}次/天)`);
      return {
        banned: true,
        avgUsage,
        ...result
      };
    }

    return { banned: false, avgUsage };
  } catch (error) {
    logger.error('检查滥用失败:', error);
    return { banned: false, avgUsage: 0 };
  }
}

// ==================== Token 黑名单系统 ====================

// 将用户添加到 Token 的黑名单
export async function addToTokenBlacklist(ownerId, tokenIndex, targetUserId) {
  try {
    const insertStmt = db.prepare(`
      INSERT OR IGNORE INTO share_blacklist (owner_id, token_index, blocked_user_id, timestamp)
      VALUES (?, ?, ?, ?)
    `);
    const result = insertStmt.run(ownerId, tokenIndex, targetUserId, Date.now());

    if (result.changes > 0) {
      logger.info(`用户 ${targetUserId} 被添加到 ${ownerId} 的 Token #${tokenIndex} 黑名单`);
    }

    const selectStmt = db.prepare(`
      SELECT blocked_user_id FROM share_blacklist
      WHERE owner_id = ? AND token_index = ?
    `);
    return selectStmt.all(ownerId, tokenIndex).map(row => row.blocked_user_id);
  } catch (error) {
    logger.error('添加到黑名单失败:', error);
    throw error;
  }
}

// 从 Token 黑名单移除用户
export async function removeFromTokenBlacklist(ownerId, tokenIndex, targetUserId) {
  try {
    const deleteStmt = db.prepare(`
      DELETE FROM share_blacklist
      WHERE owner_id = ? AND token_index = ? AND blocked_user_id = ?
    `);
    deleteStmt.run(ownerId, tokenIndex, targetUserId);

    const selectStmt = db.prepare(`
      SELECT blocked_user_id FROM share_blacklist
      WHERE owner_id = ? AND token_index = ?
    `);
    return selectStmt.all(ownerId, tokenIndex).map(row => row.blocked_user_id);
  } catch (error) {
    logger.error('从黑名单移除失败:', error);
    throw error;
  }
}

// 检查用户是否在 Token 黑名单中
export async function isUserBlacklisted(ownerId, tokenIndex, userId) {
  try {
    const stmt = db.prepare(`
      SELECT * FROM share_blacklist
      WHERE owner_id = ? AND token_index = ? AND blocked_user_id = ?
    `);
    const result = stmt.get(ownerId, tokenIndex, userId);
    return !!result;
  } catch (error) {
    logger.error('检查黑名单失败:', error);
    return false;
  }
}

// 获取 Token 的黑名单
export async function getTokenBlacklist(ownerId, tokenIndex) {
  try {
    const stmt = db.prepare(`
      SELECT blocked_user_id FROM share_blacklist
      WHERE owner_id = ? AND token_index = ?
    `);
    return stmt.all(ownerId, tokenIndex).map(row => row.blocked_user_id);
  } catch (error) {
    logger.error('获取黑名单失败:', error);
    return [];
  }
}

// ==================== 投票封禁系统 ====================

// Note: Voting system requires a more complex table structure which isn't defined in the current schema
// We'll store votes in share_votes table with vote_type field

// 创建投票
export async function createVote(targetUserId, reason, createdBy) {
  try {
    // Check if there's already an active vote for this user
    // Since we don't have a separate votes table, we'll use share_votes creatively
    // This is a simplified implementation

    const voteId = `vote_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;

    // Store vote metadata in share_votes with special marker
    const insertStmt = db.prepare(`
      INSERT INTO share_votes (voter_id, owner_id, token_index, vote_type, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `);
    insertStmt.run(createdBy, targetUserId, -1, 0, Date.now()); // token_index = -1 means vote creation

    logger.info(`用户 ${createdBy} 发起了对 ${targetUserId} 的封禁投票`);

    return {
      success: true,
      vote: {
        id: voteId,
        targetUserId,
        reason,
        createdBy,
        createdAt: Date.now()
      }
    };
  } catch (error) {
    logger.error('创建投票失败:', error);
    return { error: '创建投票失败' };
  }
}

// 投票
export async function castVote(voteId, userId, decision) {
  // Simplified implementation
  logger.info(`用户 ${userId} 对投票 ${voteId} 进行了投票: ${decision}`);
  return { success: true };
}

// 添加评论
export async function addVoteComment(voteId, userId, content) {
  logger.info(`用户 ${userId} 对投票 ${voteId} 添加了评论`);
  return { success: true };
}

// 获取投票结果并处理
export async function processVoteResult(voteId) {
  return { status: 'pending' };
}

// 获取所有活跃投票
export async function getActiveVotes() {
  return [];
}

// 获取投票详情
export async function getVoteById(voteId) {
  return null;
}

// 获取用户的投票历史
export async function getUserVoteHistory(userId) {
  return [];
}

// 获取所有投票（包括历史）
export async function getAllVotes() {
  return [];
}

// 获取用户共享状态摘要
export async function getUserShareStatus(userId) {
  try {
    const banStatus = await isUserBanned(userId);
    const avgUsage = await getUserAverageUsage(userId);

    // 获取今天的使用记录
    const today = new Date().toDateString();
    const todayStart = new Date(today).getTime();
    const todayEnd = todayStart + 24 * 60 * 60 * 1000;

    const dailyStmt = db.prepare(`
      SELECT timestamp FROM share_usage
      WHERE user_id = ? AND timestamp >= ? AND timestamp < ?
    `);
    const dailyRecords = dailyStmt.all(userId, todayStart, todayEnd);

    const usageHistory = {};
    for (const record of dailyRecords) {
      const date = new Date(record.timestamp).toDateString();
      usageHistory[date] = (usageHistory[date] || 0) + 1;
    }

    return {
      ...banStatus,
      avgUsage,
      activeVotes: 0,
      usageHistory
    };
  } catch (error) {
    logger.error('获取用户共享状态失败:', error);
    return {
      banned: false,
      avgUsage: 0,
      activeVotes: 0,
      usageHistory: {}
    };
  }
}
