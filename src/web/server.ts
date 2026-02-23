import express from "express";
import path from "path";
import fs from "fs";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";

interface ClientSocket extends WebSocket {
  isAdmin?: boolean;
}

const clients = new Set<ClientSocket>();
type MessageHandler = (msg: { type: string; data: any }, ws: ClientSocket) => void;
let onClientMessage: MessageHandler | null = null;

export function onMessage(handler: MessageHandler) {
  onClientMessage = handler;
}

export function startServer(port: number): http.Server {
  const app = express();

  let pubDir = path.join(__dirname, "public");
  if (!fs.existsSync(pubDir)) {
    pubDir = path.join(process.cwd(), "src", "web", "public");
  }

  app.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    next();
  });

  app.use(express.static(pubDir));

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws: ClientSocket) => {
    ws.isAdmin = false;
    clients.add(ws);
    ws.on("message", (raw) => {
      try {
        const parsed = JSON.parse(raw.toString());
        if (onClientMessage) onClientMessage(parsed, ws);
      } catch {}
    });
    ws.on("close", () => clients.delete(ws));
  });

  server.listen(port, () => {
    console.log(`\n  YieldClaw running at http://localhost:${port}\n`);
  });

  return server;
}

// Broadcast to all clients
export function broadcast(type: string, data: unknown): void {
  const msg = JSON.stringify({ type, timestamp: Date.now(), data });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

// Broadcast only to admin clients
export function broadcastAdmin(type: string, data: unknown): void {
  const msg = JSON.stringify({ type, timestamp: Date.now(), data });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN && ws.isAdmin) ws.send(msg);
  }
}

// Send to a specific client
export function sendTo(ws: ClientSocket, type: string, data: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, timestamp: Date.now(), data }));
  }
}
