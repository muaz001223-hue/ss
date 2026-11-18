# Fire Robot Control Center

A local-first web control center for ESP32-based fire-response robots. It
provides an authenticated Socket.IO relay, a responsive operator dashboard,
live sensor/GPS telemetry, and a Cesium globe with per-robot control and
tracking.

## Requirements

- Node.js 20.11 or newer
- npm 10 or newer
- Network access to install npm dependencies and load OpenStreetMap tiles

See [DEPLOYMENT.md](./DEPLOYMENT.md) for the Vercel dashboard and persistent
Socket.IO backend setup.

## Run locally

```sh
npm install
npm run dev
```

On the first run, the server creates a private `.env` file containing
independent, random dashboard, `robot-1`, and `sim-robot-1` tokens and prints
them once. The web dashboard and simulator default to `sim-robot-1`; `robot-1`
remains available for a separately configured device. The `.env` file is
ignored by git and is not overwritten on later runs.

The dashboard connects through a same-origin WebSocket proxy, so it also works
behind forwarded development ports without exposing port 4100 to the browser.
The proxy targets `http://127.0.0.1:4100` by default. If the control server is
on another host, set `CONTROL_SERVER_PROXY_URL` in the web server environment
to its reachable URL and restart the web server.

The backend binds to `127.0.0.1` by default. To allow a physical ESP32 on the
same trusted LAN to connect, set `HOST` to the computer's LAN interface (or
`0.0.0.0`) and `CORS_ORIGIN` to the exact dashboard origin in `.env`, then
restart. Restrict network access with a firewall. Do not run a virtual demo
robot and a physical robot with the same Robot ID.

For internet-facing deployments, terminate TLS at a trusted reverse proxy,
configure strong unique tokens and allowed origins, and do not expose the
development server directly.

## Socket.IO protocol

Robots and the optional simulator bridge connect directly to
`http://<server-host>:4100` using Socket.IO and pass a Robot ID and token in
the connection auth object. The dashboard uses the same-origin proxy by
default:

```js
io(serverUrl, { auth: { token: accessToken, robotId: "robot-1" } });
```

The robot uses its device token and stable ID. IDs may contain letters,
numbers, `.`, `_`, and `-` (up to 32 characters). A legacy `DEVICE_TOKEN` in
the root `.env` is accepted for `robot-1`. For multiple robots, configure
`DEVICE_TOKENS_JSON` as a JSON object mapping every robot ID to its own token
of at least 32 characters.

- Emit `telemetry:report` with
  `{ sensors: { right, front, left }, gps: { latitude, longitude }, pump, mode }`.
  Sensor values are finite numbers from 0 through 4095; coordinates are
  decimal degrees, or both `null` when there is no GPS fix; `pump` is boolean;
  and `mode` is a non-empty string of at most 32 characters.
- Listen for `robot:command`. Payloads are `{ command, issuedAt, leaseMs? }`.
  `command` is one of `FORWARD`, `BACKWARD`, `LEFT`, `RIGHT`, `STOP`,
  `PUMP_ON`, `PUMP_OFF`, `AUTOPILOT_ON`, or `MANUAL`.

The server adds the authenticated Robot ID to each `telemetry:update` packet
and publishes the complete connected list through `robots:status`.

The dashboard uses the dashboard token:

- Listen for `telemetry:update`, `robots:status`, and `control:state`.
- Emit `control:claim` to acquire the single-operator control lease.
- Emit `control:command` with `{ robotId, command }`. Send
  `control:heartbeat` with that robot ID while a directional command is held,
  and `control:release` when finished.

The relay caches the latest valid telemetry packet in memory and sends it to a
dashboard that reconnects while the robot is still connected. The cache is
cleared when the robot disconnects or the server restarts.

The backend includes a 750 ms movement lease on directional commands and stops
movement if heartbeats lapse, the controlling dashboard disconnects, or control
is released. Dashboard heartbeats refresh the active direction command and its
lease. **The ESP32 firmware must enforce the `leaseMs` deadline locally** and
stop the motors if its command connection is lost; a web server cannot
guarantee physical fail-safe behavior on its own. Releasing control and
disconnecting also request `STOP`, `PUMP_OFF`, and `MANUAL`; the dashboard
SAFE STOP button does the same, while releasing a direction only stops the
motors. Sensor
readings are displayed as raw outputs; calibrate flame-sensor polarity and
thresholds in firmware for your hardware rather than assuming a fire-detection
threshold.

## Arduino UNO read-only telemetry

The `fire-fighting-robot-demo/firmware/robot_brain.ino` sketch supports the
UNO sensor wiring (`A0` right, `A1` front, `A2` left) and prints
`SENSORS,<right>,<front>,<left>,0,MONITOR` at 9600 baud. The motor, servo, and
pump pins remain inputs; this firmware and bridge do not control actuators or
run an autonomous mission. The server rejects control commands for robots
reporting `mode: "monitor"`.

Connect the Arduino to the local PC and run the bridge on that same PC:

```sh
SERIAL_PORT=/dev/ttyACM0 SERIAL_ROBOT_ID=robot-1 npm run bridge
```

Use the correct serial device for the host (for example, `COM3` on Windows).
The bridge gets the device token from `SERIAL_DEVICE_TOKEN`, or from the root
`.env` using `DEVICE_TOKEN` / `DEVICE_TOKENS_JSON`. It defaults to
`http://127.0.0.1:4100`; set `SERIAL_SERVER_URL` when the Socket.IO server is at
another reachable address. ADC values are scaled from 0–1023 to the server's
0–4095 range. No serial command is sent to the Arduino.

For a Vercel-hosted dashboard, configure its control-server URL to point at a
reachable Socket.IO backend and allow the dashboard origin in the backend's
`CORS_ORIGIN`. The USB bridge still runs on the PC physically connected to the
Arduino, with `SERIAL_SERVER_URL` pointing to that same reachable backend.
Deploying the frontend alone does not give it access to the PC's USB port.

## Commands

```sh
npm run dev       # Start API and dashboard
npm run bridge    # Start the read-only local Arduino USB bridge
npm run build     # Build both workspaces
npm run start     # Start both production servers after a build
npm test          # Run backend protocol tests
```

The map uses CesiumJS, Esri World Imagery, zoom-dependent Esri place-label tiles,
and ArcGIS World Elevation terrain; terrain and satellite imagery load whether
or not the robot is online and require no Cesium Ion token. For global 3D
building tiles, create a Cesium Ion access token restricted to your dashboard
domain and the OSM Buildings asset, then copy `web/.env.example` to
`web/.env.local`, set `NEXT_PUBLIC_CESIUM_ION_ACCESS_TOKEN`, and rebuild. This
token is delivered to the browser, so restrict its allowed origins and asset
access (Cesium OSM Buildings asset ID `96188`).
The camera limits zoom to 250 m above ground to avoid magnifying imagery beyond
the source's available detail; unavailable imagery tiles are discarded in favor
of the nearest available tile.
The map shows the terrain/building data status in its controls. Search results
and the live robot receive floating, zoom-scaled labels; the global reference
layer reveals place names by zoom level.
The Active Unit panel selects a robot by ID and shows the active robot count
and its reverse-geocoded place name. Follow mode smoothly tracks the selected
robot from an automatically orbiting drone perspective with the Fireline
marker. Reverse geocoding uses Photon and OpenStreetMap data.

The map opens on a detailed 3D view of Chattogram and shows the latest robot GPS
fix without moving the camera. Use the map search to find a place or enter
`latitude, longitude`, **Robot** to recenter on the latest fix, **Follow** to
opt into live camera tracking, **2D/3D** to switch between a flat map and the
globe, and **World** to reset the globe view. Rotation is off initially to keep
the map responsive; use **Spin/Pause** to start or stop it. Interacting with the
map pauses the spin. Map flights use eased camera transitions. Country names and
boundaries become more detailed as you zoom in. Place-name search uses the
Photon geocoder and OpenStreetMap data;
the query is sent to that public service only when an operator submits the
search. For production traffic, use a geocoder service or self-hosted instance
with an appropriate usage policy. Check Esri's current imagery service terms
before a public production deployment.

`AUTOPILOT_ON` and `MANUAL` are mode requests to the robot, not autonomous
algorithms running in this web app. Implement both commands in ESP32 firmware,
report the confirmed mode in telemetry, and keep the robot's local stop/lease
failsafes active in either mode.
