import config from './config';
import BillAcceptor from './device/BillAcceptor';
import { createWebSocketServer } from './server/WebSocketServer';

const device = new BillAcceptor();

device.on('device-event', (payload) => {
  console.log(`[DEVICE] ${payload.status}`, JSON.stringify(payload));
});

const wss = createWebSocketServer(device);

wss.on('listening', () => {
  console.log(`\nWebSocket server running at ws://${config.ws.host}:${config.ws.port}`);
  console.log(` Serial port: ${config.serial.path} @ ${config.serial.baudRate} baud, parity=${config.serial.parity}`);
  console.log('\nTo connect the bill acceptor, send this JSON command:');
  console.log('  {"device":"BILL_ACCEPTOR","method":"OPEN","id":"1"}');
});

// close the port and the server cleanly on Ctrl+C / kill
async function shutdown(signal: string): Promise<void> {
  console.log(`\n[SERVER] ${signal} received. Shutting down...`);
  try {
    await device.close();
  } catch {
    // nothing useful to do if close fails while we're exiting anyway
  }
  wss.close(() => {
    console.log('[SERVER] Bye!');
    process.exit(0);
  });
}

process.on('SIGINT',  () => { void shutdown('SIGINT');  });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });