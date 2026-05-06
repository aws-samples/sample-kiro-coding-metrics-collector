# 需求文档

## 简介

在 kiro-dashboard 页面中增加一个搜索框，用户输入关键词后点击搜索（或按回车），筛选出名称匹配的仓库卡片。

## 术语表

- **Dashboard**: kiro-dashboard 的 Web 前端页面，展示所有仓库的统计概览卡片
- **Search_Box**: 文本输入框，用于输入仓库名称关键词

## 需求

### 需求 1：搜索框与过滤

**用户故事：** 作为一名开发者，我希望通过搜索框按名称筛选仓库卡片。

#### 验收标准

1. THE Dashboard SHALL 在刷新按钮旁展示一个搜索输入框，占位文本为"搜索仓库..."
2. WHEN 用户输入关键词并按回车时，THE Dashboard SHALL 仅展示名称包含该关键词的仓库卡片（大小写不敏感）
3. WHEN 搜索框为空并按回车时，THE Dashboard SHALL 展示所有仓库卡片
4. WHEN 无匹配结果时，THE Dashboard SHALL 展示"无匹配仓库"提示
