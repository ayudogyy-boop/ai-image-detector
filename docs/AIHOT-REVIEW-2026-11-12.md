# AIHOT 架构与授权模式对照

研究对象：[官方 KKKKhazix/AIHOT](https://github.com/KKKKhazix/AIHOT)，查阅于 2026-11-12，仓库树 `d342846e785db3a9a713a869efbc78b9a2dca67c`。对照本项目基线：2.2.1，提交 `d8ff40c4f65617a7fc09758806b8939e5b2d46e0`。

## 判断

借鉴共享契约、集中规则、接收边界校验和许可分层，保留图片扩展的本地架构。AIHOT 的新闻管线与数据库/任务队列解决的是持续采集、服务公开读取的问题；照搬其服务端会增加部署、隐私和维护成本，不能提高图片模型的辨别能力。

授权要区分三件事：MIT 源码、官方服务的数据使用规则、管理员身份认证。它们不互相替代。用户已选择保持私有与 MIT，不做账号/激活码。

## 对官方实现的核对

| 设计 | 官方代码/文档 | 对本项目的启发 |
|---|---|---|
| API、worker、web 分工 | [架构](https://github.com/KKKKhazix/AIHOT/blob/d342846e785db3a9a713a869efbc78b9a2dca67c/docs/architecture.md)：后台任务执行采集和模型调用，网页读已存结果 | UI 不承担模型生命周期；保留 content → background → offscreen 分工，不增数据库 |
| 配置与框架分开 | [定制说明](https://github.com/KKKKhazix/AIHOT/blob/d342846e785db3a9a713a869efbc78b9a2dca67c/docs/customize.md)：site 放站点身份，industry 放行业规则，modules 放站点功能 | 三份设置默认值合并成纯共享模块；不为小扩展拆成多包工程 |
| 单一读取规则 | [publication/scope.ts](https://github.com/KKKKhazix/AIHOT/blob/d342846e785db3a9a713a869efbc78b9a2dca67c/packages/backend/src/publication/scope.ts) 统一公开出口的筛选条件 | 本项目已经用 scoreAnalysis 统一页面和评测评分，继续保留；设置读取也统一 |
| 跨边界契约 | [contracts/http-policy.ts](https://github.com/KKKKhazix/AIHOT/blob/d342846e785db3a9a713a869efbc78b9a2dca67c/packages/contracts/src/http-policy.ts) 统一出站接口策略；后台写入口校验 schema | 消息类型、URL 与布尔开关统一定义，接收时校验，不靠发送方自律 |
| 后台访问控制 | [admin-auth.ts](https://github.com/KKKKhazix/AIHOT/blob/d342846e785db3a9a713a869efbc78b9a2dca67c/apps/api/src/routes/admin-auth.ts)、[auth.ts](https://github.com/KKKKhazix/AIHOT/blob/d342846e785db3a9a713a869efbc78b9a2dca67c/packages/backend/src/admin/auth.ts)：密码/可选飞书、会话、写请求 CSRF、登录限流 | 借鉴“明确谁能调用哪一层”；用 Chrome 本扩展 id 与上下文角色控制消息，不伪造离线登录系统 |
| 可执行边界约束 | [architecture.test.ts](https://github.com/KKKKhazix/AIHOT/blob/d342846e785db3a9a713a869efbc78b9a2dca67c/tests/architecture.test.ts) 检查模块依赖 | 增加真实边界行为回归，检查旧存储迁移、错误载荷与伪造就绪回执；最终包在 Chrome 验证 |
| 重试与副作用管理 | 架构文档说明付费请求回执、限额与结果复用 | 本扩展没有付费调用；已有并发限制、共享初始化及失败不缓存，保留，不引入计费回执系统 |

## 本轮实施

1. **共享设置**：新增 `src/shared/contracts.js`，后台、content、options、popup 都使用它。按字段恢复不完整/损坏存储，保留显式 false，恢复缺失的信号项；延时选项也来自同一份列表。storage 删除和替换字段走同一规范化逻辑，沿用设置代次隔离缓存。
2. **消息边界**：统一消息名称与分析请求结构。后台接受 content 的分析、UI/content 的设置请求、offscreen 的就绪回执；offscreen 只接受后台探针和分析；content 的统计只响应 UI/后台。空载荷、错误布尔类型、异常 URL 在产生分析副作用前拒绝。
3. **许可分层**：保留本项目 MIT 正文，新增 NOTICE、许可边界说明、模型来源与 ORT 来源记录；补齐 ORT MIT 和上游第三方告知，保留 C2PA/信任列表许可。
4. **交付约束**：构建随包拷贝契约和许可/来源记录，自检覆盖新入口引用及许可文件，拒绝把评测、测试图片、依赖目录或私有配置放进验证包。

未改变模型、评分公式、40/60 颜色、证据优先级、下载次数与并发数。不自动上传图片，不调用 AIHOT 服务，不复制它的代码或品牌。版本号更新为 2.2.2，以便区分本地验证包与 GitHub 上的 2.2.1；未发布。

## 仍须审查

- **模型质量**：旧 240 张样本 AUC 0.6527 是 2.2.1 历史测量，不是本轮新增评测，也不代表现代生成器。下轮应先做许可明确、按生成器/压缩/截图/AI 编辑分组的独立评测，再决定是否换模型。
- **素材权利**：上游模型卡 MIT 声明不替代完整版权告知；部分历史测试图片缺少来源/权限。见 [许可待审查项](LICENSING.md)。未擅自删除或替换图片。
- **运行边界**：超大像素图的解码内存、blob/鉴权图片读取与移动端交互仍是原有限制。本轮 URL 校验只是边界检查，不保证这些图片可读取，也不提供完整的网络目的地隔离或防重定向机制。
- **CI**：新增共享契约回归纳入本地 `npm run test:all`，现有工作流未修改；完整纯 Node 回归仍未接入 CI。修改 CI 需另行授权。
- **发布/服务**：仓库保持私有，当前没有自营在线服务。商用服务条款、账号或激活码没有实施需求；未来应先定义产品与隐私范围。

本轮验证结果记录在 README 与 CHANGELOG；复现命令为 `npm run test:all`、`npm run build`，再把 ZIP 解压到独立目录并执行 `node eval/test-extension.mjs --ext <解压目录>`。
