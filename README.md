# dsh-spring-widget

> DSH (DeepSeek Harness) plugin: IDEA-style **Spring Boot backend service manager** in the top bar.
> DSH 插件：顶栏 IDEA 式 **Spring Boot 后端服务管理器**。

Manage your Spring Boot backend right from the DSH top bar: source-mode launch / packaged-jar launch / stop / restart, with a live 3-tab log console (Service Logs · Request Logs · Build Output). No need to leave the conversation to watch or control your backend process.

在 DSH 顶栏一键管理 Spring Boot 后端：源码直启 / Jar 打包启动 / 停止 / 重启，带实时三页签日志控制台（服务日志 · 请求日志 · 编译输出），无需离开对话即可观察与操作后端进程。

![badge-dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-2ea44f)
![badge-spring-boot](https://img.shields.io/badge/Spring%20Boot-4.x-6db33f)
![badge-license](https://img.shields.io/badge/license-UNLICENSED-lightgrey)

---

## 📷 Screenshots / 界面预览

| Service Logs · 服务日志 | Request Logs · 请求日志 |
|---|---|
| ![console](docs/shot-console.png) | ![access](docs/shot-access.png) |

| Config Panel · 配置面板 |
|---|
| ![config](docs/shot-config.png) |

---

## ✨ Features / 功能特性

### 🚀 Launch Modes / 启动模式

| Mode / 模式 | Description / 说明 |
|---|---|
| **▶ Source Launch · 源码直启** | `mvn compile` incremental build + `java @argfile` direct launch of the main class — **no packaging needed** for iterate-and-run (generates `target/sbsv-args.txt` to bypass Windows command-line length limits) |
| **📦 Package & Launch · 打包并启动** | `mvn clean package -DskipTests` (**cleans previous build residue first**), then `java -jar` |
| **Jar Launch · Jar 启动** | Launch the existing packaged jar directly (skip rebuild) |

### 📺 3-Tab Live Log Console / 三页签实时日志控制台

| Tab / 页签 | Content / 内容 |
|---|---|
| **Service Logs · 服务日志** | App stdout/stderr (UTF-8 enforced, no garbled Chinese text) |
| **Request Logs · 请求日志** | Tomcat access log — one line per HTTP request: `time IP method path status:xxx bytes:xxx cost:xxxµs` |
| **Build Output · 编译输出** | Maven compile/package output (stdout + stderr merged) |

- **Incremental polling · 增量拉取**: pulls only new content every second, logs scroll in real time
- **Follow-scroll · 跟随滚动**: auto-scrolls to bottom; scrolling up pauses follow automatically
- **Clear · 清屏**: clears only the **currently active tab** (service / request / build), keeps read offsets so history never flashes back
- **Copy · 复制**: one-click copy of the active tab's full log

### 🗂 Grouped Config Panel / 分组配置面板

- **Path settings · 路径配置**: project dir / JDK / Maven (auto-detected from PATH when blank)
- **Launch settings · 启动配置**: main class / port / jar name (auto-detected when blank)
- **Custom directory picker · 自绘目录选择器**: breadcrumb navigation + subdirectory list + manual path input; JDK root → auto-appends `bin\java.exe`
- Config persisted to `~/.dsh/spring-widget.json`, survives restarts

### 🌙 Dark/Light Theme Ready / 深浅色主题适配

Fully adapts to DSH light/dark themes — tabs, buttons and titles stay readable in dark mode.

---

## 📦 Install / 安装

### From GitHub Release / 从 GitHub Release 安装

```bash
dsh plugin add dsh-spring-widget --source github:wrw-dev/dsh-spring-widget
```

### Local Development (link mode, hot-reload) / 本地开发安装（link 模式，改代码即时生效）

```bash
# In your profile package.json dependencies add:
#   "dsh-spring-widget": "link:C:/<username>/.dsh/plugins/dsh-spring-widget"
# And add "dsh-spring-widget" to the dsh.profile.bundles array
```

**Host changes** (`index.js`) require a DSH restart; **client changes** (`client/client.js`) take effect on page refresh (the webserver serves the bundle live).

宿主改动（`index.js`）需重启 DSH；客户端改动（`client/client.js`）刷新页面即可生效（webserver 实时下发）。

---

## 🎮 Usage / 使用

1. **后端服务** widget appears on the right of the top bar (⚙ button + status dot + log entry)
2. Click the widget to open the console
3. Click **▶ 源码启动** or **📦 打包并启动**
4. Watch real-time output in the **服务日志 / 请求日志 / 编译输出** tabs
5. Stop or restart via **■ 停止** / **⟳ 重启**

> 💡 First launch auto-detects project structure (JDK, Maven, main class, port); you can also set them manually in **⚙ 配置**.

首次启动会自动探测项目结构（JDK、Maven、主类、端口），也可在「⚙ 配置」里手动指定。

---

## ⚙️ Configuration / 配置项

| Field / 字段 | Description / 说明 | Auto-detect / 自动探测 |
|---|---|---|
| `cwd` | Project dir (server dir) · 项目目录 | ✅ Locate pom.xml / yml |
| `javaPath` | java.exe path · JDK 路径 | ✅ java on PATH |
| `mavenHome` | Maven root · Maven 根目录 | ✅ mvn on PATH |
| `mainClass` | Main class · 主类入口 | ✅ Scan @SpringBootApplication |
| `port` | Service port · 端口 | ✅ bootstrap.yml / application.yml |
| `jarName` | Jar file name · Jar 名 | ✅ pom.xml finalName / artifactId |

Stored in `~/.dsh/spring-widget.json`:

```json
{
  "cwd": "E:/path/to/project/server",
  "javaPath": "E:/JAVA/JDK/JDK25/bin/java.exe",
  "mavenHome": "F:/Software/Maven/apache-maven-3.9.15",
  "mainClass": "com.example.AppApplication",
  "port": "16110",
  "jarName": ""
}
```

---

## 📁 Project Structure / 项目结构

```
dsh-spring-widget/
├── index.js            # Host half: service management, subprocess, RPC, springboot_service tool
│                       # 宿主半区：服务管理、子进程、RPC、模型工具
├── client/
│   └── client.js       # Browser half: top-bar widget, console UI, config panel
│                       # 浏览器半区：顶栏微件、控制台 UI、配置面板
├── docs/               # README screenshots / README 截图
│   ├── shot-console.png
│   ├── shot-access.png
│   └── shot-config.png
├── cordis.patch.yml    # Plugin assembly declaration / 插件装配声明
└── package.json        # Plugin metadata / 插件元数据
```

---

## 🔌 Model Tool / 模型工具

Installs tool **`springboot_service`** automatically — control the backend via chat:

```
springboot_service action=start mode=src                    # Source launch / 源码直启
springboot_service action=start mode=jar rebuild=true       # Package & launch / 打包并启动
springboot_service action=stop                              # Stop / 停止
springboot_service action=status                            # Status + log tail / 状态+日志尾部
```

---

## 🧱 Technical Notes / 技术实现要点

- **RPC channel**: host `ctx.connection.rpc.handle('/spring-widget', ...)` ↔ client `connection.rpc.call('/spring-widget', ...)` (dedicated channel, never conflicts with the official `/api`)
- **Subprocess capture**: `SubprocessCollect` memory tail window + spill to disk (lost head recoverable)
- **Encoding fix**: JDK18+ defaults to native encoding → JVM flags `-Dstdout.encoding=UTF-8` / `-Dstderr.encoding=UTF-8` / `-Dlogging.charset.console=UTF-8`
- **Request logs**: Tomcat access log enabled via JVM flags (`-Dserver.tomcat.accesslog.enabled=true`), written to `~/.dsh/spring-widget-access/`, read incrementally by the host and shown in the UI
- **Maven execution**: `cmd.exe /c <mvn.cmd>` (Node 24 forbids direct `.cmd` spawn)

---

## © License

UNLICENSED — internal use / 内部使用。

---

## 🔗 Related / 相关

- [DeepSeek Harness](https://github.com/deepseek-ai/dsh)
- [DSH plugin ecosystem / dsh-plugin topic](https://github.com/topics/dsh-plugin)