import http from 'http';
import https from 'https';
import { URL } from 'url';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import log from '../src/utils/logger.js';
import db from '../src/database/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_FILE = path.join(__dirname, '..', 'config.json');

// 从配置文件读取 OAuth 配置
function loadOAuthConfig() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    return {
      clientId: config.oauth?.clientId || '',
      clientSecret: config.oauth?.clientSecret || ''
    };
  } catch {
    return { clientId: '', clientSecret: '' };
  }
}

const oauthConfig = loadOAuthConfig();
const CLIENT_ID = oauthConfig.clientId;
const CLIENT_SECRET = oauthConfig.clientSecret;
const STATE = crypto.randomUUID();

// 检查 OAuth 配置
if (!CLIENT_ID || !CLIENT_SECRET) {
  log.error('错误：未配置 OAuth Client ID 或 Client Secret');
  log.error('请在管理后台的"系统设置"中配置 Google OAuth 信息');
  process.exit(1);
}

const SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs'
];

function generateAuthUrl(port) {
  const params = new URLSearchParams({
    access_type: 'offline',
    client_id: CLIENT_ID,
    prompt: 'consent',
    redirect_uri: `http://localhost:${port}/oauth-callback`,
    response_type: 'code',
    scope: SCOPES.join(' '),
    state: STATE
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

function exchangeCodeForToken(code, port) {
  return new Promise((resolve, reject) => {
    const postData = new URLSearchParams({
      code: code,
      client_id: CLIENT_ID,
      redirect_uri: `http://localhost:${port}/oauth-callback`,
      grant_type: 'authorization_code'
    });
    
    if (CLIENT_SECRET) {
      postData.append('client_secret', CLIENT_SECRET);
    }
    
    const data = postData.toString();
    
    const options = {
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(data)
      }
    };
    
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(JSON.parse(body));
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${body}`));
        }
      });
    });
    
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

const server = http.createServer((req, res) => {
  const port = server.address().port;
  const url = new URL(req.url, `http://localhost:${port}`);
  
  if (url.pathname === '/oauth-callback') {
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    
    if (code) {
      log.info('收到授权码，正在交换 Token...');
      exchangeCodeForToken(code, port).then(tokenData => {
        const account = {
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token,
          expires_in: tokenData.expires_in,
          timestamp: Date.now()
        };

        try {
          // 保存到数据库 (admin token, user_id IS NULL)
          const stmt = db.prepare(`
            INSERT INTO google_tokens (
              user_id, access_token, refresh_token, expires_in, timestamp,
              email, enabled, is_shared, daily_limit, usage_today, last_reset_date,
              proxy_id, disabled_until, quota_exhausted, total_cost, daily_cost,
              last_reset_time, total_requests
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);

          stmt.run(
            null,  // user_id IS NULL for admin tokens
            account.access_token,
            account.refresh_token,
            account.expires_in,
            account.timestamp,
            null,  // email will be fetched later
            1,     // enabled
            0,     // is_shared
            100,   // daily_limit
            0,     // usage_today
            new Date().toDateString(),  // last_reset_date
            null,  // proxy_id
            null,  // disabled_until
            0,     // quota_exhausted
            0,     // total_cost
            0,     // daily_cost
            0,     // last_reset_time
            0      // total_requests
          );

          log.info('Token 已保存到数据库');
        } catch (err) {
          log.error('保存 Token 到数据库失败:', err.message);
          res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h1>保存失败</h1><p>Token 获取成功但保存到数据库失败，请查看日志。</p>');
          setTimeout(() => server.close(), 1000);
          return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>授权成功！</h1><p>Token 已保存，可以关闭此页面。</p>');

        setTimeout(() => server.close(), 1000);
      }).catch(err => {
        log.error('Token 交换失败:', err.message);
        
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>Token 获取失败</h1><p>查看控制台错误信息</p>');
        
        setTimeout(() => server.close(), 1000);
      });
    } else {
      log.error('授权失败:', error || '未收到授权码');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>授权失败</h1>');
      setTimeout(() => server.close(), 1000);
    }
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

// 使用固定端口，需要在 Google Cloud Console 配置对应的重定向 URI
const OAUTH_PORT = 8099;

// 添加错误处理，防止端口冲突导致进程崩溃
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log.error(`端口 ${OAUTH_PORT} 已被占用，OAuth 服务器无法启动`);
    log.error('请先关闭占用该端口的进程，或等待几秒后重试');
    // 不要让整个进程崩溃，只是报错
    return;
  }
  log.error('OAuth 服务器错误:', err.message);
});

server.listen(OAUTH_PORT, () => {
  const port = server.address().port;
  const authUrl = generateAuthUrl(port);
  log.info(`服务器运行在 http://localhost:${port}`);
  log.info('请在浏览器中打开以下链接进行登录：');
  console.log(`\n${authUrl}\n`);
  log.info('等待授权回调...');
  log.info('注意：需要在 Google Cloud Console 中添加重定向 URI: http://localhost:8099/oauth-callback');
});
