const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const { once } = require('node:events');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const serverPath = path.join(repoRoot, 'server.js');

function runServer(messages, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`server did not exit; stderr: ${stderr}`));
    }, 5000);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`server exited ${code}; stderr: ${stderr}`));
        return;
      }
      try {
        resolve(stdout.trim() ? stdout.trim().split('\n').map(JSON.parse) : []);
      } catch (err) {
        reject(new Error(`server wrote invalid JSON-RPC output: ${stdout}\n${err.message}`));
      }
    });

    child.stdin.end(`${messages.map((message) => JSON.stringify(message)).join('\n')}\n`);
  });
}

async function startMockApi(handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

test('initialise returns the requested protocol and all three tools', async () => {
  const replies = await runServer([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ]);

  assert.equal(replies[0].result.protocolVersion, '2025-06-18');
  assert.deepEqual(replies[1].result.tools.map((tool) => tool.name), [
    'pplx_deep_research_start',
    'pplx_deep_research_check',
    'pplx_deep_research_list',
  ]);
});

test('notifications do not produce JSON-RPC replies', async () => {
  const replies = await runServer([
    { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
  ]);

  assert.deepEqual(replies, []);
});

test('unknown methods return the JSON-RPC method-not-found error', async () => {
  const replies = await runServer([
    { jsonrpc: '2.0', id: 7, method: 'not/a/real/method', params: {} },
  ]);

  assert.equal(replies[0].error.code, -32601);
});

test('completed jobs recover report URLs when the async API omits citations', async () => {
  const api = await startMockApi((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      id: 'job-123',
      model: 'sonar-deep-research',
      status: 'COMPLETED',
      started_at: 100,
      completed_at: 115,
      response: {
        choices: [{ message: { content: 'Source: https://example.com/report.' } }],
        citations: [],
        search_results: [],
      },
    }));
  });

  try {
    const replies = await runServer([
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'pplx_deep_research_check', arguments: { job_id: 'job-123' } },
      },
    ], { PERPLEXITY_API_KEY: 'test-key', PERPLEXITY_BASE_URL: api.baseUrl });

    const text = replies[0].result.content[0].text;
    assert.match(text, /https:\/\/example\.com\/report/);
    assert.match(text, /recovered from the report text/);
  } finally {
    await api.close();
  }
});

test('rate limits reach MCP clients as actionable tool errors', async () => {
  const api = await startMockApi((_request, response) => {
    response.statusCode = 429;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ error: 'rate limit exceeded' }));
  });

  try {
    const replies = await runServer([
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'pplx_deep_research_list', arguments: {} },
      },
    ], { PERPLEXITY_API_KEY: 'test-key', PERPLEXITY_BASE_URL: api.baseUrl });

    assert.equal(replies[0].result.isError, true);
    assert.match(replies[0].result.content[0].text, /Rate limited by Perplexity/);
  } finally {
    await api.close();
  }
});
