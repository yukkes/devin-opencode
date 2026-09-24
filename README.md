# devin-opencode

An [OpenCode](https://opencode.ai/) plugin that connects your [Devin](https://devin.ai) account and lets the OpenCode agent drive cloud Devin sessions. Works with both **OpenCode v1** (stable) and **OpenCode v2** (current).

## What it does

- Adds 6 tools the OpenCode agent can call to manage cloud Devin sessions
- Registers the Cognition/Windsurf models as `devin/...` entries in `/models` when a token is available
- Signs in to Windsurf/Cognition from the TUI (`/connect` → **Windsurf (Cognition)**) for the models
- Uses a `DEVIN_API_KEY` environment variable for the session tools (`/connect` does not ask for it)
- Uses the Devin v3 API with `cog_` service user keys (also supports legacy `apk_`/`apk_user_` keys via v1 fallback)

| Tool | Purpose |
| --- | --- |
| `devin_status` | Check if Devin is connected and report auth source |
| `devin_create_session` | Hand off a task to a cloud Devin session |
| `devin_list_sessions` | List recent sessions with status |
| `devin_get_session` | Fetch session details and message history |
| `devin_send_message` | Send a follow-up message to a session |
| `devin_terminate_session` | Stop a running session |

## Quick start

### 1. Get a Devin API key

1. Go to **Settings > Service users** in the Devin app and create a service user with a role that has `UseDevinSessions` and `ViewOrgSessions` permissions
2. Generate an API key — it starts with `cog_`
3. Find your **organization ID** on the same page (starts with `org-`)

> Legacy `apk_` and `apk_user_` keys still work but are deprecated. The plugin automatically uses v1 endpoints for them.

### 2. Install the plugin

Install straight from GitHub (OpenCode v2):

```sh
opencode plugin add github:yukkes/devin-opencode
```

Or add it to `opencode.jsonc` yourself:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["github:yukkes/devin-opencode"]
}
```

<details>
<summary>OpenCode v1 (stable)</summary>

OpenCode v1 uses the singular `plugin` field and the legacy entrypoint. Clone the repository and reference the file directly:

```json
// opencode.json
{
  "plugin": ["./devin-opencode/src/legacy.ts"]
}
```

</details>

### 3. Sign in

Sign in to Windsurf/Cognition from the TUI to enable the `devin/...` models:

```text
/connect
```

Select **Windsurf (Cognition)** and choose **Sign in with Windsurf**. A browser opens, you sign in, and the token is captured automatically. The equivalent CLI command is:

```sh
npx opencode-windsurf-auth login
```

The Devin API key is only needed for the cloud session tools (`devin_*`), and is optional. It is not requested by `/connect`; set it as an environment variable if you use those tools:

```sh
export DEVIN_API_KEY=cog_your_key_here
export DEVIN_ORG_ID=org-your_org_id_here
```

`DEVIN_ORG_ID` is optional — if not set, the plugin auto-discovers it from `~/.config/devin/config.json` or the `/v3/organizations` API.

### 4. Use it

Ask the OpenCode agent:

> Use devin_create_session to create a Devin session that refactors my auth module

## Models

`devin/...` entries in `/models` (SWE-2, Claude, GPT-6, Gemini, GLM, Kimi, and more) stream from Cognition's Windsurf server. They need a Windsurf/Cognition token, resolved in this order:

1. `DEVIN_LLM_API_KEY`
2. `/connect` → **Windsurf (Cognition)** (browser sign-in)
3. `~/.config/opencode-windsurf-auth/credentials.json` (from `npx opencode-windsurf-auth login`)
4. `~/.pi/agent/auth.json`
5. `~/.local/share/devin/credentials.toml` (Devin CLI, fallback)

The Devin CLI is not required.

| Variable | Required | Description |
| --- | --- | --- |
| `DEVIN_LLM_API_KEY` | No | Windsurf/Cognition `devin-session-token$...` token for the `devin/...` models. |
| `DEVIN_LLM_BASE_URL` | No | API host for the models. Defaults to the host stored with the token, then `https://server.codeium.com`. |

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `DEVIN_API_KEY` | No | Your Devin API key (`cog_...`, `apk_...`, or `apk_user_...`). Only needed for the cloud session tools (`devin_*`); set it as an environment variable. `/connect` does not ask for it. |
| `DEVIN_ORG_ID` | No | Your Devin organization ID (`org-...`). If not set, the plugin auto-discovers it from the Devin CLI config (`~/.config/devin/config.json`) or the `/v3/organizations` API. |

## Install methods

### From GitHub (recommended)

```sh
opencode plugin add github:yukkes/devin-opencode
```

### From a local checkout

```sh
git clone https://github.com/yukkes/devin-opencode.git
cd devin-opencode
npm install
```

Then reference the entrypoint directly:

**v2:** `"plugins": ["./devin-opencode/src/index.ts"]`
**v1:** `"plugin": ["./devin-opencode/src/legacy.ts"]`

## Differences between v1 and v2

| Feature | OpenCode v1 (stable) | OpenCode v2 (current) |
| --- | --- | --- |
| Entrypoint | `src/legacy.ts` | `src/index.ts` |
| Config field | `"plugin"` (singular) | `"plugins"` (plural) |
| Auth | `/connect` or `DEVIN_API_KEY` | `/connect` or `DEVIN_API_KEY` |

## Configuration options (v2 only)

```jsonc
{
  "plugins": [
    {
      "package": "github:yukkes/devin-opencode",
      "options": { "integrationId": "devin" }
    }
  ]
}
```

| Option | Default | Description |
| --- | --- | --- |
| `integrationId` | `"devin"` | Override the integration ID (e.g. for multiple Devin accounts). |

## API versioning

The plugin uses the **Devin v3 API** (`/v3/organizations/{org_id}/sessions`) for `cog_` service user keys, which is the current recommended API. For legacy `apk_`/`apk_user_` keys, it automatically falls back to the deprecated v1 API (`/v1/sessions`).

| Key type | API version | Status |
| --- | --- | --- |
| `cog_` (service user) | v3 | Current, recommended |
| `apk_user_` (personal) | v1 (fallback) | Deprecated |
| `apk_` (service) | v1 (fallback) | Deprecated |

## Project layout

```
src/
  index.ts    # v2 plugin entrypoint (Plugin.define + integration system)
  legacy.ts   # v1 plugin entrypoint (hooks + auth + tool helper) — default export
  devin.ts    # shared typed Devin REST API client (v3 + v1 fallback)
examples/
  opencode.v2.jsonc  # example config for OpenCode v2
  opencode.v1.json   # example config for OpenCode v1
```

## License

MIT
