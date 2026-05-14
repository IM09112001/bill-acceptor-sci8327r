# SCI8327R Bill Acceptor — RS232 + WebSocket Server

Node.js service that connects to a SCI8327R/SCL8327R bill acceptor via RS232 and exposes a WebSocket JSON API.

## Requirements

- Node.js 18+
- SCI8327R or SCL8327R bill acceptor connected via RS232

## Installation

```bash
npm install
```

## Configuration

Copy `.env.example` to `.env` and edit:

```env
WS_HOST=localhost
WS_PORT=8080
SERIAL_PORT=COM3          # Windows: COM1, COM2 … / Linux: /dev/ttyUSB0, /dev/ttyACM0
SERIAL_BAUD_RATE=9600
SERIAL_TIMEOUT_MS=1500
POLL_INTERVAL_MS=300
```

## Running

```bash
npm start
```

Server starts at `ws://localhost:8080` (default).

## Testing

```bash
npm run test-client
```

Or connect any WebSocket client to `ws://localhost:8080`.

## WebSocket Request Format

```json
{"device":"BILL_ACCEPTOR","method":"OPEN","id":"req-1"}
```

- `device` — always `BILL_ACCEPTOR`
- `method` — command name
- `id` — returned in the response
- `params` — only for commands that need it (e.g. `AUTOSTACK`)

## Supported Commands

| Command | Description |
|---|---|
| `OPEN` | Open RS232 port and verify device responds |
| `CLOSE` | Close connection and release port |
| `STATUS` | Return current device state |
| `CAPTURE` | Enable bill acceptance mode |
| `STACK` | Accept bill into cassette (escrow only) |
| `RETURN` | Return bill to user (escrow only) |
| `AUTOSTACK` | `{"params":{"enabled":true}}` — auto-accept bills |
| `ENABLE` | Allow bill acceptance |
| `DISABLE` | Deny bill acceptance |

## Response Format

**Success:**
```json
{"id":"req-1","device":"BILL_ACCEPTOR","method":"OPEN","ok":true,"result":{},"ts":"..."}
```

**Error:**
```json
{"id":"req-1","device":"BILL_ACCEPTOR","method":"OPEN","ok":false,"error":{"code":"PORT_NOT_FOUND","message":"..."},"ts":"..."}
```

## Event Format

Events are broadcast to **all connected clients** when device state changes (not command responses):

```json
{"type":"EVENT","device":"BILL_ACCEPTOR","event":"ESCROW","data":{},"ts":"..."}
```

Events: `CONNECTED`, `DISCONNECTED`, `ESCROW`, `STACKING`, `STACKED`, `RETURNING`, `RETURNED`, `REJECTED`, `ERROR`

## Error Handling

The server handles these errors without crashing:
- Port/device not found
- Bill acceptor not responding
- Invalid JSON
- Wrong device name
- Unknown method
- STACK/RETURN without a bill in escrow
- Bill jammed
- Cassette full
- Cassette removed
- Device error response

## RS232 Protocol Note

`src/protocol.js` contains **placeholder** `Buffer.from([])` for all SCI8327R/SCL8327R command bytes.  
The real byte frames must come from the official SCI8327R/SCL8327R protocol manual.  
Until the manual is available, `OPEN` and any command that sends bytes to the device will return a `DEVICE_ERROR` indicating the command is not yet implemented.
