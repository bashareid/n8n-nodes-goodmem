'use strict';
/*
 * Every ID the node sends must be a UUID, checked before any request is made.
 *
 * External report against n8n 1.0.1: Memory → Delete with Memory ID
 * "../spaces/<id>" or "%2e%2e/spaces/<id>", typed or chosen by an AI agent via
 * $fromAI(), deleted the whole space and reported {"deleted": true}. 2.0
 * percent-encoded IDs, which kept dot segments inside one path segment, but
 * every such value was still sent and a 2xx still came back as success; what
 * happens to %2F on the way to GoodMem is not the node's to decide.
 *
 * The recording server here answers 200 to everything, like a server or proxy
 * that accepted the request. For each ID-taking operation, each payload must
 * be refused with a NodeOperationError that names the field and the item, and
 * the server must record no request at all. A valid UUID must still reach
 * exactly the intended path.
 */

const assert = require('node:assert/strict');
const { after, before, beforeEach, describe, it } = require('node:test');
const { NodeOperationError } = require('n8n-workflow');

const { MockServer, runNode } = require('./harness');

const U = '3f2b1c9a-7d4e-4a6b-9c8d-1e2f3a4b5c6d';
const PAYLOADS = [
	`../spaces/${U}`,
	`a/../../spaces/${U}`,
	`%2e%2e/spaces/${U}`,
	`..%2Fspaces%2F${U}`,
	`${U}/../../spaces/${U}`,
	'',
	` ${U}`,
	`${U}?x=1`,
	`${U}#frag`,
	`${U}\n`,
];

/** Operations that put the ID into the URL path. */
const PATH_IDS = [
	{
		name: 'Memory → Delete',
		field: 'Memory ID',
		params: (id) => ({ resource: 'memory', operation: 'delete', memoryId: id }),
		wire: [`DELETE /v1/memories/${U}`],
		json: { deleted: true, memoryId: U },
	},
	{
		name: 'Memory → Get',
		field: 'Memory ID',
		params: (id) => ({ resource: 'memory', operation: 'get', memoryId: id, includeContent: false }),
		wire: [`GET /v1/memories/${U}`],
	},
	{
		name: 'Memory → Download Content',
		field: 'Memory ID',
		params: (id) => ({ resource: 'memory', operation: 'downloadContent', memoryId: id }),
		wire: [`GET /v1/memories/${U}`, `GET /v1/memories/${U}/content`],
	},
	{
		name: 'Memory → List (space ID)',
		field: 'Space ID',
		params: (id) => ({ resource: 'memory', operation: 'list', memorySpaceId: id, maxItems: 100 }),
		wire: [`GET /v1/spaces/${U}/memories?maxResults=100`],
	},
	{
		name: 'Space → Get',
		field: 'Space ID',
		params: (id) => ({ resource: 'space', operation: 'get', spaceId: id }),
		wire: [`GET /v1/spaces/${U}`],
	},
	{
		name: 'Space → Delete',
		field: 'Space ID',
		params: (id) => ({ resource: 'space', operation: 'delete', spaceId: id }),
		wire: [`DELETE /v1/spaces/${U}`],
		json: { deleted: true, spaceId: U },
	},
	{
		name: 'Space → Update',
		field: 'Space ID',
		params: (id) => ({ resource: 'space', operation: 'update', spaceId: id, newName: 'renamed' }),
		wire: [`PUT /v1/spaces/${U}`],
	},
];

/** Operations that put the ID into the request body: not a path, checked the same way. */
const retrieve = (extra) => ({ resource: 'memory', operation: 'retrieve', query: 'q', spaceIds: [U], limit: 5, ...extra });
const BODY_IDS = [
	{
		name: 'Memory → Create (space ID)',
		field: 'Space ID',
		params: (id) => ({ resource: 'memory', operation: 'create', memorySpaceId: id, inputType: 'text', content: 'hi', wait: false }),
		wire: ['POST /v1/memories'],
		sent: (body) => body.spaceId,
	},
	{
		name: 'Space → Create (embedder ID)',
		field: 'Embedder ID',
		params: (id) => ({ resource: 'space', operation: 'create', name: 'n', embedderId: id }),
		wire: ['POST /v1/spaces'],
		sent: (body) => body.spaceEmbedders[0].embedderId,
	},
	{
		name: 'Memory → Retrieve (space IDs)',
		field: 'Space ID',
		params: (id) => retrieve({ spaceIds: [id] }),
		wire: ['POST /v1/memories:retrieve'],
		sent: (body) => body.spaceKeys[0].spaceId,
	},
	{
		// Blank means "no reranker", so '' is not an ID here.
		name: 'Memory → Retrieve (reranker ID)',
		field: 'Reranker ID',
		optional: true,
		params: (id) => retrieve({ retrieveOptions: { rerankerId: id } }),
		wire: ['POST /v1/memories:retrieve'],
		sent: (body) => body.postProcessor.config.reranker_id,
	},
	{
		name: 'Memory → Retrieve (LLM ID)',
		field: 'LLM ID',
		optional: true,
		params: (id) => retrieve({ retrieveOptions: { llmId: id } }),
		wire: ['POST /v1/memories:retrieve'],
		sent: (body) => body.postProcessor.config.llm_id,
	},
];

describe('IDs are UUIDs, checked before any request', () => {
	const server = new MockServer();
	before(() => server.start());
	after(() => server.stop());
	beforeEach(() => {
		server.reset();
		// Accept everything, as a permissive server or proxy would.
		const ok = () => ({ body: { memoryId: U, spaceId: U, contentType: 'text/plain', memories: [], processingStatus: 'COMPLETED' } });
		for (const method of ['GET', 'POST', 'PUT', 'DELETE']) server.route(method, /.*/, ok);
	});

	/** Run and return the error; fail with what was sent if the node accepted the value. */
	async function refusal(params, options) {
		return runNode(server, params, options).then(
			(items) =>
				assert.fail(
					`accepted: returned ${JSON.stringify(items.map((item) => item.json))}; server received ${JSON.stringify(server.wire())}`,
				),
			(error) => error,
		);
	}

	for (const entry of [...PATH_IDS, ...BODY_IDS]) {
		describe(entry.name, () => {
			for (const payload of PAYLOADS) {
				if (payload === '' && entry.optional) continue;
				it(`refuses ${JSON.stringify(payload)} and sends nothing`, async () => {
					const error = await refusal(entry.params(payload));
					assert.ok(error instanceof NodeOperationError, `expected a NodeOperationError, got ${error?.constructor?.name}: ${error?.message}; server received ${JSON.stringify(server.wire())}`);
					assert.match(error.message, new RegExp(entry.field));
					// A blank entry in the Space IDs list is dropped, which leaves none.
					assert.match(error.message, payload === '' && entry.name.includes('Retrieve') ? /is required/ : /must be a UUID/);
					assert.equal(error.context.itemIndex, 0);
					assert.deepEqual(server.wire(), [], `server received ${JSON.stringify(server.wire())}`);
				});
			}

			it('sends a valid UUID to exactly the intended request', async () => {
				const items = await runNode(server, entry.params(U));
				assert.deepEqual(server.wire(), entry.wire);
				if (entry.json) assert.deepEqual(items[0].json, entry.json);
				if (entry.sent) assert.equal(entry.sent(server.requests[0].json), U);
			});

			it('sends an upper-case UUID in canonical lower case', async () => {
				await runNode(server, entry.params(U.toUpperCase()));
				assert.deepEqual(server.wire(), entry.wire);
				if (entry.sent) assert.equal(entry.sent(server.requests[0].json), U);
			});
		});
	}

	it('refuses a non-UUID memory ID returned by the server instead of polling it', async () => {
		// Memory → Create with "Wait for Indexing" polls GET /memories/<the id the server returned>.
		server.reset();
		server.route('POST', '/v1/memories', () => ({ status: 201, body: { memoryId: `../spaces/${U}`, processingStatus: 'PENDING' } }));
		server.route('GET', /.*/, () => ({ body: { processingStatus: 'COMPLETED' } }));
		const error = await refusal({ resource: 'memory', operation: 'create', memorySpaceId: U, inputType: 'text', content: 'hi', wait: true, waitTimeout: 5 });
		assert.ok(error instanceof NodeOperationError);
		assert.match(error.message, /Memory ID from the server must be a UUID/);
		assert.deepEqual(server.wire(), ['POST /v1/memories'], `server received ${JSON.stringify(server.wire())}`);
	});

	it('names the item that carried the bad ID and sends the good items before it', async () => {
		const good = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
		const error = await refusal((i) => ({ resource: 'memory', operation: 'delete', memoryId: i === 0 ? good : `../spaces/${U}` }), {
			items: [{ json: {} }, { json: {} }],
		});
		assert.ok(error instanceof NodeOperationError);
		assert.equal(error.context.itemIndex, 1);
		assert.deepEqual(server.wire(), [`DELETE /v1/memories/${good}`]);
	});

	it('with continue-on-fail, reports the bad item as an error and never as deleted', async () => {
		const good = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
		const items = await runNode(server, (i) => ({ resource: 'space', operation: 'delete', spaceId: i === 0 ? good : `%2e%2e/spaces/${U}` }), {
			items: [{ json: {} }, { json: {} }],
			continueOnFail: true,
		});
		assert.deepEqual(items[0].json, { deleted: true, spaceId: good });
		assert.match(String(items[1].json.error), /Space ID must be a UUID/);
		assert.equal('deleted' in items[1].json, false);
		assert.deepEqual(server.wire(), [`DELETE /v1/spaces/${good}`]);
	});

	it('refuses IDs that are not strings at all', async () => {
		for (const value of [undefined, null, 42, {}, [U]]) {
			server.reset();
			const error = await refusal({ resource: 'memory', operation: 'delete', memoryId: value });
			assert.match(error.message, /Memory ID must be a UUID/, `for ${JSON.stringify(value)}`);
			assert.deepEqual(server.wire(), []);
		}
	});
});
