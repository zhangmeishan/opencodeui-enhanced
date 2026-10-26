# 当前两台机器的固定接法

本文针对已给定的部署，不使用其他域名或局域网自签证书：

| 角色 | 地址/路径 |
| --- | --- |
| 公网机器 | 现有 Nginx，域名 `lcj.lychee-nlp2ai.com` |
| 内网机器 | `100.64.0.5`，运行 OpenCode、WebUI、Office Docker |
| 开发 WebUI | `http://100.64.0.5:2635` |
| 系统 WebUI | `https://lcj.lychee-nlp2ai.com`，继续使用现有代理 |
| Office 浏览器地址 | `https://lcj.lychee-nlp2ai.com/onlyoffice` |
| liucj OpenCode | 4097，WebUI `/api`，目录 `/home/liucj/workspace` |
| masonzms OpenCode | 4096，WebUI `/api-mason`，目录 `/home/masonzms/opencode_workspace` |

以上沿用当前项目已有的端口归属。浏览器无需访问内网 Office 地址；公网机器必须能连接 `100.64.0.5:8092`。桥接不发布到公网，系统 WebUI 通过同一 Docker 网络访问它。

## A. 内网机器：Office 服务

在 `/home/masonzms/opencode_workspace/opencodeui` 中操作。先备份已有部署文件：

```bash
sudo cp -a /opt/onlyoffice/compose.yml /opt/onlyoffice/compose.yml.before-path-proxy
sudo cp -a /opt/onlyoffice/.env /opt/onlyoffice/.env.before-path-proxy
sudo cp -a /opt/onlyoffice/bridge/config.json /opt/onlyoffice/bridge/config.json.before-path-proxy
```

编辑 `/opt/onlyoffice/.env`：保留现有 `ONLYOFFICE_JWT_SECRET`，镜像继续使用已经拉取成功的版本。删除旧的 `COMPOSE_PROFILES`、`OFFICE_PROJECTS_PATH`，添加：

```dotenv
MASON_PROJECTS_PATH=/home/masonzms/opencode_workspace
LIUCJ_PROJECTS_PATH=/home/liucj/workspace
```

密码仍不用填。所有 `${变量:?提示}` 保留原样；Compose 从 `.env` 读取实际值。

项目已提供与本环境完全对应的文件内容，可复制：

```bash
sudo cp office-bridge/compose.lcj.example.yml /opt/onlyoffice/compose.yml
sudo cp office-bridge/config.lcj.example.json /opt/onlyoffice/bridge/config.json
sudo cp office-bridge/server.mjs /opt/onlyoffice/bridge/server.mjs
sudo cp office-bridge/Dockerfile.opt.example /opt/onlyoffice/Dockerfile.office-bridge
```

文件全文分别见 [Compose](compose.lcj.example.yml)、[桥接配置](config.lcj.example.json)、[Dockerfile](Dockerfile.opt.example)。保留 `name: onlyoffice`、现有 `document-*` 数据卷名；不删除卷。

**必须使用本次更新的 `server.mjs`**：它支持 `/onlyoffice` 子路径的保存下载地址重写，只改 Nginx 而使用旧桥接可能导致保存失败。

不需要新增 `office-lan-tls`、`Caddyfile.office` 或根证书；若之前已实际添加此容器，合并配置时删除该服务，用 `docker compose ... up -d --remove-orphans` 移除不再定义的旧容器，且不要加 `-v` 删除卷。

现有 `/etc/systemd/system/onlyoffice.service` 不必修改。检查、构建和应用：

```bash
sudo docker compose --env-file /opt/onlyoffice/.env -f /opt/onlyoffice/compose.yml config --quiet
sudo docker compose --env-file /opt/onlyoffice/.env -f /opt/onlyoffice/compose.yml build office-bridge
sudo systemctl restart onlyoffice.service
sudo docker compose --env-file /opt/onlyoffice/.env -f /opt/onlyoffice/compose.yml ps
curl http://100.64.0.5:8092/healthcheck
curl http://127.0.0.1:18093/health
```

`8092:80` 的 80 是容器内官方 HTTP 监听端口，不占主机 80；`18093:8093` 的 18093 给同机开发代理使用。文档服务的发布从回环改为内网地址，以便另一台公网代理连接；按你的网络策略仅允许该代理主机访问此端口。

## B. 公网机器：现有 Nginx

只在现有 `lcj.lychee-nlp2ai.com` 的 HTTPS `server` 块增加 [完整 location 片段](nginx.lcj.location.example.conf)。不要替换 `server` 全文，也不要替换现有 OpenCodeUI 的 `location /`。证书路径无需变化。

关键规则：`proxy_pass http://100.64.0.5:8092/` 去掉公开前缀，`X-Forwarded-Host $http_host/onlyoffice` 让 ONLYOFFICE 正确生成带前缀的脚本、资源、WebSocket 和保存地址。

修改文件名取决于现有 Nginx 配置。可在公网机器执行 `sudo nginx -T` 定位域名的 HTTPS server 块，备份该文件后编辑。随后：

```bash
sudo nginx -t
sudo systemctl reload nginx
curl https://lcj.lychee-nlp2ai.com/onlyoffice/healthcheck
curl -I https://lcj.lychee-nlp2ai.com/onlyoffice/web-apps/apps/api/documents/api.js
```

正常健康检查为 `true`，脚本 URL 应返回 JavaScript（不是 WebUI 的 HTML）。如果 502，先在公网机器测试 `curl http://100.64.0.5:8092/healthcheck`，核对两台机器间连通性。这一步是新增公网访问路径，不是新增域名/公网端口。

## C. 内网机器：开发版 WebUI

源码 `vite.config.ts` 已修正三条代理：`/office-api` → 本机 18093；`/api-mason` → 4096；`/api` → 4097。`/api-mason` 必须放在 `/api` 前面。

项目 `.env.local` 中保留/设置 `VITE_API_BASE_URL=/api`；如设置过 `VITE_OFFICE_BRIDGE_URL`，删除旧值或设为 `/office-api`。无需把公网 Office 地址填到 Vite 中，编辑器地址由桥接下发。

```bash
./local-server.sh
```

浏览器打开 `http://100.64.0.5:2635`。设置里的两个 OpenCode 地址分别是 `/api`、`/api-mason`。Office 文件进入公网 `/onlyoffice` 编辑器，文档读写由内部容器链路完成。

## D. 内网机器：系统版 WebUI

修改部署目录 `/opt/opencodeui/docker-compose.local.yml`：

```yaml
services:
  frontend:
    image: opencodeui-frontend:local
    build:
      context: .
      dockerfile: docker/Dockerfile.frontend
    volumes:
      - ./Caddyfile.multi:/etc/caddy/Caddyfile.standalone:ro
    networks:
      - default
      - office
networks:
  office:
    external: true
    name: onlyoffice_default
```

`onlyoffice_default` 由 `name: onlyoffice` 的 Compose 创建。修改 `/opt/opencodeui/Caddyfile.multi`，保留两个现有 OpenCode 路由，在静态 `handle` 之前增加：

```caddyfile
handle_path /office-api/* {
    reverse_proxy office-bridge:8093
}
```

公网 Nginx 现有 `location /` 会将 `/office-api` 请求转到系统 WebUI，再由其 Caddy 访问桥接；无需把桥接主机端口暴露给公网代理。如果现有 Nginx 对 `/office-api` 另有覆盖规则，需取消该旧规则，让其走 WebUI 上游。

先启动 Office，再从源码目录运行 `./system-server.sh`。它会保留部署目录里的 `docker-compose.local.yml` 和 `Caddyfile.multi`。现有 `opencodeui.service` 继续使用原端口/环境，不改成其他前端端口。确认该 unit 使用上述两份 Compose 配置。

## E. 验收

1. 浏览器打开 `https://lcj.lychee-nlp2ai.com/onlyoffice/healthcheck`，确认无证书错误且返回 `true`。
2. 开发版先分别选择 `/api` 和 `/api-mason`，在两个目录中各用一份测试 `.docx/.xlsx/.pptx`。
3. 编辑保存后，确认 WebUI 显示“已保存到项目”时间，再关闭、重新打开，并核对实际源文件。
4. 运行系统版后重复测试。公网用户无需访问 `100.64.0.5`；公网 Nginx 负责访问该地址。
5. 出错可查看 `docker compose --env-file /opt/onlyoffice/.env -f /opt/onlyoffice/compose.yml logs --tail 100 office-bridge onlyoffice`。不要删除数据卷来修复连接。

当前配置按要求为 `auth: none`，无需用户密码；JWT 服务签名仍保留。Office 公网路径本身对能访问该域名的客户端可达，这是纯公网浏览器编辑所需的连接路径。
