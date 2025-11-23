#!/bin/bash

#############################################
# Antigravity 一键更新脚本
# 功能：拉取最新镜像并重启服务
#############################################

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 配置
DOCKER_IMAGE="miku66/arg:latest"
CONTAINER_NAME="antigravity"

# 打印带颜色的消息
print_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

print_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

print_step() {
    echo -e "${BLUE}[STEP]${NC} $1"
}

# 检查Docker是否安装
check_docker() {
    if ! command -v docker &> /dev/null; then
        print_error "Docker 未安装，请先运行 deploy.sh 进行部署"
        exit 1
    fi
}

# 检查容器是否存在
check_container() {
    if ! docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        print_error "容器 $CONTAINER_NAME 不存在，请先运行 deploy.sh 进行部署"
        exit 1
    fi
}

# 备份数据
backup_data() {
    print_step "备份数据..."
    BACKUP_DIR="./backup_$(date +%Y%m%d_%H%M%S)"
    mkdir -p "$BACKUP_DIR"

    if [ -d "./data" ]; then
        cp -r ./data "$BACKUP_DIR/"
        print_info "数据已备份到: $BACKUP_DIR"
    fi
}

# 拉取最新镜像
pull_latest() {
    print_step "拉取最新镜像..."
    docker pull "$DOCKER_IMAGE"
}

# 停止并删除旧容器
stop_container() {
    print_step "停止旧容器..."
    docker stop "$CONTAINER_NAME" 2>/dev/null || true
    docker rm "$CONTAINER_NAME" 2>/dev/null || true
}

# 启动新容器
start_container() {
    print_step "启动新容器..."

    # 获取旧容器的配置
    OLD_CONTAINER=$(docker ps -a --filter "name=${CONTAINER_NAME}" --format "{{.ID}}" | head -1)

    if [ -z "$OLD_CONTAINER" ]; then
        # 使用默认配置
        PORT=8045
        DATA_DIR="./data"
        CONFIG_FILE="./config.json"
    else
        # 从旧容器获取配置
        PORT=$(docker port "$OLD_CONTAINER" 8045 2>/dev/null | cut -d: -f2 || echo "8045")
        DATA_DIR="./data"
        CONFIG_FILE="./config.json"
    fi

    docker run -d \
        --name "$CONTAINER_NAME" \
        --restart unless-stopped \
        -p ${PORT}:8045 \
        -v "$(pwd)/${DATA_DIR}:/app/data" \
        -v "$(pwd)/${CONFIG_FILE}:/app/config.json" \
        "$DOCKER_IMAGE"

    sleep 3

    if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        print_info "容器启动成功！"
    else
        print_error "容器启动失败，查看日志:"
        docker logs "$CONTAINER_NAME"
        exit 1
    fi
}

# 清理旧镜像
cleanup_old_images() {
    print_step "清理旧镜像..."
    docker image prune -f
    print_info "清理完成"
}

# 显示版本信息
show_version() {
    echo
    print_info "获取版本信息..."
    docker exec "$CONTAINER_NAME" node -e "console.log('Node version:', process.version)" 2>/dev/null || true
    docker exec "$CONTAINER_NAME" cat package.json 2>/dev/null | grep version || true
}

# 显示状态
show_status() {
    echo
    echo "======================================"
    print_info "更新完成！"
    echo "======================================"
    echo
    echo "服务状态:"
    docker ps --filter "name=${CONTAINER_NAME}" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
    echo
    echo "常用命令:"
    echo "  查看日志: docker logs -f $CONTAINER_NAME"
    echo "  重启服务: docker restart $CONTAINER_NAME"
    echo "  回滚版本: docker stop $CONTAINER_NAME && docker run ..."
    echo
}

# 主函数
main() {
    echo "======================================"
    echo "  Antigravity 一键更新脚本"
    echo "======================================"
    echo

    print_info "开始更新 $CONTAINER_NAME..."
    echo

    check_docker
    check_container

    # 询问是否备份
    read -p "是否备份数据? (y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        backup_data
    fi

    pull_latest
    stop_container
    start_container
    cleanup_old_images
    show_version
    show_status

    print_info "建议查看日志确认服务正常: docker logs -f $CONTAINER_NAME"
}

main
