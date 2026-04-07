# 语聊小精灵（Vue AI Chat）

一个面向简历展示与工程实践的前端 AI 聊天项目。  
基于 **Vue3 + TypeScript + Pinia + Vite**，接入 **智谱 AI（GLM）**，覆盖从模型调用到产品化交互的完整链路。

## 项目亮点

- 支持 **SSE 流式输出**：模型内容边生成边展示，响应体验更自然。
- 支持 **可中断生成**（AbortController）：发送过程中可随时停止。
- 支持 **失败重试机制**：包含自动重试、手动重试与退避信息展示。
- 支持 **多会话管理 + 本地持久化**：刷新后可恢复历史聊天。
- 支持 **Prompt 模板 / 自定义系统人设**：适配不同任务场景。
- 支持 **消息级交互**：引用回复、重新生成、编辑后重发。
- 支持 **消息多选与批量导出**：可导出 Markdown / JSON。
- 支持 **会话标签系统**：添加标签、按标题/标签过滤检索。
- 支持 **语音输入与语音播报**（Web Speech API）。
- 支持 **本地埋点统计**：请求数、耗时、重试率、最常用模型、平均轮次等。

## 技术栈

- Vue 3
- TypeScript
- Pinia
- Vue Router
- Vite
- Axios / Fetch
- vue-virtual-scroller
- Web Speech API

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

在项目根目录创建 `.env.local`：

```bash
VITE_ZHIPU_API_KEY=你的智谱APIKey
VITE_ZHIPU_MODEL=glm-4-flash
```

> 注意：`.env.local` 已被 `.gitignore` 忽略，请不要上传真实密钥。

### 3. 启动开发环境

```bash
npm run dev
```

### 4. 构建生产版本

```bash
npm run build
```

## 目录结构

```text
src/
  services/      # 模型 API 封装（流式请求、重试）
  stores/        # 业务状态管理（会话、消息、统计、导出等）
  views/         # 页面与交互
  types/         # TypeScript 类型定义
  style.css      # 全局样式
```

## 安全说明（必读）

- 请勿提交任何 `.env*` 文件到远端仓库。
- 若误提交过密钥，请立即在智谱平台重置 Key。
- 建议仅在本地 `.env.local` 保存密钥。

## 适合写进简历的能力点

- AI 接口接入与流式渲染
- 前端状态管理与复杂交互设计
- 可中断请求、重试与稳定性治理
- 列表性能优化与可观测性埋点
- 面向产品化场景的功能设计与实现
