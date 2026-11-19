# Deployment

## Architecture

Deploy the Next.js dashboard to Vercel and run `server/src/index.ts` as a
separate, persistent Node.js service. The Socket.IO server owns in-memory
device sessions and control leases; it is not part of the Vercel frontend
build and should not be moved into a short-lived serverless function. The
dashboard and software simulator use Socket.IO polling with a WebSocket
upgrade. A dashboard-only Vercel deployment does not expose a USB serial port.

## Deploy the dashboard to Vercel

1. Import the repository in Vercel and leave the project **Root Directory**
   at the repository root. The root `vercel.json` selects Vercel's **Other**
   framework preset, builds the web workspace (including the Cesium asset copy
   step), and stages the static site in the `public` output directory. This
   avoids invoking the Next.js server adapter for a static export.
   Alternatively, set **Root Directory** to `web` and use `web/vercel.json` to
   build directly into `out`.
2. Set `NEXT_PUBLIC_CONTROL_SERVER_URL` in the Vercel project to the public
   HTTPS URL of the persistent Socket.IO backend, for example
   `https://control.example.com`. Set `NEXT_PUBLIC_CESIUM_ION_ACCESS_TOKEN`
   only if global 3D building tiles are needed.
3. Deploy from the Vercel UI, or from the repository root using the npm scripts:

   ```sh
   npm run deploy:preview
   npm run deploy:prod
   ```

   The first command creates a preview deployment; the second deploys to
   production. The Vercel CLI will prompt to link the project on first use.

`NEXT_PUBLIC_CONTROL_SERVER_URL` is public configuration, not a credential.
Do not put dashboard or device tokens in `NEXT_PUBLIC_*` variables.

## Run the control server

Host the Node server on a persistent service that supports long-lived Socket.IO
connections. Configure its environment from the root `.env.example`, replacing
all placeholder secrets with independent, randomly generated values:

- `DASHBOARD_TOKEN`: operator sign-in token.
- `DEVICE_TOKENS_JSON`: map of provisioned Robot IDs to unique device tokens.
- `CORS_ORIGIN`: exact Vercel dashboard origin(s), comma-separated.
- `HOST=0.0.0.0` and the platform-provided `PORT`.

Install dependencies and run the server from the repository root:

```sh
npm ci
npm run build -w @fire-robot/server
npm start -w @fire-robot/server
```

Enter the configured dashboard token at sign-in. A Robot ID is accepted only
when the backend has a corresponding device token; arbitrary IDs are not
automatically trusted or linked. Keep tokens out of source control and logs.

## Local Arduino telemetry bridge

On the PC or Raspberry Pi physically connected to the Arduino, install the
repository dependencies and configure `SERIAL_SERVER_URL` to the same public
Socket.IO backend. Set `SERIAL_PORT` to the board's device path and
`SERIAL_ROBOT_ID` to an ID with a configured device token, then run:

```sh
npm ci
npm run bridge
```

The bridge in this repository is deliberately **read-only**: it reports the
UNO sensor readings and ignores every `robot:command` event. The current
firmware leaves motor, servo, and pump pins as inputs; the server rejects
commands for telemetry marked `monitor`. This deployment guide does not enable
physical movement, pump control, or autonomous fire response. The separate
room simulator remains software-only and can connect with
`CONTROL_SERVER_URL`, `SIM_ROBOT_ID=sim-robot-1`, and the matching device token.

## Checks

From the repository root:

```sh
npm ci
npm test
npm run build
cd fire-fighting-robot-demo
python -m unittest discover -s tests -v
```

Passing these checks verifies software behavior and builds only; it does not
verify physical wiring, electrical safety, radio/network coverage, or robot
operation.
