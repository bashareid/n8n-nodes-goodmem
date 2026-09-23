'use strict';
/*
 * Regression tests. Each execute-level test pins a defect reproduced against
 * the published 1.0.1 node inside a real n8n 2.39 instance; the comments name
 * the reproduction. Event shapes come from test/fixtures/retrieve_real.ndjson,
 * captured from a live GoodMem server, not written from a guess at the schema.
 */

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { after, before, beforeEach, describe, it } = require('node:test');

const { classify, decodeText, hitsFromEvents, isTextual, parseNdjson } = require('../dist/nodes/Goodmem/GenericFunctions');
const { MockServer, ndjson, runNode } = require('./harness');

const REAL = readFileSync(join(__dirname, 'fixtures', 'retrieve_real.ndjson'), 'utf8');
const realEvents = () => parseNdjson(REAL).events;
const REAL_SCORE = -0.5345187187194824; // straight from the capture: vector scores are negative

function chunkEvent(chunkId, text, memoryId, score = REAL_SCORE) {
	const event = JSON.parse(JSON.stringify(realEvents().find((e) => e.retrievedItem)));
	const reference = event.retrievedItem.chunk;
	reference.chunk.chunkId = chunkId;
	reference.chunk.chunkText = text;
	reference.chunk.memoryId = memoryId;
	reference.relevanceScore = score;
	return event;
}
function memoryEvent(memoryId, metadata = {}) {
	const event = JSON.parse(JSON.stringify(realEvents().find((e) => e.memoryDefinition)));
	event.memoryDefinition.memoryId = memoryId;
	event.memoryDefinition.metadata = metadata;
	return event;
}
const status = (code, message, details) => ({ status: { ...(code ? { code } : {}), message, ...(details ? { details } : {}) } });
const INFO = status('FEATURE_DISABLED', 'Abstract reply generation disabled', { feature: 'summarization', required_param: 'llm_id' });

/* ---------------------------------------------------------- pure logic */
describe('retrieval stream handling', () => {
	it('parses a real server stream and counts malformed lines', () => {
		const parsed = parseNdjson(REAL + '{"retrievedItem": {"chunk": {"chu');
		assert.equal(parsed.events.length, 4);
		assert.equal(parsed.malformedLines, 1);
	});

	it('drops the informational no-LLM notice but keeps known failures', () => {
		const { statuses, degraded } = classify({ events: [INFO, status('RERANKING_FAILED', 'gone')], malformedLines: 0 });
		assert.equal(degraded, true);
		assert.deepEqual(statuses.map((s) => s.code), ['RERANKING_FAILED']);
	});

	it('surfaces an unrecognized future code without treating it as fatal', () => {
		const { statuses, degraded } = classify({ events: [status('BRAND_NEW_CODE', 'hi')], malformedLines: 0 });
		assert.equal(degraded, true);
		assert.equal(statuses[0].code, 'UNKNOWN');
		assert.equal(statuses[0].originalCode, 'BRAND_NEW_CODE');
		assert.equal(statuses[0].unrecognized, true);
	});

	it('joins chunks to memories regardless of order and dedups by chunk id', () => {
		const events = [chunkEvent('c1', 'one', 'm1'), chunkEvent('c2', 'two', 'm1'), chunkEvent('c1', 'dup', 'm1'), memoryEvent('m1', { title: 'T' })];
		const hits = hitsFromEvents(events, false);
		assert.deepEqual(hits.map((h) => h.chunkId), ['c1', 'c2']);
		assert.equal(hits[0].metadata.title, 'T');
		assert.equal(hits[0].scoreKind, 'vector');
		assert.equal(hits[0].score, REAL_SCORE, 'real scores are negative and pass through untouched');
	});

	it('decodes text by charset and refuses to mangle mismatched bytes', () => {
		assert.equal(decodeText(Buffer.from('héllo', 'utf8'), 'text/plain; charset=utf-8').text, 'héllo');
		assert.equal(decodeText(Buffer.from('héllo', 'latin1'), 'text/plain; charset=iso-8859-1').text, 'héllo');
		assert.ok(decodeText(Buffer.from([0xff, 0xfe, 0xc3]), 'text/plain').error);
		assert.equal(decodeText(Buffer.from('x'), 'application/pdf'), null);
		assert.equal(isTextual('application/ld+json'), true);
	});
});

/* -------------------------------------------------------- execute path */
describe('Goodmem node execute()', () => {
	const server = new MockServer();
	before(() => server.start());
	after(() => server.stop());
	beforeEach(() => server.reset());

	const retrieveParams = (extra = {}) => ({ resource: 'memory', operation: 'retrieve', query: 'codeword', spaceIds: ['s1'], limit: 10, ...extra });

	it('emits one item per chunk with joined metadata, via POST with the NDJSON accept header', async () => {
		// n8n 1.0.1: one item whose json was the whole stream as a 4755-char string
		server.route('POST', ':retrieve', () => ndjson(INFO, memoryEvent('m1', { title: 'doc' }), chunkEvent('c1', 'first', 'm1'), chunkEvent('c2', 'second', 'm1')));
		const items = await runNode(server, retrieveParams());
		assert.equal(items.length, 2);
		assert.equal(items[0].json.chunkText, 'first');
		assert.equal(items[0].json.memoryId, 'm1');
		assert.equal(items[0].json.metadata.title, 'doc');
		assert.equal(items[0].json.partial, false);
		assert.deepEqual(items[0].json.statuses, []);
		const req = server.requests[0];
		assert.equal(req.method, 'POST');
		assert.equal(req.headers.accept, 'application/x-ndjson');
		assert.deepEqual(req.json.spaceKeys, [{ spaceId: 's1' }]);
		assert.equal(req.query.has('message'), false, 'query text travels in the body, not the URL');
	});

	it('flags failed reranking instead of reporting success', async () => {
		// n8n 1.0.1: NOT_FOUND + RERANKING_FAILED buried in the string; execution status "success"
		server.route('POST', ':retrieve', () => ndjson(status('NOT_FOUND', 'Reranker not found'), INFO, status('RERANKING_FAILED', 'Failed to create reranker client'), memoryEvent('m1'), chunkEvent('c1', 'fallback', 'm1')));
		const items = await runNode(server, retrieveParams({ retrieveOptions: { rerankerId: 'r-missing' } }));
		assert.equal(items.length, 1);
		assert.equal(items[0].json.partial, true);
		assert.deepEqual(items[0].json.statuses.map((s) => s.code), ['NOT_FOUND', 'RERANKING_FAILED']);
		assert.equal(server.requests[0].json.postProcessor.config.reranker_id, 'r-missing');
	});

	it('returns no items and flags a search that failed outright (contract Q4b)', async () => {
		server.route('POST', ':retrieve', () => ndjson(status('VECTOR_SEARCH_FAILED', 'backend unavailable')));
		const hints = [];
		const logs = [];
		const items = await runNode(server, retrieveParams(), { hints, logs });
		assert.deepEqual(items, [], 'a failed search is empty, not a node failure');
		assert.equal(hints.length, 1, 'the failure is surfaced as an execution hint');
		assert.match(hints[0].message, /VECTOR_SEARCH_FAILED/);
		assert.equal(hints[0].type, 'warning');
		assert.equal(logs.length, 1);
		assert.equal(logs[0].meta.statuses[0].code, 'VECTOR_SEARCH_FAILED');
	});

	it('treats FEATURE_DISABLED as informational whatever its details (contract Q1)', () => {
		const event = { status: { code: 'FEATURE_DISABLED', message: 'Reranking disabled: no reranker configured.', details: { feature: 'reranking', required_param: 'reranker_id' } } };
		const { statuses, degraded } = classify({ events: [event], malformedLines: 0 });
		assert.equal(degraded, false);
		assert.deepEqual(statuses, []);
	});

	it('keeps chunks when a newer server sends an unknown status code', async () => {
		server.route('POST', ':retrieve', () => ndjson(memoryEvent('m1'), chunkEvent('c1', 'still useful', 'm1'), status('CODE_FROM_THE_FUTURE', 'hello')));
		const items = await runNode(server, retrieveParams());
		assert.equal(items.length, 1);
		assert.equal(items[0].json.partial, true);
		assert.equal(items[0].json.statuses[0].code, 'UNKNOWN');
	});

	it('reports a truncated stream instead of skipping the broken line silently', async () => {
		server.route('POST', ':retrieve', () => ({
			body: JSON.stringify(memoryEvent('m1')) + '\n' + JSON.stringify(chunkEvent('c1', 'ok', 'm1')) + '\n{"retrievedItem": {"chunk": {"chu',
			headers: { 'content-type': 'application/x-ndjson' },
		}));
		const items = await runNode(server, retrieveParams());
		assert.equal(items.length, 1);
		assert.equal(items[0].json.statuses[0].code, 'MALFORMED_STREAM');
	});

	it('answers an empty search with zero items and exactly one request', async () => {
		server.route('POST', ':retrieve', () => ndjson(INFO));
		const items = await runNode(server, retrieveParams());
		assert.equal(items.length, 0);
		assert.equal(server.paths().filter((p) => p.endsWith(':retrieve')).length, 1);
	});

	it('passes the filter through verbatim on every space key', async () => {
		server.route('POST', ':retrieve', () => ndjson(INFO));
		const filter = "CAST(val('$.owner') AS TEXT) = 'o\\'brien'";
		await runNode(server, retrieveParams({ spaceIds: ['s1', 's2'], filter }));
		assert.deepEqual(server.requests[0].json.spaceKeys, [{ spaceId: 's1', filter }, { spaceId: 's2', filter }]);
	});

	it('refuses a relevance threshold without a reranker', async () => {
		// 1.0.1's UI enforced 0-1 and sent it regardless; vector scores are not on that scale
		await assert.rejects(runNode(server, retrieveParams({ retrieveOptions: { relevanceThreshold: 0.5 } })), /needs a Reranker ID/);
		assert.equal(server.requests.length, 0);
	});

	it('follows pagination when listing spaces', async () => {
		const page = (n, from) => Array.from({ length: n }, (_, k) => ({ spaceId: `s${from + k}`, name: `space-${from + k}` }));
		server.route('GET', '/v1/spaces', (req) => (req.query.get('nextToken') ? { body: { spaces: page(1, 50) } } : { body: { spaces: page(50, 0), nextToken: 'PAGE2' } }));
		const items = await runNode(server, { resource: 'space', operation: 'list', maxItems: 100 });
		assert.equal(items.length, 51, 'the space on page 2 must not be invisible');
		assert.equal(server.requests.length, 2);
		assert.equal(server.requests[1].query.get('nextToken'), 'PAGE2');
		assert.equal(items[0].json.truncated, false);
	});

	it('create waits for the memory it wrote, and never by searching', async () => {
		// 1.0.1 returned PENDING with no way to wait; a following Retrieve found nothing
		let polls = 0;
		server.route('POST', '/v1/memories', () => ({ status: 201, body: { memoryId: 'm-new', spaceId: 's1', processingStatus: 'PENDING' } }));
		server.route('GET', '/v1/memories/m-new', () => ({ body: { memoryId: 'm-new', processingStatus: ++polls < 3 ? 'PENDING' : 'COMPLETED' } }));
		const items = await runNode(server, { resource: 'memory', operation: 'create', memorySpaceId: 's1', inputType: 'text', content: 'hello', wait: true, waitTimeout: 10 });
		assert.equal(items[0].json.processingStatus, 'COMPLETED');
		assert.equal(server.paths().filter((p) => p === 'GET /v1/memories/m-new').length, 3);
		assert.equal(server.paths().filter((p) => p.endsWith(':retrieve')).length, 0);
	});

	it('create with wait off returns immediately', async () => {
		server.route('POST', '/v1/memories', () => ({ status: 201, body: { memoryId: 'm-new', processingStatus: 'PENDING' } }));
		const items = await runNode(server, { resource: 'memory', operation: 'create', memorySpaceId: 's1', inputType: 'text', content: 'hello', wait: false });
		assert.equal(items[0].json.processingStatus, 'PENDING');
		assert.equal(server.requests.length, 1);
	});

	it('create from an n8n binary property sends the bytes base64 with the file type', async () => {
		server.route('POST', '/v1/memories', () => ({ status: 201, body: { memoryId: 'm-bin', processingStatus: 'COMPLETED' } }));
		const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0xe2, 0xe3, 0xcf, 0xd3]);
		await runNode(
			server,
			{ resource: 'memory', operation: 'create', memorySpaceId: 's1', inputType: 'binary', inputBinaryPropertyName: 'data', wait: false },
			{ items: [{ json: {}, binary: { data: { data: bytes.toString('base64'), mimeType: 'application/pdf', fileName: 'report.pdf' } } }] },
		);
		const body = server.requests[0].json;
		assert.equal(body.contentType, 'application/pdf');
		assert.equal(body.originalContentB64, bytes.toString('base64'));
		assert.equal(body.metadata.title, 'report.pdf');
	});

	it('get decodes text content from base64 into a readable field', async () => {
		// 1.0.1 passed originalContent through as raw base64
		server.route('GET', '/v1/memories/m1', () => ({ body: { memoryId: 'm1', contentType: 'text/plain', originalContent: Buffer.from('The audit codeword is ZEPHYR-7.').toString('base64') } }));
		const items = await runNode(server, { resource: 'memory', operation: 'get', memoryId: 'm1', includeContent: true });
		assert.equal(items[0].json.content, 'The audit codeword is ZEPHYR-7.');
		assert.equal('originalContent' in items[0].json, false);
		assert.equal(server.requests[0].query.get('includeContent'), 'true');
	});

	it('get hands binary content over as n8n binary data, bytes intact', async () => {
		const pdf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]);
		server.route('GET', '/v1/memories/m2', () => ({ body: { memoryId: 'm2', contentType: 'application/pdf', metadata: { title: 'audit.pdf' }, originalContent: pdf.toString('base64') } }));
		const items = await runNode(server, { resource: 'memory', operation: 'get', memoryId: 'm2', includeContent: true, binaryPropertyName: 'data' });
		const binary = items[0].binary.data;
		assert.equal(binary.mimeType, 'application/pdf');
		assert.equal(binary.fileName, 'audit.pdf');
		assert.ok(Buffer.from(binary.data, 'base64').equals(pdf));
		assert.equal('content' in items[0].json, false);
	});

	it('download returns binary bytes unchanged', async () => {
		// n8n 1.0.1: 132 of 196 bytes became U+FFFD and no binary property was produced
		const body = Buffer.concat([Buffer.from('%PDF-1.4\n%'), Buffer.from(Array.from({ length: 128 }, (_, k) => 0x80 + k)), Buffer.from('\n%%EOF\n')]);
		server.route('GET', '/v1/memories/m3/content', () => ({ body, headers: { 'content-type': 'application/pdf' } }));
		server.route('GET', '/v1/memories/m3', () => ({ body: { memoryId: 'm3', contentType: 'application/pdf' } }));
		const items = await runNode(server, { resource: 'memory', operation: 'downloadContent', memoryId: 'm3', binaryPropertyName: 'file' });
		assert.ok(Buffer.from(items[0].binary.file.data, 'base64').equals(body));
		assert.equal(items[0].binary.file.mimeType, 'application/pdf');
	});

	it('download returns text as a readable field on an object item', async () => {
		// n8n 1.0.1: the item's json was a bare string
		server.route('GET', '/v1/memories/m4/content', () => ({ body: Buffer.from('plain words'), headers: { 'content-type': 'text/plain' } }));
		server.route('GET', '/v1/memories/m4', () => ({ body: { memoryId: 'm4', contentType: 'text/plain' } }));
		const items = await runNode(server, { resource: 'memory', operation: 'downloadContent', memoryId: 'm4' });
		assert.equal(typeof items[0].json, 'object');
		assert.equal(items[0].json.content, 'plain words');
	});

	it("surfaces the server's own error text", async () => {
		// n8n 1.0.1 showed "Your request is invalid or could not be processed by the service"
		server.route('POST', '/v1/spaces', () => ({ status: 409, body: { error: 'A space with this name already exists', status: 409 } }));
		await assert.rejects(
			runNode(server, { resource: 'space', operation: 'create', name: 'dup', embedderId: 'e1' }),
			(err) => /409/.test(err.message) && /A space with this name already exists/.test(err.message),
		);
	});

	it('update space sends only name and label fields', async () => {
		server.route('PUT', '/v1/spaces/s1', (req) => ({ body: { spaceId: 's1', ...req.json } }));
		await runNode(server, { resource: 'space', operation: 'update', spaceId: 's1', newName: 'renamed', labelMode: 'merge', updateLabels: { entries: [{ key: 'env', value: 'prod' }] } });
		assert.deepEqual(server.requests[0].json, { name: 'renamed', mergeLabels: { env: 'prod' } });
		await assert.rejects(runNode(server, { resource: 'space', operation: 'update', spaceId: 's1' }), /Nothing to update/);
	});

	it('create space sends the embedder and an explicit default chunking config', async () => {
		server.route('POST', '/v1/spaces', (req) => ({ status: 201, body: { spaceId: 'new', ...req.json } }));
		await runNode(server, { resource: 'space', operation: 'create', name: 'n', embedderId: 'e1', labels: { entries: [{ key: 'a', value: 'b' }] } });
		const body = server.requests[0].json;
		assert.deepEqual(body.spaceEmbedders, [{ embedderId: 'e1' }]);
		assert.deepEqual(body.labels, { a: 'b' });
		assert.ok(body.defaultChunkingConfig, 'POST /spaces rejects a missing defaultChunkingConfig');
		assert.equal('publicRead' in body, false);
	});

	it('lists embedders and rerankers', async () => {
		server.route('GET', '/v1/embedders', () => ({ body: { embedders: [{ embedderId: 'e1' }] } }));
		server.route('GET', '/v1/rerankers', () => ({ body: { rerankers: [{ rerankerId: 'r1' }, { rerankerId: 'r2' }] } }));
		assert.equal((await runNode(server, { resource: 'embedder', operation: 'list' })).length, 1);
		assert.equal((await runNode(server, { resource: 'reranker', operation: 'list' })).length, 2);
	});

	it('continue-on-fail turns an error into an item instead of stopping the run', async () => {
		server.route('GET', '/v1/memories/missing', () => ({ status: 404, body: { error: 'not found' } }));
		const items = await runNode(server, { resource: 'memory', operation: 'get', memoryId: 'missing', includeContent: false }, { continueOnFail: true });
		assert.match(String(items[0].json.error), /404/);
	});
});
