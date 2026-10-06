# R Interactive architecture

R Interactive keeps R execution independent of the VS Code extension host. Each session has an agent, a runtime backend, a durable transcript, and retained assets. The editor reconnects to the agent instead of resubmitting code. See the [wiki user guide](https://github.com/REditorSupport/vscode-R/wiki/R-Interactive) for setup and behavior, and [CONTRIBUTING.md](../../CONTRIBUTING.md#testing-r-interactive) for validation commands.

## Component boundaries

| Component | Responsibility |
| --- | --- |
| [manager.ts](manager.ts), [notebook.ts](notebook.ts), [client.ts](client.ts) | Session selection and source bindings, VS Code windows/controllers, agent connections, transcript reconciliation, and editor actions |
| [agent.ts](agent.ts) | Editor authentication and control leases, admission and queues, execution identity/state, deduplication, replay, cached workspace policy, output limits, and event fan-out |
| [journal.ts](journal.ts), [assets.ts](assets.ts) | Durable execution records and output, asset serving/compression, and retention |
| [backend.ts](backend.ts) | Node-only `SessionBackend` contract and decoded application events; independent of VS Code and provider transports |
| [backendRegistry.ts](backendRegistry.ts), [agentMain.ts](agentMain.ts) | Fixed backend definitions, preflight/preparation, and composition of the agent with its backend |
| [launcher.ts](launcher.ts), [supervisor.ts](supervisor.ts), [nodeExecutable.ts](nodeExecutable.ts) | Agent bundle preparation, runtime selection, and independent process supervision |
| [renderer.ts](renderer.ts) | Browser-side rich output and controls; live requests return through the editor to the owning session |

`SessionAgent` receives a backend factory. It does not import sess, arf, R-process launch helpers, or JGD wire types. Backend definitions are internal; there is no public plugin registration API.

## Current backend

The shipped `sess` backend uses arf with pure R sess helpers:

| Public provider | Backend | Frontend | Ownership |
| --- | --- | --- | --- |
| `arf` | `sess` | arf headless | Managed |
| `arf-existing` | `sess` | arf | Adopted |

[SessBackend](backends/sessBackend.ts) owns readiness, metadata, capabilities, and
ordered output. [SessBridge](backends/sessBridge.ts) owns authenticated sess
JSON-RPC, inspection, rich events, and requests to the editor. [Arf](backends/arf.ts)
owns launch/adoption and dispatch; [process.ts](backends/process.ts) handles
signals, ownership, and confirmed process exit. Shared discovery/HTTP helpers
remain in [arf.ts](arf.ts). Plain R Interactive creation is unavailable; ordinary
R terminals are unaffected, and existing agents can still be reconnected.

Managed sessions dispatch the private `sess:::interactive_execute` entry point
through arf `user_input` (send), respecting arf's visible-operation policy and
avoiding its unbounded evaluation-output capture. Console output comes from the
owned process pipes. Rich events use sess RPC and small authenticated stdout
references; the backend waits for each event before emitting subsequent stdout.
A stderr fence and the stdout completion reference ensure both output pipes are
drained before completion. Protocol writes use processx descriptor wrappers, so
R sinks, frontend styling, and forked workers cannot rewrite those frames. A
server reply timeout after execution started does not cancel R; its events still
establish completion. Other transport failures remain ambiguous without retries.

Adopted sessions use visible arf evaluation and return captured console output on
completion, while rich events use sess RPC. The backend waits for both completion
and the captured response. There is no subscription for arbitrary terminal console
output. Terminal task notifications and rich viewers still work. Disposal restores
sess hooks without changing frontend console callbacks or killing adopted R.

Both providers report notebook stdin/debugger support as unavailable: arf IPC
`user_input` submits code, rather than answering nested R prompts. Use ordinary
R terminals for `readline`, `scan`, and debugger interaction. arf IPC is
experimental; the integration is tested against arf 0.5.3. Persistent supervision
currently remains limited to Linux/macOS.

[SessGraphics](backends/sessGraphics.ts) owns JGD negotiation, its font-metrics worker, plot attribution/coalescing, SVG production, and resize transport. It emits display payloads with stable identities. The agent stores assets and journals references. Static graphics remains available without JGD; another backend can supply SVG/PNG directly.

Backend-specific preflight and private package installation live behind the registry and [sessPreparation.ts](backends/sessPreparation.ts). Common agent settings do not require a sess library or R path. The agent bundle cache is separate from the sess runtime cache. Existing flat launch configurations are normalized by `backendDescriptor()`; `withBackend()` derives compatibility fields for older readers. The [sess README](../../sess/README.md) documents its R hooks and wire protocol.

## Backend contract and ordering

Use the types in [backend.ts](backend.ts) as the source of truth. The essential rules are:

- Subscribe to events before calling `start()`. A `ready` event establishes execution readiness and reports actual R metadata and negotiated capabilities. Startup alone does not authorize dispatch.
- `dispatch()` acknowledges transport, not evaluation completion. `started` and `finished` events establish the result and can arrive before the dispatch promise settles. The agent records admission and the current execution first; late replies must not complete an execution twice.
- Events carry execution IDs where known. External terminal output stays identifiable as external; missing source or uncertain boundaries must not be invented.
- A transport failure can leave execution outcome unknown. Block further dispatch until the outcome is established; never automatically retry submitted R code. Transport loss does not prove process death, particularly for adopted arf.
- Inspection is a typed set of workspace, hover/completion, and data-viewer operations. Keep sockets, subprocesses, wire packets, and transport request IDs inside the backend. Runtime requests to the editor use opaque backend IDs; expired prompts must not become actionable on replay.
- The agent validates input identity, generation, and controlling-client authorization. The backend delivers input/replies and handles interruption, including slow inspection after its editor request timed out.
- Runtime capabilities come from the backend; persistence, history, rename, and queue cancellation remain agent-owned. Use capabilities and ownership for operational checks, with compatibility defaults for older manifests.

## Lifecycle

| Action | Contract |
| --- | --- |
| Close a view or disconnect the editor | Release the editor connection; keep the independent agent and R alive |
| Explicit Stop | Authorize through the agent, cancel queued work, and wait for confirmed runtime exit; this can stop an adopted process |
| Restart | Validate and prepare the replacement before stopping R, retain the transcript, and create a fresh generation; adopted arf is restarted externally |
| Dispose the backend | Perform bounded, idempotent cleanup, reject pending calls, and suppress late callbacks; clean up managed processes, but leave adopted R alive and restore its hooks where possible |

Graphics flushes already-buffered updates before reporting execution completion and preserves attribution for later updates. Restart invalidates live table/device handles from the previous R generation; retained static output remains usable. Reconnection replays history without evaluation. The execution ledger is not a transaction system or a checkpoint of R memory.

The agent uses the extension host runtime by default: Electron in Node mode on desktop, or VS Code Server's Node remotely. The optional `r.interactive.nodePath` selects standalone Node.js 18+. Runtime and supervisor checks happen before package installation or stopping R for restart. Reconnection uses the existing agent without replacing its executable. The common launcher handles detached, tmux, and systemd supervision independently of the backend.

## Validation and design history

[interactiveBackend.test.ts](../test/node/interactiveBackend.test.ts) uses a scripted backend without sess configuration to exercise agent policy, event ordering, ambiguity, input, and lifecycle rules. Real-runtime, library-isolation, supervisor, editor, and renderer checks cover the integration; see the [test instructions](../../CONTRIBUTING.md#testing-r-interactive) and [analysis fixtures](../test/examples/README.md).

The [original plans and dated review reports](https://github.com/REditorSupport/vscode-R/tree/c2167d2cdb403375fa10ad3e29cde73a49cfc014/docs) are preserved at a fixed revision of [PR #1805](https://github.com/REditorSupport/vscode-R/pull/1805). They describe development history, not the current contract. The backend boundary originated in [this review](https://github.com/REditorSupport/vscode-R/pull/1805#pullrequestreview-5392223174).
