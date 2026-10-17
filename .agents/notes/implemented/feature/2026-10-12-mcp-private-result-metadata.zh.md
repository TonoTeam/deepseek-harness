# Agent Note: MCP 私有结果元数据

Status: implemented

[English](2026-10-12-mcp-private-result-metadata.md) | 中文

## 问题

MCP 工具结果在转换规范返回值和错误展示时丢失标准 `_meta`。程序和模型不应收到这份私有载荷，但持久化结果的消费方需要成功及失败调用都保留它。

## 决定

工具 post-execute 的 accept 决策支持可选私有 `meta`。MCP 桥接将已验证的 JSON `_meta` 快照放进以精确调用对象为键的 WeakMap，再通过该决策附加到 `meta.mcp`。由插件生命周期管理的监听器观察跨作用域变更的调度，精确调用键防止跨调用错误关联。策略阻断和执行前拒绝不会获得元数据。Native 日志已经保留 `meta`；PTC 子调度日志通过兼容的可选事件字段保留它。

## 考虑过的替代方案

在规范返回值中加入 `_meta` 会暴露给 PTC 程序。修改只读结果依赖内部规范化对象身份。内容终结器不能生成私有元数据，在文本中嵌入载荷则会暴露给模型。

## 影响

成功时的规范返回值、内容和图片投影保持不变。MCP `isError` 仍然产生失败的 Native 结果。元数据仍是不可信材料，不能授权执行。部署必须替换同一源码版本构建的 tools 和 MCP client 两份产物。[回归测试](../../../../packages/mcp/mcp-client/tests/private-metadata.spec.ts)覆盖并发关联、拒绝与阻断、真实 Native 和 PTC Session 日志，以及模型请求和程序返回值不会收到元数据。
