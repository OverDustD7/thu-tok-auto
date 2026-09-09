# thu-tok-auto（THU Tok Auto）

DSH / DeepSeek Harness 的 Cordis 插件：一键获取清华大学 MadModel 平台
（`madmodel.cs.tsinghua.edu.cn`）的最新 API token，自动写入 DSH 模型配置，
并支持到时自动续期。

- **Get**：立即获取最新 token（校园网内免登录签发，实测无需任何账号/密码），
  写入 DSH 凭据 `MADMODEL_API_KEY` 并自动创建/复用模型 Provider
  `llm-pi-ai.providers.madmodel`（baseURL 指向 madmodel）。
- **Auto**：开关自动续期。开启后计时超过 **05:50** 自动触发 Get，
  自动任务运行在 Host 侧，即使页面刷新后按钮暂时消失也会继续工作。
- **计时器**：显示「距最近一次 Get 的本地经过时间」`hh:mm`；
  达到 100 小时后显示 `Too Long!`（表示该去管管了）。
  悬浮提示同时给出剩余有效期（如「剩余 5h12m」）。

默认显示在左下角侧边栏（设置区上方），14px，与 DSH 主题一致。

## 使用

1. 在 DSH 中加载本插件（动态 Cordis 插件，见「分发形态」）。
2. 点 **Get** —— 校园网内直接签发成功，绿点亮起，token 已写入；
3. 点 **Auto**（显示 `Auto ✓`）开启自动续期。

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

DSH 的动态 Client 插件在**页面硬刷新（F5）后不会自动重新挂载**：
刷新后按钮会消失，但 Host 侧的 Auto 续期仍正常运行。恢复方法：重新激活该插件
（例如在 DSH 会话中对该插件重新 run/update），当前已打开的页面会通过
热更新自动恢复 UI，**无需再次刷新页面**。

日常使用建议：避免刷新 DSH 页面；UI 信息（状态、计时）会通过内部 RPC
每 10 秒自动更新。

## 状态与文件

- 状态文件：`%USERPROFILE%\.dsh\madmodel\state.json`
  （cookies、ssoCookies、lastGetAt、auto；不再保存 token）。旧版状态中的 token
  会迁移到 DSH 凭据存储，并从状态文件移除。
- 登录浏览器配置目录：`%USERPROFILE%\.dsh\madmodel\profile\`；从本机 CDP 端口
  9333–9343 中选择未占用端口，只连接 URL 主机名严格匹配清华域的页面。
- token 只写入 DSH 凭据引用 `MADMODEL_API_KEY`，不会通过 RPC 发给浏览器，
  也不会出现在辅助进程命令行中。
- 无任何遥测；网络访问仅限 MadModel 与清华统一身份认证域名，以及本机 CDP。

## 兼容性与验证

- Node.js >= 22（登录捕获使用 Node 内置 WebSocket）；已按 DSH `0.1.2-rc.1`
  的动态 Cordis、settings、credentials、subprocess 与 `llm-pi-ai` 接口检查。
- `npm run check`：检查动态 Host/Client 函数体语法。
- `npm test`：运行 token 生命周期、Provider 写入、Host Auto、登录捕获与敏感信息
  边界回归测试。

## 分发形态

当前为 **DSH 会话内动态 Cordis 插件源码**：`lib/host.js` 与 `lib/client.js`
分别是 Host/Client 两半。动态 pluginId/packageId 由具体 DSH 会话分配，源码
更新后需要在目标会话中重新 define/update 并激活；正式 npm / GitHub 发布待定。

## License

MIT
