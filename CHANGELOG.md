# 版本记录

## 0.3.27 — 2026-11-28

- 在侧栏的「账号」中，可选保存、替换或清除清华统一身份认证账号。Windows 用 DPAPI 当前用户作用域加密保存，限制文件访问权限。
- 会话失效后，Get 或 Auto 可用保存的账号尝试登录。插件只在自己启动的无窗口浏览器中识别清华密码登录表单，并调用官网原有的提交动作。
- 未配置、密码被拒或需要额外验证时，保留原有流程。手动 Get 可以打开登录窗口，定时 Auto 不弹窗。
- 修复账号接口重复注册导致侧栏控件无法加载、登录页尚未加载就退出、以及错误原因没有显示的问题。
- Windows 上实测手动 Get 在无窗口浏览器中提交登录、通过服务端校验并写入令牌。定时 Auto 仍待验收。

## 0.3.25 — 2026-11-24

- Provide an English main README and preserve the detailed Chinese guide in the npm package.
- Document status signals, local session data, browser permissions, upgrade and removal behavior.
- Check the 20-minute Auto interval in both language guides.
- Observe the widget's own width and avoid rewriting unchanged UI text and classes.
- Verify the actual release archive with the existing isolated fixture suite. Live THU login and natural Auto renewal remain subject to the known limitations.

## 0.3.24 — 2026-10-09

本次汇总发布 0.3.6 之后的本地迭代；未合并 GitHub PR #1、#2、#3。

- 登录完成后自动捕获、校验、写入凭据并同步模型配置，一次 Get 即可完成。
- Auto 每 20 分钟尝试续期，失败按 5–30 分钟退避；后台不弹出可见登录窗口。
- 会话恢复先核验自有浏览器身份，再注入按域、路径和有效期筛选的 cookie，最后访问登录入口。
- 修复宿主 timer 不提供 `sleep()` 时的崩溃；冷启动先读取实例身份，并跳过浏览器内部页面。
- 调试端口被占时继续选择可用端口，必要时使用独立的临时 profile。
- 记录自有浏览器的启动证据；关闭后验证结果，证据不足时拒绝终止进程。新增自有残留清理工具。
- 面板区分网络故障、校验未知、令牌被拒、配置未同步与到期时间未前进，分别保留手动和自动运行记录。
- 改善侧栏挂载、重新挂载、窄栏显示和重复点击提示。
- 增加浏览器归属、端口选择、会话恢复等回归覆盖，发布门禁共 213 项测试。
- 校正文档中的时钟偏差方向、清理行为与测试数量；排除本机浏览器资料和诊断输出。

真实站点的无窗口指纹流程与自然 20 分钟 Auto 续期仍需现场验收，详见
[已知限制](./docs/KNOWN_LIMITATIONS.md)。本次没有加入校外 WebVPN 或 localhost 代理支持。

## 0.3.6 — 2026-10-01

- 同一枚令牌再次返回不视为续期成功，保护仍然可用的凭据。
- 延续既有 1M 上下文配置、模型列表同步与侧栏 Get / Auto 入口。
