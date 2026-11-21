# dsh-balance-display-simple

DSH 侧边栏顶部品牌行下方实时显示 **DeepSeek API 账户余额**。

> 名字里的 `simple` 是实话：只做「查余额、显示余额」。没有图表、历史记账、多供应商切换。

## 功能

- 侧边栏 deepseek 标题正下方显示 `API 余额 ¥19.74`，多币种用 ` · ` 拼接
- 每 60 秒自动刷新；点击余额条立即刷新
- 状态圆点：绿 = 正常，红 = 账户不可用，橙 = 查询失败（保留上次数值）
- 侧边栏折叠成 rail 时自动隐藏
- 跟随主题配色

## 安全设计

浏览器 / 渲染进程**不接触 API Key**：

- **Host 半区**（`lib/index.js`）注册同源端点 `GET /api/deepseek-balance-simple`，通过 `credentials`
  服务解析 `DEEPSEEK_API_KEY`（来源：进程环境 > `<DSH_HOME>/.credentials.yaml` > `.env`），
  由服务端调用 `https://api.deepseek.com/user/balance`（15 秒超时，`cache-control: no-store`）。
- 端点先过 dsh 自己的访问栅栏 `ctx.connection.requestRejection(request)`（Host/Origin 校验与浏览器登录，
  拒绝时返回 401/403），与 dsh 内置 `/api` 路由一致；老版本 dsh 没有该服务时退回 loopback 信任栅栏，
  只放行回环 Host、拒绝 cross-site 请求。因此浏览器里打开的外部网页无法调用这个端点。
- **Client 半区**（`lib/client.js`）只请求这个本地端点，经 MutationObserver 在侧边栏品牌行后注入余额条，
  React 重渲染后自动重新挂载。

## 安装

前置：Node.js 20+；`DSH_HOME` 指向 DSH 数据家，或用 `--dsh-home` 显式传入。

**方式 A：手动复制（不需要 pnpm）**

```powershell
git clone https://github.com/happyde2b/dsh-balance-display-simple.git
cd dsh-balance-display-simple
node install.js                  # → <DSH_HOME>\profiles\desktop\node_modules\dsh-balance-display-simple
node install.js --profile web    # 指定 profile
# 同时更新 profile 的 package.json（dependencies + dsh.profile.bundles）
```

**方式 B：官方插件管理器**

```powershell
node install.js --pack           # 产物：<DSH_HOME>\downloads\dsh-balance-display-simple-<版本>.tgz
# 在 DSH「插件 → 添加插件」里填该 tgz 的绝对路径，安装后启用
```

安装后**重启 DSH 桌面端**生效。

## 配置

暂无配置项。轮询间隔在 `lib/client.js` 顶部 `REFRESH_MS = 60000`，改后重启桌面端。

## 验证

```powershell
node --check lib/index.js
node --check lib/client.js
```

桌面端运行中可直接查端点：

```powershell
curl http://127.0.0.1:<DSH Web 端口>/api/deepseek-balance-simple
# {"ok":true,"fetchedAt":...,"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":"19.74"}]}
```

## 目录结构

```
lib/index.js        Host 半区：注册余额端点
lib/client.js       Client 半区：侧边栏余额条
cordis.patch.yml    bundle 配置层（插入插件行）
install.js          手动安装 / 打包脚本
```

## 许可

MIT
