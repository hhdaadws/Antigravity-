import logger from '../utils/logger.js';
import db from '../database/db.js';
import { getModelPricing } from './pricing_manager.js';

// 加载使用日志
export async function loadUsageLogs() {
  try {
    const logs = db.prepare('SELECT * FROM usage_logs ORDER BY timestamp DESC').all();
    return logs;
  } catch (error) {
    logger.error(`加载使用日志失败: ${error.message}`);
    return [];
  }
}

// 计算费用（使用动态定价配置）
export async function calculateCost(model, inputTokens, outputTokens) {
  const pricing = await getModelPricing(model);
  const inputCost = (inputTokens / 1000000) * pricing.input;
  const outputCost = (outputTokens / 1000000) * pricing.output;
  const totalCost = inputCost + outputCost;

  return {
    inputCost: parseFloat(inputCost.toFixed(6)),
    outputCost: parseFloat(outputCost.toFixed(6)),
    totalCost: parseFloat(totalCost.toFixed(6))
  };
}

// 记录使用日志
export async function logUsage(keyId, model, inputTokens, outputTokens, sessionId = null, requestId = null) {
  try {
    const cost = await calculateCost(model, inputTokens, outputTokens);

    const logEntry = {
      id: `log_${Date.now()}_${Math.random().toString(36).substring(7)}`,
      timestamp: new Date().toISOString(),
      key_id: keyId,
      model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      cost: cost.totalCost,
      input_cost: cost.inputCost,
      output_cost: cost.outputCost,
      session_id: sessionId,
      request_id: requestId
    };

    const stmt = db.prepare(`
      INSERT INTO usage_logs (id, timestamp, key_id, model, input_tokens, output_tokens, total_tokens, cost, input_cost, output_cost, session_id, request_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      logEntry.id,
      logEntry.timestamp,
      logEntry.key_id,
      logEntry.model,
      logEntry.input_tokens,
      logEntry.output_tokens,
      logEntry.total_tokens,
      logEntry.cost,
      logEntry.input_cost,
      logEntry.output_cost,
      logEntry.session_id,
      logEntry.request_id
    );

    logger.info(`记录消费: Key ${keyId.substring(0, 10)}..., 模型: ${model}, Token: ${inputTokens}+${outputTokens}, 费用: $${cost.totalCost.toFixed(6)}`);

    return logEntry;
  } catch (error) {
    logger.error(`记录使用日志失败: ${error.message}`);
    throw error;
  }
}

// 根据API key查询使用日志
export async function getUsageByKey(keyId, limit = 100, offset = 0) {
  try {
    const logsStmt = db.prepare(`
      SELECT * FROM usage_logs
      WHERE key_id = ?
      ORDER BY timestamp DESC
      LIMIT ? OFFSET ?
    `);
    const logs = logsStmt.all(keyId, limit, offset);

    const countStmt = db.prepare('SELECT COUNT(*) as count, COALESCE(SUM(cost), 0) as totalCost FROM usage_logs WHERE key_id = ?');
    const { count, totalCost } = countStmt.get(keyId);

    return {
      logs,
      total: count,
      totalCost: totalCost || 0
    };
  } catch (error) {
    logger.error(`查询使用日志失败: ${error.message}`);
    throw error;
  }
}

// 获取API key的使用统计
export async function getUsageStats(keyId) {
  try {
    const stmt = db.prepare(`
      SELECT
        COUNT(*) as totalRequests,
        COALESCE(SUM(input_tokens), 0) as totalInputTokens,
        COALESCE(SUM(output_tokens), 0) as totalOutputTokens,
        COALESCE(SUM(total_tokens), 0) as totalTokens,
        COALESCE(SUM(cost), 0) as totalCost
      FROM usage_logs
      WHERE key_id = ?
    `);

    const stats = stmt.get(keyId);

    if (stats.totalRequests === 0) {
      return {
        totalRequests: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalTokens: 0,
        totalCost: 0,
        averageCost: 0
      };
    }

    return {
      totalRequests: stats.totalRequests,
      totalInputTokens: stats.totalInputTokens,
      totalOutputTokens: stats.totalOutputTokens,
      totalTokens: stats.totalTokens,
      totalCost: parseFloat(stats.totalCost.toFixed(6)),
      averageCost: parseFloat((stats.totalCost / stats.totalRequests).toFixed(6))
    };
  } catch (error) {
    logger.error(`获取使用统计失败: ${error.message}`);
    throw error;
  }
}

// 清理旧日志（清理指定天数之前的日志）
export async function cleanOldLogs(days = 30) {
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);
    const cutoffDateStr = cutoffDate.toISOString();

    const countStmt = db.prepare('SELECT COUNT(*) as count FROM usage_logs WHERE timestamp < ?');
    const { count: removed } = countStmt.get(cutoffDateStr);

    const deleteStmt = db.prepare('DELETE FROM usage_logs WHERE timestamp < ?');
    deleteStmt.run(cutoffDateStr);

    const remainingStmt = db.prepare('SELECT COUNT(*) as count FROM usage_logs');
    const { count: remaining } = remainingStmt.get();

    logger.info(`清理了 ${removed} 条 ${days} 天前的使用日志`);

    return { removed, remaining };
  } catch (error) {
    logger.error(`清理旧日志失败: ${error.message}`);
    throw error;
  }
}
