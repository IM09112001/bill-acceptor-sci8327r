import { WebSocketServer } from "ws";
import { AppError, ERROR_CODES, normalizeError } from "./errors.js";

const ALLOWED_METHODS = new Set([
  "OPEN", "CLOSE", "STATUS", "CAPTURE",
  "STACK", "RETURN", "AUTOSTACK", "ENABLE", "DISABLE",
]);

function createWebSocketServer(config, billAcceptor) {
  const wss = new WebSocketServer({ host: config.ws.host, port: config.ws.port });
  wss.setMaxListeners(0);

  wss.on("connection", (ws) => {
    sendJson(ws, {
      type: "INFO",
      device: "BILL_ACCEPTOR",
      message: "Connected to bill acceptor server",
      status: billAcceptor.getStatus(),
      ts: new Date().toISOString(),
    });

    ws.on("message", (rawMessage) => {
      handleMessage(ws, rawMessage, billAcceptor, wss);
    });

    ws.on("error", () => {});
  });

  billAcceptor.on("device-event", ({ event, data }) => {
    broadcast(wss, {
      type: "EVENT",
      device: "BILL_ACCEPTOR",
      event,
      data,
      ts: new Date().toISOString(),
    });
  });

  return wss;
}

async function handleMessage(ws, rawMessage, billAcceptor, wss) {
  let request = null;
  let id = null;
  try {
    let raw;
    try { raw = JSON.parse(rawMessage.toString()); } catch {}
    if (raw && typeof raw === "object") id = raw.id ?? null;

    request = validateRequest(rawMessage);
    const result = await executeCommand(request, billAcceptor);
    sendJson(ws, buildSuccessResponse(request, result));
  } catch (err) {
    sendJson(ws, buildErrorResponse(request ?? { id }, err));
  }
}

function validateRequest(rawMessage) {
  let msg;
  try {
    msg = JSON.parse(rawMessage.toString());
  } catch {
    throw new AppError(ERROR_CODES.INVALID_JSON, "Invalid JSON");
  }

  if (!msg.device || msg.device !== "BILL_ACCEPTOR") {
    throw new AppError(ERROR_CODES.WRONG_DEVICE, `device must be BILL_ACCEPTOR, got: ${msg.device}`);
  }

  if (!msg.id) {
    throw new AppError(ERROR_CODES.MISSING_ID, "Request id is required");
  }

  const method = typeof msg.method === "string" ? msg.method.toUpperCase() : null;
  if (!method || !ALLOWED_METHODS.has(method)) {
    throw new AppError(ERROR_CODES.UNKNOWN_METHOD, `Unknown method: ${msg.method}`);
  }

  const params = msg.params && typeof msg.params === "object" ? msg.params : {};

  if (method === "AUTOSTACK") {
    if (typeof params.enabled !== "boolean") {
      throw new AppError(
        ERROR_CODES.INVALID_PARAMS,
        "AUTOSTACK requires params.enabled to be a boolean"
      );
    }
  }

  return { id: msg.id, device: "BILL_ACCEPTOR", method, params };
}

async function executeCommand(request, billAcceptor) {
  switch (request.method) {
    case "OPEN":      return billAcceptor.open();
    case "CLOSE":     return billAcceptor.close();
    case "STATUS":    return billAcceptor.status();
    case "CAPTURE":   return billAcceptor.capture();
    case "STACK":     return billAcceptor.stack();
    case "RETURN":    return billAcceptor.returnBill();
    case "AUTOSTACK": return billAcceptor.setAutoStack(request.params.enabled);
    case "ENABLE":    return billAcceptor.enable();
    case "DISABLE":   return billAcceptor.disable();
  }
}

function buildSuccessResponse(request, result) {
  return {
    id: request.id,
    device: "BILL_ACCEPTOR",
    method: request.method,
    ok: true,
    result: result ?? {},
    ts: new Date().toISOString(),
  };
}

function buildErrorResponse(request, error) {
  const err = normalizeError(error);
  return {
    id: request?.id ?? null,
    device: "BILL_ACCEPTOR",
    method: request?.method ?? null,
    ok: false,
    error: {
      code: err.code,
      message: err.message,
      details: err.details ?? null,
    },
    ts: new Date().toISOString(),
  };
}

function sendJson(ws, payload) {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch {}
}

function broadcast(wss, payload) {
  const msg = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) {
      try { client.send(msg); } catch {}
    }
  }
}

export { createWebSocketServer };
