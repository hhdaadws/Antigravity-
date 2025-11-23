import logger from '../utils/logger.js';
import db from '../database/db.js';

// 代理池管理类
class ProxyManager {
  constructor() {
    this.proxyPool = [];
    this.loadProxyPool();
  }

  // 加载代理池
  async loadProxyPool() {
    try {
      const stmt = db.prepare('SELECT * FROM proxies ORDER BY id');
      this.proxyPool = stmt.all().map(row => ({
        id: row.id,
        name: row.name,
        protocol: row.type,
        host: row.host,
        port: row.port,
        username: row.username,
        password: row.password,
        enabled: row.enabled === 1,
        created: row.created,
        lastTested: null,
        testStatus: null
      }));
      logger.info(`成功加载 ${this.proxyPool.length} 个代理`);
    } catch (error) {
      logger.error('加载代理池失败:', error.message);
      this.proxyPool = [];
    }
  }

  // 保存代理池 - Not needed anymore
  async saveProxyPool() {
    logger.warn('saveProxyPool called - this should be handled by individual DB operations');
  }

  // 获取所有代理
  getAllProxies() {
    // Reload from database to get latest data
    const stmt = db.prepare('SELECT * FROM proxies ORDER BY id');
    return stmt.all().map(row => ({
      id: row.id,
      name: row.name,
      protocol: row.type,
      host: row.host,
      port: row.port,
      username: row.username,
      password: row.password,
      enabled: row.enabled === 1,
      created: row.created,
      lastTested: null,
      testStatus: null
    }));
  }

  // 添加代理
  async addProxy(proxyConfig) {
    try {
      const id = Date.now().toString();
      const created = new Date().toISOString();

      const insertStmt = db.prepare(`
        INSERT INTO proxies (id, name, type, host, port, username, password, enabled, created)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      insertStmt.run(
        id,
        proxyConfig.name || '未命名代理',
        proxyConfig.protocol || 'socks5',
        proxyConfig.host,
        proxyConfig.port,
        proxyConfig.username || null,
        proxyConfig.password || null,
        proxyConfig.enabled !== false ? 1 : 0,
        created
      );

      const proxy = {
        id,
        name: proxyConfig.name || '未命名代理',
        protocol: proxyConfig.protocol || 'socks5',
        host: proxyConfig.host,
        port: proxyConfig.port,
        username: proxyConfig.username || null,
        password: proxyConfig.password || null,
        enabled: proxyConfig.enabled !== false,
        created,
        lastTested: null,
        testStatus: null
      };

      this.proxyPool.push(proxy);
      logger.info(`代理已添加: ${proxy.name} (${proxy.host}:${proxy.port})`);
      return proxy;
    } catch (error) {
      logger.error('添加代理失败:', error);
      throw error;
    }
  }

  // 更新代理
  async updateProxy(id, updates) {
    try {
      const stmt = db.prepare('SELECT * FROM proxies WHERE id = ?');
      const existing = stmt.get(id);

      if (!existing) {
        throw new Error('代理不存在');
      }

      // Build update query dynamically
      const fields = [];
      const values = [];

      if (updates.name !== undefined) {
        fields.push('name = ?');
        values.push(updates.name);
      }
      if (updates.protocol !== undefined) {
        fields.push('type = ?');
        values.push(updates.protocol);
      }
      if (updates.host !== undefined) {
        fields.push('host = ?');
        values.push(updates.host);
      }
      if (updates.port !== undefined) {
        fields.push('port = ?');
        values.push(updates.port);
      }
      if (updates.username !== undefined) {
        fields.push('username = ?');
        values.push(updates.username);
      }
      if (updates.password !== undefined) {
        fields.push('password = ?');
        values.push(updates.password);
      }
      if (updates.enabled !== undefined) {
        fields.push('enabled = ?');
        values.push(updates.enabled ? 1 : 0);
      }

      if (fields.length > 0) {
        values.push(id);
        const updateStmt = db.prepare(`UPDATE proxies SET ${fields.join(', ')} WHERE id = ?`);
        updateStmt.run(...values);
      }

      // Get updated proxy
      const updated = stmt.get(id);
      const proxy = {
        id: updated.id,
        name: updated.name,
        protocol: updated.type,
        host: updated.host,
        port: updated.port,
        username: updated.username,
        password: updated.password,
        enabled: updated.enabled === 1,
        created: updated.created,
        lastTested: null,
        testStatus: null
      };

      // Update in memory pool
      const index = this.proxyPool.findIndex(p => p.id === id);
      if (index !== -1) {
        this.proxyPool[index] = proxy;
      }

      logger.info(`代理已更新: ${id}`);
      return proxy;
    } catch (error) {
      logger.error('更新代理失败:', error);
      throw error;
    }
  }

  // 删除代理
  async deleteProxy(id) {
    try {
      const stmt = db.prepare('SELECT * FROM proxies WHERE id = ?');
      const proxy = stmt.get(id);

      if (!proxy) {
        throw new Error('代理不存在');
      }

      const deleteStmt = db.prepare('DELETE FROM proxies WHERE id = ?');
      deleteStmt.run(id);

      // Remove from memory pool
      const index = this.proxyPool.findIndex(p => p.id === id);
      if (index !== -1) {
        this.proxyPool.splice(index, 1);
      }

      logger.info(`代理已删除: ${proxy.name}`);
      return {
        id: proxy.id,
        name: proxy.name,
        protocol: proxy.type,
        host: proxy.host,
        port: proxy.port
      };
    } catch (error) {
      logger.error('删除代理失败:', error);
      throw error;
    }
  }

  // 根据ID获取代理
  getProxyById(id) {
    try {
      const stmt = db.prepare('SELECT * FROM proxies WHERE id = ?');
      const proxy = stmt.get(id);

      if (!proxy) {
        return null;
      }

      return {
        id: proxy.id,
        name: proxy.name,
        protocol: proxy.type,
        host: proxy.host,
        port: proxy.port,
        username: proxy.username,
        password: proxy.password,
        enabled: proxy.enabled === 1,
        created: proxy.created,
        lastTested: null,
        testStatus: null
      };
    } catch (error) {
      logger.error('获取代理失败:', error);
      return null;
    }
  }

  // 创建代理Agent
  async createProxyAgent(proxyConfig) {
    if (!proxyConfig || !proxyConfig.enabled) {
      return null;
    }

    const { protocol, host, port, username, password } = proxyConfig;

    let proxyUrl;
    if (username && password) {
      proxyUrl = `${protocol}://${username}:${password}@${host}:${port}`;
    } else {
      proxyUrl = `${protocol}://${host}:${port}`;
    }

    try {
      if (protocol === 'socks5' || protocol === 'socks4') {
        // 动态导入socks-proxy-agent
        const { SocksProxyAgent } = await import('socks-proxy-agent');
        return new SocksProxyAgent(proxyUrl);
      } else if (protocol === 'http' || protocol === 'https') {
        // HTTP代理使用内置的代理支持
        return null; // 稍后在fetch中处理
      } else {
        logger.warn(`不支持的代理协议: ${protocol}`);
        return null;
      }
    } catch (error) {
      logger.error('创建代理Agent失败:', error.message);
      return null;
    }
  }

  // 测试代理连接
  async testProxy(proxyConfig) {
    const startTime = Date.now();

    try {
      const agent = await this.createProxyAgent(proxyConfig);
      const testUrl = 'https://www.google.com';

      const fetchOptions = {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0'
        },
        timeout: 10000 // 10秒超时
      };

      if (agent) {
        fetchOptions.agent = agent;
      }

      const response = await fetch(testUrl, fetchOptions);
      const latency = Date.now() - startTime;

      const result = {
        success: response.ok,
        status: response.status,
        latency: latency,
        message: response.ok ? '连接成功' : `HTTP ${response.status}`,
        timestamp: new Date().toISOString()
      };

      // Update proxy test status in database
      if (proxyConfig.id) {
        await this.updateProxy(proxyConfig.id, {
          lastTested: result.timestamp,
          testStatus: result.success ? 'success' : 'failed'
        });
      }

      return result;
    } catch (error) {
      const latency = Date.now() - startTime;

      const result = {
        success: false,
        status: 0,
        latency: latency,
        message: error.message,
        timestamp: new Date().toISOString()
      };

      // Update proxy test status in database
      if (proxyConfig.id) {
        try {
          await this.updateProxy(proxyConfig.id, {
            lastTested: result.timestamp,
            testStatus: 'failed'
          });
        } catch (e) {
          // 忽略更新错误
        }
      }

      return result;
    }
  }

  // 批量测试所有代理
  async testAllProxies() {
    const results = [];
    const proxies = this.getAllProxies();

    for (const proxy of proxies) {
      if (proxy.enabled) {
        const result = await this.testProxy(proxy);
        results.push({
          id: proxy.id,
          name: proxy.name,
          ...result
        });
      } else {
        results.push({
          id: proxy.id,
          name: proxy.name,
          success: false,
          message: '代理已禁用',
          latency: 0
        });
      }
    }
    return results;
  }
}

const proxyManager = new ProxyManager();
export default proxyManager;
