import express from 'express';
import cors from 'cors';
import { trace } from './trace.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, name: 'stepwise-engine', languages: ['python', 'c', 'cpp', 'java'] });
});

app.post('/api/trace', async (req, res) => {
  const { language, code, stdin = '' } = req.body ?? {};
  if (typeof code !== 'string' || !code.trim()) {
    return res.status(400).json({ ok: false, error: { message: 'No code provided', kind: 'BadRequest' } });
  }
  if (!['python', 'c', 'cpp', 'java'].includes(language)) {
    return res.status(400).json({ ok: false, error: { message: `Unsupported language: ${language}`, kind: 'BadRequest' } });
  }
  try {
    const result = await trace(language, code, stdin);
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: { message: 'Internal engine error: ' + e.message, kind: 'EngineError' } });
  }
});

export default app;

// Local / traditional Node hosting — skip listen on Vercel serverless
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 4000;
  app.listen(PORT, () => {
    console.log(`StepWise engine listening on http://localhost:${PORT}`);
  });
}
