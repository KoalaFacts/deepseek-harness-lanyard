# DeepSeek Harness Lanyard

[English](README.md) | 简体中文

在自己的局域网里用手机访问 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Web 界面，用配对令牌把关。

手机只要打开一次配对链接，之后直接输入地址就能用；同一个网络里的其他设备则进不来。

## 解决什么问题

`dsh web` 默认只绑定 `127.0.0.1`，并且直接拒绝 `--host 0.0.0.0`。原因很实际：`/api` 会以 `dsh` 进程的身份执行命令，一旦在没有认证的情况下监听局域网，等于把远程执行代码的能力向整个网络敞开。

代价是正当的用法也被一并挡住了，比如想窝在沙发上，用手机接着处理刚才的会话。

`lanyard` 补上这层缺失的认证，让局域网监听变得安全。

**不改动 Harness 源码**，以普通插件包的形式安装。

## 安装

```sh
dsh plugin --profile web add @koalafacts/deepseek-harness-lanyard
```

```sh
export DSH_PAIRING_TOKEN="$(node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))")"
dsh --profile web --host 0.0.0.0 --pairing-token-env DSH_PAIRING_TOKEN
```

启动时会打印配对链接：

```
lanyard: pair a device by opening https://192.168.1.5:3080/#auth=<token> once
```

在手机上打开一次，并信任这张自签名证书。页面会把令牌存下来，同时从地址栏里抹掉，之后每次访问都自动带上。从此直接访问 `https://192.168.1.5:3080` 就行。

### 命令行参数

| 参数 | |
|---|---|
| `--host 0.0.0.0` | 对局域网提供服务，必须同时给出配对令牌 |
| `--pairing-token-env <name>` | 存放令牌的凭据名（至少 16 位，取值为 `A-Za-z0-9_-`） |
| `--keep-awake` | 阻止主机休眠，免得手机用到一半被断开 |
| `--port`、`--no-open`、`--trusted-host` | 与上游行为一致 |

配置里写的是令牌的**引用名**，不是令牌本身。凡是会回显配置的地方（`dsh --dump-config`、崩溃转储等）都拿不到它；真正的取值放在环境变量、凭据存储或 `.env` 里。

## 配对之后，手机能做什么

配对只能证明设备的身份，不能证明操作的人就坐在这台机器前面。所以配对过的手机拿到的是会话层面的能力：对话、命令、目标（goals）；凡是会改动这套安装本身的操作，仍然只能在本机进行。

- **只允许本机访问的部分**：设置、凭据、Agent 预设、系统原生对话框、模型发现，以及所有没有被明确归类过的 Gateway 命名空间。
- **令牌不会出现在请求里**。`#auth=…` 属于 URL 的 fragment，浏览器根本不会把这一段发给服务端，所以它既不会落进服务端日志，也不会经过任何代理。
- **TLS 在进程内解密**，客户端的真实地址因此得以保留。如果换成端口转发，所有请求看上去都来自本机，整套准入判断就形同虚设。

## 已知限制

- **只有一个共享密钥，而且无法吊销**。要轮换就得改凭据再重启，也没办法单独把某一台设备踢掉。
- **隧道等同于本机**。用 `adb reverse` 或 `ssh -R` 打通之后，设备在服务端看来就是本机连接，既跳过令牌，也能碰到配置类接口。开这种隧道，相当于把键盘直接交给对方。
- **页面脚本读得到令牌**。这是没办法的事：令牌本来就由浏览器端保存和出示。
- **自签名证书**，每台设备首次访问时手动信任一次。换了网络会再弹一次提示，但服务照常可用，因为准入判断从来不看证书。
- **和所继承的 Web 服务器版本绑定**。将来某个版本的 `@deepseek-ai/dsh-host-webserver` 有可能让它失效；真出了问题会直接报错退出，不会悄悄退回明文。

## 配置

默认配置是安全的，没列出来的一律拒绝。要覆盖，就在 profile 的 `cordis.patch.yml` 里把整个 `lanyard-webserver` 条目重写一遍。

| 字段 | 默认值 |
|---|---|
| `pairedNamespaces` | `commands`、`goals`、`messageFeedback`，其余一律只允许本机 |
| `privilegedMethods` | 锁在本机的那批配置类接口 |
| `apiPathPrefix`、`publicPaths`、`loopbackOnlyPaths`、`publicPathExcludedSuffixes` | 上游客户端包实际使用的路径 |

这些路径归客户端包所有，不归本插件，所以做成配置项而没有写死。哪天某个路径对不上了，Web 服务器会在启动时告警，并指出是哪一个。

## 开发

```sh
pnpm install
npm run check              # 类型检查、单元测试、构建校验
npm run test:e2e           # 起一个真实的 dsh，通过 TLS 驱动准入
npm run test:e2e:browser   # 在真实浏览器里跑一遍配对流程
```

架构说明，以及那些动手前必须先读的关键约束，见 [AGENTS.md](AGENTS.md)。

## 许可证

MIT
