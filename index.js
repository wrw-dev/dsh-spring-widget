// dsh-spring-widget — host half.
// Spring Boot 后端服务管理器（多服务版，IDEA 运行控制台式）：
// - 每个服务独立配置（名称/目录/JDK/Maven/主类/端口/Jar 名），持久化到 ~/.dsh/spring-widget.json
// - 每个服务独立进程与日志流，多个服务可同时运行；源码直启（mvn 增量编译 + @argfile 直启主类）或 Jar 启动
// - 浏览器控制台通过 /spring-widget RPC 通道访问；目录浏览（listDir）由插件宿主端用 Node fs 实现
//   （宿主网关 host.listDirectory 需要 browse 能力，本机组装只有 native，插件侧无法升级，故自带实现）
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, openSync, readSync, closeSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-spring-widget'
export const inject = ['tools', 'connection', 'subprocess', 'timer']

const CONFIG_PATH = join(homedir(), '.dsh', 'spring-widget.json')
const ACCESS_DIR = join(homedir(), '.dsh', 'spring-widget-access')
const DEFAULT_CWD = 'E:\\ALLSTAR\\code\\AI_MES\\kingdee_sync-server\\server'
const FALLBACK_MAIN = 'com.allstar.ai_mes.kingdee_sync.KingdeeSyncServerApplication'

export function apply(ctx) {
  const sub = ctx.subprocess
  const fs = () => ctx.get('fs')

  // ---------- 多服务运行态：每服务一套独立状态（进程/构建/日志流/轮询），互不干扰可并发 ----------
  let svcSeq = 0
  const newId = () => 'svc-' + Date.now().toString(36) + (++svcSeq).toString(36) + Math.random().toString(36).slice(2, 5)
  const newInstance = (id) => ({
    id,
    phase: 'stopped', pid: 0, startedAt: 0, cwd: '', cwdSource: '', jar: '', jarExists: null, jarName: '',
    javaFound: false, javaPath: '', mavenHome: '', mainClass: '', port: 0,
    mode: 'src', exitInfo: null, note: '', lastError: '',
    cfg: { name: '', cwd: '', javaPath: '', mavenHome: '', mainClass: '', port: '', jarName: '' },
    detected: { cwd: '', javaPath: '', mavenHome: '', javaVersion: '' },
    proc: null, lastProc: null, buildProc: null, pollStop: null,
    userStop: false, buildText: '', buildTruncated: false, buildOff: 0, buildSeq: 0,
    outState: { reader: null, proc: null }, errState: { reader: null, proc: null },
    detectedOnce: false, detecting: false,
  })
  const services = new Map() // id -> instance
  let activeId = ''

  const baseName = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''
  const svcName = (I) => String(I.cfg.name || '').trim() || (I.cfg.cwd ? baseName(I.cfg.cwd) : '服务')

  const snapshot = (I) => ({
    id: I.id, name: svcName(I),
    phase: I.phase, pid: I.pid, startedAt: I.startedAt, cwd: I.cwd,
    cwdSource: I.cwdSource, jar: I.jar, jarExists: I.jarExists, jarName: I.jarName,
    javaFound: I.javaFound, port: I.port, mode: I.mode, mainClass: I.mainClass,
    exitInfo: I.exitInfo, note: I.note, lastError: I.lastError,
    cfg: { ...I.cfg }, detected: { ...I.detected }, now: Date.now(),
  })
  const stateAll = () => ({ activeId, services: [...services.values()].map(snapshot) })

  // 按 id 解析服务；id 未知时按名称兜底（模型工具传服务名），再退回活动服务
  function getSvc(id) {
    const key = String(id || '').trim()
    if (key && services.has(key)) return services.get(key)
    if (key) {
      for (const I of services.values()) if (svcName(I) === key) return I
    }
    return services.get(activeId) || services.values().next().value
  }

  // ---------- 路径规范化与探测 ----------
  // JDK 路径允许填 java.exe 完整路径，也允许填 JDK 根目录 / bin 目录
  // 注意：用 Node 原生 existsSync 校验——fs 服务的 stat 对工作区外的路径（如 E:\JAVA）会判失败
  function resolveJavaExe(p) {
    let s = String(p || '').trim().replace(/^"|"$/g, '').replace(/[\\/]+$/, '')
    if (!s) return ''
    const candidates = /java\.exe$/i.test(s) ? [s] : [s + '\\bin\\java.exe', s + '\\java.exe']
    for (const c of candidates) {
      try { if (existsSync(c)) return tidyExePath(c) } catch { /* 下一个 */ }
    }
    return ''
  }
  // Maven 路径归一到根目录：支持根目录 / bin 目录 / mvn.cmd 完整路径
  function normalizeMavenHome(p) {
    let s = String(p || '').trim().replace(/^"|"$/g, '')
    s = s.replace(/[\\/]mvn(\.cmd|\.bat|\.exe)?$/i, '')     // 去掉 mvn 可执行文件名
    s = s.replace(/[\\/]+$/, '').replace(/[\\/]bin$/i, '')   // 去掉结尾的 bin 段
    return s.replace(/[\\/]+$/, '')
  }
  // 大小写规范化：扩展名转小写（E:\...\java.EXE → ...java.exe）
  function tidyExePath(p) {
    return String(p || '').trim().replace(/(\.(exe|cmd|bat))$/i, (m) => m.toLowerCase())
  }
  // 探测工具的绝对路径：resolveExecutable 已给绝对路径则直接用；否则 where 兜底
  async function whereTool(name, I) {
    try {
      const direct = await sub.resolveExecutable(name)
      if (direct && /[\\/]/.test(direct)) return tidyExePath(direct)
      const cmd = await sub.resolveExecutable('cmd.exe')
      if (!cmd) return ''
      const w = sub.spawn({
        argv: [cmd, '/c', 'where', name],
        cwd: (I && I.cwd) || undefined,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 8192 }, stderr: 'ignore' },
        graceMs: 6000,
      })
      const out = await w.done
      if (!out || out.exitCode !== 0) return ''
      const text = String((out.collected.stdout && out.collected.stdout.readFrom(0).text) || '')
      return text.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)[0] || ''
    } catch { return '' }
  }

  // ---------- 配置持久化（Node fs，无沙箱）：{ activeId, services: [{id, name, cwd, ...}] } ----------
  // 旧版扁平单服务配置首次加载时自动迁移为第一个服务，不丢数据
  function loadConfigFile() {
    try {
      if (!existsSync(CONFIG_PATH)) return
      const saved = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
      if (!saved || typeof saved !== 'object') return
      if (Array.isArray(saved.services) && saved.services.length > 0) {
        for (const sc of saved.services) {
          if (!sc || typeof sc !== 'object') continue
          const id = String(sc.id || '').trim() || newId()
          if (services.has(id)) continue
          const inst = newInstance(id)
          for (const k of Object.keys(inst.cfg)) {
            if (sc[k] !== undefined && sc[k] !== null && String(sc[k]) !== '') inst.cfg[k] = String(sc[k])
          }
          services.set(id, inst)
        }
        activeId = String(saved.activeId || '')
        if (!services.has(activeId)) activeId = services.keys().next().value
      } else {
        const inst = newInstance(newId())
        for (const k of Object.keys(inst.cfg)) {
          if (k === 'name') continue
          if (saved[k] !== undefined && saved[k] !== null && String(saved[k]) !== '') inst.cfg[k] = String(saved[k])
        }
        inst.cfg.name = inst.cfg.cwd ? baseName(inst.cfg.cwd) : '服务 1'
        services.set(inst.id, inst)
        activeId = inst.id
        saveConfigFile() // 迁移结果立即落盘
      }
    } catch { /* 无配置或解析失败 → 默认 */ }
    if (services.size === 0) {
      const inst = newInstance(newId())
      inst.cfg.name = '服务 1'
      services.set(inst.id, inst)
      activeId = inst.id
    }
  }
  function saveConfigFile() {
    try {
      writeFileSync(CONFIG_PATH, JSON.stringify({
        activeId,
        services: [...services.values()].map((I) => ({ id: I.id, ...I.cfg })),
      }, null, 2))
    } catch { /* 不阻断 */ }
  }

  // 通过 subprocess 写文件（stdin 管道：无长度限制、无引号转义问题）
  async function writeFileViaStdin(I, absOrRelPath, content) {
    const cmd = await sub.resolveExecutable('cmd.exe')
    if (!cmd) throw new Error('未找到 cmd.exe')
    const quoted = /^[A-Za-z]:[\\/]/.test(absOrRelPath) ? '"' + absOrRelPath + '"' : absOrRelPath
    const w = sub.spawn({
      argv: [cmd, '/c', 'more', '>', quoted],
      cwd: I.cwd || undefined,
      stdio: { stdin: { data: content }, stdout: 'ignore', stderr: { maxBytes: 16384 } },
      graceMs: 8000,
    })
    const outcome = await w.done
    if (!outcome || outcome.exitCode !== 0) {
      throw new Error('写入 ' + absOrRelPath + ' 失败: exit ' + (outcome ? outcome.exitCode : '?'))
    }
  }

  // ---------- 自动探测（按服务） ----------
  async function detect(I) {
    if (!I.cfg.cwd && !I.cwd) {
      const agents = ctx.get('agents')
      let cwd = ''
      if (agents) {
        try {
          const init = agents.currentInitiator ? agents.currentInitiator() : undefined
          cwd = (init && init.session && init.session.header && init.session.header.cwd) || ''
          if (cwd) I.cwdSource = '当前会话'
        } catch { /* 忽略 */ }
      }
      if (!cwd) { cwd = DEFAULT_CWD; I.cwdSource = '内置默认' }
      I.cwd = cwd
    }
    if (I.cfg.cwd) { I.cwd = String(I.cfg.cwd); I.cwdSource = '配置文件' }

    const f = fs()
    let pomText = ''
    if (f) {
      // 端口：配置 > bootstrap.yml > application.yml
      if (I.cfg.port && Number(I.cfg.port) > 0) {
        I.port = Number(I.cfg.port)
      } else {
        I.port = 0
        for (const yml of ['src/main/resources/bootstrap.yml', 'src/main/resources/application.yml']) {
          try {
            const t = await f.resolve(yml, { cwd: I.cwd })
            const text = String(await f.readText(t) || '')
            const m = /(^|\n)\s*port:\s*(\d+)/.exec(text)
            if (m) { I.port = Number(m[2]); break }
          } catch { /* 下一个 */ }
        }
      }
      // 主类 + Jar 名：读 pom.xml
      try {
        const t = await f.resolve('pom.xml', { cwd: I.cwd })
        pomText = String(await f.readText(t) || '')
      } catch { pomText = '' }
      if (I.cfg.mainClass) I.mainClass = String(I.cfg.mainClass)
      else {
        const m = /<mainClass>\s*([^<\s]+)\s*<\/mainClass>/.exec(pomText)
        I.mainClass = m ? m[1] : FALLBACK_MAIN
      }
      if (I.cfg.jarName) I.jarName = String(I.cfg.jarName)
      else {
        const jn = /<finalName>\s*([^<\s]+)\s*<\/finalName>/.exec(pomText)
        const noParent = pomText.replace(/<parent>[\s\S]*?<\/parent>/, '')
        const art = /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/.exec(noParent)
        const ver = /<version>\s*([^<\s]+)\s*<\/version>/.exec(noParent)
        const artId = art ? art[1] : ''
        if (jn) I.jarName = jn[1].replace(/\$\{project\.artifactId\}/g, artId)
        else if (artId) I.jarName = ver ? artId + '-' + ver[1] : artId
        if (!I.jarName) I.jarName = baseName(I.cfg.cwd || I.cwd) || 'app'
      }
      I.jar = I.cwd.replace(/[\\/]+$/, '') + '/target/' + I.jarName + '.jar'
      try {
        const t = await f.resolve('target/' + I.jarName + '.jar', { cwd: I.cwd })
        I.jarExists = !!(await f.stat(t))
      } catch { I.jarExists = false }
    }
    // ---------- JDK / Maven 自动探测（配置优先，其次 PATH） ----------
    I.detected = { cwd: I.cwd, javaPath: '', mavenHome: '', javaVersion: '' }
    if (I.cfg.javaPath) {
      // 配置的 JDK 路径：支持 java.exe / JDK 根目录 / bin 目录，统一归一到 java.exe
      const exe = resolveJavaExe(I.cfg.javaPath)
      I.javaPath = exe || String(I.cfg.javaPath)
      I.javaFound = !!exe
      I.detected.javaPath = I.javaPath
      if (!I.javaFound) I.lastError = 'JDK 路径无效：' + I.cfg.javaPath
    } else {
      // 未配置 → 从 PATH 探测 java，作为「自动检测」候选展示
      I.javaPath = ''
      I.javaFound = !!(await sub.resolveExecutable('java'))
      if (I.javaFound) I.detected.javaPath = await whereTool('java', I)
      if (!I.javaFound) I.lastError = '未找到 java（PATH），可在配置中填写 JDK 路径'
    }
    if (I.cfg.mavenHome) {
      I.mavenHome = normalizeMavenHome(I.cfg.mavenHome)
      I.detected.mavenHome = I.mavenHome
    } else {
      // 未配置 → 从 PATH 探测 mvn，归一到 Maven 根目录作为候选
      I.mavenHome = ''
      const mvnExe = await whereTool('mvn', I)
      if (mvnExe) I.detected.mavenHome = normalizeMavenHome(mvnExe)
    }
    if (I.javaFound && (!I.lastError || I.lastError.indexOf('JDK') !== 0)) I.lastError = ''
    I.detectedOnce = true
    return snapshot(I)
  }
  // 惰性探测：status 轮询时给从未探测过的服务异步补一轮 detect（不阻塞轮询）
  function ensureDetect() {
    for (const I of services.values()) {
      if (I.detectedOnce || I.detecting) continue
      I.detecting = true
      detect(I).catch(() => {}).finally(() => { I.detecting = false; I.detectedOnce = true })
    }
  }

  // Maven 命令：配置了 mavenHome → 其 bin\mvn.cmd 绝对路径；否则 PATH 解析
  // 注意1：.cmd 不能被 Node 直接 spawn（CVE-2024-27980 修复后抛 EINVAL），必须经 cmd.exe /c
  // 注意2：路径作为独立 argv 项传入，不内嵌引号——Windows 引号拼接后 cmd 会收到字面引号导致不识别
  async function mvnArgv(I) {
    const cmd = await sub.resolveExecutable('cmd.exe')
    if (!cmd) throw new Error('未找到 cmd.exe')
    let target = 'mvn'
    if (I.mavenHome) {
      const p = I.mavenHome.replace(/[\\/]+$/, '') + '\\bin\\mvn.cmd'
      if (!existsSync(p)) throw new Error('未找到 ' + p + '，请检查 Maven 目录配置')
      target = p
    }
    return [cmd, '/c', target]
  }

  // 子进程统一用 UTF-8 输出：JDK18+ 的 java/mvn 默认跟随系统控制台编码（中文 Windows=GBK），
  // 浏览器端按 UTF-8 解码会乱码，故强制 -Dstdout/-Dstderr.encoding=UTF-8 + MAVEN_OPTS
  const UTF8_ENV = { MAVEN_OPTS: '-Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8' }
  const JAVA_UTF8_ARGS = ['-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8']
  // Tomcat access log（每个 HTTP 请求一行：方法/URI/状态/耗时）+ 控制台日志 UTF-8（修 stderr 乱码）
  // 每个服务写独立子目录 ~/.dsh/spring-widget-access/<id>/，多服务并发时请求日志互不串扰
  function accessArgs(I) {
    const dir = join(ACCESS_DIR, I.id).replace(/\\/g, '/')
    return [
      '-Dserver.tomcat.accesslog.enabled=true',
      '-Dserver.tomcat.accesslog.directory=' + dir,
      // 格式：时间 IP 方法 路径 状态:HTTP状态码 字节:响应体字节数 耗时:微秒(÷1000=毫秒)
      '-Dserver.tomcat.accesslog.pattern=%{yyyy-MM-dd HH:mm:ss}t %h %m %U 状态:%s 字节:%b 耗时:%Dus',
      '-Dserver.tomcat.accesslog.rotate=true',
      '-Dserver.tomcat.accesslog.buffered=false',
      '-Dlogging.charset.console=UTF-8',
    ]
  }
  const javaAllArgs = (I) => JAVA_UTF8_ARGS.concat(accessArgs(I))

  // Windows Defender/索引服务会瞬时锁定 target 下的文件，导致 mvn clean 删到一半
  // 就报 "Failed to delete ..." 整体失败。手动递归清理（带回退重试 + 延迟）绕开瞬时锁，
  // 然后再让 mvn clean 收尾。返回是否清理出东西。
  async function clearTargetDir(I) {
    try {
      if (!existsSync(I.cwd)) return false
      const target = join(I.cwd, 'target')
      if (!existsSync(target)) return false
      // 最多 5 轮，每轮 300ms 延迟：瞬时锁一般 1-2 轮内消失
      for (let i = 0; i < 5; i++) {
        try {
          rmSync(target, { recursive: true, force: true })
          return true
        } catch {
          await new Promise((res) => setTimeout(res, 300))
        }
      }
      return false // 5 轮后仍有锁，交给 mvn clean 报错（不静默吞）
    } catch { return false }
  }

  async function runMaven(I, args, label) {
    const head = await mvnArgv(I)
    I.phase = 'building'; I.note = label
    I.buildSeq++
    I.buildText = ''; I.buildTruncated = false; I.buildOff = 0
    let mvnArgs = ['-B'].concat(args)
    // clean 前先手动清 target，绕开 Windows 对 target 文件的瞬时锁定（Defender/索引）
    if (args.includes('clean')) await clearTargetDir(I)
    I.buildProc = sub.spawn({
      argv: head.concat(mvnArgs),
      cwd: I.cwd,
      env: UTF8_ENV,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 262144 }, stderr: { maxBytes: 262144 } },
      graceMs: 15000,
    })
    I.pid = I.buildProc.pid
    // 同时泵 stdout + stderr：Maven 错误（尤其 clean 删除失败）走 stderr，丢掉会吞掉原因
    const pump = ctx.interval(() => {
      if (!I.buildProc) return
      try {
        const so = I.buildProc.collected.stdout
        if (so) { const r = so.readFrom(0); if (r) I.buildText += r.text }
        const se = I.buildProc.collected.stderr
        if (se) { const r = se.readFrom(0); if (r) I.buildText += r.text }
        if (I.buildText.length > 300000) I.buildText = I.buildText.slice(-300000)
      } catch { /* 忽略 */ }
    }, 800)
    let outcome
    try { outcome = await I.buildProc.done }
    finally { pump(); I.buildProc = null }
    I.pid = 0
    if (!outcome || outcome.exitCode !== 0) {
      I.phase = 'crashed'
      I.note = label + '失败（exit ' + (outcome ? outcome.exitCode : '?') + '），详情见编译输出'
      throw new Error(label + '失败: exit ' + (outcome ? outcome.exitCode : '?'))
    }
  }

  // 源码直启准备：增量编译 + 依赖 classpath + @argfile（绕开 Windows 32KB 命令行限制）
  // classpath/argfile 文件名带服务 id：两个服务共用同一项目目录时也不会互相覆盖
  async function compileAndResolve(I) {
    const cpName = 'sbsv-cp-' + I.id + '.txt'
    await runMaven(
      I,
      ['-DskipTests', 'compile', 'dependency:build-classpath', '-Dmdep.outputFile=target/' + cpName],
      '正在增量编译并解析依赖（mvn compile + dependency:build-classpath）…',
    )
    const f = fs()
    if (!f) throw new Error('fs 服务不可用')
    const cpTarget = await f.resolve('target/' + cpName, { cwd: I.cwd })
    let cp = String(await f.readText(cpTarget) || '').trim()
    if (!cp) throw new Error('依赖 classpath 为空，请检查 Maven 本地仓库配置')
    cp = cp.replace(/\\/g, '/')
    const classesDir = I.cwd.replace(/[\\/]+$/, '').replace(/\\/g, '/') + '/target/classes'
    const argName = 'sbsv-args-' + I.id + '.txt'
    await writeFileViaStdin(I, 'target\\' + argName, '-cp "' + classesDir + ';' + cp + '"\n')
    return I.cwd.replace(/[\\/]+$/, '') + '\\target\\' + argName
  }

  const stopPoll = (I) => { if (I.pollStop) { try { I.pollStop() } catch {} I.pollStop = null } }
  function startPoll(I) {
    if (I.pollStop) return
    let off = 0
    I.pollStop = ctx.interval(() => {
      if (!I.proc || !I.proc.collected || !I.proc.collected.stdout) return
      try {
        const r = I.proc.collected.stdout.readFrom(off)
        off = r.nextOffset
        const t = r.text || ''
        if (/Started\s+\S+\s+in\s+[0-9.]+\s+seconds/i.test(t) || /Tomcat started on port/i.test(t)) {
          I.phase = 'running'; I.note = '服务已就绪'; stopPoll(I)
        }
      } catch { /* 忽略 */ }
    }, 1000)
  }

  function watchProcess(I) {
    I.proc.done.then((outcome) => {
      const wasUser = I.userStop
      I.proc = null; I.pid = 0; stopPoll(I)
      I.phase = wasUser ? 'stopped' : 'crashed'
      I.exitInfo = { exitCode: outcome.exitCode, signal: outcome.signal || null }
      I.note = wasUser ? '已停止' : ('进程异常退出（exit ' + outcome.exitCode + (outcome.signal ? ', ' + outcome.signal : '') + '），详情见日志')
    }, (err) => {
      I.proc = null; I.pid = 0; stopPoll(I)
      I.phase = 'crashed'
      I.lastError = '启动失败: ' + ((err && err.message) || err)
    })
  }

  async function javaExe(I) {
    if (I.cfg.javaPath) {
      if (!I.javaFound) throw new Error('JDK 路径无效：' + I.cfg.javaPath + '（自动归一后未找到 java.exe）')
      return I.javaPath || resolveJavaExe(I.cfg.javaPath)
    }
    const java = await sub.resolveExecutable('java')
    if (!java) throw new Error('未找到 java，可在配置中填写 JDK 路径')
    return java
  }

  async function start(I, opts) {
    const o = opts || {}
    const mode = o.mode === 'jar' ? 'jar' : 'src'
    if (I.proc || I.phase === 'building' || I.phase === 'starting' || I.phase === 'stopping') return snapshot(I)
    await detect(I)
    if (!I.cwd) throw new Error('未设置项目目录，请打开配置填写')
    if (!I.javaFound) { I.phase = 'crashed'; return snapshot(I) }
    if (!I.mainClass) throw new Error('未能识别主类入口，请打开配置填写')
    I.lastError = ''; I.userStop = false
    I.startedAt = Date.now(); I.exitInfo = null
    // 确保 Tomcat access log 目录存在（每服务独立子目录）
    try { mkdirSync(join(ACCESS_DIR, I.id), { recursive: true }) } catch { /* 忽略 */ }

    if (mode === 'jar') {
      if (o.rebuild || !I.jarExists) {
        // 先 mvn clean 清掉上次打包残余（旧 class / 旧 jar），再全新打包，避免残留干扰
        await runMaven(I, ['clean', '-DskipTests', 'package'], '正在执行 mvn clean + package（先清理上次打包残余，再全新打包）…')
        I.jarExists = true
      }
      const java = await javaExe(I)
      I.mode = 'jar'; I.phase = 'starting'
      I.note = 'JVM 启动中（java -jar ' + I.jarName + '.jar），等待 Spring Boot 就绪…'
      I.proc = sub.spawn({
        argv: [java].concat(javaAllArgs(I), ['-jar', I.jar]),
        cwd: I.cwd,
        stdio: {
          stdin: 'ignore',
          // 内存窗口 4MB 保留尾部 + 64MB spill 完整落盘：超窗丢头的缺口可从 spill 恢复全量
          stdout: { maxBytes: 4194304, spill: { maxBytes: 67108864 } },
          stderr: { maxBytes: 4194304, spill: { maxBytes: 67108864 } },
        },
        graceMs: 12000,
      })
    } else {
      let argfilePath = ''
      try { argfilePath = await compileAndResolve(I) }
      catch (e) {
        I.phase = 'crashed'
        I.note = '源码直启准备失败：' + ((e && e.message) || e)
        throw e
      }
      const java = await javaExe(I)
      I.mode = 'src'; I.phase = 'starting'
      I.note = 'JVM 启动中（源码直启 ' + I.mainClass + '），等待 Spring Boot 就绪…'
      I.proc = sub.spawn({
        argv: [java].concat(javaAllArgs(I), ['@' + argfilePath, I.mainClass]),
        cwd: I.cwd,
        stdio: {
          stdin: 'ignore',
          // 内存窗口 4MB 保留尾部 + 64MB spill 完整落盘：超窗丢头的缺口可从 spill 恢复全量
          stdout: { maxBytes: 4194304, spill: { maxBytes: 67108864 } },
          stderr: { maxBytes: 4194304, spill: { maxBytes: 67108864 } },
        },
        graceMs: 15000,
      })
    }
    I.lastProc = I.proc
    I.pid = I.proc.pid
    watchProcess(I)
    startPoll(I)
    return snapshot(I)
  }

  async function stop(I) {
    if (I.buildProc && !I.proc) {
      try { I.buildProc.terminate() } catch {}
      I.phase = 'stopped'; I.pid = 0; I.note = '编译/构建已取消'
      return snapshot(I)
    }
    if (!I.proc) { I.phase = 'stopped'; I.note = ''; return snapshot(I) }
    I.userStop = true; I.phase = 'stopping'; I.note = '正在停止（终止后端进程）…'
    try { I.proc.terminate() } catch { /* done 回调收尾 */ }
    return snapshot(I)
  }

  async function restart(I, opts) {
    if (I.proc) {
      await stop(I)
      const t0 = Date.now()
      while (I.proc && Date.now() - t0 < 30000) {
        await new Promise((res) => ctx.timeout(res, 300))
      }
    }
    return start(I, opts || {})
  }

  function logs(I, args) {
    const a = args || {}
    const res = { build: null, buildSeq: I.buildSeq, out: null, err: null, access: null }
    // 编译输出：buildSeq 变化说明宿主开始了新构建 → 客户端整体重置；否则按 buildFrom 增量返回
    if (a.buildFrom !== undefined) {
      const from = Number(a.buildFrom) || 0
      res.build = { from, text: from >= I.buildText.length ? '' : I.buildText.slice(from), nextOffset: I.buildText.length, truncated: I.buildTruncated }
    } else {
      res.build = { text: I.buildText, truncated: I.buildTruncated, nextOffset: I.buildText.length }
    }
    if (I.lastProc) {
      res.out = readStream(outRead(I), Number(a.outFrom) || 0)
      res.err = readStream(errRead(I), Number(a.errFrom) || 0)
    }
    // Tomcat access log：按字节偏移增量读 access_*.log 尾部（可选）
    if (a.accessFrom !== undefined) res.access = readAccess(I, Number(a.accessFrom) || 0)
    return res
  }

  // ---------- Tomcat access log 读取：增量尾读，字节偏移由客户端维护（每服务独立子目录） ----------
  function readAccess(I, fromByte) {
    try {
      const dir = join(ACCESS_DIR, I.id)
      if (!existsSync(dir)) return { text: '', nextOffset: fromByte, lossy: false }
      // 取最新的 access 文件（access_log 日期轮转：access_log.2026-08-26.log / access_log.log）
      const files = readdirSync(dir)
        .filter((n) => /^access[^.]*\.log$/.test(n) || /^access_log/.test(n))
        .map((n) => join(dir, n))
        .filter((p) => statSync(p).isFile())
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
      if (files.length === 0) return { text: '', nextOffset: fromByte, lossy: false }
      const f = files[0]
      const size = statSync(f).size
      // 从 fromByte 读到文件尾；若文件换了（新进程/轮转）且偏移超界则从头
      const from = Math.min(fromByte, size)
      const fd = openSync(f, 'r')
      try {
        const buf = Buffer.alloc(size - from)
        readSync(fd, buf, 0, buf.length, from)
        return { text: buf.toString('utf8'), nextOffset: size, lossy: fromByte > size }
      } finally { closeSync(fd) }
    } catch { return { text: '', nextOffset: fromByte, lossy: false } }
  }

  // 读取某个采集流：优先从 spill 完整落盘恢复（lossy 时缺口只在那里），否则读内存窗口尾部
  function readStream(reader, from) {
    if (!reader) return null
    try {
      const r = reader.readFrom(from)
      if (!r) return null
      if (r.lossy && r.spillPath) {
        try {
          const full = readFileSync(r.spillPath, 'utf8')
          return {
            text: from >= full.length ? '' : full.slice(from),
            nextOffset: full.length,
            lossy: false, fromSpill: true,
            memText: r.text, memNext: r.nextOffset,
          }
        } catch { /* spill 不可读 → 回落内存尾部 */ }
      }
      return { text: r.text, nextOffset: r.nextOffset, lossy: !!r.lossy, fromSpill: false }
    } catch { return null }
  }
  // stdout/stderr reader 带缓存（每次 logs() 都新建 reader 会丢内存态）——按服务各留一份
  function outRead(I) {
    if (I.outState.proc !== I.lastProc || !I.outState.reader) {
      I.outState.reader = I.lastProc && I.lastProc.collected && I.lastProc.collected.stdout || null
      I.outState.proc = I.lastProc
    }
    return I.outState.reader
  }
  function errRead(I) {
    if (I.errState.proc !== I.lastProc || !I.errState.reader) {
      I.errState.reader = I.lastProc && I.lastProc.collected && I.lastProc.collected.stderr || null
      I.errState.proc = I.lastProc
    }
    return I.errState.reader
  }

  async function setConfig(I, args) {
    const a = (args && args.patch) || {}
    for (const k of Object.keys(I.cfg)) {
      if (a[k] !== undefined) I.cfg[k] = String(a[k] === null ? '' : a[k]).trim()
    }
    if (I.cfg.cwd) { I.cwd = I.cfg.cwd; I.cwdSource = '配置文件' }
    saveConfigFile()
    return detect(I)
  }

  // ---------- 服务管理：新增 / 删除 / 切换活动服务 ----------
  function addService(args) {
    const inst = newInstance(newId())
    const n = String((args && args.name) || '').trim()
    inst.cfg.name = n || ('服务 ' + (services.size + 1))
    services.set(inst.id, inst)
    activeId = inst.id
    saveConfigFile()
    return stateAll()
  }
  function removeService(id) {
    const key = String(id || '').trim()
    const I = services.get(key)
    if (!I) return stateAll()
    if (services.size <= 1) throw new Error('至少保留一个服务配置')
    // 还在跑先停掉，再摘除配置
    if (I.proc || I.buildProc) stop(I).catch(() => {})
    services.delete(key)
    if (activeId === key) activeId = services.keys().next().value
    saveConfigFile()
    return stateAll()
  }
  function setActive(id) {
    const key = String(id || '').trim()
    if (!services.has(key)) throw new Error('未知服务：' + key)
    activeId = key
    saveConfigFile()
    return stateAll()
  }

  // ---------- 目录列表（配置「浏览…」弹窗数据源） ----------
  // 宿主网关 host.listDirectory 需要 browse 能力（本机组装只有 native，插件无法升级），
  // 故用 Node fs 自实现：返回与 host.listDirectory 相同的结构 { path, home, crumbs, entries, truncated }
  function listDir(reqPath) {
    const home = homedir()
    const raw = String(reqPath || '').trim().replace(/^"(.*)"$/, '$1')
    // 空路径 → 盘符根列表（Windows）
    if (!raw) {
      const entries = []
      for (let c = 65; c <= 90; c++) {
        const drive = String.fromCharCode(c) + ':\\'
        try { if (existsSync(drive)) entries.push({ name: drive, path: drive, hidden: false }) } catch { /* 跳过 */ }
      }
      return { path: '', home, crumbs: [{ name: '此电脑', path: '', hidden: false }], entries, truncated: false }
    }
    let p = raw.replace(/[\\/]+$/, '')
    if (/^[A-Za-z]:$/.test(p)) p += '\\' // 盘符根保留反斜杠
    const st = statSync(p) // 不存在/无权限 → 抛错给客户端显示
    if (!st.isDirectory()) throw new Error('不是目录：' + p)
    const entries = []
    for (const name of readdirSync(p)) {
      try {
        const full = join(p, name)
        if (!statSync(full).isDirectory()) continue
        entries.push({ name, path: full, hidden: /^(\.|\$)/.test(name) })
      } catch { /* 无权限/瞬时锁 → 跳过该子项 */ }
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { sensitivity: 'base', numeric: true }))
    const MAX_ENTRIES = 2000
    const truncated = entries.length > MAX_ENTRIES
    if (truncated) entries.length = MAX_ENTRIES
    // 面包屑：此电脑 + 逐级目录
    const crumbs = [{ name: '此电脑', path: '', hidden: false }]
    const segs = p.split(/[\\/]+/).filter(Boolean)
    let acc = ''
    for (let i = 0; i < segs.length; i++) {
      if (i === 0) acc = /^[A-Za-z]:$/.test(segs[0]) ? segs[0] + '\\' : (p.startsWith('\\\\') ? '\\\\' + segs[0] : '/' + segs[0])
      else acc = acc.replace(/[\\/]+$/, '') + (p.includes('/') && !p.startsWith('\\\\') && !/^[A-Za-z]:/.test(p) ? '/' : '\\') + segs[i]
      crumbs.push({ name: segs[i], path: acc, hidden: false })
    }
    return { path: p, home, crumbs, entries, truncated }
  }

  // ---------- 独立 RPC 频道（浏览器控制台 ←→ 宿主） ----------
  // 注意：不要用 ctx.connection.rpc.intercept('/api', ...) —— /api 是官方的共享
  // 拦截器席位（typert-gateway 注册 commands/list、goals/* 等命令端点用），每 channel
  // 只允许一个拦截器；若插件再抢 /api 会把官方 gateway 顶掉，导致命令目录加载报
  // "command directory warmup failed ... HTTP 404"。独立频道用 rpc.handle('/xxx', ...)。
  const disposeRpc = ctx.connection.rpc.handle(
    '/spring-widget',
    async (endpoint, payload) => {
      try {
        const p = (payload && typeof payload === 'object') ? payload : {}
        switch (endpoint) {
          case 'spring-widget/status': ensureDetect(); return { ok: true, value: stateAll() }
          case 'spring-widget/detect': await detect(getSvc(p.id)); return { ok: true, value: stateAll() }
          case 'spring-widget/start': return { ok: true, value: await start(getSvc(p.id), p) }
          case 'spring-widget/stop': return { ok: true, value: await stop(getSvc(p.id)) }
          case 'spring-widget/restart': return { ok: true, value: await restart(getSvc(p.id), p) }
          case 'spring-widget/logs': return { ok: true, value: logs(getSvc(p.id), p) }
          case 'spring-widget/setConfig': await setConfig(getSvc(p.id), p); return { ok: true, value: stateAll() }
          case 'spring-widget/setActive': return { ok: true, value: setActive(p.id) }
          case 'spring-widget/addService': return { ok: true, value: addService(p) }
          case 'spring-widget/removeService': return { ok: true, value: removeService(p.id) }
          case 'spring-widget/listDir': return { ok: true, value: listDir(p.path) }
          default: return { ok: false, error: { code: 'internal', message: '未知端点: ' + endpoint, details: {} } }
        }
      } catch (e) {
        return { ok: false, error: { code: 'internal', message: (e && e.message) || String(e), details: {} } }
      }
    },
    { authority: 'trusted-host' },
  )

  // ---------- 模型工具 ----------
  const sbTool = defineTool({
    name: 'springboot_service',
    description: '管理 Spring Boot 后端服务（多服务，IDEA 运行控制台式）。每个服务独立配置（项目目录/JDK/Maven/主类/端口），持久化到 ~/.dsh/spring-widget.json；多个服务可同时运行。源码直启（默认：mvn 增量编译 + 本地 Maven 仓库依赖 + java -cp 直启主类，不打包）或 Jar 启动；可停止、重启、查询状态；status 附带日志尾部。',
    parameters: {
      action: {
        type: 'string',
        enum: ['status', 'start', 'stop', 'restart'],
        required: true,
        description: 'status=查询状态(含日志尾部)；start=启动；stop=停止；restart=重启',
      },
      service: {
        type: 'string',
        description: '目标服务的名称或 id（默认=控制台当前选中的活动服务；status 会列出全部服务）',
      },
      mode: {
        type: 'string',
        enum: ['src', 'jar'],
        description: '启动方式：src=源码直启（默认，无需打包，自动增量编译）；jar=运行已打包 jar',
      },
      rebuild: {
        type: 'boolean',
        description: '[mode=jar] 是否强制先 mvn -DskipTests package',
      },
    },
    output: {
      schema: { type: 'json' },
      render(args, value) {
        const v = (value && typeof value === 'object') ? value : {}
        const lines = []
        const r = v.result || {}
        lines.push('[springboot_service] action=' + String(args && args.action || '') + ' mode=' + String((args && args.mode) || 'src'))
        const list = Array.isArray(r.services) ? r.services : (r.id ? [r] : [])
        for (const s of list) {
          lines.push('- ' + String(s.name || '?') + ' (' + String(s.id || '') + ') phase=' + String(s.phase || '?')
            + ' pid=' + String(s.pid || 0) + ' port=' + String(s.port || 0) + ' main=' + String(s.mainClass || '?'))
          lines.push('  cwd=' + String(s.cwd || ''))
          if (s.note) lines.push('  note: ' + String(s.note))
          if (s.lastError) lines.push('  error: ' + String(s.lastError))
        }
        if (!list.length) lines.push('phase=?（无返回）')
        if (v.error) lines.push('error: ' + String(v.error))
        if (v.logTail) { lines.push('--- log tail ---'); lines.push(String(v.logTail)) }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const a = args || {}
      try {
        const I = getSvc(a.service)
        if (a.action === 'start') return { result: await start(I, { mode: a.mode, rebuild: !!a.rebuild }) }
        if (a.action === 'stop') return { result: await stop(I) }
        if (a.action === 'restart') return { result: await restart(I, { mode: a.mode, rebuild: !!a.rebuild }) }
        // status：全部服务摘要 + 目标服务日志尾
        ensureDetect()
        const l = logs(I, { outFrom: 0 })
        const tail = (l.out && l.out.text || '').slice(-2000)
        return { result: stateAll(), logTail: tail }
      } catch (e) {
        return { error: ((e && e.message) || String(e)), result: stateAll() }
      }
    },
  })
  const disposeTool = ctx.tools.register(sbTool)

  loadConfigFile()
  // 开机先探测活动服务（其余服务在 status 轮询中惰性补探测）
  detect(getSvc('')).catch(() => {})

  ctx.effect(() => () => {
    try { disposeRpc && disposeRpc() } catch {}
    try { disposeTool && disposeTool() } catch {}
    for (const I of services.values()) {
      stopPoll(I)
      try { if (I.proc) I.proc.terminate() } catch {}
      try { if (I.buildProc) I.buildProc.terminate() } catch {}
    }
  })
}
