#!/usr/bin/env bash
set -euo pipefail

# 同步源码，保留部署目录中的环境和代理配置。
sudo rsync -av \
  --exclude='.git/' \
  --exclude='node_modules/' \
  --exclude='dist/' \
  --exclude='.env*' \
  --exclude='docker-compose.local.yml' \
  --exclude='Caddyfile.multi' \
  --exclude='office-bridge/config.json' \
  --exclude='office-data/' \
  /home/masonzms/opencode_workspace/opencodeui/ \
  /opt/opencodeui/

# 设置部署目录权限。
sudo chown -R root:root /opt/opencodeui
sudo chmod -R go-w /opt/opencodeui

# 构建部署镜像。
cd /opt/opencodeui
sudo docker compose \
  -f docker-compose.standalone.yml \
  -f docker-compose.local.yml \
  build

# 返回源码目录，重启并查看服务状态。
cd /home/masonzms/opencode_workspace/opencodeui/
sudo systemctl restart opencodeui.service
sudo systemctl status opencodeui.service
