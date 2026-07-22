/**
 * Vercel serverless entry — re-exports the Express app.
 * Routes under /api/* are rewritten here (see vercel.json).
 */
import app from '../backend/src/server.js';

export default app;
