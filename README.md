# H.265 / H.264 WASM Player

独立静态双引擎播放器，默认尝试 HTML5 Video 原生解码，失败后使用 FFmpeg libavformat + libavcodec 软件解码，无需后端服务。

## 功能

- H.264 / H.265 MP4，原生解码 + WASM CPU 软解双引擎，无插件。
- `auto`（默认）：HTML5 Video 原生优先，媒体错误或 20 秒内无法获得首帧时回退 WASM，尽量恢复进度和播放状态。自动播放策略阻止时提示手动点击，不触发软解回退。
- `native`：只用 HTML5 Video，实际硬解/软解由浏览器与系统决定；失败提示，不自动回退。
- `software`：强制 FFmpeg WASM CPU 解码，不调用原生视频解码。切换模式时重新打开当前视频并尽量恢复进度。
- 支持本地文件、HTTP(S) URL；视频在浏览器处理，不上传到服务器。
- Web Worker 独立解码、有界帧队列、PTS 播放时钟、关键帧 seek、0.5/1/2/3 倍速。
- WebGL YUV 渲染，无法建立 WebGL context 时回退 Canvas 2D；无需视频硬解显卡。
- 静态 SVG 叠加，容器全屏及 CSS 全屏回退。

## GitHub Pages

在仓库 Settings → Pages → Build and deployment → Source 选择 GitHub Actions。
此后 main 分支的 web/**、native/**、build.sh 或工作流变更会自动构建并部署，无需手动 Run workflow。
WASM 核心及配套许可证、源码和重链接文件按 Emscripten 镜像版本、运行平台、build.sh 和 native/** 的内容哈希缓存；缓存未命中才编译 FFmpeg。每次构建始终重新复制当前 web/ 文件，避免发布旧页面。并发运行时取消过时任务。
预计播放器 URL： https://qishuhua.github.io/wasm-video-player/

也可在 Actions → Build WASM player → Run workflow 手动执行（deploy 默认勾选）；取消勾选则仅构建并上传 wasm-player-site artifact，方便测试。仅 README 变更不触发工作流。
可以解压该 artifact，用任意静态 HTTP 服务托管解压后的目录。
不要双击 file:// 页面，Worker/WASM 需要 HTTP(S)。

参数：?video=URL_ENCODED&autoplay=1&svg=URL_ENCODED&mode=auto
`mode` 可取 `auto`、`native`、`software`。
通过 video 查询参数传入的 URL 必须进行外层 URL 编码；直接粘贴到输入框则不需要。WASM 软解及自动回退要求跨域 MP4 允许本站的 CORS GET，详见下方网络视频播放注意事项。
静态 SVG 不做逐帧轨迹同步。

## 网络视频播放注意事项（OSS / S3 / MinIO / CORS）

**原生播放成功，不代表 WASM 软件解码一定能够读取同一个网络视频。** 原生 HTML5 Video 通常可以直接播放跨域媒体；WASM 路径通过 JavaScript `fetch()` 下载 MP4 二进制数据，必须满足浏览器 CORS（Cross-Origin Resource Sharing，跨源资源共享）规则。

| 解码模式 | 网络访问方式 | 跨域要求 |
| --- | --- | --- |
| auto | 原生优先，失败后 fetch + WASM | 回退到 WASM 时必须满足 CORS |
| native | HTML5 Video | 普通媒体播放通常不需要 CORS |
| software | fetch + FFmpeg WASM | 必须允许跨域读取 |
| 本地文件（任意模式） | File / Blob | 不涉及远程资源 CORS |

### 对象存储跨域配置

以阿里云 OSS 为例，在目标 Bucket 的权限管理 / 跨域设置中添加规则；S3、MinIO 等兼容对象存储也应配置相应的 CORS 规则。

| 配置项 | 建议值 |
| --- | --- |
| Allowed Origins | `https://qishuhua.github.io` |
| Allowed Methods | `GET`、`HEAD` |
| Allowed Headers | `Range`（如有其他必要请求头则按需添加；也可使用 `*`） |
| Expose Headers | `Content-Length`、`Content-Range`、`Accept-Ranges`、`ETag` |
| Max Age | 600 秒 |

Origin 只包含协议、域名和端口，不包含 `/wasm-video-player/` 路径。若部署到其他域名或本地 HTTP 服务，应允许对应的实际 Origin。建议启用 `Vary: Origin`（如果存储服务提供该选项），避免代理或 CDN 混用不同来源的响应。

预签名 URL 用于资源访问授权，CORS 用于控制浏览器跨域读取，两者独立。不需要为了 CORS 将私有 Bucket 设置为公共读，也不要在前端暴露 AccessKey Secret 或永久凭据。

### 视频地址及签名

- 在页面 URL 输入框中直接粘贴完整的 HTTP(S) 视频地址，包括全部预签名查询参数，无需对整个地址再次编码。
- 通过播放器的 `?video=...` 参数传入视频时，使用 `encodeURIComponent(videoUrl)` 或 `URLSearchParams` 对外层参数编码，避免内部签名参数的 `&` 被错误拆分。不要修改原始签名参数或重复编码。
- 确认签名未过期、对象存在且有读取权限。HTTPS 播放器应使用 HTTPS 视频地址，避免混合内容限制。
- 当前 WASM 模式完整下载视频后再解码，单文件上限 128 MiB；原生模式不受此应用限制。

### Failed to fetch 排查

若本地文件软解正常、网络视频原生播放正常，但强制软解出现 `Failed to fetch`，优先检查 CORS，不要直接判定为 H.265 解码失败。

1. 用同一个有效视频 URL 分别测试 `native` 和 `software`。
2. 打开浏览器 F12 → Console / Network，查看是否有 CORS、Mixed Content、DNS、网络连接或 HTTP 错误。
3. 检查 OSS GET 响应（包括实际重定向或 CDN 响应）是否返回匹配的 `Access-Control-Allow-Origin`。例如：

   ```bash
   curl -sS -D - -o /dev/null \
     -H 'Origin: https://qishuhua.github.io' \
     '完整的有效视频预签名URL'
   ```

   正常授权响应通常为 HTTP 200（Range 请求可能为 206），且应包含 `Access-Control-Allow-Origin: https://qishuhua.github.io`，或适用于不携带跨域凭据请求的 `*`。curl 不执行浏览器 CORS 检查，因此仅下载成功并不能证明浏览器可以读取。
4. 如果原生和 WASM 都失败，也检查签名有效期、对象路径和存储访问权限；HTTP 403/404 等错误响应缺少 CORS 头时，浏览器也可能只显示 `Failed to fetch`。

### 无法修改对象存储 CORS 时

- 通过受控 Nginx / 后端媒体代理提供同源访问或正确的 CORS 响应头；代理应限制目标地址及访问权限。
- 下载视频到本地，再通过播放器的文件选择器播放。
- 不可通过 `fetch(url, {mode: "no-cors"})` 绕过限制：其 opaque 响应无法向 JavaScript 提供视频二进制数据，WASM 也就无法解码。

仅修改 OSS CORS 规则不需要重新编译 WASM 或重新部署播放器。

## 本地构建

在固定版本 Emscripten 容器中执行：

    docker run --rm -v "$PWD:/src" -w /src emscripten/emsdk:3.1.64 bash build.sh /src/dist
    python3 -m http.server 8080 --directory dist

访问 http://localhost:8080/

## 限制

第一版使用单线程基础 WASM，不要求 SharedArrayBuffer 或 COOP/COEP，适合 GitHub Pages。
WASM 软解整段视频读入 MEMFS，限 128 MiB，面向短告警视频。原生路径不受该应用限制，可由浏览器进行渐进下载和 Range 请求。所有模式静音；暂无 RTSP、直播及 WASM 渐进下载。
Main10 转换为 8 位显示，不实现 HDR 色调映射。解码流畅度依赖 CPU、码流和浏览器。
没有实测保证 1080p 或三倍速；旧电脑建议先测试 720p/1080p 25fps。
浏览器需支持 WASM、Worker、现代 JS 模块；IE 不支持。

FFmpeg 固定 n7.1.1，LGPL 构建（无 GPL/nonfree 编码器）。构建附带准确版本源码、许可证及可重新链接的对象和静态库。商业分发需核实 LGPL、HEVC 专利等合规义务。
