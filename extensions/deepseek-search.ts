/**
 * deepseek-search - exposes a single `web_search` tool backed by the official DeepSeek Search API.
 *
 * Replaces npm:pi-web-access (which keeps five tool schemas resident).
 * API docs: https://api-docs.deepseek.com/zh-cn/guides/search/
 * Billing: 5 CNY per 1000 successful requests (successful = returned results).
 *
 * Auth comes from pi's credential store (the same source as
 * `pi auth print-api-key --provider deepseek`); no second key is stored here or in any json.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const ENDPOINT = "https://api.deepseek.com/v1/tools/search";
const TIMEOUT_MS = 30_000;

interface DsResult {
  title?: string;
  url?: string;
  snippet?: string;
  summary?: string;
  content?: string;
  date?: string | null;
  authority?: number;
  rerank_score?: number;
}

const PARAMS = Type.Object({
  query: Type.String({
    description:
      'Search query, max 128 chars, all of it sent as-is. Supports site:example.com, -site:, -"phrase", "exact phrase", lang:zh,en, after:2025-01-01, before:2026-06-01',
  }),
  count: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Results to return, default 8" })),
  need_content: Type.Optional(
    Type.Boolean({ description: "Also return the full page text (large, costs context). Default false; prefer summary." }),
  ),
});

async function apiKey(ctx: ExtensionContext): Promise<string> {
  const key = await ctx.modelRegistry.getApiKeyForProvider("deepseek");
  if (!key) {
    throw new Error("No DeepSeek API key. Run `/login deepseek` (or `pi auth print-api-key --provider deepseek` to check).");
  }
  return key;
}

function failDetail(status: number, body: string): string {
  const hint: Record<number, string> = {
    400: "bad request (invalid JSON or field, or query over 128 chars)",
    401: "API key missing or invalid",
    402: "account balance insufficient",
    403: "blocked by security policy",
    404: "no usable result for this query",
    408: "read timeout",
    413: "request body too large",
    429: "QPS limit (5/s per account) — wait and retry",
    500: "DeepSeek server error",
    504: "upstream timeout",
  };
  return `DeepSeek search failed: HTTP ${status}${hint[status] ? ` — ${hint[status]}` : ""}${body ? `\n${body.slice(0, 500)}` : ""}`;
}

function format(results: DsResult[]): string {
  return results
    .map((r, i) => {
      const meta = [r.date?.slice(0, 10), r.authority !== undefined && r.authority >= 0 ? `authority ${r.authority}` : null]
        .filter(Boolean)
        .join(", ");
      const lines = [`${i + 1}. ${r.title ?? "(no title)"}${meta ? `  [${meta}]` : ""}`, `   ${r.url ?? ""}`];
      const body = r.summary || r.snippet;
      if (body) lines.push(...body.split("\n").map((l) => `   ${l}`));
      if (r.content) lines.push("   --- full content ---", ...r.content.split("\n").map((l) => `   ${l}`));
      return lines.join("\n");
    })
    .join("\n\n");
}

export default function deepseekSearch(pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web through DeepSeek's search API. Returns titles, URLs, dates and a model-written summary per result. Pass need_content to get full page text.",
    promptSnippet: "Search the web with DeepSeek's Search API",
    promptGuidelines: [
      "Use web_search for current facts, docs and news instead of guessing from memory.",
      "Prefer one web_search call with a precise query over many broad ones; dates and snippets usually answer the question without need_content.",
    ],
    parameters: PARAMS,
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (params.query.trim().length === 0) throw new Error("query must not be blank");
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${await apiKey(ctx)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: params.query,
          count: params.count ?? 8,
          ...(params.need_content ? { need_content: true } : {}),
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
      });
      if (!res.ok) throw new Error(failDetail(res.status, await res.text().catch(() => "")));
      const data = (await res.json()) as { results?: DsResult[] };
      const results = data.results ?? [];
      if (results.length === 0) {
        return { content: [{ type: "text" as const, text: `No results for: ${params.query}` }], details: { query: params.query, results } };
      }
      return {
        content: [{ type: "text" as const, text: `${results.length} result(s) for: ${params.query}\n\n${format(results)}` }],
        details: { query: params.query, results },
      };
    },
  });
}
