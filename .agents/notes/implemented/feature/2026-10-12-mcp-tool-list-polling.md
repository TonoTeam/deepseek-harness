# Agent Note: MCP tool-list polling

Status: implemented

English | [中文](2026-10-12-mcp-tool-list-polling.zh.md)

## Problem

Stateless HTTP MCP endpoints cannot notify connected agents when an account connects a computer or changes its permissions. Reconnecting to refresh a directory can interrupt ongoing tool calls.

## Decision

The MCP client accepts optional `toolListRefreshMs` for stateless servers that cannot send directory notifications. Zero keeps the notification-only behavior. A positive interval polls the existing connected client through the same synchronization queue as notifications. Each interval begins after its preceding request settles, avoiding an accumulating timer queue. Discovery failures retain the previous registry generation; authorization remains the remote executor's responsibility on each tool call.

## Consequences

Polling stops when the connection generation goes down or the plugin disposes. A recovered connection restarts polling after initial discovery succeeds. Updating a catalog does not close the transport or cancel ongoing calls. [Polling tests](../../../../packages/mcp/mcp-client/tests/polling.spec.ts) cover optional startup recovery, directory addition and removal, discovery failure, serialization, ongoing calls, and disposal.

## Alternatives considered

Reloading the plugin closes the transport and risks cancelling long calls. A product-owned duplicate bridge would repeat tool translation and connection management. Polling the existing bridge reuses its serialized discovery and disposal.
