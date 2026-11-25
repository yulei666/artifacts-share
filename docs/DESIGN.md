# Artifacts Share — 可行性分析与设计（v2）

> 目标：用一个 Cloudflare Worker + D1 + R2 实现类似 claude.ai Artifacts 的分享系统。
>
> - 主域名（管理后台 + API）：`share.example.com`
> - 内容域名（每个 artifact 一个子域）：`{uuid}-share.example-content.com`
> - 单用户；Workers **Paid** 计划。

## 变更记录

| 版本 | 变更 |
|---|---|
| v1 | 初版 |
| v9 | 版本记录对应的上传会话（`artifact_versions.upload_id`，迁移 `0003`）：提交成功后重试提交返回 `409 upload_closed`，不再是 404；孤立清单行分批清理 |
| v8 | 上传会话的文件清单改为按行存储（`upload_expected` 表 + `uploads.manifest` 状态列，迁移 `0002`），不再受 D1 单值约 2 MB 的限制；提交时用 SQL 校验缺失文件。`npm run deploy` 先执行远程迁移再部署代码 |
| v7 | 失败计数从第一次失败开始；访问码提示剩余次数和等待时间；访问码输入失败 3 次后启用 Turnstile |
| v6 | 管理员用户名（可配置、可在后台修改）；登录页 Cloudflare Turnstile（同一 IP 失败 3 次后启用） |
| v5 | 分享页下载：单文件下载 HTML、多文件下载 ZIP；访客下载默认关闭 |
| v4 | 分享链接改为主域名分享页（顶部工具栏 + iframe），内容子域名只允许被主域名嵌入 |
| v3 | 子域名与内部 id 解耦（`public_id`），支持重新生成链接；子域名后缀可配置（`CONTENT_HOST_SUFFIX`，默认 `-share`）；中英双语；文档改用示例域名 |
| v2 | 主域改为 `share.example.com`；访问码固定为字母+数字；服务端 zip 解压做成后台开关（默认关闭）；新增 SSO 登录（Google / GitHub / Cloudflare，各绑定 1 个账号，后台配置）；去掉过期时间；默认禁止搜索引擎收录 |

---

## 1. 可行性结论

**可行，全部功能在一个 Worker 内完成。**

| 需求 | 方案 | 结论 |
|---|---|---|
| 主域 | `share.example.com` → Worker Custom Domain（或 Route） | ✅ |
| 泛子域 | `example-content.com` 上 DNS `*` 记录（Proxied）+ Route `*.example-content.com/*` | ✅ Custom Domain 不支持通配，必须用 Route |
| HTTPS 证书 | `{uuid}-share.example-content.com` 是一级子域，Universal SSL 免费覆盖 | ✅ |
| 单 HTML / 文件夹 | 单 HTML = 只有 `index.html` 的文件夹，统一建模 | ✅ |
| 前端 / API 上传 | 前端浏览器逐文件上传；API 支持 HTML / multipart / 分批会话 / zip（开关） | ✅ |
| 私有 / 公开 / 凭密 | 内容子域上由 Worker 做访问网关 | ✅ |
| 多 Token | D1 存哈希，后台管理 | ✅ |
| 密码 + SSO 登录 | 自建密码 + OAuth/OIDC（Google、GitHub、Cloudflare），后台配置与绑定 | ✅ Cloudflare 走 Access for SaaS（OIDC），见 §6.3 |

### 1.1 域名拆分带来的安全收益

已核实：

- 主域名 `example.com` 与内容域名 `example-content.com` 是两个**不同的可注册域名**（eTLD+1，按 Public Suffix List 判定）。
- 如果内容域名是某个公共后缀下的子域（例如 `foo.<psl-suffix>`），要确认该后缀确实在 PSL 中，否则它会和同后缀下的其他站点同站。

于是**后台与所有 artifact 内容跨站（cross-site）**，与 claude.ai / claudeusercontent.com 的隔离模型一致：

- 后台会话 Cookie 可用 `SameSite=Lax`，artifact 页面里的 JS 发往后台的请求不会携带它，CSRF 风险基本消除（仍保留 Origin 校验作为纵深防御）。
- artifact 之间仍是 same-site（都在 `example-content.com` 下），靠 `__Host-` Cookie + HttpOnly 隔离，见 §7。

> 前提：两个 zone 在同一个 Cloudflare 账号下（一个 Worker 只能绑定本账号的 zone）。

### 1.2 平台限制（Paid）

| 项 | Paid 限制 | 影响 |
|---|---|---|
| CPU 时间 | 默认 30s，`[limits] cpu_ms` 可调至 300000（5 min） | 开启服务端 zip 解压时建议调高 |
| 请求体 | 100 MB（取决于 zone 计划，Free/Pro zone 为 100MB） | 单次上传 ≤ 100MB；更大的内容走分批会话 |
| 子请求 | 每请求 1000（Paid） | zip 内文件数 ≤ ~900 |
| D1 / R2 | 单用户量级远低于上限；R2 出口免费 | — |

---

## 2. 总体架构

```
                   ┌──────────────────── Cloudflare Edge ─────────────────────┐
                   │  zone example.com      Custom Domain: share.example.com  │
 浏览器 / CLI ────▶ │  zone example-content.com Route: *.example-content.com/* │
                   │                    │                                     │
                   │                    ▼                                     │
                   │   ┌──────────────────── Worker ─────────────────────┐    │
                   │   │ hostname 分发                                   │    │
                   │   │ ├─ share.example.com  → 管理端                  │    │
                   │   │ │   /             后台 SPA（Static Assets）     │    │
                   │   │ │   /api/*        REST API / 登录 / OAuth 回调  │    │
                   │   │ │   /handoff      私有预览授权跳转              │    │
                   │   │ ├─ {uuid}-share.example-content.com → 内容端    │    │
                   │   │ │   /__share/*    解锁页 / 授权回调（保留）     │    │
                   │   │ │   /*            访问控制 → R2                 │    │
                   │   │ └─ 其它 host → 404                              │    │
                   │   └───────┬──────────────────────┬──────────────────┘    │
                   │           ▼                      ▼                       │
                   │      D1（元数据/配置）          R2（文件）               │
                   └──────────────────────────────────────────────────────────┘
                                │ OAuth / OIDC
                                ▼
              accounts.google.com · github.com · <team>.cloudflareaccess.com
```

技术栈：TypeScript + Hono + Workers Static Assets（后台 SPA：原生 JS、无构建，满足严格 CSP）+ fflate（zip，服务端与浏览器端共用）+ Wrangler。

### 2.1 Cloudflare 配置

1. DNS
   - zone `example.com`：`share` 由 Custom Domain 自动创建，无需手动加
   - zone `example-content.com`：`*` → `AAAA 100::`，Proxied
2. `wrangler.toml`

```toml
name = "artifacts-share"
main = "src/index.ts"
compatibility_date = "2026-11-01"

routes = [
  { pattern = "share.example.com", custom_domain = true },
  { pattern = "*.example-content.com/*", zone_name = "example-content.com" },
]

[limits]
cpu_ms = 300000            # Paid：为服务端 zip 解压预留；不开 zip 也无害

[assets]
directory = "./web/dist"
binding = "ASSETS"
run_worker_first = true    # 关键：否则静态资源会在内容子域上被直接命中

[[d1_databases]]
binding = "DB"
database_name = "artifacts-share"
database_id = "..."

[[r2_buckets]]
binding = "BUCKET"
bucket_name = "artifacts-share"

[triggers]
crons = ["17 3 * * *"]     # 清理孤儿上传、已删除 artifact、超额旧版本

[vars]
MAIN_HOST = "share.example.com"
CONTENT_ZONE = "example-content.com"
CONTENT_HOST_SUFFIX = "-share"   # 子域名 = {public_id}{suffix}.{CONTENT_ZONE}，可为空；改动会使所有旧链接失效

# secrets（wrangler secret put）:
#   SECRET_KEY                  —— 主密钥，派生 HMAC 签名密钥与 AES-GCM 加密密钥（HKDF）
#   ADMIN_BOOTSTRAP_PASSWORD    —— 首次登录用；在后台设置正式密码后失效
```

3. 内容子域识别：

```ts
const CONTENT_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-share\.artifacts\.cc\.cd$/;
```

---

## 3. 数据模型

### 3.1 D1 Schema

```sql
CREATE TABLE artifacts (
  id              TEXT PRIMARY KEY,               -- uuid v4（小写），内部 id，API 使用
  public_id       TEXT NOT NULL UNIQUE,           -- 子域名里的 id；重新生成链接时更换
  title           TEXT NOT NULL DEFAULT '',
  kind            TEXT NOT NULL,                  -- 'html' | 'folder'
  visibility      TEXT NOT NULL DEFAULT 'private',-- 'private' | 'public' | 'password'
  password_enc    TEXT,                           -- AES-GCM 加密的访问码（后台需展示，故可逆）
  password_ver    INTEGER NOT NULL DEFAULT 0,     -- 重置访问码 +1，旧解锁 Cookie 失效
  indexable       INTEGER NOT NULL DEFAULT 0,     -- 允许搜索引擎收录（仅 public 时生效），默认 0
  entry           TEXT NOT NULL DEFAULT 'index.html',
  spa_fallback    INTEGER NOT NULL DEFAULT 0,
  current_version INTEGER,
  view_count      INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  deleted_at      INTEGER
);
CREATE INDEX idx_artifacts_updated ON artifacts(updated_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE artifact_versions (
  artifact_id  TEXT NOT NULL,
  version      INTEGER NOT NULL,
  status       TEXT NOT NULL,                     -- 'uploading' | 'ready'
  file_count   INTEGER NOT NULL DEFAULT 0,
  total_size   INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  created_by   TEXT,                              -- 'session' | 'token:<id>'
  PRIMARY KEY (artifact_id, version)
);

CREATE TABLE artifact_files (
  artifact_id  TEXT NOT NULL,
  version      INTEGER NOT NULL,
  path         TEXT NOT NULL,
  size         INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  sha256       TEXT,
  PRIMARY KEY (artifact_id, version, path)
);

CREATE TABLE api_tokens (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,              -- SHA-256(token)
  prefix       TEXT NOT NULL,                     -- 前 8 位，后台识别用
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,                  -- SHA-256(随机 32 字节)，Cookie 里放原值
  method       TEXT NOT NULL,                     -- 'password' | 'google' | 'github' | 'cloudflare'
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  user_agent   TEXT,
  ip           TEXT
);

-- 系统配置（key → JSON）
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- SSO 提供方配置与绑定（每个 provider 一行 → 天然"每种只绑定 1 个"）
CREATE TABLE sso_providers (
  provider          TEXT PRIMARY KEY,             -- 'google' | 'github' | 'cloudflare'
  enabled           INTEGER NOT NULL DEFAULT 0,
  client_id         TEXT,
  client_secret_enc TEXT,                         -- AES-GCM 加密
  issuer            TEXT,                         -- 仅 cloudflare：OIDC issuer
  bound_subject     TEXT,                         -- 绑定账号的稳定 ID（Google sub / GitHub 数字 id / OIDC sub）
  bound_display     TEXT,                         -- 展示用：邮箱 / 用户名
  bound_at          INTEGER,
  updated_at        INTEGER NOT NULL
);

-- OAuth 流程临时状态（state / PKCE / 用途）
CREATE TABLE oauth_states (
  state         TEXT PRIMARY KEY,
  provider      TEXT NOT NULL,
  purpose       TEXT NOT NULL,                    -- 'login' | 'bind'
  code_verifier TEXT NOT NULL,
  nonce         TEXT,
  redirect_to   TEXT,
  expires_at    INTEGER NOT NULL                  -- 10 分钟
);

-- 限流（访问码、密码登录）
CREATE TABLE rate_limits (
  bucket   TEXT NOT NULL,                         -- 'unlock:<artifact_id>:<ip>' | 'login:<ip>'
  window   INTEGER NOT NULL,                      -- floor(now / 10min)
  fails    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window)
);
```

### 3.2 系统配置项（`settings` 表，后台"设置"页可改）

| key | 默认 | 说明 |
|---|---|---|
| `admin_password_hash` | 无 | PBKDF2-SHA256；为空时用 `ADMIN_BOOTSTRAP_PASSWORD` 登录，并强制设置正式密码 |
| `password_login_enabled` | `true` | 可在至少绑定 1 个 SSO 后关闭密码登录 |
| `server_unzip_enabled` | `false` | **服务端 zip 解压开关**，关闭时 API 收到 zip 返回 `415 unzip_disabled` |
| `unzip_max_files` | `900` | 受每请求子请求上限约束 |
| `unzip_max_bytes` | `33554432`（32 MB，最大 48 MB） | zip 本身与解压后总大小上限。zip 和解压结果同时在内存中，必须远低于 Worker 128 MB 内存上限；更大的内容请用网页上传或分批上传 |
| `default_visibility` | `private` | 新建 artifact 的默认可见性 |
| `default_indexable` | `false` | 新建 public artifact 是否允许收录 |
| `keep_versions` | `5` | 每个 artifact 保留的历史版本数 |
| `max_file_bytes` | `104857600` | 单文件上限 |
| `max_version_files` | `2000` | 单版本文件数上限 |

配置在 isolate 内存中缓存 30 秒，修改后最长 30 秒生效。

### 3.3 R2 Key 布局

```
a/{artifact_id}/v{version}/{path}
```

新版本写入新前缀，全部完成后 `UPDATE artifacts SET current_version = ?` 原子切换。超出 `keep_versions` 的旧版本由 cron 清理。

---

## 4. 上传设计

### 4.1 上传形态

| 形态 | 请求 | 说明 |
|---|---|---|
| A. 单 HTML 或 Markdown | `POST /api/v1/artifacts`，`Content-Type: text/html` 或 `text/markdown` | Markdown 默认文件名为 `index.md`，可用 `filename` 指定 |
| B. multipart | `POST /api/v1/artifacts`，`multipart/form-data`，filename 为相对路径 | 小文件夹 |
| C. zip | `POST /api/v1/artifacts`，`Content-Type: application/zip` | **受 `server_unzip_enabled` 控制，默认关闭** |
| D. 分批会话 | `POST /uploads` → `PUT /uploads/{uid}/files/{path}` × N → `POST /uploads/{uid}/commit` | 大文件夹；前端默认路径 |

前端上传 HTML、Markdown、文件夹或 zip 都走形态 D。浏览器用 fflate 解压 zip，**不依赖服务端开关**。服务端开关只影响 API 直传 zip。

### 4.2 路径规范化

- `/` 分隔，去掉前导 `./`、`/`；拒绝 `..`、空段、控制字符、`\`
- 所有文件共享同一顶层目录时自动剥掉（如 `dist/`）
- 禁止 `__share/` 前缀
- 入口优先使用显式指定的 `entry`。上传新版本时，若未指定且原入口仍在，则沿用原入口。自动推断依次选择根目录 `index.html`、唯一的 HTML 文件。没有 HTML 时，根目录与子目录使用相同的 Markdown 索引顺序，依次匹配 `index.md`、`index.markdown`、`README.md`、`README.markdown`，忽略文件名大小写。没有索引时可选唯一的 Markdown 文件。只有一个文件时可直接作为入口，其余情况需指定 `entry`。
- Content-Type 按扩展名查表，文本类追加 `; charset=utf-8`

### 4.3 zip 安全（开启时）

- 解压前检查条目数与声明的解压后大小（防 zip bomb），流式解压时累计实际字节，超过 `unzip_max_bytes` 立即中止
- 条目路径走 §4.2 同一套规范化；忽略目录条目、`__MACOSX/`、`.DS_Store`
- 中途失败：该版本保持 `uploading` 状态不切换，由 cron 清理

---

## 5. 内容访问设计

```
请求 {id}-share.example-content.com/path
  ├─ /__share/*     → 网关自身路由
  ├─ /robots.txt    → artifact 不可收录时，网关返回 "Disallow: /"（覆盖用户文件）
  ├─ 查 artifact（不存在 / 已删除 → 404）
  ├─ 有效 owner Cookie → 放行（任何可见性）
  ├─ public   → 放行
  ├─ password → 有效解锁 Cookie ? 放行 : 解锁页（401）
  └─ private  → 404 页（不泄露存在性），页内带"所有者登录"链接
  放行 → 路径解析 → R2.get → 响应
```

### 5.1 凭密访问

- **访问码**：6 位，字符集为去歧义的大写字母+数字 `23456789ABCDEFGHJKMNPQRSTUVWXYZ`（31 字符，约 8.9×10⁸ 种），输入时不区分大小写。
- 解锁：`POST /__share/unlock`（同源表单），常量时间比较。
- 限流：同一 artifact + IP，10 分钟内失败 5 次即锁定该窗口。
- 成功后设置 Cookie：

  ```
  __Host-as_unlock = payload(exp, password_ver) . HMAC(K_sign, id | exp | password_ver)
  Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=7d
  ```

- 重置访问码 → `password_ver + 1` → 旧 Cookie 全部失效。
- 分享链接可带码 `?pwd=XXXXXX`：网关校验后写 Cookie，并 302 到去掉参数的地址（后台"复制链接+访问码"提供两种格式）。

### 5.2 私有内容预览（跨域 handoff）

```
1. 后台点"打开"/ 私有 404 页点"所有者登录"
   → https://share.example.com/handoff?id={id}&next=/path
2. 主域校验会话（未登录 → 登录页 → 回到 handoff）
3. 签发 ticket = HMAC(K_sign, id | exp=now+60s | nonce) → 302 到
   https://{id}-share.example-content.com/__share/auth?ticket=…&next=/path
4. 内容端校验 ticket（签名、过期、id 匹配、nonce 一次性）
   → Set-Cookie __Host-as_owner（12h）→ 302 到 next（只允许相对路径）
```

### 5.3 路径解析

- `/` 打开入口。嵌套入口通过 `302` 转到文件路径，保留相对链接和图片的解析基准。
- `/dir/` 优先查找 `dir/index.html`。如果 `/dir` 不存在但有该 HTML 索引，则以 `301` 跳转到 `/dir/`。
- 对 Markdown 入口的文件夹，或未启用 SPA 回退的文件夹，目录路径 `/dir` 和 `/dir/` 可回退到 Markdown 索引。按 `index.md`、`index.markdown`、`README.md`、`README.markdown` 的顺序匹配直接子文件，忽略文件名大小写。命中后以 `302` 跳转到文件路径并保留查询参数。
- 仍未命中时，符合 SPA 回退条件的请求打开入口。Markdown 入口跳转到文件路径，HTML 入口直接返回内容。其他请求使用 artifact 内的 `404.html` 或默认 404。
- 支持 `ETag` 和 `If-None-Match` 条件请求。原文支持 `Range` 请求。

### 5.4 响应头与缓存

- 文件响应使用 `X-Content-Type-Options: nosniff`。通常使用 `Referrer-Policy: strict-origin-when-cross-origin`，Markdown 预览使用 `no-referrer`。
- **搜索收录**：除 `visibility = public 且 indexable = 1` 外，一律加 `X-Robots-Tag: noindex, nofollow, noarchive`，并拦截 `/robots.txt`
- 不对用户 HTML 加限制性 CSP；网关自己的页面（解锁页、404）加严格 CSP
- public：浏览器可保存响应，但需在使用前重新验证。网关在验权后查询 Cache API，内部缓存副本保留 60 秒，按子域名、版本、索引设置和文件路径区分。
- private / password：`Cache-Control: private, no-store`，不进边缘缓存

---

## 6. 认证设计

### 6.1 会话

- Cookie：`__Host-as_session`，`Secure; HttpOnly; SameSite=Lax; Path=/`，30 天滑动过期。
- D1 `sessions` 存 ID 的哈希；后台可"登出所有设备"。
- 所有通过 Cookie 认证的写操作额外校验 `Origin == https://share.example.com`（纵深防御）。

### 6.2 密码登录

- 首次部署：`settings.admin_password_hash` 为空 → 用 `ADMIN_BOOTSTRAP_PASSWORD` 登录 → 强制跳到"设置密码"页 → 写入 D1 后 bootstrap 密码失效。
- PBKDF2-SHA256（WebCrypto，10 万次迭代）+ 常量时间比较。
- 限流：同 IP 10 分钟内失败 5 次锁定。
- `password_login_enabled=false` 时隐藏密码表单并拒绝密码登录（仅当至少绑定了 1 个 SSO 时允许关闭）。
- **找回**：被锁在外面时，执行
  `wrangler d1 execute artifacts-share --remote --command "DELETE FROM settings WHERE key IN ('admin_password_hash','admin_username','password_login_enabled')"`
  即回到 bootstrap 密码状态。

### 6.2.1 用户名与 Turnstile（v6）

- **用户名**：登录需要用户名 + 密码。初始用户名来自 `ADMIN_USERNAME`（默认 `admin`），首次设置密码时可一并修改，之后在"设置 → 安全"修改（需当前密码）。存于 `settings.admin_username`，比较时不区分大小写；错误提示不区分是用户名错还是密码错。SSO 登录不涉及用户名。
- **Turnstile**：配置 `TURNSTILE_SITE_KEY`（var）+ `TURNSTILE_SECRET_KEY`（secret）后启用。用环境变量而不是后台配置：配错时后台改不回来，环境变量总能用 wrangler 修复。
  - 同一 IP 在当前 10 分钟窗口内失败 ≥ 3 次后，每次登录都要带 Turnstile token，服务端调用 siteverify 校验（失败按不通过处理），校验在计数之前。
  - `GET /api/auth/methods` 返回 `turnstile: { site_key, required }`，登录页据此加载组件；登录失败后重新查询，越过阈值时出现组件。
  - 启用 Turnstile 时硬性锁定上限为每窗口 10 次（否则 5 次）。
  - CSP 放行 `https://challenges.cloudflare.com`（script / frame / connect）。

### 6.2.2 失败计数与访问码防护（v7）

- **计数器**：D1 `rate_limits` 表，每个对象一行（`login:<ip>`、`unlock:<artifact_id>:<ip>`），记录失败次数和窗口结束时间 `reset_at`。窗口从第一次失败开始，持续 10 分钟。一条原子 upsert 完成"过期则重置为 1，否则 +1"，成功的尝试退还计数，所以只计失败。过期行在查询时被忽略，并由每日定时任务删除。
- **上限**：每窗口 5 次；启用 Turnstile 时 10 次。
- **访问码提示**：输错时显示"还可以再试 N 次"；锁定时显示"请在 N 分钟后重试"，返回 429 并带 `Retry-After`。下载弹窗通过错误体里的 `remaining` / `retry_after` 字段显示同样的信息。
- **Turnstile**：同一 IP 对同一 artifact 失败 3 次后，访问码页、`?pwd=` 链接、下载弹窗都要求 Turnstile（与登录相同，验证在计数之前）。访问码页用隐式渲染，组件自己把 `cf-turnstile-response` 加入表单，页面本身仍然没有内联脚本；只有显示组件时，该页的 CSP 才放行 `challenges.cloudflare.com`。`?pwd=` 链接无法携带 token，需要验证时显示已填好访问码的表单。Turnstile 组件的主机名需要包含内容域名。

### 6.3 SSO 登录（Google / GitHub / Cloudflare）

**每个 provider 在 `sso_providers` 表中只有一行，`bound_subject` 只有一个值 → 每种只能绑定 1 个账号。**

| Provider | 协议 | 后台需配置 | 绑定依据 | 回调地址 |
|---|---|---|---|---|
| Google（Gmail） | OIDC，Authorization Code + PKCE，scope `openid email` | Client ID、Client Secret（Google Cloud Console → OAuth 客户端，类型 Web） | ID Token 的 `sub`（并要求 `email_verified`） | `https://share.example.com/api/auth/oauth/google/callback` |
| GitHub | OAuth 2.0 Authorization Code + PKCE，scope `read:user` | Client ID、Client Secret（GitHub → Developer settings → OAuth Apps） | `/user` 返回的数字 `id`（不随改名变化） | `…/api/auth/oauth/github/callback` |
| Cloudflare | OIDC（**Cloudflare Zero Trust → Access → Applications → SaaS → OIDC**），Authorization Code + PKCE | Issuer（形如 `https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client_id>`）、Client ID、Client Secret | ID Token 的 `sub`（展示 `email`） | `…/api/auth/oauth/cloudflare/callback` |

> Cloudflare 目前没有面向第三方应用开放注册的通用"用 Cloudflare 账号登录"OAuth；可行的方式是 Access for SaaS 提供的 OIDC。Zero Trust Free 计划可用（50 用户内免费），身份源可以是 Cloudflare 的一次性 PIN（邮箱）或任意已接入的 IdP。实现上 Cloudflare 走通用 OIDC（读 `/.well-known/openid-configuration`，校验 JWKS 签名），所以理论上也可接其它标准 OIDC。

**流程：**

```
绑定（需已登录）
  后台 设置 → SSO → 填 client_id / secret（→ 保存）→ 点"绑定"
  → GET /api/auth/oauth/{p}/start?purpose=bind
  → 生成 state + PKCE verifier（+ nonce），写 oauth_states
  → 302 到 provider 授权页
  → callback：校验 state / 过期 / purpose；用 code + verifier 换 token
    → 取得 subject（OIDC：校验 ID Token 签名、iss、aud、exp、nonce）
    → 校验当前请求仍带有效会话 → 写 bound_subject / bound_display
  解绑：DELETE /api/settings/sso/{p}/binding（若这是最后一种登录方式则拒绝）

登录（未登录）
  登录页显示"已启用且已绑定"的 provider 按钮
  → GET /api/auth/oauth/{p}/start?purpose=login → 同上
  → callback：subject == bound_subject ? 创建会话 : 403（不提示具体原因）
```

安全要点：

- `state` 一次性、10 分钟过期；全部使用 PKCE（S256）
- OIDC ID Token 用 provider 的 JWKS 验签（WebCrypto RS256/ES256），JWKS 缓存 1 小时
- `redirect_to` 只允许主域内相对路径
- `client_secret` 用 `K_enc` 做 AES-GCM 加密后入库，后台只显示"已设置"，不回显
- 修改 `client_id` 或 issuer 时自动清空该 provider 的绑定（subject 只在同一个 client / issuer 下有意义）

### 6.4 API Token

- 格式 `as_` + 32 字节 base62；只在创建时显示一次；D1 存 SHA-256
- 使用时 `ctx.waitUntil` 异步更新 `last_used_at`
- 支持吊销；**不设过期时间**
- Token 不能访问 `/api/v1/tokens`、`/api/settings/*`（仅会话可访问），防止泄露的 Token 自我复制或篡改登录配置

### 6.5 密钥派生

只需要一个 Worker Secret `SECRET_KEY`，用 HKDF 派生：

- `K_sign`：HMAC-SHA256，签名 Cookie / ticket
- `K_enc`：AES-256-GCM，加密访问码与 OAuth client secret

更换 `SECRET_KEY` 会让所有 Cookie 失效，并且需要重新填写 OAuth secret、重置访问码（文档注明）。

---

## 7. 安全要点汇总

| 风险 | 对策 |
|---|---|
| artifact JS 调后台 API（CSRF） | 后台与内容**跨站**，`SameSite=Lax` 会话 Cookie 不会被带上；写操作再校验 `Origin` |
| artifact 之间互相读/改 Cookie（同属 `example-content.com`） | 全部 `__Host-` 前缀（禁止 Domain 属性）+ HttpOnly |
| 后台被 iframe 嵌入 | `X-Frame-Options: DENY` + `frame-ancestors 'none'` |
| 后台 XSS | 严格 CSP（`script-src 'self'`），后台不渲染用户 HTML |
| 访问码 / 密码爆破 | 31^6 空间 + 每 IP 限流 |
| 子域枚举 | UUIDv4；私有返回 404 |
| 路径穿越 | 上传与读取统一规范化，R2 key 服务端拼接 |
| zip bomb | 解压大小 / 条目数上限，默认关闭 |
| OAuth 劫持 | state + PKCE + nonce、JWKS 验签、redirect 白名单 |
| 搜索引擎收录 | 默认 `X-Robots-Tag: noindex` + 拦截 robots.txt |

---

## 8. API 设计

Base：`https://share.example.com`
认证：`Authorization: Bearer as_xxx` 或会话 Cookie。
错误格式：`{ "error": { "code": "...", "message": "..." } }`

### 8.1 Artifacts（Token / 会话）

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/v1/artifacts` | 创建（形态 A/B/C）；参数 `title`、`visibility`、`entry`、`spa_fallback`、`indexable`（query 或 `X-Artifact-*` 头） |
| `GET` | `/api/v1/artifacts?cursor=&limit=&q=&visibility=` | 列表 |
| `GET` | `/api/v1/artifacts/{id}` | 详情（含 `url`；凭密时含 `password`） |
| `PATCH` | `/api/v1/artifacts/{id}` | 改 `title` / `visibility` / `entry` / `spa_fallback` / `indexable`；切到 password 时自动生成访问码 |
| `POST` | `/api/v1/artifacts/{id}/password/reset` | 重新生成访问码 |
| `POST` | `/api/v1/artifacts/{id}/regenerate-link` | 重新生成子域名（旧链接立即 404）；body `{ "reset_password": true }` 可同时重新生成访问码 |
| `PUT` | `/api/v1/artifacts/{id}/content` | 更新内容 → 新版本（形态 A/B/C） |
| `GET` | `/api/v1/artifacts/{id}/versions` | 版本列表 |
| `POST` | `/api/v1/artifacts/{id}/versions/{v}/activate` | 回滚 |
| `GET` | `/api/v1/artifacts/{id}/files?version=` | 文件清单 |
| `GET` | `/api/v1/artifacts/{id}/files/{path}` | 下载原文件 |
| `DELETE` | `/api/v1/artifacts/{id}` | 软删除 |
| `GET` | `/api/v1/analytics?range=7d&tz=480&bots=0` | 全站访问统计（未配置 Analytics Engine 时返回 `{ enabled: false }`） |
| `GET` | `/api/v1/artifacts/{id}/analytics?range=7d&tz=480&bots=0` | 单作品 90 天内访问明细（`range`: `24h\|7d\|30d\|90d`，`tz`: 分钟偏移 `[-720,840]`，`bots`: `0\|1`） |

### 8.2 分批上传（Token / 会话）

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/v1/uploads` | `{ artifact_id?, title?, visibility?, entry?, files?: [{path,size}] }` → `{ upload_id, artifact_id, version }` |
| `PUT` | `/api/v1/uploads/{upload_id}/files/{path}` | 文件原始字节 |
| `POST` | `/api/v1/uploads/{upload_id}/commit` | 校验并切换版本 |
| `DELETE` | `/api/v1/uploads/{upload_id}` | 放弃 |

### 8.3 认证（公开 / 会话）

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/auth/methods` | 登录页用：是否允许密码登录、哪些 SSO 可用 |
| `POST` | `/api/auth/login` | `{ password }` |
| `POST` | `/api/auth/logout` | |
| `POST` | `/api/auth/logout-all` | |
| `GET` | `/api/auth/me` | |
| `GET` | `/api/auth/oauth/{provider}/start?purpose=login\|bind&redirect_to=` | |
| `GET` | `/api/auth/oauth/{provider}/callback` | |

### 8.4 管理（仅会话）

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` / `POST` / `DELETE` | `/api/v1/tokens[/{id}]` | Token 列表 / 创建 / 吊销 |
| `GET` / `PATCH` | `/api/settings` | 系统配置（§3.2） |
| `PUT` | `/api/settings/password` | 修改管理员密码（需旧密码） |
| `GET` | `/api/settings/sso` | 三个 provider 的配置与绑定状态（不回显 secret） |
| `PUT` | `/api/settings/sso/{provider}` | 保存 `enabled`、`client_id`、`client_secret`、`issuer` |
| `DELETE` | `/api/settings/sso/{provider}/binding` | 解绑 |

### 8.5 示例

```bash
T=as_xxxxxxxx
API=https://share.example.com/api/v1

# 单 HTML，公开
curl -X POST "$API/artifacts?title=Demo&visibility=public" \
  -H "Authorization: Bearer $T" -H "Content-Type: text/html" --data-binary @demo.html
# → {"id":"0b6c…","url":"https://0b6c…-share.example-content.com/","visibility":"public"}

# 文件夹（multipart），凭密
curl -X POST "$API/artifacts?visibility=password" -H "Authorization: Bearer $T" \
  -F "file=@dist/index.html;filename=index.html" \
  -F "file=@dist/assets/app.js;filename=assets/app.js"
# → {..., "password":"7KQ2MX"}

# zip（需在后台打开 server_unzip_enabled）
curl -X POST "$API/artifacts" -H "Authorization: Bearer $T" \
  -H "Content-Type: application/zip" --data-binary @site.zip
```

---

## 8.6 分享页（Viewer，v4）

和 Claude Artifacts 一样：分享链接是主域名上的页面 `https://share.example.com/s/{public_id}`，顶部是工具栏，下面用 iframe 加载内容子域名。

- **iframe**：`src` 为内容子域名；`sandbox` 允许脚本、表单、弹窗、下载等，但只允许由用户点击触发的顶层跳转（`allow-top-navigation-by-user-activation`），artifact 不能悄悄把分享页跳转到别的网站。
- **只允许主域名嵌入**：内容子域名的所有响应都带 `Content-Security-Policy: frame-ancestors 'self' https://share.example.com`；主域名的 CSP 用 `frame-src https://*.example-content.com` 允许加载 iframe。
- **iframe 内的 Cookie**：内容子域名与主域名跨站，`SameSite=Lax` 的 Cookie 在 iframe 中不会发送。因此解锁 / 所有者 Cookie 使用 `SameSite=None; Partitioned`（CHIPS），按顶层站点分区：在分享页里解锁后，只在分享页里有效；直接访问子域名需要单独解锁。
- **元数据接口** `GET /api/public/artifacts/{public_id}`（无需登录）与 `POST /api/public/artifacts/{public_id}/unlock`：
  - 访客：私有返回 404；访问码模式在未验证前不返回标题（`title: null`）；只返回 iframe 本来就会展示的信息。
  - 带 `?pwd=` 打开访问码链接时，分享页先以 `application/json` 调用 `POST /api/public/artifacts/{public_id}/unlock`（非 JSON 返回 415；与子域名共用限流计数）；校验通过后返回真实标题并写入主域名签名 Cookie `__Host-as_unlock_meta`（`HttpOnly; Secure; SameSite=Lax`，最多保留最近 20 条，绑定 `password_ver`，7 天有效，退出登录时清空），使刷新页面后仍保留真实标题，重置访问码立即失效；若访问码错误则不再把错误码传给 iframe，避免双倍扣次。
  - 在 iframe 内手动输入访问码解锁后（或已有内容子域名解锁 Cookie 而主域名尚未记录时由分享页携带保留参数 `__proof=1` 触发自愈），内容子域名仅对访客的 `GET` iframe 请求返回严格 CSP（`script-src 'self'`）的极简跳板页（所有者、`HEAD` 与顶层打开仍走原生 `302`）：加载静态脚本 `/__share/unlocked.js`（带 `CORP: same-origin`），通过 `postMessage` 向主域名发送短效签名回执（`k: 'unlock_proof'`，2 分钟有效，绑定 `public_id` 与 `password_ver`）后立即 `location.replace` 进入内容页；分享页校验 `e.source` 与 `e.origin` 后换取真实标题（遇瞬时非 4xx 错误自动重试一次）并写入 `__Host-as_unlock_meta`。
  - 所有者：另外返回完整的 artifact 信息，以及 `frame_url`（一次性登录票据地址）。iframe 用它先在子域名上登录，私有 / 访问码内容直接可见。
- **工具栏**：所有人可以复制链接、在新标签页打开、登录。所有者看到一个"分享"按钮（图标显示当前权限），点开是类似 Claude 的弹出面板：三种权限选项（带图标和说明）、访问码（复制 / 重新生成）、链接与"复制链接 + 访问码"。面板在点击外部、按 Esc、点进 iframe 时关闭。工具栏上另有进入管理页、退出登录。
- **语言统一**：分享页把自己的界面语言用保留参数 `__lang` 传给 iframe，只在 iframe 会显示网关页面时才带上（访问码页、所有者登录跳转），公开内容不会收到这个参数。访问码表单里也带着语言，输错后重新显示时语言不变。网关的所有跳转都会去掉 `__lang`，它不会传到 artifact 自己的页面。退出登录时先让 iframe 访问 `/__share/logout`，清掉子域名上的所有者 Cookie，再退出主域名会话。
- **Markdown 预览**适用于内容子域上任意 `.md` 或 `.markdown` 文件，包括文件夹中通过链接打开的非入口文件。网关先检查访问权限，再为浏览器页面和 iframe 导航返回预览。缺少 `Sec-Fetch-Dest` 时，根据 `Accept` 是否优先请求 `text/html` 决定是否返回预览。普通 `curl`、`fetch()` 和带 `Range` 的请求默认获得 `text/markdown` 原文。可用 `?__share_raw=1` 显式请求原文，或用 `?__share_raw=plain` 获取 `text/plain`。
  - 预览和源码切换使用同一发布版本的内容。相对链接和图片以当前文件所在目录为基准。渲染时关闭内嵌 HTML，支持代码高亮，并在浏览器端按需加载 Mermaid。每页尝试渲染前 20 个 Mermaid 代码块，其余保留原样。超过 2 MiB 的文件提供纯文本原文入口。
  - 预览和原文响应都带 `Vary: Sec-Fetch-Dest, Accept`。预览的弱 `ETag` 由模板、语言和 R2 源文件的 `ETag` 生成，匹配时返回 `304`。预览静态资源支持条件请求，带内容哈希的 JS 分块可长期缓存。
- **下载**：单个 HTML 或 Markdown 下载源文件，文件夹下载包含全部文件的 ZIP。上传时可用 `source_kind: "folder"` 标记只有一个文件的文件夹。接口为 `GET /s/{public_id}/download`，以附件返回，并带 `CSP: sandbox`，不会在主域名上渲染。ZIP 从 R2 逐个读取文件，流式打包，文本按大小选择压缩，已压缩媒体原样存储。常规 ZIP 的偏移量不够时，写入 ZIP64 偏移量。
  - 权限：所有者总是可以下载；访客需要在设置中开启"允许访客下载"（`visitor_download_enabled`，默认关闭）。私有内容只有所有者能下载。访问码模式的访客通过 `POST /api/public/artifacts/{public_id}/download-token`，用访问码换取 5 分钟有效的下载凭证（访问码不出现在下载链接里；与解锁共用限流；重新生成访问码后旧凭证失效）。
  - 工具栏：一个"下载源文件 / 下载 ZIP"按钮，提示文字显示文件名、文件数和大小（访问码访客输入访问码前看不到这些信息）。访问码访客点击后弹出访问码输入框；分享链接带 `?pwd=` 时直接下载。
- **搜索收录**：主域名 `robots.txt` 只放行 `/s/`；分享页仍默认带 `noindex`，只有公开且允许收录的 artifact 才去掉。
- API 返回的 `url` 是分享页链接，`content_url` 是子域名原始地址。

## 9. 管理后台（share.example.com）

- **多语言**：中文 / English。后台默认跟随浏览器语言（无法识别时中文），顶栏可切换并记在 localStorage；API 错误按 `error.code` 翻译。访客页面（访问码页、404、错误页）按 `Accept-Language` 选择语言，并返回 `Vary: Accept-Language`。
- **登录页**：密码表单（可关闭）+ 已绑定的 SSO 按钮
- **Artifacts 列表**：标题、类型、可见性、大小、更新时间、访问次数；搜索 / 筛选
- **新建 / 更新**：拖拽 HTML / 文件夹 / zip，粘贴 HTML 文本，进度条，选可见性
- **详情**：链接复制、打开（私有自动 handoff）；可见性切换；访问码查看 / 复制 / 重置；允许收录开关（仅 public）；文件树；版本历史与回滚；删除
- **API Tokens**：新建（仅显示一次）、列表、吊销
- **访问统计（可选）**：当 `ANALYTICS` 绑定、`CF_ACCOUNT_ID` 和 `CF_API_TOKEN`（Account Analytics: Read）均已配置时启用。访客浏览（HTML / Markdown）、下载（`source` / `zip`）和分享页外链来源（`referral`）通过 `writeDataPoint` 非阻塞写入 Workers Analytics Engine（按内部 `artifact.id` 索引，匿名月度 HMAC `visitor_id` 去重，不存明文 IP）；管理端顶栏提供全站统计页（`#/analytics`），详情页提供按需展开的折叠分析卡片，未配置或数据集未初始化时优雅降级。
- **设置**
  - 通用：默认可见性、保留版本数、上传上限
  - 上传：**服务端 zip 解压开关（默认关）**及上限
  - 安全：修改密码、是否允许密码登录、登出所有设备
  - SSO：Google / GitHub / Cloudflare 三张卡片 —— 回调地址（一键复制）、Client ID / Secret / Issuer、启用开关、绑定 / 解绑、当前绑定账号

---

## 10. 代码结构

```
.
├── wrangler.toml
├── migrations/0001_init.sql
├── src/
│   ├── index.ts                # fetch / scheduled，按 hostname 分发
│   ├── env.ts
│   ├── main/                   # share.example.com
│   │   ├── app.ts
│   │   ├── auth/
│   │   │   ├── session.ts      # 会话、中间件、Origin 校验
│   │   │   ├── password.ts
│   │   │   ├── oauth.ts        # 通用 Authorization Code + PKCE 流程
│   │   │   └── providers/{google,github,cloudflare}.ts
│   │   ├── artifacts.ts
│   │   ├── uploads.ts
│   │   ├── tokens.ts
│   │   └── settings.ts
│   ├── content/                # {uuid}-share.example-content.com
│   │   ├── gateway.ts
│   │   ├── serve.ts
│   │   └── pages.ts
│   ├── lib/
│   │   ├── crypto.ts           # HKDF、HMAC、PBKDF2、AES-GCM、随机码
│   │   ├── jwt.ts              # ID Token / JWKS 校验
│   │   ├── paths.ts
│   │   ├── mime.ts
│   │   ├── zip.ts
│   │   ├── settings.ts         # 读取 + 30s 内存缓存
│   │   └── db.ts
│   └── cron.ts
├── web/                        # 后台 SPA（index.html / app.js / app.css）
└── test/                       # vitest + @cloudflare/vitest-pool-workers
```

---

## 11. 开发与验证计划

1. 骨架：wrangler、D1 migration、hostname 分发、本地 `wrangler dev`（用 `Host` 头模拟两个域）
2. 内容端：R2 读取、路径解析、public 访问、noindex
3. 认证：密码登录（bootstrap → 正式密码）、会话、Token
4. 上传：形态 A / B / D，版本切换
5. 访问控制：凭密解锁 + 限流；私有 handoff
6. SSO：通用 OAuth / OIDC 流程 → GitHub → Google → Cloudflare Access
7. 后台 SPA（含设置页）
8. 形态 C（zip，受开关控制）、cron 清理
9. 部署：确认两个 zone 同账号；`example-content.com` 加 `*` 记录；routes、secrets；curl 全场景验证

测试重点：路径规范化 / 穿越、Cookie 签名 / 过期 / 版本失效、ticket 一次性、访问码限流、zip 开关与 zip bomb、OAuth state / PKCE / 绑定校验、Token 无法访问 settings / tokens。

---

## 12. 已确认的决策

| 项 | 决策 |
|---|---|
| 主域 | `share.example.com` |
| 内容域 | `{uuid}-share.example-content.com` |
| 访问码 | 6 位大写字母 + 数字（去歧义字符集） |
| Workers 计划 | Paid；服务端 zip 解压为后台开关，默认关闭 |
| 登录 | 自建密码 + SSO（Google / GitHub / Cloudflare，各 1 个绑定，后台配置） |
| 过期时间 | 不需要 |
| 搜索收录 | 默认禁止；public artifact 可单独开启 |
