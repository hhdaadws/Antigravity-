import { log } from '../utils/logger.js';
import proxyManager from '../admin/proxy_manager.js';
import db from '../database/db.js';

const CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const CLIENT_SECRET = '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';

class TokenManager {
  constructor() {
    this.tokens = [];
    this.lastLoadTime = 0;
    this.loadInterval = 60000; // 1分钟内不重复加载

    // 轮询机制
    this.currentTokenIndex = 0; // 轮询索引

    // 使用统计
    this.usageStats = new Map(); // refresh_token -> { requests, lastUsed }

    this.loadTokens();

    // 启动定时任务
    this.startQuotaResetCheck();
  }

  loadTokens(force = false) {
    try {
      // 避免频繁加载，1分钟内使用缓存（除非强制刷新）
      if (!force && Date.now() - this.lastLoadTime < this.loadInterval && this.tokens.length > 0) {
        return;
      }

      log.info('正在加载token...');

      // Query admin tokens from database (user_id IS NULL and enabled = 1)
      const stmt = db.prepare('SELECT * FROM google_tokens WHERE user_id IS NULL AND enabled = 1');
      const rows = stmt.all();

      // Map database columns (snake_case) to object properties (camelCase)
      this.tokens = rows.map(row => ({
        access_token: row.access_token,
        refresh_token: row.refresh_token,
        expires_in: row.expires_in,
        timestamp: row.timestamp,
        email: row.email,
        enable: row.enabled === 1,
        proxyId: row.proxy_id,
        disabledUntil: row.disabled_until,
        quotaExhausted: row.quota_exhausted === 1,
        totalCost: row.total_cost || 0,
        dailyCost: row.daily_cost || 0,
        lastResetTime: row.last_reset_time || 0,
        totalRequests: row.total_requests || 0,
        // Store database ID for updates
        _dbId: row.id
      }));

      this.lastLoadTime = Date.now();
      log.info(`成功加载 ${this.tokens.length} 个可用token`);

      // 触发垃圾回收（如果可用）
      if (global.gc) {
        global.gc();
      }
    } catch (error) {
      log.error('加载token失败:', error.message);
      this.tokens = [];
    }
  }

  // 强制重新加载token（绕过缓存）
  forceReload() {
    this.loadTokens(true);
  }

  isExpired(token) {
    if (!token.timestamp || !token.expires_in) return true;
    const expiresAt = token.timestamp + (token.expires_in * 1000);
    // 提前30秒判断过期，减少不必要的刷新请求
    return Date.now() >= expiresAt - 30000;
  }

  async refreshToken(token) {
    log.info('正在刷新token...');
    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: token.refresh_token
    });

    // 获取代理配置
    const fetchOptions = {
      method: 'POST',
      headers: {
        'Host': 'oauth2.googleapis.com',
        'User-Agent': 'Go-http-client/1.1',
        'Content-Length': body.toString().length.toString(),
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept-Encoding': 'gzip'
      },
      body: body.toString()
    };

    // 如果token配置了代理，使用代理
    if (token.proxyId) {
      const proxy = proxyManager.getProxyById(token.proxyId);
      if (proxy && proxy.enabled) {
        const agent = await proxyManager.createProxyAgent(proxy);
        if (agent) {
          fetchOptions.agent = agent;
          log.info(`使用代理: ${proxy.name}`);
        }
      }
    }

    const response = await fetch('https://oauth2.googleapis.com/token', fetchOptions);

    if (response.ok) {
      const data = await response.json();
      token.access_token = data.access_token;
      token.expires_in = data.expires_in;
      token.timestamp = Date.now();
      this.saveToDatabase(token);
      return token;
    } else {
      throw { statusCode: response.status, message: await response.text() };
    }
  }

  saveToDatabase(token) {
    try {
      log.info(`[DEBUG] saveToDatabase 开始 - refresh_token: ${token?.refresh_token?.substring(0, 20)}...`);

      if (!token._dbId) {
        log.error('[DEBUG] saveToDatabase - token 缺少 _dbId');
        return;
      }

      // Update token in database
      const stmt = db.prepare(`
        UPDATE google_tokens
        SET access_token = ?,
            expires_in = ?,
            timestamp = ?,
            proxy_id = ?,
            disabled_until = ?,
            quota_exhausted = ?,
            total_cost = ?,
            daily_cost = ?,
            last_reset_time = ?,
            total_requests = ?,
            enabled = ?
        WHERE id = ?
      `);

      stmt.run(
        token.access_token,
        token.expires_in,
        token.timestamp,
        token.proxyId || null,
        token.disabledUntil || null,
        token.quotaExhausted ? 1 : 0,
        token.totalCost || 0,
        token.dailyCost || 0,
        token.lastResetTime || 0,
        token.totalRequests || 0,
        token.enable !== false ? 1 : 0,
        token._dbId
      );

      log.info(`[DEBUG] saveToDatabase 完成 - dailyCost: ${token.dailyCost}, totalCost: ${token.totalCost}`);
    } catch (error) {
      log.error('保存数据库失败:', error.message);
      log.error('[DEBUG] saveToDatabase 错误堆栈:', error.stack);
    }
  }

  // ========== 粘性会话机制 ==========

  /**
   * 检查 token 是否因配额耗尽而被禁用
   */
  isTokenDisabledByQuota(token) {
    return token.disabledUntil && Date.now() < token.disabledUntil;
  }

  // ========== 配额管理 ==========

  /**
   * 将 token 禁用到指定时间（配额重置时间）
   */
  disableTokenUntil(token, resetTime) {
    token.disabledUntil = resetTime;
    token.quotaExhausted = true; // 标记为配额耗尽
    this.saveToDatabase(token);

    const resetDate = new Date(resetTime);
    log.warn(`⏸️  Token 因配额耗尽被禁用，将在 ${resetDate.toLocaleString()} 自动恢复`);
  }

  /**
   * 永久禁用 token
   */
  disableToken(token) {
    log.warn(`❌ 永久禁用 token`);
    token.enable = false;
    delete token.disabledUntil;
    delete token.quotaExhausted;
    this.saveToDatabase(token);
    this.loadTokens(true); // 强制刷新
  }

  /**
   * 定时检查并恢复配额已重置的 token
   */
  startQuotaResetCheck() {
    setInterval(() => {
      const now = Date.now();

      try {
        // Update tokens where disabled_until has passed
        const stmt = db.prepare(`
          UPDATE google_tokens
          SET disabled_until = NULL,
              quota_exhausted = 0
          WHERE user_id IS NULL
            AND disabled_until IS NOT NULL
            AND disabled_until <= ?
        `);

        const result = stmt.run(now);
        const restoredCount = result.changes;

        if (restoredCount > 0) {
          this.loadTokens(true);
          log.info(`✅ 恢复了 ${restoredCount} 个配额已重置的 token`);
        }
      } catch (error) {
        log.error('配额重置检查失败:', error.message);
      }
    }, 60000); // 每分钟检查一次
  }

  /**
   * 处理请求错误（检测配额耗尽）
   */
  async handleRequestError(error, token) {
    // 配额耗尽错误
    if (error.statusCode === 429 || (error.message && error.message.includes('quota'))) {
      log.warn(`🚫 Token 配额耗尽: ${error.message}`);

      // 禁用到明天UTC 0点重置
      const tomorrow = new Date();
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      tomorrow.setUTCHours(0, 0, 0, 0);

      this.disableTokenUntil(token, tomorrow.getTime());

      // 返回下一个可用的 token
      return await this.getNextToken();
    }

    // 403 错误 - 永久禁用
    if (error.statusCode === 403) {
      log.warn(`🚫 Token 遇到 403 错误，永久禁用`);
      this.disableToken(token);

      // 返回下一个可用的 token
      return await this.getNextToken();
    }

    // 400 错误 - 模型权限不足
    if (error.statusCode === 400) {
      log.warn(`🚫 Token 无权访问该模型，永久禁用`);
      this.disableToken(token);

      // 返回下一个可用的 token
      return await this.getNextToken();
    }

    throw error;
  }

  // ========== 统计和监控 ==========

  /**
   * 记录 Token 费用使用情况
   * @param {Object} token - Token对象
   * @param {number} cost - 产生的费用(美元)
   */
  addUsage(token, cost) {
    try {
      log.info(`[DEBUG] addUsage 被调用 - cost: ${cost}, refresh_token: ${token?.refresh_token?.substring(0, 20)}...`);

      // 在内存中找到最新的 token 对象引用
      const found = this.tokens.find(t => t.refresh_token === token.refresh_token);
      if (!found) {
        log.warn(`[DEBUG] addUsage - 未找到匹配的 token! tokens数组长度: ${this.tokens.length}`);
        return;
      }

      log.info(`[DEBUG] addUsage - 找到 token, 当前 dailyCost: ${found.dailyCost}, totalCost: ${found.totalCost}`);

      // 初始化统计字段
      found.totalCost = found.totalCost || 0;
      found.dailyCost = found.dailyCost || 0;
      found.lastResetTime = found.lastResetTime || 0;
      found.totalRequests = (found.totalRequests || 0) + 1;

      // 检查是否需要每日重置 (每天0点)
      const now = new Date();
      const lastReset = new Date(found.lastResetTime);
      
      // 简单比较日期字符串，不同则意味着跨天
      if (now.toDateString() !== lastReset.toDateString()) {
        found.dailyCost = 0;
        // found.dailyRequests = 0; // 如果需要可以添加
        found.lastResetTime = now.getTime();
      }

      // 更新费用
      found.totalCost += cost;
      found.dailyCost += cost;

      log.info(`[DEBUG] addUsage - 更新后 dailyCost: ${found.dailyCost}, totalCost: ${found.totalCost}`);

      this.saveToDatabase(found);
      log.info(`[DEBUG] addUsage - saveToDatabase 已调用`);
    } catch (error) {
      log.error('记录token费用失败:', error.message);
      log.error('[DEBUG] addUsage 错误堆栈:', error.stack);
    }
  }

  /**
   * 记录 Token 使用
   */
  recordUsage(token) {
    const key = token.refresh_token;
    if (!this.usageStats.has(key)) {
      this.usageStats.set(key, { requests: 0, lastUsed: null });
    }
    const stats = this.usageStats.get(key);
    stats.requests++;
    stats.lastUsed = Date.now();
  }

  /**
   * 获取单个 Token 的请求次数
   */
  getTokenRequests(token) {
    const stats = this.usageStats.get(token.refresh_token);
    return stats ? stats.requests : 0;
  }

  /**
   * 获取所有 Token 的使用统计
   */
  getUsageStats() {
    const stats = [];
    this.tokens.forEach((token, index) => {
      const usage = this.usageStats.get(token.refresh_token) || { requests: 0, lastUsed: null };

      stats.push({
        index,
        requests: usage.requests,
        lastUsed: usage.lastUsed ? new Date(usage.lastUsed).toISOString() : null,
        enabled: token.enable !== false,
        quotaExhausted: !!token.quotaExhausted,
        disabledUntil: token.disabledUntil ? new Date(token.disabledUntil).toISOString() : null
      });
    });
    return {
      totalTokens: this.tokens.length,
      availableTokens: this.tokens.filter(t => t.enable !== false && !this.isTokenDisabledByQuota(t)).length,
      totalRequests: Array.from(this.usageStats.values()).reduce((sum, s) => sum + s.requests, 0),
      tokens: stats
    };
  }

  /**
   * 获取任何一个可用的 token（不管是否被占用）
   * 用于轻量级操作，如获取模型列表
   * @returns {Promise<Object>} - Token对象
   */
  async getAnyEnabledToken() {
    await this.loadTokens();

    // 查找第一个启用且未因配额耗尽而被禁用的 token
    for (const token of this.tokens) {
      if (token.enable !== false && !this.isTokenDisabledByQuota(token)) {
        // 刷新 token 如果需要
        if (this.isExpired(token)) {
          await this.refreshToken(token);
        }
        return token;
      }
    }

    throw new Error('No enabled tokens available.');
  }

  /**
   * 使用轮询方式获取下一个可用的 token
   * @returns {Promise<Object>} - Token对象
   */
  async getNextToken() {
    await this.loadTokens();

    if (this.tokens.length === 0) {
      throw new Error('No tokens available.');
    }

    // 过滤出可用的 token（启用且未因配额耗尽而被禁用）
    const availableTokens = this.tokens.filter(token =>
      token.enable !== false && !this.isTokenDisabledByQuota(token)
    );

    if (availableTokens.length === 0) {
      throw new Error('No enabled tokens available.');
    }

    // 轮询选择下一个 token
    const token = availableTokens[this.currentTokenIndex % availableTokens.length];
    this.currentTokenIndex++;

    // 如果索引太大，重置为0避免溢出
    if (this.currentTokenIndex > 10000) {
      this.currentTokenIndex = 0;
    }

    // 刷新 token 如果需要
    if (this.isExpired(token)) {
      await this.refreshToken(token);
    }

    // 记录使用统计
    this.recordUsage(token);

    const tokenInfo = this.tokens.findIndex(t => t.refresh_token === token.refresh_token);
    log.info(`🔄 轮询选择 Token #${tokenInfo} (总请求: ${this.getTokenRequests(token)})`);

    return token;
  }

  disableCurrentToken(token) {
    const found = this.tokens.find(t => t.access_token === token.access_token);
    if (found) {
      this.disableToken(found);
    }
  }
}

const tokenManager = new TokenManager();
export default tokenManager;
