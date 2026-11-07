# WorkBuddy 管理后台

`wb-switch-admin` 是独立的安装统计与版本管理服务，不和用户本地的 `wb-switch-server` 混用。

## 启动

需要 Rust stable：

```bash
WB_ADMIN_TOKEN="change-me" \
WB_ADMIN_MASTER_KEY="$(openssl rand -base64 32)" \
cargo run -p wb-switch-admin
```

默认监听 `0.0.0.0:57900`。管理页面按路由访问：`/admin/overview`、`/admin/features`、`/admin/users`、`/admin/sub2api`、`/admin/releases`。

可用环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `WB_ADMIN_BIND` | `0.0.0.0:57900` | 监听地址 |
| `WB_ADMIN_DB` | `./wb-admin.sqlite3` | SQLite 数据库文件 |
| `WB_ADMIN_TOKEN` | `dev-admin-token-change-me` | 管理接口 Bearer 令牌，生产必须修改 |
| `WB_ADMIN_MASTER_KEY` | 无默认值 | 32 字节 base64/64 位 hex，用于 AES-256-GCM 加密 Sub2API 用户 API Key 和管理员 API Key |

## API

- `GET /healthz`：健康检查
- `POST /api/telemetry/heartbeat`：客户端匿名心跳
- `GET /api/admin/overview`：安装数、活跃数、账号总数、版本/平台/功能分布
- `GET /api/admin/installations`：安装设备列表
- `GET /api/admin/users`：手机号用户列表与 Sub2API 账号绑定信息
- `POST /api/admin/users/:id/sub2api`：设置或解除用户的 Sub2API 账号绑定
- `POST /api/admin/users/:id/sync`：同步单个用户的 Sub2API 账号、余额和远端状态
- `POST /api/admin/users/:id/status`：同步启用/禁用状态到本地和 Sub2API
- `GET /api/admin/users/:id/credits/history`：读取用户积分流水
- `POST /api/admin/users/:id/credits`：原子增加或扣减用户积分并写入流水
- `POST /api/admin/users/:id/consumption/sync`：读取 Sub2API 用户累计消费，计算新增消费并扣除本地积分
- `POST /api/admin/sub2api/users/consumption-sync`：批量同步所有已绑定用户的 Sub2API 消费
- `GET /api/client/credits`：客户端读取当前用户积分和流水
- `POST /api/client/redeem`：客户端核销一次性兑换码并增加积分
- `GET /api/admin/releases`：版本发布记录
- `POST /api/admin/releases`：创建或更新版本发布记录
- `GET /api/admin/sub2api/config`：读取脱敏后的 Sub2API 配置
- `POST /api/admin/sub2api/config`：保存 Sub2API Base URL（不再要求填写用户 API Key）
- `GET /api/admin/sub2api/admin-config`：读取脱敏后的管理员 API Key 配置
- `POST /api/admin/sub2api/admin-config`：保存 Sub2API Admin API Key（服务端加密）
- `POST /api/admin/sub2api/users/test`：测试 Sub2API 管理用户接口
- `POST /api/admin/sub2api/users/sync`：按手机号邮箱规则创建/匹配 Sub2API 用户并保存一对一绑定
- `POST /api/admin/sub2api/test`：测试连接并读取模型
- `POST /api/admin/sub2api/models/refresh`：刷新模型缓存
- `GET /api/admin/model-services`：读取后台启用/停用的模型服务卡片
- `POST /api/admin/model-services`：添加 GLM/Kimi/DeepSeek/Qwen/自定义模型服务
- `POST /api/admin/model-services/:id`：测试指定模型服务
- `DELETE /api/admin/model-services/:id`：删除指定模型服务
- `GET /api/client/models`：客户端读取脱敏模型目录
- `POST /api/client/chat/completions`：后台注入 API Key 后代理模型请求
- `POST /api/client/auth/sms/send`：发送手机号验证码
- `POST /api/client/auth/sms/login`：手机号验证码登录并创建会话
- `GET /api/client/auth/me`：读取当前登录用户
- `POST /api/client/auth/logout`：撤销当前会话
- `GET /admin/overview`：运营概览
- `GET /admin/features`：功能使用
- `GET /admin/users`：用户与设备
- `GET /admin/sub2api`：Sub2API 服务配置与模型目录
- `GET /admin/releases`：应用升级管理

心跳只接受随机安装 ID、版本、操作系统、架构、语言、账号数量和聚合事件计数。服务端不会设计账号 UID、邮箱、token 或会话内容字段。

## 接入客户端

客户端优先通过 `VITE_WB_ADMIN_URL` 配置后台地址；未设置时读取本地保存的地址，开发模式和桌面版默认使用线上 API `https://admin.woai.info/api`，Web 部署回退到当前来源。若需要本地预览后台，请显式设置 `VITE_WB_ADMIN_URL=http://127.0.0.1:57900`。地址可以填写域名根路径、反向代理前缀（例如 `/admin`）或完整 API 根路径（例如 `/admin/api`），客户端会自动补齐且不会重复 `/api`。远程部署仍应显式设置 `VITE_WB_ADMIN_URL`。演示模式不会发送后台请求。客户端只读取模型目录和代理响应，不接收 API Key。

Sub2API 的 Base URL、管理员 API Key 密文、用户专属 API Key 密文、模型缓存和同步状态都保存在 `WB_ADMIN_DB` 指定的 SQLite 数据库中。消费同步读取 Sub2API `/api/v1/admin/users/:id/usage` 的累计 `total_cost`，用本地快照计算新增消费，避免重复扣除。每次扣除写入 `sub2api_usage` 流水；本地积分为 0 时把 Sub2API 用户余额设为 0，大于 0 时设为 99999999。手机号 `13800138000` 会映射为 `13800138000@users.workbuddy.local`，登录或手动同步时创建/匹配对应 Sub2API 用户，并尝试在 `China-models` 分组创建用户 API Key。新版本优先使用管理员创建 Key 接口；旧版本会使用管理员重置密码后登录用户 `/api/v1/keys` 的兼容流程。客户端登录后只读取该用户 Key 可用的模型；导入 WorkBuddy 时由后台把 Key 写入本机 `models.json`，完整 Key 不返回浏览器。所有 Key 都使用 AES-256-GCM 加密，主密钥由 `WB_ADMIN_MASTER_KEY` 提供；主密钥丢失后无法解密旧配置，需要重新录入 Key。
## 短信验证码登录

客户端登录使用阿里云**号码认证服务（PNVS）**：服务端调用 `SendSmsVerifyCode` 下发验证码，
再用 `CheckSmsVerifyCode` 核销，验证码本身由阿里云生成，服务端不保存明文。
实现见 `crates/wb-switch-admin/src/sms.rs`（与 video_flow 项目的 `management/sms_auth.py` 同一套调用参数）。

配置项（环境变量）：

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `WB_SMS_ACCESS_KEY_ID` | 是 | 阿里云 AccessKeyId |
| `WB_SMS_ACCESS_KEY_SECRET` | 是 | 阿里云 AccessKeySecret |
| `WB_SMS_SIGN_NAME` | 是 | 短信签名 |
| `WB_SMS_TEMPLATE_CODE` | 否 | 模板号，默认 `100001`（PNVS 通用验证码模板） |
| `WB_SMS_SCHEME_NAME` | 否 | 号码认证方案名称，未使用可留空 |
| `WB_SMS_ENDPOINT` | 否 | 默认 `dypnsapi.aliyuncs.com` |
| `WB_SMS_MODE` | 否 | `dev` 强制本地验证码；`production` 未配置时直接报错；留空表示自动 |

行为：

- 配置了 AccessKey → 真实下发短信，`sms_challenges.provider = 'aliyun'`，登录时由阿里云核销
- 未配置且非 `production` 模式 → 回退本地调试验证码 `123456`，响应里返回 `devCode`
- 每次挑战 5 分钟有效、最多 5 次尝试、同一挑战只能使用一次

相关接口：

- `POST /api/client/auth/sms/send`：下发验证码
- `POST /api/client/auth/sms/login`：校验验证码并创建会话
- `GET /api/admin/sms/config`：查看当前短信服务配置（脱敏，需管理员令牌）
- `GET /api/admin/sms/settings`：读取后台「系统设置 → 阿里云短信登录」保存的配置（密钥只回打码提示）
- `PUT /api/admin/sms/settings`：保存短信配置；`accessKeySecret` 留空表示保持原密钥，`clearSecret: true` 表示清除
## 后台页面配置（设置 → 阿里云短信登录）

登录后台（`/admin/settings`，左侧「系统设置 → 阿里云短信登录」）即可填写 AccessKey、签名、
模板号和 Endpoint，无需重启服务：

- 密钥用 `WB_ADMIN_MASTER_KEY` 派生的 AES-256-GCM 加密后存入 `sms_settings` 表
  （`secret_nonce` / `secret_ciphertext` / `secret_tag`），页面只显示 `UiT...cdef` 形式的打码提示。
- 解析顺序为 **环境变量优先，其次后台页面配置**：只要设置了 `WB_SMS_ACCESS_KEY_ID`，页面配置就被忽略
  （页面会提示「环境变量优先」）。
- 保存后客户端下一次 `POST /api/client/auth/sms/send` 立即使用新配置；未配置时回退本地验证码
  `123456`（`WB_SMS_MODE=production` 时改为直接报错）。
- 只有 `enabled`、AccessKey、签名都齐全才算「已配置」；AccessKey 被阿里云拒绝时会原样回传阿里云错误码
  （例如 `InvalidAccessKeyId.NotFound`）。
