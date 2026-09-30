import { Plugin, Model, Provider } from "@opencode/plugin"
import { createDevin, getCachedCatalog, type ModelCatalogEntry } from "ai-sdk-devin"
import * as crypto from "node:crypto"
import * as http from "node:http"
import { Devin, DevinApiError, resolveOrgId } from "./devin.js"

const INTEGRATION_ID = "devin"
const ENV_VAR = "DEVIN_API_KEY"
const WINDSURF_OAUTH_CLIENT_ID = "3GUryQ7ldAeKEuD2obYnppsnmj58eP5u"
const WINDSURF_SIGNIN_URL = "https://windsurf.com/windsurf/signin"
const WINDSURF_REGISTER_URL = "https://register.windsurf.com"
/** AI SDK provider for the Cognition models; `aisdk:` marks it as one for OpenCode. */
const LLM_PACKAGE = "aisdk:ai-sdk-devin"
const DEFAULT_LLM_HOST = "https://server.codeium.com"

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
    }
  } catch {
    // fall through to env lookup
  }
  return process.env[ENV_VAR]
}

function requireApiKey(apiKey: string | undefined): string {
  if (!apiKey) {
    throw new DevinApiError(
      "Devin is not connected. Set the DEVIN_API_KEY environment variable.",
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

/**
 * Read the `devin-session-token$...` token and API host stored by the /connect
 * sign-in. The models need this token; a Devin API key (`cog_...`) does not work.
 */
async function resolveLlm(ctx: any, integrationId: string) {
  try {
    const connection = await ctx.integration.connection.active(integrationId)
    const value = connection ? await ctx.integration.connection.resolve(connection) : undefined
    if (value?.type === "oauth" && value.access?.startsWith("devin-session-token$")) {
      return { token: value.access as string, host: (value.metadata?.apiServerUrl as string) ?? DEFAULT_LLM_HOST }
    }
  } catch {
    // not signed in
  }
  return undefined
}

/** Build an OpenCode model entry from a Cognition catalog entry. */
function buildLlmModel(entry: ModelCatalogEntry): Model.Info {
  return {
    ...Model.Info.default(Provider.ID.make(INTEGRATION_ID), Model.ID.make(entry.modelUid)),
    name: entry.label,
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
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

/**
 * Sign in to Windsurf/Cognition in the browser: a loopback listener captures the
 * token, which is exchanged for a long-lived `devin-session-token$...` key.
 */
async function signIn(): Promise<{ url: string; credential: Promise<any> }> {
  let resolveToken: (token: string) => void = () => {}
  let rejectToken: (error: Error) => void = () => {}
  const token = new Promise<string>((resolve, reject) => {
    resolveToken = resolve
    rejectToken = reject
  })
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    const value = url.searchParams.get("firebase_id_token") ?? url.searchParams.get("access_token")
    res.writeHead(200, { "Content-Type": "text/html" })
    if (value) {
      res.end("<html><body>Signed in. You can close this tab and return to OpenCode.</body></html>")
      resolveToken(value)
    } else {
      // The token arrives in the URL fragment; bounce it to the query string.
      res.end("<html><body><script>var h=location.hash.slice(1);if(h)location.replace('/auth?'+h)</script></body></html>")
    }
  })
  server.on("error", rejectToken)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const params = new URLSearchParams({
    response_type: "token",
    client_id: WINDSURF_OAUTH_CLIENT_ID,
    redirect_uri: `http://127.0.0.1:${(server.address() as { port: number }).port}/auth`,
    state: crypto.randomUUID(),
    prompt: "login",
    redirect_parameters_type: "query",
  })
  const credential = token
    .finally(() => server.close())
    .then(async (firebaseIdToken) => {
      const res = await fetch(`${WINDSURF_REGISTER_URL}/exa.seat_management_pb.SeatManagementService/RegisterUser`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Connect-Protocol-Version": "1" },
        body: JSON.stringify({ firebase_id_token: firebaseIdToken }),
      })
      const body = (await res.json()) as { api_key?: string; name?: string; api_server_url?: string }
      if (!res.ok || !body.api_key) throw new Error(`Windsurf sign-in failed (${res.status})`)
      return {
        type: "oauth",
        methodID: "oauth",
        refresh: "",
        access: body.api_key,
        expires: Math.floor(Date.now() / 1000) + 10 * 365 * 24 * 60 * 60,
        metadata: { apiServerUrl: body.api_server_url || DEFAULT_LLM_HOST, name: body.name ?? "" },
      }
    })
  return { url: `${WINDSURF_SIGNIN_URL}?${params}`, credential }
}

export default Plugin.define({
  id: "devin.opencode",
  setup: async (ctx) => {
    const options = (ctx.options ?? {}) as DevinPluginOptions
    const integrationId = options.integrationId ?? INTEGRATION_ID

    // Register the Devin integration so users can sign in via /connect for the
    // `devin/...` models. The session tools read DEVIN_API_KEY.
    await ctx.integration.transform((draft) => {
      draft.update(integrationId, (integration) => {
        integration.name = "Devin"
      })
      draft.method.update({
        integrationID: integrationId,
        method: { id: "oauth", type: "oauth", label: "Sign in" },
        authorize: async () => {
          const login = await signIn()
          return {
            mode: "auto",
            url: login.url,
            instructions: "Sign in with your Windsurf/Cognition account in the browser.",
            callback: login.credential,
          } as any
        },
      })
    })

    const getApiKey = () => resolveApiKey(ctx, integrationId)

    // Register the `devin/...` models once signed in.
    const llm = await resolveLlm(ctx, integrationId)
    const catalog = llm ? await getCachedCatalog(llm.token, llm.host) : undefined
    if (llm && catalog) {
      await (ctx as any).provider.transform((editor: any) => {
        editor.add({
          info: {
            ...Provider.Info.empty(Provider.ID.make(INTEGRATION_ID)),
            // Tie the provider to the Devin sign-in so the TUI lists its models.
            integrationID: integrationId,
            name: "Devin",
            activation: "enabled",
            package: LLM_PACKAGE,
            settings: { apiKey: llm.token, baseURL: llm.host },
          },
          models: Array.from(catalog.byUid.values())
            .filter((entry) => !entry.disabled)
            .map(buildLlmModel),
        })
      })
      // OpenCode has no runtime for ai-sdk-devin, so hand it the SDK instance.
      // ai-sdk-devin emits `finishReason` as a bare string; AI SDK v3 expects
      // `{ unified, raw }`, so normalize it in flight.
      await ctx.aisdk.hook("sdk", (event: any) => {
        if (event.package !== LLM_PACKAGE.replace(/^aisdk:/, "")) return
        const provider = createDevin({ apiKey: llm.token, baseURL: llm.host })
        event.sdk = {
          languageModel(modelId: string) {
            const model = provider.languageModel(modelId)
            return {
              ...model,
              doStream: async (opts: any) => {
                const result = await model.doStream(opts)
                const stream = result.stream.pipeThrough(
                  new TransformStream<any, any>({
                    transform(part, controller) {
                      if (part?.type === "finish" && typeof part.finishReason === "string") {
                        part = { ...part, finishReason: { unified: part.finishReason, raw: part.finishReason } }
                      }
                      controller.enqueue(part)
                    },
                  }),
                )
                return { ...result, stream }
              },
            }
          },
        }
      })
    }

    await ctx.tool.transform((tools) => {
      // --- devin_status -----------------------------------------------------
      tools.add({
        name: "devin_status",
        description:
          "Check whether a Devin account is connected to OpenCode and report the active authentication source. Takes no input.",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        execute: async () => {
          const apiKey = await getApiKey()
          const source = apiKey ? `environment variable (${ENV_VAR})` : "not connected"
          const text =
            source === "not connected"
              ? "Devin is not connected. Set DEVIN_API_KEY."
              : `Devin is connected via ${source}.`
          return {
            metadata: { connected: source !== "not connected", source },
            content: [textPart(text)],
          }
        },
      })

      // --- devin_create_session --------------------------------------------
      tools.add({
        name: "devin_create_session",
        description:
          "Create a new cloud Devin session with a task prompt and return its session_id and URL. Use this to hand off a self-contained task to Devin. Optionally provide a title, playbook_id, tags, and unlisted flag.",
        input: {
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
              metadata: session,
              content: [textPart(text)],
            }
          } catch (error) {
            const { message, status } = summarizeError(error)
            return {
              metadata: { ok: false, error: message, status },
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
        input: {
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
              metadata: result,
              content: [textPart(text)],
            }
          } catch (error) {
            const { message, status } = summarizeError(error)
            return {
              metadata: { ok: false, error: message, status },
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
        input: {
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
              metadata: session,
              content: [textPart(text)],
            }
          } catch (error) {
            const { message, status } = summarizeError(error)
            return {
              metadata: { ok: false, error: message, status },
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
        input: {
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
              metadata: { ok: true, session_id: args.session_id, detail: detail ?? null },
              content: [textPart(text)],
            }
          } catch (error) {
            const { message, status } = summarizeError(error)
            return {
              metadata: { ok: false, error: message, status },
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
        input: {
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
              metadata: { ok: true, session_id: args.session_id, detail: result.detail },
              content: [
                textPart(`Terminated Devin session ${args.session_id}: ${result.detail}`),
              ],
            }
          } catch (error) {
            const { message, status } = summarizeError(error)
            return {
              metadata: { ok: false, error: message, status },
              content: [textPart(`Failed to terminate session: ${message}`)],
            }
          }
        },
      })
    })
  },
})
