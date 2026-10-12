---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-12-mcp-private-metadata

[English](2026-10-12-mcp-private-metadata.md) | 中文

## 概述

在 PTC 子调度结果中保留可选的私有元数据。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-12-mcp-private-metadata
baseline: false
changes:
  - root: "event:tool/ptc-dispatch"
    previous: "2026-09-14-image-offload"
    after: "ca2a0c9a0e4172b1831dbb2747acd6adf620dbe2ea68960220c6279d066e24e6"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

新增 meta 字段为可选项，旧日志仍然有效；兼容性分类器不要求升级 Session 格式。该字段是私有展示数据，程序返回值、模型消息与授权行为保持不变。

<a id="verification"></a>
## 验证

三组 MCP 元数据风险测试验证真实 Native Session 结果日志与 PTC 子调度成功及失败日志、并发关联、拒绝和阻断调用，以及元数据不会进入模型请求或程序返回值。

<a id="dev-note"></a>
## 开发备注

无。
