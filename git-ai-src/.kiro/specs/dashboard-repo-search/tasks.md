# Implementation Plan: Dashboard 仓库搜索

## 概述

在 `agent-support/kiro-dashboard/public/index.html` 中添加搜索功能，包括搜索输入框、缓存变量、过滤逻辑和无匹配提示。纯前端改动，单文件修改。

## Tasks

- [x] 1. 添加搜索输入框和样式
  - 在刷新按钮和 `#app` 之间添加工具栏容器 `<div>`，包裹刷新按钮和搜索输入框
  - 添加 `<input id="search-input" placeholder="搜索仓库...">` 
  - 添加搜索框 CSS 样式（暗色主题，与刷新按钮风格一致）
  - 添加工具栏容器的 flex 布局样式
  - _Requirements: 1.1_

- [x] 2. 实现搜索逻辑
  - [x] 2.1 添加 `allRepos` 缓存变量，修改 `loadRepos()` 将数据存入 `allRepos` 并调用 `renderCards(allRepos)`
    - _Requirements: 1.2, 1.3_
  - [x] 2.2 新增 `renderCards(repos)` 函数，渲染卡片到 `#app`；空数组时显示 `<div class="empty">无匹配仓库</div>`
    - _Requirements: 1.4_
  - [x] 2.3 新增 `handleSearch()` 函数，读取搜索框值进行大小写不敏感过滤，调用 `renderCards`；为搜索框添加 `keydown` 事件监听（回车触发）
    - _Requirements: 1.2, 1.3, 1.4_

- [x] 3. Checkpoint — 验证功能
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- 仅修改 `agent-support/kiro-dashboard/public/index.html` 一个文件
- 无后端改动，无新增依赖
- 搜索为大小写不敏感的 `String.includes` 匹配
