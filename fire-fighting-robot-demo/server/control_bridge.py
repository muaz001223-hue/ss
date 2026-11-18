"""Connect the virtual robot to the dashboard's Socket.IO control server."""

import asyncio
import json
import logging
import math
import os
import re
from collections.abc import Mapping
from pathlib import Path
from typing import Callable

import socketio
from dotenv import load_dotenv

from simulation.physics_env import ROOM_HEIGHT, ROOM_WIDTH

logger = logging.getLogger(__name__)
REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(REPOSITORY_ROOT / ".env")

CONTROL_SERVER_URL = os.getenv("CONTROL_SERVER_URL", "http://127.0.0.1:4100")
ROBOT_ID = os.getenv("SIM_ROBOT_ID", "sim-robot-1")
GPS_ORIGIN_LATITUDE = float(os.getenv("SIM_GPS_ORIGIN_LATITUDE", "37.7749"))
GPS_ORIGIN_LONGITUDE = float(os.getenv("SIM_GPS_ORIGIN_LONGITUDE", "-122.4194"))
GPS_METERS_PER_PIXEL = float(os.getenv("SIM_GPS_METERS_PER_PIXEL", "0.5"))
METERS_PER_DEGREE = 111_320
ROBOT_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$")


def _read_token_map(configured_tokens: str | None) -> dict[str, str]:
    if not configured_tokens:
        return {}
    try:
        token_map = json.loads(configured_tokens)
    except json.JSONDecodeError as error:
        raise ValueError("DEVICE_TOKENS_JSON must contain a valid JSON object.") from error
    if not isinstance(token_map, dict) or any(
        not isinstance(robot_id, str)
        or not ROBOT_ID_PATTERN.fullmatch(robot_id)
        or not isinstance(token, str)
        or not token
        for robot_id, token in token_map.items()
    ):
        raise ValueError("DEVICE_TOKENS_JSON must map valid Robot IDs to non-empty tokens.")
    return token_map


def _token_for_robot(
    robot_id: str,
    token_map: Mapping[str, str],
    fallback_token: str,
) -> str:
    if robot_id in token_map:
        return token_map[robot_id]
    return fallback_token if robot_id == "robot-1" else ""


def _number(value: object, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"Simulator state field {field!r} must be numeric.")
    if not math.isfinite(value):
        raise ValueError(f"Simulator state field {field!r} must be finite.")
    return float(value)


def build_telemetry(
    robot: Mapping[str, object],
    sensors: Mapping[str, object],
) -> dict[str, object]:
    x = _number(robot.get("x"), "robot.x")
    y = _number(robot.get("y"), "robot.y")
    latitude = GPS_ORIGIN_LATITUDE + (
        (ROOM_HEIGHT / 2 - y) * GPS_METERS_PER_PIXEL / METERS_PER_DEGREE
    )
    longitude_scale = METERS_PER_DEGREE * max(
        math.cos(math.radians(GPS_ORIGIN_LATITUDE)),
        0.01,
    )
    longitude = GPS_ORIGIN_LONGITUDE + (
        (x - ROOM_WIDTH / 2) * GPS_METERS_PER_PIXEL / longitude_scale
    )
    readings = {
        name: round(_number(sensors.get(name), f"sensors.{name}") * 4095 / 1023)
        for name in ("right", "front", "left")
    }
    mode = robot.get("mode")
    pump = robot.get("pump")
    if not isinstance(mode, str) or not mode or not isinstance(pump, bool):
        raise ValueError("Simulator robot mode or pump state is invalid.")

    return {
        "sensors": readings,
        "gps": {"latitude": latitude, "longitude": longitude},
        "pump": pump,
        "mode": mode,
    }


class ControlServerBridge:
    def __init__(
        self,
        command_handler: Callable[[dict[str, object]], str | None],
    ) -> None:
        self.robot_id = ROBOT_ID
        if not ROBOT_ID_PATTERN.fullmatch(self.robot_id):
            raise ValueError("SIM_ROBOT_ID must be a valid Robot ID.")
        self._dedicated_robot_id = self.robot_id
        self._dedicated_token = os.getenv("SIM_DEVICE_TOKEN", "")
        self._fallback_token = os.getenv("DEVICE_TOKEN", "")
        self._token_map = _read_token_map(os.getenv("DEVICE_TOKENS_JSON"))
        self.token = self._token_for_robot(self.robot_id)
        self._configuration_version = 0
        self.command_handler = command_handler
        self.client = socketio.AsyncClient(reconnection=False)
        self.client.on("robot:command", self._on_robot_command)

    @property
    def available_robot_ids(self) -> list[str]:
        robot_ids = set(self._token_map)
        if self._fallback_token:
            robot_ids.add("robot-1")
        if self._dedicated_token:
            robot_ids.add(self._dedicated_robot_id)
        return sorted(robot_ids)

    def _token_for_robot(self, robot_id: str) -> str:
        token = _token_for_robot(robot_id, self._token_map, self._fallback_token)
        if token:
            return token
        return self._dedicated_token if robot_id == self._dedicated_robot_id else ""

    async def configure_robot(self, robot_id: object) -> None:
        if not isinstance(robot_id, str) or not ROBOT_ID_PATTERN.fullmatch(robot_id):
            raise ValueError(
                "Robot ID must start with a letter or number and contain only letters, "
                "numbers, '.', '_' or '-' (up to 32 characters)."
            )
        token = self._token_for_robot(robot_id)
        if not token:
            raise ValueError(
                f"No device token is configured for Robot ID {robot_id}. "
                "Add it to DEVICE_TOKENS_JSON or use the legacy robot-1 token."
            )
        if robot_id == self.robot_id:
            return

        self.robot_id = robot_id
        self.token = token
        self._configuration_version += 1
        if self.client.connected:
            await self.client.disconnect()
        logger.info("Virtual robot relay reconfigured for Robot ID %s.", robot_id)

    async def connect(self) -> None:
        missing_token_logged = False
        while True:
            if self.client.connected:
                await asyncio.sleep(0.5)
                continue
            if not self.token:
                if not missing_token_logged:
                    logger.warning(
                        "Simulator relay disabled: no device token is configured for Robot ID %s.",
                        self.robot_id,
                    )
                    missing_token_logged = True
                await asyncio.sleep(1)
                continue
            try:
                version = self._configuration_version
                await self.client.connect(
                    CONTROL_SERVER_URL,
                    auth={"token": self.token, "robotId": self.robot_id},
                    transports=["polling", "websocket"],
                    wait_timeout=5,
                )
                if version != self._configuration_version:
                    await self.client.disconnect()
                    continue
                missing_token_logged = False
                logger.info("Virtual robot connected to control server at %s.", CONTROL_SERVER_URL)
            except (socketio.exceptions.ConnectionError, OSError) as error:
                logger.error(
                    "Virtual robot could not connect to control server at %s: %s",
                    CONTROL_SERVER_URL,
                    error,
                )
                await asyncio.sleep(2)

    async def disconnect(self) -> None:
        if self.client.connected:
            await self.client.disconnect()

    async def report_state(self, state: Mapping[str, object]) -> None:
        if not self.client.connected:
            return
        robot = state.get("robot")
        sensors = state.get("sensors")
        if not isinstance(robot, Mapping) or not isinstance(sensors, Mapping):
            raise ValueError("Simulator state is missing robot or sensor data.")
        try:
            await self.client.emit("telemetry:report", build_telemetry(robot, sensors))
        except socketio.exceptions.SocketIOError as error:
            logger.error("Could not send simulator telemetry to the control server: %s", error)

    async def _on_robot_command(self, payload: object) -> None:
        if not isinstance(payload, Mapping):
            logger.warning("Ignoring malformed control command from the server.")
            return
        command = payload.get("command")
        if not isinstance(command, str):
            logger.warning("Ignoring control command without a command name.")
            return

        if command in {"AUTOPILOT_ON", "MANUAL"}:
            simulation_command = {
                "command": "SET_MODE",
                "mode": "AUTOPILOT" if command == "AUTOPILOT_ON" else "MANUAL",
            }
        else:
            simulation_command = {"command": command}

        error = self.command_handler(simulation_command)
        if error:
            logger.warning("Simulator rejected control command %s: %s", command, error)
