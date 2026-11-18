import assert from "node:assert/strict";
import test from "node:test";
import {
  isMovementCommand,
  isRobotCommandable,
  parseControlCommand,
  parseControlCommandRequest,
  parseRobotId,
  parseTelemetry,
} from "./protocol.js";

const validTelemetry = {
  sensors: { right: 12, front: 900, left: 4095 },
  gps: { latitude: 37.7749, longitude: -122.4194 },
  pump: false,
  mode: "manual",
};

test("accepts valid telemetry and trims the mode", () => {
  assert.deepEqual(
    parseTelemetry({ ...validTelemetry, mode: " manual " }),
    { ...validTelemetry, mode: "manual" },
  );
});

test("accepts a missing GPS fix only when both coordinates are null", () => {
  assert.deepEqual(
    parseTelemetry({
      ...validTelemetry,
      gps: { latitude: null, longitude: null },
    })?.gps,
    { latitude: null, longitude: null },
  );
  assert.equal(
    parseTelemetry({
      ...validTelemetry,
      gps: { latitude: null, longitude: 2 },
    }),
    null,
  );
});

test("rejects out-of-range readings, coordinates, and malformed telemetry", () => {
  assert.equal(
    parseTelemetry({
      ...validTelemetry,
      sensors: { ...validTelemetry.sensors, front: 4096 },
    }),
    null,
  );
  assert.equal(
    parseTelemetry({
      ...validTelemetry,
      gps: { latitude: 91, longitude: 0 },
    }),
    null,
  );
  assert.equal(parseTelemetry(null), null);
});

test("allows only documented control commands", () => {
  assert.equal(parseControlCommand("PUMP_ON"), "PUMP_ON");
  assert.equal(parseControlCommand("AUTOPILOT_ON"), "AUTOPILOT_ON");
  assert.equal(parseControlCommand("PUMP-ON"), null);
  assert.equal(isMovementCommand("FORWARD"), true);
  assert.equal(isMovementCommand("STOP"), false);
});

test("keeps monitor-only and not-yet-reported robots non-commandable", () => {
  assert.equal(isRobotCommandable(undefined), false);
  assert.equal(isRobotCommandable({ mode: "MONITOR" }), false);
  assert.equal(isRobotCommandable({ mode: "manual" }), true);
});

test("validates robot IDs and robot-targeted control commands", () => {
  assert.equal(parseRobotId("unit-02"), "unit-02");
  assert.equal(parseRobotId("../unit"), null);
  assert.deepEqual(
    parseControlCommandRequest({ robotId: "unit-02", command: "AUTOPILOT_ON" }),
    { robotId: "unit-02", command: "AUTOPILOT_ON" },
  );
  assert.equal(
    parseControlCommandRequest({ robotId: "unit-02", command: "DELETE" }),
    null,
  );
});
