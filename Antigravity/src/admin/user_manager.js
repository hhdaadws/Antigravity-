import crypto from 'crypto';
import logger from '../utils/logger.js';
import db from '../database/db.js';
import { cleanupInactiveUsers } from './security_manager.js';
import * as shareManager from './share_manager.js';

// 读取所有用户
export async function loadUsers() {
  try {
    const stmt = db.prepare('SELECT * FROM users');
    const rows = stmt.all();

    // Convert to old format with apiKeys array and googleTokens array
    const users = [];
    for (const row of rows) {
      // Get API keys for this user
      const apiKeysStmt = db.prepare('SELECT * FROM user_api_keys WHERE user_id = ?');
      const apiKeys = apiKeysStmt.all(row.id).map(k => ({
        id: k.id,
        key: k.key,
        name: k.name,
        created: k.created,
        lastUsed: k.last_used,
        requests: k.requests
      }));

      // Get Google tokens for this user
      const tokensStmt = db.prepare('SELECT * FROM google_tokens WHERE user_id = ?');
      const googleTokens = tokensStmt.all(row.id).map(t => ({
        access_token: t.access_token,
        refresh_token: t.refresh_token,
        expires_in: t.expires_in,
        timestamp: t.timestamp,
        email: t.email,
        enable: t.enabled === 1,
        isShared: t.is_shared === 1,
        dailyLimit: t.daily_limit,
        usageToday: t.usage_today,
        lastResetDate: t.last_reset_date
      }));

      users.push({
        id: row.id,
        username: row.username,
        password: row.password,
        email: row.email,
        googleId: row.google_id,
        systemPrompt: row.system_prompt,
        created: row.created,
        lastLogin: row.last_login,
        enabled: row.enabled === 1,
        apiKeys,
        googleTokens
      });
    }

    return users;
  } catch (error) {
    logger.error('加载用户失败:', error);
    return [];
  }
}

// 保存用户 - No longer needed, kept for compatibility
async function saveUsers(users) {
  // This function is kept for backward compatibility with cleanupInactiveUsers
  // But we'll handle the actual deletion in deleteUser
  logger.warn('saveUsers called - this should be handled by individual DB operations');
}

// 生成用户ID
function generateUserId() {
  return 'user_' + crypto.randomBytes(8).toString('hex');
}

// 生成API密钥
function generateApiKey() {
  return 'sk-user-' + crypto.randomBytes(16).toString('hex');
}

// 密码哈希
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

// 验证密码
function verifyPassword(password, storedHash) {
  const [salt, hash] = storedHash.split(':');
  const verifyHash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return hash === verifyHash;
}

// 生成用户会话Token
function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

// 用户注册
export async function registerUser(username, password, email) {
  try {
    // 验证用户名格式
    if (!username || username.length < 3 || username.length > 20) {
      throw new Error('用户名长度必须在3-20个字符之间');
    }

    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      throw new Error('用户名只能包含字母、数字和下划线');
    }

    // 验证密码强度
    if (!password || password.length < 6) {
      throw new Error('密码长度至少6个字符');
    }

    // 验证邮箱格式
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error('邮箱格式不正确');
    }

    // 检查用户名是否已存在
    const existingUserStmt = db.prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?)');
    const existingUser = existingUserStmt.get(username);
    if (existingUser) {
      throw new Error('用户名已被使用');
    }

    // 检查邮箱是否已存在
    if (email) {
      const existingEmailStmt = db.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?)');
      const existingEmail = existingEmailStmt.get(email);
      if (existingEmail) {
        throw new Error('邮箱已被注册');
      }
    }

    // 创建新用户
    const userId = generateUserId();
    const hashedPassword = hashPassword(password);
    const created = Date.now();

    const insertStmt = db.prepare(`
      INSERT INTO users (id, username, password, email, google_id, system_prompt, created, last_login, enabled)
      VALUES (?, ?, ?, ?, NULL, NULL, ?, NULL, 1)
    `);
    insertStmt.run(userId, username, hashedPassword, email || null, created);

    logger.info(`新用户注册: ${username}`);

    return {
      id: userId,
      username: username,
      email: email,
      created: created
    };
  } catch (error) {
    logger.error('用户注册失败:', error);
    throw error;
  }
}

// 用户登录
export async function loginUser(username, password) {
  try {
    const stmt = db.prepare('SELECT * FROM users WHERE LOWER(username) = LOWER(?)');
    const user = stmt.get(username);

    if (!user) {
      throw new Error('用户名或密码错误');
    }

    if (!user.enabled) {
      throw new Error('账号已被禁用');
    }

    if (!verifyPassword(password, user.password)) {
      throw new Error('用户名或密码错误');
    }

    // 更新最后登录时间
    const updateStmt = db.prepare('UPDATE users SET last_login = ? WHERE id = ?');
    updateStmt.run(Date.now(), user.id);

    // 生成会话Token
    const sessionToken = generateSessionToken();

    logger.info(`用户登录: ${username}`);

    return {
      id: user.id,
      username: user.username,
      email: user.email,
      token: sessionToken
    };
  } catch (error) {
    logger.error('用户登录失败:', error);
    throw error;
  }
}

// 获取用户信息
export async function getUserById(userId) {
  try {
    const stmt = db.prepare('SELECT * FROM users WHERE id = ?');
    const user = stmt.get(userId);

    if (!user) {
      return null;
    }

    // Get API keys
    const apiKeysStmt = db.prepare('SELECT * FROM user_api_keys WHERE user_id = ?');
    const apiKeys = apiKeysStmt.all(userId).map(k => ({
      id: k.id,
      key: k.key,
      name: k.name,
      created: k.created,
      lastUsed: k.last_used,
      requests: k.requests
    }));

    return {
      id: user.id,
      username: user.username,
      email: user.email,
      apiKeys: apiKeys,
      systemPrompt: user.system_prompt || null,
      created: user.created,
      lastLogin: user.last_login,
      enabled: user.enabled === 1
    };
  } catch (error) {
    logger.error('获取用户信息失败:', error);
    return null;
  }
}

// 获取用户通过用户名
export async function getUserByUsername(username) {
  try {
    const stmt = db.prepare('SELECT * FROM users WHERE LOWER(username) = LOWER(?)');
    const user = stmt.get(username);

    if (!user) {
      return null;
    }

    // Get API keys
    const apiKeysStmt = db.prepare('SELECT * FROM user_api_keys WHERE user_id = ?');
    const apiKeys = apiKeysStmt.all(user.id).map(k => ({
      id: k.id,
      key: k.key,
      name: k.name,
      created: k.created,
      lastUsed: k.last_used,
      requests: k.requests
    }));

    // Get Google tokens
    const tokensStmt = db.prepare('SELECT * FROM google_tokens WHERE user_id = ?');
    const googleTokens = tokensStmt.all(user.id).map(t => ({
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      expires_in: t.expires_in,
      timestamp: t.timestamp,
      email: t.email,
      enable: t.enabled === 1,
      isShared: t.is_shared === 1,
      dailyLimit: t.daily_limit,
      usageToday: t.usage_today,
      lastResetDate: t.last_reset_date
    }));

    return {
      id: user.id,
      username: user.username,
      password: user.password,
      email: user.email,
      googleId: user.google_id,
      systemPrompt: user.system_prompt,
      created: user.created,
      lastLogin: user.last_login,
      enabled: user.enabled === 1,
      apiKeys,
      googleTokens
    };
  } catch (error) {
    logger.error('获取用户失败:', error);
    return null;
  }
}

// 生成用户API密钥
export async function generateUserApiKey(userId, keyName) {
  try {
    const userStmt = db.prepare('SELECT * FROM users WHERE id = ?');
    const user = userStmt.get(userId);

    if (!user) {
      throw new Error('用户不存在');
    }

    if (!user.enabled) {
      throw new Error('账号已被禁用');
    }

    // 限制每个用户最多5个密钥
    const countStmt = db.prepare('SELECT COUNT(*) as count FROM user_api_keys WHERE user_id = ?');
    const { count } = countStmt.get(userId);

    if (count >= 5) {
      throw new Error('每个用户最多创建5个API密钥');
    }

    const keyId = crypto.randomBytes(8).toString('hex');
    const apiKey = generateApiKey();
    const created = Date.now();

    const insertStmt = db.prepare(`
      INSERT INTO user_api_keys (id, user_id, key, name, created, last_used, requests)
      VALUES (?, ?, ?, ?, ?, NULL, 0)
    `);
    insertStmt.run(keyId, userId, apiKey, keyName || '未命名密钥', created);

    logger.info(`用户 ${user.username} 创建了新密钥: ${keyName}`);

    return {
      id: keyId,
      key: apiKey,
      name: keyName || '未命名密钥',
      created: created,
      lastUsed: null,
      requests: 0
    };
  } catch (error) {
    logger.error('生成API密钥失败:', error);
    throw error;
  }
}

// 删除用户API密钥
export async function deleteUserApiKey(userId, keyId) {
  try {
    const userStmt = db.prepare('SELECT username FROM users WHERE id = ?');
    const user = userStmt.get(userId);

    if (!user) {
      throw new Error('用户不存在');
    }

    const deleteStmt = db.prepare('DELETE FROM user_api_keys WHERE id = ? AND user_id = ?');
    const result = deleteStmt.run(keyId, userId);

    if (result.changes === 0) {
      throw new Error('密钥不存在');
    }

    logger.info(`用户 ${user.username} 删除了密钥: ${keyId}`);

    return true;
  } catch (error) {
    logger.error('删除API密钥失败:', error);
    throw error;
  }
}

// 获取用户所有API密钥
export async function getUserApiKeys(userId) {
  try {
    const userStmt = db.prepare('SELECT id FROM users WHERE id = ?');
    const user = userStmt.get(userId);

    if (!user) {
      throw new Error('用户不存在');
    }

    const keysStmt = db.prepare('SELECT * FROM user_api_keys WHERE user_id = ?');
    const keys = keysStmt.all(userId);

    return keys.map(key => ({
      id: key.id,
      key: key.key,
      name: key.name,
      created: key.created,
      lastUsed: key.last_used,
      requests: key.requests
    }));
  } catch (error) {
    logger.error('获取用户API密钥失败:', error);
    throw error;
  }
}

// 验证用户API密钥
export async function validateUserApiKey(apiKey) {
  try {
    const stmt = db.prepare(`
      SELECT uak.*, u.id as user_id, u.username, u.enabled
      FROM user_api_keys uak
      JOIN users u ON uak.user_id = u.id
      WHERE uak.key = ?
    `);
    const result = stmt.get(apiKey);

    if (!result) {
      return { valid: false };
    }

    if (!result.enabled) {
      return { valid: false };
    }

    // 更新使用统计
    const updateStmt = db.prepare(`
      UPDATE user_api_keys
      SET last_used = ?, requests = requests + 1
      WHERE key = ?
    `);
    updateStmt.run(Date.now(), apiKey);

    return {
      valid: true,
      userId: result.user_id,
      username: result.username,
      keyId: result.id
    };
  } catch (error) {
    logger.error('验证API密钥失败:', error);
    return { valid: false };
  }
}

// 更新用户信息
export async function updateUser(userId, updates) {
  try {
    const userStmt = db.prepare('SELECT * FROM users WHERE id = ?');
    const user = userStmt.get(userId);

    if (!user) {
      throw new Error('用户不存在');
    }

    // 更新允许的字段
    if (updates.email !== undefined) {
      if (updates.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(updates.email)) {
        throw new Error('邮箱格式不正确');
      }
      // 检查邮箱是否已被其他用户使用
      if (updates.email) {
        const existingEmailStmt = db.prepare('SELECT id FROM users WHERE id != ? AND LOWER(email) = LOWER(?)');
        const existingEmail = existingEmailStmt.get(userId, updates.email);
        if (existingEmail) {
          throw new Error('邮箱已被其他用户使用');
        }
      }

      const updateEmailStmt = db.prepare('UPDATE users SET email = ? WHERE id = ?');
      updateEmailStmt.run(updates.email || null, userId);
    }

    if (updates.password) {
      if (updates.password.length < 6) {
        throw new Error('密码长度至少6个字符');
      }
      const hashedPassword = hashPassword(updates.password);
      const updatePasswordStmt = db.prepare('UPDATE users SET password = ? WHERE id = ?');
      updatePasswordStmt.run(hashedPassword, userId);
    }

    if (updates.systemPrompt !== undefined) {
      const updatePromptStmt = db.prepare('UPDATE users SET system_prompt = ? WHERE id = ?');
      updatePromptStmt.run(updates.systemPrompt || null, userId);
    }

    logger.info(`用户 ${user.username} 更新了个人信息`);

    // Get updated user info
    const updatedUser = userStmt.get(userId);
    return {
      id: updatedUser.id,
      username: updatedUser.username,
      email: updatedUser.email,
      systemPrompt: updatedUser.system_prompt
    };
  } catch (error) {
    logger.error('更新用户信息失败:', error);
    throw error;
  }
}

// 删除用户
export async function deleteUser(userId) {
  try {
    const userStmt = db.prepare('SELECT username FROM users WHERE id = ?');
    const user = userStmt.get(userId);

    if (!user) {
      throw new Error('用户不存在');
    }

    // CASCADE will automatically delete related records
    const deleteStmt = db.prepare('DELETE FROM users WHERE id = ?');
    deleteStmt.run(userId);

    logger.info(`用户已删除: ${user.username}`);

    return true;
  } catch (error) {
    logger.error('删除用户失败:', error);
    throw error;
  }
}

// 获取用户统计
export async function getUserStats() {
  try {
    const totalStmt = db.prepare('SELECT COUNT(*) as count FROM users');
    const enabledStmt = db.prepare('SELECT COUNT(*) as count FROM users WHERE enabled = 1');
    const disabledStmt = db.prepare('SELECT COUNT(*) as count FROM users WHERE enabled = 0');
    const keysStmt = db.prepare('SELECT COUNT(*) as count FROM user_api_keys');

    return {
      total: totalStmt.get().count,
      enabled: enabledStmt.get().count,
      disabled: disabledStmt.get().count,
      totalKeys: keysStmt.get().count
    };
  } catch (error) {
    logger.error('获取用户统计失败:', error);
    return { total: 0, enabled: 0, disabled: 0, totalKeys: 0 };
  }
}

// 获取所有用户（管理员用）
export async function getAllUsers() {
  try {
    const stmt = db.prepare('SELECT * FROM users');
    const users = stmt.all();

    const result = [];
    for (const user of users) {
      const countStmt = db.prepare('SELECT COUNT(*) as count FROM user_api_keys WHERE user_id = ?');
      const { count } = countStmt.get(user.id);

      result.push({
        id: user.id,
        username: user.username,
        email: user.email,
        apiKeysCount: count,
        created: user.created,
        lastLogin: user.last_login,
        enabled: user.enabled === 1
      });
    }

    return result;
  } catch (error) {
    logger.error('获取所有用户失败:', error);
    return [];
  }
}

// 启用/禁用用户（管理员用）
export async function toggleUserStatus(userId, enabled) {
  try {
    const userStmt = db.prepare('SELECT username FROM users WHERE id = ?');
    const user = userStmt.get(userId);

    if (!user) {
      throw new Error('用户不存在');
    }

    const updateStmt = db.prepare('UPDATE users SET enabled = ? WHERE id = ?');
    updateStmt.run(enabled ? 1 : 0, userId);

    logger.info(`用户 ${user.username} 已${enabled ? '启用' : '禁用'}`);

    return true;
  } catch (error) {
    logger.error('切换用户状态失败:', error);
    throw error;
  }
}

// Google OAuth 登录/注册
export async function loginOrRegisterWithGoogle(googleUser) {
  try {
    const { email, name } = googleUser;

    if (!email) {
      throw new Error('无法获取 Google 账号邮箱');
    }

    // 查找是否存在该邮箱的用户
    const stmt = db.prepare('SELECT * FROM users WHERE LOWER(email) = LOWER(?)');
    let user = stmt.get(email);

    if (user) {
      // 已存在用户，检查是否启用
      if (!user.enabled) {
        throw new Error('账号已被禁用');
      }

      // 更新最后登录时间
      const updateStmt = db.prepare('UPDATE users SET last_login = ? WHERE id = ?');
      updateStmt.run(Date.now(), user.id);

      logger.info(`用户通过 Google 登录: ${user.username}`);

      return {
        id: user.id,
        username: user.username,
        email: user.email,
        isNewUser: false
      };
    } else {
      // 创建新用户
      // 使用邮箱前缀作为用户名，确保唯一性
      let baseUsername = email.split('@')[0].replace(/[^a-zA-Z0-9_]/g, '_');
      let username = baseUsername;
      let counter = 1;

      // 确保用户名唯一
      const checkStmt = db.prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?)');
      while (checkStmt.get(username)) {
        username = `${baseUsername}${counter}`;
        counter++;
      }

      // 生成随机密码（用户可以之后在设置中修改）
      const randomPassword = crypto.randomBytes(16).toString('hex');
      const userId = generateUserId();
      const hashedPassword = hashPassword(randomPassword);
      const created = Date.now();

      const insertStmt = db.prepare(`
        INSERT INTO users (id, username, password, email, google_id, system_prompt, created, last_login, enabled)
        VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 1)
      `);
      insertStmt.run(userId, username, hashedPassword, email, googleUser.id, created, created);

      logger.info(`新用户通过 Google 注册: ${username} (${email})`);

      return {
        id: userId,
        username: username,
        email: email,
        isNewUser: true
      };
    }
  } catch (error) {
    logger.error('Google登录/注册失败:', error);
    throw error;
  }
}

// 获取用户的 Google Tokens
export async function getUserTokens(userId) {
  try {
    const userStmt = db.prepare('SELECT id FROM users WHERE id = ?');
    const user = userStmt.get(userId);

    if (!user) {
      throw new Error('用户不存在');
    }

    const tokensStmt = db.prepare('SELECT * FROM google_tokens WHERE user_id = ?');
    const tokens = tokensStmt.all(userId);

    return tokens.map(t => ({
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      expires_in: t.expires_in,
      timestamp: t.timestamp,
      email: t.email,
      enable: t.enabled === 1,
      isShared: t.is_shared === 1,
      dailyLimit: t.daily_limit,
      usageToday: t.usage_today,
      lastResetDate: t.last_reset_date
    }));
  } catch (error) {
    logger.error('获取用户Tokens失败:', error);
    throw error;
  }
}

// 添加用户 Google Token
export async function addUserToken(userId, tokenData) {
  try {
    const userStmt = db.prepare('SELECT * FROM users WHERE id = ?');
    const user = userStmt.get(userId);

    if (!user) {
      throw new Error('用户不存在');
    }

    if (!user.enabled) {
      throw new Error('账号已被禁用');
    }

    // 限制每个用户最多添加10个 Token
    const countStmt = db.prepare('SELECT COUNT(*) as count FROM google_tokens WHERE user_id = ?');
    const { count } = countStmt.get(userId);

    if (count >= 10) {
      throw new Error('每个用户最多添加10个 Token');
    }

    const insertStmt = db.prepare(`
      INSERT INTO google_tokens (
        user_id, access_token, refresh_token, expires_in, timestamp, email,
        enabled, is_shared, daily_limit, usage_today, last_reset_date
      ) VALUES (?, ?, ?, ?, ?, ?, 1, 0, 100, 0, ?)
    `);

    const result = insertStmt.run(
      userId,
      tokenData.access_token,
      tokenData.refresh_token || null,
      tokenData.expires_in || 3600,
      Date.now(),
      tokenData.email || null,
      new Date().toDateString()
    );

    logger.info(`用户 ${user.username} 添加了新 Token`);

    return { success: true, index: result.lastInsertRowid - 1 };
  } catch (error) {
    logger.error('添加用户Token失败:', error);
    throw error;
  }
}

// 删除用户 Google Token
export async function deleteUserToken(userId, tokenIndex) {
  try {
    const userStmt = db.prepare('SELECT username FROM users WHERE id = ?');
    const user = userStmt.get(userId);

    if (!user) {
      throw new Error('用户不存在');
    }

    // Get all tokens for user to find the one at tokenIndex
    const tokensStmt = db.prepare('SELECT id FROM google_tokens WHERE user_id = ? ORDER BY id');
    const tokens = tokensStmt.all(userId);

    if (tokenIndex < 0 || tokenIndex >= tokens.length) {
      throw new Error('Token 不存在');
    }

    const tokenId = tokens[tokenIndex].id;
    const deleteStmt = db.prepare('DELETE FROM google_tokens WHERE id = ?');
    deleteStmt.run(tokenId);

    logger.info(`用户 ${user.username} 删除了 Token #${tokenIndex}`);

    return { success: true };
  } catch (error) {
    logger.error('删除用户Token失败:', error);
    throw error;
  }
}

// 获取用户的随机可用 Token（用于 API 调用）
export async function getUserAvailableToken(userId) {
  try {
    const stmt = db.prepare('SELECT * FROM google_tokens WHERE user_id = ? AND enabled = 1');
    const tokens = stmt.all(userId);

    if (tokens.length === 0) {
      return null;
    }

    // 随机返回一个
    const randomIndex = Math.floor(Math.random() * tokens.length);
    const token = tokens[randomIndex];

    return {
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      expires_in: token.expires_in,
      enable: true
    };
  } catch (error) {
    logger.error('获取可用Token失败:', error);
    return null;
  }
}

// 定期清理未登录账号任务
let cleanupTimer = null;

export function startInactiveUsersCleanup() {
  // 每天清理一次（24小时）
  const cleanupInterval = 24 * 60 * 60 * 1000;

  async function performCleanup() {
    try {
      logger.info('开始清理长时间未登录账号...');
      const users = await loadUsers();
      const result = await cleanupInactiveUsers(users);

      if (result.deletedCount > 0) {
        // Delete users from database
        for (const deletedUser of result.deletedUsers) {
          const user = users.find(u => u.username === deletedUser.username);
          if (user) {
            await deleteUser(user.id);
          }
        }
        logger.info(`已清理 ${result.deletedCount} 个长时间未登录账号`);
      } else {
        logger.info('没有需要清理的账号');
      }
    } catch (error) {
      logger.error('清理账号失败:', error.message);
    }
  }

  // 立即执行一次
  performCleanup();

  // 设置定时器
  cleanupTimer = setInterval(performCleanup, cleanupInterval);
  logger.info('账号自动清理任务已启动（每24小时执行一次）');
}

export function stopInactiveUsersCleanup() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
    logger.info('账号自动清理任务已停止');
  }
}

// ========== Token 共享功能 ==========

// 更新 Token 共享设置
export async function updateTokenSharing(userId, tokenIndex, sharingSettings) {
  try {
    const userStmt = db.prepare('SELECT username FROM users WHERE id = ?');
    const user = userStmt.get(userId);

    if (!user) {
      throw new Error('用户不存在');
    }

    // Get all tokens for user to find the one at tokenIndex
    const tokensStmt = db.prepare('SELECT id FROM google_tokens WHERE user_id = ? ORDER BY id');
    const tokens = tokensStmt.all(userId);

    if (tokenIndex < 0 || tokenIndex >= tokens.length) {
      throw new Error('Token 不存在');
    }

    const tokenId = tokens[tokenIndex].id;

    // Build update query dynamically
    const updates = [];
    const values = [];

    if (sharingSettings.isShared !== undefined) {
      updates.push('is_shared = ?');
      values.push(sharingSettings.isShared ? 1 : 0);
    }

    if (sharingSettings.dailyLimit !== undefined) {
      const limit = Math.max(1, Math.min(10000, parseInt(sharingSettings.dailyLimit)));
      updates.push('daily_limit = ?');
      values.push(limit);
    }

    if (updates.length > 0) {
      values.push(tokenId);
      const updateStmt = db.prepare(`UPDATE google_tokens SET ${updates.join(', ')} WHERE id = ?`);
      updateStmt.run(...values);
    }

    // Get updated token
    const getTokenStmt = db.prepare('SELECT * FROM google_tokens WHERE id = ?');
    const token = getTokenStmt.get(tokenId);

    logger.info(`用户 ${user.username} 更新了 Token #${tokenIndex} 的共享设置: ${token.is_shared ? '已共享' : '未共享'}, 限制: ${token.daily_limit}/天`);

    return {
      success: true,
      token: {
        isShared: token.is_shared === 1,
        dailyLimit: token.daily_limit
      }
    };
  } catch (error) {
    logger.error('更新Token共享设置失败:', error);
    throw error;
  }
}

// 获取所有共享的 Token（来自所有用户）
export async function getAllSharedTokens() {
  try {
    const stmt = db.prepare(`
      SELECT gt.*, u.id as user_id, u.username, u.enabled as user_enabled
      FROM google_tokens gt
      JOIN users u ON gt.user_id = u.id
      WHERE gt.is_shared = 1 AND gt.enabled = 1 AND u.enabled = 1
    `);
    const tokens = stmt.all();

    const today = new Date().toDateString();
    const sharedTokens = [];

    for (const token of tokens) {
      // 检查是否需要重置每日使用次数
      if (token.last_reset_date !== today) {
        const updateStmt = db.prepare('UPDATE google_tokens SET usage_today = 0, last_reset_date = ? WHERE id = ?');
        updateStmt.run(today, token.id);
        token.usage_today = 0;
        token.last_reset_date = today;
      }

      // Get token index for this user
      const indexStmt = db.prepare('SELECT id FROM google_tokens WHERE user_id = ? ORDER BY id');
      const userTokens = indexStmt.all(token.user_id);
      const tokenIndex = userTokens.findIndex(t => t.id === token.id);

      sharedTokens.push({
        userId: token.user_id,
        username: token.username,
        tokenIndex: tokenIndex,
        email: token.email,
        dailyLimit: token.daily_limit,
        usageToday: token.usage_today,
        remainingToday: token.daily_limit - token.usage_today,
        timestamp: token.timestamp,
        token: {
          access_token: token.access_token,
          refresh_token: token.refresh_token,
          expires_in: token.expires_in,
          timestamp: token.timestamp,
          email: token.email,
          enable: true,
          isShared: true,
          dailyLimit: token.daily_limit,
          usageToday: token.usage_today,
          lastResetDate: token.last_reset_date
        }
      });
    }

    return sharedTokens;
  } catch (error) {
    logger.error('获取共享Tokens失败:', error);
    return [];
  }
}

// 获取随机可用的共享 Token（带封禁和黑名单检查）
export async function getRandomSharedToken(callerId = null) {
  try {
    // 检查调用者是否被封禁
    if (callerId) {
      const banStatus = await shareManager.isUserBanned(callerId);
      if (banStatus.banned) {
        logger.info(`用户 ${callerId} 被封禁使用共享，剩余时间: ${Math.round(banStatus.remainingTime / 3600000)}小时`);
        return {
          error: 'banned',
          banned: true,
          banUntil: banStatus.banUntil,
          remainingTime: banStatus.remainingTime,
          reason: banStatus.reason
        };
      }
    }

    const today = new Date().toDateString();
    const stmt = db.prepare(`
      SELECT gt.*, u.id as user_id, u.username
      FROM google_tokens gt
      JOIN users u ON gt.user_id = u.id
      WHERE gt.is_shared = 1 AND gt.enabled = 1 AND u.enabled = 1
    `);
    const tokens = stmt.all();

    const availableTokens = [];

    for (const token of tokens) {
      // 检查调用者是否在该 Token 的黑名单中
      if (callerId) {
        // Get token index
        const indexStmt = db.prepare('SELECT id FROM google_tokens WHERE user_id = ? ORDER BY id');
        const userTokens = indexStmt.all(token.user_id);
        const tokenIndex = userTokens.findIndex(t => t.id === token.id);

        const isBlacklisted = await shareManager.isUserBlacklisted(token.user_id, tokenIndex, callerId);
        if (isBlacklisted) {
          continue; // 跳过这个 Token
        }
      }

      // 重置每日使用次数
      if (token.last_reset_date !== today) {
        const updateStmt = db.prepare('UPDATE google_tokens SET usage_today = 0, last_reset_date = ? WHERE id = ?');
        updateStmt.run(today, token.id);
        token.usage_today = 0;
        token.last_reset_date = today;
      }

      // 检查是否还有剩余使用次数
      if (token.usage_today < token.daily_limit) {
        availableTokens.push(token);
      }
    }

    if (availableTokens.length === 0) {
      return null;
    }

    // 随机选择一个
    const randomIndex = Math.floor(Math.random() * availableTokens.length);
    const selected = availableTokens[randomIndex];

    // 增加使用次数
    const updateStmt = db.prepare('UPDATE google_tokens SET usage_today = usage_today + 1 WHERE id = ?');
    updateStmt.run(selected.id);
    selected.usage_today++;

    // 记录共享使用并检查滥用
    if (callerId) {
      await shareManager.recordShareUsage(callerId);
      // 异步检查是否需要封禁（不阻塞当前请求）
      shareManager.checkAndBanAbuser(callerId).catch(err =>
        logger.error('检查滥用失败:', err)
      );
    }

    logger.info(`共享 Token 被使用: ${selected.username} 的 Token (今日: ${selected.usage_today}/${selected.daily_limit})`);

    return {
      access_token: selected.access_token,
      refresh_token: selected.refresh_token,
      expires_in: selected.expires_in,
      email: selected.email,
      owner: selected.username,
      ownerId: selected.user_id,
      usageToday: selected.usage_today,
      dailyLimit: selected.daily_limit
    };
  } catch (error) {
    logger.error('获取随机共享Token失败:', error);
    return null;
  }
}

// 获取共享统计信息
export async function getSharedTokenStats() {
  try {
    const sharedTokens = await getAllSharedTokens();

    const totalShared = sharedTokens.length;
    const totalAvailable = sharedTokens.filter(t => t.remainingToday > 0).length;
    const totalUsageToday = sharedTokens.reduce((sum, t) => sum + t.usageToday, 0);
    const totalLimitToday = sharedTokens.reduce((sum, t) => sum + t.dailyLimit, 0);

    return {
      totalShared,
      totalAvailable,
      totalUsageToday,
      totalLimitToday,
      remainingToday: totalLimitToday - totalUsageToday,
      tokens: sharedTokens.map(t => ({
        username: t.username,
        email: t.email,
        usageToday: t.usageToday,
        dailyLimit: t.dailyLimit,
        remainingToday: t.remainingToday
      }))
    };
  } catch (error) {
    logger.error('获取共享统计失败:', error);
    return {
      totalShared: 0,
      totalAvailable: 0,
      totalUsageToday: 0,
      totalLimitToday: 0,
      remainingToday: 0,
      tokens: []
    };
  }
}

// 获取用户或共享 Token（用于 API 调用）
export async function getUserOrSharedToken(userId) {
  // 首先尝试使用用户自己的 Token
  const userToken = await getUserAvailableToken(userId);
  if (userToken) {
    logger.info(`使用用户自己的 Token: userId=${userId}`);
    return userToken;
  }

  // 如果用户没有可用 Token，使用共享池
  const sharedToken = await getRandomSharedToken();
  if (sharedToken) {
    logger.info(`用户 ${userId} 使用共享 Token: owner=${sharedToken.owner}`);
    return sharedToken;
  }

  // 没有任何可用 Token
  return null;
}
