import WebSocket from "ws";

const WS_URL = "ws://localhost:8080";
const ws = new WebSocket(WS_URL);

const commands = [
  { device: "BILL_ACCEPTOR", method: "STATUS",   id: "test-1" },
  { device: "BILL_ACCEPTOR", method: "OPEN",     id: "test-2" },
  { device: "BILL_ACCEPTOR", method: "STATUS",   id: "test-3" },
  { device: "BILL_ACCEPTOR", method: "CAPTURE",  id: "test-4" },
  { device: "BILL_ACCEPTOR", method: "STACK",    id: "test-5" },
  { device: "BILL_ACCEPTOR", method: "AUTOSTACK", id: "test-6", params: { enabled: true } },
  { device: "BILL_ACCEPTOR", method: "STATUS",   id: "test-7" },
];

let index = 0;

function sendNext() {
  if (index >= commands.length) {
    console.log("\nAll tests complete. Closing connection.");
    ws.close();
    return;
  }
  const cmd = commands[index++];
  console.log(">> sent:", JSON.stringify(cmd));
  ws.send(JSON.stringify(cmd));
}

ws.on("open", () => {
  console.log(`Connected to ${WS_URL}\n`);
  // Wait for the INFO message before starting; sendNext is called from onmessage.
});

ws.on("message", (raw) => {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
    console.log("<< recv:", JSON.stringify(msg, null, 2));
  } catch {
    console.log("<< recv (raw):", raw.toString());
    return;
  }

  // INFO and EVENT are unsolicited — don't advance the queue, but use INFO to kick off the first command.
  if (msg.type === "INFO") {
    setTimeout(sendNext, 200);
    return;
  }
  if (msg.type === "EVENT") {
    return;
  }

  // Response to a command — send the next one after a short gap.
  setTimeout(sendNext, 300);
});

ws.on("error", (err) => {
  console.error("WebSocket error:", err.message);
});

ws.on("close", () => {
  console.log("Connection closed.");
});
