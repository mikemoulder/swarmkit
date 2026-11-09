import { copyFile, readFile, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const { name, version, engines, license } = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const manifest = {
  name,
  version,
  license,
  type: "module",
  engines,
  exports: { ".": { types: "./index.d.ts", import: "./index.js" } },
  files: ["*.js", "*.d.ts", "LICENSE-MIT", "LICENSE-APACHE"],
};
await writeFile(new URL("dist/sdk/package.json", root), JSON.stringify(manifest, null, 2) + "\n");
await Promise.all(
  ["LICENSE-MIT", "LICENSE-APACHE"].map((file) =>
    copyFile(new URL(file, root), new URL(`dist/sdk/${file}`, root))),
);
