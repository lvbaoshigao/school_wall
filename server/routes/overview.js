'use strict';

const express = require('express');
const { authRequired } = require('../middleware/auth');
const { getOverview, parseOverviewQuery, OverviewError } = require('../lib/overview');

// Mount at /api/admin/overview before the broader admin router. Dashboard
// cookies intentionally are NOT accepted here: the dashboard has its own
// same-origin authenticated adapter around the shared builder.
const router = express.Router();
router.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});
router.use(authRequired);
router.get('/', (req, res, next) => {
  try {
    const options = parseOverviewQuery(req.query, req.headers);
    res.json(getOverview(req.db, { userId: req.user.id, ...options }));
  } catch (error) {
    if (error instanceof OverviewError) return res.status(error.status).json({ error: error.message, code: error.code });
    // Let the common error handler report failures without substituting fake
    // zeros or exposing SQL, filesystem locations or permission internals.
    next(error);
  }
});
router.all('/', (req, res) => {
  res.setHeader('Allow', 'GET, HEAD');
  res.status(405).json({ error: '概览接口仅支持只读请求', code: 'OVERVIEW_METHOD_NOT_ALLOWED' });
});

module.exports = router;
