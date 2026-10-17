[English](README.md) | **简体中文**

# eClass Exporter（YorkU eClass 课程备份工具）

把 [eclass.yorku.ca](https://eclass.yorku.ca) 上的课程完整导出到本地，离线也能浏览：
课程信息、各 section 内容、标签、文件、作业（含自己的提交和老师批注）、讨论区、Wiki、
Quiz 回顾、Lesson、Book、Glossary、数据库、H5P、链接，以及“我的成绩”。

- **一键备份全部课程**：在任意 eClass 页面点右下角 **⬇ Export eClass** → *Choose courses…* → *Export selected*
- **单独导出某门课**：进入课程（或课程里任意活动页）→ **⬇ Export eClass** → *Export this course*

它运行在你已登录的浏览器标签页里，所以能看到的内容和你在 eClass 上能看到的一样；
不需要密码或 token，除了 eClass 本身不会向任何地方发送数据。

## 安装

从 [最新 Release](https://github.com/dattodigm/eclass-exporter/releases/latest) 下载。

### Chrome / Edge（推荐）

1. 下载 `eclass-exporter-chrome-<版本>.zip` 并解压。
2. 打开 `chrome://extensions`（Edge 用 `edge://extensions`），打开右上角 **开发者模式**。
3. 点 **加载已解压的扩展程序**，选择解压出来的文件夹。
4. 刷新任意 eClass 页面，右下角出现红色 **⬇ Export eClass** 按钮。

### Firefox

- **用户脚本（Firefox 推荐）**：安装 [Tampermonkey](https://www.tampermonkey.net/) 或
  [Violentmonkey](https://violentmonkey.github.io/)，然后打开
  [`eclass-exporter.user.js`](https://github.com/dattodigm/eclass-exporter/releases/latest/download/eclass-exporter.user.js)
  确认安装。之后发布新版本会自动更新。
- **扩展（实验性）**：下载 `eclass-exporter-firefox-<版本>.zip`，打开 `about:debugging#/runtime/this-firefox`，
  点 **临时载入附加组件…** 选这个 zip。因为没有经过 Mozilla 签名，重启 Firefox 后会被移除。

Firefox 不支持直接写入文件夹，只能用 **ZIP** 模式。

### 任意浏览器临时使用

在 eClass 页面按 `F12` → Console，粘贴 `eclass-exporter.user.js` 的全部内容回车，按钮就会出现（刷新页面后消失）。

## 使用

| 选项 | 说明 |
| --- | --- |
| Save to a folder | **推荐**（Chrome/Edge）。选一个空文件夹，例如 `文档\eClass-Backup`，文件直接写进去。可断点续传：再次导出到同一文件夹时，已下载的文件会跳过。不要直接选“文档”“桌面”这类系统文件夹，浏览器会拒绝，在里面新建一个子文件夹即可。 |
| Download a ZIP per course | 每门课下载一个 ZIP（另有一个 `eClass-index.zip` 放总目录）。全部解压到同一个文件夹即可互相链接。单门课超过 3.5 GB 会自动分卷。 |
| Download files and attachments | 关闭后只保存页面，文件链接指向 eClass。 |
| Forums and discussions | 是否导出讨论区。 |
| My grades | 保存成绩报告页。 |
| Skip files larger than N MB | 跳过大文件（如课程录像）；跳过的文件在页面里会用黄色虚线框标出并链接回 eClass。 |

导出过程中可以切到别的标签页，但 **不要关闭或刷新这个 eClass 标签页**。
会话过期（8 小时）时导出会停止并提示，重新登录后再导出到同一文件夹即可继续。

**速度与限流**：eClass 前面的负载均衡器会封禁请求过快的客户端（实测约 9 次/秒持续几分钟后，
整个 eClass 对该浏览器返回 `403 Forbidden`，约 2 分钟后自动解除）。所以工具把对 eClass 的请求限制在
约 3 次/秒；文件本体从 CDN 下载，不受此限制。万一仍被限流，工具会自动暂停 1→2→4… 分钟并降速重试。
实测参考：一门普通课程 1–3 分钟，大型课程（200 个活动、1000+ 文件）约 10 分钟，全部课程预计 30–60 分钟。

**断点续传 / 增量更新**：再次导出到同一文件夹时，页面会重新生成，已存在的文件不会重新下载。
如果老师替换了同名活动里的文件，想拿到新版本，取消勾选 *Skip files already in the folder* 再导出一次。

## 导出结果

```
eClass-Backup/
├─ index.html                     ← 所有课程总目录（按学期排序）
├─ courses.json
└─ AP-CMDS 4275 M - Power, Resistance and New Me (Winter 2025-2026)/
   ├─ index.html                  ← 课程主页：信息、讲师、各 section、标签内容、活动链接
   ├─ course-info.html            ← 课程信息（讲师）
   ├─ grades.html                 ← 我的成绩
   ├─ course.json                 ← 完整结构数据（含 eClass 原始 state）
   ├─ _files/                     ← 摘要/标签里的图片、附件
   ├─ 00 - General/
   │  ├─ 01 - Announcements/      ← 论坛：index.html + discussions/*.html + files/
   │  ├─ 02 - Social Justice Tech Audit/   ← 作业：说明、截止日期、我的提交、评分、批注 PDF
   │  ├─ 06 - Syllabus.pdf        ← 文件资源直接保存
   │  └─ 07 - News Finder Sign Ups (link).html
   ├─ 01 - Week 1- Introduction- Why Resist/
   │  └─ ...
   └─ _Unlisted activities/       ← 能打开但没有列在任何可见 section 里的活动
```

用浏览器打开 `index.html` 就能离线浏览。所有页面顶部有面包屑导航和 “Open on eClass ↗” 原始链接。

## 会导出什么 / 不会导出什么

**会**：所有你能访问的活动；受限或隐藏的活动会在课程主页标注 *restricted* 和限制条件。
无法访问的课程（例如未开放给学生的 Lab/Tutorial 子课程）会在总目录里注明原因。

**不会 / 有限**：

- LTI 外部工具、Turnitin、YuJa/YouTube 等嵌入视频：只保存页面和链接，不下载外部平台内容。
- Lesson：只沿着 Lesson 自己的菜单抓取页面，不会替你答题，所以菜单里没有的页面不会出现。
- Quiz：只保存允许回顾的已完成尝试，不会开始新的尝试。
- 小组 Wiki：保存你所在小组的版本。
- 其他同学的个人信息：只保存在你能看到的讨论帖里出现的部分。

**只读**：工具只发 GET 请求和三个只读 AJAX 接口，不会提交作业、答题或修改任何设置。
打开活动页会像你手动点开一样留下“已查看”记录。

## 开发

```
src/exporter.js            唯一的源码（扩展、用户脚本、控制台三种形态共用）
build.mjs                  生成 extension/（Chrome）、dist/firefox/ 与 dist/eclass-exporter.user.js
docs/eclass-structure.md   eClass 结构探索笔记（接口、选择器、限流、各模块抓取方式）
.github/workflows/         CI 构建检查与自动发布
```

修改 `src/exporter.js` 后运行：

```bash
node build.mjs
```

脚本化调用（控制台）：

```js
// 导出指定课程 id，ZIP 模式
await eclassExporter.run([138507], { mode: 'zip', maxMB: 200 });
// 当前进度 / 取消
eclassExporter.current?.stats;
eclassExporter.current?.cancel();
```

Firefox 的 `web-ext lint` 会对 `innerHTML` 报警告：这些写入都发生在 `DOMParser` 创建的文档里，
这种文档不执行脚本也不加载资源，内容只会被保存到磁盘。

### 发布新版本

修改 `src/exporter.js` 里的 `VERSION`，运行 `node build.mjs` 并提交，然后打标签推送：

```bash
git tag v1.0.1 && git push origin v1.0.1
```

*Release* 工作流会检查标签和 `VERSION` 是否一致，打包 Chrome、Firefox 扩展和用户脚本，并发布到 GitHub Releases。

## 许可证

[MIT](LICENSE)
