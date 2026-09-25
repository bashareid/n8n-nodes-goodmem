'use strict';
/*
 * Every ID the node sends must be a UUID, checked before any request is made.
 *
 * External report against n8n 1.0.1: Memory → Delete with Memory ID
 * "../spaces/<id>" or "%2e%2e/spaces/<id>", typed or chosen by an AI agent via
 * $fromAI(), deleted the whole space and reported {"deleted": true}. 2.0
 * percent-encoded IDs before this check, and that was not enough.
 * encodeURIComponent leaves "." and ".." as they are, and the HTTP client
 * (fetch here, axios in n8n) resolves them: Space → Delete with Space ID ".."
 * sent DELETE /v1/ and reported {"deleted": true}, and Memory → List with ".."
 * sent GET /v1/memories. Every other value was sent encoded, e.g.
 * DELETE /v1/spaces/..%2Fspaces%2F<id>, and a 2xx still came back as success;
 * what happens to %2F on the way to GoodMem is not the node's to decide.
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

const { requireUuid } = require('../dist/nodes/Goodmem/GenericFunctions');
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
	// Dot segments. Percent-encoding leaves them as they are and the HTTP client
	// resolves them, so without the check ".." as a Space ID sent DELETE /v1/.
	'..',
	'.',
	// Not UUIDs, yet free of "/", "\", "%", "?", "#" and whitespace, so a check
	// that only refuses URL-special characters would let them through.
	'...',
	'mem-1',
	U.replace(/-/g, ''),
	`{${U}}`,
	`urn:uuid:${U}`,
	`${U}0`,
	`${U}${U}`,
	U.replace('a', '\u0430'), // Cyrillic a
	U.replace('3', '\uff13'), // fullwidth digit three
	'\u2024\u2024', // one dot leader, twice
	'\uff0e\uff0e', // fullwidth full stop, twice
	`..\\spaces\\${U}`,
];
// Only a string can be a UUID, even one whose String() form looks like one.
const NON_STRINGS = [undefined, null, 42, true, {}, [U], new String(U), { toString: () => U }];

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
					const blankSpaceIds = payload === '' && entry.name.includes('Retrieve');
					assert.match(error.message, blankSpaceIds ? /is required/ : /must be a UUID/);
					if (!blankSpaceIds) {
						assert.ok(
							error.description.startsWith(`Received ${JSON.stringify(payload)}.`),
							`description: ${error.description}`,
						);
						assert.match(error.description, /no request is made/);
					}
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
		for (const value of NON_STRINGS) {
			server.reset();
			const error = await refusal({ resource: 'memory', operation: 'delete', memoryId: value });
			assert.match(error.message, /Memory ID must be a UUID/, `for ${JSON.stringify(value)}`);
			assert.deepEqual(server.wire(), []);
		}
	});

	it('percent-encoding alone does not stop ".." or "." (why the check exists)', async () => {
		// What 2.0 sent for Space → Delete before the check: the ID encoded, nothing else.
		server.reset();
		server.route('DELETE', /.*/, () => ({ body: {} }));
		for (const id of ['..', '.']) {
			await fetch(`${server.baseUrl}/v1/spaces/${encodeURIComponent(id)}`, { method: 'DELETE' });
		}
		assert.deepEqual(server.wire(), ['DELETE /v1/', 'DELETE /v1/spaces/']);
	});

	it('names the memory by its checked, lower-case ID when waiting for it times out', async () => {
		server.reset();
		server.route('POST', '/v1/memories', () => ({ status: 201, body: { memoryId: U.toUpperCase(), processingStatus: 'PENDING' } }));
		server.route('GET', /.*/, () => ({ body: { processingStatus: 'PENDING' } }));
		const error = await refusal({ resource: 'memory', operation: 'create', memorySpaceId: U, inputType: 'text', content: 'hi', wait: true, waitTimeout: 0 });
		assert.ok(error instanceof NodeOperationError);
		assert.equal(
			error.message,
			`Memory ${U} was still PENDING after 0s. It was created; check its processing status rather than storing it again.`,
		);
		assert.equal(error.description, `memoryId: ${U}`);
		assert.equal(error.context.itemIndex, 0);
		assert.deepEqual(server.wire(), ['POST /v1/memories', `GET /v1/memories/${U}`]);
	});

	it('ignores blank Space IDs entries and treats a blank Reranker or LLM ID as none', async () => {
		await runNode(server, retrieve({ spaceIds: ['', U.toUpperCase(), '  '], retrieveOptions: { rerankerId: '', llmId: '  ' } }));
		assert.deepEqual(server.wire(), ['POST /v1/memories:retrieve']);
		assert.deepEqual(server.requests[0].json.spaceKeys, [{ spaceId: U }]);
		assert.equal('postProcessor' in server.requests[0].json, false);
	});
});

describe('requireUuid, the one ID check', () => {
	const ctx = { getNode: () => ({ name: 'Goodmem', type: 'goodmem', typeVersion: 2, position: [0, 0], parameters: {} }) };

	it('accepts a UUID in any case and returns it in lower case', () => {
		const accepted = [
			[U, U],
			[U.toUpperCase(), U],
			['3F2b1C9a-7D4e-4A6b-9C8d-1E2f3A4b5C6d', U],
			['00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000'],
			['FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF', 'ffffffff-ffff-ffff-ffff-ffffffffffff'],
		];
		for (const [value, expected] of accepted) assert.equal(requireUuid.call(ctx, value, 'Test ID', 0), expected);
	});

	it('refuses everything else, naming the field and the item', () => {
		for (const value of [...PAYLOADS, ...NON_STRINGS]) {
			assert.throws(
				() => requireUuid.call(ctx, value, 'Test ID', 3),
				(error) =>
					error instanceof NodeOperationError &&
					error.message.startsWith('Test ID must be a UUID') &&
					error.context.itemIndex === 3,
				`accepted ${JSON.stringify(value)}`,
			);
		}
	});

	it('says why without claiming that every ID goes into the URL', () => {
		// Embedder, reranker and LLM IDs go in the request body; they are checked all the same.
		assert.throws(
			() => requireUuid.call(ctx, '..', 'Embedder ID', 0),
			(error) =>
				error.description ===
				'Received "..". GoodMem IDs are UUIDs. Memory and space IDs are put into request URLs, where a value such as ".." could address a different resource, so every ID is checked the same way: any other value is refused and no request is made with it.',
		);
	});
});
