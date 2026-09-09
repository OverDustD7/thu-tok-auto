# THU Tok Auto：DSH 插件检查与修改报告

日期：2026-09-09  
审查版本：0.1.0 → 0.2.0  
目标运行时：DeepSeek Harness（本机安装版本 `0.1.2-rc.1`）

## 1. 范围与方法

本次逐行检查了工作目录内全部原始文件：

- `lib/host.js`（DSH 动态 Cordis Host 半）
- `lib/client.js`（DSH 动态 Cordis Client 半）
- `package.json`
- `README.md`
- `LICENSE`

同时对照本机安装的 DSH `settings`、`credentials`、`subprocess`、动态 Cordis
Host/Client runner、`llm-pi-ai` 实现与公开文档核验接口。工作目录不是 Git 仓库，
因此本报告以审查前读取到的文件为基线，无法提供 Git commit/diff 标识。

## 2. 主要问题与处理结果

| 级别 | 问题 | 影响 | 处理 |
| --- | --- | --- | --- |
| 严重 | 新建 `madmodel` 路由缺少 `api` | 当前 DSH 的手工 `llm-pi-ai` 路由可能被校验拒绝 | 补充 `api: openai-completions`，并用本机真实 schema 验证 |
| 严重 | token、Cookie 作为 `node -e` 命令行参数传入辅助进程 | 可被进程列表或诊断工具读取 | 改为通过 stdin 传入，命令行不再携带机密 |
| 高 | Host snapshot 向 Client 返回 token 前 26 字符 | 无 UI 用途，却扩大了浏览器侧暴露面 | 完全删除 `tokenPreview`；删除未使用的复制 token RPC |
| 高 | token 明文重复保存于 `state.json` | 绕过 DSH 凭据隔离，增加落盘副本 | token 只存 DSH credentials；旧状态自动迁移并清除 token 字段 |
| 高 | 复用旧 token 时重置 `lastGetAt` | 将旧 token 错算为又有 6 小时寿命，可能中途过期 | 仅新签发/登录捕获时重置；复用保留原基准 |
| 高 | Auto 计时只存在于 Client | F5 导致 Client 消失后，自动续期实际停止 | Auto 迁至 Host 定时器；Client 只显示状态与控制开关 |
| 高 | 登录捕获的无 token 分支未调用凭据/Provider 写入 | UI 可显示成功，但模型仍使用旧凭据 | 两条捕获成功路径统一完成凭据与 Provider 写入 |
| 高 | CDP 在无清华页面时回退到任意页面 | 可能读取无关页面的 `localStorage.user.token` 并误写 | 只接受主机名严格匹配的清华页面；删除任意页面回退 |
| 高 | 信任 CDP 返回的任意 WebSocket 地址 | 被占用端口上的恶意服务可诱导外连 | WebSocket 仅允许 `ws://127.0.0.1|localhost|[::1]` 且端口一致 |
| 高 | Cookie 域通过子串判断、SSO 跳转不限制域名 | 可能误收相似恶意域，或把 SSO Cookie 发往越域跳转 | 改为域后缀边界匹配；SSO 仅允许指定清华认证域与 MadModel |
| 高 | 2.5 秒捕获定时器可重叠执行 20 秒任务 | 多个 CDP 辅助进程并发、重复写入与竞态 | 增加单飞锁，上一轮完成前不启动下一轮 |
| 高 | 更新一个 Provider 时复制整个 `providers` 到用户层 | 把继承配置固化为用户覆盖，干扰后续组合更新 | 只提交目标 Provider 的最小 patch |
| 高 | 配置更新失败后用不完整 patch 执行 `replace` | 可能清除 namespace 其他顶层字段 | 删除危险的整体替换回退 |
| 中 | Client `catch` 引用了 `try` 块内的 `report` | 首次挂载异常时二次抛出 `ReferenceError` | 将报告函数提升到 `try` 外，并加入失败路径测试 |
| 中 | 动态 Host 未声明服务依赖 | 服务消失时插件不会按 Cordis 生命周期停驻 | 声明 subprocess/timer/fs/settings/credentials 注入依赖 |
| 中 | 固定使用 9333，冲突时直接误复用 | 本机已有调试服务时登录失败或误连 | 在 9333–9343 中探测匹配实例或选择空闲端口 |
| 中 | 状态写入非原子且错误被吞掉 | 中断时可能损坏 JSON，UI 仍显示成功 | 临时文件 + rename，错误上抛并反映到状态 |
| 中 | 持久状态未校验类型与未来时间 | 损坏数据可让 Auto 长期不执行 | 限制字符串长度、校验数值并拒绝异常未来时间 |
| 中 | 无语法、行为或打包验证 | 修改后容易回归 | 新增 11 项测试、check/prepack 脚本与 `.gitignore` |

## 3. 文件修改摘要

### `lib/host.js`

- 补全 DSH `llm-pi-ai` Provider 的协议字段。
- 改为目标 Provider 最小写入，保留用户自定义名称、模型及其他 Provider。
- 将 Auto 调度放到 Host，并提供 5 分钟失败重试节流。
- 修正旧 token 复用、登录捕获、状态恢复和部分失败状态。
- 收紧 SSO、Cookie、CDP 页面与 WebSocket 的信任边界。
- 敏感参数通过 stdin 传入辅助进程；状态文件不再保存 token。
- 增加原子状态写入、旧状态迁移、输入规范化和捕获并发保护。
- 声明完整的 Cordis 服务注入依赖，定时器跟随插件 fiber 释放。

### `lib/client.js`

- 移除 token preview 与 Provider 名称强制同步逻辑。
- 移除 Client 侧 Auto 调度，避免与 Host 重复执行。
- 保留每 10 秒状态刷新、Get/Auto 控件与计时显示。
- 修复挂载失败报告的作用域错误；错误提示可显示 Host 的部分失败信息。

### `package.json`、README 与工程文件

- 版本提升至 `0.2.0`，Node 最低版本调整为 22（登录捕获依赖内置 WebSocket）。
- 新增 `check`、`test`、`prepack`。
- README 更新 Host Auto、凭据存储、CDP 端口、安全边界、兼容性与动态分发说明。
- 删除会话特定且已过时的 pluginId/packageId 描述。
- 新增 `.gitignore`、`test/check.mjs`、`test/plugin.test.mjs`。

`LICENSE` 内容正确，未修改。

## 4. 验证结果

### 自动化测试

`npm test`：11/11 通过，覆盖：

1. 动态 Host/Client 函数体语法；
2. Client overlay 挂载及声明式生命周期 API；
3. 新 token 签发与合法 Provider 创建；
4. 已有 Provider 的用户字段保留；
5. 旧 token 复用不重置寿命；
6. 旧版明文 token 迁移且不覆盖较新凭据；
7. 登录捕获 fallback 完整写入；
8. SSO 越域跳转拒绝；
9. 无 Client 页面时 Host Auto 执行；
10. 状态文件重复原子覆盖与 stdin 输入；
11. CDP 严格主机与禁止任意页面回退。

### DSH 与打包兼容

- 用本机 `@deepseek-ai/dsh-llm-pi-ai@0.1.2-rc.1` 的真实 `Config` schema
  解析新 Provider 成功。
- `npm run check` 通过。
- `npm pack --dry-run --json` 通过；发布清单仅包含 LICENSE、README、
  `lib/host.js`、`lib/client.js` 与 `package.json`，无测试、缓存或敏感状态文件。

## 5. 仍需真实环境验收的事项

- 本次没有执行真实清华账号登录，也没有改动当前 DSH 会话中的运行包；这样可避免
  触发真实认证和覆盖正在使用的动态插件。需要在校园网/校外各做一次手动 Get 验收。
- 6 小时 JWT 寿命、约 9.6 分钟签发时钟偏差与模型 ID 来自项目既有实测记录；
  MadModel 公开页面会跳转清华认证，未能从无需登录的公开文档独立确认。
- DSH 的动态 Client 在 F5 后不自动恢复仍是平台限制；本次保证 Host Auto 不受影响，
  但按钮仍需重新激活动态包才能恢复。
- SSO Cookie 仍需持久化在用户目录状态文件中才能重放。文件写入请求 `0600` 权限，
  Windows 上最终保护还取决于用户目录继承 ACL；不应共享该目录。

## 6. 部署建议

在目标 DSH 会话中以新的 `lib/host.js` 与 `lib/client.js` 重新 define/update 并激活。
首次升级后检查 `%USERPROFILE%\.dsh\madmodel\state.json` 已无 `token` 字段，再分别验证：

1. Get 后模型选择器出现/保留 MadModel 路由；
2. 发起一次最小模型请求；
3. 开启 Auto，确认状态持久化；
4. F5 后等待 Host 状态继续推进，再重新激活 Client 验证 UI 恢复。

DSH 参考：

- <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/extensions.md>
- <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/providers.md>
- <https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm-pi-ai/README.md>
