# xbb-notes

后端技术学习笔记，基于 [VitePress](https://vitepress.dev/) 构建，通过 GitHub Pages 发布。

站点地址：https://xbb1993.github.io/xbb-notes/

## 内容

- `docs/redis/`：Redis 学习笔记（基于《Redis设计与实现》+ 现代生产补充，共 32 篇）
- `docs/architect/`：系统架构设计师学习笔记（共 17 篇）

## 本地预览

```bash
npm install
npm run docs:dev      # 开发预览，默认 http://localhost:5173/xbb-notes/
npm run docs:build    # 构建，输出到 docs/.vitepress/dist
```

## 新增笔记

1. 在对应目录（如 `docs/redis/`）新建 `.md`，文件名用英文，例如 `ch25-xxx.md`，第一行写 `# 标题`。
2. 在 `docs/.vitepress/config.mts` 的侧边栏对应分组里加入文件名（不含 `.md`）。
3. 提交并推送到 `main`，GitHub Actions 会自动构建并发布。

## 写作注意

- 正文里的 `<xxx>` 会被当作 HTML 标签，尖括号内容请用反引号包起来，或写成 `\<`。
- 正文里的 `{{ }}` 会被当作 Vue 表达式，同样用反引号或代码块包起来。
- 动图/交互页面（独立 HTML）放进 `docs/public/`，笔记里用 `/xbb-notes/文件名.html` 链接。
