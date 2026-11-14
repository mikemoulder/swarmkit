import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// Runs the hand-assembled anchor contract against an in-memory NEAR host.
async function host(predecessor: string) {
  const wasm = readFileSync(new URL("../contracts/anchor/anchor.wasm", import.meta.url));
  const storage = new Map<string, Buffer>();
  const registers = new Map<bigint, Buffer>();
  const logs: string[] = [];
  let input = Buffer.alloc(0);
  let memory!: WebAssembly.Memory;
  const bytes = (len: bigint, ptr: bigint) => Buffer.from(memory.buffer, Number(ptr), Number(len));
  const env = {
    input: (r: bigint) => { registers.set(r, input); },
    read_register: (r: bigint, ptr: bigint) => { registers.get(r)!.copy(Buffer.from(memory.buffer), Number(ptr)); },
    register_len: (r: bigint) => BigInt(registers.get(r)?.length ?? -1),
    predecessor_account_id: (r: bigint) => { registers.set(r, Buffer.from(predecessor)); },
    block_timestamp: () => 1_794_000_000_000_000_000n,
    storage_write: (kl: bigint, kp: bigint, vl: bigint, vp: bigint) => {
      storage.set(bytes(kl, kp).toString("latin1"), Buffer.from(bytes(vl, vp))); return 0n;
    },
    storage_has_key: (kl: bigint, kp: bigint) => (storage.has(bytes(kl, kp).toString("latin1")) ? 1n : 0n),
    panic_utf8: (len: bigint, ptr: bigint) => { throw new Error(bytes(len, ptr).toString()); },
    log_utf8: (len: bigint, ptr: bigint) => { logs.push(bytes(len, ptr).toString()); },
  };
  const { instance } = await WebAssembly.instantiate(wasm, { env });
  memory = instance.exports.memory as WebAssembly.Memory;
  const anchor = (text: string) => { input = Buffer.from(text); (instance.exports.anchor as () => void)(); };
  return { anchor, storage, logs };
}

test("anchor contract stores a write-once, signer-bound, timestamped record", async () => {
  const { anchor, storage, logs } = await host("seller-1.swarm.testnet");
  const message = "swarmkit:v1:round-7:commit:" + "ab".repeat(32);
  anchor(message);
  const [[key, value]] = [...storage];
  assert.equal(key, message + "\0seller-1.swarm.testnet");
  assert.equal(value.readBigUInt64LE(), 1_794_000_000_000_000_000n);
  assert.deepEqual(logs, [message]);
  assert.throws(() => anchor(message), /already anchored/);
  assert.throws(() => anchor("not-swarmkit-data"), /bad input/);
  assert.throws(() => anchor("swarm"), /bad input/);
});
