# thu-tok-auto（THU Tok Auto）

DSH / DeepSeek Harness 的 Cordis 插件：一键获取清华大学 MadModel 平台
（`madmodel.cs.tsinghua.edu.cn`）的最新 API token，自动写入 DSH 模型配置，
并支持到时自动续期。

- **Get**：立即获取最新 token（校园网内免登录签发，实测无需任何账号/密码），
  写入 DSH 凭据 `MADMODEL_API_KEY` 并自动创建/复用模型 Provider
  `llm-pi-ai.providers.madmodel`（baseURL 指向 madmodel）。
- **Auto**：开关自动续期。开启后计时超过 **05:50** 自动触发 Get，
  自动任务运行在 Host 侧，与页面是否打开无关。
- **计时器**：显示「距最近一次 Get 的本地经过时间」`hh:mm`；
  达到 100 小时后显示 `Too Long!`（表示该去管管了）。
  悬浮提示同时给出剩余有效期（如「剩余 5h12m」）。

默认挂在左侧边栏底部：**「设置」按钮上方**；若设置上方已有其他插件的按钮
（如 Remote），则置于**最顶部按钮的上方**。Get/Auto 在左、计时器在右，
与 DSH 主题一致。找不到设置按钮时退回左下角固定浮层。

## 安装

作为 **DSH profile bundle**（正式 npm 插件）安装，随 profile 声明同步：

```sh
dsh plugin --profile web add thu-tok-auto
```

然后**重启 DSH Web**（或对应 profile）使插件加载。也可手动在
`~/.dsh/profiles/web/package.json` 的 `dependencies` 与 `dsh.profile.bundles`
中加入 `thu-tok-auto` 后重新安装。

更新：

```sh
dsh plugin --profile web up thu-tok-auto
```

## 使用

1. 安装并重启后，侧边栏底部「设置」上方出现 **[●] [Get] [Auto] ✓ | hh:mm** 控件
   （若 Remote 等插件已在设置上方，则排在其最上方）；
2. 点 **Get** —— 校园网内直接签发成功，绿点亮起，token 已写入；
3. 点 **Auto** 开启自动续期：按钮变灰、右侧出现绿色 **✓**（再次点击关闭）。

校外或凭据失效时的兜底：Get 会自动回退到已保存 SSO 会话；仍无法签发时，
手动点击 Get 会打开 Edge/Chrome 登录窗口，登录完成后自动捕获并继续。
后台 Auto 不会自行弹出登录窗口，只会把状态标记为「需要登录」。

## 工作原理

### 获取阶梯（依次尝试）

| 层级 | 方式 | 说明 |
| --- | --- | --- |
| 1 | `GET /model-api/auth-login/check`（无凭据） | 校园网内直接签发全新 token（实测可用，免登录） |
| 2 | 复用已保存 token | 仅当旧 token 仍被 `/model-api/auth-login` 校验通过 |
| 3 | SSO 重放 | 使用已保存的 `id.tsinghua.edu.cn` Cookie 走一遍票据流程 |
| 4 | 需要登录 | 手动 Get 时打开 Edge/Chrome（CDP 捕获），登录后写入 |

成功签发的 token 会同时写入：

- DSH 凭据：`credentials.set('MADMODEL_API_KEY', token)`
- DSH 模型配置：查找 baseURL 含 `madmodel.cs.tsinghua.edu.cn` 的 Provider；
  不存在则自动创建 `llm-pi-ai.providers.madmodel`
  （`api: openai-completions`、`apiKeyEnv: MADMODEL_API_KEY`，模型
  `DeepSeek-V4-Flash-0731`）。插件只写目标 Provider，不会把其他 Provider
  复制成用户层覆盖。

### 时间语义（实测数据）

- 签发接口（`/auth-login/check`）发出的 JWT：**`exp − iat == 6h` 整**（多次采样）。
  站点 API 手册写 5h，是登录签发场景的保守说法；本插件按实测 6h 处理。
- 签发服务的时钟比本地快约 9.6 分钟：JWT 的 `iat/exp` 不可直接与本地时钟比对。
  因此新签发 token 一律以**本地时钟**记录 `lastGetAt = Date.now()`。
- 旧 token 仅通过有效性校验而被复用时，不会重置 `lastGetAt`，避免把剩余寿命
  错算成新的 6 小时。
- 显示剩余 = `lastGetAt + 6h − now`；计时 = `now − lastGetAt`。
- **Auto 间隔 05:50**：6h 寿命 − 10 分钟缓冲，两种口径下都安全。
- 计时从未获取过/无基准时显示 `--:--`；超过 99:59 显示 `Too Long!`。

## 平台限制（重要）

- 插件以 profile bundle 形式运行在 DSH 宿主进程，UI 由宿主在每次整页加载时
  注入全局脚本：**页面刷新（F5）后按钮自动重新出现**（不再需要重新激活插件）。
- UI 信息（状态、计时基准）通过 `/thu-tok-auto/api/*` 每 10 秒轮询更新，
  计时器本身在页面本地每秒走字。
- 本机浏览器登录捕获依赖 Edge/Chrome 的 DevTools 调试端口（本机 9333–9343）。

## 状态与文件

- 状态文件：`%USERPROFILE%\.dsh\madmodel\state.json`
  （cookies、ssoCookies、lastGetAt、auto；不再保存 token）。旧版状态中的 token
  会迁移到 DSH 凭据存储，并从状态文件移除。
- 登录浏览器配置目录：`%USERPROFILE%\.dsh\madmodel\profile\`；从本机 CDP 端口
  9333–9343 中选择未占用端口，只连接 URL 主机名严格匹配清华域的页面。
- token 只写入 DSH 凭据引用 `MADMODEL_API_KEY`，不会通过 HTTP 发给浏览器，
  也不会出现在任何子进程命令行中。
- 无任何遥测；网络访问仅限 MadModel 与清华统一身份认证域名，以及本机 CDP。

## 兼容性与验证

- Node.js >= 22（登录捕获使用 Node 内置 WebSocket 与 fetch）；已按 DSH
  `0.1.2-rc.1` 的 profile bundle（`dsh.bundle.patch`）、settings、credentials、
  timer、webServer、connection 与 `llm-pi-ai` 接口核对。
- `npm run check`：检查 Host/核心/UI 语法与补丁声明。
- `npm test`：运行 token 生命周期、Provider 写入、Host Auto、登录捕获与敏感信息
  边界回归测试（发布前 prepack 自动执行）。

## 开发与源码

- GitHub：<https://github.com/OverDustD7/thu-tok-auto>
- npm：<https://www.npmjs.com/package/thu-tok-auto>
- 源码结构：
  - `lib/core.js` —— 核心逻辑（依赖注入，可独立单测）：获取阶梯、凭据/配置写入、
    状态迁移、Auto 判据、登录捕获编排；
  - `lib/index.js` —— Cordis 插件入口：装配真实环境（Node fetch/WebSocket/fs、
    DSH settings/credentials/timer/webServer/connection），提供
    `/thu-tok-auto/api/*` 与 UI 注入；
  - `lib/ui.js` —— 浏览器端全局脚本 UI。

`0.2.0` 及更早版本为「DSH 会话内动态 Cordis 插件」形态（`lib/host.js` /
`lib/client.js`）；`0.2.1` 起改为可直接安装的 profile bundle。行为与状态文件
路径保持一致，切换无需迁移。

## License

MIT