# SCI8327R Bill Acceptor — RS232 + WebSocket Server

Node.js service that bridges a **SCI8327R / SCL8327R** bill acceptor over RS232 to a JSON WebSocket API.  
Clients send commands as JSON, receive JSON responses, and get device events broadcast in real time.

## Requirements

- Node.js 18+
- SCI8327R or SCL8327R bill acceptor connected via RS232/USB-serial adapter

## Installation

```bash
cp .env.example .env   # copy config template, then edit SERIAL_PORT and WS_HOST
npm install
npm start
```

## Configuration

All settings live in `.env`. Safe defaults are in `.env.example`.

| Variable | Default | Description |
|---|---|---|
| `WS_HOST` | `localhost` | WebSocket bind address. Use `0.0.0.0` on Windows to accept connections from browsers and Postman. |
| `WS_PORT` | `8080` | WebSocket port |
| `SERIAL_PORT` | `COM3` | RS232 port. Windows: `COM1`, `COM2`… Linux: `/dev/ttyUSB0`, `/dev/ttyACM0` |
| `SERIAL_BAUD_RATE` | `9600` | Baud rate for SCI8327R/SCL8327R |
| `SERIAL_DATA_BITS` | `8` | Data bits |
| `SERIAL_STOP_BITS` | `1` | Stop bits |
| `SERIAL_PARITY` | `none` | Parity |
| `SERIAL_TIMEOUT_MS` | `1500` | Command response timeout in milliseconds |
| `POLL_INTERVAL_MS` | `300` | Status poll interval in milliseconds |

> **Windows note:** Node.js resolves `localhost` to `::1` (IPv6 only), causing `ECONNREFUSED` for IPv4 clients.  
> Set `WS_HOST=0.0.0.0` in `.env` when testing from a browser or Postman on Windows.

## Running

```bash
npm start              # start the WebSocket server
npm run test-client    # run sequential integration test (server must be running)
```

Server listens at `ws://localhost:8080` by default.

---

## WebSocket API

### Connection

On every new connection the server sends an unsolicited `INFO` message:

```json
{
  "type": "INFO",
  "device": "BILL_ACCEPTOR",
  "message": "Connected to bill acceptor server",
  "status": {
    "connected": false,
    "mode": "CLOSED",
    "enabled": false,
    "autoStack": false,
    "billInEscrow": false,
    "serialPort": "COM3",
    "lastRawResponse": null
  },
  "ts": "2026-05-14T09:37:00.924Z"
}
```

### Request format

```json
{"device": "BILL_ACCEPTOR", "method": "OPEN", "id": "req-1", "params": {}}
```

| Field | Required | Description |
|---|---|---|
| `device` | Yes | Must be `BILL_ACCEPTOR` |
| `method` | Yes | Command name (see table below) |
| `id` | Yes | Arbitrary request ID; echoed back in every response |
| `params` | No | Extra parameters (required by `AUTOSTACK`) |

Validation order: valid JSON → `device === "BILL_ACCEPTOR"` → `id` present → known `method` → method-specific params.  
**The `id` is returned in every error response** as long as the message was valid JSON, even when `device`, `method`, or `params` fail validation.

### Success response

```json
{
  "id": "req-1",
  "device": "BILL_ACCEPTOR",
  "method": "STATUS",
  "ok": true,
  "result": {
    "connected": false,
    "mode": "CLOSED",
    "enabled": false,
    "autoStack": false,
    "billInEscrow": false,
    "serialPort": "COM3",
    "lastRawResponse": null
  },
  "ts": "2026-05-14T09:37:01.143Z"
}
```

### Error response

```json
{
  "id": "req-1",
  "device": "BILL_ACCEPTOR",
  "method": "OPEN",
  "ok": false,
  "error": {
    "code": "PORT_NOT_FOUND",
    "message": "No such file or directory, cannot open COM3",
    "details": null
  },
  "ts": "2026-05-14T09:37:06.569Z"
}
```

---

## Commands

| Command | Description |
|---|---|
| `OPEN` | Open RS232 port and verify the device responds. Required before any other command. |
| `CLOSE` | Stop polling, close serial port, release COM port. |
| `STATUS` | Return in-memory device state. Never throws — works whether connected or not. |
| `CAPTURE` | Enable bill acceptance mode. Device waits for a bill to be inserted. |
| `STACK` | Accept bill in escrow into the cassette. Throws `NO_ESCROW` if no bill is waiting. |
| `RETURN` | Return bill in escrow to the user. Throws `NO_ESCROW` if no bill is waiting. |
| `AUTOSTACK` | Set auto-accept mode. `params.enabled` must be a boolean. When `true`, escrow bills are automatically stacked without requiring a `STACK` command. |
| `ENABLE` | Allow bill acceptance. |
| `DISABLE` | Deny bill acceptance. |

### AUTOSTACK example

```json
{"device": "BILL_ACCEPTOR", "method": "AUTOSTACK", "id": "as-1", "params": {"enabled": true}}
```

---

## Device Events

Events are **broadcast to all connected clients** when device state changes.  
They are never a direct response to a command — they come at any time.

```json
{"type": "EVENT", "device": "BILL_ACCEPTOR", "event": "ESCROW", "data": {}, "ts": "..."}
```

| Event | Trigger |
|---|---|
| `CONNECTED` | Device opened and responding |
| `DISCONNECTED` | Serial port closed or cable unplugged |
| `ESCROW` | Bill inserted and waiting for `STACK` or `RETURN` |
| `STACKING` | Bill is moving into the cassette |
| `STACKED` | Bill accepted into the cassette |
| `RETURNING` | Bill is moving back to the user |
| `RETURNED` | Bill returned to the user |
| `REJECTED` | Bill rejected by the device |
| `ERROR` | Device or serial error |

---

## Error Codes

| Code | Cause |
|---|---|
| `INVALID_JSON` | Message could not be parsed as JSON |
| `WRONG_DEVICE` | `device` field is not `BILL_ACCEPTOR` |
| `MISSING_ID` | `id` field not present |
| `UNKNOWN_METHOD` | `method` not in the allowed list |
| `INVALID_PARAMS` | Method-specific params invalid (e.g. `AUTOSTACK` without boolean `enabled`) |
| `PORT_NOT_FOUND` | Serial port path does not exist |
| `DEVICE_NOT_RESPONDING` | No response within `SERIAL_TIMEOUT_MS` |
| `DEVICE_DISCONNECTED` | Command sent while not connected |
| `NO_ESCROW` | `STACK` or `RETURN` sent with no bill in escrow |
| `BILL_JAMMED` | Bill jammed in the transport path |
| `CASSETTE_FULL` | Bill cassette is at capacity |
| `CASSETTE_REMOVED` | Cassette is missing |
| `DEVICE_ERROR` | Generic hardware or protocol error |
| `INTERNAL_ERROR` | Unexpected software error |

---

## State Machine

```
CLOSED ──(OPEN)──▶ OPENING ──▶ OPEN ──(CAPTURE)──▶ CAPTURE
                                                        │
                                          bill inserted │
                                                        ▼
                                                     ESCROW
                                                    /       \
                                             (STACK)         (RETURN)
                                                │                │
                                           STACKING          RETURNING
                                                │                │
                                           CAPTURE           CAPTURE
```

- `STACK` / `RETURN` require `billInEscrow === true`, otherwise throw `NO_ESCROW`
- `CAPTURE`, `ENABLE`, `DISABLE`, `STACK`, `RETURN` throw `DEVICE_DISCONNECTED` when not connected
- `STATUS` and `AUTOSTACK` work in any state
- Serial disconnect sets `mode = "CLOSED"`, emits `DISCONNECTED`, stops polling — server keeps running

---

## Test Client Output

`npm run test-client` connects to the running server and sends commands sequentially.  
Sample output with **no physical device connected** (COM3 absent):

```
Connected to ws://localhost:8080

<< recv: {"type":"INFO","device":"BILL_ACCEPTOR","message":"Connected to bill acceptor server",
  "status":{"connected":false,"mode":"CLOSED","enabled":false,"autoStack":false,
  "billInEscrow":false,"serialPort":"COM3","lastRawResponse":null},"ts":"..."}

>> sent: {"device":"BILL_ACCEPTOR","method":"STATUS","id":"test-1"}
<< recv: {"id":"test-1","device":"BILL_ACCEPTOR","method":"STATUS","ok":true,
  "result":{"connected":false,"mode":"CLOSED","enabled":false,"autoStack":false,
  "billInEscrow":false,"serialPort":"COM3","lastRawResponse":null},"ts":"..."}

>> sent: {"device":"BILL_ACCEPTOR","method":"OPEN","id":"test-2"}
<< recv: {"id":"test-2","device":"BILL_ACCEPTOR","method":"OPEN","ok":false,
  "error":{"code":"DEVICE_ERROR","message":"Opening COM3: Unknown error code 121","details":null},"ts":"..."}

>> sent: {"device":"BILL_ACCEPTOR","method":"STATUS","id":"test-3"}
<< recv: {"id":"test-3","device":"BILL_ACCEPTOR","method":"STATUS","ok":true,
  "result":{"connected":false,"mode":"CLOSED",...},"ts":"..."}

>> sent: {"device":"BILL_ACCEPTOR","method":"CAPTURE","id":"test-4"}
<< recv: {"id":"test-4","device":"BILL_ACCEPTOR","method":"CAPTURE","ok":false,
  "error":{"code":"DEVICE_DISCONNECTED","message":"Device is not connected","details":null},"ts":"..."}

>> sent: {"device":"BILL_ACCEPTOR","method":"STACK","id":"test-5"}
<< recv: {"id":"test-5","device":"BILL_ACCEPTOR","method":"STACK","ok":false,
  "error":{"code":"DEVICE_DISCONNECTED","message":"Device is not connected","details":null},"ts":"..."}

>> sent: {"device":"BILL_ACCEPTOR","method":"AUTOSTACK","id":"test-6","params":{"enabled":true}}
<< recv: {"id":"test-6","device":"BILL_ACCEPTOR","method":"AUTOSTACK","ok":true,
  "result":{"connected":false,"mode":"CLOSED","enabled":false,"autoStack":true,...},"ts":"..."}

>> sent: {"device":"BILL_ACCEPTOR","method":"STATUS","id":"test-7"}
<< recv: {"id":"test-7","device":"BILL_ACCEPTOR","method":"STATUS","ok":true,
  "result":{"connected":false,"mode":"CLOSED","enabled":false,"autoStack":true,...},"ts":"..."}

All tests complete. Closing connection.
Connection closed.
```

**Expected behavior without hardware:**
- `STATUS` always returns `ok: true` with current in-memory state
- `OPEN` fails with `DEVICE_ERROR` when COM port is absent or locked
- `CAPTURE` / `STACK` fail with `DEVICE_DISCONNECTED` (not connected)
- `AUTOSTACK` always succeeds — it sets an in-memory flag regardless of connection state
- Every response echoes the original `id` field

---

## RS232 Protocol Status

`src/protocol.js` contains **placeholder** `Buffer.from([])` for all SCI8327R/SCL8327R command bytes.  
`buildCommand()` throws `DEVICE_ERROR` for any command until real byte frames are filled in from the official manual.  
`parseDeviceResponse()` is a stub that returns `{ event: null, error: null, deviceStatus: {} }`.

**Do not guess byte frames.** Fill in real values only after the official SCI8327R/SCL8327R protocol manual is available.

Once the real protocol is implemented, hardware errors returned by `parseDeviceResponse()` will propagate as `ok: false` error responses to clients (the throw path in `sendDeviceCommand()` is already wired up).
