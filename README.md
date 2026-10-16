# Wenhao Liu — Static Personal Website

纯静态个人技术网站，不需要 Node.js、数据库或构建步骤。页面使用语义化 HTML 和共享 CSS；笔记由自托管的 Vditor 静态预览引擎呈现。

## 视觉设计

网站采用内容优先的简洁风格：白底黑字、单列排版。首页通过 Posts、Projects 与 About 三个标签在同一页面切换内容。正文阅读器使用接近 Typora GitHub 主题的排版。

## 页面

- `index.html`：网站默认入口，通过顶部标签切换文章、项目与个人介绍
- `about.html`：完整个人介绍、关注方向与联系方式的独立兼容入口
- `projects.html`：项目列表与相关链接的独立兼容入口
- `notes/reader.html`：Markdown 笔记阅读器
- `posts/`：Markdown 原文与笔记图片；新增正文继续放在这里
- `assets/vendor/vditor/`：Vditor 3.10.6 静态预览运行时，包含 Markdown、KaTeX、Mermaid 和代码高亮资源

根目录的 `index.html` 是主要内容页；顶部标签只切换当前页面中的内容，不触发页面跳转。

## 笔记管理

笔记元数据（日期、分类、标题）以 front-matter 形式写在每篇 Markdown 顶部，示例：

```markdown
---
id: agent-runtime
date: 2026-08-01
category: agent
title: Agent Runtime Notes
---

# 正文标题
```

新增或修改笔记后，在仓库根目录运行：

```bash
python3 tools/build_notes.py
```

`id` 和 `date` 是已发布笔记的必填字段。`id` 是用于公开链接的稳定短标识，只能包含小写字母、数字和连字符，并且不能重复；`date` 必须是真实的 `YYYY-MM-DD` 日期。`category` 可取 `agent` 或 `other`，省略时使用 `other`；`title` 省略时取正文首个一级标题。

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

所有站内资源均使用相对路径。阅读器由 Vditor 统一解析并安全输出 CommonMark/GFM；`assets/css/typora-github.css` 将正文排版调整为 Typora 默认 GitHub 主题的宽度、字体、标题、表格、引用和代码样式，字体文件及授权信息保存在 `assets/fonts/typora-github/`。共享的 `base.css` 只负责网站外框。阅读器仍会修正正文中的相对链接和图片路径，并按需渲染 KaTeX 公式、Mermaid 图表与代码高亮；Mermaid 保持 `strict` 安全级别。运行时不依赖 CDN。Vditor 资源当前固定为 `3.10.6`，升级时需同步更新 HTML 中的版本标记并回归检查公式、图表和代码块。
