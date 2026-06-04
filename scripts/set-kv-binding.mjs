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
const activeBindingPattern =
  /\[\[kv_namespaces\]\][\s\S]*?binding\s*=\s*"CPA_MONITOR_KV"[\s\S]*?(?=\n\[\[|\n[a-zA-Z_][\w-]*\s*=|$)/;
const commentedExamplePattern =
  /#\s*\[\[kv_namespaces\]\]\s*\r?\n\s*#?\s*binding\s*=\s*"CPA_MONITOR_KV"\s*\r?\n\s*#?\s*id\s*=\s*"[^"]*"/;

if (activeBindingPattern.test(original)) {
  next = original.replace(
    activeBindingPattern,
    block,
  );
} else if (commentedExamplePattern.test(original)) {
  next = original.replace(
    commentedExamplePattern,
    block,
  );
} else {
  next = `${original.trimEnd()}\n\n${block}\n`;
}

await writeFile(file, next);
console.log(`Bound CPA_MONITOR_KV to ${id} in ${file}`);
