import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { Server, type Socket } from "socket.io";
import {
  isMovementCommand,
  isRobotCommandable,
  parseControlCommandRequest,
  parseRobotId,
  parseTelemetry,
  type ControlCommand,
  type MovementCommand,
  type RobotCommand,
  type RobotStatus,
  type TelemetryUpdate,
} from "./protocol.js";

interface ClientToServerEvents {
  "telemetry:report": (payload: unknown) => void;
  "control:claim": () => void;
  "control:command": (command: unknown) => void;
  "control:heartbeat": (robotId: unknown) => void;
  "control:release": () => void;
}

interface ServerToClientEvents {
  "robot:ready": (data: { movementLeaseMs: number }) => void;
  "robot:command": (command: RobotCommand) => void;
  "robots:status": (statuses: RobotStatus[]) => void;
  "control:state": (state: { occupied: boolean }) => void;
  "control:granted": () => void;
  "control:revoked": () => void;
  "control:error": (error: { message: string }) => void;
  "control:notice": (notice: { message: string }) => void;
  "control:ack": (ack: { robotId: string; command: ControlCommand; accepted: boolean }) => void;
  "telemetry:update": (telemetry: TelemetryUpdate) => void;
  "telemetry:error": (error: { message: string }) => void;
}

interface ClientData {
  role: "dashboard" | "device";
  robotId?: string;
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../");
dotenv.config({ path: resolve(projectRoot, ".env") });

const port = Number(process.env.PORT ?? 4100);
const host = process.env.HOST ?? "127.0.0.1";
const origins = (process.env.CORS_ORIGIN ?? "http://localhost:3000")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const MOVEMENT_LEASE_MS = 750;
const MOVEMENT_TIMEOUT_MS = 900;
const DASHBOARD_ROOM = "dashboards";

function validateToken(name: string, value: string | undefined): string {
  if (!value || value.length < 32) {
    throw new Error(`${name} must be configured with at least 32 characters.`);
  }
  return value;
}

const dashboardToken = validateToken("DASHBOARD_TOKEN", process.env.DASHBOARD_TOKEN);
function loadDeviceTokens(): Map<string, string> {
  const tokens = new Map<string, string>();
  const configuredTokens = process.env.DEVICE_TOKENS_JSON;
  if (configuredTokens) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(configuredTokens);
    } catch (error: unknown) {
      throw new Error("DEVICE_TOKENS_JSON must contain a valid JSON object.", { cause: error });
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("DEVICE_TOKENS_JSON must map Robot IDs to device tokens.");
    }
    for (const [robotId, token] of Object.entries(parsed)) {
      if (!parseRobotId(robotId) || typeof token !== "string") {
        throw new Error("DEVICE_TOKENS_JSON contains an invalid Robot ID or token.");
      }
      tokens.set(robotId, validateToken(`Device token for ${robotId}`, token));
    }
  } else if (process.env.DEVICE_TOKEN) {
    tokens.set("robot-1", validateToken("DEVICE_TOKEN", process.env.DEVICE_TOKEN));
  } else {
    throw new Error("Configure DEVICE_TOKEN or DEVICE_TOKENS_JSON.");
  }
  return tokens;
}

const deviceTokens = loadDeviceTokens();

function tokenMatches(candidate: unknown, expected: string): boolean {
  if (typeof candidate !== "string") return false;
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  return (
    candidateBuffer.length === expectedBuffer.length &&
    timingSafeEqual(candidateBuffer, expectedBuffer)
  );
}

const httpServer = createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }

  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "Not found" }));
});

const io = new Server<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  ClientData
>(httpServer, {
  cors: {
    origin: origins,
    methods: ["GET", "POST"],
    credentials: false,
  },
  maxHttpBufferSize: 16_384,
});

type AppSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  ClientData
>;
const robotSockets = new Map<string, AppSocket>();
let controllerSocketId: string | null = null;
const activeMovements = new Map<string, MovementCommand>();
const movementTimers = new Map<string, NodeJS.Timeout>();
const latestTelemetry = new Map<string, TelemetryUpdate>();

function controlState() {
  io.emit("control:state", { occupied: controllerSocketId !== null });
}

function emitRobotCommand(
  robotId: string,
  command: ControlCommand,
  leaseMs?: number,
): boolean {
  const robotSocket = robotSockets.get(robotId);
  if (!robotSocket?.connected) return false;

  const payload: RobotCommand = {
    command,
    issuedAt: Date.now(),
    ...(leaseMs === undefined ? {} : { leaseMs }),
  };
  robotSocket.emit("robot:command", payload);
  return true;
}

function stopMovement(robotId: string) {
  const movementTimer = movementTimers.get(robotId);
  if (movementTimer) clearTimeout(movementTimer);
  movementTimers.delete(robotId);
  activeMovements.delete(robotId);
  emitRobotCommand(robotId, "STOP");
}

function stopAllActuators(robotId?: string) {
  const robotIds = robotId ? [robotId] : [...robotSockets.keys()];
  for (const id of robotIds) {
    stopMovement(id);
    emitRobotCommand(id, "PUMP_OFF");
    emitRobotCommand(id, "MANUAL");
  }
}

function armMovementTimeout(robotId: string) {
  const movementTimer = movementTimers.get(robotId);
  if (movementTimer) clearTimeout(movementTimer);
  movementTimers.set(robotId, setTimeout(() => {
    movementTimers.delete(robotId);
    activeMovements.delete(robotId);
    emitRobotCommand(robotId, "STOP");
    io.emit("control:notice", {
      message: `Movement stopped because ${robotId}'s control heartbeat expired.`,
    });
  }, MOVEMENT_TIMEOUT_MS));
}

function emitRobotStatuses(socket?: AppSocket) {
  const statuses = [...robotSockets.entries()].map(([robotId, robotSocket]) => ({
    robotId,
    connected: robotSocket.connected,
    lastTelemetryAt: latestTelemetry.get(robotId)?.receivedAt ?? null,
  }));
  if (socket) {
    socket.emit("robots:status", statuses);
  } else {
    io.to(DASHBOARD_ROOM).emit("robots:status", statuses);
  }
}

io.use((socket, next) => {
  const token: unknown = socket.handshake.auth?.token;
  if (tokenMatches(token, dashboardToken)) {
    socket.data.role = "dashboard";
    next();
  } else {
    const suppliedRobotId: unknown = socket.handshake.auth?.robotId;
    const robotId = suppliedRobotId === undefined ? "robot-1" : parseRobotId(suppliedRobotId);
    const expectedToken = robotId ? deviceTokens.get(robotId) : undefined;
    if (!robotId || !expectedToken || !tokenMatches(token, expectedToken)) {
      next(new Error("Authentication failed. Check the Robot ID and device token."));
      return;
    }
    socket.data.role = "device";
    socket.data.robotId = robotId;
    next();
  }
});

io.on("connection", (socket) => {
  if (socket.data.role === "device") {
    const robotId = socket.data.robotId;
    if (!robotId || robotSockets.get(robotId)?.connected) {
      socket.disconnect(true);
      return;
    }

    robotSockets.set(robotId, socket);
    socket.emit("robot:ready", { movementLeaseMs: MOVEMENT_LEASE_MS });
    emitRobotStatuses();

    socket.on("telemetry:report", (payload) => {
      const telemetry = parseTelemetry(payload);
      if (!telemetry) {
        socket.emit("telemetry:error", {
          message: "Telemetry rejected: check sensor, GPS, pump, and mode values.",
        });
        return;
      }

      const update: TelemetryUpdate = {
        ...telemetry,
        robotId,
        receivedAt: Date.now(),
      };
      latestTelemetry.set(robotId, update);
      io.to(DASHBOARD_ROOM).emit("telemetry:update", update);
      emitRobotStatuses();
    });

    socket.on("disconnect", () => {
      if (robotSockets.get(robotId)?.id !== socket.id) return;
      robotSockets.delete(robotId);
      latestTelemetry.delete(robotId);
      stopAllActuators(robotId);
      emitRobotStatuses();
    });

    return;
  }

  socket.join(DASHBOARD_ROOM);
  emitRobotStatuses(socket);
  for (const telemetry of latestTelemetry.values()) {
    socket.emit("telemetry:update", telemetry);
  }
  socket.emit("control:state", { occupied: controllerSocketId !== null });

  socket.on("control:claim", () => {
    if (controllerSocketId && controllerSocketId !== socket.id) {
      socket.emit("control:error", {
        message: "Another dashboard currently holds control.",
      });
      return;
    }

    controllerSocketId = socket.id;
    socket.emit("control:granted");
    controlState();
  });

  socket.on("control:command", (value) => {
    const request = parseControlCommandRequest(value);
    if (!request) {
      socket.emit("control:error", { message: "Unsupported robot command or Robot ID." });
      return;
    }
    const { robotId, command } = request;
    const robotSocket = robotSockets.get(robotId);

    if (!robotSocket?.connected) {
      if (command === "STOP") {
        stopMovement(robotId);
        socket.emit("control:ack", { robotId, command, accepted: false });
      } else {
        socket.emit("control:error", { message: `Robot ${robotId} is not connected.` });
      }
      return;
    }

    const telemetry = latestTelemetry.get(robotId);
    if (!isRobotCommandable(telemetry)) {
      const message = telemetry
        ? `Robot ${robotId} is connected in read-only telemetry mode.`
        : `Robot ${robotId} has not reported telemetry yet.`;
      socket.emit("control:error", { message });
      socket.emit("control:ack", { robotId, command, accepted: false });
      return;
    }

    if (command === "STOP") {
      stopMovement(robotId);
      socket.emit("control:ack", {
        robotId,
        command,
        accepted: true,
      });
      return;
    }

    if (command === "PUMP_OFF") {
      emitRobotCommand(robotId, command);
      socket.emit("control:ack", { robotId, command, accepted: true });
      return;
    }

    if (command === "MANUAL") {
      stopMovement(robotId);
      emitRobotCommand(robotId, command);
      socket.emit("control:ack", { robotId, command, accepted: true });
      return;
    }

    if (controllerSocketId !== socket.id) {
      socket.emit("control:error", {
        message: "Claim control before sending robot commands.",
      });
      return;
    }

    if (command === "AUTOPILOT_ON") stopMovement(robotId);

    const leaseMs = isMovementCommand(command) ? MOVEMENT_LEASE_MS : undefined;
    emitRobotCommand(robotId, command, leaseMs);
    if (isMovementCommand(command)) {
      activeMovements.set(robotId, command);
      armMovementTimeout(robotId);
    }
    socket.emit("control:ack", { robotId, command, accepted: true });
  });

  socket.on("control:heartbeat", (value) => {
    const robotId = parseRobotId(value);
    const robotSocket = robotId ? robotSockets.get(robotId) : undefined;
    const activeMovement = robotId ? activeMovements.get(robotId) : undefined;
    if (
      controllerSocketId === socket.id &&
      robotId &&
      robotSocket?.connected &&
      activeMovement
    ) {
      emitRobotCommand(robotId, activeMovement, MOVEMENT_LEASE_MS);
      armMovementTimeout(robotId);
    }
  });

  socket.on("control:release", () => {
    if (controllerSocketId !== socket.id) return;
    stopAllActuators();
    controllerSocketId = null;
    socket.emit("control:revoked");
    controlState();
  });

  socket.on("disconnect", () => {
    if (controllerSocketId !== socket.id) return;
    stopAllActuators();
    controllerSocketId = null;
    controlState();
  });
});

httpServer.listen(port, host, () => {
  console.log(`Control server listening on http://${host}:${port}`);
  console.log(`Allowed dashboard origins: ${origins.join(", ")}`);
});

function shutdown() {
  stopAllActuators();
  io.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
