import assert from "node:assert/strict";
import test from "node:test";
import { parseArduinoSensorLine, toMonitorTelemetry } from "./serial-protocol.js";

test("parses current UNO telemetry and scales 10-bit ADC values", () => {
  const readings = parseArduinoSensorLine("SENSORS,0,512,1023,0,MONITOR");
  assert.deepEqual(readings, { right: 0, front: 512, left: 1023 });
  assert.deepEqual(readings && toMonitorTelemetry(readings), {
    sensors: { right: 0, front: 2050, left: 4095 },
    gps: { latitude: null, longitude: null },
    pump: false,
    mode: "monitor",
  });
});

test("accepts the previous sensor-only firmware line", () => {
  assert.deepEqual(
    parseArduinoSensorLine("SIM,SENSORS,1,2,3"),
    { right: 1, front: 2, left: 3 },
  );
});

test("rejects malformed, out-of-range, or actuator-enabled lines", () => {
  assert.equal(parseArduinoSensorLine("SENSORS,0,1024,10,0,MONITOR"), null);
  assert.equal(parseArduinoSensorLine("SENSORS,0,1.5,10,0,MONITOR"), null);
  assert.equal(parseArduinoSensorLine("SENSORS,0,1,10,1,MONITOR"), null);
  assert.equal(parseArduinoSensorLine("SENSORS,0,1,10,0,MANUAL"), null);
});
