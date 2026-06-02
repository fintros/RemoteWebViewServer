import http from 'http';
import { WebSocketServer } from "ws"
import env from "env-var";
import { makeConfigFromParams, setConfigFor, logDeviceConfig } from "./config.js";
import { broadcaster, ensureDeviceAsync, cleanupIdleAsync } from './deviceManager.js';
import { InputRouter } from "./inputRouter.js";
import { bootstrapAsync } from './browser.js';
import { MsgType } from './protocol.js';

const WS_PORT = env.get("WS_PORT").default("8081").asIntPositive();
const HEALTH_PORT = env.get("HEALTH_PORT").default("18080").asIntPositive();

const wss = new WebSocketServer({ port: WS_PORT, perMessageDeflate: false });
const inputRouter = new InputRouter();

await bootstrapAsync();

wss.on("connection", (ws, req) => { 
  const url = new URL(req.url || "", `ws://localhost:${WS_PORT}`);
  const id = url.searchParams.get("id") || "default";

  const cfg = makeConfigFromParams(url.searchParams);
  setConfigFor(id, cfg);
  logDeviceConfig(id, cfg);

  broadcaster.addClient(id, ws);

  const devPromise = ensureDeviceAsync(id, cfg);

  // СРАЗУ ЖЕ вешаем слушатель, чтобы не пропустить ни одного байта
  ws.on("message", async (msg, isBinary) => {
    if (!isBinary) return;

    const buf: Buffer = Buffer.isBuffer(msg) ? msg : Buffer.from(msg as ArrayBuffer);
    
    try {
      const dev = await devPromise;

      switch (buf.readUInt8(0)) {
        case MsgType.Touch:
          await inputRouter.handleTouchPacketAsync(dev, buf);
          break;
        case MsgType.Keepalive:
          dev.lastActive = Date.now();
          break;
        case MsgType.FrameStats:
          await inputRouter.handleFrameStatsPacketAsync(dev, buf);
          break;
        case MsgType.OpenURL:
          await inputRouter.handleOpenURLPacketAsync(dev, buf);
          break;
      }
    } catch (e) {
      console.warn(`[ws] Failed to handle packet: ${(e as Error).message}`);
    }
  });

  ws.on("close", async () => {
    broadcaster.removeClient(id, ws);
    try {
      const dev = await devPromise;
      dev.lastActive = Date.now();
    } catch (e) {
    }
  });

 devPromise.catch((e) => {
    console.error(`[device] Failed to ensure device ${id}:`, e);
    ws.close(); // Закрываем сокет, если Хромиум умер
  });
});

http.createServer(async (req, res) => {
  try {
    res.writeHead(200); res.end('ok');
  } catch (e) {
    res.writeHead(500); res.end('err');
  }
}).listen(HEALTH_PORT);

setInterval(() => cleanupIdleAsync(), 60_000);

console.log(`[server] WebSocket listening on :${WS_PORT}`);
