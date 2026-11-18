"""Local-only WebSocket API and static host for the room simulation."""

import asyncio
from contextlib import asynccontextmanager, suppress
import math
from pathlib import Path
import sys

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
import uvicorn

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from simulation.hardware_pins import PIN_MAP, SERIAL_BAUD
from simulation.physics_env import PhysicsEnvironment
from simulation.robot_logic import RobotLogic
from simulation.signal_test import PeriodicSignalTest
from server.control_bridge import ControlServerBridge

TICK_SECONDS = 0.05
MAX_DELTA_SECONDS = 0.1
ALLOWED_DRIVE_COMMANDS = {"FORWARD", "BACKWARD", "LEFT", "RIGHT", "STOP"}

environment = PhysicsEnvironment()
robot_logic = RobotLogic()
signal_test = PeriodicSignalTest()
connections: set[WebSocket] = set()


def build_state(
    robot_id: str | None = None,
    robot_connected: bool = False,
    available_robot_ids: list[str] | None = None,
) -> dict[str, object]:
    state = environment.snapshot()
    state["pins"] = robot_logic.pin_state(environment)
    state["pinMap"] = PIN_MAP
    state["serialBaud"] = SERIAL_BAUD
    state["signalTest"] = signal_test.snapshot()
    if robot_id is not None:
        state["robotId"] = robot_id
        state["robotConnected"] = robot_connected
        state["availableRobotIds"] = available_robot_ids or []
    return state


async def simulation_loop(control_bridge: ControlServerBridge) -> None:
    previous_time = asyncio.get_running_loop().time()
    while True:
        await asyncio.sleep(TICK_SECONDS)
        now = asyncio.get_running_loop().time()
        delta_seconds = min(now - previous_time, MAX_DELTA_SECONDS)
        previous_time = now
        signal_test.update(environment, delta_seconds)
        robot_logic.update(environment, delta_seconds)
        state = build_state(
            control_bridge.robot_id,
            control_bridge.client.connected,
            control_bridge.available_robot_ids,
        )
        await control_bridge.report_state(state)
        disconnected: list[WebSocket] = []
        for connection in tuple(connections):
            try:
                await connection.send_json(state)
            except (RuntimeError, WebSocketDisconnect):
                disconnected.append(connection)
        for connection in disconnected:
            connections.discard(connection)


@asynccontextmanager
async def lifespan(_: FastAPI):
    control_bridge = ControlServerBridge(handle_command)
    app.state.control_bridge = control_bridge
    signal_test.start(environment, robot_logic)
    bridge_task = asyncio.create_task(control_bridge.connect())
    task = asyncio.create_task(simulation_loop(control_bridge))
    try:
        yield
    finally:
        task.cancel()
        bridge_task.cancel()
        with suppress(asyncio.CancelledError):
            await task
        with suppress(asyncio.CancelledError):
            await bridge_task
        await control_bridge.disconnect()


app = FastAPI(title="Fireline Robot Room Simulation", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=PROJECT_ROOT / "server" / "static"), name="static")


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(PROJECT_ROOT / "server" / "static" / "index.html")


@app.get("/health")
async def health() -> dict[str, object]:
    control_bridge: ControlServerBridge = app.state.control_bridge
    return {
        "ok": True,
        "mode": "simulation-only",
        "connectedClients": len(connections),
        "controlServerConnected": control_bridge.client.connected,
        "robotId": control_bridge.robot_id,
    }


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    await websocket.accept()
    connections.add(websocket)
    control_bridge: ControlServerBridge = app.state.control_bridge
    await websocket.send_json(build_state(
        control_bridge.robot_id,
        control_bridge.client.connected,
        control_bridge.available_robot_ids,
    ))
    try:
        while True:
            try:
                payload = await websocket.receive_json()
            except ValueError:
                await websocket.send_json({"type": "error", "message": "Command must contain valid JSON."})
                continue
            if not isinstance(payload, dict):
                await websocket.send_json({"type": "error", "message": "Expected a JSON command object."})
                continue
            if payload.get("command") == "SET_ROBOT_ID":
                try:
                    await control_bridge.configure_robot(payload.get("robotId"))
                except ValueError as error:
                    await websocket.send_json({"type": "error", "message": str(error)})
                else:
                    await websocket.send_json({
                        "type": "robot-link",
                        "robotId": control_bridge.robot_id,
                    })
                continue
            error = handle_command(payload)
            if error:
                await websocket.send_json({"type": "error", "message": error})
    except WebSocketDisconnect:
        connections.discard(websocket)


def handle_command(payload: dict[str, object]) -> str | None:
    command = payload.get("command")
    if command == "START_AUTO_SIGNAL_TEST":
        signal_test.start(environment, robot_logic)
        return None
    if command == "STOP_AUTO_SIGNAL_TEST":
        signal_test.stop(environment)
        return None
    if command in {
        "ADD_FIRE",
        "START_MISSION",
        "START_SIGNAL_DEMO",
        "CLEAR_FIRES",
        "RESET",
        "FORWARD",
        "BACKWARD",
        "LEFT",
        "RIGHT",
        "PUMP_ON",
        "AUTOPILOT_ON",
    } or (command == "SET_MODE" and payload.get("mode") == "AUTOPILOT"):
        signal_test.stop(environment)

    if command == "ADD_FIRE":
        x = payload.get("x")
        y = payload.get("y")
        if (
            isinstance(x, (int, float))
            and not isinstance(x, bool)
            and isinstance(y, (int, float))
            and not isinstance(y, bool)
            and math.isfinite(x)
            and math.isfinite(y)
        ):
            environment.add_fire(x, y)
            return None
        return "A fire location must have finite numeric x and y coordinates."
    elif command == "START_MISSION":
        environment.clear()
        robot_logic.reset(environment)
        robot = environment.robot
        environment.add_fire(
            robot.x + math.sin(robot.heading) * 180,
            robot.y - math.cos(robot.heading) * 180,
        )
    elif command == "START_SIGNAL_DEMO":
        zone = payload.get("zone")
        offsets = {"right": math.pi / 2, "front": 0.0, "left": -math.pi / 2}
        if not isinstance(zone, str) or zone not in offsets:
            return "Signal demo zone must be right, front, or left."
        environment.clear()
        robot_logic.reset(environment)
        robot_logic.set_mode("MANUAL", environment)
        robot = environment.robot
        angle = robot.heading + offsets[zone]
        environment.add_fire(
            robot.x + math.sin(angle) * 40,
            robot.y - math.cos(angle) * 40,
        )
    elif command == "CLEAR_FIRES":
        environment.fires.clear()
        robot_logic.set_mode(environment.robot.mode, environment)
    elif command == "RESET":
        environment.clear()
        robot_logic.reset(environment)
    elif command == "SET_MODE":
        mode = payload.get("mode")
        if mode in {"MANUAL", "AUTOPILOT"}:
            robot_logic.set_mode(str(mode), environment)
        else:
            return "Mode must be MANUAL or AUTOPILOT."
    elif command == "STOP":
        robot_logic.set_mode("MANUAL", environment)
    elif command in ALLOWED_DRIVE_COMMANDS and environment.robot.mode == "MANUAL":
        robot_logic.set_manual_command(str(command))
    elif command == "PUMP_ON" and environment.robot.mode == "MANUAL":
        robot_logic.set_manual_pump(True)
    elif command == "PUMP_OFF":
        robot_logic.set_manual_pump(False)
        environment.robot.pump = False
    elif command in ALLOWED_DRIVE_COMMANDS:
        return "Switch to Manual mode before using movement controls."
    elif command in {"PUMP_ON", "PUMP_OFF"}:
        return "Switch to Manual mode before using the simulated pump."
    elif command not in {"CLEAR_FIRES", "RESET"}:
        return "Unsupported simulation command."
    return None


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)
