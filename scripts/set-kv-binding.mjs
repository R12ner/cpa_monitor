import { readFile, writeFile } from "node:fs/promises";

const id = process.argv[2]?.trim();

if (!id || !/^[a-f0-9]{32}$/i.test(id)) {
  console.error("Usage: npm run kv:bind -- <32-character-kv-namespace-id>");
  process.exit(1);
}

const file = "wrangler.toml";
const original = await readFile(file, "utf8");
const block = `[[kv_namespaces]]
binding = "CPA_MONITOR_KV"
id = "${id}"`;

let next;
if (/\[\[kv_namespaces\]\][\s\S]*?binding\s*=\s*"CPA_MONITOR_KV"[\s\S]*?(?=\n\[\[|\n[a-zA-Z_][\w-]*\s*=|$)/.test(original)) {
  next = original.replace(
    /\[\[kv_namespaces\]\][\s\S]*?binding\s*=\s*"CPA_MONITOR_KV"[\s\S]*?(?=\n\[\[|\n[a-zA-Z_][\w-]*\s*=|$)/,
    block,
  );
} else {
  next = `${original.trimEnd()}\n\n${block}\n`;
}

await writeFile(file, next);
console.log(`Bound CPA_MONITOR_KV to ${id} in ${file}`);
