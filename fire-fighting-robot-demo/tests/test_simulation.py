import asyncio
import math
import unittest

from simulation.hardware_pins import (
    DEFAULT_SPEED,
    FRONT_FIRE_THRESHOLD,
    FRONT_SEARCH_THRESHOLD,
    LEFT_FIRE_THRESHOLD,
    LEFT_SEARCH_THRESHOLD,
    RIGHT_FIRE_THRESHOLD,
    RIGHT_SEARCH_THRESHOLD,
    SENSOR_CLEAR_VALUE,
)
from simulation.physics_env import ROOM_HEIGHT, ROOM_WIDTH, PhysicsEnvironment
from simulation.robot_logic import RobotLogic
from simulation.signal_test import (
    SIGNAL_TEST_INTERVAL_SECONDS,
    SIGNAL_TEST_PULSE_SECONDS,
    PeriodicSignalTest,
)
from server.control_bridge import (
    ControlServerBridge,
    _read_token_map,
    _token_for_robot,
    build_telemetry,
)


class SimulationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.environment = PhysicsEnvironment()
        self.logic = RobotLogic()

    def test_idle_room_reports_clear_sensors_and_safe_outputs(self) -> None:
        state = self.environment.snapshot()
        pins = self.logic.pin_state(self.environment)

        self.assertEqual(state["sensors"], {
            "right": SENSOR_CLEAR_VALUE,
            "front": SENSOR_CLEAR_VALUE,
            "left": SENSOR_CLEAR_VALUE,
        })
        self.assertEqual(pins["enA"], DEFAULT_SPEED)
        self.assertEqual(pins["enB"], DEFAULT_SPEED)
        self.assertEqual(pins["pump"], 0)
        self.assertEqual(pins["servo"], 90)

    def test_pdf_flame_thresholds_and_virtual_pin_map_are_present(self) -> None:
        from simulation.hardware_pins import PIN_MAP

        self.assertEqual(RIGHT_FIRE_THRESHOLD, 250)
        self.assertEqual(FRONT_FIRE_THRESHOLD, 350)
        self.assertEqual(LEFT_FIRE_THRESHOLD, 250)
        self.assertEqual(RIGHT_SEARCH_THRESHOLD, 700)
        self.assertEqual(FRONT_SEARCH_THRESHOLD, 800)
        self.assertEqual(LEFT_SEARCH_THRESHOLD, 700)
        self.assertEqual(PIN_MAP["enA"], "D10")
        self.assertEqual(PIN_MAP["in1"], "D9")
        self.assertEqual(PIN_MAP["in2"], "D8")
        self.assertEqual(PIN_MAP["in3"], "D7")
        self.assertEqual(PIN_MAP["in4"], "D6")
        self.assertEqual(PIN_MAP["enB"], "D5")
        self.assertEqual(PIN_MAP["ir_R"], "A0")
        self.assertEqual(PIN_MAP["ir_F"], "A1")
        self.assertEqual(PIN_MAP["ir_L"], "A2")
        self.assertEqual(PIN_MAP["servo"], "A4")
        self.assertEqual(PIN_MAP["pump"], "A5")

    def test_pdf_fire_cutoff_boundaries_and_priority(self) -> None:
        zone = self.logic._flame_zone

        self.assertEqual(zone({"right": 249, "front": 100, "left": 100}), "right")
        self.assertEqual(zone({"right": 250, "front": 349, "left": 100}), "front")
        self.assertEqual(zone({"right": 250, "front": 350, "left": 249}), "left")
        self.assertIsNone(zone({"right": 250, "front": 350, "left": 250}))

    def test_pdf_startup_servo_sweep_and_pwm_enable_values(self) -> None:
        for _ in range(50):
            self.logic.update(self.environment, 0.05)

        self.assertEqual(self.environment.robot.servo, 95)
        pins = self.logic.pin_state(self.environment)
        self.assertEqual(pins["enA"], 160)
        self.assertEqual(pins["enB"], 160)

    def test_pdf_initialization_and_sensor_servo_sequences(self) -> None:
        sequence = RobotLogic._sequence
        self.assertEqual(
            RobotLogic._setup_servo_path(),
            sequence(90, 140, 5) + sequence(140, 40, -5) + sequence(40, 95, 5),
        )
        self.assertEqual(
            RobotLogic._pump_servo_path("right"),
            sequence(90, 40, -3) + sequence(40, 90, 3),
        )
        self.assertEqual(
            RobotLogic._pump_servo_path("front"),
            sequence(90, 140, 3) + sequence(140, 40, -3) + sequence(40, 90, 3),
        )
        self.assertEqual(
            RobotLogic._pump_servo_path("left"),
            sequence(90, 140, 3) + sequence(140, 90, -3),
        )

    def test_pdf_l298n_motor_pin_states_for_all_directions(self) -> None:
        expected = {
            "FORWARD": {"in1": 1, "in2": 0, "in3": 0, "in4": 1},
            "BACKWARD": {"in1": 0, "in2": 1, "in3": 1, "in4": 0},
            "LEFT": {"in1": 1, "in2": 0, "in3": 1, "in4": 0},
            "RIGHT": {"in1": 0, "in2": 1, "in3": 0, "in4": 1},
            "STOP": {"in1": 0, "in2": 0, "in3": 0, "in4": 0},
        }

        self.logic.set_mode("MANUAL", self.environment)
        for drive, pins in expected.items():
            self.logic.set_manual_command(drive)
            self.logic.update(self.environment, 0.05)
            state = self.logic.pin_state(self.environment)
            for pin, value in pins.items():
                self.assertEqual(state[pin], value, f"{drive} pin {pin}")

    def test_pdf_search_branches_for_each_flame_sensor(self) -> None:
        offsets = {"right": 1.57079632679, "front": 0, "left": -1.57079632679}
        expected = {"right": "BACKWARD", "front": "FORWARD", "left": "BACKWARD"}

        for zone, offset in offsets.items():
            with self.subTest(zone=zone):
                environment = PhysicsEnvironment()
                logic = RobotLogic()
                for _ in range(50):
                    logic.update(environment, 0.05)
                robot = environment.robot
                environment.add_fire(
                    robot.x + math.sin(offset) * 140,
                    robot.y - math.cos(offset) * 140,
                )

                logic.update(environment, 0.05)

                self.assertEqual(environment.robot.drive, expected[zone])
                self.assertFalse(environment.robot.pump)

    def test_pdf_side_search_runs_reverse_then_200ms_turn(self) -> None:
        for zone, offset, turn, heading_sign in (
            ("right", math.pi / 2, "RIGHT", 1),
            ("left", -math.pi / 2, "LEFT", -1),
        ):
            with self.subTest(zone=zone):
                environment = PhysicsEnvironment()
                logic = RobotLogic()
                for _ in range(50):
                    logic.update(environment, 0.05)
                robot = environment.robot
                environment.add_fire(
                    robot.x + math.sin(offset) * 140,
                    robot.y - math.cos(offset) * 140,
                )

                logic.update(environment, 0.05)
                self.assertEqual(robot.drive, "BACKWARD")
                logic.update(environment, 0.05)
                self.assertEqual(robot.drive, turn)
                for _ in range(3):
                    logic.update(environment, 0.05)
                    self.assertEqual(robot.drive, turn)
                logic.update(environment, 0.05)

                self.assertEqual(robot.drive, "STOP")
                self.assertAlmostEqual(robot.heading, heading_sign * 0.36)

    def test_pdf_close_flame_priority_stops_and_pumps_with_servo_sweep(self) -> None:
        for _ in range(50):
            self.logic.update(self.environment, 0.05)
        robot = self.environment.robot
        self.environment.add_fire(robot.x + 40, robot.y)
        self.environment.add_fire(robot.x, robot.y - 40)

        self.logic.update(self.environment, 0.05)

        self.assertEqual(self.environment.robot.drive, "STOP")
        self.assertTrue(self.environment.robot.pump)
        self.assertEqual(self.environment.robot.servo, 90)
        self.assertEqual(self.logic._servo_action, "right")

    def test_autopilot_turns_on_simulated_pump_and_extinguishes_close_fire(self) -> None:
        fire = self.environment.add_fire(self.environment.robot.x, self.environment.robot.y - 45)

        for _ in range(190):
            self.logic.update(self.environment, 0.05)

        self.assertFalse(fire.active)
        self.assertFalse(self.environment.robot.pump)
        self.assertEqual(self.environment.robot.servo, 88)

    def test_manual_drive_moves_robot_and_reports_virtual_motor_pwm(self) -> None:
        starting_y = self.environment.robot.y
        self.logic.set_mode("MANUAL", self.environment)
        self.logic.set_manual_command("FORWARD")
        self.logic.update(self.environment, 0.1)

        self.assertLess(self.environment.robot.y, starting_y)
        self.assertEqual(self.logic.pin_state(self.environment)["enA"], DEFAULT_SPEED)

    def test_out_of_room_fire_coordinates_are_clamped(self) -> None:
        fire = self.environment.add_fire(-100, 5000)

        self.assertEqual(fire.x, 28)
        self.assertEqual(fire.y, 732)

    def test_start_demo_mission_creates_a_fire_ahead_of_autopilot_robot(self) -> None:
        from server import app as simulator_app

        previous_environment = simulator_app.environment
        previous_logic = simulator_app.robot_logic
        simulator_app.environment = self.environment
        simulator_app.robot_logic = self.logic
        try:
            self.assertIsNone(simulator_app.handle_command({"command": "START_MISSION"}))
        finally:
            simulator_app.environment = previous_environment
            simulator_app.robot_logic = previous_logic

        robot = self.environment.robot
        self.assertEqual(robot.mode, "AUTOPILOT")
        self.assertEqual(len(self.environment.active_fires()), 1)
        fire = self.environment.active_fires()[0]
        self.assertAlmostEqual(fire.x, robot.x)
        self.assertAlmostEqual(fire.y, robot.y - 180)

    def test_signal_preview_holds_a_fire_signal_in_each_sensor_zone(self) -> None:
        from server import app as simulator_app

        previous_environment = simulator_app.environment
        previous_logic = simulator_app.robot_logic
        simulator_app.environment = self.environment
        simulator_app.robot_logic = self.logic
        try:
            for zone, threshold in (
                ("right", RIGHT_FIRE_THRESHOLD),
                ("front", FRONT_FIRE_THRESHOLD),
                ("left", LEFT_FIRE_THRESHOLD),
            ):
                with self.subTest(zone=zone):
                    error = simulator_app.handle_command({
                        "command": "START_SIGNAL_DEMO",
                        "zone": zone,
                    })
                    self.assertIsNone(error)
                    self.logic.update(self.environment, 0.05)

                    self.assertEqual(self.environment.robot.mode, "MANUAL")
                    self.assertEqual(self.environment.robot.drive, "STOP")
                    self.assertFalse(self.environment.robot.pump)
                    self.assertEqual(len(self.environment.active_fires()), 1)
                    self.assertLess(self.environment.sensor_readings()[zone], threshold)

            self.assertIsNotNone(simulator_app.handle_command({
                "command": "START_SIGNAL_DEMO",
                "zone": [],
            }))
        finally:
            simulator_app.environment = previous_environment
            simulator_app.robot_logic = previous_logic

    def test_periodic_signal_test_generates_two_second_pulses_every_ten_seconds(self) -> None:
        signal_test = PeriodicSignalTest()
        thresholds = {
            "right": RIGHT_FIRE_THRESHOLD,
            "front": FRONT_FIRE_THRESHOLD,
            "left": LEFT_FIRE_THRESHOLD,
        }
        signal_test.start(self.environment, self.logic)

        for zone in ("right", "front", "left"):
            with self.subTest(zone=zone):
                self.assertEqual(self.environment.robot.mode, "MANUAL")
                self.assertEqual(self.environment.robot.drive, "STOP")
                self.assertFalse(self.environment.robot.pump)
                self.assertLess(self.environment.sensor_readings()[zone], thresholds[zone])
                self.assertEqual(signal_test.snapshot()["zone"], zone)

                pulse_ticks = round(SIGNAL_TEST_PULSE_SECONDS / 0.05)
                for _ in range(pulse_ticks):
                    signal_test.update(self.environment, 0.05)
                self.assertFalse(any(fire.active for fire in self.environment.fires))
                self.assertEqual(self.environment.sensor_readings()[zone], SENSOR_CLEAR_VALUE)

                wait_ticks = round(
                    (SIGNAL_TEST_INTERVAL_SECONDS - SIGNAL_TEST_PULSE_SECONDS) / 0.05
                )
                for _ in range(wait_ticks):
                    signal_test.update(self.environment, 0.05)

        self.assertEqual(signal_test.snapshot()["zone"], "right")

    def test_stopping_periodic_signal_test_clears_its_pulse_and_disables_future_signals(self) -> None:
        signal_test = PeriodicSignalTest()
        signal_test.start(self.environment, self.logic)
        signal_test.stop(self.environment)

        for _ in range(round(SIGNAL_TEST_INTERVAL_SECONDS / 0.05)):
            signal_test.update(self.environment, 0.05)

        self.assertFalse(signal_test.snapshot()["enabled"])
        self.assertFalse(any(fire.active for fire in self.environment.fires))

    def test_auto_signal_commands_start_stop_and_publish_test_status(self) -> None:
        from server import app as simulator_app

        previous_environment = simulator_app.environment
        previous_logic = simulator_app.robot_logic
        previous_signal_test = simulator_app.signal_test
        simulator_app.environment = self.environment
        simulator_app.robot_logic = self.logic
        simulator_app.signal_test = PeriodicSignalTest()
        try:
            self.assertIsNone(simulator_app.handle_command({
                "command": "START_AUTO_SIGNAL_TEST",
            }))
            self.assertTrue(simulator_app.build_state()["signalTest"]["enabled"])
            self.assertLess(
                self.environment.sensor_readings()["right"],
                RIGHT_FIRE_THRESHOLD,
            )

            self.assertIsNone(simulator_app.handle_command({
                "command": "STOP_AUTO_SIGNAL_TEST",
            }))
            self.assertFalse(simulator_app.build_state()["signalTest"]["enabled"])
            self.assertEqual(self.environment.sensor_readings(), {
                "right": SENSOR_CLEAR_VALUE,
                "front": SENSOR_CLEAR_VALUE,
                "left": SENSOR_CLEAR_VALUE,
            })
        finally:
            simulator_app.environment = previous_environment
            simulator_app.robot_logic = previous_logic
            simulator_app.signal_test = previous_signal_test

    def test_safety_stop_and_manual_mode_do_not_interrupt_auto_signal_test(self) -> None:
        from server import app as simulator_app

        previous_environment = simulator_app.environment
        previous_logic = simulator_app.robot_logic
        previous_signal_test = simulator_app.signal_test
        signal_test = PeriodicSignalTest()
        simulator_app.environment = self.environment
        simulator_app.robot_logic = self.logic
        simulator_app.signal_test = signal_test
        try:
            signal_test.start(self.environment, self.logic)
            self.assertIsNone(simulator_app.handle_command({"command": "STOP"}))
            self.assertTrue(signal_test.snapshot()["enabled"])
            self.assertLess(self.environment.sensor_readings()["right"], RIGHT_FIRE_THRESHOLD)

            self.assertIsNone(simulator_app.handle_command({
                "command": "SET_MODE",
                "mode": "MANUAL",
            }))
            self.assertTrue(signal_test.snapshot()["enabled"])

            self.assertIsNone(simulator_app.handle_command({
                "command": "SET_MODE",
                "mode": "AUTOPILOT",
            }))
            self.assertFalse(signal_test.snapshot()["enabled"])
        finally:
            simulator_app.environment = previous_environment
            simulator_app.robot_logic = previous_logic
            simulator_app.signal_test = previous_signal_test

    def test_robot_id_uses_only_its_configured_device_token(self) -> None:
        tokens = _read_token_map('{"robot-1":"legacy","lab-2":"separate"}')

        self.assertEqual(_token_for_robot("lab-2", tokens, "legacy"), "separate")
        self.assertEqual(_token_for_robot("robot-1", {}, "legacy"), "legacy")
        self.assertEqual(_token_for_robot("lab-3", tokens, "legacy"), "")
        with self.assertRaises(ValueError):
            _read_token_map('{"bad id":"token"}')

    def test_robot_id_can_be_switched_to_another_configured_virtual_device(self) -> None:
        bridge = ControlServerBridge(lambda _: None)
        bridge._token_map = {"lab-2": "test-token"}
        bridge._dedicated_token = ""
        bridge._fallback_token = ""

        asyncio.run(bridge.configure_robot("lab-2"))

        self.assertEqual(bridge.robot_id, "lab-2")
        self.assertEqual(bridge.token, "test-token")
        self.assertEqual(bridge.available_robot_ids, ["lab-2"])
        with self.assertRaises(ValueError):
            asyncio.run(bridge.configure_robot("unknown"))

    def test_control_telemetry_scales_sensors_and_maps_room_position(self) -> None:
        robot = {
            "x": ROOM_WIDTH / 2,
            "y": ROOM_HEIGHT / 2,
            "mode": "MANUAL",
            "pump": True,
        }
        sensors = {"right": 100, "front": 500, "left": 950}

        telemetry = build_telemetry(robot, sensors)

        self.assertEqual(telemetry["sensors"], {
            "right": round(100 * 4095 / 1023),
            "front": round(500 * 4095 / 1023),
            "left": round(950 * 4095 / 1023),
        })
        self.assertEqual(telemetry["mode"], "MANUAL")
        self.assertTrue(telemetry["pump"])
        self.assertEqual(telemetry["gps"]["latitude"], 37.7749)
        self.assertEqual(telemetry["gps"]["longitude"], -122.4194)

    def test_control_server_mode_commands_change_simulator_telemetry(self) -> None:
        from server import app as simulator_app

        simulator_app.environment = PhysicsEnvironment()
        simulator_app.robot_logic = RobotLogic()
        bridge = ControlServerBridge(simulator_app.handle_command)

        async def send_and_report_mode(command: str) -> str:
            await bridge._on_robot_command({"command": command})
            state = simulator_app.build_state()
            return build_telemetry(state["robot"], state["sensors"])["mode"]

        self.assertEqual(
            asyncio.run(send_and_report_mode("MANUAL")),
            "MANUAL",
        )
        self.assertEqual(
            asyncio.run(send_and_report_mode("AUTOPILOT_ON")),
            "AUTOPILOT",
        )

    def test_control_bridge_manual_drive_pump_and_safe_stop_are_simulation_only(self) -> None:
        from server import app as simulator_app

        previous_environment = simulator_app.environment
        previous_logic = simulator_app.robot_logic
        simulator_app.environment = PhysicsEnvironment()
        simulator_app.robot_logic = RobotLogic()
        bridge = ControlServerBridge(simulator_app.handle_command)

        async def send(command: str) -> None:
            await bridge._on_robot_command({"command": command})

        try:
            starting_y = simulator_app.environment.robot.y
            asyncio.run(send("MANUAL"))
            asyncio.run(send("FORWARD"))
            simulator_app.robot_logic.update(simulator_app.environment, 0.1)
            self.assertLess(simulator_app.environment.robot.y, starting_y)

            asyncio.run(send("PUMP_ON"))
            simulator_app.robot_logic.update(simulator_app.environment, 0.05)
            self.assertTrue(simulator_app.environment.robot.pump)

            asyncio.run(send("STOP"))
            simulator_app.robot_logic.update(simulator_app.environment, 0.05)
            self.assertEqual(simulator_app.environment.robot.drive, "STOP")
            self.assertFalse(simulator_app.environment.robot.pump)

            asyncio.run(send("AUTOPILOT_ON"))
            self.assertEqual(simulator_app.environment.robot.mode, "AUTOPILOT")
        finally:
            simulator_app.environment = previous_environment
            simulator_app.robot_logic = previous_logic


if __name__ == "__main__":
    unittest.main()
