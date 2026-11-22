# HTTPS 手机预览与鼠标组合按键

日期：2026-11-22

预览页增加“扫码运行”。仅桌面版、用户手动运行且对应已消费的执行授权仍覆盖当前 Document 修订时可用；Agent 自动验证不启动网络分享。二维码使用 `@haiyue/ui/qr-code` 公共导出的 `HYQRCode`。

HTTPS 服务由 Electron main 的根生命周期拥有。点击分享才监听所有本机 IPv4 网卡的临时端口，二维码可切换局域网地址；不配置路由器、公网穿透或系统防火墙。同一执行计划和修订复用分享，不因电脑端预览尺寸变化撤销手机运行。分享最长 30 分钟；停止 Play、关闭工程、修改修订、取消尚未完成的启动、到期或应用销毁均撤销对应服务。关闭已生成的二维码弹窗会保留分享，弹窗有独立的“停止分享”。

main 用 `@peculiar/x509@3.1.0` / WebCrypto 生成设备 CA 与带当前地址 SAN 的短期服务证书。CA 私钥只进入 Electron safeStorage 加密的设备存储；服务私钥仅在 main 内存。renderer 和扫码页只能取得公开 CA 证书与 SHA-256 指纹。不会自动写入任何设备的系统信任库。

手机与电脑需要在可互访的局域网内。首次安装并信任本机 CA 后，手机浏览器才能将该地址作为可信 HTTPS 使用；iOS 还需启用根证书完全信任，见 [Apple 官方说明](https://support.apple.com/en-us/102390)。用户应核对编辑器中的证书指纹。WebGPU 浏览器需要可信安全上下文，见 [Chrome WebGPU 排障说明](https://developer.chrome.google.cn/docs/web-platform/webgpu/troubleshooting-tips?hl=en)。仅跳过浏览器证书警告不能作为 WebGPU 可用性的承诺。

每次分享使用不可猜测路径，只提供内存中的不可变场景、已批准执行计划、被启用组件引用且摘要验证通过的受控资源，以及白名单浏览器构建文件。资源描述投影不包含项目路径。禁止目录浏览、主进程与 preload 文件、任意路径、非 GET/HEAD 请求和不匹配的 Host。分享链接与证书不写入操作日志。服务没有编辑器 IPC、工程修改或远程执行入口。

手机页面复用生产 `preview-runtime`，在 `sandbox="allow-scripts"` 的 iframe 中独立运行游戏，保留执行计划及资源校验、WebGPU 渲染、脚本能力和生命周期边界。用户点击开始后才运行，支持重玩、全屏、退出及分享撤销检测。画布铺满手机的当前可见视口，跟随旋转、浏览器可用高度及全屏变化，不使用电脑预览尺寸进行缩放。手机通过校验后的私有启动选项 `cameraFit: short-axis` 保留相机在屏幕短边上的配置视野，避免纵屏裁切；只调整运行环境的投影，不改工程相机数据、脚本或执行计划。桌面预览默认保持原有投影语义；不自动将鼠标操作转换成触屏手势。

“扫码运行”入口使用纯 SVG 二维码图标、可访问名称，以及公共 UI Tooltip 的 1000ms 延迟说明。Web 编辑器隐藏该入口及 Tooltip 容器。

## 组合按键

浏览器遵循 [Pointer Events 的组合按键规则](https://www.w3.org/TR/pointerevents3/#chorded-button-interactions)：按下第一个鼠标键时产生 `pointerdown`，按住时增减其他键会产生 `pointermove`，最后一个键松开才产生 `pointerup`。原预览桥仅在 down/up 时携带 button，因此丢失中间按键边沿。

新增逐 pointerId 的按钮掩码跟踪，依据 DOM `buttons` 差异转为既有逻辑 down/up。常规移动不伪造按钮；取消或丢失捕获只取消指针并释放映射动作，避免把取消识别成点击。blur 和销毁会清理状态。无需改变 Engine Replay 公共格式或项目脚本。

直接调用 `play.input` 从模拟层进入，不能证明 DOM 适配正确。新增真实 Chromium 输入分发回归，验证实际可信 `pointermove(button, buttons)` 能转换为脚本收到的 down/up，并保留隔离 iframe、HTTPS 验证与 GPU 渲染。测试会话只验证其临时 CA 的签名与 IP，不修改系统信任库或全局禁用证书校验。
