// Keeps the root `pi` manifest equal to the union of every workspace package's
// manifest, so `pi install git:github.com/geminixiang/pi-stuff` installs the whole suite.
// Usage: node scripts/suite-manifest.mjs [--write]
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const rootPkgPath = join(root, "package.json");
const rootPkg = JSON.parse(readFileSync(rootPkgPath, "utf8"));
const kinds = ["extensions", "skills", "prompts", "themes"];

const expected = { extensions: [], skills: ["./skills"], prompts: [], themes: [] };
for (const dir of readdirSync(join(root, "packages")).sort()) {
  const pkg = JSON.parse(readFileSync(join(root, "packages", dir, "package.json"), "utf8"));
  for (const kind of kinds) {
    for (const entry of pkg.pi?.[kind] ?? []) {
      expected[kind].push(`./packages/${dir}/${entry.replace(/^\.\//, "")}`);
    }
  }
}
const manifest = Object.fromEntries(kinds.filter((kind) => expected[kind].length).map((kind) => [kind, expected[kind]]));

if (process.argv.includes("--write")) {
  rootPkg.pi = manifest;
  writeFileSync(rootPkgPath, `${JSON.stringify(rootPkg, null, 2)}\n`);
  console.log("root pi manifest updated");
} else if (JSON.stringify(rootPkg.pi) !== JSON.stringify(manifest)) {
  console.error("root pi manifest is out of date; run: node scripts/suite-manifest.mjs --write");
  process.exit(1);
} else {
  console.log(`root pi manifest covers ${manifest.extensions?.length ?? 0} extensions and ${manifest.skills?.length ?? 0} skill roots`);
}
