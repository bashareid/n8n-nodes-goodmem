### Changelog

All notable changes to this project will be documented in this file.

#### 2.0.0

2.0 is a deliberate break. The node is rewritten in n8n's programmatic style
with **no runtime dependencies**, as community-node verification requires. Node
version 2; workflows built on 1.x need their Goodmem nodes re-added (parameter
names changed, see Migration).

Every defect below was reproduced by running the published 1.0.1 package inside
a real n8n 2.39 instance against a live GoodMem server; the execution records
are kept alongside the repository's audit notes.

**Fixed**

- **Retrieve emitted one item whose `json` was the raw NDJSON stream as a
  string** — statuses, boundaries, chunks and memory definitions concatenated
  and unparsed. Retrieve now emits one item per matching chunk with `chunkText`,
  `score`, `scoreKind`, `chunkId`, `memoryId`, `spaceId`, `source` and the
  memory's `metadata` joined in, plus `partial` and `statuses` on every item.
- **A search whose reranking failed reported success.** The server's
  `NOT_FOUND` and `RERANKING_FAILED` statuses were inside that string. They now
  mark the results `partial` and are listed in `statuses`; a search that
  produced nothing usable returns no items and surfaces the server's reason as
  an execution hint and a warning log line, never a node failure. Notices that
  carry no loss (`FEATURE_DISABLED`, `LLM_CAPABILITY_INFERRED`) are dropped by
  code alone, per the server's definition of them; status codes this version
  does not know are reported as `UNKNOWN` and never discard results.
- **Download Content corrupted binary.** Bytes were decoded as text: a 196-byte
  PDF payload came back with 132 replacement characters and no binary property.
  Non-text content is now delivered as n8n binary data, byte for byte; text
  arrives as a `content` field on an object item instead of a bare string.
- **Get returned `originalContent` as raw base64.** Text is decoded using the
  declared charset into `content`; other types become binary data.
- **Server error text was lost.** A duplicate space name showed "Your request
  is invalid or could not be processed by the service"; the server had said
  "A space with this name already exists". Errors now carry the server's
  message and status code.
- A truncated retrieval stream was skipped silently; it is now reported as a
  `MALFORMED_STREAM` status.
- `Relevance Threshold` was documented as a 0–1 score and sent without a
  reranker, where it means nothing: vector scores are opaque and routinely
  negative. It now requires a Reranker ID and its description says the range
  depends on the model.

**Added**

- Space → List (with name filter), Get and Update (name, merge/replace labels).
  Embedder → List and Reranker → List, so IDs can be discovered from n8n.
  Memory → List. All listings follow server pagination up to Max Items.
- Memory → Create waits for the new memory to finish indexing by default, so a
  following Retrieve finds it; turn "Wait for Indexing" off to return
  immediately. Create also accepts an n8n binary property (PDF, image, …).
- Retrieve sends `POST /v1/memories:retrieve`: the query and filter travel in
  the request body rather than the URL.
- A regression suite (`npm test`) that runs the built node against a local
  HTTP server with event shapes captured from a live GoodMem server, wired into
  CI.

**Migration from 1.x**

| 1.x | 2.0 |
| --- | --- |
| Retrieve `retrieveMessage`, `retrieveSpaceIds`, `retrieveRequestedSize`, `retrieveFilter` | `query`, `spaceIds`, `limit`, `filter` |
| Retrieve `postProcessorOptions.*` | `retrieveOptions.rerankerId`, `llmId`, `llmTemp`, `relevanceThreshold`, `chronologicalResort` |
| Retrieve output: one item containing the raw stream | One item per chunk; use `partial` / `statuses` |
| Memory `memoryIdRequired`, `requiredSpaceIdForMemory`, `originalContent`, `contentTypeForMemory`, `optionalMetadata` | `memoryId`, `memorySpaceId`, `content`, `contentType`, `metadata` |
| Chunking strategy fields | `chunking`: Server Default / None / Custom (JSON) |
| Space `requiredSpaceId`, `requiredSpaceName`, `spaceEmbedders` collection, `optionalSpaceLabels` | `spaceId`, `name`, `embedderId`, `labels` |
| Download Content output: string item | Binary property (default `data`), or `content` for text |

The filter is a GoodMem expression typed by the workflow author. Inside a
quoted value escape `'` as `\'` and `\` as `\\`; SQL-style `''` doubling and
double-quoted strings are rejected by the server. When the node is used as an
AI tool, any field mapped with `$fromAI()` is model-controlled — keep `spaceIds`
and `filter` fixed unless that is intended.

#### 1.0.1

- Address n8n verification feedback and fix three breakages against current GoodMem ([#2](https://github.com/PAIR-Systems-Inc/n8n-nodes-goodmem/pull/2))

#### 1.0.0

- Initial release: Space create/delete, Memory create/get/delete/download/retrieve ([#1](https://github.com/PAIR-Systems-Inc/n8n-nodes-goodmem/pull/1))
