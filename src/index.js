import config from "./config.js";
import BillAcceptor from "./billAcceptor.js";
import { createWebSocketServer } from "./websocket.js";

const billAcceptor = new BillAcceptor();
const wss = createWebSocketServer(config, billAcceptor);

console.log(`WebSocket server started at ws://${config.ws.host}:${config.ws.port}`);
console.log(`Serial port configured as ${config.serial.path}`);

async function shutdown() {
  try { await billAcceptor.close(); } catch {}
  wss.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err.message);
});

process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});
