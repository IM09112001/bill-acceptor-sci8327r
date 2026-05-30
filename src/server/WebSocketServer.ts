import { WebSocketServer as WsServer, WebSocket } from 'ws';

import config from '../config';
import { AppError, normalizeError } from '../errors';
import {
  ERROR_CODES,
  type WsRequest,
  type WsResponse,
  type KnownMethod,
  type AutoStackParams,
} from '../types';
import BillAcceptor from '../device/BillAcceptor';

function sendJson(ws: WebSocket, data: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function buildSuccessResponse(req: WsRequest, result: unknown): WsResponse {
  return {
    id: req.id,
    device: 'BILL_ACCEPTOR',
    method: req.method,
    ok: true,
    result,
    ts: new Date().toISOString(),
  };
}

function buildErrorResponse(
  id: string | null,
  method: KnownMethod | null,
  err: unknown,
): WsResponse {
  const appErr = normalizeError(err);
  return {
    id,
    device: 'BILL_ACCEPTOR',
    method,
    ok: false,
    error: {
      code: appErr.code,
      message: appErr.message,
      details: appErr.details,
    },
    ts: new Date().toISOString(),
  };
}

const KNOWN_METHODS: KnownMethod[] = [
  'OPEN', 'CLOSE', 'STATUS', 'CAPTURE',
  'ENABLE', 'DISABLE', 'STACK', 'RETURN', 'AUTOSTACK',
];

function validateRequest(raw: Buffer): WsRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString());
  } catch {
    throw new AppError(ERROR_CODES.INVALID_JSON, 'Request is not valid JSON');
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new AppError(ERROR_CODES.INVALID_JSON, 'Request must be a JSON object');
  }

  const req = parsed as Record<string, unknown>;

  if (req['device'] !== 'BILL_ACCEPTOR') {
    throw new AppError(ERROR_CODES.WRONG_DEVICE, `Unknown device: ${String(req['device'])}`);
  }

  if (typeof req['id'] !== 'string' || !req['id']) {
    throw new AppError(ERROR_CODES.MISSING_ID, 'Missing or invalid id field');
  }

  if (!KNOWN_METHODS.includes(req['method'] as KnownMethod)) {
    throw new AppError(ERROR_CODES.UNKNOWN_METHOD, `Unknown method: ${String(req['method'])}`);
  }

  if (req['method'] === 'AUTOSTACK') {
    const params = req['params'] as Record<string, unknown> | undefined;
    if (!params || typeof params['enabled'] !== 'boolean') {
      throw new AppError(
        ERROR_CODES.INVALID_PARAMS,
        'AUTOSTACK requires params.enabled to be a boolean',
      );
    }
  }

  return parsed as WsRequest;
}

async function executeCommand(req: WsRequest, device: BillAcceptor): Promise<unknown> {
  switch (req.method) {
    case 'OPEN': return device.open();
    case 'CLOSE': return device.close();
    case 'STATUS': return device.status();
    case 'CAPTURE': return device.capture();
    case 'ENABLE': return device.enable();
    case 'DISABLE': return device.disable();
    case 'STACK': return device.stack();
    case 'RETURN': return device.returnBill();
    case 'AUTOSTACK': {
      const { enabled } = req.params as AutoStackParams;
      return device.setAutoStack(enabled);
    }
    default:
      throw new AppError(ERROR_CODES.UNKNOWN_METHOD, `Unhandled method: ${req.method}`);
  }
}

async function handleMessage(
  ws: WebSocket,
  raw: Buffer,
  device: BillAcceptor,
): Promise<void> {
  // pull id/method out first so even a rejected request gets echoed back with them
  let id: string | null = null;
  let method: KnownMethod | null = null;

  try {
    let preliminary: unknown;
    try { preliminary = JSON.parse(raw.toString()); } catch { /* validateRequest reports it */ }
    if (preliminary && typeof preliminary === 'object') {
      const p = preliminary as Record<string, unknown>;
      if (typeof p['id'] === 'string') id = p['id'];
      if (typeof p['method'] === 'string') method = p['method'] as KnownMethod;
    }

    const req = validateRequest(raw);
    const result = await executeCommand(req, device);
    sendJson(ws, buildSuccessResponse(req, result));
  } catch (err: unknown) {
    sendJson(ws, buildErrorResponse(id, method, err));
  }
}

export function createWebSocketServer(device: BillAcceptor): WsServer {
  const wss = new WsServer({ host: config.ws.host, port: config.ws.port });

  device.on('device-event', (payload) => {
    const message = JSON.stringify({
      type: 'EVENT',
      device: 'BILL_ACCEPTOR',
      event: payload.status,
      data: payload,
      ts: new Date().toISOString(),
    });

    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  });

  wss.on('connection', (ws) => {
    sendJson(ws, {
      type: 'INFO',
      device: 'BILL_ACCEPTOR',
      message: 'Connected to bill acceptor server',
      status: device.getStatus(),
      ts: new Date().toISOString(),
    });

    ws.on('message', (raw) => {
      void handleMessage(ws, raw as Buffer, device);
    });

    ws.on('error', () => {});
  });

  wss.on('error', (err) => {
    console.error('[WS] Server error:', err.message);
  });

  return wss;
}