# ONLYOFFICE 部署与多 OpenCode 服务连接

当前 `100.64.0.5` + `lcj.lychee-nlp2ai.com` 环境请直接使用 [对应环境的完整操作步骤](deploy-lcj.md)，其中提供可复制的 Compose、config.json 和公网 Nginx 子路径配置。

Office 标签使用可选的 ONLYOFFICE Docs。`.docx/.xlsx/.pptx` 可编辑；其他支持的 Office 格式先只读打开，转换为新版后编辑。未配置时可预览或下载，文本代码编辑不依赖 ONLYOFFICE。

Office 预览和编辑不提供选区加入聊天功能，也不加载选区插件；仅文本文件支持选区引用。反向代理仍需将 `/office-api/*` 转发给桥接以支持文档配置和保存。

WebUI 打开 Office 文件时优先连接文档服务进行只读预览，点击“编辑”后进入编辑模式。文档服务不可用时，新版 Office 文件可回退到基础浏览器预览。编辑器自身的品牌标识仍遵守其版本和许可。

预览与编辑使用独立文档会话和 key。预览配置签名中明确包含 `editorConfig.mode=view` 及禁止编辑、批注、审阅、填写表单等权限，预览会话的写入回调会被桥接拒绝。前端会核对只读配置，桥接版本过旧返回编辑配置时不会直接打开。修改这些模式逻辑时需同步更新前端与桥接代码。

预览限制与缓存：文本编辑上限 8 MiB，普通二进制预览上限 48 MiB，Office 基础浏览器预览上限 12 MiB（还受解压后内容限制）。Office 完整预览直接读取桥接端文件，不先通过浏览器下载全文；桥接 `maxBytes` 默认是 50 MiB，可在配置 JSON 中显式调整，例如 `"maxBytes": 104857600` 表示 100 MiB。调整时还需确认 ONLYOFFICE 本身允许对应格式和文件大小，并在测试后按项目部署约定更新服务。

浏览器内容缓存分两层：内存最多 8 项、总计 64 MiB；IndexedDB 磁盘缓存最多 64 项、内容总计 512 MiB，最长保留 7 天，超过容量按最近使用顺序淘汰。磁盘缓存位于访问 WebUI 的浏览器所在电脑，关闭页面或浏览器后，同一浏览器配置、同一网站地址可继续复用（隐私模式、站点数据清理、浏览器空间回收可能清除缓存）。缓存原始文件字节或预览数据，不缓存运行中的 Office 编辑器，也不保存未保存草稿；重开页面仍需重新排版或连接文档引擎。

每次复用前重新读取服务器 SHA-256，磁盘读取后再次确认版本；指纹变化则重新下载，校验失败则报错而不显示旧缓存。缓存键按服务器、目录、路径和预览类型隔离，并哈希后存储，不写入认证凭据；打开时的服务器权限校验不可省略，因此磁盘缓存不提供离线旧版本预览。浏览器禁用存储或配额写满时自动回退正常读取，内存上限不增加。可在浏览器的本站点数据管理中删除 `opencode-preview-cache-v1` IndexedDB 数据库清空磁盘缓存。

文件传输前后也校验一致性。重新打开、窗口重新聚焦和“重新加载”会触发校验；“重新加载”跳过两级缓存。未保存编辑保留在草稿中，不被磁盘文件自动覆盖，保存仍检查原文件校验和。持续打开期间其他程序的修改不会无限高频轮询，请用“重新加载”立即核验。

本示例按**浏览器从其他电脑访问 WebUI、对接多个 OpenCode 服务**设计，不假设浏览器在服务器本机。所有 `example.com`、`192.0.2.10` 和 `/replace/...` 都是占位符，必须改成实际地址和目录。

## 1. 四类地址不要混用

| 配置或地址 | 谁使用 | 示例 |
| --- | --- | --- |
| WebUI origin / `frontendOrigins` | 校验浏览器请求的来源 | `https://chat.example.com`，开发页可为 `http://服务器IP:2635` |
| `documentServerPublicUrl` | **用户浏览器**加载完整 Office 编辑器 | `https://office.example.com` |
| `documentServerInternalUrl` | **桥接容器**下载编辑结果 | `http://onlyoffice` |
| `bridgeDocumentUrl` | **ONLYOFFICE 容器**读取文档和回调保存 | `http://office-bridge:8093` |

容器内部地址只需容器能访问，不需要浏览器解析。浏览器地址必须是实际可达的域名/IP；HTTPS 的 WebUI 应使用 HTTPS 的 Office 地址。

Compose 中 `127.0.0.1:18092:80` 只表示 **主机上的反向代理通过 18092 访问容器内 80**，不是让浏览器访问 localhost，也不占用主机的 80。官方文档镜像内置 HTTP 服务监听 80；桥接容器监听 8093。主机端口分别使用 18092、18093。

```text
浏览器 → https://chat.example.com/office-api → 主机反向代理 → 桥接 :18093 → 容器 :8093
   └──→ https://office.example.com          → 主机反向代理 → 文档 :18092 → 容器 :80

ONLYOFFICE 容器 ←→ http://office-bridge:8093
桥接容器       → http://onlyoffice
```

## 2. 每个 OpenCode 服务独立映射目录

ONLYOFFICE 不知道 OpenCode 有哪些工作目录。桥接也不会自动同步远程文件。管理员需要给每个 OpenCode 服务指定：

1. WebUI 中使用的服务 URL，例如 `/api`、`/api-mason` 或完整远程 URL。
2. 该服务看到的一个或多个允许访问的目录 `remote`。
3. 桥接容器内对应同一份文件的挂载目录 `local`。

例如：

| 服务 | WebUI 连接地址 | OpenCode 中的目录 | Docker 主机实际目录 | 桥接内挂载 |
| --- | --- | --- | --- | --- |
| A（4097） | `/api` | `/workspace/service-a` | `/srv/opencode-a/projects` | `/projects/service-a` |
| B（4096） | `/api-mason` | `/work/service-b` | `/srv/opencode-b/work` | `/projects/service-b` |

这只是对应关系示例，不是对你主机目录的推断。**A 和 B 即使都显示 `/workspace`，也必须按服务 URL 分别映射到各自挂载，不能共用一个 `OFFICE_PROJECTS_PATH`。**

单个服务有多个不相邻的项目根目录时，在其 `roots` 中增加多个条目，并在 Compose 中增加对应挂载。项目位于已映射根目录的子目录时，不必为每个子项目配置一次。

如果 OpenCode 在另一台机器上，主机 bind mount 不能直接挂载那台机器的目录。必须先让桥接通过共享存储访问那份文件，或者在文件所在机器部署独立桥接。当前代码支持一个桥接访问多个**已挂载**根目录；不支持仅填写远程路径就自动读写远端机器。

## 3. 当前不要求 Office 密码

示例每个 mapping 使用：

```json
"auth": "none"
```

Compose 和环境文件中的用户名、密码已注释，桥接不会要求 Office 登录。请求仍只接受 `frontendOrigins` 指定的网页来源和已映射的目录。**来源检查不是用户身份认证**：在此模式下，能访问桥接接口的客户端可以访问配置范围内的 Office 文档，适用于你已接受的免密码模式。

`ONLYOFFICE_JWT_SECRET` 继续保留，它是文档配置和保存回调的服务间签名密钥，不是用户访问密码。需要在文档服务和桥接中保持一致，也不能放入 `VITE_*` 前端变量。

## 4. 在项目目录准备和启动

以下步骤由管理员执行，项目不会自动操作系统服务。

```bash
cp office-bridge/.env.example .env.office
cp office-bridge/config.example.json office-bridge/config.json
openssl rand -hex 32
```

编辑 `.env.office`：

```dotenv
ONLYOFFICE_JWT_SECRET=填写上面生成的随机字符串
ONLYOFFICE_IMAGE=onlyoffice/documentserver:10.0.0

# 两个独立的主机目录，分别与两个 OpenCode 服务中的文件对应。
OFFICE_MAIN_PROJECTS_PATH=/srv/opencode-a/projects
OFFICE_SECOND_PROJECTS_PATH=/srv/opencode-b/work

# 仅供同机 Nginx/Caddy 代理使用，不是浏览器地址。
OFFICE_BIND_ADDRESS=127.0.0.1
ONLYOFFICE_PORT=18092
OFFICE_BRIDGE_PORT=18093

# 当前不启用密码。
# OFFICE_MAIN_USERNAME=opencode
# OFFICE_MAIN_PASSWORD=自行设置
# OFFICE_SECOND_USERNAME=opencode
# OFFICE_SECOND_PASSWORD=自行设置
```

镜像 tag 固定不等于已验证拉取。若 Docker Hub 不可达，可以自行使用可信镜像加速地址，例如将前缀改为 `docker.m.daocloud.io/onlyoffice/documentserver:10.0.0`；镜像站可用性和 tag 仍需在部署环境核实。

编辑 `office-bridge/config.json`：

```json
{
  "documentServerPublicUrl": "https://office.example.com",
  "documentServerInternalUrl": "http://onlyoffice",
  "bridgeDocumentUrl": "http://office-bridge:8093",
  "frontendOrigins": ["https://chat.example.com", "http://192.0.2.10:2635"],
  "maxBytes": 52428800,
  "mappings": [
    {
      "id": "opencode-4097",
      "apiUrls": ["/api"],
      "auth": "none",
      "roots": [{ "remote": "/workspace/service-a", "local": "/projects/service-a" }]
    },
    {
      "id": "opencode-4096",
      "apiUrls": ["/api-mason"],
      "auth": "none",
      "roots": [{ "remote": "/work/service-b", "local": "/projects/service-b" }]
    }
  ]
}
```

将公网/内网地址、`frontendOrigins` 和 `remote` 改成你的实际值。`id` 只是管理员自定义的稳定标识，端口号不会自动决定路由。

`apiUrls` 可给同一服务列出多个访问别名，例如：

```json
"apiUrls": ["/api", "https://opencode-a.example.com"]
```

只有这些 URL 实际指向**同一个文件服务**时才能放在同一 mapping。相对地址只匹配当前 WebUI 同源的相应路径；完整 URL 精确区分域名、端口和路径。不同 mapping 不能重复匹配同一 URL，歧义会报错，避免读取错误目录。旧版单值 `apiUrl` 仍兼容。

启动独立 Office Compose：

```bash
docker compose --env-file .env.office -f docker-compose.office.yml up -d --build
docker compose --env-file .env.office -f docker-compose.office.yml ps
```

Docker 需要提权的环境自行加 `sudo`。首次启动文档服务可能需要几分钟。目录挂载使用 `create_host_path: false`，主机目录不存在会报错，不会偷偷创建空目录。

同机管理员检查上游服务时可以用以下地址；这些不是用户浏览器的访问地址：

```bash
curl http://127.0.0.1:18092/healthcheck
curl http://127.0.0.1:18093/health
```

文档服务通常返回 `true`，桥接返回 `{"healthy":true}`。

## 5. 公网/内网代理与 local-server.sh

在 `office.example.com` 的现有 HTTPS server 中代理文档服务，并支持 WebSocket：

```nginx
# http 块内；已有同等 map 时复用。
map $http_upgrade $office_connection {
    default upgrade;
    '' close;
}

# office.example.com 的 HTTPS server 块内。
location / {
    proxy_pass http://127.0.0.1:18092;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $office_connection;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 3600s;
}
```

在 `chat.example.com` 的现有 HTTPS server 中代理桥接（去掉 `/office-api` 前缀）：

```nginx
location /office-api/ {
    proxy_pass http://127.0.0.1:18093/;
    proxy_set_header Host $host;
    proxy_set_header Origin $http_origin;
    # 当前免密码；将来启用 Basic 认证时再透传。
    # proxy_set_header Authorization $http_authorization;
}
```

`local-server.sh` 的 Vite 代理默认也转发到主机 `127.0.0.1:18093`，浏览器仍访问 `http://服务器IP:2635/office-api`。将 `http://服务器IP:2635` 加入 `frontendOrigins`；Vite 运行在另一台机器时，用 `OFFICE_BRIDGE_TARGET=http://桥接可达地址:18093 ./local-server.sh` 指定代理上游。

如果通过前端 Docker 的自定义 `Caddyfile.multi` 代理，加入：

```caddyfile
handle_path /office-api/* {
    reverse_proxy office-bridge:8093
}
```

此写法要求前端容器和 Office 容器加入同一 Docker 网络。若走 `host.docker.internal:18093`，仅绑定主机回环通常无法访问；应显式调整桥接发布地址及网络访问规则。推荐同机 Nginx 直接代理，保持上游仅回环监听。

## 6. `/opt/onlyoffice` + systemd 部署

目录结构建议：

```text
/opt/onlyoffice/
  compose.yml
  .env
  Dockerfile.office-bridge
  bridge/
    server.mjs
    config.json
```

项目已提供完整的 `/opt` 布局示例：[compose.opt.example.yml](compose.opt.example.yml)、[Dockerfile.opt.example](Dockerfile.opt.example)，不必手工拼接 `volumes`。**已有 Compose 时先比较备份，保留原有项目名和数据卷名，避免创建另一套空数据库卷。** 下面只展示文件复制目标，不会由项目自动执行：

```bash
# 在项目根目录执行；已有文件时先自行备份，不要直接覆盖管理员配置。
sudo mkdir -p /opt/onlyoffice/bridge
sudo cp office-bridge/server.mjs /opt/onlyoffice/bridge/server.mjs
sudo cp office-bridge/Dockerfile.opt.example /opt/onlyoffice/Dockerfile.office-bridge
# 新建部署可以复制示例；已有部署应先比较/合并。
sudo cp office-bridge/compose.opt.example.yml /opt/onlyoffice/compose.yml
sudo cp office-bridge/config.example.json /opt/onlyoffice/bridge/config.json
sudo cp office-bridge/.env.example /opt/onlyoffice/.env
```

编辑复制后的 `.env` 和 `bridge/config.json`，填写真实地址和两个实际主机目录。该示例不使用 profiles，不需要 `COMPOSE_PROFILES=bridge`；替换旧示例时删除这一旧变量即可。

修改已有 `onlyoffice.service` 时保持你的实际 Docker 路径（先用 `command -v docker` 核对）：

```ini
[Unit]
Description=ONLYOFFICE and file bridge
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/onlyoffice
ExecStart=/usr/bin/docker compose --env-file /opt/onlyoffice/.env -f /opt/onlyoffice/compose.yml up -d
ExecStop=/usr/bin/docker compose --env-file /opt/onlyoffice/.env -f /opt/onlyoffice/compose.yml down
TimeoutStartSec=900
TimeoutStopSec=180

[Install]
WantedBy=multi-user.target
```

手动构建、拉取后启动/重启服务。`active (exited)` 代表 Compose 启动命令已完成，容器状态需通过 `docker compose ps` 检查。不要添加 `down -v`，它会删除文档服务/桥接持久卷。

`system-server.sh` 仍只更新 WebUI；不会启动或重启 `/opt/onlyoffice` 服务。现有的 `/opt/onlyoffice/config.json`、Compose 和系统代理也不会被项目自动修改。

## 7. 将来恢复密码校验

某个 mapping 改为：

```json
"auth": "basic",
"usernameEnv": "OFFICE_MAIN_USERNAME",
"passwordEnv": "OFFICE_MAIN_PASSWORD"
```

JSON 本身不支持注释，因此 `config.json` 用 `auth` 切换；在 `.env` 和 Compose 的 `environment` 中取消对应用户名密码项的注释。免密码 mapping 不读取凭证，Basic mapping 未配置完整凭证会拒绝启动。两种模式可按服务分别设置。代理也需恢复 `Authorization` 透传。

## 保存和验收

- ONLYOFFICE 和桥接共享 JWT secret。只关闭用户密码，不关闭文件令牌、编辑器配置和保存回调的签名验证。
- 保存前检查原文件 SHA-256；外部程序修改过文件时拒绝覆盖，Office 编辑结果保留到桥接 `/data`，顶部显示恢复文件名。成功保存在源目录生成 `.office-时间-会话ID.bak` 备份。
- 会话快照和状态保存在持久卷，桥接重启后可继续接收回调。令牌有效期为 7 天，过期需重开文档。备份和恢复副本由管理员按保留策略清理。
- 启动后分别在 A、B 服务中准备同名文档，确认打开和保存各自对应的真实文件。不要只检查界面显示“已保存”，需要关闭并重新打开，确认桥接顶部落盘时间和实际文件内容。
- 不支持符号链接文件。确认桥接对每个挂载目录有必要的读写权限。非同机服务须先解决共享存储或独立桥接，否则不能连接文件。
- 原生文档服务的字体、公式和复杂格式兼容性需要用实际文档验收。项目提供模拟 DocsAPI、签名回调、路径隔离及多服务保存测试；本次修改不安装镜像，不连接现有 OpenCode 服务。

官方资料：[集成机制](https://api.onlyoffice.com/docs/docs-api/get-started/how-it-works/)、[保存回调](https://api.onlyoffice.com/docs/docs-api/usage-api/callback-handler/)。
