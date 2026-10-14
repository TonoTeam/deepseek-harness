# Agent Note: MCP private result metadata

Status: implemented

English | [中文](2026-10-12-mcp-private-result-metadata.zh.md)

## Problem

MCP tool results discard standard `_meta` during canonical value conversion and error projection. Programs and models must not receive this private payload, but durable result consumers need it on successful and failed calls.

## Decision

The tools post-execute accept decision supports optional private `meta`. The MCP bridge snapshots validated JSON `_meta` into an exact-execution WeakMap, then attaches it as `meta.mcp` through that decision. The effect-scoped listener observes dispatches across scope changes, while the exact execution key prevents cross-call association. A policy block or pre-dispatch denial does not gain metadata. Native logs already retain `meta`; PTC sub-dispatch logs retain it through an optional compatible event field.

## Alternatives considered

Adding `_meta` to canonical values exposes it to PTC programs. Mutating readonly results depends on internal normalization identity. A content finalizer cannot author private metadata, and embedding the payload in text exposes it to models.

## Consequences

Successful canonical values, content and image projections remain unchanged. MCP `isError` still produces a failed native result. Metadata remains untrusted material and cannot authorize execution. Deployment must replace both the tools and MCP client artifacts from the same source revision. [Regression tests](../../../../packages/mcp/mcp-client/tests/private-metadata.spec.ts) cover concurrent correlation, denial and blocking, real Native and PTC Session logs, and exclusion from model requests and program values.
