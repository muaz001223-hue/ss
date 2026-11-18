"""Small deterministic 2D room used only by the browser demo."""

from dataclasses import dataclass
import math

from .hardware_pins import (
    SENSOR_CLEAR_VALUE,
    SENSOR_MIN_VALUE,
    SERVO_HOME,
)

ROOM_WIDTH = 1200
ROOM_HEIGHT = 760
SENSOR_RANGE = 360.0
SENSOR_HALF_ANGLE = math.radians(30)
ROBOT_RADIUS = 24.0


@dataclass
class Fire:
    id: int
    x: float
    y: float
    active: bool = True
    extinguish_progress: float = 0.0


@dataclass
class Robot:
    x: float = ROOM_WIDTH / 2
    y: float = ROOM_HEIGHT / 2
    heading: float = 0.0
    mode: str = "AUTOPILOT"
    drive: str = "STOP"
    motor_speed: int = 0
    pump: bool = False
    servo: int = SERVO_HOME


class PhysicsEnvironment:
    def __init__(self) -> None:
        self.robot = Robot()
        self.fires: list[Fire] = []
        self._next_fire_id = 1

    def add_fire(self, x: float, y: float) -> Fire:
        fire = Fire(
            id=self._next_fire_id,
            x=min(max(float(x), 28.0), ROOM_WIDTH - 28.0),
            y=min(max(float(y), 28.0), ROOM_HEIGHT - 28.0),
        )
        self._next_fire_id += 1
        self.fires.append(fire)
        return fire

    def clear(self) -> None:
        self.fires.clear()
        self.robot = Robot()

    def active_fires(self) -> list[Fire]:
        return [fire for fire in self.fires if fire.active]

    def nearest_fire(self) -> tuple[Fire | None, float, float]:
        candidates = self.active_fires()
        if not candidates:
            return None, 0.0, math.inf

        fire = min(
            candidates,
            key=lambda item: math.hypot(item.x - self.robot.x, item.y - self.robot.y),
        )
        dx = fire.x - self.robot.x
        dy = fire.y - self.robot.y
        return fire, math.atan2(dx, -dy), math.hypot(dx, dy)

    def sensor_readings(self) -> dict[str, int]:
        readings: dict[str, int] = {}
        for name, offset in (("right", math.pi / 2), ("front", 0), ("left", -math.pi / 2)):
            best_intensity = 0.0
            sensor_heading = self.robot.heading + offset
            for fire in self.active_fires():
                dx = fire.x - self.robot.x
                dy = fire.y - self.robot.y
                distance = math.hypot(dx, dy)
                if distance > SENSOR_RANGE:
                    continue
                bearing = math.atan2(dx, -dy)
                difference = (bearing - sensor_heading + math.pi) % (2 * math.pi) - math.pi
                if abs(difference) > SENSOR_HALF_ANGLE:
                    continue
                distance_factor = 1.0 - distance / SENSOR_RANGE
                angle_factor = 1.0 - abs(difference) / SENSOR_HALF_ANGLE
                best_intensity = max(best_intensity, distance_factor * (0.45 + 0.55 * angle_factor))

            value = SENSOR_CLEAR_VALUE - round(
                (SENSOR_CLEAR_VALUE - SENSOR_MIN_VALUE) * best_intensity
            )
            readings[name] = min(max(value, SENSOR_MIN_VALUE), SENSOR_CLEAR_VALUE)
        return readings

    def apply_drive(self, delta_seconds: float) -> None:
        robot = self.robot
        dt = min(max(delta_seconds, 0.0), 0.1)
        if robot.drive == "LEFT":
            robot.heading -= 1.8 * dt
        elif robot.drive == "RIGHT":
            robot.heading += 1.8 * dt
        elif robot.drive in ("FORWARD", "BACKWARD"):
            direction = 1 if robot.drive == "FORWARD" else -1
            distance = 115.0 * dt * direction
            robot.x += math.sin(robot.heading) * distance
            robot.y -= math.cos(robot.heading) * distance

        robot.heading = (robot.heading + math.pi) % (2 * math.pi) - math.pi
        robot.x = min(max(robot.x, ROBOT_RADIUS), ROOM_WIDTH - ROBOT_RADIUS)
        robot.y = min(max(robot.y, ROBOT_RADIUS), ROOM_HEIGHT - ROBOT_RADIUS)

    def snapshot(self) -> dict[str, object]:
        readings = self.sensor_readings()
        robot = self.robot
        return {
            "type": "state",
            "room": {"width": ROOM_WIDTH, "height": ROOM_HEIGHT},
            "robot": {
                "x": round(robot.x, 2),
                "y": round(robot.y, 2),
                "heading": round(robot.heading, 4),
                "mode": robot.mode,
                "drive": robot.drive,
                "motorSpeed": robot.motor_speed,
                "pump": robot.pump,
                "servo": round(robot.servo),
            },
            "sensors": readings,
            "fires": [
                {
                    "id": fire.id,
                    "x": round(fire.x, 2),
                    "y": round(fire.y, 2),
                    "active": fire.active,
                    "progress": round(fire.extinguish_progress, 2),
                }
                for fire in self.fires
            ],
        }
