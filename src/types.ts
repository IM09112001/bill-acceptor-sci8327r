export const ERROR_CODES = {
  INVALID_JSON: 'INVALID_JSON',
  WRONG_DEVICE: 'WRONG_DEVICE',
  MISSING_ID: 'MISSING_ID',
  UNKNOWN_METHOD: 'UNKNOWN_METHOD',
  INVALID_PARAMS: 'INVALID_PARAMS',
  PORT_NOT_FOUND: 'PORT_NOT_FOUND',
  DEVICE_NOT_RESPONDING: 'DEVICE_NOT_RESPONDING',
  DEVICE_DISCONNECTED: 'DEVICE_DISCONNECTED',
  NO_ESCROW: 'NO_ESCROW',
  BILL_JAMMED: 'BILL_JAMMED',
  CASSETTE_FULL: 'CASSETTE_FULL',
  CASSETTE_REMOVED: 'CASSETTE_REMOVED',
  DEVICE_ERROR: 'DEVICE_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR'
} as const;

export type ErrorCode = typeof ERROR_CODES[keyof typeof ERROR_CODES];

// Bill acceptor state machine modes
export type DeviceMode =
  | 'CLOSED'
  | 'OPENING'
  | 'OPEN'
  | 'CAPTURE'
  | 'ESCROW'
  | 'STACKING'
  | 'RETURNING'
  | 'DISABLED'
  | 'ERROR';

export type DeviceEventName =
  | 'CONNECTED'
  | 'DISCONNECTED'
  | 'ESCROW'
  | 'STACKING'
  | 'STACKED'
  | 'RETURNING'
  | 'RETURNED'
  | 'REJECTED'
  | 'ERROR';

export interface DeviceStatus {
  connected: boolean;
  mode: DeviceMode;
  enabled: boolean;
  autoStack: boolean;
  billInEscrow: boolean;
  serialPort: string;
  lastRawResponse: string | null; // last raw hex frame, handy in the logs
}

export interface DeviceEventPayload {
  status: DeviceEventName;
  docType?: number; // denomination, e.g. 5 for $5
  code?: ErrorCode;
  message?: string;
  statusDetails?: DeviceStatus;
}

// decoded status bytes straight off the wire
export interface DeviceStatusBits {
  idling: boolean;
  accepting: boolean;
  escrowed: boolean;
  stacking: boolean;
  stacked: boolean;
  returning: boolean;
  returned: boolean;
  rejected: boolean;
  jammed: boolean;
  cassetteFull: boolean;
  cassetteRemoved: boolean;
  msgType: number;
  docType: number;
  raw0: number;
  raw1: number;
}

export interface ParsedDeviceResponse {
  raw: string; // hex, e.g. "020B1001..."
  event: DeviceEventName | null;
  error: string | null;
  deviceStatus: DeviceStatusBits;
}

export type KnownMethod =
  | 'OPEN' | 'CLOSE' | 'STATUS' | 'CAPTURE'
  | 'ENABLE' | 'DISABLE' | 'STACK' | 'RETURN' | 'AUTOSTACK';

export interface AutoStackParams {
  enabled: boolean;
}

export interface WsRequest {
  device: 'BILL_ACCEPTOR';
  method: KnownMethod;
  id: string;
  params?: any;
}

export interface WsResponse {
  id: string | null;
  device: 'BILL_ACCEPTOR';
  method: KnownMethod | null;
  ts: string;
  ok: boolean;
  result?: any;
  error?: {
    code: ErrorCode;
    message: string;
    details?: any;
  };
}

// EVENT (device pushed something) and INFO (server greeting) share one shape
export interface WsDeviceEvent {
  type: 'EVENT' | 'INFO';
  device: 'BILL_ACCEPTOR';
  event?: DeviceEventName;
  message?: string;
  data?: any;
  status?: DeviceStatus;
  ts: string;
}
