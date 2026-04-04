/**
 * End-to-end search test.
 * Loads the actual search page in a headless browser, types queries,
 * and inspects ONLY the rendered DOM — no separate Pagefind imports.
 *
 * Run: make test (from project root)
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";

const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, "$1");
const DIST_DIR = path.resolve(SCRIPT_DIR, "..", "dist");
const PORT = 9222;

// ---- Serve dist/ using npx serve (same as make serve) ----

function startServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn("npx", ["serve", DIST_DIR, "-l", String(PORT), "--no-clipboard"], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
    });
    let started = false;
    const onData = (chunk) => {
      const text = chunk.toString();
      if (!started && text.includes("Accepting connections")) {
        started = true;
        resolve(proc);
      }
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    setTimeout(() => {
      if (!started) {
        // Give it a moment — serve might be slow to print
        started = true;
        resolve(proc);
      }
    }, 5000);
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

// ---- Preflight: verify dist/ has the expected code ----

const distIndex = fs.readFileSync(path.join(DIST_DIR, "index.html"), "utf-8");
const hasManualApproach = distIndex.includes("headingWords");
const hasSubResults = distIndex.includes("sub_results");
if (!hasManualApproach) {
  console.error("\x1b[31mERROR: dist/index.html is stale — missing manual hit-building code.\x1b[0m");
  console.error("Run 'make build' first to rebuild dist/ from site/.");
  process.exit(2);
}
if (hasSubResults) {
  console.error("\x1b[31mERROR: dist/index.html still has sub_results code — stale build.\x1b[0m");
  console.error("Run 'make build' first to rebuild dist/ from site/.");
  process.exit(2);
}
console.log("  dist/index.html has expected code");

// ---- Helper: search and read DOM results ----

async function searchAndReadDOM(page, query) {
  // Clear previous results and input
  await page.evaluate(() => {
    document.getElementById("search-input").value = "";
    document.getElementById("results").innerHTML = "";
  });

  // Type the full query, then wait for debounce + render
  await page.type("#search-input", query);
  try {
    await page.waitForFunction(
      () => document.querySelectorAll(".result-item").length > 0,
      { timeout: 10000 },
    );
  } catch {
    console.log(`  [timeout] No results rendered for "${query}"`);
    return [];
  }

  // Wait for search to fully settle (debounce is 200ms, give extra time)
  await new Promise(r => setTimeout(r, 1000));

  // Read final DOM state
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll(".result-item")).map(el => ({
      title: el.querySelector(".result-title a")?.textContent || "",
      date: el.querySelector(".result-date")?.textContent || "",
      snippet: el.querySelector(".result-snippet")?.textContent || "",
      snippetHtml: el.querySelector(".result-snippet")?.innerHTML || "",
      link: el.querySelector(".result-snippet a")?.href || "",
      termCount: parseInt(el.dataset.termCount || "0"),
    }));
  });
}

// ---- Main ----

const serverProc = await startServer();
console.log(`npx serve running on http://localhost:${PORT}`);
console.log(`Serving: ${DIST_DIR}`);

const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();

// Log ALL browser console messages for debugging
page.on("console", (msg) => {
  console.log(`  [browser:${msg.type()}] ${msg.text()}`);
});

await page.goto(`http://localhost:${PORT}/`, { waitUntil: "networkidle0" });

// Verify the page loaded correctly
const pageTitle = await page.title();
console.log(`  Page title: "${pageTitle}"`);

// ---- Test: "kilo koks" — multiple results per episode ----

console.log("\n== DOM test: 'kilo koks' ==");

const kiloResults = await searchAndReadDOM(page, '"kilo koks"');
console.log(`  Total DOM results: ${kiloResults.length}`);

// Show ALL results
for (let i = 0; i < kiloResults.length; i++) {
  const r = kiloResults[i];
  const tag = r.title.includes("410") ? " <<<" : "";
  console.log(`  [${i}] ${r.title} | ${r.snippet.substring(0, 80).trim()}${tag}`);
}

const lnp410Results = kiloResults.filter(r => r.title.includes("410"));
console.log(`\n  LNP410 results in DOM: ${lnp410Results.length}`);
for (const r of lnp410Results) {
  console.log(`    snippet: ${r.snippet.trim()}`);
  console.log(`    link: ${r.link}`);
}

assert(
  "at least 3 DOM results for LNP410",
  lnp410Results.length >= 3,
  `got ${lnp410Results.length}`,
);

// Quoted phrase search: every snippet must contain the exact phrase
for (const r of kiloResults) {
  const text = r.snippet.replace(/^[^:]+:\s*/, "").toLowerCase();
  assert(
    `snippet contains "kilo koks": ${r.title}`,
    text.includes("kilo koks"),
    `"${r.snippet.substring(0, 100).trim()}"`,
  );
}

// Verify no speaker name duplication
for (const r of lnp410Results) {
  const parts = r.snippet.split(": ");
  if (parts.length >= 2) {
    const speaker = parts[0].trim();
    const rest = parts.slice(1).join(": ").trim();
    assert(
      `no duplicate speaker "${speaker}" in snippet`,
      !rest.startsWith(speaker),
      `"${r.snippet.substring(0, 100).trim()}"`,
    );
  }
}

// ---- Test: "chatkontrolle" — multiple episodes ----

console.log("\n== DOM test: 'chatkontrolle' ==");

const chatResults = await searchAndReadDOM(page, "chatkontrolle");
const chatEpisodes = new Set(chatResults.map(r => r.title));
console.log(`  Total DOM results: ${chatResults.length}`);
console.log(`  Distinct episodes: ${chatEpisodes.size}`);

assert(
  "chatkontrolle returns results from multiple episodes",
  chatEpisodes.size >= 3,
  `got ${chatEpisodes.size} episodes`,
);

// ---- Test: multi-term ranking — both terms should appear before single terms ----

console.log("\n== DOM test: 'chatkontrolle johansson' ranking ==");

const multiResults = await searchAndReadDOM(page, "chatkontrolle johansson");
console.log(`  Total DOM results: ${multiResults.length}`);

// Show first 15 results with their termCount
const top = multiResults.slice(0, 15);
for (let i = 0; i < top.length; i++) {
  const r = top[i];
  console.log(`  [${i}] tc=${r.termCount} ${r.title} | ${r.snippet.substring(0, 60).trim()}`);
}

// termCount distribution
const tcCounts = {};
for (const r of multiResults) tcCounts[r.termCount] = (tcCounts[r.termCount] || 0) + 1;
console.log(`\n  termCount distribution: ${JSON.stringify(tcCounts)}`);

// All termCount=2 results should appear before any termCount=1
const firstTc1 = multiResults.findIndex(r => r.termCount < 2);
const lastTc2 = multiResults.map(r => r.termCount).lastIndexOf(2);
console.log(`  first tc<2 at index: ${firstTc1}, last tc=2 at index: ${lastTc2}`);

assert(
  "all multi-term hits sorted before single-term hits",
  lastTc2 < firstTc1 || lastTc2 === -1,
  `last tc=2 at ${lastTc2}, first tc<2 at ${firstTc1}`,
);

// ---- Cleanup ----

await browser.close();
serverProc.kill();

// ---- Summary ----

console.log(`\n== Summary: ${passed} passed, ${failed} failed ==`);
process.exit(failed > 0 ? 1 : 0);
