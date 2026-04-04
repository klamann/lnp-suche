/**
 * Headless browser test for search functionality.
 * Starts a local HTTP server, loads Pagefind, runs search queries,
 * and verifies hit-building logic produces expected results.
 *
 * Run: make test (from project root)
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";

const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, "$1");
const DIST_DIR = path.resolve(SCRIPT_DIR, "..", "dist");
const PORT = 9222;

// ---- Serve dist/ over HTTP ----

function startServer() {
  const mimeTypes = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".wasm": "application/wasm",
  };
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, `http://localhost:${PORT}`).pathname);
    let filePath = path.join(DIST_DIR, urlPath);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) filePath = path.join(filePath, "index.html");

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
      res.end(data);
    });
  });
  return new Promise((resolve) => {
    server.listen(PORT, () => resolve(server));
  });
}

// ---- Test runner ----

let passed = 0;
let failed = 0;

function assert(label, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${label}`);
  } else {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${label}`);
    if (detail) console.log(`       ${detail}`);
  }
}

// ---- Main ----

const server = await startServer();
console.log(`Server running on http://localhost:${PORT}`);

const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();

// Expose the Pagefind search API results to Node
page.on("console", (msg) => {
  if (msg.type() === "error") console.log(`  [browser] ${msg.text()}`);
});

await page.goto(`http://localhost:${PORT}/`, { waitUntil: "networkidle0" });

// Run search and extract raw Pagefind data inside the browser
const results = await page.evaluate(async () => {
  const pagefind = await import("/pagefind/pagefind.js");
  await pagefind.init();

  async function searchAndExtract(query) {
    const search = await pagefind.search(query);
    const pages = await Promise.all(search.results.map(r => r.data()));
    return pages.map(p => ({
      title: p.meta?.title || "",
      url: p.meta?.url || "",
      date: p.meta?.date || "",
      content: p.content || "",
      anchors: p.anchors || [],
      locations: p.locations || [],
      sub_results: (p.sub_results || []).map(s => ({
        title: s.title,
        excerpt: s.excerpt,
        anchor: s.anchor,
      })),
      excerpt: p.excerpt || "",
    }));
  }

  return {
    kiloKoks: await searchAndExtract("kilo koks"),
    chatkontrolle: await searchAndExtract("chatkontrolle"),
  };
});

await browser.close();
server.close();

// ---- Test: "kilo koks" raw Pagefind data for LNP410 ----

console.log("\n== kilo koks: raw Pagefind data for LNP410 ==");

const lnp410 = results.kiloKoks.find(p => p.title.includes("410"));
assert("LNP410 found in results", !!lnp410);

if (lnp410) {
  const words = lnp410.content.split(/\s+/);
  const h6Anchors = lnp410.anchors.filter(a => a.element === "h6");

  // Find all word positions containing "kilo" or "koks"
  const kiloKoksWordIndices = [];
  words.forEach((w, i) => {
    if (w.toLowerCase().replace(/[.,;:!?]/g, "").match(/^(kilo|koks)$/)) {
      kiloKoksWordIndices.push(i);
    }
  });

  console.log(`\n  content word count: ${words.length}`);
  console.log(`  h6 anchors: ${h6Anchors.length}`);
  console.log(`  locations (match positions): [${lnp410.locations.join(", ")}]`);
  console.log(`  sub_results: ${lnp410.sub_results.length}`);
  console.log(`  "kilo"/"koks" word indices in content: [${kiloKoksWordIndices.join(", ")}]`);

  // Show context around each "kilo"/"koks" occurrence
  for (const idx of kiloKoksWordIndices) {
    const ctx = words.slice(Math.max(0, idx - 3), idx + 4).join(" ");
    // Find which anchor section this falls in
    const anchor = [...h6Anchors].reverse().find(a => a.location <= idx);
    const inLocations = lnp410.locations.includes(idx);
    console.log(`    word[${idx}] = "${words[idx]}" (speaker: ${anchor?.text || "?"}, in locations: ${inLocations})`);
    console.log(`      context: ...${ctx}...`);
  }

  // ---- Test: hit-building algorithm ----

  console.log("\n== kilo koks: hit-building algorithm ==");

  const paragraphs = h6Anchors.map((a, i) => {
    const headingWords = a.text ? a.text.split(/\s+/).length : 0;
    return {
      id: a.id,
      speaker: a.text || "",
      start: a.location + headingWords,
      end: i + 1 < h6Anchors.length ? h6Anchors[i + 1].location : words.length,
    };
  });

  const hits = [];
  const seen = new Set();
  for (const loc of lnp410.locations) {
    const para = paragraphs.find(p => loc >= p.start && loc < p.end);
    if (!para || seen.has(para.id)) continue;
    seen.add(para.id);

    const paraWords = words.slice(para.start, para.end);
    const paraLocs = lnp410.locations.filter(l => l >= para.start && l < para.end);
    const offsets = new Set(paraLocs.map(l => l - para.start));

    let snippetWords, snippetOffsets, prefix = "", suffix = "";
    if (paraWords.length > 40) {
      const first = Math.min(...offsets);
      const start = Math.max(0, first - 15);
      const end = Math.min(paraWords.length, first + 25);
      snippetWords = paraWords.slice(start, end);
      snippetOffsets = new Set(paraLocs.map(l => l - para.start - start).filter(o => o >= 0 && o < snippetWords.length));
      if (start > 0) prefix = "… ";
      if (end < paraWords.length) suffix = " …";
    } else {
      snippetWords = paraWords;
      snippetOffsets = offsets;
    }

    const excerpt = prefix + snippetWords.map((w, i) =>
      snippetOffsets.has(i) ? `[${w}]` : w
    ).join(" ") + suffix;

    hits.push({ speaker: para.speaker, excerpt, paraId: para.id });
  }

  for (const hit of hits) {
    console.log(`  ${hit.speaker}: ${hit.excerpt}`);
  }

  // 4 hits: 3 literal "Kilo Koks" + 1 stemmed "Kilogramm Kokain" match
  assert("at least 3 hits for 'kilo koks' in LNP410", hits.length >= 3, `got ${hits.length}`);

  // Check no excerpt starts with speaker name
  for (const hit of hits) {
    const plain = hit.excerpt.replace(/\[|\]/g, "");
    assert(
      `excerpt for ${hit.paraId} doesn't start with speaker "${hit.speaker}"`,
      !plain.startsWith(hit.speaker),
      `excerpt: "${plain.substring(0, 80)}"`,
    );
  }
}

// ---- Test: "chatkontrolle" returns multiple episodes ----

console.log("\n== chatkontrolle: multiple episodes ==");
assert(
  "chatkontrolle returns multiple episodes",
  results.chatkontrolle.length >= 3,
  `got ${results.chatkontrolle.length}`,
);

// ---- Summary ----

console.log(`\n== Summary: ${passed} passed, ${failed} failed ==`);
process.exit(failed > 0 ? 1 : 0);
