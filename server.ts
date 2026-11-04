import express from 'express';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import geminiSolveHandler from './api/gemini/solve.js';
import geminiStatusHandler from './api/gemini/status.js';
import webhookProxyHandler from './api/webhook/proxy.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const port = parseInt(process.env.PORT || '3000', 10);

  // Match Vercel 4mb body limit
  app.use(express.json({ limit: '4mb' }));

  // Delegate API routes to the single Vercel serverless handler implementations
  app.all('/api/gemini/solve', (req, res) => geminiSolveHandler(req, res));
  app.all('/api/gemini/status', (req, res) => geminiStatusHandler(req, res));
  app.all('/api/webhook/proxy', (req, res) => webhookProxyHandler(req, res));

  // Loader.io verification endpoint
  app.get('/loaderio-a4d07eb0b080983ea5999ef8b78d57fd*', (_req, res) => {
    res.type('text/plain').send('loaderio-a4d07eb0b080983ea5999ef8b78d57fd');
  });

  // Serve firebase-applet-config.json directly
  app.get('/firebase-applet-config.json', (_req, res) => {
    const configPath = path.resolve(__dirname, 'firebase-applet-config.json');
    if (fs.existsSync(configPath)) {
      res.sendFile(configPath);
    } else {
      res.status(404).json({ error: 'Config not found' });
    }
  });

  // Serve static files or Vite middlewares
  if (process.env.NODE_ENV === 'production') {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`Server listening on port ${port}`);
  });
}

startServer();
