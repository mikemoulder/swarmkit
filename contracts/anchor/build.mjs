// Assembles the SwarmKit anchor contract into contracts/anchor/anchor.wasm.
// No toolchain: every byte of the module is written below and can be read.
//
// One method, `anchor`. Input is raw UTF-8 that must start with "swarmkit" and be 8-256 bytes.
// Storage key   = input ++ 0x00 ++ predecessor_account_id
// Storage value = block_timestamp (u64, little-endian nanoseconds)
// Write-once: a second anchor of the same bytes by the same account panics.
// Anyone can list a round's anchors with RPC view_state and the prefix "swarmkit:v1:<roundId>:".
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const uleb = (n) => { const out = []; n = BigInt(n); do { let b = Number(n & 0x7fn); n >>= 7n; if (n) b |= 0x80; out.push(b); } while (n); return out; };
const sleb = (n) => { const out = []; n = BigInt(n); for (;;) { const b = Number(n & 0x7fn); n >>= 7n; const done = (n === 0n && !(b & 0x40)) || (n === -1n && (b & 0x40)); out.push(done ? b : b | 0x80); if (done) return out; } };
const str = (s) => [...uleb(Buffer.byteLength(s)), ...Buffer.from(s)];
const vec = (items) => [...uleb(items.length), ...items.flat()];
const section = (id, body) => [id, ...uleb(body.length), ...body];
const I64 = 0x7e, I32 = 0x7f;
const fn = (params, results) => [0x60, ...vec(params.map((p) => [p])), ...vec(results.map((r) => [r]))];

const types = [
  fn([I64], []),                     // 0 input, predecessor_account_id
  fn([I64, I64], []),                // 1 read_register, panic_utf8, log_utf8
  fn([I64], [I64]),                  // 2 register_len
  fn([], [I64]),                     // 3 block_timestamp
  fn([I64, I64, I64, I64, I64], [I64]), // 4 storage_write
  fn([I64, I64], [I64]),             // 5 storage_has_key
  fn([], []),                        // 6 anchor
];
const imports = [
  ["input", 0], ["read_register", 1], ["register_len", 2], ["predecessor_account_id", 0],
  ["block_timestamp", 3], ["storage_write", 4], ["storage_has_key", 5], ["panic_utf8", 1], ["log_utf8", 1],
];
const [INPUT, READ, LEN, PRED, TIME, WRITE, HAS, PANIC, LOG] = imports.map((_, i) => i);

const call = (f) => [0x10, ...uleb(f)];
const i64 = (n) => [0x42, ...sleb(n)];
const i32 = (n) => [0x41, ...sleb(n)];
const get = (l) => [0x20, l], set = (l) => [0x21, l], tee = (l) => [0x22, l];
const ifThen = (...body) => [0x04, 0x40, ...body.flat(), 0x0b];
const BAD = [9, 64], TAKEN = [16, 80], PREFIX = 100, BUF = 1024;
const panic = ([len, ptr]) => [...i64(len), ...i64(ptr), ...call(PANIC), 0x00];
const N = 0, M = 1, K = 2; // locals: input length, predecessor length, key length

const body = [
  ...i64(0), ...call(INPUT),
  ...i64(0), ...call(LEN), ...tee(N), 0x50,                 // n == 0
  ...get(N), ...i64(256), 0x56, 0x72,                       // || n > 256
  ...get(N), ...i64(8), 0x54, 0x72,                         // || n < 8
  ...ifThen(panic(BAD)),
  ...i64(0), ...i64(BUF), ...call(READ),
  ...i32(BUF), 0x29, 3, 0, ...i32(PREFIX), 0x29, 3, 0, 0x52, // first 8 bytes != "swarmkit"
  ...ifThen(panic(BAD)),
  ...get(N), 0xa7, ...i32(BUF), 0x6a, ...i32(0), 0x3a, 0, 0, // key[n] = 0
  ...i64(1), ...call(PRED),
  ...i64(1), ...call(LEN), ...set(M),
  ...i64(1), ...get(N), ...i64(BUF + 1), 0x7c, ...call(READ),
  ...get(N), ...get(M), 0x7c, ...i64(1), 0x7c, ...set(K),
  ...get(K), ...i64(BUF), ...call(HAS), ...i64(0), 0x52,
  ...ifThen(panic(TAKEN)),
  ...i32(0), ...call(TIME), 0x37, 3, 0,                     // mem[0..8] = block_timestamp
  ...get(K), ...i64(BUF), ...i64(8), ...i64(0), ...i64(2), ...call(WRITE), 0x1a,
  ...get(N), ...i64(BUF), ...call(LOG),
  0x0b,
];
const code = [...vec([[3, I64]]), ...body]; // one local group: 3 x i64
const data = (offset, text) => [0, ...i32(offset), 0x0b, ...str(text)];

const wasm = Uint8Array.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  ...section(1, vec(types)),
  ...section(2, vec(imports.map(([name, type]) => [...str("env"), ...str(name), 0x00, ...uleb(type)]))),
  ...section(3, vec([uleb(6)])),
  ...section(5, vec([[0x00, 1]])),                                  // memory, min 1 page
  ...section(7, vec([[...str("anchor"), 0x00, ...uleb(imports.length)], [...str("memory"), 0x02, 0]])),
  ...section(10, vec([[...uleb(code.length), ...code]])),
  ...section(11, vec([data(BAD[1], "bad input"), data(TAKEN[1], "already anchored"), data(PREFIX, "swarmkit")])),
]);
if (!WebAssembly.validate(wasm)) throw new Error("Assembled module is not valid WebAssembly");
const out = fileURLToPath(new URL("./anchor.wasm", import.meta.url));
writeFileSync(out, wasm);
console.log(`${out}\n${wasm.length} bytes sha256 ${createHash("sha256").update(wasm).digest("hex")}`);
