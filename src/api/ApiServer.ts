import http from 'node:http';
import type { SwarmNode } from '../node/SwarmNode.js';
import { createLogger } from '../utils/logger.js';

/**
 * ApiServer — minimal REST API for interacting with a SwarmNode.
 *
 * Endpoints:
 *   GET  /health          → { status: 'ok', peerId }
 *   GET  /balance         → { peerId, balance }
 *   GET  /models          → { models: [...] }
 *   POST /infer           → { taskId }
 *   GET  /result/:taskId  → { taskId, result }
 *   GET  /stats           → { peerId, models, balance, ... }
 */
export class ApiServer {
    private server: http.Server | null = null;
    private readonly logger = createLogger('info', 'api');

    constructor(private readonly node: SwarmNode) { }

    start(port: number = 3000): Promise<void> {
        return new Promise((resolve) => {
            this.server = http.createServer(async (req, res) => {
                try {
                    await this.handleRequest(req, res);
                } catch (err: any) {
                    this.sendJson(res, 500, { error: err.message });
                }
            });

            this.server.listen(port, () => {
                this.logger.info(`API server listening on :${port}`);
                resolve();
            });
        });
    }

    stop(): Promise<void> {
        return new Promise((resolve) => {
            if (this.server) {
                this.server.close(() => resolve());
            } else {
                resolve();
            }
        });
    }

    private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
        const url = new URL(req.url ?? '/', `http://localhost`);
        const path = url.pathname;
        const method = req.method ?? 'GET';

        // CORS
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        if (method === 'OPTIONS') { res.writeHead(204).end(); return; }

        // Routes
        if (method === 'GET' && path === '/health') {
            return this.sendJson(res, 200, {
                status: 'ok',
                peerId: this.node.getPeerId().slice(0, 16) + '...',
                uptime: process.uptime(),
            });
        }

        if (method === 'GET' && path === '/balance') {
            const balance = await this.node.getBalance();
            return this.sendJson(res, 200, {
                peerId: this.node.getPeerId(),
                balance,
            });
        }

        if (method === 'GET' && path === '/models') {
            const available = this.node.modelRouter.getAvailableModels();
            return this.sendJson(res, 200, { models: available });
        }

        if (method === 'POST' && path === '/infer') {
            const body = await this.readBody(req);
            const { prompt, model } = JSON.parse(body);
            if (!prompt) {
                return this.sendJson(res, 400, { error: 'prompt required' });
            }
            const taskId = await this.node.submitPrompt(prompt, model ? { model } : undefined);
            return this.sendJson(res, 201, { taskId });
        }

        if (method === 'GET' && path.startsWith('/result/')) {
            const taskId = path.slice('/result/'.length);
            const result = await this.node.getResult(taskId);
            return this.sendJson(res, 200, { taskId, result });
        }

        if (method === 'GET' && path === '/stats') {
            const balance = await this.node.getBalance();
            const models = this.node.modelRouter.getAvailableModels();
            return this.sendJson(res, 200, {
                peerId: this.node.getPeerId().slice(0, 16) + '...',
                balance,
                modelsAvailable: models.length,
                models,
                uptime: process.uptime(),
            });
        }

        this.sendJson(res, 404, { error: 'not found' });
    }

    private sendJson(res: http.ServerResponse, status: number, data: any) {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
    }

    private readBody(req: http.IncomingMessage): Promise<string> {
        return new Promise((resolve, reject) => {
            const chunks: Buffer[] = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => resolve(Buffer.concat(chunks).toString()));
            req.on('error', reject);
        });
    }
}
