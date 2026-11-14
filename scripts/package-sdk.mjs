import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const { name, version, description, engines, license, repository, homepage, bugs } =
  JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const manifest = {
  name,
  version,
  description,
  repository,
  homepage,
  bugs,
  license,
  type: "module",
  engines,
  exports: { ".": { types: "./index.d.ts", import: "./index.js" } },
  keywords: ["near", "near-protocol", "near-intents", "ai-agents", "multi-agent", "swarm", "agent-economy",
    "sealed-bid", "auction", "procurement", "collective-purchasing", "settlement", "typescript"],
  files: ["*.js", "*.d.ts", "LICENSE-MIT", "LICENSE-APACHE", "examples"],
};
await writeFile(new URL("dist/sdk/package.json", root), JSON.stringify(manifest, null, 2) + "\n");
await mkdir(new URL("dist/sdk/examples/", root), { recursive: true });
await Promise.all(
  [
    ["LICENSE-MIT", "LICENSE-MIT"],
    ["LICENSE-APACHE", "LICENSE-APACHE"],
    ["examples/dataset-market.mjs", "examples/dataset-market.mjs"],
    ["examples/split-market.mjs", "examples/split-market.mjs"],
    ["examples/incremental-market.mjs", "examples/incremental-market.mjs"],
    ["examples/sqlite-round-store.mjs", "examples/sqlite-round-store.mjs"],
    ["examples/agent-service.mjs", "examples/agent-service.mjs"],
  ].map(([source, destination]) =>
    copyFile(new URL(source, root), new URL(`dist/sdk/${destination}`, root))),
);

// The npm page renders README.md out of context: make every relative link and image absolute.
const blob = "https://github.com/mikemoulder/swarmkit/blob/main/";
const raw = "https://raw.githubusercontent.com/mikemoulder/swarmkit/main/";
const absolute = (url, base) => /^(https?:|mailto:|#)/.test(url) ? url : base + url.replace(/^\.\//, "");
const readme = (await readFile(new URL("README.md", root), "utf8"))
  .replace(/(<img[^>]*src=")([^"]+)"/g, (_, head, url) => `${head}${absolute(url, raw)}"`)
  .replace(/(<a[^>]*href=")([^"]+)"/g, (_, head, url) => `${head}${absolute(url, blob)}"`)
  .replace(/(!\[[^\]]*\]\()([^)\s]+)\)/g, (_, head, url) => `${head}${absolute(url, raw)})`)
  .replace(/(\[[^\]]*\]\()([^)\s]+)\)/g, (_, head, url) => `${head}${absolute(url, blob)})`);
await writeFile(new URL("dist/sdk/README.md", root), readme);
