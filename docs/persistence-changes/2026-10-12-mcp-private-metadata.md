---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-12-mcp-private-metadata

English | [中文](2026-10-12-mcp-private-metadata.zh.md)

## Summary

Preserve optional private metadata on PTC sub-dispatch results.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

The added meta field is optional. Existing logs without it remain valid, and the compatibility classifier requires no Session format bump. The field is private presentation data; program values, model messages and authorization are unchanged.

<a id="verification"></a>
## Verification

Three MCP metadata risk groups exercise real Native Session result logs and PTC child success/error logs, concurrent correlation, blocked/denied calls, and absence of metadata from model requests and program values.

<a id="dev-note"></a>
## Dev Note

None.
