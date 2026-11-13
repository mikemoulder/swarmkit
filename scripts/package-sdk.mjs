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
  files: ["*.js", "*.d.ts", "LICENSE-MIT", "LICENSE-APACHE", "examples"],
};
await writeFile(new URL("dist/sdk/package.json", root), JSON.stringify(manifest, null, 2) + "\n");
await mkdir(new URL("dist/sdk/examples/", root), { recursive: true });
await Promise.all(
  [
    ["LICENSE-MIT", "LICENSE-MIT"],
    ["LICENSE-APACHE", "LICENSE-APACHE"],
    ["scripts/README.md", "README.md"],
    ["examples/dataset-market.mjs", "examples/dataset-market.mjs"],
    ["examples/split-market.mjs", "examples/split-market.mjs"],
  ].map(([source, destination]) =>
    copyFile(new URL(source, root), new URL(`dist/sdk/${destination}`, root))),
);
