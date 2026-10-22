---
name: verify-mesh-property
description: Check that Resonance's mesh flooding terminates (every node puts each packet on the air a bounded number of times) by running real MeshNodes from src/mesh/node.ts through every order of deliveries, losses and timer firings within a bound. Use before and after any change to src/mesh/node.ts, packet.ts, payloads.ts, bloom.ts or MAX_DEFER_MS in radio.ts, and whenever a mesh change could make a node send, relay or carry a packet more often.
---

# Verify the mesh: flooding terminates

**Property.** Whatever is lost and in whatever order frames and timers come, each node puts a given packet on the air a bounded number of times: as its author at most `config.maxAttempts` frames (the first send, then retries or echo repeats; a receipt is its sender's packet), as a relay once per attempt it heard, and as a carrier once per HELLO it heard from a neighbour that had not heard the packet when it said hello.

**Harm.** Sound is one shared channel where a frame takes 1 to 20 s, so a packet sent without bound jams the room for everyone nearby, and a call for help waits behind it.

## Run it

```sh
npx vitest run src/mesh/flooding-bound.test.ts                      # default bound: 10 tests, 8-12 s
MESH_VERIFY_FULL=1 npx vitest run src/mesh/flooding-bound.test.ts   # adds the two biggest scenarios: 35-45 s
```

Vitest 5.0.5 from package.json on Node 22; nothing else to install. Run the default bound on every change to the covered code, and the full bound before merging one. A failure prints `counterexample:` and numbered steps in the code's words. This is what removing the dedupe check from `receive()` prints:

```
1. A sends check-in X
2. A airs check-in X: B stores it
3. the clock moves on to 4.0 s
4. B.tick() at 4.0 s: queues a relay of check-in X
5. B airs a relay of check-in X: A hears it; C stores it
6. the clock moves on to 5.8 s
7. C.tick() at 5.8 s: queues a relay of check-in X
8. C airs a relay of check-in X: B already holds it; D stores it
9. the clock moves on to 8.4 s
10. B.tick() at 8.4 s: queues a relay of check-in X
=> B relayed attempt 0 of check-in X 2 times; the bound is once per attempt
```

## Does my change touch it?

Sync commit: **c16fd68** (`Say in code what comments explained: named shares, tries and states`). At that commit the check was confirmed to describe the code below, passing except for the known finding.

```sh
git diff c16fd68 -- src/mesh/node.ts src/mesh/packet.ts src/mesh/payloads.ts src/mesh/bloom.ts src/mesh/radio.ts src/mesh/explorer.ts src/mesh/flooding-bound.test.ts
```

Any output means rerun the check and follow "Keeping it in step".

| File | What the check covers | How |
| --- | --- | --- |
| `src/mesh/node.ts` | `MeshNode`: `originate`, `awaitAnswer`, `aired`, `receive`, `hello`, `onAck`, `onHello`, `lackedBy`, `carry`, `feedNeighbors`, `tick`, `alone`, `schedule`, `remember`, `leastNeeded` (a store full of chat only), `sendAck`, `touchNeighbor`, `keepMs`, `ackTimeout`, `echoTimeout`, `pruneSeen` (below its 4000 entries only) | runs the real code |
| `src/mesh/packet.ts` | `encodePacket`, `decodePacket`, `peekType` | runs the real code |
| `src/mesh/payloads.ts` | `encodeBody`, `decodeBody` | runs the real code |
| `src/mesh/bloom.ts` | `Bloom`, `sliceOf` (the HELLO summary) | runs the real code |
| `src/mesh/radio.ts` | only `MAX_DEFER_MS`, through node.ts. `TxQueue` does not run: the explorer stands in for it, airing any waiting frame next and reporting each with `aired()` once | modelled |
| `src/station.ts` | does not run. Its calls are the explorer's steps: `tick()` at any moment, `hello()` up to the scenario's count, `channelBusy` true only on a busy tick | modelled |

`MeshNode.answer` (file requests) and `MeshNode.hydrate` are not covered.

The harness is `src/mesh/explorer.ts`; the property and scenarios are in `src/mesh/flooding-bound.test.ts` (the monitor is `airBudget`). The explorer leans on three things in node.ts:

- It copies and fingerprints every own field of a `MeshNode` except `clock`, `events` and `stats` (`PORTS`). A field holding a class instance other than Map, Set, Array, Uint8Array or a plain object makes it throw `harness: cannot copy a ...`.
- It reads the private `relays`, `acks` and `echoes` and their `due` (`nextDue`, `Timers`) to know when the clock may move. A new kind of timer must be added there, or it never comes due.
- The monitor sorts the `transmit` reasons: `origin`, `ack`, `retry` count against the author; `relay` against the relay; `carry` and `answer` against the carrier. A new reason must be sorted.

## Bounds and assumptions

Default scenarios. Each must pass with `cut` 0 (the depth bound never stopped the search).

| Scenario | Nodes and links | Receptions lost | Else | States |
| --- | --- | --- | --- | --- |
| a check-in floods three nodes that all hear each other | ABC, all pairs | 2 | | 2,002 |
| a check-in floods four nodes in a line | A-B-C-D | 2 | | 3,787 |
| a check-in floods three nodes while the air is busy at one tick | ABC, all pairs | 1 | 1 busy tick | 9,267 |
| a direct message and its receipt cross a relay | A-B-C | 1 | A's `maxAttempts` 2 stands in for 3 | 7,994 |
| a direct message to a neighbour, with all three attempts | A-B | 1 | | 181 |
| a check-in from a node that knows a neighbour, whose echoes are all lost | A-B | 3 | A heard B's hello first, so it is not alone | 193 |
| two nodes meet and swap what the other lacks | B-N | 1 | 1 HELLO each, relays off | 2,890 |

`MESH_VERIFY_FULL=1` adds a check-in in a ring of four (AB AC BD CD) with 2 losses (35,695 states) and the triangle with 2 losses and a busy tick (24,724 states).

In every scenario:

- Any timer may fire late by any amount: a node's timers run only when the explorer picks its `tick()`, and the clock moves only to the next relay, retry or echo due anywhere, or by a scenario's long pause.
- The radio may hold a frame for any time: any waiting frame may air next. Each linked neighbour hears it or, while the loss budget lasts, misses it. A node hears nothing from a node it is not linked to.
- `clock.random()` is one fixed sequence per node, not every value, so backoffs, HELLO ids and Bloom salts are fixed along a path. Order and lateness are free; the drawn numbers are not.
- Small numbers stand in for large ones: `storeLimit` 2 for 300, `maxAttempts` 2 for 3 across a relay.

The check runs the real class instead of a TLA+ model because the question is whether node.ts itself, with its dedupe memory, timers and Bloom summaries, can send without bound; a hand model would drift from it. Vitest is already the repo's test runner, so nothing new is installed.

## Known finding (narrowed, still open)

A packet that left a node's store but not its dedupe memory (`seen`) is carried back to it once. The node's summary lacks the packet, so a neighbour that holds it carries it; `receive()` drops the copy as already seen, but notes its id in `forgotten`, and later HELLOs list `forgotten` ids, so nobody carries it again. Until commit fc3d45c it came back at every HELLO, for as long as the carrier kept its copy (12 h for chat, 72 h for lasting news); `mesh.test.ts` pins the fix in `a packet a node forgot is carried back to it once, not at every hello`. That one carry still breaks `airBudget`'s bound (one carry per HELLO from a neighbour that had not heard the packet). A node gets there when its store expires a packet a neighbour heard later, when a full store drops one (a beacon fills its 300 and says hello every minute), and after `Station.wipe()`, which clears the store but not `seen`. That last path is not in the check.

From the test `a store forgets a chat after 12 h that a neighbour heard three hours later`:

```
1. N hears chat Y from afar
2. the air settles: N airs a relay of chat Y
3. 3 hours pass
4. B hears chat Y from afar
5. the air settles: B airs a relay of chat Y
6. ten hours pass: the clock reads 13 h 0 min 6.7 s
7. N.tick() at 13 h 0 min 6.7 s: its store forgets chat Y
8. N.hello() queues a summary of its store: nothing
9. N airs its hello: B hears it
10. the clock moves on to 13 h 0 min 8.1 s
11. B.tick() at 13 h 0 min 8.1 s: queues a carry of chat Y
=> B carried chat Y 1 time(s) but heard 0 HELLO(s) from neighbours that had not heard it; the bound is one carry per such HELLO
```

The two tests under `known finding` pin these counterexamples so the suite passes. They are not passes of the property.

## Real bug or modeling error?

1. An error starting `harness:` is the explorer's fault, or a change in node.ts broke one of its three assumptions above. Fix `explorer.ts`, never node.ts.
2. A failing `copies states exactly` test means copying a state lost something. Fix `copy()` or `fields()` in `explorer.ts`.
3. `maxDepth cut the search short` means the bound stopped the search before it ran out of states. Raise that scenario's `maxDepth`.
4. A counterexample was replayed on fresh, uncopied nodes before it was printed, so node.ts really does those steps in that order. Ask whether a device can: a frame waiting in the radio far longer than a real queue holds one (`TxQueue` defers a frame at most `MAX_DEFER_MS`, 25 s, and keeps 64; a queue of long frames can still hold one for minutes), or a node not ticking for a long time while others act (Station ticks every 200 ms). If a step needs what no device does, that is a modeling gap: narrow the explorer, say so in this skill, and keep the property as it is. Otherwise it is a real bug: report it with the steps, and do not weaken `airBudget` or change node.ts unless asked.
5. A failing `known finding` test: read the new counterexample. The same cause in other steps means update the pinned text with `npx vitest run src/mesh/flooding-bound.test.ts -u`. No violation means the finding is fixed: move that scenario into `holding` and delete the "Known finding" section here.

## Keeping it in step

After an intended change to the covered code:

1. Run the default and the full bound.
2. Read the diff against the table above: new `MeshNode` fields are copied and fingerprinted on their own, but new timers need `nextDue`, new `transmit` reasons need `airBudget`, and new config may need new scenarios.
3. Confirm the check can still fail. Delete `if (this.seen.has(rk)) return p;` in `receive()`: the three flood scenarios fail with `relayed attempt 0 of check-in X 2 times`. Restore it, then delete the `if (a.packet.attempt + 1 >= this.config.maxAttempts) { ... }` block in `tick()`: both direct-message scenarios fail with `put chat M on air 3 times as its author` (4 times for the pair). Restore it, then write `this.config.maxAttempts + 1` in the echo repeats' limit in `tick()`: the scenario of a node that knows a neighbour fails with `A put check-in X on air 4 times as its author`. Restore with `git checkout src/mesh/node.ts`.
4. Only then move the sync commit above to the commit you checked.

A new scenario should stay under about 5 s and 40,000 states. To size one, log `explore(s, airBudget)`'s `states`, `depth` and `cut` once and delete the log. Retries, relays and HELLOs grow the state space fastest.

## Not covered

- A direct message across a relay with all three attempts: 164,230 states and 32 s with nothing lost.
- Three nodes meeting: 201,048 states and 49 s with relays off; out of memory with relays on.
- A newcomer saying hello again after the 90 s cooldown: out of memory under Vitest (over 70,000 states).
- Relays during a meeting; `feedNeighbors` batches after the first three; stores bigger than one HELLO slice (40 ids); the `UNPROVEN_FEED` budget.
- A store over its share of lasting news, where `leastNeeded` drops a superseded check-in (`supersededCheckIn`, with `superseded` from src/roster.ts) or else the oldest lasting news. Only the known finding fills a store, and with chat.
- Busy air long enough for `MAX_DEFER_MS` to release a held relay; more than one busy tick.
- `answer()`, `hydrate()`, `Station.wipe()`, `pruneSeen` past 4000 entries, and times past 12 h or 72 h outside the known-finding scenarios.
- More than four nodes, more than two losses (three in the two-node echo scenario), other random draws.
- `TxQueue` order, its 64-frame limit and drops; station.ts wiring; the audio modem.
- Whether packets arrive (liveness). This checks a bound on sending only.
