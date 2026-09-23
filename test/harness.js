'use strict';
/*
 * Test harness: a local HTTP server plus a minimal stand-in for n8n's
 * IExecuteFunctions that fulfils the request helper contract the node uses
 * (baseURL + url + qs, headers, encoding-dependent body, full response).
 *
 * The stand-in is deliberately small. It is not n8n; the live check that runs
 * the built node inside a real n8n instance remains the authority for host
 * behaviour. These tests pin the node's own logic against realistic server
 * responses. They run against the compiled output in dist/, which is also
 * what gets published.
 */

const http = require('node:http');
const { Goodmem } = require('../dist/nodes/Goodmem/Goodmem.node');

class MockServer {
	constructor() {
		this.requests = [];
		this.routes = [];
		this.baseUrl = '';
	}

	route(method, pathOrSuffix, handler) {
		const test = pathOrSuffix instanceof RegExp ? (p) => pathOrSuffix.test(p) : (p) => p.endsWith(pathOrSuffix);
		this.routes.push({ method: method.toUpperCase(), test, handler });
	}

	reset() {
		this.requests.length = 0;
		this.routes.length = 0;
	}

	start() {
		this.server = http.createServer((req, res) => {
			const chunks = [];
			req.on('data', (c) => chunks.push(c));
			req.on('end', () => {
				const url = new URL(req.url ?? '/', 'http://localhost');
				const body = Buffer.concat(chunks).toString('utf8');
				const recorded = { method: req.method ?? '', path: url.pathname, query: url.searchParams, headers: req.headers, body };
				try {
					recorded.json = body ? JSON.parse(body) : undefined;
				} catch {
					recorded.json = undefined;
				}
				this.requests.push(recorded);
				const route = this.routes.find((r) => r.method === recorded.method && r.test(url.pathname));
				if (!route) {
					res.writeHead(404, { 'content-type': 'application/json' });
					res.end(JSON.stringify({ error: `unrouted ${recorded.method} ${url.pathname}` }));
					return;
				}
				const out = route.handler(recorded) ?? {};
				const headers = { ...(out.headers ?? {}) };
				let payload;
				if (Buffer.isBuffer(out.body)) payload = out.body;
				else if (typeof out.body === 'string') payload = Buffer.from(out.body);
				else {
					payload = Buffer.from(JSON.stringify(out.body ?? {}));
					headers['content-type'] = headers['content-type'] ?? 'application/json';
				}
				res.writeHead(out.status ?? 200, headers);
				res.end(payload);
			});
		});
		return new Promise((resolve) =>
			this.server.listen(0, '127.0.0.1', () => {
				this.baseUrl = `http://127.0.0.1:${this.server.address().port}`;
				resolve(this.baseUrl);
			}),
		);
	}

	stop() {
		return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
	}

	paths() {
		return this.requests.map((r) => `${r.method} ${r.path}`);
	}
}

function ndjson(...events) {
	return { body: events.map((e) => JSON.stringify(e)).join('\n') + '\n', headers: { 'content-type': 'application/x-ndjson; charset=utf-8' } };
}

/** Run the real node's execute() against a mock context. Returns the output items. */
async function runNode(server, params, options = {}) {
	const items = options.items ?? [{ json: {} }];
	const node = { name: 'Goodmem', type: 'goodmem', typeVersion: 2, position: [0, 0], parameters: {} };

	const request = async (opts) => {
		const base = String(opts.baseURL ?? '').replace(/\/+$/, '');
		const url = new URL(base + String(opts.url));
		for (const [k, v] of Object.entries(opts.qs ?? {})) {
			if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
		}
		const headers = { 'x-api-key': 'test-key', ...(opts.headers ?? {}) };
		let body;
		if (opts.body !== undefined) body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
		const res = await fetch(url, { method: String(opts.method ?? 'GET'), headers, body });
		const buf = Buffer.from(await res.arrayBuffer());
		const encoding = String(opts.encoding ?? (opts.json ? 'json' : 'text'));
		let parsed;
		if (encoding === 'arraybuffer') parsed = buf;
		else if (encoding === 'text') parsed = buf.toString('utf8');
		else {
			const text = buf.toString('utf8');
			try {
				parsed = text ? JSON.parse(text) : undefined;
			} catch {
				parsed = text;
			}
		}
		const responseHeaders = {};
		res.headers.forEach((v, k) => (responseHeaders[k] = v));
		if (!opts.ignoreHttpStatusErrors && res.status >= 400) throw new Error(`HTTP ${res.status}`);
		return opts.returnFullResponse ? { statusCode: res.status, headers: responseHeaders, body: parsed } : parsed;
	};

	const hints = options.hints ?? [];
	const logs = options.logs ?? [];
	const ctx = {
		getInputData: () => items,
		getNode: () => node,
		// Zero-item outputs carry their flag here (retrieval status contract, Q4b).
		addExecutionHints: (...h) => hints.push(...h),
		logger: {
			warn: (message, meta) => logs.push({ level: 'warn', message, meta }),
			info: () => {},
			error: () => {},
			debug: () => {},
		},
		continueOnFail: () => Boolean(options.continueOnFail),
		getCredentials: async () => ({ server: server.baseUrl, goodmemApiKey: 'test-key' }),
		getNodeParameter: (name, _i, fallback) => (name in params ? params[name] : fallback),
		helpers: {
			httpRequestWithAuthentication: async function (_type, opts) {
				return request(opts);
			},
			prepareBinaryData: async (buffer, fileName, mimeType) => ({
				data: buffer.toString('base64'),
				mimeType: mimeType ?? 'application/octet-stream',
				fileName,
				fileSize: `${buffer.length} B`,
			}),
			assertBinaryData: (i, property) => {
				const binary = items[i]?.binary?.[property];
				if (!binary) throw new Error(`no binary property ${property}`);
				return binary;
			},
			getBinaryDataBuffer: async (i, property) => Buffer.from(items[i].binary[property].data, 'base64'),
		},
	};
	const result = await new Goodmem().execute.call(ctx);
	return result[0];
}

module.exports = { MockServer, ndjson, runNode };
