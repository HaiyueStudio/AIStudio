# M06 POC threat model

范围：Windows/Electron 本地 AIStudio、项目目录、插件 root、两种 Agent backend、Codex child process、日志与 bug bundle。
信任边界：renderer ↔ preload/main IPC、main ↔ project filesystem、main ↔ secret store、backend adapter ↔ provider/Codex stdio、
Studio tool policy ↔ Document mutation、project script ↔ preview runtime。项目内容、模型输出、上游事件和日志文本均视为不可信。

| Threat / STRIDE | Attack | Control | Residual / acceptance |
| --- | --- | --- | --- |
| API key/token disclosure / I | renderer、project、prompt、log 或 bundle 获得 credential | secret 仅由 main secret-store 注入；字段 denylist+canary scan；不读取 Codex credential 文件 | 人工凭据测试后扫描 user-data/project/bundle |
| prompt injection / E,T | 项目脚本或日志诱导模型调用越权工具 | 模型内容无权限；固定 allowlist schema、effect/risk policy、base revision 和精确 approval | 高风险调用始终需用户确认 |
| malicious project script / E,D | 脚本访问主机或挂死 preview | proposal/diff；写入和首次运行分开授权；独立 runtime owner、stop/timeout | trusted-project 不是恶意代码沙箱，UI 必须明确提示 |
| tool escalation / E | 伪造 tool id、effect 或参数 | registry 中 effect 不由请求决定；unknown id/version/schema fail closed；无 shell/network/delete tool | G09 conformance 覆盖伪造请求 |
| stale/replayed approval / S,T | 参数、preview 或 revision 变化后复用 allow | approval 绑定 call/tool/version/args+preview digest/document/base revision/TTL/one-shot | monotonic time 与 commit 前二次校验 |
| path traversal/symlink / T,I | 脚本名或 bundle 路径逃逸项目根 | canonical relative resource id；realpath containment；拒绝绝对路径、`..`、reparse point | G04/G10 Windows fixture |
| IPC spoofing / S,E | renderer 构造 shell/fs/secret channel | contextIsolation、sandbox、nodeIntegration=false；preload channel allowlist与 schema/version/correlation | unknown channel 记录并拒绝 |
| Codex child-process escape / E,D | 任意 built-in command/file/network 或孤儿进程 | pinned executable；main-only stdio；禁用/拒绝 built-in effects；Abort/Job owner 终止进程树 | G07/G10 反复 cancel/close 后查残留 |
| external payload spoofing / S,T | provider 发送未知事件或错误类型 | wire payload 从 `unknown` schema validate，再归一化；不把 raw object 交给 renderer/tool | schema drift fail closed |
| log poisoning / T,R | 换行、伪造 sequence、巨型内容掩盖事实 | envelope/sequence/checksum 由 writer 生成；长度预算；文本作为 data；append-only tail recovery | Log Viewer 不解释 HTML/ANSI/control chars |
| log loss/tamper / T,R,D | partial tail、磁盘满、rotation 丢关联 | atomic append、checksum、flush、quota/rotation manifest、startup recovery | integrity 不可靠时 mutation/trusted runtime fail closed |
| diagnostics over-read / I,D | Agent 读取任意文件或无限日志 | typed filters、window/limit、correlation traversal、approved artifact id；无 path/SQL | 查询和返回也记日志与预算 |
| plugin config injection / T,E | 配置引入代码、秘密或未知 capability | JSON schema、provenance、静态 bundled plugin allowlist；禁止远程插件/动态代码 | G02 activation fixture |
| plugin lifecycle leak / D,E | 失败后 listener/Worker/GPU/process 残留 | 唯一 parent-child effect tree、事务 activation、逆序 dispose、late-result guard | G02 failure injection 必须通过 |
| supply-chain drift / T | `latest`/branch 或 schema 静默变化 | exact versions、lock integrity、tag+full commit、license snapshot、generated schema tree hash | 升级需新 ADR/evidence |
| bug bundle leakage / I | 导出完整 prompt/project/token/crash data | manifest-first allowlist、二次 redaction、大小预算、用户预览；secret canary scan | POC 不自动上传 bundle |

## Security invariants

- durable log 不可用或校验失败：observe 可带明确降级；Document mutation、trusted-code、runtime-start 一律拒绝。
- renderer、模型输出和日志重放永远不能直接持有 World/Document 可变引用。
- 不保存隐藏 chain-of-thought；只保存用户可见内容、明确 reasoning summary、tool/approval 与可重建状态摘要。
- approval 与 backend 自带命令审批分域；Codex approval 不能代替 Studio editor-tool approval。
