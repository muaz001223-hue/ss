"""Periodic virtual flame-sensor pulses for the software simulation."""

import math

from .physics_env import PhysicsEnvironment
from .robot_logic import RobotLogic

SIGNAL_TEST_INTERVAL_SECONDS = 10.0
SIGNAL_TEST_PULSE_SECONDS = 2.0
SIGNAL_TEST_ZONES = ("right", "front", "left")
SIGNAL_TEST_DISTANCE = 40.0


class PeriodicSignalTest:
    def __init__(self) -> None:
        self.enabled = False
        self._elapsed = 0.0
        self._next_signal_at = 0.0
        self._active_until = 0.0
        self._next_zone_index = 0
        self._active_zone: str | None = None
        self._fire_id: int | None = None

    def start(self, environment: PhysicsEnvironment, logic: RobotLogic) -> None:
        self.stop(environment)
        environment.fires.clear()
        logic.set_mode("MANUAL", environment)
        self.enabled = True
        self._elapsed = 0.0
        self._next_signal_at = 0.0
        self._active_until = 0.0
        self._next_zone_index = 0
        self.update(environment, 0.0)

    def stop(self, environment: PhysicsEnvironment) -> None:
        self._deactivate_fire(environment)
        self.enabled = False
        self._active_zone = None
        self._next_signal_at = 0.0

    def update(self, environment: PhysicsEnvironment, delta_seconds: float) -> None:
        if not self.enabled:
            return

        self._elapsed += max(0.0, delta_seconds)
        if self._fire_id is not None and self._elapsed >= self._active_until:
            self._deactivate_fire(environment)

        if self._fire_id is not None or self._elapsed < self._next_signal_at:
            return

        zone = SIGNAL_TEST_ZONES[self._next_zone_index]
        self._next_zone_index = (self._next_zone_index + 1) % len(SIGNAL_TEST_ZONES)
        offsets = {"right": math.pi / 2, "front": 0.0, "left": -math.pi / 2}
        angle = environment.robot.heading + offsets[zone]
        fire = environment.add_fire(
            environment.robot.x + math.sin(angle) * SIGNAL_TEST_DISTANCE,
            environment.robot.y - math.cos(angle) * SIGNAL_TEST_DISTANCE,
        )
        self._fire_id = fire.id
        self._active_zone = zone
        self._active_until = self._elapsed + SIGNAL_TEST_PULSE_SECONDS
        self._next_signal_at = self._elapsed + SIGNAL_TEST_INTERVAL_SECONDS

    def snapshot(self) -> dict[str, bool | float | str | None]:
        pulse_active = self._fire_id is not None
        return {
            "enabled": self.enabled,
            "pulseActive": pulse_active,
            "zone": self._active_zone or SIGNAL_TEST_ZONES[self._next_zone_index],
            "secondsUntilNext": round(max(0.0, self._next_signal_at - self._elapsed), 1),
        }

    def _deactivate_fire(self, environment: PhysicsEnvironment) -> None:
        if self._fire_id is not None:
            environment.fires[:] = [
                fire for fire in environment.fires if fire.id != self._fire_id
            ]
        self._fire_id = None
        self._active_zone = None

