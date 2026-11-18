"""PDF-matched decision logic for the virtual robot; never accesses hardware."""

from .hardware_pins import (
    DEFAULT_SPEED,
    FRONT_FIRE_THRESHOLD,
    FRONT_SEARCH_THRESHOLD,
    LEFT_FIRE_THRESHOLD,
    LEFT_SEARCH_THRESHOLD,
    RIGHT_FIRE_THRESHOLD,
    RIGHT_SEARCH_THRESHOLD,
    SERVO_HOME,
    SERVO_MAX,
    SERVO_MIN,
    SERVO_REFRESH_SECONDS,
    SERVO_STEP,
)
from .physics_env import PhysicsEnvironment

EXTINGUISH_SECONDS = 4.0
REVERSE_SECONDS = 0.1
TURN_SECONDS = 0.2


class RobotLogic:
    def __init__(self) -> None:
        self.manual_command = "STOP"
        self.manual_pump = False
        self._servo_path = self._setup_servo_path()
        self._servo_elapsed = 0.0
        self._servo_action: str | None = "SETUP"
        self._motion_path: list[tuple[str, float]] = []
        self._motion_index = 0
        self._motion_remaining = 0.0
        self._pump_fire_id: int | None = None

    @staticmethod
    def _sequence(start: int, stop: int, step: int) -> list[int]:
        if step > 0:
            return list(range(start, stop + 1, step))
        return list(range(start, stop - 1, step))

    @classmethod
    def _setup_servo_path(cls) -> list[int]:
        return (
            cls._sequence(SERVO_HOME, SERVO_MAX, 5)
            + cls._sequence(SERVO_MAX, SERVO_MIN, -5)
            + cls._sequence(SERVO_MIN, 95, 5)
        )

    @classmethod
    def _pump_servo_path(cls, zone: str) -> list[int]:
        sweep_out = cls._sequence(SERVO_HOME, SERVO_MAX, SERVO_STEP)
        sweep_in = cls._sequence(SERVO_MAX, SERVO_MIN, -SERVO_STEP)
        sweep_home = cls._sequence(SERVO_MIN, SERVO_HOME, SERVO_STEP)
        if zone == "right":
            return (
                cls._sequence(SERVO_HOME, SERVO_MIN, -SERVO_STEP)
                + cls._sequence(SERVO_MIN, SERVO_HOME, SERVO_STEP)
            )
        if zone == "front":
            return sweep_out + sweep_in + sweep_home
        return sweep_out + cls._sequence(SERVO_MAX, SERVO_HOME, -SERVO_STEP)

    @staticmethod
    def _flame_zone(readings: dict[str, int]) -> str | None:
        if readings["right"] < RIGHT_FIRE_THRESHOLD:
            return "right"
        if readings["front"] < FRONT_FIRE_THRESHOLD:
            return "front"
        if readings["left"] < LEFT_FIRE_THRESHOLD:
            return "left"
        return None

    def _start_servo_path(self, action: str, path: list[int]) -> None:
        self._servo_action = action
        self._servo_path = path
        self._servo_elapsed = 0.0

    def _advance_servo_path(
        self,
        environment: PhysicsEnvironment,
        delta_seconds: float,
    ) -> bool:
        if not self._servo_path:
            return False
        self._servo_elapsed += delta_seconds
        while self._servo_elapsed + 1e-9 >= SERVO_REFRESH_SECONDS and self._servo_path:
            environment.robot.servo = self._servo_path.pop(0)
            self._servo_elapsed = max(0.0, self._servo_elapsed - SERVO_REFRESH_SECONDS)
        if not self._servo_path:
            self._servo_action = None
            return False
        return True

    def _update_pump_progress(self, environment: PhysicsEnvironment, dt: float) -> None:
        if self._pump_fire_id is None:
            return
        fire = next(
            (fire for fire in environment.fires if fire.id == self._pump_fire_id),
            None,
        )
        if fire is None or not fire.active:
            return
        fire.extinguish_progress += dt
        if fire.extinguish_progress >= EXTINGUISH_SECONDS:
            fire.active = False

    def _update_motion_path(
        self,
        environment: PhysicsEnvironment,
        delta_seconds: float,
    ) -> bool:
        if not self._motion_path:
            return False
        robot = environment.robot
        command, _ = self._motion_path[self._motion_index]
        robot.drive = command
        robot.motor_speed = DEFAULT_SPEED
        environment.apply_drive(delta_seconds)
        self._motion_remaining = max(0.0, self._motion_remaining - delta_seconds)
        if self._motion_remaining <= 1e-9:
            self._motion_index += 1
            if self._motion_index == len(self._motion_path):
                self._motion_path = []
                robot.drive = "STOP"
                robot.motor_speed = 0
            else:
                command, duration = self._motion_path[self._motion_index]
                self._motion_remaining = duration
                robot.drive = command
        return True

    def set_mode(self, mode: str, environment: PhysicsEnvironment) -> None:
        robot = environment.robot
        robot.mode = mode
        robot.drive = "STOP"
        robot.motor_speed = 0
        robot.pump = False
        robot.servo = SERVO_HOME
        self.manual_command = "STOP"
        self.manual_pump = False
        self._servo_path = []
        self._servo_elapsed = 0.0
        self._servo_action = None
        self._motion_path = []
        self._motion_index = 0
        self._pump_fire_id = None

    def reset(self, environment: PhysicsEnvironment) -> None:
        self.set_mode("AUTOPILOT", environment)
        self._servo_path = self._setup_servo_path()
        self._servo_action = "SETUP"

    def set_manual_command(self, command: str) -> None:
        self.manual_command = command

    def set_manual_pump(self, enabled: bool) -> None:
        self.manual_pump = enabled

    def update(self, environment: PhysicsEnvironment, delta_seconds: float) -> None:
        dt = min(max(delta_seconds, 0.0), 0.1)
        robot = environment.robot

        if robot.mode == "MANUAL":
            self._motion_path = []
            if self._servo_action == "SETUP":
                self._servo_path = []
                self._servo_action = None
            robot.drive = self.manual_command
            robot.motor_speed = DEFAULT_SPEED if self.manual_command != "STOP" else 0
            robot.pump = self.manual_pump
            environment.apply_drive(dt)
            if robot.pump:
                if self._servo_action != "manual":
                    self._start_servo_path("manual", self._pump_servo_path("front"))
                self._advance_servo_path(environment, dt)
            else:
                self._servo_path = []
                self._servo_action = None
                robot.servo = SERVO_HOME
            return

        if self._servo_action == "SETUP":
            robot.drive = "STOP"
            robot.motor_speed = 0
            robot.pump = False
            self._advance_servo_path(environment, dt)
            return

        if self._servo_action is not None:
            robot.drive = "STOP"
            robot.motor_speed = 0
            robot.pump = True
            self._update_pump_progress(environment, dt)
            self._advance_servo_path(environment, dt)
            return

        if self._update_motion_path(environment, dt):
            return

        readings = environment.sensor_readings()
        zone = self._flame_zone(readings)
        if zone is not None:
            robot.drive = "STOP"
            robot.motor_speed = 0
            robot.pump = True
            fire, _, _ = environment.nearest_fire()
            self._pump_fire_id = fire.id if fire is not None else None
            self._update_pump_progress(environment, dt)
            self._start_servo_path(zone, self._pump_servo_path(zone))
            self._advance_servo_path(environment, dt)
            return

        robot.pump = False
        self._pump_fire_id = None
        right, front, left = (
            readings["right"],
            readings["front"],
            readings["left"],
        )
        if RIGHT_FIRE_THRESHOLD < right <= RIGHT_SEARCH_THRESHOLD:
            self._motion_path = [
                ("BACKWARD", REVERSE_SECONDS),
                ("RIGHT", TURN_SECONDS),
            ]
        elif FRONT_FIRE_THRESHOLD <= front <= FRONT_SEARCH_THRESHOLD:
            robot.drive = "FORWARD"
            robot.motor_speed = DEFAULT_SPEED
            environment.apply_drive(dt)
            return
        elif LEFT_FIRE_THRESHOLD < left <= LEFT_SEARCH_THRESHOLD:
            self._motion_path = [
                ("BACKWARD", REVERSE_SECONDS),
                ("LEFT", TURN_SECONDS),
            ]
        else:
            robot.drive = "STOP"
            robot.motor_speed = 0
            return

        self._motion_index = 0
        self._motion_remaining = self._motion_path[0][1]
        self._update_motion_path(environment, dt)

    def pin_state(self, environment: PhysicsEnvironment) -> dict[str, int]:
        robot = environment.robot
        readings = environment.sensor_readings()
        forward = robot.drive == "FORWARD"
        backward = robot.drive == "BACKWARD"
        turning_left = robot.drive == "LEFT"
        turning_right = robot.drive == "RIGHT"
        return {
            "enA": DEFAULT_SPEED,
            "in1": int(forward or turning_left),
            "in2": int(backward or turning_right),
            "in3": int(backward or turning_left),
            "in4": int(forward or turning_right),
            "enB": DEFAULT_SPEED,
            "ir_R": readings["right"],
            "ir_F": readings["front"],
            "ir_L": readings["left"],
            "servo": round(robot.servo),
            "pump": int(robot.pump),
        }
