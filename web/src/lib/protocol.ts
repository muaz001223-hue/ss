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

export interface TelemetryUpdate {
  robotId: string;
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
  receivedAt: number;
}

export interface RobotStatus {
  robotId: string;
  connected: boolean;
  lastTelemetryAt: number | null;
}
