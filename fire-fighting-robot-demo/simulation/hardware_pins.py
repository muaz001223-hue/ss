"""Arduino pin labels and simulated states; no physical I/O is performed."""

from dataclasses import dataclass

PIN_MAP = {
    "enA": "D10",
    "in1": "D9",
    "in2": "D8",
    "in3": "D7",
    "in4": "D6",
    "enB": "D5",
    "ir_R": "A0",
    "ir_F": "A1",
    "ir_L": "A2",
    "servo": "A4",
    "pump": "A5",
}

SERIAL_BAUD = 9600
DEFAULT_SPEED = 160
SENSOR_CLEAR_VALUE = 1023
SENSOR_MIN_VALUE = 100
SERVO_HOME = 90
SERVO_MIN = 40
SERVO_MAX = 140
SERVO_STEP = 3
SERVO_REFRESH_SECONDS = 0.05

# ADC thresholds from the project PDF Arduino sketch.
RIGHT_FIRE_THRESHOLD = 250
FRONT_FIRE_THRESHOLD = 350
LEFT_FIRE_THRESHOLD = 250
RIGHT_SEARCH_THRESHOLD = 700
FRONT_SEARCH_THRESHOLD = 800
LEFT_SEARCH_THRESHOLD = 700


@dataclass(frozen=True)
class SimulatedPins:
    enA: int
    in1: int
    in2: int
    in3: int
    in4: int
    enB: int
    ir_R: int
    ir_F: int
    ir_L: int
    servo: int
    pump: int

    def as_dict(self) -> dict[str, int]:
        return {
            "enA": self.enA,
            "in1": self.in1,
            "in2": self.in2,
            "in3": self.in3,
            "in4": self.in4,
            "enB": self.enB,
            "ir_R": self.ir_R,
            "ir_F": self.ir_F,
            "ir_L": self.ir_L,
            "servo": self.servo,
            "pump": self.pump,
        }
