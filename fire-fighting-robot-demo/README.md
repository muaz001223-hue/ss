# Fireline Robot Simulation Demo

A self-contained, local-only 2D robot-room simulator. Place virtual fires,
watch simulated flame sensors and pin values, and try manual or autopilot
behavior in the browser. When the main Fireline control server and its
repository `.env` are available, the virtual robot connects as its device and
streams telemetry to the dashboard.

The simulation follows the six-page `projact.pdf` project reference: the
Arduino UNO pin assignments, L298N direction truth table, sensor cutoff and
search branches, PWM value, and servo sweeps are represented in the browser.
The component inventory also lists the PDF's sensors, motors/chassis, driver,
servo, pump and water path, battery cells, breadboard, switch, TIP122, resistor,
capacitor, and jumper wires.

## Safety boundary

This project is a visual software simulation, not fire-response equipment.
Motor, pump, and servo values are calculated virtual states only; there is no
hardware I/O path. The included Arduino sketch is a **sensor-only serial
monitor**; all actuator pins remain inputs and it never drives motors, a servo,
or a pump. The PDF's circuit and control behavior are reproduced for software
testing only, not for connecting or operating real hardware. A passing
simulation test does not verify physical wiring, electrical safety, water
handling, or fire-extinguishing performance.

## Requirements and run

- Python 3.10+
- A browser with Canvas and WebSocket support

From this directory:

```sh
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
python -m pip install -r requirements.txt
python server/app.py
```

Open <http://127.0.0.1:8000>. The server binds to loopback only. It also
provides a simple health endpoint at <http://127.0.0.1:8000/health>.
Start the main project with `npm run dev` in a second terminal. The simulator
reads `DEVICE_TOKEN` from the repository `.env`, retries its Socket.IO
connection to `http://127.0.0.1:4100`, and relays sensor, pump, mode, and
synthetic GPS telemetry. The default simulated GPS origin is San Francisco;
set `SIM_GPS_ORIGIN_LATITUDE` and `SIM_GPS_ORIGIN_LONGITUDE` to change it.
By default the simulator connects as `robot-1`. The lab's **Robot ID** field
can switch to another ID that has a configured device token. With
`DEVICE_TOKENS_JSON`, only IDs in that token map can connect; the legacy
`DEVICE_TOKEN` is accepted for `robot-1`; `SIM_DEVICE_TOKEN` is tied to the
startup `SIM_ROBOT_ID`. Changing the field reconnects the virtual robot under
that ID without displaying or sending the token to the browser.

To run an end-to-end software mission:

1. Start the dashboard and simulator, and use the same configured Robot ID in
   both. In the main dashboard, sign in, enter that ID in **Active Unit**, and
   claim control.
2. Click **Start demo mission** in the simulator. The simulation creates one
   fire in front of the virtual robot; its sensor values and activity appear in
   the scan monitor and telemetry.
3. Use the dashboard's **AUTOPILOT** button to run the PDF-style scan and
   approach logic, or use its manual controls to test driving and the pump.
   The simulated pump, servo, motors, and map GPS telemetry update under the
   selected Robot ID.

The control bridge translates dashboard `AUTOPILOT_ON` and `MANUAL` commands
into simulator modes, and the changed mode is confirmed through telemetry.
Do not run a physical robot and simulator with the same Robot ID; the control
server accepts only one device connection per ID. The simulator never drives
physical outputs.

Run the simulator logic tests with:

```sh
python -m unittest discover -s tests -v
```

## Try the demo

1. Use **Hold Signal Preview** to pin a virtual signal to the selected sensor
   and keep the robot parked so the scan reading stays visible. Click **Start
   demo mission** to create a built-in fire in front of the robot and resume
   autopilot, or click **Place fire** and then click in the room. The PDF
   autopilot evaluates right/front/left sensors in order, searches with
   reverse/turn or forward actions, and runs the matching virtual pump/servo
   sweep when a close-flame threshold is met. Use the **Right**, **Front**, and
   **Left** search-zone buttons to place a repeatable test fire in each
   sensor's search band.
2. The **10s auto test** starts when the simulator starts. It generates an
   immediate 2-second virtual flame pulse, then repeats every 10 seconds while
   cycling the right, front, and left sensor zones. It parks the virtual robot
   in Manual mode. Use **Stop auto test** to stop it; starting a mission,
   placing a fire, moving, or switching to Autopilot also interrupts the test.
   Safety STOP and Manual mode changes do not interrupt it. Click
   **Start 10s auto test** to resume. This validates only the software
   simulation and telemetry path, not physical sensor hardware.
3. Select **Manual** and use the D-pad or WASD/arrow keys. Directional input is
   held only while the key/button is held; **STOP** releases motion and turns
   off the simulated actuators. Manual mode is an extra UI test control, not a
   mode shown in the PDF sketch. Use the pump button to test the virtual pump.
4. Use **Clear fires** or **Reset** to restart the virtual room.
5. Read the changing sensor, pin, servo, pump, motor, and event-log displays.

All motion and actuator state is simulated in Python at 20 Hz and sent to the
browser over a local WebSocket. The virtual ADC sensors use 0–1023 readings
with a no-flame value of 1023. Autopilot cutoffs are right `<250`, front
`<350`, and left `<250`; the PDF's later search branches are right `251–700`,
front `251–800`, and left `251–700` in that priority order. Because the front
close-flame branch is checked first, its effective forward band is `350–800`.
Right/left search reverses for 100 ms and turns for 200 ms. The PDF's servo
initialization sweep, zone-specific pump sweeps, and 50 ms servo-pulse interval
are simulated.
Canvas animation is interpolated independently for smooth display. The
control-server bridge publishes synthetic GPS based on room coordinates for
map tracking. There is no physical-I/O path.

## Modules

```text
firmware/robot_brain.ino       Safe sensor-only serial monitor
simulation/hardware_pins.py    PDF pin labels, thresholds, and pulse settings
simulation/physics_env.py      Room, robot pose, fires, and virtual sensors
simulation/robot_logic.py      PDF-priority virtual autopilot and manual tests
simulation/signal_test.py      Periodic virtual flame-sensor test pulses
server/app.py                 Loopback FastAPI/WebSocket server
server/control_bridge.py      Socket.IO telemetry and command relay
server/static/index.html       Dashboard UI
server/static/style.css        Responsive dashboard styling
server/static/app.js           Canvas renderer and WebSocket client
```
