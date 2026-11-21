# 余额显示（dsh-balance-display-simple）

## 使命

在 DSH 侧边栏顶部品牌行（deepseek 标题）正下方显示 **DeepSeek API 余额**，实时刷新。
名字里的 `simple` 是实话：只做「查余额、显示余额」，没有图表、历史记账、多供应商切换。

## 用户要求

1. 侧边栏标题下方显示余额（`API 余额 ¥19.74` + 状态圆点）
2. 每 60 秒自动刷新，点击余额条立即刷新
3. 浏览器 / 渲染进程**不接触 API Key**
4. 端点必须过 DSH 自己的访问栅栏（market 维护者 fkysly 在 #17363 提出的要求，0.1.1 已补）

## 架构

| 半区 | 文件 | 职责 |
| --- | --- | --- |
| Host | `lib/index.js` | 注册 `kind: 'exact'` 路由 `GET /api/deepseek-balance-simple`；先调 `ctx.connection.requestRejection(request)`（Host/Origin 校验 + 浏览器登录，401/403），老版 DSH 无该服务时退回 `isTrustedLoopbackRequest`（只放行回环 Host、拒绝 `sec-fetch-site: cross-site`、Origin 与 Host 不一致）；余额来源两条：先调可选服务 `ctx.get('deepseekAccount')` 的 `getBalance({ version, locale, timezoneOffsetSeconds })`（DeepSeek 账号 OAuth 登录，免 API Key；把充值 `value` + 赠送 `bonusWallets` 按币种求和，响应 `source: 'account'`），服务缺失、未登录（null）或失败时回退 `credentials` 的 `DEEPSEEK_API_KEY` → `https://api.deepseek.com/user/balance`（15s 超时，响应 `source: 'apiKey'`）；统一 `cache-control: no-store` |
| Client | `lib/client.js` | `window.__ModuleLoader__.load(...)` 客户端模块；MutationObserver 监听侧栏，把余额条插到品牌按钮所在行之后 |

- 包名 / 插件 id：`dsh-balance-display-simple`；patch id：`balance-display-simple`（`cordis.patch.yml`）。
- DOM 常量：`dsh-balance-display-simple-chip` / `-style` / `-debug`，余额条元素 class 仍是 `dsh-balance-chip`。
- exact 路由优先于 `client-connection` 注册的 `/api` 前缀路由，因此路径不冲突。
- 端点返回：成功 `{ ok: true, fetchedAt, is_available, balance_infos: [...] }`；被栅栏拒绝时 `{ ok: false, error: 'unauthorized' | 'forbidden' }`（HTTP 401/403）；其余失败 `{ ok: false, error }`（HTTP 200）。
- 渲染：余额条右侧有一段时段文字（`lib/client.js` 顶部 `SLOGAN_PREFIX` / `SLOGAN_SUFFIX` / `PEAK_NAME` / `VALLEY_NAME`），按 DeepSeek 峰谷定价二选一：峰时（周一至周五 09:00–12:00、14:00–18:00，北京时间）显示「此时是 梁文锋时段」，其余时间显示「此时是 梁文谷时段」，其中的“其余时间”= 周末全天（含调休上班的周末，DeepSeek 明确按谷时）+ 中国法定节假日全天 + 工作日非峰窗口；节假日表见 `lib/client.js` 的 `HOLIDAY_DATES`（2026 / 2027 国务院通知，每年更新）；每次刷新重算；中间的名字单独成 `span.dsh-balance-slogan-name`：17px、左右各 5px 间距；谷时加 `is-valley`（亮绿 `#34c759` + 绿色微光、整段不透明，表示“开心”），峰时加 `is-peak`（灰蓝 `#8d94a4`、600 字重、无光晕、整段 opacity .58，表示“沮丧”）（余额条元素间距 5px，260px 侧栏下不截断）；前缀/后缀 11px 灰色，整段紧接在余额数值后面左对齐，空间不够时省略号；
  余额条顺序：状态圆点（`dsh-balance-dot`，最前）→ `API 余额` 标签 → 金额 → 时段文字（`ensureDotFirst()` 会在热重载后把圆点挪回最前）；多币种 `balance_infos` 用 ` · ` 拼接，金额 `toFixed(2)`；`is_available === false` 圆点红，请求失败圆点橙并保留上次数值；侧栏折叠成 rail（祖先类名含 `collapsed`）时隐藏。
- 挂载幂等：DOM 里已有 chip 就复用；React 重渲染后由 MutationObserver（300ms 节流）重新挂载。
- 卸载：`ctx.effect` 返回的 disposer 清定时器、断 observer、移除余额条。

## 文件位置

- 源码 / 本地克隆：`D:\zhangsir_code\my-dsh-pluging\dsh-balance-display-simple\`（本仓库的本地副本，remote = GitHub）
- GitHub：`https://github.com/happyde2b/dsh-balance-display-simple`（public，MIT，已收录 DSH Market）
- 安装目标：`D:\DeepSeekHarness\dsh-home\profiles\desktop\node_modules\`
- 数据家：`D:\DeepSeekHarness\dsh-home`；profile：`desktop`
- 本机 profile 现在装的就是 `dsh-balance-display-simple`（目录 junction 到本仓库）；旧包名 `dsh-balance-display` 已于 2026-11-21 移除。

## 安装 / 生效

1. 打包：`node install.js --pack` → `<DSH_HOME>\downloads\dsh-balance-display-simple-<版本>.tgz`
   （npm tarball 规范：内容在顶层 `package/` 下；排除 `install.js`、`scripts`、`.git`）
2. DSH 侧栏「**插件**」→「**添加插件**」→ 填 tgz **绝对路径** → 「安装」→ 「立即启用」
3. 本机开发推荐：用插件管理器以**目录**安装（`plugin_manager install_bundle`，生成指向本目录的 junction），改源码后按刷新按钮即生效，不用重启；本机 profile 现在就是这样装的
4. 命令行备选：`node install.js`（复制安装 + 更新 profile manifest 的 `dependencies` / `dsh.profile.bundles`，可用 `--profile` / `--dsh-home`）
5. **重启桌面端**生效（tgz/复制安装时；目录 junction 安装按刷新按钮即可）

## 验证

- 语法：`node --check lib/index.js`、`node --check lib/client.js`、`node --check install.js`
- 客户端冒烟（mock DOM 跑注册 → 挂载 → 注入 → 拉取 → 卸载）：`node scripts/smoke.js`
- Host 半区（真实导入 + mock ctx：路由形状、405、栅栏 401/403、缺 credentials 分支）：`node scripts/verify-host.js`
- 端点（桌面端运行中）：`curl http://127.0.0.1:<DSH Web 端口>/api/deepseek-balance-simple`
- 截图（不含真实账户信息，余额固定 `¥17.42`）：`assets/preview.html?state=valley|peak` 用 Edge headless
  （`--headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 --window-size=260,200`，
  宽度等于侧栏 260px，避免右侧空白）渲染成临时 raw，再把底部空行裁掉、四周留 36 CSS px 底色（`#17181c`），
  输出固定 520×248 的 `assets/screenshot-valley.png` / `screenshot-peak.png`（裁剪脚本见 `preview.html` 注释；品牌行用 `assets/wordmark.svg`——从 DSH 前端包提取的原版 182×24 字标，仅截图用）；
  图标 `assets/icon-preview.html` → `assets/icon.png`（512 CSS px ×2 = 1024×1024）
- 图标：插件行图标是包根 `icon.svg`（36×36，透明底、只画 `¥` + 绿点，容器由 DSH 画；`package.json` 顶层
  `"icon": "icon.svg"`，必须包内、≤256 KiB，绝对路径/URL 会被拒）；市场卡片图标是 `assets/icon.svg` /
  `assets/icon.png`（512 深色圆角瓦片，市场需要自带底）。标题/描述来自 `locale/zh.json`、`locale/en.json`
  的 `meta.title` / `meta.description`（插件未激活时也会读）
- 市场截图约定：仓库根 `screenshots.json` 是 awesome-dsh-plugin 的「作者自声明截图」文件（1-8 张、必须是
  GitHub 图床的 https URL），比 catalog 的 `data/screenshots.json` 优先；README 里的 `assets/*.png` 则用于
  市场安装弹窗的自动抽取

## 踩过的坑

1. **不能靠文本找锚点**：品牌按钮内容可能只有 SVG，必须按 CSS Modules 类名（含 `brand`）匹配；
   兜底用「新会话」按钮（类名含 `newSession`），插到它前面。
2. **React 重渲染会移除注入节点** → 必须 MutationObserver 持续 ensure，并且 `ensure()` 要幂等
   （插件被加载两次时只保留一条余额条）。
3. **挂载失败要可见**：`#dsh-balance-display-simple-debug` 红色提示条只在从未成功挂载过时出现，成功后自动移除。
4. **浏览器不碰 Key**：所有上游请求都在 Host 半区；`credentials` 服务在部分 profile 不可用，
   此时端点返回明确的 `ok:false` 说明，而不是 500。
5. **端点必须过访问栅栏**：只挂在 webServer 上、不调 `connection.requestRejection` 时，浏览器里任何网页
   都能读余额（market 描述里被加了警告）。0.1.1 已补，回退逻辑覆盖老版 dsh。
6. **远端 SHA ≠ 本地 SHA**：2026-11-15 / 11-21 两次推送都因 `github.com` 直连不通走了 git data API，
   远端 `030b355` 与本地 `bc197e6` 树相同、SHA 不同；网络恢复后 `git fetch && git reset --hard origin/main` 对齐。
