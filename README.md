# n8n-nodes-goodmem

An n8n community node for [GoodMem](https://goodmem.ai), a self-hostable
semantic memory service: store text and files, search them in natural
language, and manage the spaces they live in — from any n8n workflow, or as a
tool for an n8n AI agent.

The node has no runtime dependencies and talks to GoodMem through n8n's own
request helpers, as community-node verification requires.

## Install

**Settings → Community Nodes → Install** and enter
`@pairsystems/n8n-nodes-goodmem`, or:

```bash
cd ~/.n8n/nodes && npm install @pairsystems/n8n-nodes-goodmem
```

Requires n8n 1.60 or later. Version 2.0 is a break from 1.x — see
[CHANGELOG](CHANGELOG.md) for the parameter mapping.

## Credentials

Create a **Goodmem API** credential with your server URL (for example
`https://goodmem.example.com`) and an API key. The credential test lists your
spaces. For a server with a private certificate authority, mount the CA under
`/opt/custom-certificates` as n8n documents.

## Operations

| Resource | Operations |
| --- | --- |
| Memory | Retrieve (semantic search), Create, Get, Download Content, List, Delete |
| Space | Create, Get, List, Update, Delete |
| Embedder | List |
| Reranker | List |

### Retrieve

Give it a query and one or more space IDs. Each matching passage becomes an
output item:

```json
{
  "chunkText": "Refunds above $500 need a manager's approval.",
  "score": -0.53, "scoreKind": "vector",
  "chunkId": "…", "memoryId": "…", "spaceId": "…", "source": "…",
  "metadata": { "title": "handbook", "category": "policy" },
  "partial": false, "statuses": []
}
```

- `partial` is `true` when part of the search did not complete — a reranker was
  unavailable, one space was unreachable. The passages are usable but may be
  incomplete, and `statuses` says why. A search that produced nothing usable
  fails the node with the server's reason; an empty result is simply no items.
- `score` is passed through exactly as GoodMem reports it. Vector scores are
  opaque similarities that can be negative; reranker scores are relevance
  values. `scoreKind` says which you have. **Relevance Threshold** therefore
  needs a Reranker ID.
- **Filter** is a GoodMem expression applied to every space, e.g.
  `CAST(val('$.category') AS TEXT) = 'policy'`. Inside a quoted value escape
  `'` as `\'` and `\` as `\\`.
- Set an **LLM ID** to also get an `abstractReply` on the first item.

### Create

Stores text, or a file from a binary property of the incoming item (a PDF from
an HTTP Request or Read Binary File node). By default it **waits until the
memory is indexed**, so a Retrieve later in the same workflow finds it. Turn
"Wait for Indexing" off to return immediately with `processingStatus: PENDING`.

### Get and Download Content

Text content is returned decoded in a `content` field. Anything else — PDFs,
images — is returned as n8n binary data (property `data` by default), bytes
intact, ready for a Write Binary File or another node.

### Using the node as an AI tool

The node is marked usable as a tool. Any field you map with `$fromAI()` is then
chosen by the model; keep **Space IDs** and **Filter** fixed unless you intend
the agent to pick them.

## Development

```bash
npm install --ignore-scripts   # @n8n/node-cli pulls a native module you do not need
npm run lint
npm test                        # builds, then runs the regression suite
```

The tests run the built node against a local HTTP server using event shapes
captured from a live GoodMem server. Lint uses n8n's strict cloud-compatibility
configuration unchanged.

## License

[MIT](LICENSE.md)
