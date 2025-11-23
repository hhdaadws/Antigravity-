# 数据库迁移和部署指南

本指南介绍如何从JSON文件存储迁移到SQLite数据库，以及如何使用Docker部署和更新应用。

## 📋 目录

- [数据库迁移](#数据库迁移)
- [Docker部署](#docker部署)
- [一键脚本](#一键脚本)
- [常见问题](#常见问题)

---

## 🔄 数据库迁移

### 为什么迁移到数据库？

从JSON文件存储迁移到SQLite数据库有以下优势：

- ✅ **更好的并发性能** - 支持多进程同时读写
- ✅ **数据完整性** - 事务支持，防止数据损坏
- ✅ **查询效率** - 索引支持，快速查询
- ✅ **可扩展性** - 支持水平扩展
- ✅ **更小的内存占用** - 不需要将所有数据加载到内存

### 迁移步骤

#### 1. 备份现有数据

在迁移之前，请先备份您的data目录：

```bash
cp -r data data_backup_$(date +%Y%m%d)
```

#### 2. 安装依赖

确保已安装better-sqlite3：

```bash
npm install
```

#### 3. 运行迁移脚本

执行迁移脚本将JSON数据导入数据库：

```bash
npm run migrate
```

迁移脚本会：
- 自动备份所有JSON文件到 `data/json_backup_<timestamp>/`
- 创建SQLite数据库 `data/antigravity.db`
- 将所有数据从JSON文件导入数据库
- 保留原始JSON文件（可以安全删除）

#### 4. 验证迁移

启动应用并检查是否正常工作：

```bash
npm start
```

访问管理面板 http://localhost:8045/admin.html 确认数据正确迁移。

### 迁移注意事项

⚠️ **重要提示：**

1. 迁移脚本会自动备份JSON文件，但建议手动备份
2. 迁移后，应用将使用数据库，不再读写JSON文件
3. 如需回滚，从备份目录恢复JSON文件，并删除 `antigravity.db`
4. 数据库文件包含3个文件：
   - `antigravity.db` - 主数据库文件
   - `antigravity.db-shm` - 共享内存文件（WAL模式）
   - `antigravity.db-wal` - 预写日志文件（WAL模式）

---

## 🐳 Docker部署

### 方式1: 使用一键部署脚本（推荐）

最简单的部署方式，适合新手：

```bash
# 下载并运行部署脚本
chmod +x deploy.sh
./deploy.sh
```

脚本会自动：
- 检测操作系统
- 安装Docker（如未安装）
- 创建必要的目录和配置文件
- 拉取最新镜像
- 启动容器

### 方式2: 使用docker-compose

适合需要自定义配置的用户：

```bash
# 启动服务
docker-compose up -d

# 查看日志
docker-compose logs -f

# 停止服务
docker-compose down

# 重启服务
docker-compose restart
```

### 方式3: 手动Docker命令

```bash
# 拉取镜像
docker pull miku66/arg:latest

# 创建配置文件（如果没有）
mkdir -p data
cat > config.json << 'EOF'
{
  "port": 8045,
  "apiEndpoint": "https://generativelanguage.googleapis.com/v1beta/models",
  "adminUsername": "admin",
  "adminPassword": "admin123"
}
EOF

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

## 🚀 一键脚本

### deploy.sh - 一键部署

自动安装Docker并部署应用：

```bash
./deploy.sh
```

**功能：**
- 检测并安装Docker
- 创建data目录和配置文件
- 拉取最新镜像
- 启动容器
- 显示服务信息

**适用系统：**
- Ubuntu/Debian
- CentOS/RHEL
- Fedora

### update.sh - 一键更新

更新到最新版本：

```bash
./update.sh
```

**功能：**
- 拉取最新镜像
- 备份数据（可选）
- 停止旧容器
- 启动新容器
- 清理旧镜像
- 显示版本信息

**使用示例：**

```bash
# 更新前查看当前版本
docker exec antigravity node -e "console.log(require('./package.json').version)"

# 执行更新
./update.sh

# 查看日志确认正常
docker logs -f antigravity
```

---

## 📦 持久化数据

### 数据目录结构

```
data/
├── antigravity.db       # SQLite数据库
├── antigravity.db-shm   # 共享内存文件
├── antigravity.db-wal   # 预写日志文件
└── json_backup_*/       # JSON文件备份（迁移后）
```

### 备份数据库

#### 方式1: 复制数据库文件

```bash
# 停止容器
docker stop antigravity

# 备份数据库
cp -r data data_backup_$(date +%Y%m%d_%H%M%S)

# 启动容器
docker start antigravity
```

#### 方式2: 使用SQLite备份命令

```bash
# 在线备份（不需要停止容器）
docker exec antigravity sqlite3 /app/data/antigravity.db ".backup '/app/data/backup.db'"

# 复制备份文件到宿主机
docker cp antigravity:/app/data/backup.db ./backup_$(date +%Y%m%d_%H%M%S).db
```

### 恢复数据库

```bash
# 停止容器
docker stop antigravity

# 恢复数据库
cp backup.db data/antigravity.db

# 启动容器
docker start antigravity
```

---

## 🔧 常见问题

### Q1: 迁移后JSON文件还需要吗？

A: 不需要。迁移后应用会使用SQLite数据库，JSON文件已被备份到 `data/json_backup_*/` 目录。如果确认迁移成功，可以删除备份目录以节省空间。

### Q2: 如何回滚到JSON文件存储？

A:

```bash
# 1. 停止应用
docker stop antigravity

# 2. 删除数据库文件
rm data/antigravity.db*

# 3. 从备份恢复JSON文件
cp data/json_backup_*/*.json data/

# 4. 启动应用
docker start antigravity
```

### Q3: 数据库文件太大怎么办？

A: 可以清理旧的日志数据：

```bash
# 清理30天前的使用日志
docker exec antigravity node -e "
  const db = require('./src/database/db.js').default;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  db.prepare('DELETE FROM usage_logs WHERE timestamp < ?').run(cutoff.toISOString());
  db.prepare('DELETE FROM app_logs WHERE timestamp < ?').run(cutoff.toISOString());
  console.log('清理完成');
"

# 压缩数据库
docker exec antigravity sqlite3 /app/data/antigravity.db "VACUUM"
```

### Q4: Docker镜像无法拉取？

A: 尝试使用国内镜像源：

```bash
# 方法1: 配置Docker镜像加速
sudo mkdir -p /etc/docker
sudo tee /etc/docker/daemon.json <<-'EOF'
{
  "registry-mirrors": ["https://docker.mirrors.ustc.edu.cn"]
}
EOF
sudo systemctl restart docker

# 方法2: 使用代理
docker pull miku66/arg:latest --proxy http://your-proxy:port
```

### Q5: 容器无法启动？

A: 检查日志找出原因：

```bash
# 查看容器日志
docker logs antigravity

# 查看容器状态
docker ps -a | grep antigravity

# 进入容器调试
docker exec -it antigravity sh
```

### Q6: 端口被占用？

A: 修改映射端口：

```bash
# 使用其他端口（如8046）
docker run -d \
  --name antigravity \
  --restart unless-stopped \
  -p 8046:8045 \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/config.json:/app/config.json \
  miku66/arg:latest
```

### Q7: 如何查看数据库内容？

A:

```bash
# 方法1: 使用SQLite命令行
docker exec -it antigravity sqlite3 /app/data/antigravity.db

# 常用命令
.tables          # 查看所有表
.schema users    # 查看表结构
SELECT * FROM users LIMIT 10;  # 查询数据
.quit            # 退出

# 方法2: 复制到本地使用GUI工具
docker cp antigravity:/app/data/antigravity.db ./
# 使用 DB Browser for SQLite 等工具打开
```

### Q8: 如何监控数据库性能？

A:

```bash
# 查看数据库统计信息
docker exec antigravity sqlite3 /app/data/antigravity.db "
  SELECT
    (SELECT COUNT(*) FROM users) as total_users,
    (SELECT COUNT(*) FROM api_keys) as total_api_keys,
    (SELECT COUNT(*) FROM usage_logs) as total_usage_logs,
    (SELECT COUNT(*) FROM google_tokens) as total_tokens;
"

# 查看数据库大小
docker exec antigravity du -h /app/data/antigravity.db
```

---

## 🎯 最佳实践

1. **定期备份** - 每天自动备份数据库到异地
2. **监控日志** - 使用 `docker logs -f antigravity` 监控运行状态
3. **限制日志大小** - 在docker-compose.yml中配置日志轮转
4. **定期更新** - 使用 `./update.sh` 保持最新版本
5. **安全配置** - 修改默认管理员密码
6. **性能优化** - 定期清理旧日志，保持数据库精简

---

## 📞 技术支持

如有问题，请：

1. 查看日志: `docker logs -f antigravity`
2. 检查配置文件是否正确
3. 提交Issue到GitHub仓库

---

## 📄 许可证

MIT License
