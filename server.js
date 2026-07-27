#!/usr/bin/env node
/**
 * perplexity-deep-mcp
 *
 * A zero-dependency MCP server exposing Perplexity's ASYNCHRONOUS Sonar Deep
 * Research API over stdio.
 *
 * Why this exists: sonar-deep-research routinely runs for 2-20 minutes. MCP
 * clients (Claude Desktop among them) cancel a tool call long before that and
 * return "MCP error -32001: Request timed out". Perplexity's synchronous
 * endpoint is therefore unusable from inside an MCP client.
 *
 * This server splits the work across separate, always-fast requests:
 *   start  -> POST /v1/async/sonar         (returns immediately with a job id)
 *   check  -> GET  /v1/async/sonar/{id}    (returns immediately with status)
 *   list   -> GET  /v1/async/sonar         (returns immediately with all jobs)
 *
 * No single request ever approaches the client timeout, so arbitrarily long
 * research jobs work fine.
 *
 * Implemented against the raw JSON-RPC 2.0 stdio protocol with no npm
 * dependencies, so it runs from a bare `node server.js` with no install step.
 *
 * KNOWN LIMITATION (verified 2026-07-25, Perplexity-side, not fixable here):
 * The async endpoint returns citations: [] and search_results: [] even on jobs
 * that ran many searches, and the model omits inline [n] markers. Injecting a
 * system prompt demanding inline URLs was tested and did NOT work. So async
 * deep research currently gives you a long, well-structured, UNSOURCED report.
 * Do not cite its output in academic or client work without verifying every
 * claim independently. If you need attributed sources, use a tool backed by
 * the synchronous endpoint instead. Re-test periodically - if citations start
 * coming back, formatCompleted() will pick them up automatically.
 *
 * Env:
 *   PERPLEXITY_API_KEY   required
 *   PERPLEXITY_BASE_URL  optional, default https://api.perplexity.ai
 */

'use strict';

const PROTOCOL_FALLBACK = '2025-06-18';
const SERVER_NAME = 'perplexity-deep';
const SERVER_VERSION = '1.0.0';

const BASE_URL = (process.env.PERPLEXITY_BASE_URL || 'https://api.perplexity.ai').replace(/\/+$/, '');
const API_KEY = process.env.PERPLEXITY_API_KEY;

const HTTP_TIMEOUT_MS = 60000;
const MAX_WAIT_SECONDS = 40;

// stdout is reserved exclusively for JSON-RPC frames. Everything else -> stderr.
function log(...args) {
  process.stderr.write('[perplexity-deep] ' + args.join(' ') + '\n');
}

// ---------------------------------------------------------------- HTTP client

async function apiRequest(method, path, body) {
  if (!API_KEY) {
    throw new Error(
      'PERPLEXITY_API_KEY is not set. Add it to the "env" block of this server ' +
      'entry in claude_desktop_config.json, then fully quit and reopen Claude.'
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(BASE_URL + path, {
      method,
      headers: {
        Authorization: 'Bearer ' + API_KEY,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === 'AbortError') {
      throw new Error(
        `Perplexity did not respond within ${HTTP_TIMEOUT_MS / 1000}s on ${method} ${path}. ` +
        'This is a network or Perplexity-side problem, not a research timeout. Retry the call.'
      );
    }
    throw new Error(`Network error calling ${method} ${path}: ${err && err.message ? err.message : String(err)}`);
  }
  clearTimeout(timer);

  const text = await res.text();

  if (!res.ok) {
    let detail = text.slice(0, 800);
    try {
      const parsed = JSON.parse(text);
      detail = JSON.stringify(parsed.error || parsed.detail || parsed).slice(0, 800);
    } catch (_) { /* keep raw text */ }

    if (res.status === 401 || res.status === 403) {
      throw new Error(`Perplexity rejected the API key (HTTP ${res.status}). Check PERPLEXITY_API_KEY is valid and not revoked. Detail: ${detail}`);
    }
    if (res.status === 404) {
      throw new Error(`Not found (HTTP 404) on ${path}. If this was a job lookup, the id may be wrong or older than 7 days (results expire after 7 days). Detail: ${detail}`);
    }
    if (res.status === 429) {
      throw new Error(`Rate limited by Perplexity (HTTP 429). Wait a minute and retry, or check your usage tier. Detail: ${detail}`);
    }
    throw new Error(`Perplexity API error HTTP ${res.status} on ${method} ${path}. Detail: ${detail}`);
  }

  try {
    return JSON.parse(text);
  } catch (_) {
    throw new Error(`Perplexity returned non-JSON on ${method} ${path}: ${text.slice(0, 400)}`);
  }
}

// ------------------------------------------------------------------- helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stripThinking(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

function fmtDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return 'unknown';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function formatCompleted(job, opts) {
  const r = job.response || {};
  const choice = (r.choices && r.choices[0]) || {};
  const msg = choice.message || {};
  let content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
  if (opts.strip_thinking !== false) content = stripThinking(content);

  const parts = [];
  parts.push(`# Deep research complete\n`);
  parts.push(`Job \`${job.id}\` · model \`${job.model}\``);
  if (job.started_at && job.completed_at) {
    parts.push(`Elapsed: ${fmtDuration(job.completed_at - job.started_at)}`);
  }

  const u = r.usage || {};
  if (u.num_search_queries != null) parts.push(`Search queries run: ${u.num_search_queries}`);
  if (u.cost && u.cost.total_cost != null) parts.push(`Cost: $${Number(u.cost.total_cost).toFixed(4)}`);
  parts.push('\n---\n');
  parts.push(content || '(empty response body)');

  // Prefer search_results (has titles + dates); fall back to bare citations.
  const results = Array.isArray(r.search_results) ? r.search_results : [];
  const citations = Array.isArray(r.citations) ? r.citations : [];

  if (results.length) {
    parts.push('\n---\n\n## Sources\n');
    results.forEach((sr, i) => {
      const date = sr.date ? ` — ${sr.date}` : '';
      parts.push(`[${i + 1}] [${sr.title || sr.url}](${sr.url})${date}`);
    });
  } else if (citations.length) {
    parts.push('\n---\n\n## Sources\n');
    citations.forEach((c, i) => parts.push(`[${i + 1}] ${c}`));
  } else {
    // Known Perplexity bug: async jobs return empty citations/search_results.
    // The server injects a system prompt telling the model to write URLs into
    // the prose, so recover them from there instead.
    const inline = [...new Set((content.match(/https?:\/\/[^\s)\]"'<>]+/g) || []))]
      .map((u) => u.replace(/[.,;]+$/, ''));

    if (inline.length) {
      parts.push('\n---\n\n## Sources found in the report body\n');
      inline.forEach((u, i) => parts.push(`[${i + 1}] ${u}`));
      parts.push(
        '\n> Perplexity\'s async API returned an empty citations array (a known server-side bug), ' +
        'so these URLs were recovered from the report text. They have not been independently verified as live or relevant.'
      );
    } else {
      parts.push(
        '\n---\n\n> **No sources returned.** Perplexity\'s async API sent back an empty citations array ' +
        '(a known server-side bug) and no URLs appear in the report text. ' +
        'Every claim above is unattributed - do not cite this in academic or client work without verifying independently.'
      );
    }
  }

  return parts.join('\n');
}

function formatPending(job) {
  const now = Math.floor(Date.now() / 1000);
  const since = job.started_at || job.created_at;
  const elapsed = since ? now - since : null;
  const lines = [
    `Job \`${job.id}\` is **${job.status}**.`,
    elapsed != null ? `Elapsed so far: ${fmtDuration(elapsed)}.` : '',
    '',
    'Deep research typically takes 2-20 minutes depending on reasoning_effort.',
    'Call pplx_deep_research_check again with the same job_id. Use wait_seconds ' +
    '(up to 40) to have this tool hold briefly before reporting back, which cuts ' +
    'down the number of polls needed.',
  ];
  return lines.filter(Boolean).join('\n');
}

// --------------------------------------------------------------------- tools

const TOOLS = [
  {
    name: 'pplx_deep_research_start',
    description:
      'Start a Perplexity Sonar Deep Research job. Returns a job_id immediately (does not wait for the research to finish). ' +
      'Use this for exhaustive multi-source investigation: literature reviews, market and competitor analysis, regulatory landscapes. ' +
      'After calling this, poll pplx_deep_research_check with the returned job_id. Jobs typically take 2-20 minutes. ' +
      'For quick factual lookups this is overkill and expensive - use a normal web search instead.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'The research question. Be specific and state exactly what you want covered, including any sub-questions, ' +
            'sectors, date ranges, or types of evidence required. Longer, more structured prompts produce far better results here.',
        },
        reasoning_effort: {
          type: 'string',
          enum: ['minimal', 'low', 'medium', 'high'],
          description:
            'How much effort the model spends. minimal/low finish faster and cost less; high runs many more searches and takes much longer. Default medium.',
        },
        search_mode: {
          type: 'string',
          enum: ['web', 'academic', 'sec'],
          description:
            'Corpus to search. Use "academic" for peer-reviewed literature (best for thesis work), "sec" for US company filings, "web" for everything else. Default web.',
        },
        search_recency_filter: {
          type: 'string',
          enum: ['hour', 'day', 'week', 'month', 'year'],
          description: 'Only use sources published within this window. Omit for no recency limit.',
        },
        search_domain_filter: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Restrict or exclude domains, max 10. Plain domain to allow (e.g. "sars.gov.za"); prefix with "-" to exclude (e.g. "-pinterest.com"). ' +
            'Use this to force high-quality sources and shut out content farms.',
        },
        search_after_date_filter: {
          type: 'string',
          description: 'Only sources published after this date, format MM/DD/YYYY.',
        },
        system_prompt: {
          type: 'string',
          description:
            'Optional system instruction shaping tone, structure, or output format of the final report.',
        },
      },
      required: ['query'],
    },
    annotations: {
      title: 'Start deep research',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: 'pplx_deep_research_check',
    description:
      'Check a deep research job and retrieve the full report once it is finished. Returns immediately with the current status. ' +
      'If the job is still running, call again. Results stay retrievable for 7 days.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: {
          type: 'string',
          description: 'The id returned by pplx_deep_research_start.',
        },
        wait_seconds: {
          type: 'number',
          description:
            'Optionally hold for up to 40 seconds before reporting, polling internally. Reduces the number of tool calls needed. Default 0.',
          minimum: 0,
          maximum: MAX_WAIT_SECONDS,
        },
        strip_thinking: {
          type: 'boolean',
          description: 'Remove <think> reasoning blocks from the report. Default true.',
        },
      },
      required: ['job_id'],
    },
    annotations: {
      title: 'Check deep research',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: 'pplx_deep_research_list',
    description:
      'List recent deep research jobs with their ids, models and statuses. Use this to recover a job_id you lost, or to see what is still running.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['CREATED', 'IN_PROGRESS', 'COMPLETED', 'FAILED'],
          description: 'Optionally show only jobs with this status.',
        },
        limit: {
          type: 'number',
          description: 'Max jobs to show, newest first. Default 20.',
          minimum: 1,
          maximum: 100,
        },
      },
    },
    annotations: {
      title: 'List deep research jobs',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
];

/**
 * Perplexity's async deep research endpoint has a server-side bug: it returns
 * citations: [] and search_results: [] even on jobs that ran many searches, and
 * the model omits inline [n] markers too. The synchronous endpoint does not
 * have this problem, but it is unusable from an MCP client because of the
 * request timeout.
 *
 * Workaround: instruct the model to write the source URLs into the prose
 * itself, which survives regardless of the broken metadata fields.
 */
const CITATION_SYSTEM_PROMPT = [
  'Cite your sources inline in the body text. After every factual claim, figure,',
  'date or quotation, put the full source URL in brackets immediately after the',
  'claim, e.g. (https://www.sars.gov.za/tax-rates/).',
  'End the report with a "## Sources" section listing every URL you used, one per',
  'line, each with the publisher name and publication date where known.',
  'Do not rely on numbered citation markers alone - always write out the full URL.',
  'If you cannot find a source for a claim, say so explicitly rather than stating it as fact.',
].join(' ');

async function toolStart(args) {
  const query = (args.query || '').trim();
  if (!query) throw new Error('The "query" parameter is required and cannot be empty.');

  const messages = [];
  const system = args.system_prompt
    ? `${args.system_prompt}\n\n${CITATION_SYSTEM_PROMPT}`
    : CITATION_SYSTEM_PROMPT;
  messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: query });

  const request = {
    model: 'sonar-deep-research',
    messages,
    reasoning_effort: args.reasoning_effort || 'medium',
  };

  if (args.search_mode) request.search_mode = args.search_mode;
  if (args.search_recency_filter) request.search_recency_filter = args.search_recency_filter;
  if (args.search_after_date_filter) request.search_after_date_filter = args.search_after_date_filter;
  if (Array.isArray(args.search_domain_filter) && args.search_domain_filter.length) {
    request.search_domain_filter = args.search_domain_filter.slice(0, 10);
  }

  const job = await apiRequest('POST', '/v1/async/sonar', { request });

  return [
    `Deep research job submitted.`,
    ``,
    `**job_id:** \`${job.id}\``,
    `**model:** ${job.model}`,
    `**status:** ${job.status}`,
    `**reasoning_effort:** ${request.reasoning_effort}`,
    ``,
    `Expect 2-20 minutes. Retrieve it with:`,
    `pplx_deep_research_check({ job_id: "${job.id}", wait_seconds: 40 })`,
    ``,
    `The result is retrievable for 7 days, so this is safe to pick up in a later conversation.`,
  ].join('\n');
}

async function toolCheck(args) {
  const jobId = (args.job_id || '').trim();
  if (!jobId) throw new Error('The "job_id" parameter is required. Use pplx_deep_research_list to find it.');

  const waitFor = Math.min(Math.max(Number(args.wait_seconds) || 0, 0), MAX_WAIT_SECONDS);
  const deadline = Date.now() + waitFor * 1000;

  let job = await apiRequest('GET', `/v1/async/sonar/${encodeURIComponent(jobId)}`);

  while (
    (job.status === 'CREATED' || job.status === 'IN_PROGRESS') &&
    Date.now() < deadline
  ) {
    await sleep(Math.min(5000, Math.max(1000, deadline - Date.now())));
    job = await apiRequest('GET', `/v1/async/sonar/${encodeURIComponent(jobId)}`);
  }

  if (job.status === 'COMPLETED') return formatCompleted(job, args);

  if (job.status === 'FAILED') {
    throw new Error(
      `Job ${job.id} FAILED. Perplexity reported: ${job.error_message || '(no error message given)'}. ` +
      'Submit a new job with pplx_deep_research_start, ideally with a narrower query or lower reasoning_effort.'
    );
  }

  return formatPending(job);
}

async function toolList(args) {
  const data = await apiRequest('GET', '/v1/async/sonar');
  let requests = Array.isArray(data.requests) ? data.requests.slice() : [];

  if (args.status) requests = requests.filter((r) => r.status === args.status);
  requests.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

  const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
  requests = requests.slice(0, limit);

  if (!requests.length) {
    return args.status
      ? `No deep research jobs with status ${args.status}.`
      : 'No deep research jobs found. Start one with pplx_deep_research_start.';
  }

  const rows = requests.map((r) => {
    const created = r.created_at ? new Date(r.created_at * 1000).toISOString().replace('T', ' ').slice(0, 16) : '?';
    return `| \`${r.id}\` | ${r.status} | ${r.model} | ${created} |`;
  });

  return [
    `${requests.length} job(s):`,
    '',
    '| job_id | status | model | created (UTC) |',
    '|---|---|---|---|',
    ...rows,
    '',
    'Retrieve any COMPLETED job with pplx_deep_research_check({ job_id: "..." }).',
  ].join('\n');
}

const HANDLERS = {
  pplx_deep_research_start: toolStart,
  pplx_deep_research_check: toolCheck,
  pplx_deep_research_list: toolList,
};

// ----------------------------------------------------------- JSON-RPC plumbing

function send(payload) {
  process.stdout.write(JSON.stringify(payload) + '\n');
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleMessage(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize': {
      const requested = params && typeof params.protocolVersion === 'string'
        ? params.protocolVersion
        : PROTOCOL_FALLBACK;
      sendResult(id, {
        protocolVersion: requested,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      return;
    }

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return; // notifications get no reply

    case 'ping':
      if (!isNotification) sendResult(id, {});
      return;

    case 'tools/list':
      sendResult(id, { tools: TOOLS });
      return;

    case 'tools/call': {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      const handler = HANDLERS[name];

      if (!handler) {
        sendResult(id, {
          content: [{ type: 'text', text: `Unknown tool "${name}". Available: ${Object.keys(HANDLERS).join(', ')}.` }],
          isError: true,
        });
        return;
      }

      try {
        const text = await handler(args);
        sendResult(id, { content: [{ type: 'text', text }] });
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        log('tool error:', name, message);
        sendResult(id, { content: [{ type: 'text', text: `Error: ${message}` }], isError: true });
      }
      return;
    }

    // Declared unsupported, but answer politely so strict clients do not error.
    case 'resources/list':
      sendResult(id, { resources: [] });
      return;
    case 'prompts/list':
      sendResult(id, { prompts: [] });
      return;

    default:
      if (!isNotification) sendError(id, -32601, `Method not found: ${method}`);
  }
}

function main() {
  if (!API_KEY) {
    log('WARNING: PERPLEXITY_API_KEY is not set. Tool calls will fail until it is.');
  }

  let buffer = '';
  let inFlight = 0;
  let stdinClosed = false;

  // Never exit while a tool call is still awaiting Perplexity, otherwise a
  // closed stdin would drop the reply on the floor.
  const exitWhenIdle = () => {
    if (stdinClosed && inFlight === 0) process.exit(0);
  };

  process.stdin.setEncoding('utf8');

  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;

      let msg;
      try {
        msg = JSON.parse(line);
      } catch (_) {
        log('skipping unparseable line');
        continue;
      }

      inFlight += 1;
      Promise.resolve(handleMessage(msg))
        .catch((err) => {
          log('fatal handler error:', err && err.message ? err.message : String(err));
          if (msg && msg.id !== undefined && msg.id !== null) {
            sendError(msg.id, -32603, `Internal error: ${err && err.message ? err.message : String(err)}`);
          }
        })
        .finally(() => {
          inFlight -= 1;
          exitWhenIdle();
        });
    }
  });

  process.stdin.on('end', () => { stdinClosed = true; exitWhenIdle(); });
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));

  log(`ready (${SERVER_NAME} v${SERVER_VERSION}, base ${BASE_URL})`);
}

main();
