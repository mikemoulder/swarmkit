# Working on SwarmKit

Read [idea.md](idea.md) before changing scope and [handoff.md](handoff.md) before resuming work. SwarmKit is a TypeScript SDK for agent economies on NEAR. GPU procurement is its first reference application. Keep market rules in [RULES.md](RULES.md), implementation boundaries in [ARCHITECTURE.md](ARCHITECTURE.md), and durable decisions in [memory.md](memory.md).

Run `npm run demo` and `npm test` on Node 22.18 or newer. Update the handoff after each verified checkpoint. Keep credentials out of the repository and distinguish simulated activity, native testnet payments, and actual Intents settlement in user-facing claims.
