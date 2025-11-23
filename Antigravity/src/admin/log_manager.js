import db from '../database/db.js';

const MAX_LOGS = 200; // 最多保存 200 条日志（降低内存使用）

// 加载日志
export async function loadLogs() {
  try {
    const logs = db.prepare('SELECT * FROM app_logs ORDER BY timestamp DESC').all();
    return logs;
  } catch (error) {
    console.error('加载日志失败:', error);
    return [];
  }
}

// 添加日志
export async function addLog(level, message, details = null) {
  try {
    const stmt = db.prepare(`
      INSERT INTO app_logs (timestamp, level, message, details)
      VALUES (?, ?, ?, ?)
    `);

    stmt.run(
      new Date().toISOString(),
      level,
      message,
      details ? JSON.stringify(details) : null
    );

    // 清理旧日志，保持数量在限制内
    const countStmt = db.prepare('SELECT COUNT(*) as count FROM app_logs');
    const { count } = countStmt.get();

    if (count > MAX_LOGS) {
      const deleteStmt = db.prepare(`
        DELETE FROM app_logs
        WHERE id IN (
          SELECT id FROM app_logs
          ORDER BY timestamp ASC
          LIMIT ?
        )
      `);
      deleteStmt.run(count - MAX_LOGS);
    }
  } catch (error) {
    console.error('添加日志失败:', error);
  }
}

// 清空日志
export async function clearLogs() {
  try {
    const stmt = db.prepare('DELETE FROM app_logs');
    stmt.run();
  } catch (error) {
    console.error('清空日志失败:', error);
  }
}

// 获取最近的日志
export async function getRecentLogs(limit = 100) {
  try {
    const stmt = db.prepare(`
      SELECT * FROM app_logs
      ORDER BY timestamp DESC
      LIMIT ?
    `);
    return stmt.all(limit);
  } catch (error) {
    console.error('获取日志失败:', error);
    return [];
  }
}
