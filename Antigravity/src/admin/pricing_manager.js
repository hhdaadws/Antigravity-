import logger from '../utils/logger.js';
import db from '../database/db.js';

// 默认定价配置（Gemini 3 Pro 计费标准，美元/百万tokens）
const DEFAULT_PRICING = {
  'gemini-3-pro-preview': {
    input: 1.25,
    output: 5.0
  },
  'gemini-3-pro-high': {
    input: 1.25,
    output: 5.0
  },
  'gemini-2.5-pro': {
    input: 1.25,
    output: 2.50
  },
  'gemini-2.5-flash': {
    input: 0.075,
    output: 0.30
  },
  'default': {
    input: 1.25,
    output: 5.0
  }
};

// 初始化默认定价
async function initializeDefaultPricing() {
  try {
    const countStmt = db.prepare('SELECT COUNT(*) as count FROM pricing');
    const { count } = countStmt.get();

    if (count === 0) {
      const stmt = db.prepare('INSERT INTO pricing (model, input_price, output_price) VALUES (?, ?, ?)');
      const insert = db.transaction((pricingData) => {
        for (const [model, prices] of Object.entries(pricingData)) {
          stmt.run(model, prices.input, prices.output);
        }
      });
      insert(DEFAULT_PRICING);
      logger.info('已初始化默认定价配置');
    }
  } catch (error) {
    logger.error(`初始化默认定价失败: ${error.message}`);
  }
}

// 初始化时加载默认定价
initializeDefaultPricing();

// 加载定价配置
export async function loadPricing() {
  try {
    const rows = db.prepare('SELECT model, input_price, output_price FROM pricing').all();
    const pricing = {};
    rows.forEach(row => {
      pricing[row.model] = {
        input: row.input_price,
        output: row.output_price
      };
    });
    return pricing;
  } catch (error) {
    logger.error(`加载定价配置失败: ${error.message}`);
    return DEFAULT_PRICING;
  }
}

// 获取特定模型的定价
export async function getModelPricing(model) {
  try {
    const stmt = db.prepare('SELECT input_price, output_price FROM pricing WHERE model = ?');
    const row = stmt.get(model);

    if (row) {
      return {
        input: row.input_price,
        output: row.output_price
      };
    }

    // 如果找不到，返回默认定价
    const defaultStmt = db.prepare('SELECT input_price, output_price FROM pricing WHERE model = ?');
    const defaultRow = defaultStmt.get('default');

    return defaultRow ? {
      input: defaultRow.input_price,
      output: defaultRow.output_price
    } : DEFAULT_PRICING.default;
  } catch (error) {
    logger.error(`获取模型定价失败: ${error.message}`);
    return DEFAULT_PRICING.default;
  }
}

// 更新特定模型的定价
export async function updateModelPricing(model, inputPrice, outputPrice) {
  try {
    if (inputPrice < 0 || outputPrice < 0) {
      throw new Error('价格不能为负数');
    }

    const stmt = db.prepare(`
      INSERT INTO pricing (model, input_price, output_price)
      VALUES (?, ?, ?)
      ON CONFLICT(model) DO UPDATE SET
        input_price = excluded.input_price,
        output_price = excluded.output_price
    `);

    stmt.run(model, parseFloat(inputPrice), parseFloat(outputPrice));
    logger.info(`模型 ${model} 的定价已更新: input=$${inputPrice}/M, output=$${outputPrice}/M`);

    return {
      input: parseFloat(inputPrice),
      output: parseFloat(outputPrice)
    };
  } catch (error) {
    logger.error(`更新模型定价失败: ${error.message}`);
    throw error;
  }
}

// 删除模型定价（恢复为使用默认定价）
export async function deleteModelPricing(model) {
  try {
    if (model === 'default') {
      throw new Error('不能删除默认定价');
    }

    const checkStmt = db.prepare('SELECT COUNT(*) as count FROM pricing WHERE model = ?');
    const { count } = checkStmt.get(model);

    if (count === 0) {
      throw new Error('模型定价不存在');
    }

    const deleteStmt = db.prepare('DELETE FROM pricing WHERE model = ?');
    deleteStmt.run(model);
    logger.info(`模型 ${model} 的定价已删除，将使用默认定价`);

    return true;
  } catch (error) {
    logger.error(`删除模型定价失败: ${error.message}`);
    throw error;
  }
}

// 重置所有定价为默认值
export async function resetPricing() {
  try {
    const deleteStmt = db.prepare('DELETE FROM pricing');
    deleteStmt.run();

    const stmt = db.prepare('INSERT INTO pricing (model, input_price, output_price) VALUES (?, ?, ?)');
    const insert = db.transaction((pricingData) => {
      for (const [model, prices] of Object.entries(pricingData)) {
        stmt.run(model, prices.input, prices.output);
      }
    });
    insert(DEFAULT_PRICING);

    logger.info('所有定价已重置为默认值');
    return DEFAULT_PRICING;
  } catch (error) {
    logger.error(`重置定价失败: ${error.message}`);
    throw error;
  }
}

// 添加新模型定价
export async function addModelPricing(model, inputPrice, outputPrice) {
  try {
    const checkStmt = db.prepare('SELECT COUNT(*) as count FROM pricing WHERE model = ?');
    const { count } = checkStmt.get(model);

    if (count > 0) {
      throw new Error('模型定价已存在，请使用更新功能');
    }

    if (inputPrice < 0 || outputPrice < 0) {
      throw new Error('价格不能为负数');
    }

    const stmt = db.prepare('INSERT INTO pricing (model, input_price, output_price) VALUES (?, ?, ?)');
    stmt.run(model, parseFloat(inputPrice), parseFloat(outputPrice));

    logger.info(`新模型 ${model} 的定价已添加: input=$${inputPrice}/M, output=$${outputPrice}/M`);

    return {
      input: parseFloat(inputPrice),
      output: parseFloat(outputPrice)
    };
  } catch (error) {
    logger.error(`添加模型定价失败: ${error.message}`);
    throw error;
  }
}
