import { Plugin, Model, Provider } from "@opencode-ai/plugin/v2"
import { createDevin, getCachedCatalog, type ModelCatalogEntry } from "ai-sdk-devin"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Devin, DevinApiError, resolveOrgId } from "./devin.js"

const INTEGRATION_ID = "devin"
const ENV_VAR = "DEVIN_API_KEY"
const LLM_ENV_VAR = "DEVIN_LLM_API_KEY"
const LLM_BASE_URL_ENV_VAR = "DEVIN_LLM_BASE_URL"
/** Runtime package that streams Cognition/Windsurf LLM models. */
const LLM_PACKAGE = "ai-sdk-devin"
const DEFAULT_LLM_HOST = "https://server.codeium.com"

interface LlmAuth {
  token: string
  host: string
}

/**
 * Resolve the Windsurf/Cognition OAuth token and host used for LLM streaming.
 * Unlike the session tools, this is not a Devin API key (`cog_...`): it is a
 * `devin-session-token$...` token minted by Windsurf login. The host differs per
 * account (e.g. `server.self-serve.windsurf.com`), so it is read alongside the
 * token.
 */
function resolveLlm(): LlmAuth | undefined {
  const env = process.env[LLM_ENV_VAR]
  if (env) return { token: env, host: process.env[LLM_BASE_URL_ENV_VAR] ?? DEFAULT_LLM_HOST }

  // Devin CLI credentials (~/.local/share/devin/credentials.toml).
  try {
    const toml = fs.readFileSync(path.join(os.homedir(), ".local", "share", "devin", "credentials.toml"), "utf8")
    const token = /windsurf_api_key\s*=\s*"([^"]+)"/.exec(toml)?.[1]
    const host = /api_server_url\s*=\s*"([^"]+)"/.exec(toml)?.[1]
    if (token?.startsWith("devin-session-token$")) return { token, host: host ?? DEFAULT_LLM_HOST }
  } catch {
    // fall through
  }

  try {
    const auth = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "auth.json"), "utf8"))
    const token = auth?.devin?.access
    if (typeof token === "string" && token.startsWith("devin-session-token$")) {
      return { token, host: DEFAULT_LLM_HOST }
    }
  } catch {
    // fall through
  }

  try {
    const creds = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), ".config", "opencode-windsurf-auth", "credentials.json"), "utf8"),
    )
    if (typeof creds?.apiKey === "string" && creds.apiKey.startsWith("devin-session-token$")) {
      return { token: creds.apiKey, host: creds.apiServerUrl ?? DEFAULT_LLM_HOST }
    }
  } catch {
    // fall through
  }

  return undefined
}

/** Build an OpenCode model entry from a Cognition catalog entry. */
function buildLlmModel(entry: ModelCatalogEntry): Model.Info {
  const base = Model.Info.empty(Provider.ID.make(INTEGRATION_ID), Model.ID.make(entry.modelUid))
  return {
    ...base,
    name: entry.label,
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    time: { released: Date.now() },
    cost: [
      {
        input: (entry.pricing?.input ?? 0) as never,
        output: (entry.pricing?.output ?? 0) as never,
        cache: { read: (entry.pricing?.cachedInput ?? 0) as never, write: 0 as never },
      },
    ],
    status: "active",
    enabled: true,
    limit: { context: entry.contextWindow || 256_000, output: 128_000 },
  }
}

/** Cached org_id for v3 API calls. */
let cachedOrgId: string | undefined

export interface DevinPluginOptions {
  /**
   * Override the integration ID. Defaults to "devin". Change this only if you
   * need multiple Devin accounts side by side.
   */
  integrationId?: string
}

/**
 * Resolve the active Devin API key from the OpenCode integration connection,
 * falling back to the DEVIN_API_KEY environment variable when no credential has
 * been stored via /connect.
 */
async function resolveApiKey(
  ctx: Parameters<NonNullable<Parameters<typeof Plugin.define>[0]["setup"]>>[0],
  integrationId: string,
): Promise<string | undefined> {
  try {
    const connection = await ctx.integration.connection.active(integrationId)
    if (connection) {
      const value = await ctx.integration.connection.resolve(connection)
      if (value?.type === "key" && value.key) return value.key
      if (value?.type === "oauth" && value.access) return value.access
    }
  } catch {
    // fall through to env lookup
  }
  return process.env[ENV_VAR]
}

function requireApiKey(apiKey: string | undefined): string {
  if (!apiKey) {
    throw new DevinApiError(
      "Devin is not connected. Run /connect in the OpenCode TUI and choose Devin, or set the DEVIN_API_KEY environment variable.",
      401,
      undefined,
    )
  }
  return apiKey
}

/** Ensure we have an org_id (needed for v3 API with cog_ keys). */
async function ensureOrgId(apiKey: string): Promise<string> {
  if (cachedOrgId) return cachedOrgId
  const orgId = await resolveOrgId(apiKey)
  if (!orgId) {
    throw new DevinApiError(
      "Could not determine your Devin organization ID. Set DEVIN_ORG_ID env var.",
      401,
      undefined,
    )
  }
  cachedOrgId = orgId
  return orgId
}

function summarizeError(error: unknown): { message: string; status?: number } {
  if (error instanceof DevinApiError) return { message: error.message, status: error.status }
  if (error instanceof Error) return { message: error.message }
  return { message: "Unknown error" }
}

/** Build a typed text content part for tool outputs. */
function textPart(text: string): { type: "text"; text: string } {
  return { type: "text", text }
}

/** A compact, model-friendly text rendering of a session summary. */
function renderSession(s: {
  session_id: string
  status: string
  status_enum?: string | null
  title?: string | null
  url?: string
  created_at?: string | number
  updated_at?: string | number
}): string {
  const title = s.title ? s.title : "untitled"
  const status = s.status_enum ?? s.status
  return `- ${s.session_id} | ${title} | ${status}`
}

export default Plugin.define({
  id: "devin.opencode",
  setup: async (ctx) => {
    const options = (ctx.options ?? {}) as DevinPluginOptions
    const integrationId = options.integrationId ?? INTEGRATION_ID

    // Register the Devin integration so users can connect via /connect or by
    // setting DEVIN_API_KEY. Two auth methods: an API key (stored credential)
    // and an environment-variable connection.
    await ctx.integration.transform((draft) => {
      draft.update(integrationId, (integration) => {
        integration.name = "Devin"
      })
      draft.method.update({
        integrationID: integrationId,
        method: { type: "key", label: "Devin API key" },
      })
      draft.method.update({
        integrationID: integrationId,
        method: { type: "env", names: [ENV_VAR] },
      })
    })

    const getApiKey = () => resolveApiKey(ctx, integrationId)

    // Register the Cognition/Windsurf LLM provider (the `devin/...` models in
    // /models) when a `devin-session-token$...` token is available. The session
    // tools work with just DEVIN_API_KEY; the models additionally need this.
    const llm = resolveLlm()
    if (llm) {
      const catalog = await getCachedCatalog(llm.token, llm.host)
      const models = catalog
        ? Array.from(catalog.byUid.values())
            .filter((entry) => !entry.disabled)
            .map(buildLlmModel)
        : []
      if (models.length > 0) {
        await (ctx as any).provider.transform((editor: any) => {
          editor.add({
            info: {
              ...Provider.Info.empty(Provider.ID.make(INTEGRATION_ID)),
              name: "Devin (Cognition)",
              activation: "enabled",
              package: LLM_PACKAGE,
              settings: { apiKey: llm.token, baseURL: llm.host },
            },
            models,
          })
        })
        // ai-sdk-devin is not an OpenCode runtime package, so hand OpenCode an
        // SDK instance for it; OpenCode then calls sdk.languageModel(modelID).
        //
        // ai-sdk-devin implements AI SDK v3 but emits `finishReason` as a bare
        // string; v3 requires `{ unified, raw }`. Normalize it in flight so
        // OpenCode's finish-reason schema validates.
        await ctx.aisdk.hook("sdk", (event: any) => {
          if (event.package !== LLM_PACKAGE) return
          const apiKey = (event.options?.apiKey as string | undefined) ?? llm.token
          if (!apiKey) return
          const provider = createDevin({ apiKey, baseURL: llm.host })
          const normalizeFinish = (stream: ReadableStream<any>) =>
            stream.pipeThrough(
              new TransformStream({
                transform(part: any, controller) {
                  if (part?.type === "finish" && typeof part.finishReason === "string") {
                    controller.enqueue({
                      ...part,
                      finishReason: { unified: part.finishReason, raw: part.finishReason },
                    })
                  } else {
                    controller.enqueue(part)
                  }
                },
              }),
            )
          event.sdk = {
            languageModel(modelId: string) {
              const model = provider.languageModel(modelId)
              return {
                ...model,
                doStream: async (opts: any) => {
                  const result = await model.doStream(opts)
                  return { ...result, stream: normalizeFinish(result.stream) }
                },
              }
            },
          }
        })
      }
    }

    await ctx.tool.transform((tools) => {
      // --- devin_status -----------------------------------------------------
      tools.add({
        name: "devin_status",
        description:
          "Check whether a Devin account is connected to OpenCode and report the active authentication source. Takes no input.",
        jsonSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        execute: async () => {
          const apiKey = await getApiKey()
          const connection = await ctx.integration.connection
            .active(integrationId)
            .catch(() => undefined)
          const source = connection?.type === "credential"
            ? "stored credential"
            : connection?.type === "env"
              ? `environment variable (${ENV_VAR})`
              : apiKey
                ? `environment variable (${ENV_VAR})`
                : "not connected"
          const text =
            source === "not connected"
              ? "Devin is not connected. Run /connect and choose Devin, or set DEVIN_API_KEY."
              : `Devin is connected via ${source}.`
          return {
            structured: { connected: source !== "not connected", source },
            content: [textPart(text)],
          }
        },
      })

      // --- devin_create_session --------------------------------------------
      tools.add({
        name: "devin_create_session",
        description:
          "Create a new cloud Devin session with a task prompt and return its session_id and URL. Use this to hand off a self-contained task to Devin. Optionally provide a title, playbook_id, tags, and unlisted flag.",
        jsonSchema: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description: "The task description for Devin to work on.",
            },
            title: { type: "string", description: "Optional custom session title." },
            playbook_id: {
              type: "string",
              description: "Optional playbook ID to run.",
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Optional tags to attach to the session (max 50).",
            },
            unlisted: {
              type: "boolean",
              description: "If true, the session is not listed in the default session list.",
            },
          },
          required: ["prompt"],
          additionalProperties: false,
        },
        execute: async (input) => {
          const args = input as {
            prompt: string
            title?: string
            playbook_id?: string
            tags?: string[]
            unlisted?: boolean
          }
          const apiKey = requireApiKey(await getApiKey())
          try {
            const orgId = await ensureOrgId(apiKey)
            const session = await Devin.createSession(apiKey, orgId, {
              prompt: args.prompt,
              title: args.title,
              playbook_id: args.playbook_id,
              tags: args.tags,
              unlisted: args.unlisted,
            })
            const text = `Created Devin session ${session.session_id}\nURL: ${session.url}`
            return {
              structured: session,
              content: [textPart(text)],
            }
          } catch (error) {
            const { message, status } = summarizeError(error)
            return {
              structured: { ok: false, error: message, status },
              content: [textPart(`Failed to create Devin session: ${message}`)],
            }
          }
        },
      })

      // --- devin_list_sessions ---------------------------------------------
      tools.add({
        name: "devin_list_sessions",
        description:
          "List recent Devin sessions for the connected account. Returns session_id, title, and status for each. Supports optional limit (default 20), offset, and tag filters.",
        jsonSchema: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
            offset: { type: "integer", minimum: 0, default: 0 },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Only return sessions with these tags.",
            },
          },
          additionalProperties: false,
        },
        execute: async (input) => {
          const args = (input ?? {}) as {
            limit?: number
            offset?: number
            tags?: string[]
          }
          const apiKey = requireApiKey(await getApiKey())
          try {
            const orgId = await ensureOrgId(apiKey)
            const result = await Devin.listSessions(apiKey, orgId, {
              limit: args.limit ?? 20,
              offset: args.offset ?? 0,
              tags: args.tags,
            })
            const lines = result.sessions.map(renderSession)
            const text =
              lines.length > 0
                ? `Devin sessions (${result.sessions.length}):\n${lines.join("\n")}`
                : "No Devin sessions found."
            return {
              structured: result,
              content: [textPart(text)],
            }
          } catch (error) {
            const { message, status } = summarizeError(error)
            return {
              structured: { ok: false, error: message, status },
              content: [textPart(`Failed to list Devin sessions: ${message}`)],
            }
          }
        },
      })

      // --- devin_get_session -----------------------------------------------
      tools.add({
        name: "devin_get_session",
        description:
          "Retrieve details about an existing Devin session: status, metadata, and the full message history. Provide a session_id.",
        jsonSchema: {
          type: "object",
          properties: {
            session_id: { type: "string", description: "The Devin session ID." },
          },
          required: ["session_id"],
          additionalProperties: false,
        },
        execute: async (input) => {
          const args = input as { session_id: string }
          const apiKey = requireApiKey(await getApiKey())
          try {
            const orgId = await ensureOrgId(apiKey)
            const session = await Devin.getSession(apiKey, orgId, args.session_id)
            const messageLines = (session.messages ?? []).map(
              (m) => `[${m.timestamp}] ${m.type}: ${m.message}`,
            )
            const header = renderSession(session)
            const text =
              `${header}\n` +
              (messageLines.length > 0
                ? `\nMessages:\n${messageLines.join("\n")}`
                : "\nNo messages yet.")
            return {
              structured: session,
              content: [textPart(text)],
            }
          } catch (error) {
            const { message, status } = summarizeError(error)
            return {
              structured: { ok: false, error: message, status },
              content: [textPart(`Failed to get Devin session: ${message}`)],
            }
          }
        },
      })

      // --- devin_send_message ----------------------------------------------
      tools.add({
        name: "devin_send_message",
        description:
          "Send a message to an active Devin session to provide additional instructions or context. The session must be in a running state.",
        jsonSchema: {
          type: "object",
          properties: {
            session_id: { type: "string", description: "The Devin session ID." },
            message: { type: "string", description: "The message to send to Devin." },
          },
          required: ["session_id", "message"],
          additionalProperties: false,
        },
        execute: async (input) => {
          const args = input as { session_id: string; message: string }
          const apiKey = requireApiKey(await getApiKey())
          try {
            const orgId = await ensureOrgId(apiKey)
            const result = await Devin.sendMessage(apiKey, orgId, args.session_id, args.message)
            const detail = result?.detail
            const text = detail
              ? `Message sent to Devin session ${args.session_id} (${detail}).`
              : `Message sent to Devin session ${args.session_id}.`
            return {
              structured: { ok: true, session_id: args.session_id, detail: detail ?? null },
              content: [textPart(text)],
            }
          } catch (error) {
            const { message, status } = summarizeError(error)
            return {
              structured: { ok: false, error: message, status },
              content: [textPart(`Failed to send message: ${message}`)],
            }
          }
        },
      })

      // --- devin_terminate_session -----------------------------------------
      tools.add({
        name: "devin_terminate_session",
        description:
          "Terminate an active Devin session. Once terminated, the session cannot be resumed. Use only when the task is done or should be stopped.",
        jsonSchema: {
          type: "object",
          properties: {
            session_id: { type: "string", description: "The Devin session ID to terminate." },
          },
          required: ["session_id"],
          additionalProperties: false,
        },
        execute: async (input) => {
          const args = input as { session_id: string }
          const apiKey = requireApiKey(await getApiKey())
          try {
            const orgId = await ensureOrgId(apiKey)
            const result = await Devin.terminateSession(apiKey, orgId, args.session_id)
            return {
              structured: { ok: true, session_id: args.session_id, detail: result.detail },
              content: [
                textPart(`Terminated Devin session ${args.session_id}: ${result.detail}`),
              ],
            }
          } catch (error) {
            const { message, status } = summarizeError(error)
            return {
              structured: { ok: false, error: message, status },
              content: [textPart(`Failed to terminate session: ${message}`)],
            }
          }
        },
      })
    })
  },
})
