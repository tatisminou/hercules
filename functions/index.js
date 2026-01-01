const {onRequest} = require("firebase-functions/v2/https");
const {defineSecret} = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const YahooFinance = require("yahoo-finance2").default;
const yahooFinance = new YahooFinance();
const {v4: uuidv4} = require("uuid");

// Initialize Firebase Admin
admin.initializeApp();
const db = admin.firestore();

// Cache staleness threshold (15 minutes)
const CACHE_MAX_AGE_MS = 15 * 60 * 1000;

// Define secrets
const finnhubKey = defineSecret("FINNHUB_KEY");

// Allowed origins for CORS (update with your domain)
const allowedOrigins = [
  "https://tuplebox-hercules.web.app",
  "https://tuplebox-hercules.firebaseapp.com",
  "http://localhost:5000", // For local testing
];

// Helper: Verify Firebase ID token
async function verifyAuth(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }
  const idToken = authHeader.split("Bearer ")[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    return decodedToken;
  } catch (error) {
    logger.warn("Token verification failed:", error.message);
    return null;
  }
}

// Helper: Handle CORS with origin checking
function handleCors(req, res) {
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
  }
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Max-Age", "3600");

  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return true;
  }
  return false;
}

// Test endpoint - just confirms function is working
exports.hello = onRequest({region: "europe-west2", cors: true}, async (req, res) => {
  // Verify auth
  const user = await verifyAuth(req);

  res.json({
    message: "Firebase Functions working!",
    timestamp: new Date().toISOString(),
    authenticated: !!user,
    userId: user?.uid || null,
  });
});

// Helper: Check if symbol is non-US (has exchange suffix like .L, .PA, .DE)
function isInternationalSymbol(symbol) {
  return /\.[A-Z]{1,2}$/.test(symbol);
}

// Helper: Find stock by Yahoo symbol
async function findStockByYahooSymbol(yahooSymbol) {
  const snapshot = await db.collection("stocks")
      .where("identifiers.yahoo", "==", yahooSymbol)
      .limit(1)
      .get();
  if (snapshot.empty) return null;
  return {id: snapshot.docs[0].id, ...snapshot.docs[0].data()};
}

// Helper: Create new stock in registry
async function createStock(yahooData) {
  const stockId = uuidv4();
  const now = admin.firestore.FieldValue.serverTimestamp();

  const stockDoc = {
    name: yahooData.longName || yahooData.shortName || yahooData.symbol,
    primarySymbol: yahooData.symbol,
    currency: yahooData.currency || "USD",
    type: yahooData.quoteType || "EQUITY",
    exchange: yahooData.exchange || null,
    identifiers: {
      yahoo: yahooData.symbol,
      isin: null,
      sedol: null,
      bloomberg: null,
      figi: null,
    },
    corporateActions: [],
    adjustmentFactor: 1.0,
    metadata: {
      createdAt: now,
      updatedAt: now,
    },
  };

  await db.collection("stocks").doc(stockId).set(stockDoc);
  logger.info(`Created stock ${stockId} for ${yahooData.symbol}`);
  return {id: stockId, ...stockDoc};
}

// Helper: Check if cache is stale
function isCacheStale(cacheData) {
  if (!cacheData || !cacheData.updatedAt) return true;
  const updatedAt = cacheData.updatedAt.toDate ?
    cacheData.updatedAt.toDate() : new Date(cacheData.updatedAt);
  return (Date.now() - updatedAt.getTime()) > CACHE_MAX_AGE_MS;
}

// Helper: Update price cache for a stock
async function updatePriceCache(stockId, yahooSymbol) {
  try {
    const quote = await yahooFinance.quote(yahooSymbol);
    if (!quote || !quote.regularMarketPrice) return null;

    const cacheData = {
      current: quote.regularMarketPrice,
      high: quote.regularMarketDayHigh,
      low: quote.regularMarketDayLow,
      open: quote.regularMarketOpen,
      previousClose: quote.regularMarketPreviousClose,
      change: quote.regularMarketChange,
      changePercent: quote.regularMarketChangePercent,
      fiftyTwoWeekHigh: quote.fiftyTwoWeekHigh,
      fiftyTwoWeekLow: quote.fiftyTwoWeekLow,
      volume: quote.regularMarketVolume,
      marketCap: quote.marketCap,
      currency: quote.currency,
      source: "yahoo",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await db.collection("priceCache").doc(stockId).set(cacheData);
    logger.info(`Updated price cache for stock ${stockId}`);
    return cacheData;
  } catch (error) {
    logger.error(`Failed to update cache for ${stockId}:`, error.message);
    return null;
  }
}

// Helper: Get price with cache-first strategy
async function getPriceWithCache(stockId, yahooSymbol) {
  const cacheRef = db.collection("priceCache").doc(stockId);
  const cacheDoc = await cacheRef.get();

  if (cacheDoc.exists && !isCacheStale(cacheDoc.data())) {
    logger.info(`Cache hit for stock ${stockId}`);
    return {...cacheDoc.data(), fromCache: true};
  }

  logger.info(`Cache miss/stale for stock ${stockId}, fetching fresh data`);
  const freshData = await updatePriceCache(stockId, yahooSymbol);
  if (freshData) {
    return {...freshData, fromCache: false};
  }

  // Fall back to stale cache if fresh fetch failed
  if (cacheDoc.exists) {
    logger.warn(`Using stale cache for stock ${stockId}`);
    return {...cacheDoc.data(), fromCache: true, stale: true};
  }

  return null;
}

// Helper: Fetch quote from Yahoo Finance using yahoo-finance2 library
async function fetchYahooQuote(symbol) {
  try {
    const quote = await yahooFinance.quote(symbol);

    if (!quote || !quote.regularMarketPrice) {
      return null;
    }

    return {
      symbol: quote.symbol,
      name: quote.longName || quote.shortName,
      currency: quote.currency,
      current: quote.regularMarketPrice,
      high: quote.regularMarketDayHigh,
      low: quote.regularMarketDayLow,
      open: quote.regularMarketOpen,
      previousClose: quote.regularMarketPreviousClose,
      change: quote.regularMarketChange,
      changePercent: quote.regularMarketChangePercent,
      fiftyTwoWeekHigh: quote.fiftyTwoWeekHigh,
      fiftyTwoWeekLow: quote.fiftyTwoWeekLow,
      volume: quote.regularMarketVolume,
      marketCap: quote.marketCap,
      source: "yahoo",
    };
  } catch (error) {
    logger.error(`Yahoo Finance error for ${symbol}:`, error.message);
    return null;
  }
}

// Helper: Fetch quote from Finnhub (for US stocks)
async function fetchFinnhubQuote(symbol, apiKey) {
  const url = `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${apiKey}`;
  const response = await fetch(url);
  const data = await response.json();

  if (data.c && data.c !== 0) {
    return {
      symbol: symbol,
      current: data.c,
      high: data.h,
      low: data.l,
      open: data.o,
      previousClose: data.pc,
      change: data.d,
      changePercent: data.dp,
      source: "finnhub",
    };
  }
  return null;
}

// Get stock quote - uses Finnhub for US, Yahoo Finance for international
exports.getQuote = onRequest({region: "europe-west2", cors: true, secrets: [finnhubKey]}, async (req, res) => {
  // Require authentication
  const user = await verifyAuth(req);
  if (!user) {
    res.status(401).json({error: "Authentication required"});
    return;
  }

  const symbol = req.query.symbol || "AAPL";
  logger.info(`User ${user.uid} requesting quote for ${symbol}`);

  try {
    let quote = null;

    if (isInternationalSymbol(symbol)) {
      // International stock - use Yahoo Finance
      logger.info(`Fetching international quote for ${symbol} from Yahoo Finance`);
      quote = await fetchYahooQuote(symbol);
    } else {
      // US stock - use Finnhub
      const fhKey = finnhubKey.value();
      if (!fhKey) {
        res.status(500).json({error: "Finnhub API key not configured"});
        return;
      }
      logger.info(`Fetching US quote for ${symbol} from Finnhub`);
      quote = await fetchFinnhubQuote(symbol, fhKey);
    }

    if (!quote) {
      res.status(404).json({error: `No data found for symbol: ${symbol}`});
      return;
    }

    res.json({
      ...quote,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error("Quote API error:", error);
    res.status(500).json({error: "Failed to fetch quote"});
  }
});

// Search for stocks by symbol or name using Yahoo Finance
exports.searchSymbol = onRequest({region: "europe-west2", cors: true}, async (req, res) => {
  // Require authentication
  const user = await verifyAuth(req);
  if (!user) {
    res.status(401).json({error: "Authentication required"});
    return;
  }

  const query = req.query.q || "";
  logger.info(`User ${user.uid} searching for: ${query}`);

  if (!query) {
    res.status(400).json({error: "Missing search query parameter 'q'"});
    return;
  }

  try {
    const data = await yahooFinance.search(query);

    res.json({
      query: query,
      count: data.quotes?.length || 0,
      results: (data.quotes || []).map((item) => ({
        symbol: item.symbol,
        description: item.longname || item.shortname,
        type: item.quoteType,
        exchange: item.exchange,
      })),
    });
  } catch (error) {
    logger.error("Yahoo Finance search error:", error);
    res.status(500).json({error: "Failed to search symbols"});
  }
});

// Register a stock in the registry (called when user selects from search)
exports.registerStock = onRequest({region: "europe-west2", cors: true}, async (req, res) => {
  const user = await verifyAuth(req);
  if (!user) {
    res.status(401).json({error: "Authentication required"});
    return;
  }

  const yahooSymbol = req.query.symbol;
  if (!yahooSymbol) {
    res.status(400).json({error: "Missing symbol parameter"});
    return;
  }

  logger.info(`User ${user.uid} registering stock: ${yahooSymbol}`);

  try {
    // Check if stock already exists
    let stock = await findStockByYahooSymbol(yahooSymbol);

    if (stock) {
      logger.info(`Stock ${yahooSymbol} already registered as ${stock.id}`);
      // Get cached price
      const price = await getPriceWithCache(stock.id, yahooSymbol);
      res.json({
        stockId: stock.id,
        stock: stock,
        price: price,
        created: false,
      });
      return;
    }

    // Fetch stock info from Yahoo to populate registry
    const quote = await yahooFinance.quote(yahooSymbol);
    if (!quote) {
      res.status(404).json({error: `Symbol not found: ${yahooSymbol}`});
      return;
    }

    // Create new stock entry
    stock = await createStock(quote);

    // Populate initial price cache
    const price = await updatePriceCache(stock.id, yahooSymbol);

    res.json({
      stockId: stock.id,
      stock: stock,
      price: price,
      created: true,
    });
  } catch (error) {
    logger.error("Register stock error:", error);
    res.status(500).json({error: "Failed to register stock"});
  }
});

// Get stock by stockId with cached price
exports.getStockPrice = onRequest({region: "europe-west2", cors: true}, async (req, res) => {
  const user = await verifyAuth(req);
  if (!user) {
    res.status(401).json({error: "Authentication required"});
    return;
  }

  const stockId = req.query.stockId;
  if (!stockId) {
    res.status(400).json({error: "Missing stockId parameter"});
    return;
  }

  try {
    // Get stock from registry
    const stockDoc = await db.collection("stocks").doc(stockId).get();
    if (!stockDoc.exists) {
      res.status(404).json({error: `Stock not found: ${stockId}`});
      return;
    }

    const stock = stockDoc.data();
    const yahooSymbol = stock.identifiers?.yahoo;

    if (!yahooSymbol) {
      res.status(500).json({error: "Stock has no Yahoo symbol configured"});
      return;
    }

    // Get price with cache
    const price = await getPriceWithCache(stockId, yahooSymbol);

    if (!price) {
      res.status(500).json({error: "Failed to fetch price"});
      return;
    }

    res.json({
      stockId: stockId,
      name: stock.name,
      symbol: stock.primarySymbol,
      currency: stock.currency,
      adjustmentFactor: stock.adjustmentFactor,
      ...price,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error("Get stock price error:", error);
    res.status(500).json({error: "Failed to get stock price"});
  }
});

// Get stock details including corporate actions
exports.getStock = onRequest({region: "europe-west2", cors: true}, async (req, res) => {
  const user = await verifyAuth(req);
  if (!user) {
    res.status(401).json({error: "Authentication required"});
    return;
  }

  const stockId = req.query.stockId;
  if (!stockId) {
    res.status(400).json({error: "Missing stockId parameter"});
    return;
  }

  try {
    const stockDoc = await db.collection("stocks").doc(stockId).get();
    if (!stockDoc.exists) {
      res.status(404).json({error: `Stock not found: ${stockId}`});
      return;
    }

    res.json({
      stockId: stockId,
      ...stockDoc.data(),
    });
  } catch (error) {
    logger.error("Get stock error:", error);
    res.status(500).json({error: "Failed to get stock"});
  }
});

// Debug endpoint to test different Finnhub endpoints for a symbol
exports.debugQuote = onRequest({region: "europe-west2", cors: true, secrets: [finnhubKey]}, async (req, res) => {
  const symbol = req.query.symbol || "LLOY.L";
  const apiKey = finnhubKey.value();

  const results = {};

  // 1. Standard quote endpoint
  try {
    const quoteRes = await fetch(`https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${apiKey}`);
    results.quote = await quoteRes.json();
  } catch (e) {
    results.quote = {error: e.message};
  }

  // 2. Candle/OHLC data (last 7 days)
  try {
    const now = Math.floor(Date.now() / 1000);
    const weekAgo = now - (7 * 24 * 60 * 60);
    const candleRes = await fetch(`https://finnhub.io/api/v1/stock/candle?symbol=${symbol}&resolution=D&from=${weekAgo}&to=${now}&token=${apiKey}`);
    results.candle = await candleRes.json();
  } catch (e) {
    results.candle = {error: e.message};
  }

  // 3. Company profile
  try {
    const profileRes = await fetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${symbol}&token=${apiKey}`);
    results.profile = await profileRes.json();
  } catch (e) {
    results.profile = {error: e.message};
  }

  // 4. Basic financials
  try {
    const metricsRes = await fetch(`https://finnhub.io/api/v1/stock/metric?symbol=${symbol}&metric=all&token=${apiKey}`);
    results.metrics = await metricsRes.json();
  } catch (e) {
    results.metrics = {error: e.message};
  }

  res.json({symbol, results});
});
