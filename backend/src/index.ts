import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { metricsManager } from './metrics';
import { webhookRouter } from './webhooks';
import { analyticsRouter } from './analytics';
import { startStellarListener } from './stellarListener';
import { initDb } from './db/pool';
import { startSyncer } from './syncer';

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.use('/webhooks', webhookRouter);
app.use('/analytics', analyticsRouter);

// Start time for uptime calculation
const startTime = Date.now();

/**
 * @api {get} /health Health check endpoint
 * @apiDescription Returns the status and heartbeat of the automation engine.
 */
app.get('/health', (req: Request, res: Response) => {
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    res.json({
        status: 'ok',
        uptime: `${uptime}s`,
        timestamp: new Date().toISOString(),
        version: process.env.npm_package_version || '0.0.1',
        service: 'quipay-automation-engine',
        analytics: !!process.env.DATABASE_URL,
    });
});

/**
 * @api {get} /metrics Metrics endpoint
 * @apiDescription Exports data on processed transactions, success rates, and latency in Prometheus format.
 */
app.get('/metrics', async (req: Request, res: Response) => {
    try {
        res.set('Content-Type', metricsManager.register.contentType);
        res.end(await metricsManager.register.metrics());
    } catch (ex) {
        res.status(500).end(ex);
    }
});

// Mock endpoint to simulate transaction processing for testing metrics
app.post('/test/simulate-tx', (req: Request, res: Response) => {
    const { status, latency } = req.body;
    metricsManager.trackTransaction(status || 'success', latency || Math.random() * 2);
    res.json({ message: 'Transaction tracked' });
});

// ── Boot sequence ──────────────────────────────────────────────────────────────
app.listen(port, async () => {
    console.log(`🚀 Quipay Automation Engine listening at http://localhost:${port}`);

    // 1. Init DB (no-op when DATABASE_URL is absent)
    await initDb();

    // 2. Start the historical sync worker
    await startSyncer();

    // 3. Start the live event listener
    startStellarListener();
});
