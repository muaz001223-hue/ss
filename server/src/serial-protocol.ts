import type { RobotTelemetry } from "./protocol.js";

interface SensorReadings {
  right: number;
  front: number;
  left: number;
}

function parseAdcValue(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 1023
    ? parsed
    : null;
}

export function parseArduinoSensorLine(line: string): SensorReadings | null {
  const fields = line.trim().split(",");
  let readingFields: string[];

  if (fields[0] === "SENSORS" && fields.length === 6) {
    if (fields[4] !== "0" || fields[5] !== "MONITOR") return null;
    readingFields = fields.slice(1, 4);
  } else if (
    fields[0] === "SIM" &&
    fields[1] === "SENSORS" &&
    fields.length === 5
  ) {
    readingFields = fields.slice(2);
  } else {
    return null;
  }

  const [right, front, left] = readingFields.map(parseAdcValue);
  if (right === null || front === null || left === null) return null;
  return { right, front, left };
}

function scaleAdcValue(value: number): number {
  return Math.round((value * 4095) / 1023);
}

export function toMonitorTelemetry(
  readings: SensorReadings,
): RobotTelemetry {
  return {
    sensors: {
      right: scaleAdcValue(readings.right),
      front: scaleAdcValue(readings.front),
      left: scaleAdcValue(readings.left),
    },
    gps: { latitude: null, longitude: null },
    pump: false,
    mode: "monitor",
  };
}
