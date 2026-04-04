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
      totalHits: parseInt(el.dataset.totalHits || "0"),
      orderedPhrase: el.dataset.orderedPhrase === "1",
      adjacentTerms: el.dataset.adjacentTerms === "1",
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

// ---- Test: snippet quality — multi-term snippets should show all terms ----

console.log("\n== DOM test: snippet quality ==");

// For results with termCount=2, the snippet should generally contain both terms.
// Hyphenated variants like "Chat-Kontrolle" may not match the plain text check.
const tc2Results = multiResults.filter(r => r.termCount === 2);
console.log(`  Checking ${tc2Results.length} results with termCount=2`);
let bothTermsCount = 0;
for (const r of tc2Results) {
  const text = r.snippet.toLowerCase();
  const hasBoth = (text.includes("chatkontrolle") || text.includes("chat-kontrolle"))
    && text.includes("johansson");
  if (hasBoth) bothTermsCount++;
  console.log(`  ${hasBoth ? "ok" : "MISS"} ${r.title} | ${r.snippet.substring(0, 100).trim()}`);
}
assert(
  "most tc=2 snippets show both search terms",
  bothTermsCount >= Math.ceil(tc2Results.length * 0.8),
  `${bothTermsCount}/${tc2Results.length} snippets show both terms`,
);

// For "kilo koks", all snippets should show both terms (they always appear together)
const kiloSnippetCheck = await searchAndReadDOM(page, "kilo koks");
const kiloTc2 = kiloSnippetCheck.filter(r => r.termCount === 2);
console.log(`  "kilo koks" results with termCount=2: ${kiloTc2.length}`);
for (const r of kiloTc2) {
  const text = r.snippet.toLowerCase();
  assert(
    `"kilo koks" snippet shows both terms: ${r.title}`,
    text.includes("kilo") && text.includes("koks"),
    `"${r.snippet.substring(0, 120).trim()}"`,
  );
}

// ---- Test: sort by date ----

console.log("\n== DOM test: sort by date ==");

// Search, then switch to date-desc
const sortResults = await searchAndReadDOM(page, "chatkontrolle");
console.log(`  Results before sort change: ${sortResults.length}`);

await page.select("#sort-select", "date-desc");
await new Promise(r => setTimeout(r, 500));
const dateDescResults = await page.evaluate(() => {
  return Array.from(document.querySelectorAll(".result-item")).map(el => ({
    date: el.querySelector(".result-date")?.textContent || "",
  }));
});

let dateDescOk = true;
for (let i = 1; i < dateDescResults.length; i++) {
  if (dateDescResults[i].date > dateDescResults[i - 1].date) {
    dateDescOk = false;
    break;
  }
}
console.log(`  date-desc results: ${dateDescResults.length}`);
assert("date-desc: dates are non-increasing", dateDescOk);

// Switch to date-asc
await page.select("#sort-select", "date-asc");
await new Promise(r => setTimeout(r, 500));
const dateAscResults = await page.evaluate(() => {
  return Array.from(document.querySelectorAll(".result-item")).map(el => ({
    date: el.querySelector(".result-date")?.textContent || "",
  }));
});

let dateAscOk = true;
for (let i = 1; i < dateAscResults.length; i++) {
  if (dateAscResults[i].date < dateAscResults[i - 1].date) {
    dateAscOk = false;
    break;
  }
}
assert("date-asc: dates are non-decreasing", dateAscOk);

// Reset sort
await page.select("#sort-select", "relevance");
await new Promise(r => setTimeout(r, 500));

// ---- Test: date filter ----

console.log("\n== DOM test: date filter ==");

// Filter to last year
await page.select("#date-filter", "year");
await new Promise(r => setTimeout(r, 500));
const yearResults = await page.evaluate(() => {
  return Array.from(document.querySelectorAll(".result-item")).map(el => ({
    date: el.querySelector(".result-date")?.textContent || "",
  }));
});

const oneYearAgo = new Date();
oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
const oneYearAgoStr = oneYearAgo.toISOString().slice(0, 10);
const allDatesInRange = yearResults.every(r => r.date >= oneYearAgoStr);
console.log(`  year filter results: ${yearResults.length}, cutoff: ${oneYearAgoStr}`);
assert("date filter 'year': all dates within last year", allDatesInRange);

// Reset to all
await page.select("#date-filter", "all");
await new Promise(r => setTimeout(r, 500));
const allResults = await page.evaluate(() => {
  return Array.from(document.querySelectorAll(".result-item")).map(el => ({
    date: el.querySelector(".result-date")?.textContent || "",
  }));
});

const dates = allResults.map(r => r.date).filter(Boolean);
const dateSpan = dates.length > 0 ? dates[0] > dates[dates.length - 1] : false;
const minDate = dates.reduce((a, b) => a < b ? a : b, "9999");
const maxDate = dates.reduce((a, b) => a > b ? a : b, "0000");
const spanDays = (new Date(maxDate) - new Date(minDate)) / 86400000;
console.log(`  all filter results: ${allResults.length}, date range: ${minDate} to ${maxDate} (${Math.round(spanDays)} days)`);
assert("date filter 'all': results span more than 1 year", spanDays > 365);

assert("year filter returns fewer results than all", yearResults.length < allResults.length);

// ---- Test: speaker filter ----

console.log("\n== DOM test: speaker filter ==");

// Get speaker counts from panel
const speakerInfo = await page.evaluate(() => {
  const labels = document.querySelectorAll("#speaker-panel label");
  return Array.from(labels).slice(0, 5).map(l => ({
    name: l.querySelector(".speaker-name")?.textContent?.trim() || "",
    count: l.querySelector(".speaker-count")?.textContent?.trim() || "",
    checked: l.querySelector("input")?.checked || false,
  }));
});
console.log(`  Top speakers: ${speakerInfo.map(s => `${s.name} ${s.count}`).join(", ")}`);

assert(
  "speaker counts shown after search",
  speakerInfo.some(s => s.count && s.count !== "(0)"),
  `counts: ${speakerInfo.map(s => s.count).join(", ")}`,
);

// Uncheck all speakers, then check only one
const targetSpeaker = "Linus Neumann";
await page.evaluate((target) => {
  const cbs = document.querySelectorAll("#speaker-panel input[type=checkbox]");
  for (const cb of cbs) {
    cb.checked = cb.value === target;
  }
  // Trigger change on last one to re-render
  cbs[0].dispatchEvent(new Event("change"));
}, targetSpeaker);
await new Promise(r => setTimeout(r, 500));

const filteredResults = await page.evaluate(() => {
  return Array.from(document.querySelectorAll(".result-item")).map(el => ({
    snippet: el.querySelector(".result-snippet")?.textContent || "",
  }));
});

console.log(`  Filtered to "${targetSpeaker}": ${filteredResults.length} results`);

const allMatchSpeaker = filteredResults.every(r => {
  const parts = r.snippet.split(": ");
  return parts.length >= 2 && parts[0].trim() === targetSpeaker;
});
assert(
  `all filtered results are by ${targetSpeaker}`,
  allMatchSpeaker,
  `first non-match: ${filteredResults.find(r => !r.snippet.startsWith(targetSpeaker))?.snippet?.substring(0, 80)}`,
);

assert(
  "speaker filter reduces result count",
  filteredResults.length < allResults.length,
  `filtered: ${filteredResults.length}, all: ${allResults.length}`,
);

// Re-check all speakers
await page.evaluate(() => {
  const cbs = document.querySelectorAll("#speaker-panel input[type=checkbox]");
  for (const cb of cbs) cb.checked = true;
  cbs[0].dispatchEvent(new Event("change"));
});
await new Promise(r => setTimeout(r, 500));

const restoredCount = await page.evaluate(() =>
  document.querySelectorAll(".result-item").length
);
assert(
  "re-checking all speakers restores full results",
  restoredCount === allResults.length,
  `restored: ${restoredCount}, expected: ${allResults.length}`,
);

// ---- Test: quoted phrase search "fünf blockchains" ----

console.log("\n== DOM test: quoted phrase search ==");

// No snippet should contain duplicate ellipsis ("… …")
const snippetCheckResults = await searchAndReadDOM(page, "fünf blockchains");
const dupeEllipsis = snippetCheckResults.filter(r => r.snippet.includes("… …"));
for (const r of dupeEllipsis) {
  console.log(`  DUPE: ${r.snippet.substring(0, 120).trim()}`);
}
assert(
  "no snippets with duplicate ellipsis",
  dupeEllipsis.length === 0,
  `${dupeEllipsis.length} snippets have "… …"`,
);

// Unquoted search should find results, with exact phrase matches ranked first
const unquotedResults = snippetCheckResults;
console.log(`  Unquoted "fünf blockchains": ${unquotedResults.length} results`);
assert(
  "unquoted 'fünf blockchains' returns results",
  unquotedResults.length > 0,
);

// Show ranking fields for top results
for (let i = 0; i < Math.min(5, unquotedResults.length); i++) {
  const r = unquotedResults[i];
  console.log(`  [${i}] ord=${r.orderedPhrase} adj=${r.adjacentTerms} tc=${r.termCount} th=${r.totalHits} ${r.title} | ${r.snippet.substring(0, 60).trim()}`);
}

// Ordered phrase matches must come before non-phrase matches
const firstNonOrdered = unquotedResults.findIndex(r => !r.orderedPhrase);
const lastOrdered = unquotedResults.map(r => r.orderedPhrase).lastIndexOf(true);
assert(
  "ordered phrase results ranked before non-phrase results",
  lastOrdered < firstNonOrdered || lastOrdered === -1,
  `last ordered at ${lastOrdered}, first non-ordered at ${firstNonOrdered}`,
);

// Top result should have ordered phrase match
assert(
  "top result has ordered phrase match",
  unquotedResults[0]?.orderedPhrase === true,
  `orderedPhrase=${unquotedResults[0]?.orderedPhrase}`,
);

// Verify umlaut normalization works for quoted phrase search at Pagefind level
const pfQuotedCount = await page.evaluate(async () => {
  const pf = await import("./pagefind/pagefind.js");
  const r = await pf.search('"funf blockchains"');
  return r.results.length;
});
console.log(`  Pagefind API '"funf blockchains"': ${pfQuotedCount} results`);
assert(
  "Pagefind finds quoted 'funf blockchains' (umlaut-normalized)",
  pfQuotedCount > 0,
  `got ${pfQuotedCount} results`,
);

// Quoted search via UI must also return results
const quotedResults = await searchAndReadDOM(page, '"fünf blockchains"');
console.log(`  Quoted '"fünf blockchains"': ${quotedResults.length} results`);
assert(
  "quoted phrase search returns results",
  quotedResults.length > 0,
  "got 0 results",
);

// Every result from a quoted search should contain the exact phrase
for (const r of quotedResults) {
  const text = r.snippet.replace(/^[^:]+:\s*/, "").toLowerCase();
  assert(
    `quoted result contains exact phrase: ${r.title}`,
    text.includes("fünf blockchains"),
    `"${r.snippet.substring(0, 100).trim()}"`,
  );
}

// ---- Cleanup ----

await browser.close();
serverProc.kill();

// ---- Summary ----

console.log(`\n== Summary: ${passed} passed, ${failed} failed ==`);
process.exit(failed > 0 ? 1 : 0);
