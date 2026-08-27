// dsh-spring-widget — host half.
// Spring Boot 后端服务管理器：源码直启（mvn 增量编译 + 本地 Maven 仓库依赖 + java @argfile 直启主类），
// 可停止/重启/查状态；配置持久化到 ~/.dsh/spring-widget.json；浏览器控制台通过 /api 共享 RPC 通道访问。
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, openSync, readSync, closeSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
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

  const S = {
    phase: 'stopped', pid: 0, startedAt: 0,
    cwd: '', cwdSource: '', jar: '', jarExists: null, jarName: '',
    javaFound: false, javaPath: '', mavenHome: '', mainClass: '', port: 0,
    mode: 'src', exitInfo: null, note: '', lastError: '',
    cfg: { cwd: '', javaPath: '', mavenHome: '', mainClass: '', port: '', jarName: '' },
    detected: { cwd: '', javaPath: '', mavenHome: '', javaVersion: '' },
  }
  let proc = null, lastProc = null, buildProc = null, pollStop = null
  let userStop = false, buildText = '', buildTruncated = false, buildOff = 0, buildSeq = 0

  const snapshot = () => ({
    phase: S.phase, pid: S.pid, startedAt: S.startedAt, cwd: S.cwd,
    cwdSource: S.cwdSource, jar: S.jar, jarExists: S.jarExists, jarName: S.jarName,
    javaFound: S.javaFound, port: S.port, mode: S.mode, mainClass: S.mainClass,
    exitInfo: S.exitInfo, note: S.note, lastError: S.lastError,
    cfg: { ...S.cfg }, detected: { ...S.detected }, now: Date.now(),
  })

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
  async function whereTool(name) {
    try {
      const direct = await sub.resolveExecutable(name)
      if (direct && /[\\/]/.test(direct)) return tidyExePath(direct)
      const cmd = await sub.resolveExecutable('cmd.exe')
      if (!cmd) return ''
      const w = sub.spawn({
        argv: [cmd, '/c', 'where', name],
        cwd: S.cwd || undefined,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 8192 }, stderr: 'ignore' },
        graceMs: 6000,
      })
      const out = await w.done
      if (!out || out.exitCode !== 0) return ''
      const text = String((out.collected.stdout && out.collected.stdout.readFrom(0).text) || '')
      return text.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)[0] || ''
    } catch { return '' }
  }

  // ---------- 配置持久化（Node fs，无沙箱） ----------
  function loadConfigFile() {
    try {
      if (!existsSync(CONFIG_PATH)) return
      const saved = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
      if (saved && typeof saved === 'object') {
        for (const k of Object.keys(S.cfg)) {
          if (saved[k] !== undefined && saved[k] !== null && String(saved[k]) !== '') S.cfg[k] = saved[k]
        }
      }
    } catch { /* 无配置或解析失败 → 默认 */ }
  }
  function saveConfigFile() {
    try { writeFileSync(CONFIG_PATH, JSON.stringify(S.cfg, null, 2)) } catch { /* 不阻断 */ }
  }

  // 通过 subprocess 写文件（stdin 管道：无长度限制、无引号转义问题）
  async function writeFileViaStdin(absOrRelPath, content) {
    const cmd = await sub.resolveExecutable('cmd.exe')
    if (!cmd) throw new Error('未找到 cmd.exe')
    const quoted = /^[A-Za-z]:[\\/]/.test(absOrRelPath) ? '"' + absOrRelPath + '"' : absOrRelPath
    const w = sub.spawn({
      argv: [cmd, '/c', 'more', '>', quoted],
      cwd: S.cwd || undefined,
      stdio: { stdin: { data: content }, stdout: 'ignore', stderr: { maxBytes: 16384 } },
      graceMs: 8000,
    })
    const outcome = await w.done
    if (!outcome || outcome.exitCode !== 0) {
      throw new Error('写入 ' + absOrRelPath + ' 失败: exit ' + (outcome ? outcome.exitCode : '?'))
    }
  }

  // ---------- 自动探测 ----------
  async function detect() {
    loadConfigFile()
    if (!S.cwd && S.cfg.cwd) { S.cwd = String(S.cfg.cwd); S.cwdSource = '配置文件' }
    if (!S.cwd) {
      const agents = ctx.get('agents')
      let cwd = ''
      if (agents) {
        try {
          const init = agents.currentInitiator ? agents.currentInitiator() : undefined
          cwd = (init && init.session && init.session.header && init.session.header.cwd) || ''
          if (cwd) S.cwdSource = '当前会话'
        } catch { /* 忽略 */ }
      }
      if (!cwd) { cwd = DEFAULT_CWD; S.cwdSource = '内置默认' }
      S.cwd = cwd
    }

    const f = fs()
    let pomText = ''
    if (f) {
      // 端口：配置 > bootstrap.yml > application.yml
      if (S.cfg.port && Number(S.cfg.port) > 0) {
        S.port = Number(S.cfg.port)
      } else {
        S.port = 0
        for (const yml of ['src/main/resources/bootstrap.yml', 'src/main/resources/application.yml']) {
          try {
            const t = await f.resolve(yml, { cwd: S.cwd })
            const text = String(await f.readText(t) || '')
            const m = /(^|\n)\s*port:\s*(\d+)/.exec(text)
            if (m) { S.port = Number(m[2]); break }
          } catch { /* 下一个 */ }
        }
      }
      // 主类 + Jar 名：读 pom.xml
      try {
        const t = await f.resolve('pom.xml', { cwd: S.cwd })
        pomText = String(await f.readText(t) || '')
      } catch { pomText = '' }
      if (S.cfg.mainClass) S.mainClass = String(S.cfg.mainClass)
      else {
        const m = /<mainClass>\s*([^<\s]+)\s*<\/mainClass>/.exec(pomText)
        S.mainClass = m ? m[1] : FALLBACK_MAIN
      }
      if (S.cfg.jarName) S.jarName = String(S.cfg.jarName)
      else {
        const jn = /<finalName>\s*([^<\s]+)\s*<\/finalName>/.exec(pomText)
        const noParent = pomText.replace(/<parent>[\s\S]*?<\/parent>/, '')
        const art = /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/.exec(noParent)
        const ver = /<version>\s*([^<\s]+)\s*<\/version>/.exec(noParent)
        const artId = art ? art[1] : ''
        if (jn) S.jarName = jn[1].replace(/\$\{project\.artifactId\}/g, artId)
        else if (artId) S.jarName = ver ? artId + '-' + ver[1] : artId
        if (!S.jarName) S.jarName = 'kingdee-sync-server'
      }
      S.jar = S.cwd.replace(/[\\/]+$/, '') + '/target/' + S.jarName + '.jar'
      try {
        const t = await f.resolve('target/' + S.jarName + '.jar', { cwd: S.cwd })
        S.jarExists = !!(await f.stat(t))
      } catch { S.jarExists = false }
    }
    // ---------- JDK / Maven 自动探测（配置优先，其次 PATH） ----------
    S.detected = { cwd: S.cwd, javaPath: '', mavenHome: '', javaVersion: '' }
    if (S.cfg.javaPath) {
      // 配置的 JDK 路径：支持 java.exe / JDK 根目录 / bin 目录，统一归一到 java.exe
      const exe = resolveJavaExe(S.cfg.javaPath)
      S.javaPath = exe || String(S.cfg.javaPath)
      S.javaFound = !!exe
      S.detected.javaPath = S.javaPath
      if (!S.javaFound) S.lastError = 'JDK 路径无效：' + S.cfg.javaPath
    } else {
      // 未配置 → 从 PATH 探测 java，作为「自动检测」候选展示
      S.javaPath = ''
      S.javaFound = !!(await sub.resolveExecutable('java'))
      if (S.javaFound) S.detected.javaPath = await whereTool('java')
      if (!S.javaFound) S.lastError = '未找到 java（PATH），可在配置中填写 JDK 路径'
    }
    if (S.cfg.mavenHome) {
      S.mavenHome = normalizeMavenHome(S.cfg.mavenHome)
      S.detected.mavenHome = S.mavenHome
    } else {
      // 未配置 → 从 PATH 探测 mvn，归一到 Maven 根目录作为候选
      S.mavenHome = ''
      const mvnExe = await whereTool('mvn')
      if (mvnExe) S.detected.mavenHome = normalizeMavenHome(mvnExe)
    }
    if (S.javaFound && (!S.lastError || S.lastError.indexOf('JDK') !== 0)) S.lastError = ''
    return snapshot()
  }

  // Maven 命令：配置了 mavenHome → 其 bin\mvn.cmd 绝对路径；否则 PATH 解析
  // 注意1：.cmd 不能被 Node 直接 spawn（CVE-2024-27980 修复后抛 EINVAL），必须经 cmd.exe /c
  // 注意2：路径作为独立 argv 项传入，不内嵌引号——Windows 引号拼接后 cmd 会收到字面引号导致不识别
  async function mvnArgv() {
    const cmd = await sub.resolveExecutable('cmd.exe')
    if (!cmd) throw new Error('未找到 cmd.exe')
    let target = 'mvn'
    if (S.mavenHome) {
      const p = S.mavenHome.replace(/[\\/]+$/, '') + '\\bin\\mvn.cmd'
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
  // 写到 ~/.dsh/spring-widget-access/，不污染项目目录；widget 增量读取显示「请求日志」tab
  const ACCESS_ARGS = [
    '-Dserver.tomcat.accesslog.enabled=true',
    '-Dserver.tomcat.accesslog.directory=' + ACCESS_DIR.replace(/\\/g, '/'),
    // 格式：时间 IP 方法 路径 状态:HTTP状态码 字节:响应体字节数 耗时:微秒(÷1000=毫秒)
    '-Dserver.tomcat.accesslog.pattern=%{yyyy-MM-dd HH:mm:ss}t %h %m %U 状态:%s 字节:%b 耗时:%Dus',
    '-Dserver.tomcat.accesslog.rotate=true',
    '-Dserver.tomcat.accesslog.buffered=false',
    '-Dlogging.charset.console=UTF-8',
  ]
  const JAVA_ALL = JAVA_UTF8_ARGS.concat(ACCESS_ARGS)

  // Windows Defender/索引服务会瞬时锁定 target 下的文件，导致 mvn clean 删到一半
  // 就报 "Failed to delete ..." 整体失败。手动递归清理（带回退重试 + 延迟）绕开瞬时锁，
  // 然后再让 mvn clean 收尾。返回是否清理出东西。
  async function clearTargetDir() {
    try {
      if (!existsSync(S.cwd)) return false
      const target = join(S.cwd, 'target')
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

  async function runMaven(args, label) {
    const head = await mvnArgv()
    S.phase = 'building'; S.note = label
    buildSeq++
    buildText = ''; buildTruncated = false; buildOff = 0
    let mvnArgs = ['-B'].concat(args)
    // clean 前先手动清 target，绕开 Windows 对 target 文件的瞬时锁定（Defender/索引）
    if (args.includes('clean')) await clearTargetDir()
    buildProc = sub.spawn({
      argv: head.concat(mvnArgs),
      cwd: S.cwd,
      env: UTF8_ENV,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 262144 }, stderr: { maxBytes: 262144 } },
      graceMs: 15000,
    })
    S.pid = buildProc.pid
    // 同时泵 stdout + stderr：Maven 错误（尤其 clean 删除失败）走 stderr，丢掉会吞掉原因
    const pump = ctx.interval(() => {
      if (!buildProc) return
      try {
        const so = buildProc.collected.stdout
        if (so) { const r = so.readFrom(0); if (r) buildText += r.text }
        const se = buildProc.collected.stderr
        if (se) { const r = se.readFrom(0); if (r) buildText += r.text }
        if (buildText.length > 300000) buildText = buildText.slice(-300000)
      } catch { /* 忽略 */ }
    }, 800)
    let outcome
    try { outcome = await buildProc.done }
    finally { pump(); buildProc = null }
    S.pid = 0
    if (!outcome || outcome.exitCode !== 0) {
      S.phase = 'crashed'
      S.note = label + '失败（exit ' + (outcome ? outcome.exitCode : '?') + '），详情见编译输出'
      throw new Error(label + '失败: exit ' + (outcome ? outcome.exitCode : '?'))
    }
  }

  // 源码直启准备：增量编译 + 依赖 classpath + @argfile（绕开 Windows 32KB 命令行限制）
  async function compileAndResolve() {
    await runMaven(
      ['-DskipTests', 'compile', 'dependency:build-classpath', '-Dmdep.outputFile=target/sbsv-cp.txt'],
      '正在增量编译并解析依赖（mvn compile + dependency:build-classpath）…',
    )
    const f = fs()
    if (!f) throw new Error('fs 服务不可用')
    const cpTarget = await f.resolve('target/sbsv-cp.txt', { cwd: S.cwd })
    let cp = String(await f.readText(cpTarget) || '').trim()
    if (!cp) throw new Error('依赖 classpath 为空，请检查 Maven 本地仓库配置')
    cp = cp.replace(/\\/g, '/')
    const classesDir = S.cwd.replace(/[\\/]+$/, '').replace(/\\/g, '/') + '/target/classes'
    await writeFileViaStdin('target\\sbsv-args.txt', '-cp "' + classesDir + ';' + cp + '"\n')
    return S.cwd.replace(/[\\/]+$/, '') + '\\target\\sbsv-args.txt'
  }

  const stopPoll = () => { if (pollStop) { try { pollStop() } catch {} pollStop = null } }
  function startPoll() {
    if (pollStop) return
    let off = 0
    pollStop = ctx.interval(() => {
      if (!proc || !proc.collected || !proc.collected.stdout) return
      try {
        const r = proc.collected.stdout.readFrom(off)
        off = r.nextOffset
        const t = r.text || ''
        if (/Started\s+\S+\s+in\s+[0-9.]+\s+seconds/i.test(t) || /Tomcat started on port/i.test(t)) {
          S.phase = 'running'; S.note = '服务已就绪'; stopPoll()
        }
      } catch { /* 忽略 */ }
    }, 1000)
  }

  async function watchProcess() {
    proc.done.then((outcome) => {
      const wasUser = userStop
      proc = null; S.pid = 0; stopPoll()
      S.phase = wasUser ? 'stopped' : 'crashed'
      S.exitInfo = { exitCode: outcome.exitCode, signal: outcome.signal || null }
      S.note = wasUser ? '已停止' : ('进程异常退出（exit ' + outcome.exitCode + (outcome.signal ? ', ' + outcome.signal : '') + '），详情见日志')
    }, (err) => {
      proc = null; S.pid = 0; stopPoll()
      S.phase = 'crashed'
      S.lastError = '启动失败: ' + ((err && err.message) || err)
    })
  }

  async function javaExe() {
    if (S.cfg.javaPath) {
      if (!S.javaFound) throw new Error('JDK 路径无效：' + S.cfg.javaPath + '（自动归一后未找到 java.exe）')
      return S.javaPath || resolveJavaExe(S.cfg.javaPath)
    }
    const java = await sub.resolveExecutable('java')
    if (!java) throw new Error('未找到 java，可在配置中填写 JDK 路径')
    return java
  }

  async function start(opts) {
    const o = opts || {}
    const mode = o.mode === 'jar' ? 'jar' : 'src'
    if (proc || S.phase === 'building' || S.phase === 'starting' || S.phase === 'stopping') return snapshot()
    await detect()
    if (!S.cwd) throw new Error('未设置项目目录，请打开配置填写')
    if (!S.javaFound) { S.phase = 'crashed'; return snapshot() }
    if (!S.mainClass) throw new Error('未能识别主类入口，请打开配置填写')
    S.lastError = ''; userStop = false
    S.startedAt = Date.now(); S.exitInfo = null
    // 确保 Tomcat access log 目录存在
    try { mkdirSync(ACCESS_DIR, { recursive: true }) } catch { /* 忽略 */ }

    if (mode === 'jar') {
      if (o.rebuild || !S.jarExists) {
        // 先 mvn clean 清掉上次打包残余（旧 class / 旧 jar），再全新打包，避免残留干扰
        await runMaven(['clean', '-DskipTests', 'package'], '正在执行 mvn clean + package（先清理上次打包残余，再全新打包）…')
        S.jarExists = true
      }
      const java = await javaExe()
      S.mode = 'jar'; S.phase = 'starting'
      S.note = 'JVM 启动中（java -jar ' + S.jarName + '.jar），等待 Spring Boot 就绪…'
      proc = sub.spawn({
        argv: [java].concat(JAVA_ALL, ['-jar', S.jar]),
        cwd: S.cwd,
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
      try { argfilePath = await compileAndResolve() }
      catch (e) {
        S.phase = 'crashed'
        S.note = '源码直启准备失败：' + ((e && e.message) || e)
        throw e
      }
      const java = await javaExe()
      S.mode = 'src'; S.phase = 'starting'
      S.note = 'JVM 启动中（源码直启 ' + S.mainClass + '），等待 Spring Boot 就绪…'
      proc = sub.spawn({
        argv: [java].concat(JAVA_ALL, ['@' + argfilePath, S.mainClass]),
        cwd: S.cwd,
        stdio: {
          stdin: 'ignore',
          // 内存窗口 4MB 保留尾部 + 64MB spill 完整落盘：超窗丢头的缺口可从 spill 恢复全量
          stdout: { maxBytes: 4194304, spill: { maxBytes: 67108864 } },
          stderr: { maxBytes: 4194304, spill: { maxBytes: 67108864 } },
        },
        graceMs: 15000,
      })
    }
    lastProc = proc
    S.pid = proc.pid
    await watchProcess()
    startPoll()
    return snapshot()
  }

  async function stop() {
    if (buildProc && !proc) {
      try { buildProc.terminate() } catch {}
      S.phase = 'stopped'; S.pid = 0; S.note = '编译/构建已取消'
      return snapshot()
    }
    if (!proc) { S.phase = 'stopped'; S.note = ''; return snapshot() }
    userStop = true; S.phase = 'stopping'; S.note = '正在停止（终止后端进程）…'
    try { proc.terminate() } catch { /* done 回调收尾 */ }
    return snapshot()
  }

  async function restart(opts) {
    if (proc) {
      await stop()
      const t0 = Date.now()
      while (proc && Date.now() - t0 < 30000) {
        await new Promise((res) => ctx.timeout(res, 300))
      }
    }
    return start(opts || {})
  }

  function logs(args) {
    const a = args || {}
    const res = { build: null, buildSeq, out: null, err: null, access: null }
    // 编译输出：buildSeq 变化说明宿主开始了新构建 → 客户端整体重置；否则按 buildFrom 增量返回
    if (a.buildFrom !== undefined) {
      const from = Number(a.buildFrom) || 0
      res.build = { from, text: from >= buildText.length ? '' : buildText.slice(from), nextOffset: buildText.length, truncated: buildTruncated }
    } else {
      res.build = { text: buildText, truncated: buildTruncated, nextOffset: buildText.length }
    }
    if (lastProc) {
      res.out = readStream(outRead(lastProc), Number(a.outFrom) || 0)
      res.err = readStream(errRead(lastProc), Number(a.errFrom) || 0)
    }
    // Tomcat access log：按字节偏移增量读 access_*.log 尾部（可选）
    if (a.accessFrom !== undefined) res.access = readAccess(Number(a.accessFrom) || 0)
    return res
  }

  // ---------- Tomcat access log 读取：增量尾读，字节偏移由客户端维护 ----------
  function readAccess(fromByte) {
    try {
      if (!existsSync(ACCESS_DIR)) return { text: '', nextOffset: fromByte, lossy: false }
      // 取最新的 access 文件（access_log 日期轮转：access_log.2026-08-26.log / access_log.log）
      const files = readdirSync(ACCESS_DIR)
        .filter((n) => /^access[^.]*\.log$/.test(n) || /^access_log/.test(n))
        .map((n) => join(ACCESS_DIR, n))
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
  // stdout/stderr reader 带缓存（每次 logs() 都新建 reader 会丢内存态）
  const outState = { reader: null, proc: null }
  const errState = { reader: null, proc: null }
  function outRead(proc) {
    if (outState.proc !== proc || !outState.reader) {
      outState.reader = proc && proc.collected && proc.collected.stdout || null
      outState.proc = proc
    }
    return outState.reader
  }
  function errRead(proc) {
    if (errState.proc !== proc || !errState.reader) {
      errState.reader = proc && proc.collected && proc.collected.stderr || null
      errState.proc = proc
    }
    return errState.reader
  }

  async function setConfig(args) {
    const a = (args && args.patch) || {}
    for (const k of Object.keys(S.cfg)) {
      if (a[k] !== undefined) S.cfg[k] = String(a[k] === null ? '' : a[k]).trim()
    }
    if (S.cfg.cwd) { S.cwd = S.cfg.cwd; S.cwdSource = '配置文件' }
    saveConfigFile()
    return detect()
  }

  // ---------- 独立 RPC 频道（浏览器控制台 ←→ 宿主） ----------
  // 注意：不要用 ctx.connection.rpc.intercept('/api', ...) —— /api 是官方的共享
  // 拦截器席位（typert-gateway 注册 commands/list、goals/* 等命令端点用），每 channel
  // 只允许一个拦截器；若插件再抢 /api 会把官方 gateway 顶掉，导致命令目录加载报
  // "command directory warmup failed ... HTTP 404"。独立频道用 rpc.handle('/xxx', ...)。
  const RPC_ENDPOINTS = /^spring-widget\//
  const disposeRpc = ctx.connection.rpc.handle(
    '/spring-widget',
    async (endpoint, payload) => {
      try {
        const p = (payload && typeof payload === 'object') ? payload : {}
        switch (endpoint) {
          case 'spring-widget/status': return { ok: true, value: S.cwd ? snapshot() : await detect() }
          case 'spring-widget/detect': return { ok: true, value: await detect() }
          case 'spring-widget/start': return { ok: true, value: await start(p) }
          case 'spring-widget/stop': return { ok: true, value: await stop() }
          case 'spring-widget/restart': return { ok: true, value: await restart(p) }
          case 'spring-widget/logs': return { ok: true, value: logs(p) }
          case 'spring-widget/setConfig': return { ok: true, value: await setConfig(p) }
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
    description: '管理 Spring Boot 后端服务（kingdee-sync-server）。源码直启（默认：mvn 增量编译 + 本地 Maven 仓库依赖 + java -cp 直启主类，不打包）或 Jar 启动；可停止、重启、查询状态；status 附带日志尾部。项目目录/JDK/Maven/主类/端口在控制台配置并持久化到 ~/.dsh/spring-widget.json。',
    parameters: {
      action: {
        type: 'string',
        enum: ['status', 'start', 'stop', 'restart'],
        required: true,
        description: 'status=查询状态(含日志尾部)；start=启动；stop=停止；restart=重启',
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
        lines.push('phase=' + String(r.phase || '?') + ' pid=' + String(r.pid || 0) + ' port=' + String(r.port || 0) + ' main=' + String(r.mainClass || '?'))
        lines.push('cwd=' + String(r.cwd || ''))
        if (r.note) lines.push('note: ' + String(r.note))
        if (r.lastError) lines.push('error: ' + String(r.lastError))
        if (v.error) lines.push('error: ' + String(v.error))
        if (v.logTail) { lines.push('--- log tail ---'); lines.push(String(v.logTail)) }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const a = args || {}
      try {
        if (a.action === 'start') return { result: await start({ mode: a.mode, rebuild: !!a.rebuild }) }
        if (a.action === 'stop') return { result: await stop() }
        if (a.action === 'restart') return { result: await restart({ mode: a.mode, rebuild: !!a.rebuild }) }
        const snap = S.cwd ? snapshot() : await detect()
        const l = logs({ outFrom: 0 })
        const tail = (l.out && l.out.text || '').slice(-2000)
        return { result: snap, logTail: tail }
      } catch (e) {
        return { error: ((e && e.message) || String(e)), result: snapshot() }
      }
    },
  })
  const disposeTool = ctx.tools.register(sbTool)

  detect().catch(() => {})

  ctx.effect(() => () => {
    try { disposeRpc && disposeRpc() } catch {}
    try { disposeTool && disposeTool() } catch {}
    stopPoll()
    try { if (proc) proc.terminate() } catch {}
    try { if (buildProc) buildProc.terminate() } catch {}
  })
}
