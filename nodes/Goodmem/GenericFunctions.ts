import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError, sleep } from 'n8n-workflow';

/*
 * HTTP goes through n8n's own request helper. The node has no runtime
 * dependencies, which n8n's community-node verification requires.
 */

export type Encoding = 'json' | 'text' | 'arraybuffer';

export interface GoodmemRequestOptions {
	method: IHttpRequestMethods;
	path: string;
	qs?: IDataObject;
	body?: IDataObject;
	encoding?: Encoding;
	accept?: string;
	itemIndex?: number;
}

export interface GoodmemResponse<T = unknown> {
	statusCode: number;
	headers: Record<string, string>;
	body: T;
}

function normalizeHeaders(headers: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	if (headers && typeof headers === 'object') {
		for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
			out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value ?? '');
		}
	}
	return out;
}

function serverMessage(body: unknown, statusCode: number): string {
	// The server answers with {"error": "..."} or {"errors": [{"field","message"}]}.
	let parsed: unknown = body;
	let text: string | undefined;
	if (Buffer.isBuffer(body)) text = body.toString('utf8');
	else if (typeof body === 'string') text = body;
	if (text !== undefined) {
		try {
			parsed = JSON.parse(text);
		} catch {
			return text.trim() || `HTTP ${statusCode}`;
		}
	}
	if (parsed && typeof parsed === 'object') {
		const obj = parsed as IDataObject;
		if (typeof obj.error === 'string') return obj.error;
		if (Array.isArray(obj.errors)) {
			const parts = (obj.errors as IDataObject[]).map((e) =>
				e.field ? `${String(e.field)}: ${String(e.message)}` : String(e.message),
			);
			if (parts.length) return parts.join('; ');
		}
		if (typeof obj.message === 'string') return obj.message;
	}
	return `HTTP ${statusCode}`;
}

export async function getBaseUrl(this: IExecuteFunctions): Promise<string> {
	const credentials = await this.getCredentials('goodmemApi');
	const server = String(credentials.server ?? '').trim();
	if (!server) {
		throw new NodeOperationError(this.getNode(), 'The Goodmem credential has no server URL.');
	}
	return server.replace(/\/+$/, '') + '/v1';
}

/**
 * One request, with the server's own error text preserved.
 *
 * Status errors are handled here rather than by the helper's default so that
 * the message a user sees is the server's ("A space with this name already
 * exists"), not a generic "request is invalid".
 */
export async function goodmemRequest<T = unknown>(
	this: IExecuteFunctions,
	options: GoodmemRequestOptions,
): Promise<GoodmemResponse<T>> {
	const encoding = options.encoding ?? 'json';
	const accept =
		options.accept ??
		(encoding === 'json' ? 'application/json' : encoding === 'text' ? 'application/x-ndjson' : '*/*');

	const request: IHttpRequestOptions = {
		method: options.method,
		baseURL: await getBaseUrl.call(this),
		url: options.path,
		qs: options.qs,
		headers: { Accept: accept },
		encoding,
		json: encoding === 'json',
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
	};
	if (options.body !== undefined) {
		request.body = options.body;
		request.headers = { ...request.headers, 'Content-Type': 'application/json' };
		if (encoding !== 'json') {
			// The helper only serializes objects when json is set; keep the wire
			// body JSON while receiving text/bytes.
			request.body = JSON.stringify(options.body);
		}
	}

	const raw = (await this.helpers.httpRequestWithAuthentication.call(
		this,
		'goodmemApi',
		request,
	)) as { statusCode?: number; headers?: unknown; body?: unknown };

	const statusCode = Number(raw.statusCode ?? 0);
	const headers = normalizeHeaders(raw.headers);
	let body: unknown = raw.body;
	if (encoding === 'arraybuffer' && body !== undefined && !Buffer.isBuffer(body)) {
		body = Buffer.from(body as ArrayBuffer);
	}

	if (statusCode >= 400) {
		const message = serverMessage(body, statusCode);
		const errorBody: JsonObject =
			body && typeof body === 'object' && !Buffer.isBuffer(body)
				? (body as JsonObject)
				: { error: Buffer.isBuffer(body) ? body.toString('utf8') : String(body ?? '') };
		throw new NodeApiError(this.getNode(), errorBody, {
			message: `GoodMem ${statusCode}: ${message}`,
			description: `${options.method} ${options.path}`,
			httpCode: String(statusCode),
			itemIndex: options.itemIndex,
		});
	}

	return { statusCode, headers, body: body as T };
}

/** Follow nextToken pagination until the server stops or maxItems is reached. */
export async function listAll<T = IDataObject>(
	this: IExecuteFunctions,
	path: string,
	key: string,
	options: { qs?: IDataObject; maxItems?: number; itemIndex?: number } = {},
): Promise<{ items: T[]; truncated: boolean }> {
	const maxItems = options.maxItems && options.maxItems > 0 ? options.maxItems : Infinity;
	const items: T[] = [];
	let nextToken: string | undefined;
	const seenTokens = new Set<string>();

	for (;;) {
		const qs: IDataObject = { ...(options.qs ?? {}) };
		if (Number.isFinite(maxItems)) qs.maxResults = Math.min(1000, maxItems - items.length);
		if (nextToken) qs.nextToken = nextToken;
		const { body } = await goodmemRequest.call(this, {
			method: 'GET',
			path,
			qs,
			itemIndex: options.itemIndex,
		});
		const page = (body as IDataObject) ?? {};
		const chunk = (Array.isArray(page[key]) ? page[key] : []) as T[];
		items.push(...chunk);
		const token = typeof page.nextToken === 'string' && page.nextToken ? page.nextToken : undefined;
		if (items.length >= maxItems) return { items: items.slice(0, maxItems), truncated: !!token };
		if (!token || chunk.length === 0) return { items, truncated: false };
		if (seenTokens.has(token)) {
			throw new NodeOperationError(
				this.getNode(),
				'Pagination loop: the server returned the same nextToken twice.',
			);
		}
		seenTokens.add(token);
		nextToken = token;
	}
}

const TERMINAL = new Set(['COMPLETED', 'FAILED']);

/**
 * Wait for one specific memory to finish indexing.
 *
 * This is the only correct place to wait: searching repeatedly until results
 * appear cannot distinguish "not indexed yet" from "nothing matches".
 */
export async function waitForMemory(
	this: IExecuteFunctions,
	memoryId: string,
	options: { timeoutMs: number; intervalMs?: number; itemIndex?: number },
): Promise<string> {
	const deadline = Date.now() + options.timeoutMs;
	const intervalMs = options.intervalMs ?? 500;
	let status = 'PENDING';
	for (;;) {
		const { body } = await goodmemRequest.call(this, {
			method: 'GET',
			path: `/memories/${encodeURIComponent(memoryId)}`,
			itemIndex: options.itemIndex,
		});
		status = String((body as IDataObject).processingStatus ?? 'PENDING');
		if (TERMINAL.has(status)) return status;
		if (Date.now() >= deadline) {
			throw new NodeOperationError(
				this.getNode(),
				`Memory ${memoryId} was still ${status} after ${options.timeoutMs / 1000}s. It was created; check its processing status rather than storing it again.`,
				{ itemIndex: options.itemIndex, description: `memoryId: ${memoryId}` },
			);
		}
		await sleep(intervalMs);
	}
}

/* ------------------------------------------------------------------ */
/* Retrieval stream handling. Pure functions, unit tested directly.   */
/* ------------------------------------------------------------------ */

export interface GoodmemStatus {
	code?: string;
	message?: string;
	details?: IDataObject;
}

export interface RetrieveEvent {
	status?: GoodmemStatus;
	retrievedItem?: IDataObject;
	memoryDefinition?: IDataObject;
	abstractReply?: IDataObject;
	resultSetBoundary?: IDataObject;
}

export interface ParsedStream {
	events: RetrieveEvent[];
	malformedLines: number;
}

/** Status codes this version knows. Anything else is a newer server's. */
export const KNOWN_STATUS_CODES = new Set([
	'GOODMEM_STATUS_CODE_UNSPECIFIED',
	'INVALID_ARGUMENT',
	'NOT_FOUND',
	'PERMISSION_DENIED',
	'FAILED_PRECONDITION',
	'EMBEDDER_FAILED',
	'EMBEDDER_UNAVAILABLE',
	'EMBEDDER_TIMEOUT',
	'VECTOR_SEARCH_FAILED',
	'VECTOR_SEARCH_PARTIAL',
	'VECTOR_SEARCH_TIMEOUT',
	'SPACE_INACCESSIBLE',
	'SPACE_NOT_FOUND',
	'SPACE_NO_EMBEDDERS',
	'CHUNK_NOT_FOUND',
	'MEMORY_LOAD_FAILED',
	'MEMORY_CONTENT_UNAVAILABLE',
	'RERANKING_FAILED',
	'SUMMARIZATION_FAILED',
	'SUMMARIZATION_TIMEOUT',
	'RATE_LIMITED',
	'RESOURCE_EXHAUSTED',
	'CONFIGURATION_ERROR',
	'LLM_CAPABILITY_INFERRED',
	'FEATURE_DISABLED',
]);

export function parseNdjson(text: string): ParsedStream {
	const events: RetrieveEvent[] = [];
	let malformedLines = 0;
	for (const rawLine of text.split('\n')) {
		const line = rawLine.trim();
		if (!line) continue;
		try {
			events.push(JSON.parse(line) as RetrieveEvent);
		} catch {
			// A truncated stream must not be mistaken for a complete one.
			malformedLines++;
		}
	}
	return { events, malformedLines };
}

/** Notices that carry no loss of results. */
export function isInformational(status: GoodmemStatus): boolean {
	if (!status.code) return false;
	if (status.code === 'LLM_CAPABILITY_INFERRED') return true;
	if (status.code === 'FEATURE_DISABLED') {
		const details = status.details ?? {};
		return details.feature === 'summarization' && details.required_param === 'llm_id';
	}
	return false;
}

export interface Classified {
	statuses: IDataObject[];
	degraded: boolean;
}

/**
 * Known informational -> dropped. Known failures -> degraded. Codes this
 * version does not recognise -> surfaced as UNKNOWN and degraded, but never
 * discarded and never fatal: a newer server must not break retrieval.
 */
export function classify(parsed: ParsedStream): Classified {
	const statuses: IDataObject[] = [];
	let degraded = parsed.malformedLines > 0;
	if (parsed.malformedLines > 0) {
		statuses.push({
			code: 'MALFORMED_STREAM',
			message: `${parsed.malformedLines} line(s) of the retrieval stream could not be parsed.`,
		});
	}
	for (const event of parsed.events) {
		const status = event.status;
		if (!status || isInformational(status)) continue;
		const entry: IDataObject = { ...status };
		if (!status.code || !KNOWN_STATUS_CODES.has(status.code)) {
			entry.code = 'UNKNOWN';
			entry.originalCode = status.code ?? null;
			entry.unrecognized = true;
		}
		statuses.push(entry);
		degraded = true;
	}
	return { statuses, degraded };
}

export interface Hit {
	chunkText: string;
	score: number | null;
	scoreKind: 'vector' | 'reranker';
	chunkId: string;
	memoryId: string;
	spaceId: string | null;
	source: string;
	metadata: IDataObject;
	chunkMetadata: IDataObject;
}

/**
 * Join chunks to their memory definitions by ID, independent of event order,
 * and deduplicate by chunk ID: two chunks of one memory are two results.
 */
export function hitsFromEvents(events: RetrieveEvent[], reranked: boolean): Hit[] {
	const memories = new Map<string, IDataObject>();
	for (const event of events) {
		const definition = event.memoryDefinition;
		if (definition && typeof definition.memoryId === 'string') {
			memories.set(definition.memoryId, definition);
		}
	}
	const hits: Hit[] = [];
	const seen = new Set<string>();
	for (const event of events) {
		const item = event.retrievedItem;
		if (!item) continue;
		const reference = item.chunk as IDataObject | undefined;
		const chunk = reference?.chunk as IDataObject | undefined;
		if (!chunk || typeof chunk.chunkText !== 'string' || !chunk.chunkText) continue;
		const chunkId = String(chunk.chunkId ?? '');
		if (!chunkId || seen.has(chunkId)) continue;
		seen.add(chunkId);
		const memoryId = String(chunk.memoryId ?? '');
		const memory = memories.get(memoryId) ?? (item.memory as IDataObject | undefined);
		const score = typeof reference?.relevanceScore === 'number' ? reference.relevanceScore : null;
		hits.push({
			chunkText: chunk.chunkText,
			score,
			scoreKind: reranked ? 'reranker' : 'vector',
			chunkId,
			memoryId,
			spaceId: memory && typeof memory.spaceId === 'string' ? memory.spaceId : null,
			source:
				memory && typeof memory.originalContentRef === 'string'
					? memory.originalContentRef
					: memoryId,
			metadata: (memory?.metadata as IDataObject) ?? {},
			chunkMetadata: (chunk.metadata as IDataObject) ?? {},
		});
	}
	return hits;
}

export function abstractReply(events: RetrieveEvent[]): IDataObject | undefined {
	for (const event of events) if (event.abstractReply) return event.abstractReply;
	return undefined;
}

/* ------------------------------------------------------------------ */
/* Content decoding                                                    */
/* ------------------------------------------------------------------ */

const TEXTUAL = ['text/', 'application/json', 'application/xml', '+json', '+xml'];

export function isTextual(contentType: string): boolean {
	const lower = contentType.toLowerCase();
	return TEXTUAL.some((marker) => lower.includes(marker));
}

export function charsetOf(contentType: string): string {
	for (const part of contentType.split(';').slice(1)) {
		const [key, value] = part.split('=').map((s) => s.trim());
		if (key?.toLowerCase() === 'charset' && value) return value.replace(/^"|"$/g, '');
	}
	return 'utf-8';
}

/**
 * Decode bytes as text using the declared charset.
 * Returns null for non-text types, and an error message instead of silently
 * mangling text that does not match its declared charset.
 */
export function decodeText(buffer: Buffer, contentType: string): { text?: string; error?: string } | null {
	if (!isTextual(contentType)) return null;
	const charset = charsetOf(contentType);
	try {
		return { text: new TextDecoder(charset, { fatal: true }).decode(buffer) };
	} catch {
		return { error: `Content could not be decoded as ${charset}.` };
	}
}

export function fileNameFor(memory: IDataObject, memoryId: string, contentType: string): string {
	const metadata = (memory.metadata as IDataObject) ?? {};
	const title = typeof metadata.title === 'string' ? metadata.title.trim() : '';
	if (title) return title;
	const extension: Record<string, string> = {
		'application/pdf': 'pdf',
		'text/plain': 'txt',
		'text/markdown': 'md',
		'text/html': 'html',
		'application/json': 'json',
		'image/png': 'png',
		'image/jpeg': 'jpg',
	};
	const ext = extension[contentType.split(';')[0].trim().toLowerCase()];
	return ext ? `${memoryId}.${ext}` : memoryId;
}
