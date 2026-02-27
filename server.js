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

  // First try meta description — often the best short summary
  const metaDesc =
    $('meta[name="description"]').attr("content") ||
    $('meta[property="og:description"]').attr("content") ||
    $('meta[name="twitter:description"]').attr("content") ||
    "";

  if (metaDesc.trim().length > 50) {
    return metaDesc.trim();
  }

  // Remove noisy elements
  $(
    "script, style, nav, header, footer, aside, .sidebar, .menu, .nav, .advertisement, .ad, .ads, .cookie, .popup, .modal, .comments, .comment-section, .related-posts, .share, .social, noscript, iframe, svg, form"
  ).remove();

  // Try to find the main article content — expanded selector list
  const selectors = [
    "article .entry-content",
    "article .post-content",
    ".post-content",
    ".entry-content",
    ".article-content",
    ".article-body",
    ".blog-content",
    ".content-body",
    ".post-body",
    ".story-body",
    '[class*="article-body"]',
    '[class*="post-content"]',
    '[class*="entry-content"]',
    '[class*="blog-content"]',
    '[class*="rich-text"]',
    "article",
    '[role="main"]',
    "main",
    ".main-content",
    "#content",
    ".content",
  ];

  let text = "";
  for (const selector of selectors) {
    const el = $(selector);
    if (el.length) {
      // Get only paragraph text to avoid nav/heading noise
      const paragraphs = el.find("p");
      if (paragraphs.length > 0) {
        text = paragraphs
          .map((_, p) => $(p).text().trim())
          .get()
          .filter((t) => t.length > 30)
          .join(" ");
      }
      if (!text || text.length < 100) {
        text = el.text();
      }
      if (text.trim().length > 100) break;
    }
  }

  // Fallback: grab all <p> tags on the page
  if (!text || text.length < 100) {
    text = $("p")
      .map((_, p) => $(p).text().trim())
      .get()
      .filter((t) => t.length > 30)
      .join(" ");
  }

  // Last fallback to body text
  if (!text || text.length < 50) {
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
    return text.substring(0, 300) + (text.length > 300 ? "..." : "");
  }

  return meaningful.slice(0, maxSentences).join(" ");
}

// Resolve a link relative to a base URL
function resolveUrl(link, baseUrl) {
  if (!link || link.startsWith("#") || link.startsWith("javascript:")) {
    return "";
  }
  if (link.startsWith("http")) return link;
  try {
    return new URL(link, baseUrl).href;
  } catch {
    return "";
  }
}

// Determine if a link looks like a blog/article page (not a category, tag, or homepage)
function looksLikeArticleUrl(link) {
  if (!link) return false;
  // Filter out anchors, common non-article paths
  const skip =
    /\/(tag|category|author|page|search|login|signup|cart|contact|about|privacy|terms|feed|rss)\b/i;
  if (skip.test(link)) return false;
  return true;
}

// Scrape headlines from a given URL
async function scrapeHeadlines(url) {
  const cached = getCached(url);
  if (cached) return cached;

  const { data: html } = await axios.get(url, {
    timeout: 20000,
    maxRedirects: 5,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      "Cache-Control": "no-cache",
    },
  });

  const $ = cheerio.load(html);
  const baseHost = new URL(url).hostname;

  const headlines = [];
  const seen = new Set();

  function addHeadline(title, link) {
    title = title.replace(/\s+/g, " ").trim();
    if (!title || title.length < 10 || title.length > 300) return;
    if (seen.has(title.toLowerCase())) return;

    link = resolveUrl(link, url);

    // Skip links that point to external domains or non-article pages
    if (link) {
      try {
        const linkHost = new URL(link).hostname;
        if (!linkHost.includes(baseHost) && !baseHost.includes(linkHost)) {
          return;
        }
      } catch {
        // keep going
      }
    }

    seen.add(title.toLowerCase());
    headlines.push({ title, link, summary: null });
  }

  // ----- Strategy 1: Targeted selectors (heading elements with links) -----
  const headingLinkSelectors = [
    "article h1 a",
    "article h2 a",
    "article h3 a",
    ".post h2 a",
    ".post h3 a",
    ".blog-post h2 a",
    ".entry-title a",
    ".post-title a",
    ".article-title a",
    ".card-title a",
    ".story-title a",
    '[class*="post"] h2 a',
    '[class*="post"] h3 a',
    '[class*="blog"] h2 a',
    '[class*="blog"] h3 a',
    '[class*="article"] h2 a',
    '[class*="article"] h3 a',
    '[class*="card"] h2 a',
    '[class*="card"] h3 a',
    '[class*="entry"] h2 a',
    '[class*="entry"] h3 a',
  ];

  for (const selector of headingLinkSelectors) {
    $(selector).each((_, el) => {
      addHeadline($(el).text(), $(el).attr("href"));
    });
  }

  // ----- Strategy 2: Standalone heading selectors (no link inside) -----
  const headingSelectors = [
    "article h1",
    "article h2",
    "article h3",
    ".post-title",
    ".entry-title",
    ".blog-title",
    ".article-title",
    ".card-title",
  ];

  for (const selector of headingSelectors) {
    $(selector).each((_, el) => {
      const $el = $(el);
      const link =
        $el.find("a").attr("href") ||
        $el.closest("a").attr("href") ||
        $el.parent("a").attr("href") ||
        "";
      addHeadline($el.text(), link);
    });
  }

  // ----- Strategy 3: Generic h2/h3 with links -----
  $("h2 a, h3 a").each((_, el) => {
    addHeadline($(el).text(), $(el).attr("href"));
  });

  // ----- Strategy 4: Links that look like blog posts -----
  // Look for <a> tags with long-ish text that point to article-like URLs
  if (headlines.length < 5) {
    $("a").each((_, el) => {
      if (headlines.length >= 30) return false;
      const $el = $(el);
      const href = $el.attr("href") || "";
      const text = $el.text().trim();

      // Skip nav-like or tiny links
      if (!text || text.length < 15 || text.length > 300) return;
      // Skip if it has too many child elements (likely a complex widget, not a title)
      if ($el.children().length > 3) return;

      const resolved = resolveUrl(href, url);
      if (resolved && looksLikeArticleUrl(resolved)) {
        // Check the URL path has some depth (likely a blog post, not homepage)
        try {
          const pathname = new URL(resolved).pathname;
          if (pathname.split("/").filter(Boolean).length >= 1) {
            addHeadline(text, href);
          }
        } catch {
          // skip
        }
      }
    });
  }

  // ----- Strategy 5: RSS/Atom feed discovery -----
  if (headlines.length === 0) {
    const feedUrl =
      $('link[type="application/rss+xml"]').attr("href") ||
      $('link[type="application/atom+xml"]').attr("href");

    if (feedUrl) {
      try {
        const resolvedFeed = resolveUrl(feedUrl, url);
        const { data: feedXml } = await axios.get(resolvedFeed, {
          timeout: 15000,
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          },
        });
        const $feed = cheerio.load(feedXml, { xmlMode: true });

        $feed("item, entry").each((_, el) => {
          if (headlines.length >= 30) return false;
          const title =
            $feed(el).find("title").first().text() || "";
          const link =
            $feed(el).find("link").attr("href") ||
            $feed(el).find("link").text() ||
            "";
          addHeadline(title, link);
        });
      } catch {
        // feed fetch failed, continue
      }
    }
  }

  setCache(url, headlines);
  return headlines;
}

// Fetch summary for a single article URL with retry
async function fetchArticleSummary(articleUrl) {
  const cacheKey = `summary:${articleUrl}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    Referer: articleUrl,
  };

  // Try up to 2 times
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { data: html } = await axios.get(articleUrl, {
        timeout: 15000,
        maxRedirects: 5,
        headers,
      });

      const summary = extractSummary(html);
      if (summary && summary.length > 20) {
        setCache(cacheKey, summary);
        return summary;
      }
    } catch {
      if (attempt === 0) {
        // Brief pause before retry
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  return "Summary unavailable — could not fetch article content.";
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
