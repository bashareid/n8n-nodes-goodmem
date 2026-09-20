import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import type { GoodmemResponse } from './GenericFunctions';
import {
	abstractReply,
	classify,
	decodeText,
	fileNameFor,
	goodmemRequest,
	hitsFromEvents,
	isTextual,
	listAll,
	parseNdjson,
	waitForMemory,
} from './GenericFunctions';

const CHUNKING_PROPERTIES = (resource: string, operation: string): INodeTypeDescription['properties'] => [
	{
		displayName: 'Chunking',
		name: 'chunking',
		type: 'options',
		noDataExpression: true,
		default: 'default',
		options: [
			{ name: 'Server Default', value: 'default' },
			{ name: 'None (Single Chunk)', value: 'none' },
			{ name: 'Custom (JSON)', value: 'custom' },
		],
		displayOptions: { show: { resource: [resource], operation: [operation] } },
		description: 'How content is split into chunks before embedding',
	},
	{
		displayName: 'Chunking Config (JSON)',
		name: 'chunkingConfigJson',
		type: 'json',
		default: '{"recursive":{"chunkSize":512,"chunkOverlap":64}}',
		displayOptions: { show: { resource: [resource], operation: [operation], chunking: ['custom'] } },
		description:
			'A GoodMem chunking configuration, e.g. {"recursive":{"chunkSize":512,"chunkOverlap":64}} or {"sentence":{"maxChunkSize":4000,"minChunkSize":100}}',
	},
];

const KEY_VALUE_COLLECTION = (
	displayName: string,
	name: string,
	description: string,
	show: IDataObject,
): INodeTypeDescription['properties'][number] => ({
	displayName,
	name,
	type: 'fixedCollection',
	typeOptions: { multipleValues: true },
	placeholder: `Add ${displayName.replace(/s$/, '')}`,
	default: {},
	displayOptions: { show: show as never },
	description,
	options: [
		{
			displayName: 'Entry',
			name: 'entries',
			values: [
				{ displayName: 'Key', name: 'key', type: 'string', default: '' },
				{ displayName: 'Value', name: 'value', type: 'string', default: '' },
			],
		},
	],
});

function collectionToObject(value: unknown): IDataObject {
	const out: IDataObject = {};
	const entries = ((value as IDataObject | undefined)?.entries ?? []) as IDataObject[];
	for (const entry of entries) {
		const key = String(entry.key ?? '').trim();
		if (key) out[key] = entry.value ?? '';
	}
	return out;
}

function parseJsonParameter(this: IExecuteFunctions, raw: unknown, name: string, i: number): IDataObject {
	if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as IDataObject;
	let parsed: unknown;
	try {
		parsed = JSON.parse(String(raw ?? ''));
	} catch {
		parsed = undefined;
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new NodeOperationError(this.getNode(), `${name} must be a JSON object.`, { itemIndex: i });
	}
	return parsed as IDataObject;
}

export class Goodmem implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Goodmem',
		name: 'goodmem',
		icon: { light: 'file:../../icons/goodmem.svg', dark: 'file:../../icons/goodmem.dark.svg' },
		group: ['input'],
		version: 2,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Store, search and manage memories in Goodmem',
		defaults: { name: 'Goodmem' },
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'goodmemApi', required: true }],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Embedder', value: 'embedder' },
					{ name: 'Memory', value: 'memory' },
					{ name: 'Reranker', value: 'reranker' },
					{ name: 'Space', value: 'space' },
				],
				default: 'memory',
			},

			/* ------------------------------------------------ embedder / reranker */
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['embedder'] } },
				options: [{ name: 'List', value: 'list', description: 'List embedders', action: 'List embedders' }],
				default: 'list',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['reranker'] } },
				options: [{ name: 'List', value: 'list', description: 'List rerankers', action: 'List rerankers' }],
				default: 'list',
			},

			/* ------------------------------------------------------------ space */
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['space'] } },
				options: [
					{ name: 'Create', value: 'create', description: 'Create a space', action: 'Create a space' },
					{ name: 'Delete', value: 'delete', description: 'Delete a space and everything in it', action: 'Delete a space' },
					{ name: 'Get', value: 'get', description: 'Get a space by ID', action: 'Get a space' },
					{ name: 'List', value: 'list', description: 'List spaces', action: 'List spaces' },
					{ name: 'Update', value: 'update', description: 'Rename a space or change its labels', action: 'Update a space' },
				],
				default: 'create',
			},
			{
				displayName: 'Space ID',
				name: 'spaceId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['space'], operation: ['delete', 'get', 'update'] } },
				description: 'The ID of the space',
			},
			{
				displayName: 'Name',
				name: 'name',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['space'], operation: ['create'] } },
				description: 'Name for the new space. Creation fails if a space with this name already exists.',
			},
			{
				displayName: 'Embedder ID',
				name: 'embedderId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['space'], operation: ['create'] } },
				description: 'ID of the embedder that will index this space. Use Embedder → List to find one.',
			},
			...CHUNKING_PROPERTIES('space', 'create'),
			KEY_VALUE_COLLECTION('Labels', 'labels', 'Labels for the space (at most 20)', {
				resource: ['space'],
				operation: ['create'],
			}),
			{
				displayName: 'New Name',
				name: 'newName',
				type: 'string',
				default: '',
				displayOptions: { show: { resource: ['space'], operation: ['update'] } },
				description: 'New name for the space. Leave empty to keep the current name.',
			},
			{
				displayName: 'Label Update',
				name: 'labelMode',
				type: 'options',
				noDataExpression: true,
				default: 'keep',
				options: [
					{ name: 'Keep Existing', value: 'keep' },
					{ name: 'Merge Into Existing', value: 'merge' },
					{ name: 'Replace All', value: 'replace' },
				],
				displayOptions: { show: { resource: ['space'], operation: ['update'] } },
			},
			KEY_VALUE_COLLECTION('Labels', 'updateLabels', 'Labels to merge or replace (at most 20)', {
				resource: ['space'],
				operation: ['update'],
				labelMode: ['merge', 'replace'],
			}),
			{
				displayName: 'Name Filter',
				name: 'nameFilter',
				type: 'string',
				default: '',
				displayOptions: { show: { resource: ['space'], operation: ['list'] } },
				description: 'Glob filter on space names, e.g. docs-*',
			},

			/* ----------------------------------------------------------- memory */
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['memory'] } },
				options: [
					{ name: 'Create', value: 'create', description: 'Store text or a file as a memory', action: 'Create a memory' },
					{ name: 'Delete', value: 'delete', description: 'Delete a memory', action: 'Delete a memory' },
					{ name: 'Download Content', value: 'downloadContent', description: 'Download the original content of a memory', action: 'Download memory content' },
					{ name: 'Get', value: 'get', description: 'Get a memory by ID', action: 'Get a memory' },
					{ name: 'List', value: 'list', description: 'List the memories in a space', action: 'List memories' },
					{ name: 'Retrieve', value: 'retrieve', description: 'Search memories semantically', action: 'Retrieve memories' },
				],
				default: 'retrieve',
			},
			{
				displayName: 'Memory ID',
				name: 'memoryId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['memory'], operation: ['delete', 'get', 'downloadContent'] } },
				description: 'The ID of the memory',
			},
			{
				displayName: 'Space ID',
				name: 'memorySpaceId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['memory'], operation: ['create', 'list'] } },
				description: 'The ID of the space',
			},
			{
				displayName: 'Include Content',
				name: 'includeContent',
				type: 'boolean',
				default: true,
				displayOptions: { show: { resource: ['memory'], operation: ['get'] } },
				description: 'Whether to return the stored content. Text arrives as a "content" field; other types as binary data.',
			},
			{
				displayName: 'Put Output File in Field',
				name: 'binaryPropertyName',
				type: 'string',
				default: 'data',
				displayOptions: { show: { resource: ['memory'], operation: ['downloadContent', 'get'] } },
				description: 'Name of the binary property to write non-text content to',
			},
			{
				displayName: 'Input Type',
				name: 'inputType',
				type: 'options',
				noDataExpression: true,
				default: 'text',
				options: [
					{ name: 'Text', value: 'text' },
					{ name: 'Binary File', value: 'binary' },
				],
				displayOptions: { show: { resource: ['memory'], operation: ['create'] } },
			},
			{
				displayName: 'Content',
				name: 'content',
				type: 'string',
				typeOptions: { rows: 5 },
				default: '',
				required: true,
				displayOptions: { show: { resource: ['memory'], operation: ['create'], inputType: ['text'] } },
				description: 'The text to store',
			},
			{
				displayName: 'Content Type',
				name: 'contentType',
				type: 'string',
				default: 'text/plain',
				displayOptions: { show: { resource: ['memory'], operation: ['create'], inputType: ['text'] } },
				description: 'MIME type of the text, e.g. text/plain or text/markdown',
			},
			{
				displayName: 'Input Binary Field',
				name: 'inputBinaryPropertyName',
				type: 'string',
				default: 'data',
				required: true,
				displayOptions: { show: { resource: ['memory'], operation: ['create'], inputType: ['binary'] } },
				description: 'Name of the binary property holding the file to store',
			},
			KEY_VALUE_COLLECTION('Metadata', 'metadata', 'Metadata stored with the memory. A "title" key helps some embedders.', {
				resource: ['memory'],
				operation: ['create'],
			}),
			...CHUNKING_PROPERTIES('memory', 'create'),
			{
				displayName: 'Wait for Indexing',
				name: 'wait',
				type: 'boolean',
				default: true,
				displayOptions: { show: { resource: ['memory'], operation: ['create'] } },
				description:
					'Whether to wait until the memory is indexed and searchable before continuing. Turn off to return immediately with status PENDING.',
			},
			{
				displayName: 'Indexing Timeout (Seconds)',
				name: 'waitTimeout',
				type: 'number',
				default: 120,
				typeOptions: { minValue: 1 },
				displayOptions: { show: { resource: ['memory'], operation: ['create'], wait: [true] } },
			},
			{
				displayName: 'Status Filter',
				name: 'statusFilter',
				type: 'options',
				default: '',
				options: [
					{ name: 'Any', value: '' },
					{ name: 'Completed', value: 'COMPLETED' },
					{ name: 'Failed', value: 'FAILED' },
					{ name: 'Pending', value: 'PENDING' },
					{ name: 'Processing', value: 'PROCESSING' },
				],
				displayOptions: { show: { resource: ['memory'], operation: ['list'] } },
			},

			/* --------------------------------------------------------- retrieve */
			{
				displayName: 'Query',
				name: 'query',
				type: 'string',
				typeOptions: { rows: 3 },
				default: '',
				required: true,
				displayOptions: { show: { resource: ['memory'], operation: ['retrieve'] } },
				description: 'What to search for, in natural language',
			},
			{
				displayName: 'Space IDs',
				name: 'spaceIds',
				type: 'string',
				typeOptions: { multipleValues: true, multipleValueButtonText: 'Add Space ID' },
				default: [],
				required: true,
				displayOptions: { show: { resource: ['memory'], operation: ['retrieve'] } },
				description: 'Spaces to search. At least one is required.',
			},
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				typeOptions: { minValue: 1 },
				default: 50,
				displayOptions: { show: { resource: ['memory'], operation: ['retrieve'] } },
				description: 'Max number of results to return',
			},
			{
				displayName: 'Filter',
				name: 'filter',
				type: 'string',
				default: '',
				displayOptions: { show: { resource: ['memory'], operation: ['retrieve'] } },
				placeholder: "CAST(val('$.category') AS TEXT) = 'policy'",
				description:
					"GoodMem filter expression applied to every space. Inside a quoted value escape ' as \\' and \\ as \\\\; SQL-style '' doubling is rejected by the server.",
			},
			{
				displayName: 'Options',
				name: 'retrieveOptions',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { resource: ['memory'], operation: ['retrieve'] } },
				options: [
					{
						displayName: 'Chronological Resort',
						name: 'chronologicalResort',
						type: 'boolean',
						default: false,
						description: 'Whether to order results by creation time instead of relevance. Requires a reranker.',
					},
					{
						displayName: 'Fetch Candidates',
						name: 'fetchK',
						type: 'number',
						typeOptions: { minValue: 1 },
						default: 0,
						description: 'Candidates to retrieve before reranking. 0 uses Limit.',
					},
					{
						displayName: 'Include Abstract Reply',
						name: 'includeAbstractReply',
						type: 'boolean',
						default: true,
						description: 'Whether to include the LLM-generated answer (when an LLM is set) on the first item',
					},
					{
						displayName: 'LLM ID',
						name: 'llmId',
						type: 'string',
						default: '',
						description: 'LLM to generate an answer from the retrieved passages',
					},
					{
						displayName: 'LLM Temperature',
						name: 'llmTemp',
						type: 'number',
						typeOptions: { minValue: 0, maxValue: 2, numberPrecision: 2 },
						default: 0.3,
					},
					{
						displayName: 'Relevance Threshold',
						name: 'relevanceThreshold',
						type: 'number',
						typeOptions: { numberPrecision: 3 },
						default: 0,
						description:
							'Minimum reranker score to keep a result. Only meaningful with a reranker; the score range depends on the reranker model. Ignored when 0.',
					},
					{
						displayName: 'Reranker ID',
						name: 'rerankerId',
						type: 'string',
						default: '',
						description: 'Reranker to improve result ordering. Use Reranker → List to find one.',
					},
				],
			},

			/* -------------------------------------------------- list (shared) */
			{
				displayName: 'Max Items',
				name: 'maxItems',
				type: 'number',
				typeOptions: { minValue: 1 },
				default: 100,
				displayOptions: {
					show: { operation: ['list'] },
				},
				description: 'Stop after this many items. Pages are followed automatically.',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const resource = this.getNodeParameter('resource', 0) as string;
		const operation = this.getNodeParameter('operation', 0) as string;

		for (let i = 0; i < items.length; i++) {
			try {
				const out = await runOperation.call(this, resource, operation, i);
				for (const item of out) item.pairedItem = { item: i };
				returnData.push(...out);
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (error as Error).message },
						pairedItem: { item: i },
					});
					continue;
				}
				// Re-wrapping a NodeApiError hands back the original with the
				// server's message intact; anything else becomes a node error.
				if (error instanceof NodeApiError) {
					throw new NodeApiError(this.getNode(), error as unknown as JsonObject, { itemIndex: i });
				}
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}
		return [returnData];
	}
}

async function runOperation(
	this: IExecuteFunctions,
	resource: string,
	operation: string,
	i: number,
): Promise<INodeExecutionData[]> {
	const one = (json: IDataObject, binary?: INodeExecutionData['binary']): INodeExecutionData[] => [
		binary ? { json, binary } : { json },
	];
	const many = (list: IDataObject[]): INodeExecutionData[] => list.map((json) => ({ json }));

	/* ---------------------------------------------------------------- lists */
	if (operation === 'list' && (resource === 'embedder' || resource === 'reranker')) {
		const maxItems = this.getNodeParameter('maxItems', i, 100) as number;
		const { items, truncated } = await listAll.call(
			this,
			resource === 'embedder' ? '/embedders' : '/rerankers',
			resource === 'embedder' ? 'embedders' : 'rerankers',
			{ maxItems, itemIndex: i },
		);
		return many(items.map((entry) => ({ ...(entry as IDataObject), truncated })));
	}

	/* ---------------------------------------------------------------- space */
	if (resource === 'space') {
		if (operation === 'list') {
			const maxItems = this.getNodeParameter('maxItems', i, 100) as number;
			const nameFilter = (this.getNodeParameter('nameFilter', i, '') as string).trim();
			const { items, truncated } = await listAll.call(this, '/spaces', 'spaces', {
				maxItems,
				itemIndex: i,
				qs: nameFilter ? { nameFilter } : {},
			});
			return many(items.map((entry) => ({ ...(entry as IDataObject), truncated })));
		}
		if (operation === 'create') {
			const body: IDataObject = {
				name: this.getNodeParameter('name', i) as string,
				spaceEmbedders: [{ embedderId: this.getNodeParameter('embedderId', i) as string }],
			};
			const labels = collectionToObject(this.getNodeParameter('labels', i, {}));
			if (Object.keys(labels).length) body.labels = labels;
			const chunking = this.getNodeParameter('chunking', i, 'default') as string;
			if (chunking === 'none') body.defaultChunkingConfig = { none: {} };
			else if (chunking === 'custom') {
				body.defaultChunkingConfig = parseJsonParameter.call(
					this,
					this.getNodeParameter('chunkingConfigJson', i),
					'Chunking Config',
					i,
				);
			}
			// Server default chunking otherwise: POST /spaces rejects a missing
			// defaultChunkingConfig, so the documented default is sent explicitly.
			if (!body.defaultChunkingConfig) {
				body.defaultChunkingConfig = { recursive: { chunkSize: 512, chunkOverlap: 64 } };
			}
			const { body: space } = await goodmemRequest.call(this, { method: 'POST', path: '/spaces', body, itemIndex: i });
			return one(space as IDataObject);
		}
		const spaceId = this.getNodeParameter('spaceId', i) as string;
		const path = `/spaces/${encodeURIComponent(spaceId)}`;
		if (operation === 'get') {
			const { body } = await goodmemRequest.call(this, { method: 'GET', path, itemIndex: i });
			return one(body as IDataObject);
		}
		if (operation === 'delete') {
			await goodmemRequest.call(this, { method: 'DELETE', path, itemIndex: i });
			return one({ deleted: true, spaceId });
		}
		if (operation === 'update') {
			const body: IDataObject = {};
			const newName = (this.getNodeParameter('newName', i, '') as string).trim();
			if (newName) body.name = newName;
			const labelMode = this.getNodeParameter('labelMode', i, 'keep') as string;
			if (labelMode !== 'keep') {
				const labels = collectionToObject(this.getNodeParameter('updateLabels', i, {}));
				body[labelMode === 'merge' ? 'mergeLabels' : 'replaceLabels'] = labels;
			}
			if (!Object.keys(body).length) {
				throw new NodeOperationError(this.getNode(), 'Nothing to update: set a new name or a label change.', { itemIndex: i });
			}
			const { body: space } = await goodmemRequest.call(this, { method: 'PUT', path, body, itemIndex: i });
			return one(space as IDataObject);
		}
	}

	/* --------------------------------------------------------------- memory */
	if (resource === 'memory') {
		if (operation === 'retrieve') return retrieve.call(this, i);

		if (operation === 'list') {
			const spaceId = this.getNodeParameter('memorySpaceId', i) as string;
			const maxItems = this.getNodeParameter('maxItems', i, 100) as number;
			const statusFilter = this.getNodeParameter('statusFilter', i, '') as string;
			const { items, truncated } = await listAll.call(
				this,
				`/spaces/${encodeURIComponent(spaceId)}/memories`,
				'memories',
				{ maxItems, itemIndex: i, qs: statusFilter ? { statusFilter } : {} },
			);
			return many(items.map((entry) => ({ ...(entry as IDataObject), truncated })));
		}

		if (operation === 'create') {
			const spaceId = this.getNodeParameter('memorySpaceId', i) as string;
			const body: IDataObject = { spaceId };
			const inputType = this.getNodeParameter('inputType', i, 'text') as string;
			if (inputType === 'binary') {
				const property = this.getNodeParameter('inputBinaryPropertyName', i) as string;
				const binary = this.helpers.assertBinaryData(i, property);
				const buffer = await this.helpers.getBinaryDataBuffer(i, property);
				body.contentType = binary.mimeType || 'application/octet-stream';
				body.originalContentB64 = buffer.toString('base64');
				const metadata = collectionToObject(this.getNodeParameter('metadata', i, {}));
				if (binary.fileName && metadata.title === undefined) metadata.title = binary.fileName;
				if (Object.keys(metadata).length) body.metadata = metadata;
			} else {
				const content = this.getNodeParameter('content', i) as string;
				if (!content.trim()) {
					throw new NodeOperationError(this.getNode(), 'Content must not be empty.', { itemIndex: i });
				}
				body.originalContent = content;
				body.contentType = (this.getNodeParameter('contentType', i, 'text/plain') as string) || 'text/plain';
				const metadata = collectionToObject(this.getNodeParameter('metadata', i, {}));
				if (Object.keys(metadata).length) body.metadata = metadata;
			}
			const chunking = this.getNodeParameter('chunking', i, 'default') as string;
			if (chunking === 'none') body.chunkingConfig = { none: {} };
			else if (chunking === 'custom') {
				body.chunkingConfig = parseJsonParameter.call(this, this.getNodeParameter('chunkingConfigJson', i), 'Chunking Config', i);
			}
			const { body: created } = await goodmemRequest.call(this, { method: 'POST', path: '/memories', body, itemIndex: i });
			const memory = created as IDataObject;
			if (this.getNodeParameter('wait', i, true) as boolean) {
				const timeout = this.getNodeParameter('waitTimeout', i, 120) as number;
				memory.processingStatus = await waitForMemory.call(this, String(memory.memoryId), {
					timeoutMs: timeout * 1000,
					itemIndex: i,
				});
			}
			return one(memory);
		}

		const memoryId = this.getNodeParameter('memoryId', i) as string;
		const path = `/memories/${encodeURIComponent(memoryId)}`;

		if (operation === 'delete') {
			await goodmemRequest.call(this, { method: 'DELETE', path, itemIndex: i });
			return one({ deleted: true, memoryId });
		}

		if (operation === 'get') {
			const includeContent = this.getNodeParameter('includeContent', i, true) as boolean;
			const { body } = await goodmemRequest.call(this, {
				method: 'GET',
				path,
				qs: includeContent ? { includeContent: 'true' } : {},
				itemIndex: i,
			});
			const memory = { ...(body as IDataObject) };
			const encoded = memory.originalContent;
			delete memory.originalContent;
			if (includeContent && typeof encoded === 'string') {
				// The server sends content base64-encoded inside the JSON.
				const buffer = Buffer.from(encoded, 'base64');
				const contentType = String(memory.contentType ?? 'application/octet-stream');
				return emitContent.call(this, memory, buffer, contentType, memoryId, i);
			}
			return one(memory);
		}

		if (operation === 'downloadContent') {
			const { body: meta } = await goodmemRequest.call(this, { method: 'GET', path, itemIndex: i });
			const { body, headers } = (await goodmemRequest.call(this, {
				method: 'GET',
				path: `${path}/content`,
				encoding: 'arraybuffer',
				itemIndex: i,
			})) as GoodmemResponse<Buffer>;
			const memory = meta as IDataObject;
			const contentType = headers['content-type'] || String(memory.contentType ?? 'application/octet-stream');
			return emitContent.call(this, memory, body, contentType, memoryId, i);
		}
	}

	throw new NodeOperationError(this.getNode(), `Unsupported operation "${resource}:${operation}".`, { itemIndex: i });
}

/** Text content becomes a readable field; anything else becomes n8n binary data. */
async function emitContent(
	this: IExecuteFunctions,
	memory: IDataObject,
	buffer: Buffer,
	contentType: string,
	memoryId: string,
	i: number,
): Promise<INodeExecutionData[]> {
	const json: IDataObject = { ...memory, contentType, contentLength: buffer.length };
	if (isTextual(contentType)) {
		const decoded = decodeText(buffer, contentType);
		if (decoded?.text !== undefined) {
			json.content = decoded.text;
			return [{ json }];
		}
		// Undecodable text is handed over as bytes with the reason attached.
		if (decoded?.error) json.contentError = decoded.error;
	}
	const property = this.getNodeParameter('binaryPropertyName', i, 'data') as string;
	const fileName = fileNameFor(memory, memoryId, contentType);
	const binary = await this.helpers.prepareBinaryData(buffer, fileName, contentType.split(';')[0].trim());
	return [{ json, binary: { [property]: binary } }];
}

async function retrieve(this: IExecuteFunctions, i: number): Promise<INodeExecutionData[]> {
	const query = (this.getNodeParameter('query', i) as string).trim();
	if (!query) throw new NodeOperationError(this.getNode(), 'Query must not be empty.', { itemIndex: i });
	const spaceIds = (this.getNodeParameter('spaceIds', i) as string[]).map((s) => s.trim()).filter(Boolean);
	if (!spaceIds.length) throw new NodeOperationError(this.getNode(), 'At least one Space ID is required.', { itemIndex: i });
	const limit = this.getNodeParameter('limit', i, 10) as number;
	const filter = (this.getNodeParameter('filter', i, '') as string).trim();
	const options = this.getNodeParameter('retrieveOptions', i, {}) as IDataObject;
	const rerankerId = String(options.rerankerId ?? '').trim();
	const llmId = String(options.llmId ?? '').trim();
	const fetchK = Number(options.fetchK ?? 0) || 0;
	const relevanceThreshold = Number(options.relevanceThreshold ?? 0) || 0;

	if (relevanceThreshold && !rerankerId) {
		throw new NodeOperationError(
			this.getNode(),
			'Relevance Threshold needs a Reranker ID: vector scores are not on a fixed scale.',
			{ itemIndex: i },
		);
	}

	const body: IDataObject = {
		message: query,
		spaceKeys: spaceIds.map((spaceId) => (filter ? { spaceId, filter } : { spaceId })),
		requestedSize: fetchK > 0 ? Math.max(fetchK, limit) : limit,
		fetchMemory: true,
	};
	if (rerankerId || llmId) {
		const config: IDataObject = { max_results: limit };
		if (rerankerId) config.reranker_id = rerankerId;
		if (llmId) {
			config.llm_id = llmId;
			config.llm_temp = Number(options.llmTemp ?? 0.3);
		}
		if (relevanceThreshold) config.relevance_threshold = relevanceThreshold;
		if (options.chronologicalResort === true) config.chronological_resort = true;
		body.postProcessor = { name: 'com.goodmem.retrieval.postprocess.ChatPostProcessorFactory', config };
	}

	const { body: text } = (await goodmemRequest.call(this, {
		method: 'POST',
		path: '/memories:retrieve',
		body,
		encoding: 'text',
		accept: 'application/x-ndjson',
		itemIndex: i,
	})) as GoodmemResponse<string>;

	const parsed = parseNdjson(typeof text === 'string' ? text : String(text ?? ''));
	const { statuses, degraded } = classify(parsed);
	const hits = hitsFromEvents(parsed.events, Boolean(rerankerId)).slice(0, limit);

	// A search that failed outright must not look like one that found nothing.
	if (degraded && hits.length === 0) {
		const summary = statuses.map((s) => `${String(s.code)}: ${String(s.message ?? '')}`).join('; ');
		throw new NodeOperationError(this.getNode(), `Retrieval failed: ${summary}`, {
			itemIndex: i,
			description: JSON.stringify(statuses),
		});
	}

	const reply = options.includeAbstractReply !== false ? abstractReply(parsed.events) : undefined;
	return hits.map((hit, index) => {
		const json: IDataObject = {
			...hit,
			query,
			// True when part of the search did not complete: results are
			// usable but may be incomplete. The statuses say why.
			partial: degraded,
			statuses,
		};
		if (index === 0 && reply) json.abstractReply = reply;
		return { json };
	});
}
