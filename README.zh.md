# DeepSeek Harness Lanyard

[English](README.md) | 简体中文

在自己的网络里用手机访问 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的网页界面，通过配对令牌保护。

设备只需打开一次配对链接完成配对，之后直接访问地址即可；网络上的其他设备无法访问。

## 为什么需要它

`dsh web` 只绑定 `127.0.0.1`，并且拒绝 `--host 0.0.0.0`，这是有充分理由的：`/api` 会以 `dsh` 进程的身份执行命令，未经认证的局域网绑定等于把远程代码执行交给网络上的任何人。但这个拒绝也挡住了它本要保护的场景——在沙发上接着处理会话。

`lanyard` 补上缺失的认证层，让这个绑定变得安全。

**不修改 Harness 源码。** 它以普通插件包的形式安装。

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

在手机上打开一次并接受自签名证书。页面会保存令牌、从地址栏中清除它，并在之后每次访问时自动出示——此后直接访问 `https://192.168.1.5:3080` 即可。

### 命令行参数

| 参数 | |
|---|---|
| `--host 0.0.0.0` | 对局域网提供服务；必须配合配对令牌 |
| `--pairing-token-env <name>` | 存放令牌的凭据名称（至少 16 个 `A-Za-z0-9_-` 字符） |
| `--keep-awake` | 保持主机唤醒，避免休眠中断手机的连接 |
| `--port`、`--no-open`、`--trusted-host` | 与上游一致 |

令牌通过**引用**指定，而非直接写入配置，因此任何回显配置的界面（`dsh --dump-config`、崩溃转储）都不会泄露它。取值来自环境变量、凭据存储或 `.env` 层。

## 已配对手机能做什么

配对认证的是**设备**，而不是坐在机器前的人。因此已配对的手机可以使用会话相关的功能——对话、命令、目标——而任何会改动这套安装的操作仍然只限本机：

- **仅限回环地址访问：** 设置、凭据、Agent 预设、系统原生对话框、模型发现，以及任何本次构建未明确归类的 Gateway 命名空间。
- **URL 片段不会上网。** `#auth=…` 只存在于 URL 片段中，浏览器不会把它发送出去，因此令牌既不会进入服务端日志，也不会经过任何代理。
- **TLS 在进程内终止**，从而保留真实的客户端地址。若改成转发代理，所有请求都会看起来来自本机，等于让整个网关失效。

## 已知限制

- **单一共享密钥，无法吊销。** 轮换意味着更换凭据并重启；无法单独解除某台设备的配对。
- **隧道等同于本机。** `adb reverse` 或 `ssh -R` 会让设备成为回环对端，从而跳过令牌**并**触达配置面。请把它视同交出自己的键盘。
- **页面脚本可以读取令牌**——这是必然的，因为浏览器端需要保存它。
- **自签名证书**，每台设备接受一次。网络变化会再次提示；服务仍然可用，因为准入判断从不依赖证书。
- **与所继承的载体版本耦合。** 未来的 `@deepseek-ai/dsh-host-webserver` 可能使其失效——按设计会明确报错，绝不会悄悄退回明文服务。

## 配置

默认值是安全的，且默认拒绝；如需覆盖，请在 profile 的 `cordis.patch.yml` 中重写整个 `lanyard-webserver` 行。

| 字段 | 默认值 |
|---|---|
| `pairedNamespaces` | `commands`、`goals`、`messageFeedback`——其余一律仅限回环 |
| `privilegedMethods` | 被固定在本机的配置面 |
| `apiPathPrefix`、`publicPaths`、`loopbackOnlyPaths`、`publicPathExcludedSuffixes` | 上游客户端包所使用的路径 |

这些路径归客户端包所有，而不属于本插件，因此它们是配置项而非常量。一旦某个路径不再匹配，载体会在启动时发出警告并指明是哪一个。

## 开发

```sh
pnpm install
npm run check              # 类型检查、单元测试、构建校验
npm run test:e2e           # 启动真实的 dsh，并通过 TLS 驱动网关
npm run test:e2e:browser   # 在真实浏览器中完成配对流程
```

架构说明与不可破坏的关键约束见 [AGENTS.md](AGENTS.md)。

## 许可证

MIT
