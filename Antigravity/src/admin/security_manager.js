import crypto from 'crypto';
import logger from '../utils/logger.js';
import db from '../database/db.js';

// Security events are stored in security_events table with:
// - event_type: 'ip_registration', 'device_registration', 'ip_ban', 'device_ban', 'suspicious_attempt'
// - identifier: IP address or device ID
// - timestamp: Event timestamp
// - data: JSON data for the event
// - expires_at: When the event expires (for cleanup)

// 生成设备指纹
export function generateDeviceFingerprint(userAgent, acceptLanguage, screenResolution, timezone, platform) {
  const data = `${userAgent}|${acceptLanguage}|${screenResolution}|${timezone}|${platform}`;
  return crypto.createHash('sha256').update(data).digest('hex');
}

// 检查IP是否被封禁
export async function isIPBanned(ip) {
  try {
    const stmt = db.prepare(`
      SELECT * FROM security_events
      WHERE event_type = 'ip_ban' AND identifier = ? AND (expires_at IS NULL OR expires_at > ?)
    `);
    const ban = stmt.get(ip, Date.now());
    return !!ban;
  } catch (error) {
    logger.error('检查IP封禁失败:', error);
    return false;
  }
}

// 检查设备是否被封禁
export async function isDeviceBanned(deviceId) {
  try {
    const stmt = db.prepare(`
      SELECT * FROM security_events
      WHERE event_type = 'device_ban' AND identifier = ? AND (expires_at IS NULL OR expires_at > ?)
    `);
    const ban = stmt.get(deviceId, Date.now());
    return !!ban;
  } catch (error) {
    logger.error('检查设备封禁失败:', error);
    return false;
  }
}

// 检查IP注册限制
export async function checkIPRegistrationLimit(ip) {
  try {
    // 检查是否被封禁
    const banStmt = db.prepare(`
      SELECT data FROM security_events
      WHERE event_type = 'ip_ban' AND identifier = ? AND (expires_at IS NULL OR expires_at > ?)
    `);
    const ban = banStmt.get(ip, Date.now());

    if (ban) {
      const banData = JSON.parse(ban.data || '{}');
      throw new Error(`该 IP 已被封禁：${banData.reason || '注册次数过多'}`);
    }

    const now = Date.now();
    const dayAgo = now - 24 * 60 * 60 * 1000;

    // 获取24小时内的注册记录
    const registrationStmt = db.prepare(`
      SELECT COUNT(*) as count FROM security_events
      WHERE event_type = 'ip_registration' AND identifier = ? AND timestamp > ?
    `);
    const { count } = registrationStmt.get(ip, dayAgo);

    // 清理过期记录
    const cleanupStmt = db.prepare(`
      DELETE FROM security_events
      WHERE event_type = 'ip_registration' AND identifier = ? AND timestamp <= ?
    `);
    cleanupStmt.run(ip, dayAgo);

    // 检查注册数量
    if (count >= 5) {
      // 记录可疑尝试
      const suspiciousStmt = db.prepare(`
        SELECT COUNT(*) as count FROM security_events
        WHERE event_type = 'suspicious_attempt' AND identifier = ? AND timestamp > ?
      `);
      const { count: suspiciousCount } = suspiciousStmt.get(ip, dayAgo);

      const insertSuspiciousStmt = db.prepare(`
        INSERT INTO security_events (event_type, identifier, timestamp, data, expires_at)
        VALUES ('suspicious_attempt', ?, ?, NULL, ?)
      `);
      insertSuspiciousStmt.run(ip, now, now + 24 * 60 * 60 * 1000);

      // 如果尝试次数超过3次，封禁IP
      if (suspiciousCount >= 2) { // >=2 because we just added one
        const banData = JSON.stringify({ reason: '短时间内注册次数过多（超过限制3次以上）', bannedAt: now });
        const banStmt = db.prepare(`
          INSERT INTO security_events (event_type, identifier, timestamp, data, expires_at)
          VALUES ('ip_ban', ?, ?, ?, NULL)
        `);
        banStmt.run(ip, now, banData);

        logger.warn(`IP ${ip} 已被封禁：注册尝试次数过多`);
        throw new Error('该 IP 已被封禁：注册次数过多');
      }

      throw new Error('24小时内该 IP 已注册5个账号，请稍后再试');
    }

    return true;
  } catch (error) {
    logger.error('检查IP注册限制失败:', error);
    throw error;
  }
}

// 检查设备注册限制
export async function checkDeviceRegistrationLimit(deviceId) {
  try {
    // 检查是否被封禁
    const banStmt = db.prepare(`
      SELECT data FROM security_events
      WHERE event_type = 'device_ban' AND identifier = ? AND (expires_at IS NULL OR expires_at > ?)
    `);
    const ban = banStmt.get(deviceId, Date.now());

    if (ban) {
      const banData = JSON.parse(ban.data || '{}');
      throw new Error(`该设备已被封禁：${banData.reason || '注册次数过多'}`);
    }

    const now = Date.now();
    const dayAgo = now - 24 * 60 * 60 * 1000;

    // 获取24小时内的注册记录
    const registrationStmt = db.prepare(`
      SELECT COUNT(*) as count FROM security_events
      WHERE event_type = 'device_registration' AND identifier = ? AND timestamp > ?
    `);
    const { count } = registrationStmt.get(deviceId, dayAgo);

    // 清理过期记录
    const cleanupStmt = db.prepare(`
      DELETE FROM security_events
      WHERE event_type = 'device_registration' AND identifier = ? AND timestamp <= ?
    `);
    cleanupStmt.run(deviceId, dayAgo);

    // 检查注册数量
    if (count >= 5) {
      // 封禁设备
      const banData = JSON.stringify({ reason: '短时间内同一设备注册次数过多', bannedAt: now });
      const banDeviceStmt = db.prepare(`
        INSERT INTO security_events (event_type, identifier, timestamp, data, expires_at)
        VALUES ('device_ban', ?, ?, ?, NULL)
      `);
      banDeviceStmt.run(deviceId, now, banData);

      logger.warn(`设备 ${deviceId} 已被封禁：注册尝试次数过多`);
      throw new Error('该设备已被封禁：注册次数过多');
    }

    return true;
  } catch (error) {
    logger.error('检查设备注册限制失败:', error);
    throw error;
  }
}

// 记录注册
export async function recordRegistration(ip, deviceId, userId) {
  try {
    const now = Date.now();
    const expiresAt = now + 24 * 60 * 60 * 1000; // 24小时后过期

    // 记录IP注册
    const ipData = JSON.stringify({ userId, timestamp: now });
    const ipStmt = db.prepare(`
      INSERT INTO security_events (event_type, identifier, timestamp, data, expires_at)
      VALUES ('ip_registration', ?, ?, ?, ?)
    `);
    ipStmt.run(ip, now, ipData, expiresAt);

    // 记录设备注册
    if (deviceId) {
      const deviceData = JSON.stringify({ userId, timestamp: now });
      const deviceStmt = db.prepare(`
        INSERT INTO security_events (event_type, identifier, timestamp, data, expires_at)
        VALUES ('device_registration', ?, ?, ?, ?)
      `);
      deviceStmt.run(deviceId, now, deviceData, expiresAt);
    }

    logger.info(`记录注册：IP=${ip}, 设备=${deviceId}, 用户=${userId}`);
  } catch (error) {
    logger.error('记录注册失败:', error);
    throw error;
  }
}

// 清理长时间未登录的账号（超过15天）
export async function cleanupInactiveUsers(users) {
  const now = Date.now();
  const inactivePeriod = 15 * 24 * 60 * 60 * 1000; // 15天
  const deletedUsers = [];

  const activeUsers = users.filter(user => {
    const lastActivity = user.lastLogin || user.created;
    const inactive = now - lastActivity > inactivePeriod;

    if (inactive) {
      deletedUsers.push({
        username: user.username,
        lastActivity: new Date(lastActivity).toLocaleString()
      });
      return false;
    }
    return true;
  });

  if (deletedUsers.length > 0) {
    logger.info(`自动清理 ${deletedUsers.length} 个长时间未登录账号：${deletedUsers.map(u => u.username).join(', ')}`);
  }

  return { users: activeUsers, deletedCount: deletedUsers.length, deletedUsers };
}

// 获取安全统计
export async function getSecurityStats() {
  try {
    const now = Date.now();

    const ipBanStmt = db.prepare(`
      SELECT COUNT(*) as count FROM security_events
      WHERE event_type = 'ip_ban' AND (expires_at IS NULL OR expires_at > ?)
    `);
    const deviceBanStmt = db.prepare(`
      SELECT COUNT(*) as count FROM security_events
      WHERE event_type = 'device_ban' AND (expires_at IS NULL OR expires_at > ?)
    `);

    const ipBansStmt = db.prepare(`
      SELECT identifier, data FROM security_events
      WHERE event_type = 'ip_ban' AND (expires_at IS NULL OR expires_at > ?)
    `);
    const deviceBansStmt = db.prepare(`
      SELECT identifier, data FROM security_events
      WHERE event_type = 'device_ban' AND (expires_at IS NULL OR expires_at > ?)
    `);

    const bannedIPs = {};
    const bannedDevices = {};

    for (const row of ipBansStmt.all(now)) {
      const data = JSON.parse(row.data || '{}');
      bannedIPs[row.identifier] = data;
    }

    for (const row of deviceBansStmt.all(now)) {
      const data = JSON.parse(row.data || '{}');
      bannedDevices[row.identifier] = data;
    }

    return {
      bannedIPsCount: ipBanStmt.get(now).count,
      bannedDevicesCount: deviceBanStmt.get(now).count,
      bannedIPs,
      bannedDevices
    };
  } catch (error) {
    logger.error('获取安全统计失败:', error);
    return {
      bannedIPsCount: 0,
      bannedDevicesCount: 0,
      bannedIPs: {},
      bannedDevices: {}
    };
  }
}

// 解封IP
export async function unbanIP(ip) {
  try {
    const deleteStmt = db.prepare(`
      DELETE FROM security_events
      WHERE event_type IN ('ip_ban', 'suspicious_attempt') AND identifier = ?
    `);
    const result = deleteStmt.run(ip);

    if (result.changes > 0) {
      logger.info(`IP ${ip} 已解封`);
      return true;
    }

    return false;
  } catch (error) {
    logger.error('解封IP失败:', error);
    return false;
  }
}

// 解封设备
export async function unbanDevice(deviceId) {
  try {
    const deleteStmt = db.prepare(`
      DELETE FROM security_events
      WHERE event_type = 'device_ban' AND identifier = ?
    `);
    const result = deleteStmt.run(deviceId);

    if (result.changes > 0) {
      logger.info(`设备 ${deviceId} 已解封`);
      return true;
    }

    return false;
  } catch (error) {
    logger.error('解封设备失败:', error);
    return false;
  }
}
