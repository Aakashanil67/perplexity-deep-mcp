# perplexity-deep-mcp

An MCP server that makes Perplexity's Sonar Deep Research usable from MCP clients that enforce a request timeout.

No dependencies. One file. Runs on `node server.js`.

## The problem

Perplexity's `sonar-deep-research` model runs for two to twenty minutes depending on reasoning effort. MCP clients don't wait that long. Claude Desktop cancels the tool call and returns:

```
MCP error -32001: Request timed out
```

The official Perplexity MCP server calls the synchronous `/chat/completions` endpoint, so deep research is effectively unavailable from inside the client. Raising the timeout doesn't help. The limit lives in the client's bundled MCP SDK, which on a packaged install sits inside a signed application bundle you can't edit. Config keys like `timeout` and `MCP_SERVER_REQUEST_TIMEOUT` are ignored.

Perplexity solved this on their side with an async API. This server exposes it.

## How it works

The job is split across three requests that each return in under a second:

```
pplx_deep_research_start   POST /v1/async/sonar        submit, get a job id back
pplx_deep_research_check   GET  /v1/async/sonar/{id}   poll status, fetch result
pplx_deep_research_list    GET  /v1/async/sonar        recover ids, see what's running
```

Nothing blocks. Research length stops being a constraint. Results stay retrievable for seven days, so a job started in one conversation can be collected in another.

`check` takes an optional `wait_seconds` (max 40). The server holds and polls internally, which cuts the number of round trips without going near the client's limit.

## Install

Node 18 or later. Nothing else.

```
git clone https://github.com/Aakashanil67/perplexity-deep-mcp.git
```

Get an API key from the [Perplexity API portal](https://www.perplexity.ai/account/api/group).

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "perplexity-deep": {
      "command": "node",
      "args": ["/absolute/path/to/perplexity-deep-mcp/server.js"],
      "env": {
        "PERPLEXITY_API_KEY": "pplx-your-key-here"
      }
    }
  }
}
```

On Windows, use `"C:\\Program Files\\nodejs\\node.exe"` as the command if bare `node` doesn't resolve. Quit the app fully — from the system tray, not just the window — and reopen.

### Claude Code

```
claude mcp add perplexity-deep --env PERPLEXITY_API_KEY="pplx-your-key-here" -- node /absolute/path/to/server.js
```

### Environment

| Variable | Required | Default |
|---|---|---|
| `PERPLEXITY_API_KEY` | yes | — |
| `PERPLEXITY_BASE_URL` | no | `https://api.perplexity.ai` |

## Tools

### `pplx_deep_research_start`

Submits a job and returns immediately.

| Parameter | Type | Notes |
|---|---|---|
| `query` | string, required | Longer and more structured prompts produce noticeably better reports here |
| `reasoning_effort` | `minimal` \| `low` \| `medium` \| `high` | Default `medium`. `high` runs many more searches and takes considerably longer |
| `search_mode` | `web` \| `academic` \| `sec` | `academic` for peer-reviewed sources, `sec` for US company filings |
| `search_recency_filter` | `hour` \| `day` \| `week` \| `month` \| `year` | |
| `search_domain_filter` | string[] | Max 10. Prefix with `-` to exclude, e.g. `["-pinterest.com"]` |
| `search_after_date_filter` | string | `MM/DD/YYYY` |
| `system_prompt` | string | Shapes tone and structure of the report |

### `pplx_deep_research_check`

| Parameter | Type | Notes |
|---|---|---|
| `job_id` | string, required | From `start` |
| `wait_seconds` | number, 0–40 | Hold and poll internally before reporting back |
| `strip_thinking` | boolean | Strips `<think>` blocks. Default true |

Returns the full report with sources and cost once the job reaches `COMPLETED`. While it's running you get the status and elapsed time. A `FAILED` job surfaces Perplexity's error message.

### `pplx_deep_research_list`

Optional `status` and `limit`. Returns a table of recent jobs.

## Known limitation

The async endpoint returns `citations: []` and `search_results: []` even on jobs that ran many searches, and the model omits inline `[n]` markers. The synchronous endpoint doesn't have this problem. Verified 25 July 2026 against two jobs that ran eight and four search queries respectively; both came back with empty source arrays. Injecting a system prompt instructing the model to write full URLs into the prose was tried and did not work.

The practical effect is that you get a long, well-organised, unattributed report. That is fine for scoping an unfamiliar topic and not fine for anything you intend to cite.

The server handles this rather than hiding it. If the citation arrays are empty it scans the report body for URLs and lists whatever it finds, labelled as recovered rather than cited. If nothing turns up it says so in plain language at the end of the report. `formatCompleted()` reads the proper fields first, so if Perplexity ships a fix the correct sources appear with no code change.

This is upstream. There are open reports on the Perplexity community forum describing the same behaviour.

## Why there are no dependencies

The MCP TypeScript SDK is the normal way to build one of these. It's a good SDK. It also means a build step, a `node_modules` tree, and a lockfile to keep current, all to wrap a protocol that is JSON-RPC 2.0 over newline-delimited stdio.

For a server with three tools and two endpoints that trade wasn't worth making. `server.js` implements the protocol directly: `initialize` echoes the client's requested version, `tools/list` returns the schemas, `tools/call` dispatches, and `resources/list` and `prompts/list` return empty rather than erroring, which keeps stricter clients happy. Notifications get no reply. Unknown methods return `-32601`.

Two details worth knowing if you adapt this:

Everything written to stdout has to be a JSON-RPC frame. A stray `console.log` corrupts the stream and the client drops the connection with no useful error. All logging here goes to stderr.

The process tracks in flight requests and won't exit on stdin close while a call is still awaiting the API. Without that guard a closing client can drop a reply that was about to be written.

## Errors

Failures return `isError: true` with a message aimed at whoever has to fix it, not a stack trace. A 401 says the key was rejected. A 404 on a job lookup mentions the seven-day expiry. A 429 says to wait. Network timeouts distinguish themselves from research timeouts, because the two look identical from the client side and the fix is different.

## Development

```
node --check server.js
```

Drive it by hand over stdio:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | PERPLEXITY_API_KEY=your-key node server.js
```

Or use the official inspector:

```
npx @modelcontextprotocol/inspector node server.js
```

## Cost

Billed by Perplexity per request. Observed on short test jobs: $0.08 for four search queries, $0.13 for eight. Real research runs at `high` effort cost substantially more. Each result reports its own cost.

## License

MIT. See [LICENSE](LICENSE).
