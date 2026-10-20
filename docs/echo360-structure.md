# YorkU Echo360 结构探索笔记

> 探索时间：2026-10-19，学生视角（5 个 Echo360 课程，124 个 lesson）。
> 这些是 `src/echo360.js` 所依赖的事实；Echo360 改版后导出出错，先对照这里排查。

## 1. 平台概况

| 项目 | 观察结果 |
| --- | --- |
| 地址 | `https://echo360.ca`（加拿大区域；York 的 institutionId `dd36aa86-85dc-434f-820c-f58116e2e441`） |
| 登录 | 通常从 eClass 课程里的 Echo360 LTI 活动进入（`isLtiSession: true`），会话靠 cookie |
| 前端 | 每个路由服务端渲染一页，页面里用 `Echo["xxxApp"]("<转义 JSON>")` 启动 React 应用 |
| 路由表 | `GET /jsroutes` 返回完整的 Play 路由（方法 + URL 模板），找接口最快的办法 |
| 文件 CDN | `files.echo360.ca`（原始文件）、`content.echo360.ca`（HLS 流、缩略图）、`thumbnails.echo360.ca`（海报、幻灯片图），都用 CloudFront 签名 cookie；跨域 `fetch` 必须带 `credentials: 'include'` |

所有 JSON 接口都是 `{"status":"ok","message":"","data":…}` 包装；出错时 `status: "ko"`，`message` 如 `Exception.unauthorized`。

## 2. 用到的只读接口

| 用途 | 接口 | 说明 |
| --- | --- | --- |
| 我的课程 | `GET /user/enrollments` | `data[0].userSections[]`：`sectionId, courseCode, courseName, sectionName, lessonCount, termId`；`data[0].termsById` 给学期名和开始日期 |
| 课程大纲 | `GET /section/{sectionId}/syllabus` | `data[]`：`SyllabusGroupType`（分组/周，含 `groupInfo.name` 和 `lessons[]`）或单独的 lesson。每个 lesson 有 `lesson.{id, displayName, createdAt}`、`startTimeUTC`、`medias[]`（`id, mediaType: Video/Presentation/Audio, title, thumbnailUri`）、`questionCount`、`hasVideo/hasSlideDeck/isFuture` |
| 播放器数据 | `GET /lesson/{lessonId}/classroom`（HTML） | 页面里 `Echo["echoPlayerV2FullApp"]("…")` 的 JSON：`video{mediaId, duration(ISO 8601), playableMedias[](HLS), posterMedia[]}`、`slides{slideDeck{originalFile{name,url,sizeInBytes}}, slidesWithImages[]{slide{text, thumbnailUrl}}}`、`chapters`、`captions`、`copyrightData{restrictDownload}`、`user`（含邮箱，导出时去掉） |
| 下载选项 | `GET /api/ui/echoplayer/lessons/{lessonId}/medias/{mediaId}/download-info` | 播放器“下载”菜单的数据源：`audioFiles[]`、`primaryFiles.files[]`、`secondaryFiles.files[]`、`transcriptFiles[]`。老师关闭下载时视频相关数组为空（甚至整个 `data: []`）；对 Presentation 媒体返回 404 |
| 下载文件 | `GET …/medias/{mediaId}/file/{fileName}` → `{downloadUri}` | 播放器下载视频/音频用；对 transcript 文件名返回 `Exception.unauthorized` |
| 字幕/转录 | `GET …/medias/{mediaId}/transcript-file?format=vtt` 或 `format=text` | 返回 `attachment` 文件；`…/transcript` 返回 JSON cues |
| 讨论区 | `GET /api/ui/discussions/lessons/{lessonId}/questions` | `data.questions[]{question{body, createdAt, videoContentRef{timestampMillis}, likeCount, pinned}, responses[]{body, authorFirstName, authorLastName, createdAt}}`；提问者常为匿名（只有 `authorId`） |
| 我的笔记 | `GET /section/{sectionId}/notes/download`（也有 `/lesson/{id}/notes/download`） | 纯文本附件，没有笔记时为空 |
| 学习指南 | `GET /section/{sectionId}/study_guide_list` | HTML 片段（本账号为空，未导出） |

注意避开的接口：`PUT …/discussions/…/config`、`POST /questions/search`（虽然是搜索但用 POST）、所有 `like/bookmark/read` 等会写状态的接口。

## 3. 机构开关（`user.currentInstitution.toggles`）

York 打开了 `contentDownloads`、`outOfTermContentDownloads`、`studentUcDownload`、`discussions`、`captions`、`requestTranscriptions`。
但**是否能下载某个视频由老师按课程设置**：本账号 4 个有录像的课程、全部 124 个 lesson 的 `download-info` 都没有视频文件（多数直接返回 404）。不过播放器本身仍能拿到 HLS 流，所以导出器改为抓取并合并 HLS。

HLS 的实际结构（2026-10-19 实测，已登录）：

- `player.video.playableMedias[]` 给出 `s0_a.m3u8`（纯音频）、`s1_v.m3u8`（纯视频）、`s1_av.m3u8`（音视频组合）三种入口。选 `trackType` 同时含 `Audio` 和 `Video` 的那个。
- `s1_av.m3u8` 是 master playlist：`#EXT-X-STREAM-INF` 列出 `s1q0.m3u8`（640×360）、`s1q1.m3u8`（1920×1080），`#EXT-X-MEDIA:TYPE=AUDIO` 用 `GROUP-ID` 指向对应的 `s0q0.m3u8` / `s0q1.m3u8`。所以**视频和音频是两条独立的 fMP4 流**，播放器自己合成。
- 媒体播放列表用 `#EXT-X-MAP` + `#EXT-X-BYTERANGE`，所有分片在同一个 `s1q1.m4s` / `s0q1.m4s` 文件里，按 4–10 秒切分；没有 AES key，没有 DRM。
- 每个分片是 `sidx + moof + mdat` 的 fragmented MP4（H.264 视频 / AAC 单声道音频）。`init` 段是 `ftyp + moov`，里面只有一个 track。
- CDN 是 `content.echo360.ca`，带 `x-uid` 等查询参数的 URL 只是给播放器看的；直接用 cookie 请求不带查询参数的子播放列表/分片也能拿到 200/206。

导出器的处理：下载 init 与全部分片 → 把音频轨的 `trak`/`trex`/`tfhd` track_ID 改成 2，把两个 `moov` 合成一个 → 按 `tfdt` 解码时间交错拼接 `moof+mdat` → 写成一个 `recording.mp4`。不转码，可直接拖动进度条。`AES-128` 流会用 WebCrypto 解密；`SAMPLE-AES`/FairPlay 等 DRM 会报错并跳过。

实测（2026-10-19）：EECS 2101 Week 1（6836 秒，1080p）合并后 274,458,716 字节，684 个视频分片 + 684 个音频分片，用时 86 秒；浏览器里可加载、播放、拖到结尾，音频轨正常。EECS 1720 的 Remote Lab（670 秒）合并后 52,647,815 字节，用时 11 秒。输出是 fragmented MP4（`moov` 在文件头，后面是交错的 `moof+mdat`），Chrome/Firefox/VLC/ffmpeg 都能直接播放；没有 `sidx`，但播放器按 `moof` 顺序索引，拖动正常。

## 4. 本账号的实际情况（2026-10-19）

| 课程 | lesson | 有媒体 | 转录 | 幻灯片 | Q&A | 可下载视频 |
| --- | --- | --- | --- | --- | --- | --- |
| LE/EECS 2101 A (Fall 2023-2024) | 45 | 45 | 12 | 12（PDF） | 5 | 0 |
| LE/EECS 3431 A (Fall 2023-2024) | 20 | 18 | 18 | 0 | 0 | 0 |
| LE/EECS 1720 M (Winter 2022-2023) | 17 | 11 | 11 | 0 | 0 | 0 |
| LE/EECS 1710 A (Fall 2022-2023) | 42 | 40 | 未统计 | 1 | 0 | 0 |
| LE/EECS 3461 M (Winter 2023-2024) | 0 | — | — | — | — | — |

## 5. 导出策略

- **视频抓取并合并 HLS 流**：官方下载不可用时，直接保存播放器使用的 HLS（视频/音频分开则合并成一个 MP4），绕过老师关闭的下载按钮；不重新编码、不处理 DRM。
- 每个 lesson：转录（VTT + TXT，TXT 同时内嵌在 lesson 页可搜索）、幻灯片原始文件 + 每页文字、Q&A、海报图、`lesson.json`（去掉 `user` 等个人数据）。
- 每个课程：按分组建文件夹、`index.html` 表格（日期/时长/保存了什么）、`my-notes.txt`（有笔记时）、`section.json`。
- 写在备份根目录的 `Echo360/` 子文件夹里，和 eClass 备份可共用同一个文件夹，两个总目录互相链接。
- 请求节流约 3 次/秒（Echo360 是否有 WAF 未知，测试中 163 次请求无异常）；CDN 下载并发 3。
