---
description: "Operate Chromium through Chrome DevTools MCP with separate browser state for each live Session."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-browser-use-chrome-devtools-mcp

English | [中文](README.zh.md)

## Summary

Use Chrome DevTools MCP to inspect pages and operate Chromium through its upstream tools. The provider makes a Session's upstream catalogue available before creation or resume completes and retains its serving connection across turns. Launch a separate browser or attach one Session to an existing browser with its current tabs and login state. Launch mode can opt into starting the serving process on the Session's first browser call. This published experimental package activates only when explicitly mounted.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount both entries before creating or resuming a Session, in a profile composition that supplies Agents, tools, system prompts, and the working-directory service. Loading or reloading this provider does not adopt Sessions that are already active. Browser installation follows the upstream runtime; select an existing Chromium installation with `executablePath`.

```yaml
- name: '@deepseek-ai/dsh-browser-use'
- name: '@deepseek-ai/dsh-experimental-browser-use-chrome-devtools-mcp'
  config:
    mode: launch
    headless: true
```

Use `mode: attach` and set `endpoint` to an HTTP(S) debugging URL or WS(S) browser endpoint to operate an existing browser. The new live Session claims the attachment during initialization and retains it until unloading. If the attachment is busy, that activation continues without this browser and does not retry on later turns. After release, a newly created or resumed activation can acquire it. Direct calls from another Session fail. Cleanup disconnects and leaves the external browser and its pages running.

Launch mode also accepts `startup: on-demand`. The provider then runs one transient metadata process with only the pinned CLI and usage-statistics setting, registers the discovered catalogue and instructions for each future Session, and starts that Session's own Chrome DevTools process on its first browser tool or resource call; later turns reuse it. The metadata process never calls a browser tool and does not create a profile. `mode: attach` requires eager startup and rejects `startup: on-demand`.

| Field | Default | Meaning |
|---|---|---|
| `mode` | required | `launch` or `attach`, fixed for this provider activation |
| `startup` | `eager` | Launch mode: start the server during creation (`eager`) or on the first browser call (`on-demand`); attachment requires `eager` |
| `headless` | `true` | Launch without a visible window |
| `executablePath` | upstream discovery | Chromium executable for launch |
| `endpoint` | required for attach | Existing browser debugging endpoint |
| `toolCallTimeoutMs` | MCP client default | Per-call timeout in milliseconds |

The [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-browser-use-chrome-devtools-mcp) lists accepted fields. The profile or preset selects the browser mode.

When configuring the system prompt's `toolOrder` for the whole process, leave browser tools under `<unlisted-tools>`. Explicitly listing browser tool names can make prompt assembly fail for Sessions without a browser connection.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The provider resolves its pinned npm entry and starts it under the current Node executable. SDK version negotiation may run a temporary probe before a serving process; on-demand startup additionally runs one metadata-only process whose catalogue is registered before model requests. The [shared runtime](../browser-use-runtime/README.md) owns awaited Agent initialization, per-Session serialization, and cleanup; the [MCP client](../../mcp/mcp-client/README.md) owns result projection, while the runtime reuses its public tool-definition and server-context exports over the SDK stdio transport.

Browser state survives turns while its live Session remains attached. The MCP server starts in the Session's validated current working directory and retains that launch directory after later Session directory changes. Disposal waits for server shutdown before releasing resources. Resume after reload starts fresh browser runtime state; stored conversation history does not restore cookies or pages.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Browser use](../../../docs/subsystems/browser-use.md) — provider selection and Session ownership.
- [Browser-use service](../../browser-use/browser-use/README.md) — exclusive provider registration.
- [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) — upstream installation and browser behavior.

-----

<a id="model-experience"></a>
## Model Experience

### Browser tools and screenshots

#### What the model sees

Tools retain upstream descriptions and JSON schemas under `mcp__chrome-devtools-mcp__<tool>` names. Text and screenshots use the normal tool-result pipeline and Session log. Screenshots require an attachment store and an image-capable model route; other routes receive the MCP image diagnostic. The MCP client also exposes resource helpers and attributed server instructions. Browser instructions are shown only after this Session owns a connection; targeted resource requests enforce the same ownership.

#### Token effect

The catalog, resource helpers, and server instructions add tool definitions and prompt text. Calls add arguments, text, and admitted images to Session history. Inline image bytes stay outside model-visible history.

#### KV Cache effect

An unchanged catalog preserves its tool-definition prefix. Results append to history; provider or catalog changes can reduce prefix reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The integration retains the pinned server's browser and tool restrictions.

- Chromium only; Firefox and WebKit are not selectable.
- Startup failure or cancellation rejects Session creation or resume and triggers client cleanup. With on-demand startup, a failed first browser call reports the error without retrying; a disconnected or drifted serving process is not replaced. After fixing the cause, create a new Session or unload and resume the existing one.
- Attachment exclusivity is local to this provider instance. Other processes and browser users can still modify the same pages.
- The shared resource-server inventory can show inherited server names; it does not grant access to another Session's browser.
- Cancellation does not undo navigation, clicks, or other actions already delivered to the browser.
- Tool schemas follow the pinned experimental dependency and carry no DSH stability promise.
- Usage statistics are disabled. Other features, including performance tools, retain their upstream behavior.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
