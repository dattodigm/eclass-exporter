# YorkU eClass 结构探索笔记

> 探索时间：2026-10-16，账号视角：学生（54 门已选课程）。
> 这些是导出工具（`src/exporter.js`）所依赖的事实；eClass 升级后若导出出错，先对照这里排查。

## 1. 平台概况

| 项目 | 观察结果 |
| --- | --- |
| 系统 | Moodle 5.x（Bootstrap 5 标记 `data-bs-toggle`、`visually-hidden`；有 `mod_subsection`、`course/section.php`、`M.cfg.apibase=/api`） |
| 主题 | `moove` |
| 登录 | Passport York SSO；会话超时 `sessiontimeout = 28800` 秒（8 小时） |
| 文件存储 | `pluginfile.php/...` 会 302 跳转到 **CloudFront**（`dm7crvy4e45rz.cloudfront.net`，带签名 URL） |
| 页面结构 | 活动页主体在 `#region-main`（含 `.activity-header` 日期/说明）→ 内层 `[role=main]` |

### 负载均衡器限流（AWS WAF）

请求太快会被整站封禁：实测约 5 分钟内 ~2800 次请求（≈9 次/秒）后，所有 eClass 请求（页面和 AJAX）都返回

```
HTTP 403, server: awselb/2.0, content-type: text/html, 约 520 字节
<html><head><title>403 Forbidden</title></head><body><center><h1>403 Forbidden</h1></center>...
```

停止请求后约 2 分钟自动解除。正常的 eClass 响应没有 `server` 头，Moodle 自己的错误页也不是这个样子，
所以能可靠区分。导出工具把 eClass 请求限制在约 3 次/秒（实测 2.75 次/秒稳定无封禁），
遇到这种 403 自动暂停并降速。CDN（CloudFront）上的文件下载不计入。

### CloudFront 跨域的坑

CloudFront 返回 `Access-Control-Allow-Origin: *`。因此 `fetch()` **不能**带 `credentials: 'include'`，
否则跨域重定向后 CORS 失败（报 `Failed to fetch`）。默认的 `same-origin` 模式已经会把 eClass cookie
带给 `eclass.yorku.ca`，CDN 不需要 cookie（URL 已签名），`Content-Disposition` 头也可读。
但 CDN 响应经常**没有 `Content-Length`**，所以不能靠“大小相同”判断文件是否已下载；
导出工具改为读取上次的 `course.json` 里记录的路径来续传。

### 不在任何 section 里的活动

隐藏 section 里的活动对学生来说 `uservisible` 可能为 true（“stealth”，例如给 page 放图片的 folder），
但它不会出现在任何 section 的 `cmlist` 里。导出工具把这类活动放到 `_Unlisted activities/`。

## 2. 可用的 AJAX 接口

调用方式：`POST /lib/ajax/service.php?sesskey=<M.cfg.sesskey>&info=<方法名>`，
body 为 `[{"index":0,"methodname":"...","args":{...}}]`。只有标记为 `ajax: true` 的外部函数能用。

| 方法 | 结果 | 用途 |
| --- | --- | --- |
| `core_course_get_enrolled_courses_by_timeline_classification` | ✅ | 课程列表（`classification: "allincludinghidden"`, `limit: 0`）。返回 fullname / shortname / summary / courseimage / 分类(学期) / 起止日期 / 进度 |
| `core_courseformat_get_state` | ✅ | **课程结构权威来源**：所有 section（含子 section）与 cm（活动）的 id、名称、类型、URL、可见性、限制、完成状态。返回值是 JSON 字符串，需要再 `JSON.parse` |
| `mod_forum_get_discussion_posts` | ✅ | 讨论帖完整内容（message HTML、作者、时间、parentid、attachments） |
| `core_session_time_remaining` | ✅ | 检测会话是否过期 |
| `core_course_get_recent_courses` | ✅ | 最近访问课程 |
| `core_calendar_get_action_events_by_course` | ✅ | 课程日历待办 |
| `core_course_get_contents`、`mod_assign_get_assignments`、`mod_forum_get_forums_by_courses`、`mod_wiki_*`、`mod_glossary_*`、`mod_book_*`、`mod_quiz_get_user_attempts`、`gradereport_user_*`、`core_enrol_get_enrolled_users`、`core_webservice_get_site_info` | ❌ `servicenotavailable` | 没开放给 AJAX，只能解析 HTML |

不可访问的课程（多数是 Lab/Tutorial 子课程）调用 `core_courseformat_get_state` 返回 `requireloginerror`，
打开 `course/view.php` 会显示 *"This course is currently unavailable to students"*。

## 3. 课程结构

```
课程 course
├─ section 0 "General"            (state.section[], 顺序见 state.course.sectionlist)
│   ├─ cm: forum "Announcements"
│   ├─ cm: label（纯 HTML，显示在课程页）
│   └─ cm: subsection ──► 委托 section（component = "mod_subsection", parentsectionid）
│                          └─ cm ...
└─ section N ...
```

- `state.section[i]`：`id, number, title(HTML 转义), cmlist[], sectionurl, component, parentsectionid, visible`
- `state.cm[i]`：`id, name(HTML 转义), module, modname, url, sectionid, uservisible, accessvisible, hascmrestrictions, delegatesectionid(子 section)`
- `uservisible = false`：受限/隐藏活动，打开 view.php 会被重定向回课程页 → 导出时只记录，不抓取。

### 课程格式（影响 HTML 渲染，不影响 state）

| 格式 | 课程数 | 课程主页能否看到全部活动 |
| --- | --- | --- |
| topics | 19 | 能 |
| weeks | 2 | 能 |
| menutab | 5 | **不能**（主页只渲染一个标签页，cm 数为 0） |
| grid | 1 | 不能（只显示格子） |
| flexsections | 1 | 部分 |

结论：结构取自 `core_courseformat_get_state`；摘要 / 标签内容 / 活动说明从
**`course/section.php?id=<sectionid>`** 抓取，每种格式都能完整渲染（嵌套的子 section 也会一起渲染）。

### Section 页里的 HTML 选择器

| 内容 | 选择器 |
| --- | --- |
| section 元素 | `[data-for="section"][data-id="<sectionid>"]` |
| section 摘要 | `[data-for="sectioninfo"] .summarytext` |
| section 限制说明 | `.section_availability` |
| 活动元素 | `[data-for="cmitem"][data-id="<cmid>"]` |
| 标签内容 / 课程页上的活动说明 | `.activity-altcontent` |
| 活动日期 | `[data-region="activity-dates"]` |
| 活动限制说明 | `.availabilityinfo` |

## 4. 各类活动（全部 54 门课的统计与抓取方式）

| 模块 | 数量 | 内容在哪里 | 导出做法 |
| --- | --- | --- | --- |
| resource（文件） | 493 | `mod/resource/view.php?id=X&redirect=1` → 302 → CloudFront 文件 | 直接下载，文件名用活动名 + 原扩展名 |
| label | 439 | 课程页 `.activity-altcontent` | 嵌入课程 index.html |
| url | 253 | `mod/url/view.php?id=X&forceview=1` 的 `.urlworkaround a`（嵌入模式为 iframe/frame） | 生成 `(link).html` 记录目标 |
| assign | 178 | `#region-main`：开放/截止日期、说明、附件、**自己的提交文件**、评分、反馈、批注 PDF（`assignfeedback_editpdf`） | 保存页面 + 下载所有 pluginfile |
| page | 172 | `#region-main .generalbox` | 保存页面 + 图片 |
| subsection | 128 | 委托 section | 嵌套目录 |
| forum | 108 | 讨论列表 `view.php?id=X`（分页参数 `p`）；帖子用 AJAX `mod_forum_get_discussion_posts` | 列表页 + 每个讨论一个 HTML |
| lesson | 106 | `view.php?id=X`；左侧菜单为 GET 链接 `view.php?id=X&pageid=Y` | 只顺着菜单 GET，**不提交答案** |
| quiz | 91 | `view.php` 尝试记录；回顾 `review.php?attempt=A&cmid=X&showall=1` | 保存概览 + 每次尝试的回顾 |
| lti / h5pactivity | 30 / 30 | 外部工具 / iframe `h5p/embed.php?url=<pluginfile .h5p>` | 保存页面；H5P 包下载为 `.h5p` |
| folder | 17 | `view.php` 的 `.foldertree`；“在课程页内联显示”的文件夹会重定向回课程页，树在 section 页里 | 按原目录树下载 |
| feedback / attendance / data / choicegroup / tab / journal / glossary / turnitintooltwo / book / wiki / choice / questionnaire / mediagallery / scheduler | 17 / 12 / 12 / 11 / 11 / 6 / 6 / 7 / 4 / 4 / 3 / 3 / 3 / 1 | 各自 view.php | 通用：保存 `#region-main` + 附件 |

专门处理的几种：

- **book**：`mod/book/tool/print/index.php?id=X` 一页打印全书。
- **glossary**：`mod/glossary/print.php?id=X&mode=letter&hook=ALL&page=-1` 显示全部词条（默认每页 10 条）。
- **wiki**：`map.php?pageid=<首页>&option=5` 列出全部页面；每页用 `prettyview.php?pageid=Y`；附件在 `files.php?pageid=Y`。小组 wiki 默认显示用户所在小组。
- **data（数据库）**：不要用 `perpage=` 参数（会被存成用户偏好），改为跟随分页链接。
- **forum**：不要用 `discuss.php?mode=` 参数（会改用户的显示偏好），所以帖子走 AJAX。

## 5. 课程级页面

| 页面 | URL | 内容 |
| --- | --- | --- |
| 课程信息 | `course/info.php?id=X` | 课程卡片、讲师（`.course-contacts .contact .name/.role`） |
| 我的成绩 | `grade/report/user/index.php?id=X` | 成绩项、权重、分数、反馈 |
| 课程主页 | `course/view.php?id=X` | 各格式渲染不同，不作为数据源 |

## 6. 只读原则（导出工具遵守）

- 只发 GET 请求和上面列出的只读 AJAX；不提交任何表单（lesson 答题、quiz 开始尝试、作业提交都不会触发）。
- 不带会写入用户偏好的参数（`perpage`、`mode`、排序 `o=` 等）。
- 打开活动页会产生一条“已查看”日志，对设置了“查看即完成”的活动会标记完成，和手动点开一样。
