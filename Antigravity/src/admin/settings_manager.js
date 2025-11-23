import fs from 'fs/promises';
import path from 'path';
import logger from '../utils/logger.js';
import { reloadConfig } from '../config/config.js';
import db from '../database/db.js';

const CONFIG_FILE = path.join(process.cwd(), 'config.json');

// 加载设置 - Still reads from config.json for non-DB settings
export async function loadSettings() {
  try {
    const data = await fs.readFile(CONFIG_FILE, 'utf-8');
    const config = JSON.parse(data);

    // Merge with database settings
    const dbSettings = await loadDatabaseSettings();
    return { ...config, ...dbSettings };
  } catch (error) {
    logger.error('读取配置文件失败:', error);
    // 返回默认配置
    return {
      server: { port: 8045, host: '0.0.0.0' },
      api: {
        url: 'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse',
        modelsUrl: 'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels',
        host: 'daily-cloudcode-pa.sandbox.googleapis.com',
        userAgent: 'antigravity/1.11.3 windows/amd64'
      },
      defaults: { temperature: 1, top_p: 0.85, top_k: 50, max_tokens: 8096 },
      security: { maxRequestSize: '50mb', apiKey: 'sk-text', adminPassword: 'admin123' },
      systemInstruction: '你是聊天机器人，专门为用户提供聊天和情绪价值，协助进行小说创作或者角色扮演，也可以提供数学或者代码上的建议'
    };
  }
}

// 从数据库加载设置
async function loadDatabaseSettings() {
  try {
    const stmt = db.prepare('SELECT key, value FROM system_settings');
    const rows = stmt.all();

    const settings = {};
    for (const row of rows) {
      try {
        settings[row.key] = JSON.parse(row.value);
      } catch {
        settings[row.key] = row.value;
      }
    }

    return settings;
  } catch (error) {
    logger.error('从数据库加载设置失败:', error);
    return {};
  }
}

// 保存设置到数据库
async function saveDatabaseSetting(key, value) {
  try {
    const jsonValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
    const timestamp = Date.now();

    const stmt = db.prepare(`
      INSERT OR REPLACE INTO system_settings (key, value, updated_at)
      VALUES (?, ?, ?)
    `);
    stmt.run(key, jsonValue, timestamp);
  } catch (error) {
    logger.error('保存数据库设置失败:', error);
    throw error;
  }
}

// 保存设置
export async function saveSettings(newSettings) {
  try {
    // 读取现有配置
    let config;
    try {
      const data = await fs.readFile(CONFIG_FILE, 'utf-8');
      config = JSON.parse(data);
    } catch {
      config = {};
    }

    // 合并设置
    config.server = config.server || {};
    config.security = config.security || {};
    config.defaults = config.defaults || {};

    // 更新服务器配置
    if (newSettings.server) {
      if (newSettings.server.port !== undefined) {
        config.server.port = parseInt(newSettings.server.port) || config.server.port;
        await saveDatabaseSetting('server.port', config.server.port);
      }
      if (newSettings.server.host !== undefined) {
        config.server.host = newSettings.server.host;
        await saveDatabaseSetting('server.host', config.server.host);
      }
    }

    // 更新安全配置
    if (newSettings.security) {
      // 使用 !== undefined 判断，允许保存空字符串
      if (newSettings.security.apiKey !== undefined) {
        config.security.apiKey = newSettings.security.apiKey;
        await saveDatabaseSetting('security.apiKey', config.security.apiKey);
      }
      if (newSettings.security.adminPassword !== undefined) {
        config.security.adminPassword = newSettings.security.adminPassword;
        await saveDatabaseSetting('security.adminPassword', config.security.adminPassword);
      }
      if (newSettings.security.maxRequestSize !== undefined) {
        config.security.maxRequestSize = newSettings.security.maxRequestSize;
        await saveDatabaseSetting('security.maxRequestSize', config.security.maxRequestSize);
      }
    }

    // 更新默认参数
    if (newSettings.defaults) {
      config.defaults.temperature = parseFloat(newSettings.defaults.temperature) ?? config.defaults.temperature;
      config.defaults.top_p = parseFloat(newSettings.defaults.top_p) ?? config.defaults.top_p;
      config.defaults.top_k = parseInt(newSettings.defaults.top_k) ?? config.defaults.top_k;
      config.defaults.max_tokens = parseInt(newSettings.defaults.max_tokens) ?? config.defaults.max_tokens;

      await saveDatabaseSetting('defaults', config.defaults);
    }

    // 更新系统指令
    if (newSettings.systemInstruction !== undefined) {
      config.systemInstruction = newSettings.systemInstruction;
      await saveDatabaseSetting('systemInstruction', config.systemInstruction);
    }

    // 更新 OAuth 配置
    if (newSettings.oauth) {
      config.oauth = config.oauth || {};
      if (newSettings.oauth.clientId !== undefined) {
        config.oauth.clientId = newSettings.oauth.clientId;
        await saveDatabaseSetting('oauth.clientId', config.oauth.clientId);
      }
      if (newSettings.oauth.clientSecret !== undefined) {
        config.oauth.clientSecret = newSettings.oauth.clientSecret;
        await saveDatabaseSetting('oauth.clientSecret', config.oauth.clientSecret);
      }
    }

    // 写入文件 (for backward compatibility)
    await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
    logger.info('配置文件已保存');

    // 热更新内存中的配置
    reloadConfig();

    return { success: true, message: '设置已保存并生效' };
  } catch (error) {
    logger.error('保存配置文件失败:', error);
    throw new Error('保存配置失败: ' + error.message);
  }
}

// 获取特定设置
export async function getSetting(key) {
  try {
    const stmt = db.prepare('SELECT value FROM system_settings WHERE key = ?');
    const row = stmt.get(key);

    if (!row) {
      return null;
    }

    try {
      return JSON.parse(row.value);
    } catch {
      return row.value;
    }
  } catch (error) {
    logger.error('获取设置失败:', error);
    return null;
  }
}

// 设置特定值
export async function setSetting(key, value) {
  try {
    await saveDatabaseSetting(key, value);
    logger.info(`设置已更新: ${key}`);
    return { success: true };
  } catch (error) {
    logger.error('设置更新失败:', error);
    throw error;
  }
}

// 删除设置
export async function deleteSetting(key) {
  try {
    const stmt = db.prepare('DELETE FROM system_settings WHERE key = ?');
    const result = stmt.run(key);

    if (result.changes > 0) {
      logger.info(`设置已删除: ${key}`);
      return { success: true };
    }

    return { success: false, message: '设置不存在' };
  } catch (error) {
    logger.error('删除设置失败:', error);
    throw error;
  }
}

// 获取所有设置
export async function getAllSettings() {
  try {
    const stmt = db.prepare('SELECT key, value, updated_at FROM system_settings ORDER BY key');
    const rows = stmt.all();

    const settings = {};
    for (const row of rows) {
      try {
        settings[row.key] = {
          value: JSON.parse(row.value),
          updatedAt: row.updated_at
        };
      } catch {
        settings[row.key] = {
          value: row.value,
          updatedAt: row.updated_at
        };
      }
    }

    return settings;
  } catch (error) {
    logger.error('获取所有设置失败:', error);
    return {};
  }
}
