# 数据库迁移 & Docker 部署说明

## ✨ 新功能

本次更新包含以下重要功能：

### 1. 📊 数据库存储

- ✅ 从JSON文件存储迁移到SQLite数据库
- ✅ 更好的并发性能和数据完整性
- ✅ 支持事务和索引查询
- ✅ 自动数据迁移脚本

### 2. 🐳 Docker支持

- ✅ 完整的Dockerfile配置
- ✅ GitHub Actions自动构建并推送到 `miku66/arg:latest`
- ✅ 多架构支持 (amd64/arm64)
- ✅ 健康检查和日志轮转

### 3. 🚀 一键部署脚本

- ✅ `deploy.sh` - 自动安装Docker并部署
- ✅ `update.sh` - 一键更新到最新版本
- ✅ `docker-compose.yml` - Docker Compose配置
- ✅ 支持Ubuntu/Debian/CentOS/Fedora

---

## 🚀 快速开始

### 选项1: 使用一键部署脚本（推荐）

```bash
# 1. 下载项目
git clone <repository-url>
cd Antigravity

# 2. 运行部署脚本
chmod +x deploy.sh
./deploy.sh
```

### 选项2: 使用Docker Compose

```bash
# 1. 创建配置文件（首次部署）
mkdir -p data
cp config.json.example config.json  # 修改配置

# 2. 启动服务
docker-compose up -d

# 3. 查看日志
docker-compose logs -f
```

### 选项3: 手动Docker部署

```bash
# 拉取镜像
docker pull miku66/arg:latest

# 运行容器
docker run -d \
  --name antigravity \
  --restart unless-stopped \
  -p 8045:8045 \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/config.json:/app/config.json \
  miku66/arg:latest
```

---

## 📦 从JSON迁移到数据库

如果您之前使用JSON文件存储，可以使用迁移脚本：

```bash
# 1. 备份数据
cp -r data data_backup_$(date +%Y%m%d)

# 2. 运行迁移
npm install
npm run migrate

# 3. 启动应用
npm start
```

详细迁移指南请参考 [MIGRATION_GUIDE.md](./MIGRATION_GUIDE.md)

---

## 🔄 更新应用

### 使用更新脚本

```bash
./update.sh
```

### 手动更新

```bash
# 1. 拉取最新镜像
docker pull miku66/arg:latest

# 2. 停止并删除旧容器
docker stop antigravity
docker rm antigravity

# 3. 启动新容器
docker run -d \
  --name antigravity \
  --restart unless-stopped \
  -p 8045:8045 \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/config.json:/app/config.json \
  miku66/arg:latest

# 4. 清理旧镜像
docker image prune -f
```

---

## 🔧 常用命令

```bash
# 查看日志
docker logs -f antigravity

# 进入容器
docker exec -it antigravity sh

# 重启容器
docker restart antigravity

# 停止容器
docker stop antigravity

# 启动容器
docker start antigravity

# 查看数据库
docker exec -it antigravity sqlite3 /app/data/antigravity.db
```

---

## 📁 目录结构

```
Antigravity/
├── src/                    # 源代码
│   ├── database/          # 数据库模块（新增）
│   │   └── db.js         # 数据库初始化
│   ├── admin/            # 管理模块
│   ├── api/              # API客户端
│   ├── auth/             # 认证模块
│   └── server/           # 服务器入口
├── scripts/               # 脚本文件
│   ├── migrate-to-database.js  # 数据迁移脚本（新增）
│   └── oauth-server.js   # OAuth服务器
├── data/                  # 数据目录
│   ├── antigravity.db    # SQLite数据库（新增）
│   └── *.json            # JSON文件（迁移后可删除）
├── public/               # 前端静态文件
├── Dockerfile            # Docker配置（新增）
├── .dockerignore         # Docker忽略文件（新增）
├── docker-compose.yml    # Docker Compose配置（新增）
├── deploy.sh             # 一键部署脚本（新增）
├── update.sh             # 一键更新脚本（新增）
├── config.json           # 配置文件
└── package.json          # 项目依赖
```

---

## 🎯 GitHub Actions 自动构建

每次推送到main/master分支，GitHub Actions会自动：

1. 构建Docker镜像
2. 推送到Docker Hub: `miku66/arg:latest`
3. 支持多架构: linux/amd64, linux/arm64

**配置要求：**

在GitHub仓库设置中添加以下Secrets：
- `DOCKER_USERNAME` - Docker Hub用户名
- `DOCKER_PASSWORD` - Docker Hub密码或访问令牌

---

## 🔒 安全建议

1. **修改默认密码** - 首次部署后立即修改管理员密码
2. **限制访问** - 使用防火墙限制端口访问
3. **定期备份** - 定期备份 `data/` 目录
4. **更新镜像** - 定期运行 `./update.sh` 获取最新安全补丁
5. **HTTPS** - 生产环境建议使用反向代理(Nginx)配置HTTPS

---

## 📊 数据库说明

### 数据库文件

- `antigravity.db` - 主数据库文件
- `antigravity.db-shm` - 共享内存文件（WAL模式）
- `antigravity.db-wal` - 预写日志文件（WAL模式）

### 备份数据库

```bash
# 在线备份
docker exec antigravity sqlite3 /app/data/antigravity.db ".backup '/app/data/backup.db'"

# 复制到宿主机
docker cp antigravity:/app/data/backup.db ./backup_$(date +%Y%m%d).db
```

### 查看数据库

```bash
# 进入SQLite命令行
docker exec -it antigravity sqlite3 /app/data/antigravity.db

# 查看所有表
.tables

# 查看表结构
.schema users

# 查询数据
SELECT * FROM users;

# 退出
.quit
```

---

## 🐛 故障排查

### 容器无法启动

```bash
# 查看详细日志
docker logs antigravity

# 检查端口占用
netstat -tunlp | grep 8045

# 检查配置文件
cat config.json
```

### 数据库错误

```bash
# 检查数据库文件
ls -lh data/antigravity.db*

# 验证数据库完整性
docker exec antigravity sqlite3 /app/data/antigravity.db "PRAGMA integrity_check"

# 修复数据库
docker exec antigravity sqlite3 /app/data/antigravity.db "VACUUM"
```

### 迁移失败

```bash
# 从备份恢复JSON文件
cp -r data_backup/* data/

# 删除损坏的数据库
rm data/antigravity.db*

# 重新运行迁移
npm run migrate
```

---

## 📞 获取帮助

- 查看详细迁移指南: [MIGRATION_GUIDE.md](./MIGRATION_GUIDE.md)
- 查看原始README: [README.md](./README.md)
- 提交Issue到GitHub仓库

---

## 📝 更新日志

### v1.1.0 (当前版本)

- ✨ 新增SQLite数据库支持
- ✨ 新增Docker部署支持
- ✨ 新增GitHub Actions自动构建
- ✨ 新增一键部署和更新脚本
- ✨ 新增数据迁移工具
- 🐛 修复并发访问问题
- ⚡ 优化性能和内存使用
- 📝 完善文档

### v1.0.0

- 🎉 初始版本
- 基于JSON文件存储
