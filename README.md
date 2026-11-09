# workbuddy-switch

WorkBuddy 账号切换与积分管理桌面 App（Tauri），支持国内版 / 国际版，并提供积分到期与 Token 用量监控。

<p align="center">
  <img src="public/icon-transparent.png" alt="WorkBuddy Switch 图标" width="128" />
</p>

多账号共享登录态，一键切换 WorkBuddy 登录账号。**会话复制**：把当前账号的会话以新 id 复制给目标账号，源账号数据不受影响，云端归属目标账号。

**在线演示**：[打开 GitHub Pages 演示](https://changexbc.github.io/workbuddy-switch/)（只读演示；账号、积分与请求记录均为虚构数据，所有业务操作均已禁用）

## 快速开始

前往 [GitHub Releases](https://github.com/changexbc/workbuddy-switch/releases/latest) 下载对应平台的安装包：

| 平台 | 安装包 | 安装方式 |
| --- | --- | --- |
| macOS Apple Silicon（M 系列，arm64） | `workbuddy-switch_<版本>_aarch64.dmg` | 打开 DMG，将 `workbuddy-switch.app` 拖入「应用程序」 |
| macOS Intel（x86_64） | `workbuddy-switch_<版本>_x86_64.dmg` | 打开 DMG，将 `workbuddy-switch.app` 拖入「应用程序」 |
| Windows x64 | `workbuddy-switch_<版本>_x64-setup.exe` | 运行安装程序并按提示完成安装 |
| Linux x64 | `workbuddy-switch_<版本>_amd64.deb` / `workbuddy-switch_<版本>_amd64.AppImage` | Debian/Ubuntu 安装 `.deb`；其他发行版可给 AppImage 添加执行权限后直接运行 |

macOS 首次启动若提示无法验证开发者，先在 Finder 中按住 Control 点击应用并选择「打开」，或前往「系统设置 → 隐私与安全性」选择「仍要打开」。仅当安装包来自上述官方 Releases、且系统仍提示「已损坏」时，再执行：

```bash
xattr -rd com.apple.quarantine "/Applications/workbuddy-switch.app"
```

应用能启动但切换账号时提示无权限，请参阅下方 [macOS 权限说明](#macos-权限说明)。

另有 npm / webui 版本可在浏览器中使用，见文末 [npm / webui 版本](#npm--webui-版本)。

## 功能

| 模块 | 说明 |
| --- | --- |
| 账号管理 | OAuth 扫码登录、导入导出账号、删除账号 |
| 账号切换 | 一键切换 WorkBuddy 登录账号，切换过程实时显示进度 |
| 会话复制 | 把当前账号勾选的会话复制给目标账号，源账号数据不受影响 |
| 积分到期查询 | 自动查询每个账号的积分剩余量与到期时间；7 天内到期高亮，并按紧迫程度排序、标注「建议优先使用」 |
| 积分统计 | 汇总官方请求用量：总览、近 30 天趋势、模型分类、账号消耗与请求明细 |
| Token 统计 | 按来源查看 Token 总览与趋势，含构成占比、活跃热力图、项目/模型 Top 10 与会话排行 |
| 模型导入 | 浏览 WorkBuddy 模型目录，支持全部导入、选择导入和移除已导入模型 |
| 自动更新 | 从 GitHub Releases 检查新版本，整包更新经签名校验 |
| 权限检测 | macOS 授权引导（App 管理 / 完全磁盘访问拖拽授权 + 自动检测） |

## 支持的工具

| 工具 | 账号切换 | 会话复制 | 自动关闭重开 |
| --- | :---: | :---: | :---: |
| WorkBuddy | ✅ | ✅ | ✅ |

✅ 表示支持。当前产品界面只保留 WorkBuddy 账号管理与积分能力。

## 使用

1. **添加与导出账号**：账号页 →「OAuth 扫码登录」「导入备份」；「导出」可将勾选账号备份为 JSON
2. **切换账号与账号信息**：账号卡片 →「切换」，可勾选复制当前会话；「账号信息」可给账号添加备注，并选择卡片上显示账号名 / 手机号 / 备注
3. **查看积分与统计**：账号页自动查询各账号积分到期情况，点「刷新积分」手动更新；侧栏进入「积分统计」「Token 统计」查看用量明细
4. **切换 WorkBuddy 账号**：账号卡片上的「切换」会写入 WorkBuddy 登录态并按需重启客户端
5. **查看积分**：账号页展示每个账号的积分资源与到期时间，顶部总积分栏汇总全部账号余额
6. **购买积分**：点击顶部「购买」打开 WorkBuddy 购买页面
7. **管理模型**：左侧「模型导入」进入模型中心，可搜索模型、批量导入或移除模型
8. **更新**：应用会自动检查公开 GitHub Releases；发现新版本后可从设置页打开 Release 页面手动下载

## 界面预览

### 管理 WorkBuddy 账号

账号卡片集中展示登录状态、积分余额和到期资源，临期积分直接标注在对应卡片内，并按紧迫程度优先排列。

![账号管理页面（账号信息已脱敏）](docs/images/accounts-overview.png)

### 积分统计

积分统计页展示官方请求用量、每日趋势、模型分布、账号消耗和请求明细，数据来源与更新时间会明确显示。

![积分统计页面](docs/images/credit-statistics.png)

### Token 统计

Token 统计页按来源展示 Token 总览与趋势、构成占比、活跃热力图、项目/模型 Top 10 与会话排行。

![Token 统计页面](docs/images/token-statistics.png)

## macOS 权限说明

切换账号需要写入 WorkBuddy 认证文件，macOS 要求授权「App 管理」（或「完全磁盘访问」）：

1. 首次切换报「无权限」时，点「打开系统设置」
2. 优先在 **App 管理** 里打开 workbuddy-switch 开关；若没有，则去 **完全磁盘访问** 把 workbuddy-switch 拖进带箭头的框
3. 授权后重启本应用生效；设置页「权限检测」可随时验证

## npm / webui 版本

```bash
npm i -g workbuddy-switch
workbuddy-switch              # 启动本地服务 + 自动打开浏览器
workbuddy-switch status       # 终端查看当前账号
```

界面与桌面 App 一致，功能覆盖上方全部模块，但不提供会话悬浮窗（桌面版专属）。webui 模式下的 macOS 权限由启动服务的终端进程决定；若终端已授权完全磁盘访问则无需额外操作。

## 管理后台

仓库包含独立的 `wb-switch-admin` 服务，用于管理匿名安装统计和版本发布记录。启动方式与环境变量见 [管理后台文档](docs/admin-backend.md)。客户端默认接入线上后台 API `https://admin.woai.info/api`，也可在设置页「后台服务」保存自建地址，或在构建时用 `VITE_WB_ADMIN_URL` 注入；匿名心跳跟随同一后台地址发送。

管理后台还支持配置 Sub2API Base URL 和管理员 API Key。管理员 Key 只在后台加密保存；手机号用户登录后，后台自动创建并加密保存该用户专属 API Key，客户端只读取当前用户可用模型，不会收到管理员 Key。

## 致谢

感谢 [Linux.do](https://linux.do) 社区。

## 许可

[MIT](./LICENSE)

## 隐私政策

小玉米API默认将账号凭据、模型配置和业务缓存保存在用户设备或用户指定的后台服务中。应用不会将 WorkBuddy 账号凭据或 API Key 发送给项目维护者。

应用可向用户配置的后台地址发送匿名安装心跳，用于统计安装规模和功能使用情况。心跳可能包含随机安装 ID、应用版本、操作系统、架构、语言、账号数量和功能事件计数，不包含账号凭据、模型 API Key、手机号、聊天内容或请求正文。用户可以通过不使用后台服务或在网络层阻止该请求来停止心跳发送。

项目维护者仅为提供服务、排查故障和发布更新而处理必要数据，不出售或用于广告画像。隐私问题和数据删除请求可联系 `wishjoxgood@gmail.com`。本政策会随数据处理方式变化而更新。
