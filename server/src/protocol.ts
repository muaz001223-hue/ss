export const CONTROL_COMMANDS = [
  "FORWARD",
  "BACKWARD",
  "LEFT",
  "RIGHT",
  "STOP",
  "PUMP_ON",
  "PUMP_OFF",
  "AUTOPILOT_ON",
  "MANUAL",
] as const;

export type ControlCommand = (typeof CONTROL_COMMANDS)[number];
export type MovementCommand = "FORWARD" | "BACKWARD" | "LEFT" | "RIGHT";

export interface RobotTelemetry {
  sensors: {
    right: number;
    front: number;
    left: number;
  };
  gps: {
    latitude: number | null;
    longitude: number | null;
  };
  pump: boolean;
  mode: string;
}

export interface TelemetryUpdate extends RobotTelemetry {
  robotId: string;
  receivedAt: number;
}

export interface RobotStatus {
  robotId: string;
  connected: boolean;
  lastTelemetryAt: number | null;
}

export interface ControlCommandRequest {
  robotId: string;
  command: ControlCommand;
}

export interface RobotCommand {
  command: ControlCommand;
  issuedAt: number;
  leaseMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSensorReading(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 4095
  );
}

function isCoordinate(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
  );
}

export function parseRobotId(value: unknown): string | null {
  return typeof value === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,31}$/.test(value)
    ? value
    : null;
}

export function parseTelemetry(value: unknown): RobotTelemetry | null {
  if (!isRecord(value) || !isRecord(value.sensors) || !isRecord(value.gps)) {
    return null;
  }

  const { right, front, left } = value.sensors;
  const { latitude, longitude } = value.gps;
  const noFix = latitude === null && longitude === null;
  const validFix =
    isCoordinate(latitude, -90, 90) && isCoordinate(longitude, -180, 180);

  if (
    !isSensorReading(right) ||
    !isSensorReading(front) ||
    !isSensorReading(left) ||
    (!noFix && !validFix) ||
    typeof value.pump !== "boolean" ||
    typeof value.mode !== "string" ||
    value.mode.trim().length === 0 ||
    value.mode.length > 32
  ) {
    return null;
  }

  return {
    sensors: { right, front, left },
    gps: { latitude, longitude },
    pump: value.pump,
    mode: value.mode.trim(),
  };
}

export function parseControlCommand(value: unknown): ControlCommand | null {
  return typeof value === "string" &&
    (CONTROL_COMMANDS as readonly string[]).includes(value)
    ? (value as ControlCommand)
    : null;
}

export function parseControlCommandRequest(value: unknown): ControlCommandRequest | null {
  if (!isRecord(value)) return null;
  const robotId = parseRobotId(value.robotId);
  const command = parseControlCommand(value.command);
  return robotId && command ? { robotId, command } : null;
}

export function isMovementCommand(
  command: ControlCommand,
): command is MovementCommand {
  return (
    command === "FORWARD" ||
    command === "BACKWARD" ||
    command === "LEFT" ||
    command === "RIGHT"
  );
}

export function isRobotCommandable(
  telemetry: Pick<RobotTelemetry, "mode"> | undefined,
): boolean {
  return Boolean(
    telemetry && telemetry.mode.trim().toLowerCase() !== "monitor",
  );
}
