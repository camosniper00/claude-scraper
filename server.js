const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// In-memory cache to avoid re-scraping on every request
const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

function getCached(key) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.timestamp < CACHE_TTL) {
    return entry.data;
  }
  cache.delete(key);
  return null;
}

function setCache(key, data) {
  cache.set(key, { data, timestamp: Date.now() });
}

// Extract a text summary from a page's body content
function extractSummary(html, maxSentences = 3) {
  const $ = cheerio.load(html);

  // Remove script, style, nav, header, footer, aside elements
  $(
    "script, style, nav, header, footer, aside, .sidebar, .menu, .nav, .advertisement, .ad, .cookie, noscript, iframe"
  ).remove();

  // Try to find the main article content
  const selectors = [
    "article",
    '[role="main"]',
    ".post-content",
    ".entry-content",
    ".article-content",
    ".blog-content",
    ".content-body",
    ".post-body",
    "main",
    ".main-content",
  ];

  let text = "";
  for (const selector of selectors) {
    const el = $(selector);
    if (el.length && el.text().trim().length > 100) {
      text = el.text();
      break;
    }
  }

  // Fallback to body text
  if (!text) {
    text = $("body").text();
  }

  // Clean up whitespace
  text = text.replace(/\s+/g, " ").trim();

  // Extract sentences
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [];
  const meaningful = sentences
    .map((s) => s.trim())
    .filter((s) => s.length > 30 && s.length < 500);

  if (meaningful.length === 0) {
    // Fallback: just grab a chunk
    return text.substring(0, 300) + (text.length > 300 ? "..." : "");
  }

  return meaningful.slice(0, maxSentences).join(" ");
}

// Scrape headlines from a given URL
async function scrapeHeadlines(url) {
  const cached = getCached(url);
  if (cached) return cached;

  const { data: html } = await axios.get(url, {
    timeout: 15000,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });

  const $ = cheerio.load(html);

  const headlines = [];
  const seen = new Set();

  // Look for headline elements — h1, h2, h3 inside article/blog containers
  const headlineSelectors = [
    "article h1 a",
    "article h2 a",
    "article h3 a",
    ".post h2 a",
    ".post h3 a",
    ".blog-post h2 a",
    ".entry-title a",
    "h2.post-title a",
    "h3.post-title a",
    "h2 a",
    "h3 a",
    "h1 a",
    "article h1",
    "article h2",
    "article h3",
    ".post-title",
    ".entry-title",
    ".blog-title",
    ".article-title",
  ];

  for (const selector of headlineSelectors) {
    $(selector).each((_, el) => {
      const title = $(el).text().trim();
      let link = $(el).attr("href") || $(el).find("a").attr("href") || "";

      if (!title || title.length < 5 || title.length > 300) return;
      if (seen.has(title.toLowerCase())) return;

      // Resolve relative URLs
      if (link && !link.startsWith("http")) {
        try {
          link = new URL(link, url).href;
        } catch {
          link = "";
        }
      }

      seen.add(title.toLowerCase());
      headlines.push({ title, link, summary: null });
    });

    if (headlines.length >= 20) break;
  }

  setCache(url, headlines);
  return headlines;
}

// Fetch summary for a single article URL
async function fetchArticleSummary(articleUrl) {
  const cacheKey = `summary:${articleUrl}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const { data: html } = await axios.get(articleUrl, {
      timeout: 12000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    const summary = extractSummary(html);
    setCache(cacheKey, summary);
    return summary;
  } catch {
    return "Summary unavailable — could not fetch article content.";
  }
}

// API: Scrape headlines from a URL
app.post("/api/scrape", async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: "URL is required" });
  }

  try {
    new URL(url);
  } catch {
    return res.status(400).json({ error: "Invalid URL format" });
  }

  try {
    const headlines = await scrapeHeadlines(url);

    // Fetch summaries in parallel (limit concurrency to 5)
    const withSummaries = [];
    const batchSize = 5;
    for (let i = 0; i < headlines.length; i += batchSize) {
      const batch = headlines.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map(async (h) => {
          if (h.link) {
            const summary = await fetchArticleSummary(h.link);
            return { ...h, summary };
          }
          return { ...h, summary: "No link available for summary." };
        })
      );
      withSummaries.push(...results);
    }

    res.json({
      source: url,
      count: withSummaries.length,
      headlines: withSummaries,
    });
  } catch (err) {
    res.status(500).json({
      error: `Failed to scrape: ${err.message}`,
    });
  }
});

// Serve the frontend
app.get("/", (_, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Headline Scraper running at http://localhost:${PORT}`);
});
