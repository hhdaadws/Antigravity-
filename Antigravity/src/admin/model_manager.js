import logger from '../utils/logger.js';
import db from '../database/db.js';
import { getAvailableModels } from '../api/client.js';
import fs from 'fs/promises';
import path from 'path';

// 默认模型配置（每日额度）
const DEFAULT_MODEL_QUOTAS = {
  'gemini-2.0-flash-exp': 100,
  'gemini-1.5-flash': 100,
  'gemini-1.5-flash-8b': 150,
  'gemini-1.5-pro': 50,
  'gemini-exp-1206': 30,
  'default': 100  // 未配置模型的默认额度
};

// 读取模型列表
export async function loadModels() {
  try {
    const models = db.prepare('SELECT * FROM models ORDER BY id').all();
    return models;
  } catch (error) {
    logger.error(`加载模型列表失败: ${error.message}`);
    return [];
  }
}

// 自动获取并保存模型
export async function fetchAndSaveModels() {
  try {
    // 使用管理员权限获取模型列表
    const modelsData = await getAvailableModels({ type: 'admin' });

    if (!modelsData || !modelsData.data) {
      throw new Error('获取模型列表失败');
    }

    const stmt = db.prepare(`
      INSERT INTO models (id, name, quota, enabled)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        quota = COALESCE((SELECT quota FROM models WHERE id = excluded.id), excluded.quota)
    `);

    const insert = db.transaction((modelsData) => {
      for (const model of modelsData) {
        stmt.run(
          model.id,
          model.id,
          DEFAULT_MODEL_QUOTAS[model.id] || DEFAULT_MODEL_QUOTAS.default,
          1
        );
      }
    });

    insert(modelsData.data);
    logger.info(`成功获取并保存了 ${modelsData.data.length} 个模型`);

    return await loadModels();
  } catch (error) {
    logger.error(`获取模型失败: ${error.message}`);
    throw error;
  }
}

// 更新模型配额
export async function updateModelQuota(modelId, quota) {
  try {
    const checkStmt = db.prepare('SELECT * FROM models WHERE id = ?');
    const model = checkStmt.get(modelId);

    if (!model) {
      throw new Error('模型不存在');
    }

    const updateStmt = db.prepare('UPDATE models SET quota = ? WHERE id = ?');
    updateStmt.run(quota, modelId);

    logger.info(`更新模型 ${modelId} 配额为 ${quota}`);

    return { ...model, quota };
  } catch (error) {
    logger.error(`更新模型配额失败: ${error.message}`);
    throw error;
  }
}

// 启用/禁用模型
export async function toggleModel(modelId, enabled) {
  try {
    const checkStmt = db.prepare('SELECT * FROM models WHERE id = ?');
    const model = checkStmt.get(modelId);

    if (!model) {
      throw new Error('模型不存在');
    }

    const updateStmt = db.prepare('UPDATE models SET enabled = ? WHERE id = ?');
    updateStmt.run(enabled ? 1 : 0, modelId);

    logger.info(`模型 ${modelId} 已${enabled ? '启用' : '禁用'}`);

    return { ...model, enabled: enabled ? 1 : 0 };
  } catch (error) {
    logger.error(`切换模型状态失败: ${error.message}`);
    throw error;
  }
}

// 记录模型使用
export async function recordModelUsage(userId, modelId) {
  try {
    const today = new Date().toISOString().split('T')[0];

    const stmt = db.prepare(`
      INSERT INTO model_usage (model_id, date, usage)
      VALUES (?, ?, 1)
      ON CONFLICT(model_id, date) DO UPDATE SET
        usage = usage + 1
    `);

    stmt.run(modelId, today);

    const getStmt = db.prepare('SELECT usage FROM model_usage WHERE model_id = ? AND date = ?');
    const result = getStmt.get(modelId, today);

    return result ? result.usage : 1;
  } catch (error) {
    logger.error(`记录模型使用失败: ${error.message}`);
    return 0;
  }
}

// 获取用户今日模型使用情况
export async function getUserModelUsage(userId) {
  try {
    const today = new Date().toISOString().split('T')[0];

    const stmt = db.prepare(`
      SELECT model_id, usage FROM model_usage
      WHERE date = ?
    `);

    const rows = stmt.all(today);
    const usage = {};

    rows.forEach(row => {
      usage[row.model_id] = row.usage;
    });

    return usage;
  } catch (error) {
    logger.error(`获取用户模型使用情况失败: ${error.message}`);
    return {};
  }
}

// 检查用户模型配额
export async function checkModelQuota(userId, modelId) {
  try {
    const modelStmt = db.prepare('SELECT * FROM models WHERE id = ?');
    const model = modelStmt.get(modelId);

    const today = new Date().toISOString().split('T')[0];
    const usageStmt = db.prepare('SELECT usage FROM model_usage WHERE model_id = ? AND date = ?');
    const usageRow = usageStmt.get(modelId, today);
    const used = usageRow ? usageRow.usage : 0;

    if (!model) {
      // 模型不存在，使用默认配额
      const defaultQuota = DEFAULT_MODEL_QUOTAS.default;

      return {
        allowed: used < defaultQuota,
        quota: defaultQuota,
        used,
        remaining: Math.max(0, defaultQuota - used)
      };
    }

    if (!model.enabled) {
      return {
        allowed: false,
        quota: model.quota,
        used,
        remaining: 0,
        error: '该模型已被禁用'
      };
    }

    return {
      allowed: used < model.quota,
      quota: model.quota,
      used,
      remaining: Math.max(0, model.quota - used)
    };
  } catch (error) {
    logger.error(`检查模型配额失败: ${error.message}`);
    return {
      allowed: false,
      quota: 0,
      used: 0,
      remaining: 0,
      error: '检查配额失败'
    };
  }
}

// 获取模型统计信息
export async function getModelStats() {
  try {
    const models = await loadModels();
    const today = new Date().toISOString().split('T')[0];

    const stats = models.map(model => {
      const usageStmt = db.prepare('SELECT COALESCE(usage, 0) as usage FROM model_usage WHERE model_id = ? AND date = ?');
      const usageRow = usageStmt.get(model.id, today);
      const totalUsageToday = usageRow ? usageRow.usage : 0;

      return {
        id: model.id,
        name: model.name,
        quota: model.quota,
        enabled: model.enabled,
        usageToday: totalUsageToday,
        userCount: totalUsageToday > 0 ? 1 : 0  // Simplified - actual user count would require user tracking
      };
    });

    return {
      models: stats,
      totalModels: models.length,
      enabledModels: models.filter(m => m.enabled).length,
      totalUsageToday: stats.reduce((sum, m) => sum + m.usageToday, 0)
    };
  } catch (error) {
    logger.error(`获取模型统计信息失败: ${error.message}`);
    return {
      models: [],
      totalModels: 0,
      enabledModels: 0,
      totalUsageToday: 0
    };
  }
}

// 清理过期使用记录（保留最近30天）
export async function cleanupOldUsage() {
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 30);
    const cutoffDateStr = cutoffDate.toISOString().split('T')[0];

    const countStmt = db.prepare('SELECT COUNT(*) as count FROM model_usage WHERE date < ?');
    const { count: cleaned } = countStmt.get(cutoffDateStr);

    if (cleaned > 0) {
      const deleteStmt = db.prepare('DELETE FROM model_usage WHERE date < ?');
      deleteStmt.run(cutoffDateStr);
      logger.info(`清理了 ${cleaned} 条过期的模型使用记录`);
    }

    return cleaned;
  } catch (error) {
    logger.error(`清理过期使用记录失败: ${error.message}`);
    return 0;
  }
}

// 设置用户特定模型配额（可选功能，覆盖默认配额）
export async function setUserModelQuota(userId, modelId, quota) {
  const USER_QUOTAS_FILE = path.join(process.cwd(), 'data', 'user_model_quotas.json');

  let userQuotas = {};
  try {
    const data = await fs.readFile(USER_QUOTAS_FILE, 'utf-8');
    userQuotas = JSON.parse(data);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  if (!userQuotas[userId]) {
    userQuotas[userId] = {};
  }

  userQuotas[userId][modelId] = quota;

  await fs.writeFile(USER_QUOTAS_FILE, JSON.stringify(userQuotas, null, 2), 'utf-8');
  logger.info(`为用户 ${userId} 设置模型 ${modelId} 配额为 ${quota}`);

  return { userId, modelId, quota };
}

// 获取用户特定模型配额
export async function getUserModelQuota(userId, modelId) {
  const USER_QUOTAS_FILE = path.join(process.cwd(), 'data', 'user_model_quotas.json');

  try {
    const data = await fs.readFile(USER_QUOTAS_FILE, 'utf-8');
    const userQuotas = JSON.parse(data);

    if (userQuotas[userId] && userQuotas[userId][modelId] !== undefined) {
      return userQuotas[userId][modelId];
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  // 返回默认配额
  const models = await loadModels();
  const model = models.find(m => m.id === modelId);
  return model ? model.quota : DEFAULT_MODEL_QUOTAS.default;
}
