# DeepSeek Harness upstream pin

- Repository: <https://github.com/deepseek-ai/deepseek-harness>
- Release/tag: `dsh-v0.1.0-rc.7`
- Commit: `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`
- License: MIT
- Runtime declaration: Node `^22.19.0 || >=24`

AIStudio 只在 `packages/harness-bridge` 直接依赖固定版本的 Cordis、agent、loop、LLM、session、tools 与 approval
packages。精确 npm integrity、license/third-party snapshot digest 记录在 `config/upstream/pins.json`，lockfile 是实际解析
结果。升级 tag 时必须重新捕获 snapshot、重跑 compatibility fixture，并单独审查生命周期和工具语义。

`LICENSE.snapshot` 与 `THIRD_PARTY_NOTICES.md.snapshot` 由 `node scripts/capture-upstream-snapshots.mjs` 从固定 tag
生成，不手工编辑。
