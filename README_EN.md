# OpenCodeUI

[中文](./README.md) | English

A third-party Web frontend for [OpenCode](https://github.com/anomalyco/opencode).

**This project is entirely built with AI-assisted programming (Vibe Coding)** — from the first line of code to the final release, all features were developed through conversations with AI.

> **Disclaimer**: This project is for learning and communication purposes only. We are not responsible for any issues arising from the use of this project. The project is in its early stages and may contain bugs and instabilities.

## Preview

<img width="2298" height="1495" alt="image" src="https://github.com/user-attachments/assets/dc68837b-0560-4701-b6ab-ecb13fdc1f4f" />
<img width="2296" height="1500" alt="image" src="https://github.com/user-attachments/assets/7a8d9754-69c4-49c5-99ee-6452d94f5420" />

## Features

- **Full Chat Interface** — Message streaming, Markdown rendering, code highlighting (Shiki)
- **Built-in Terminal** — Web terminal based on xterm.js with WebGL rendering
- **File Browsing & Diff** — Browse workspace files, multi-file diff comparison
- **Theme System** — 3 built-in themes (Eucalyptus / Claude / Breeze), light/dark mode toggle and custom CSS
- **PWA Support** — Installable as a desktop/mobile app
- **Mobile Friendly** — Safe area handling, touch optimization, responsive layout
- **Browser Notifications** — Push notifications when AI replies are complete
- **@ Mentions & / Slash Commands** — Quickly reference files and execute commands in conversations
- **Custom Shortcuts** — Configurable key bindings
- **Docker Deployment** — Containerized frontend and backend separation, ready to use out of the box
- **Desktop App** — Native client based on Tauri (macOS / Linux / Windows)
- **Dynamic Port Routing** — Auto-discovery of dev services inside containers, generates preview links

## Chat files

- Use **Attach file**, drag files into the composer, or paste files. Multiple attachments are supported.
- Attachments are sent to the conversation's OpenCode server. That server's `opencode-better-file-upload` plugin handles document conversion; text and code attachments are sent as readable context.
- Ask the assistant to link generated files, for example `[Download report](./output/report.docx)`, then click the link to save. File attachments in messages and tool results can also be expanded and saved.
- Downloads read original bytes through the conversation server's terminal API, including PDF, Office, and ZIP files. Terminal connections must be available. Linux/macOS requires `sh` and `base64`; Windows requires PowerShell. Downloads are limited to approximately 96 MiB per file and report failures on timeout or disconnect.
- The backend configuration editor has been removed from Settings. Administrators should manage configuration in each OpenCode server's native WebUI.

## Project file management

- File tabs, panel visibility, and terminal layouts are isolated by OpenCode server. Switching unloads the previous server's preview/editor and closes fullscreen, then enters the target server's panel state. First visits have no file tabs; returning restores that server's tabs. Unsaved text buffers remain attached to their original server, in page memory only. Terminal snapshots use server and directory together, and late responses from another server cannot overwrite the visible panel.

- Project navigation is rooted at each OpenCode server's `/path` response `directory`. Parent navigation, typed outside paths and outside URL projects are blocked; old outside projects and escaping tree entries are filtered. This is a WebUI navigation boundary, not a server sandbox. Direct APIs, terminals and symlink isolation still require backend filesystem permissions or container mounts. The Office bridge separately checks real paths against its administrator-defined roots.
- Office defaults to local read-only preview; the online editor loads only after **Edit**. Word has a document preview, Excel shows a bounded content table, and PowerPoint shows slide text. Use editing/download for full layout or legacy formats. Returning from editing reloads the file. The WebUI uses generic editing labels; the document service's own branding remains subject to its edition and license.

- The left sidebar opens the current project's **Files** by default, with **Recents** and **Active** available for conversations. With no project selected, it uses the selected OpenCode server's working directory. The global project entry is removed.
- Click a file or choose **Open in right panel** from its context menu. The right panel supports file tabs, reordering, closing, fullscreen, and downloading. Previews retain their project directory and server identity when the focused conversation changes.
- The right text editor supports Markdown, TXT, TeX and common programming files, syntax highlighting, line numbers, undo, search, and Ctrl/Cmd+S. Markdown can switch to preview. Unsaved buffers survive tab switches; closing or switching projects asks before discarding, and browser refresh warns about unsaved changes. UTF-8 text is supported with BOM and CRLF preservation, up to 2 MiB.
- Every editable text file has Edit/Preview modes using the current unsaved draft. HTML/HTM/XHTML render in an isolated iframe and resolve project-relative CSS, JS and image dependencies on the file's server (64 dependencies, 4 MiB each, 16 MiB total). SVG renders as an isolated image; CSV/TSV tables show up to 200 rows and 50 columns; JSON/JSONL format read-only or fall back to raw text. Markdown aliases and standalone Mermaid diagrams render locally. Code, config, logs and TeX have highlighted source previews without executing build/compile commands. MDX previews Markdown without executing JSX; Vue/Svelte/TSX applications still need their development server. Returning to Edit retains undo history.
- Office files use the optional full **ONLYOFFICE Docs** editor. The former XML content editor has been removed. `.docx/.xlsx/.pptx` support editing; legacy formats and ODF open in view mode and can be converted first. Without configured services, use preview/download; `.docx` has a local preview. Administrators deploy the independent document server and file bridge and configure project directory mappings. See [ONLYOFFICE deployment](office-bridge/README.md). Services are not automatically installed or started.
- Saving checks the original SHA-256, rejects external changes, atomically replaces the file, and keeps a uniquely named `.bak` copy beside it. Linux/macOS also needs `sha256sum` or `shasum`. Reload discards edits and reads the latest file from disk.
- Images use Blob URLs that are released on close; ordinary PNG/JPEG reads use the native file API. Preview size is limited to approximately 12 MiB; PNGs also have a 40 million pixel and 16384-pixel edge limit. Download oversized files instead. PDFs remain read-only in the browser's built-in viewer.
- Upload or drop files into the project root, or right-click a folder to upload there. Existing files are never overwritten. Uploads support files up to 64 MiB; downloads support approximately 96 MiB.
- Workspace transfers and binary previews use the server's terminal WebSocket API. They require filesystem permissions and a proxy that supports WebSocket. Linux/macOS requires `sh` and `base64`; Windows requires PowerShell. Download PDFs if the browser's PDF viewer is disabled.

## Tech Stack

| Category          | Technology                     |
| ----------------- | ------------------------------ |
| Framework         | React 19 + TypeScript          |
| Build             | Vite 7                         |
| Styling           | Tailwind CSS v4                |
| Code Highlighting | Shiki                          |
| Terminal          | xterm.js (WebGL)               |
| Markdown          | react-markdown + remark-gfm    |
| Desktop           | Tauri 2                        |
| Deployment        | Docker (Caddy + Python Router) |

## Quick Start

No deployment needed — after starting the OpenCode backend locally, access the hosted frontend directly:

```bash
opencode serve --cors "https://lehhair.github.io"
```

Then open https://lehhair.github.io/OpenCodeUI/

## Docker Deployment (Frontend Only)

For scenarios where `opencode serve` is already running, you only need a frontend UI container to connect to the existing backend.

```bash
git clone https://github.com/lehhair/OpenCodeUI.git
cd OpenCodeUI

# Start (connects to host's opencode serve :4096 by default)
docker compose -f docker-compose.standalone.yml up -d
```

Visit `http://localhost:3000`.

**Connect to a remote backend:**

```bash
BACKEND_URL=your-server.com:4096 PORT=8080 docker compose -f docker-compose.standalone.yml up -d
```

| Environment Variable | Default                     | Description                                      |
| -------------------- | --------------------------- | ------------------------------------------------ |
| `BACKEND_URL`        | `host.docker.internal:4096` | opencode serve address (without protocol prefix) |
| `PORT`               | `3000`                      | Frontend listening port                          |

**When the backend enables password auth (`OPENCODE_SERVER_PASSWORD`):**

After you enter the username/password in the frontend's server connection dialog, the frontend automatically attaches an `Authorization: Basic <base64>` header to every request. The built-in Caddy config explicitly forwards this header, so no extra setup is needed.

If you use a custom Caddyfile (or hit 401 auth failures), add this to the `reverse_proxy` block:

```caddyfile
handle_path /api/* {
	reverse_proxy your-opencode-serve:4096 {
		header_up Host {upstream_hostport}
		header_up Authorization {http.request.header.Authorization}
		flush_interval -1
	}
}
```

Mount the custom config via `docker-compose.standalone.yml`:

```yaml
volumes:
  - ./Caddyfile.standalone:/etc/caddy/Caddyfile.standalone:ro
```

## Docker Deployment

### Architecture & Ports

The deployment consists of three services, unified through the Gateway:

| Service  | Port                  | Description                                         |
| -------- | --------------------- | --------------------------------------------------- |
| Gateway  | 6658 (`GATEWAY_PORT`) | Unified entry point, reverse proxy for all requests |
| Gateway  | 6659 (`PREVIEW_PORT`) | Dev service preview                                 |
| Frontend | 3000 (internal)       | Static frontend                                     |
| Backend  | 4096 (internal)       | OpenCode API                                        |
| Router   | 7070 (internal)       | Dynamic port routing (built into Gateway)           |

### Gateway Routing Rules

Requests on port `6658` are forwarded according to these rules:

| Path         | Target         | Description                    |
| ------------ | -------------- | ------------------------------ |
| `/api/*`     | Backend :4096  | OpenCode API, supports SSE     |
| `/routes`    | Router :7070   | Dynamic route management panel |
| `/preview/*` | Router :7070   | Preview port switching API     |
| Other        | Frontend :3000 | Frontend static assets         |

Port `6659` is used to access dev services inside the container. The Router automatically scans ports `3000-9999` and generates preview links via the `/p/{token}/` path.

### Deployment Steps

```bash
git clone https://github.com/lehhair/OpenCodeUI.git
cd OpenCodeUI

# Copy and edit environment variables, fill in at least one LLM API Key
cp .env.example .env

# Start
docker compose up -d
```

Visit `http://localhost:6658`.

### Environment Persistence (Simplified)

The backend now retains only one core persistent volume: `opencode-home` (mounted at `/root`).

The backend entry script automatically verifies and supplements `opencode` / `mise` on startup to prevent toolchain loss after container rebuilds.

- OpenCode configuration and session cache
- npm / cargo / pip and other user-space caches
- Node / Python multi-version runtimes installed via `mise`

All of the above will be preserved after container rebuilds — no need to split into multiple small volumes.

When upgrading from older versions, the original `opencode-data/opencode-config/opencode-cache/opencode-npm/opencode-cargo/opencode-local/opencode-opt` volumes become orphaned and can be manually cleaned up after confirming data has been migrated.

First time entering the backend container, you can install and persist runtime versions directly:

```bash
docker compose exec backend mise use -g node@22 python@3.12
docker compose exec backend node -v
docker compose exec backend python -V
```

The `gateway` still retains a separate volume `opencode-router-data` for storing dynamic routing state.

### Environment Variables

Edit the `.env` file with the key configuration:

```env
# LLM API Key (fill in at least one)
ANTHROPIC_API_KEY=
OPENAI_API_KEY=

# Ports
GATEWAY_PORT=6658
PREVIEW_PORT=6659

# Working directory (mounted to /workspace in the container)
WORKSPACE=./workspace

# Must be set for public deployment
OPENCODE_SERVER_USERNAME=opencode
OPENCODE_SERVER_PASSWORD=your-strong-password

# Router service
ROUTER_SCAN_INTERVAL=5
ROUTER_PORT_RANGE=3000-9999
ROUTER_EXCLUDE_PORTS=4096
```

### Reverse Proxy

Docker listens on `127.0.0.1` by default; public deployment requires a reverse proxy in front.

**Nginx:**

```nginx
server {
    listen 443 ssl;
    server_name opencode.example.com;

    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:6658;
        proxy_http_version 1.1;

        # SSE (required)
        proxy_set_header Connection '';
        proxy_buffering off;
        proxy_cache off;

        # WebSocket
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400s;
    }
}

# Preview (optional, recommended to use a separate domain)
server {
    listen 443 ssl;
    server_name preview.example.com;

    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:6659;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400s;
    }
}
```

**Caddy:**

```caddyfile
opencode.example.com {
    reverse_proxy 127.0.0.1:6658 {
        flush_interval -1
    }
}

preview.example.com {
    reverse_proxy 127.0.0.1:6659
}
```

> **Important**: SSE requires buffering to be disabled. Nginx needs `proxy_buffering off`, Caddy needs `flush_interval -1`.

## Local Development

Requires a running [OpenCode](https://github.com/anomalyco/opencode) backend.

```bash
opencode serve

# In another terminal
git clone https://github.com/lehhair/OpenCodeUI.git
cd OpenCodeUI
npm install
npm run dev
```

Vite starts at `http://localhost:5173`, `/api` is automatically proxied to `http://127.0.0.1:4096`.

### Pre-PR Validation

Before opening a PR, run the same validation steps locally that CI uses:

```bash
npm run validate
```

This command runs TypeScript validation, ESLint, unit tests, and a production build in sequence.

If you prefer the hyphenated name, this alias is also available:

```bash
npm run type-check
```

GitHub Actions runs the same checks in the `Build Validation` workflow for every PR and every push to `main`.

### Release Preparation

For a real release, prefer the command below. It runs the full validation suite first, then updates versions and the changelog:

```bash
npm run release:prepare -- 0.2.0
```

After it finishes, follow the printed `git commit`, `git tag`, and `git push` steps.

## Desktop App

Download the installer from [Releases](https://github.com/lehhair/OpenCodeUI/releases), or build locally:

```bash
npm install
npm run tauri build
```

> **macOS users**: If the app shows "cannot be opened because the developer cannot be verified" and gets moved to Trash, run this command in Terminal to remove the quarantine attribute:
>
> ```bash
> xattr -d com.apple.quarantine /Applications/OpenCode.app
> ```

## Project Structure

```
src/
├── api/                 # API request wrappers
├── components/          # Common components (Terminal, DiffView, etc.)
├── features/            # Business modules
│   ├── chat/            #   Chat interface
│   ├── message/         #   Message rendering
│   ├── sessions/        #   Session management
│   ├── settings/        #   Settings panel
│   ├── mention/         #   @ mentions
│   └── slash-command/   #   Slash commands
├── hooks/               # Custom Hooks
├── store/               # State management
├── themes/              # Theme presets
└── utils/               # Utility functions

src-tauri/               # Tauri desktop app (Rust)
docker/                  # Docker config (Gateway / Frontend / Backend)
```

## Design Notes

Some UI styles are inspired by the [Claude](https://claude.ai) interface design.

## Related Project

- [PiUI](https://github.com/lehhair/PiUI) — A frontend for the Pi coding agent that shares OpenCodeUI's UI design and interaction patterns

## License

[GPL-3.0](./LICENSE)

## Star History

<a href="https://www.star-history.com/#lehhair/OpenCodeUI&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=lehhair/OpenCodeUI&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=lehhair/OpenCodeUI&type=Date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=lehhair/OpenCodeUI&type=Date" />
 </picture>
</a>

---

_This project is driven by Vibe Coding. If you're also interested in AI-assisted programming, feel free to connect._
