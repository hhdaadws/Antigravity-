#!/bin/bash

#############################################
# Antigravity 一键部署脚本
# 功能：自动安装Docker、拉取镜像并启动服务
#############################################

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 配置
DOCKER_IMAGE="miku66/arg:latest"
CONTAINER_NAME="antigravity"
DATA_DIR="./data"
CONFIG_FILE="./config.json"
PORT=8045

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

# 检查是否以root运行
check_root() {
    if [ "$EUID" -ne 0 ]; then
        print_warn "建议使用 sudo 运行此脚本"
        read -p "是否继续? (y/n) " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            exit 1
        fi
    fi
}

# 检测系统类型
detect_os() {
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        OS=$ID
        VERSION=$VERSION_ID
    else
        print_error "无法检测操作系统"
        exit 1
    fi
    print_info "检测到操作系统: $OS $VERSION"
}

# 安装Docker
install_docker() {
    if command -v docker &> /dev/null; then
        print_info "Docker 已安装"
        docker --version
        return 0
    fi

    print_info "开始安装 Docker..."

    case $OS in
        ubuntu|debian)
            sudo apt-get update
            sudo apt-get install -y ca-certificates curl gnupg
            sudo install -m 0755 -d /etc/apt/keyrings
            curl -fsSL https://download.docker.com/linux/$OS/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
            sudo chmod a+r /etc/apt/keyrings/docker.gpg
            echo \
              "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/$OS \
              $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
              sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
            sudo apt-get update
            sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
            ;;
        centos|rhel|fedora)
            sudo yum install -y yum-utils
            sudo yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
            sudo yum install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
            sudo systemctl start docker
            sudo systemctl enable docker
            ;;
        *)
            print_error "不支持的操作系统: $OS"
            print_info "请手动安装 Docker: https://docs.docker.com/engine/install/"
            exit 1
            ;;
    esac

    # 将当前用户添加到docker组
    if [ "$EUID" -eq 0 ]; then
        usermod -aG docker $SUDO_USER 2>/dev/null || true
    else
        sudo usermod -aG docker $USER
    fi

    print_info "Docker 安装完成"
    docker --version
}

# 创建数据目录
create_data_dir() {
    if [ ! -d "$DATA_DIR" ]; then
        print_info "创建数据目录: $DATA_DIR"
        mkdir -p "$DATA_DIR"
    else
        print_info "数据目录已存在: $DATA_DIR"
    fi
}

# 创建配置文件
create_config() {
    if [ ! -f "$CONFIG_FILE" ]; then
        print_info "创建配置文件: $CONFIG_FILE"
        cat > "$CONFIG_FILE" << 'EOF'
{
  "port": 8045,
  "apiEndpoint": "https://generativelanguage.googleapis.com/v1beta/models",
  "adminUsername": "admin",
  "adminPassword": "admin123",
  "tokenExpiry": 3600000,
  "corsOrigins": ["*"],
  "securityConfig": {
    "maxRegistrationsPerIP": 5,
    "maxRegistrationsPerDevice": 3,
    "registrationWindow": 86400000,
    "inactiveAccountDays": 30,
    "suspiciousThreshold": 10,
    "deviceBanDuration": 2592000000
  },
  "systemPrompt": ""
}
EOF
        print_warn "已创建默认配置文件，请修改管理员密码！"
    else
        print_info "配置文件已存在"
    fi
}

# 停止旧容器
stop_old_container() {
    if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        print_info "停止并删除旧容器..."
        docker stop "$CONTAINER_NAME" 2>/dev/null || true
        docker rm "$CONTAINER_NAME" 2>/dev/null || true
    fi
}

# 拉取Docker镜像
pull_image() {
    print_info "拉取 Docker 镜像: $DOCKER_IMAGE"
    docker pull "$DOCKER_IMAGE"
}

# 启动容器
start_container() {
    print_info "启动容器: $CONTAINER_NAME"
    docker run -d \
        --name "$CONTAINER_NAME" \
        --restart unless-stopped \
        -p ${PORT}:8045 \
        -v "$(pwd)/${DATA_DIR}:/app/data" \
        -v "$(pwd)/${CONFIG_FILE}:/app/config.json" \
        "$DOCKER_IMAGE"

    # 等待容器启动
    sleep 3

    if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        print_info "容器启动成功！"
    else
        print_error "容器启动失败"
        docker logs "$CONTAINER_NAME"
        exit 1
    fi
}

# 显示状态
show_status() {
    echo
    echo "======================================"
    print_info "部署完成！"
    echo "======================================"
    echo
    echo "服务信息:"
    echo "  容器名称: $CONTAINER_NAME"
    echo "  访问地址: http://localhost:$PORT"
    echo "  数据目录: $DATA_DIR"
    echo "  配置文件: $CONFIG_FILE"
    echo
    echo "常用命令:"
    echo "  查看日志: docker logs -f $CONTAINER_NAME"
    echo "  停止服务: docker stop $CONTAINER_NAME"
    echo "  启动服务: docker start $CONTAINER_NAME"
    echo "  重启服务: docker restart $CONTAINER_NAME"
    echo "  删除容器: docker rm -f $CONTAINER_NAME"
    echo
    echo "Web界面:"
    echo "  管理面板: http://localhost:$PORT/admin.html"
    echo "  用户面板: http://localhost:$PORT/user.html"
    echo
}

# 主函数
main() {
    echo "======================================"
    echo "  Antigravity 一键部署脚本"
    echo "======================================"
    echo

    check_root
    detect_os
    install_docker
    create_data_dir
    create_config
    stop_old_container
    pull_image
    start_container
    show_status
}

main
