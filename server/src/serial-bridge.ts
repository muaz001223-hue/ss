import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import dotenv from "dotenv";
import { ReadlineParser } from "@serialport/parser-readline";
import { SerialPort } from "serialport";
import { io } from "socket.io-client";
import { parseRobotId } from "./protocol.js";
import { parseArduinoSensorLine, toMonitorTelemetry } from "./serial-protocol.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../");
dotenv.config({ path: resolve(projectRoot, ".env") });

interface BridgeConfig {
  portPath: string;
  robotId: string;
  token: string;
  serverUrl: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deviceTokenFor(robotId: string): string {
  const explicitToken = process.env.SERIAL_DEVICE_TOKEN?.trim();
  if (explicitToken) return explicitToken;

  const tokenMap = process.env.DEVICE_TOKENS_JSON;
  if (tokenMap) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(tokenMap);
    } catch (error: unknown) {
      throw new Error("DEVICE_TOKENS_JSON must contain valid JSON.", { cause: error });
    }
    if (isRecord(parsed)) {
      const token = parsed[robotId];
      if (typeof token === "string" && token.trim()) return token.trim();
    }
  }

  if (robotId === "robot-1" && process.env.DEVICE_TOKEN?.trim()) {
    return process.env.DEVICE_TOKEN.trim();
  }
  throw new Error(
    `No device token configured for ${robotId}; set SERIAL_DEVICE_TOKEN or configure the root .env.`,
  );
}

function loadConfig(): BridgeConfig {
  const portPath = process.env.SERIAL_PORT?.trim();
  if (!portPath) {
    throw new Error("Set SERIAL_PORT to the Arduino USB serial device path.");
  }

  const requestedRobotId = process.env.SERIAL_ROBOT_ID?.trim() || "robot-1";
  const robotId = parseRobotId(requestedRobotId);
  if (!robotId) {
    throw new Error("SERIAL_ROBOT_ID is not a valid Robot ID.");
  }

  const token = deviceTokenFor(robotId);
  if (token.length < 32) {
    throw new Error("The configured device token must contain at least 32 characters.");
  }

  const serverUrl =
    process.env.SERIAL_SERVER_URL?.trim() || "http://127.0.0.1:4100";
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(serverUrl);
  } catch (error: unknown) {
    throw new Error("SERIAL_SERVER_URL must be a valid HTTP(S) URL.", { cause: error });
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error("SERIAL_SERVER_URL must use HTTP or HTTPS.");
  }

  return { portPath, robotId, token, serverUrl };
}

function startBridge(config: BridgeConfig): void {
  const serial = new SerialPort({
    path: config.portPath,
    baudRate: 9600,
    autoOpen: false,
  });
  const lines = serial.pipe(new ReadlineParser({ delimiter: "\n" }));
  const socket = io(config.serverUrl, {
    autoConnect: false,
    auth: { robotId: config.robotId, token: config.token },
  });

  let latestTelemetry: ReturnType<typeof toMonitorTelemetry> | null = null;
  let invalidLineCount = 0;
  let isStopping = false;

  lines.on("data", (line: string) => {
    const readings = parseArduinoSensorLine(line);
    if (!readings) {
      invalidLineCount += 1;
      if (invalidLineCount === 1) {
        console.warn("Ignoring unrecognized serial line; expected UNO SENSORS telemetry.");
      }
      return;
    }

    latestTelemetry = toMonitorTelemetry(readings);
    if (socket.connected) socket.emit("telemetry:report", latestTelemetry);
  });

  serial.on("error", (error) => {
    console.error("USB serial error:", error.message);
  });
  serial.on("close", () => {
    if (!isStopping) console.error("USB serial connection closed.");
  });

  socket.on("connect", () => {
    console.log("Read-only serial bridge connected to the control server.");
    if (latestTelemetry) socket.emit("telemetry:report", latestTelemetry);
  });
  socket.on("connect_error", (error) => {
    console.error("Socket.IO connection failed:", error.message);
  });
  socket.on("disconnect", (reason) => {
    console.warn(`Socket.IO disconnected: ${reason}`);
  });
  socket.on("robot:ready", () => {
    console.log("Device authenticated; serial commands remain disabled.");
  });
  socket.on("robot:command", ({ command }) => {
    console.warn(`Ignoring ${command} command: this serial bridge is read-only.`);
  });
  socket.on("telemetry:error", ({ message }) => {
    console.error("Telemetry rejected by server:", message);
  });

  serial.open((error) => {
    if (error) {
      console.error(`Unable to open serial port ${config.portPath}:`, error.message);
      process.exitCode = 1;
      return;
    }
    console.log(`Opened Arduino serial port at 9600 baud for ${config.robotId}.`);
    socket.connect();
  });

  const shutdown = () => {
    if (isStopping) return;
    isStopping = true;
    socket.disconnect();
    if (serial.isOpen) {
      serial.close((error) => {
        if (error) console.error("Error closing USB serial port:", error.message);
      });
    }
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    startBridge(loadConfig());
  } catch (error: unknown) {
    console.error(
      error instanceof Error ? error.message : "Unable to start serial bridge.",
    );
    process.exitCode = 1;
  }
}
