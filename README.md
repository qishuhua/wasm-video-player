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
然后在 Actions → Build WASM player → Run workflow，勾选 deploy。
工作流编译 WASM，并将静态播放器部署到 GitHub Pages 站点根目录。
预计播放器 URL： https://qishuhua.github.io/wasm-video-player/

不勾选 deploy 时仅构建并上传 wasm-player-site artifact，方便先测试。
可以解压该 artifact，用任意静态 HTTP 服务托管解压后的目录。
不要双击 file:// 页面，Worker/WASM 需要 HTTP(S)。

参数：?video=URL_ENCODED&autoplay=1&svg=URL_ENCODED&mode=auto
`mode` 可取 `auto`、`native`、`software`。
URL 必须经过 URL 编码；WASM 软解及自动回退要求跨域 MP4 允许本站的 CORS GET。原生播放可能不需要 CORS，但仍遵守浏览器安全规则。HTTPS 页面应使用 HTTPS 视频。
静态 SVG 不做逐帧轨迹同步。

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
