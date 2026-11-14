# Wenhao Liu — Static Personal Website

纯静态个人技术网站，不需要 Node.js、数据库或构建步骤。页面使用语义化 HTML 和共享 CSS；笔记由自托管的 Vditor 静态预览引擎呈现。

## 视觉设计

主页采用浅灰背景、白色圆角卡片、柔和阴影和蓝色链接，主体最大宽度为 1080px。按个人介绍、Projects、Education & Experience、Posts & Notes 的顺序纵向展示，顶部导航滚动定位到对应模块。经历区域在桌面上使用两列，小屏幕改为单列；笔记按日期从新到旧排列，桌面上日期和标题分列，手机上日期位于标题上方。

视觉布局参考 [Jiaqi Xin 的个人主页](https://xin-jiaqi.github.io/)，采用独立编写的 HTML、CSS 和 JavaScript 实现。其公开模板仓库的 [README 权利说明](https://github.com/Xin-Jiaqi/minimal-academic-homepage#rights-status) 目前标注尚未选择开源许可，因此本项目没有复制其源码和图片。

首页样式位于 `assets/css/home.css`，共享基础样式与阅读器外框位于 `assets/css/base.css`；正文阅读器继续使用接近 Typora GitHub 主题的排版。

教育经历中的上海大学校徽已下载到 `assets/images/shanghai-university-emblem.png`，来源为上海大学官网的[校徽介绍页](https://www.shu.edu.cn/xxgk/sdwh/xhjs.htm)及其[原始图片](https://www.shu.edu.cn/__local/0/08/C6/1EABE492B0CF228A5564D6E6ABE_779D1EE3_5BF7.png)。页面使用本地图片，并保持原图比例。

## 页面

- `index.html`：网站默认入口，包含个人介绍、项目、经历与笔记模块
- `notes/reader.html`：Markdown 笔记阅读器
- `posts/`：Markdown 原文与笔记图片；新增正文继续放在这里
- `assets/vendor/vditor/`：Vditor 3.10.6 静态预览运行时，包含 Markdown、KaTeX、Mermaid 和代码高亮资源

根目录的 `index.html` 是主要内容页；顶部导航通过 `#projects`、`#experience` 和 `#posts` 定位。旧的首页标签入口已改为单页滚动结构，文章链接保持不变。

首页继续使用生成的 `assets/js/notes-data.js`，由 `assets/js/home.js` 按目录已有的日期倒序展示全部文章。文章不再按主题分组或折叠，每行包含发布日期与标题，整行可点击进入阅读器。

## 笔记管理

笔记元数据（日期、标题）以 front-matter 形式写在每篇 Markdown 顶部，示例：

```markdown
---
id: agent-runtime
date: 2026-08-01
title: Agent Runtime Notes
---

# 正文标题
```

新增或修改笔记后，在仓库根目录运行：

```bash
python3 tools/build_notes.py
```

`id` 和 `date` 是已发布笔记的必填字段。`id` 是用于公开链接的稳定短标识，只能包含小写字母、数字和连字符，并且不能重复；`date` 必须是真实的 `YYYY-MM-DD` 日期。`title` 省略时取正文首个一级标题。

脚本会严格校验所有元数据，同时检查未闭合的代码围栏和失效的本地图片引用，再重新生成 `assets/js/notes-data.js`。该生成文件需要和代码一起提交，不要手动编辑。CI 或提交前可以使用下面的命令检查数据是否为最新：

```bash
python3 tools/build_notes.py --check
```

## 本地预览

Markdown 阅读器需要通过 HTTP 读取文章，不能直接用 `file://` 打开。可在仓库根目录运行：

```bash
python3 -m http.server 8000
```

然后访问 `http://localhost:8000/`。

## 部署到 GitHub Pages

1. 将项目内容放到 GitHub 仓库根目录并推送。
2. 打开仓库的 `Settings → Pages`。
3. 在 `Build and deployment` 中选择 `Deploy from a branch`。
4. 选择 `main` 分支和 `/ (root)` 目录。
5. 保存并等待部署完成。

所有站内资源均使用相对路径。阅读器由 Vditor 统一解析并安全输出 CommonMark/GFM；`assets/css/typora-github.css` 参照 Typora 默认 GitHub 主题处理正文的标题、表格、引用和代码样式，并将行宽限制在适合长文阅读的范围内。共享的 `base.css` 负责网站外框与阅读器页头页脚。阅读器仍会修正正文中的相对链接和图片路径，并按需渲染 KaTeX 公式、Mermaid 图表与代码高亮；Mermaid 保持 `strict` 安全级别。运行时不依赖 CDN。Vditor 资源当前固定为 `3.10.6`，升级时需同步更新 HTML 中的版本标记并回归检查公式、图表和代码块。
