import { search } from "./dist/src/lib/search.js";
import { loadMetadata } from "./dist/src/lib/metadata.js";

async function main() {
  loadMetadata();
  const query = "Unified Rendering OSS note transport steps after update";
  console.log("Searching for:", query);
  const results = await search(query, { k: 10, includeOnline: true });
  console.log("Results count:", results.length);
  for (const r of results) {
    console.log("-----------------------------------------");
    console.log("ID:", r.id);
    console.log("Title:", r.text ? r.text.split("\n")[0] : "");
    console.log("URL:", r.path);
    console.log("Snippet:", r.text ? r.text.substring(0, 300) : "");
  }
}

main().catch(console.error);
