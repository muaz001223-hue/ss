"use strict";

const canvas = document.getElementById("roomCanvas");
const context = canvas.getContext("2d", { alpha: false });
const elements = {
  connection: document.querySelector(".connection"),
  connectionText: document.getElementById("connectionText"),
  hint: document.getElementById("canvasHint"),
  serialLog: document.getElementById("serialLog"),
  modeStatus: document.getElementById("modeStatus"),
};

let socket;
let latest = null;
let mode = "AUTOPILOT";
let placingFire = false;
let lastLogSignature = "";
let lastLogAt = 0;
let renderedRobot = null;
let lastFrameAt = performance.now();
let robotLinkError = "";
let pendingRobotId = null;

function connect() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
  socket.addEventListener("open", () => {
    elements.connection.classList.add("connected");
    elements.connectionText.textContent = "SIM LINKED";
  });
  socket.addEventListener("close", () => {
    elements.connection.classList.remove("connected");
    elements.connectionText.textContent = "RECONNECTING";
    window.setTimeout(connect, 1000);
  });
  socket.addEventListener("error", () => socket.close());
  socket.addEventListener("message", (event) => {
    try {
      const state = JSON.parse(event.data);
      if (state.type === "state") {
        latest = state;
        mode = state.robot.mode;
        updateDashboard(state);
      } else if (state.type === "robot-link") {
        robotLinkError = "";
        pendingRobotId = state.robotId;
        const status = document.getElementById("robotLinkStatus");
        status.classList.remove("error");
        status.textContent = `Linking Robot ID ${state.robotId} to the control server…`;
      } else if (state.type === "error") {
        pendingRobotId = null;
        robotLinkError = state.message;
        const status = document.getElementById("robotLinkStatus");
        status.classList.add("error");
        status.textContent = state.message;
      } else {
        return;
      }
    } catch (error) {
      console.error("Could not read simulation update.", error);
    }
  });
}

function send(command, extra = {}) {
  if (socket?.readyState !== WebSocket.OPEN) {
    const status = document.getElementById("robotLinkStatus");
    robotLinkError = "Local simulator is disconnected; reconnect before sending commands.";
    status.textContent = robotLinkError;
    status.classList.add("error");
    return;
  }
  socket.send(JSON.stringify({ command, ...extra }));
}

function updateRobotLink(state) {
  const input = document.getElementById("robotIdInput");
  const status = document.getElementById("robotLinkStatus");
  if (pendingRobotId && state.robotId === pendingRobotId) {
    pendingRobotId = null;
  }
  if (pendingRobotId) {
    status.classList.remove("error", "connected");
    status.textContent = `Linking Robot ID ${pendingRobotId} to the control server…`;
    return;
  }
  if (document.activeElement !== input && typeof state.robotId === "string") {
    input.value = state.robotId;
  }

  const options = document.getElementById("robotIdOptions");
  const knownIds = Array.isArray(state.availableRobotIds)
    ? state.availableRobotIds.filter((robotId) => typeof robotId === "string")
    : [];
  options.replaceChildren(...knownIds.map((robotId) => {
    const option = document.createElement("option");
    option.value = robotId;
    return option;
  }));

  if (robotLinkError) {
    status.classList.remove("connected");
    status.classList.add("error");
    status.textContent = robotLinkError;
    return;
  }
  status.classList.toggle("connected", state.robotConnected === true);
  status.classList.toggle("error", Boolean(robotLinkError));
  status.textContent = state.robotConnected
    ? `Relay online · ${state.robotId}`
    : `Local simulation ready · relay offline · ${state.robotId}`;
}

function updateScanMonitor(sensors) {
  const zones = [
    { name: "RIGHT", value: sensors.right, threshold: 250 },
    { name: "FRONT", value: sensors.front, threshold: 350 },
    { name: "LEFT", value: sensors.left, threshold: 250 },
  ];
  const fire = zones.find((zone) => zone.value < zone.threshold);
  const searching = fire ? null : zones.find((zone) => (
    zone.name === "FRONT"
      ? zone.value >= zone.threshold && zone.value <= 800
      : zone.value > zone.threshold && zone.value <= 700
  ));
  const signal = fire ?? searching;
  const card = document.querySelector(".signal-card");
  document.getElementById("scanStatus").textContent = fire
    ? `FIRE SIGNAL · ${fire.name}`
    : searching ? `SCANNING · ${searching.name} SENSOR` : "SCANNING · NO FIRE SIGNAL";
  document.getElementById("scanDirection").textContent = fire
    ? "DETECTED"
    : searching ? "WEAK SIGNAL" : "CLEAR";
  document.getElementById("scanDetail").textContent = fire
    ? `${fire.name.toLowerCase()} ADC ${fire.value} crossed the PDF pump threshold (<${fire.threshold}).`
    : searching
      ? `${searching.name.toLowerCase()} ADC ${searching.value} is in its PDF search band.`
      : "All virtual sensors are above their fire/search bands. Signal updates at 20 Hz.";
  document.getElementById("scanSignalFill").style.width = `${signal
    ? Math.max(0, Math.min(100, 100 - (signal.value / 1023) * 100))
    : 0}%`;
  card.classList.toggle("alert", Boolean(fire));
  for (const zone of zones) {
    const key = zone.name[0] + zone.name.slice(1).toLowerCase();
    const element = document.getElementById(`scan${key}`);
    element.textContent = String(zone.value);
    element.parentElement.classList.toggle("active", signal?.name === zone.name);
  }
}

function updateDashboard(state) {
  const { robot, sensors, pins } = state;
  const pumpToggle = document.getElementById("pumpToggle");
  const autoSignalTestButton = document.getElementById("autoSignalTestButton");
  const autoSignalTestStatus = document.getElementById("autoSignalTestStatus");
  const signalTest = state.signalTest;
  autoSignalTestButton.setAttribute("aria-pressed", String(signalTest.enabled));
  autoSignalTestButton.textContent = signalTest.enabled
    ? "Stop auto test"
    : "Start 10s auto test";
  autoSignalTestStatus.textContent = !signalTest.enabled
    ? "Virtual-only test: 2-second pulse, cycling Right / Front / Left."
    : signalTest.pulseActive
      ? `${signalTest.zone.toUpperCase()} sensor pulse active · virtual only`
      : `Next ${signalTest.zone.toUpperCase()} pulse in ${signalTest.secondsUntilNext}s · virtual only`;
  for (const [name, value] of Object.entries(sensors)) {
    const key = name[0].toUpperCase() + name.slice(1);
    document.getElementById(`sensor${key}`).textContent = String(value);
    document.getElementById(`meter${key}`).style.width = `${100 - (value / 1023) * 100}%`;
  }
  updateRobotLink(state);
  updateScanMonitor(sensors);

  for (const key of ["enA", "enB", "in1", "in2", "in3", "in4"]) {
    document.getElementById(`pin${key[0].toUpperCase()}${key.slice(1)}`).textContent = String(pins[key]);
  }
  document.getElementById("pinServo").textContent = `${pins.servo}°`;
  document.getElementById("pinPump").textContent = pins.pump ? "HIGH" : "LOW";
  document.getElementById("servoStatus").textContent = `${robot.servo}°`;
  document.getElementById("pumpStatus").textContent = robot.pump ? "ON" : "OFF";
  document.getElementById("motorStatus").textContent = robot.drive;
  pumpToggle.disabled = mode !== "MANUAL";
  pumpToggle.classList.toggle("active", robot.pump);
  pumpToggle.setAttribute("aria-pressed", String(robot.pump));
  pumpToggle.textContent = robot.pump ? "Turn simulated pump off" : "Turn simulated pump on";
  document.querySelector(".actuator:nth-child(1)").classList.toggle("active", robot.pump);
  document.querySelector(".actuator:nth-child(2)").classList.toggle("active", robot.servo !== 90);
  document.querySelector(".actuator:nth-child(3)").classList.toggle("active", robot.motorSpeed > 0);

  document.getElementById("manualMode").classList.toggle("active", mode === "MANUAL");
  document.getElementById("autoMode").classList.toggle("active", mode === "AUTOPILOT");
  document.querySelectorAll("[data-zone-test]").forEach((button) => {
    button.disabled = mode !== "AUTOPILOT";
  });
  document.querySelectorAll("[data-drive]").forEach((button) => {
    button.disabled = mode !== "MANUAL";
    button.classList.toggle("pressed", robot.drive === button.dataset.drive);
  });
  elements.modeStatus.textContent = mode === "MANUAL"
    ? `Manual control · ${robot.drive}`
    : robot.pump ? `Extinguishing simulated fire · servo ${robot.servo}°`
      : robot.drive !== "STOP" ? `PDF autopilot · ${robot.drive}`
        : state.fires.some((fire) => fire.active) ? "Autopilot scanning sensor zones"
        : "Autopilot waiting · place a fire";
  elements.hint.classList.toggle("hidden", state.fires.length > 0);
  updateLog(state);
}

function updateLog(state) {
  const { robot, sensors, pins } = state;
  const signature = [
    robot.mode,
    robot.drive,
    robot.pump,
    Math.floor(robot.servo / 15),
    Math.floor(sensors.right / 50),
    Math.floor(sensors.front / 50),
    Math.floor(sensors.left / 50),
    state.fires.filter((fire) => fire.active).length,
  ].join(":");
  const now = Date.now();
  if (signature === lastLogSignature && now - lastLogAt < 2000) return;
  lastLogSignature = signature;
  lastLogAt = now;
  const line = document.createElement("div");
  line.className = "log-line";
  const time = document.createElement("time");
  time.textContent = new Date(now).toLocaleTimeString([], { hour12: false });
  const text = document.createElement("span");
  const reading = `${sensors.right}\t${sensors.front}\t${sensors.left}`;
  if (robot.pump) {
    text.className = "log-fire";
    text.textContent = `PUMP ON · SERVO ${pins.servo}° · ADC ${reading}`;
  } else if (robot.drive !== "STOP") {
    text.textContent = `${robot.mode} · ${robot.drive} · PWM ${pins.enA} · ADC ${reading}`;
  } else {
    text.className = "log-ok";
    text.textContent = `${robot.mode} · MOTORS STOP · ADC ${reading}`;
  }
  line.append(time, text);
  elements.serialLog.prepend(line);
  while (elements.serialLog.children.length > 8) elements.serialLog.lastElementChild.remove();
}

function resizeCanvas() {
  const bounds = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  canvas.width = Math.round(bounds.width * dpr);
  canvas.height = Math.round(bounds.height * dpr);
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawGrid(width, height) {
  const step = 40;
  context.fillStyle = "#0c151c";
  context.fillRect(0, 0, width, height);
  context.lineWidth = 1;
  context.strokeStyle = "#172631";
  context.beginPath();
  for (let x = 0.5; x < width; x += step) {
    context.moveTo(x, 0);
    context.lineTo(x, height);
  }
  for (let y = 0.5; y < height; y += step) {
    context.moveTo(0, y);
    context.lineTo(width, y);
  }
  context.stroke();
  context.strokeStyle = "#385064";
  context.strokeRect(0.5, 0.5, width - 1, height - 1);
}

function drawFire(fire, scaleX, scaleY, now) {
  const x = fire.x * scaleX;
  const y = fire.y * scaleY;
  const pulse = 1 + Math.sin(now / 170 + fire.id) * 0.08;
  const radius = 14 * pulse;
  context.save();
  context.translate(x, y);
  context.globalAlpha = 0.25;
  context.fillStyle = "#ff5638";
  context.beginPath();
  context.arc(0, 0, radius * 2.2, 0, Math.PI * 2);
  context.fill();
  context.globalAlpha = 1;
  context.fillStyle = "#ff784f";
  context.beginPath();
  context.moveTo(0, -radius);
  context.bezierCurveTo(radius * 1.2, -radius * 0.2, radius * 0.65, radius, 0, radius);
  context.bezierCurveTo(-radius * 0.9, radius * 0.5, -radius * 0.7, -radius * 0.2, 0, -radius);
  context.fill();
  context.fillStyle = "#ffd278";
  context.beginPath();
  context.ellipse(0, radius * 0.33, radius * 0.32, radius * 0.5, 0, 0, Math.PI * 2);
  context.fill();
  if (fire.progress > 0) {
    context.strokeStyle = "#ffbd69";
    context.lineWidth = 3;
    context.beginPath();
    context.arc(0, 0, 23, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(fire.progress / 4, 1));
    context.stroke();
  }
  context.restore();
}

function drawRobot(robot, scaleX, scaleY, now) {
  const target = { x: robot.x * scaleX, y: robot.y * scaleY, heading: robot.heading };
  if (!renderedRobot) renderedRobot = target;
  const blend = 1 - Math.exp(-Math.min((now - lastFrameAt) / 1000, 0.05) * 14);
  renderedRobot.x += (target.x - renderedRobot.x) * blend;
  renderedRobot.y += (target.y - renderedRobot.y) * blend;
  let turn = target.heading - renderedRobot.heading;
  turn = (turn + Math.PI) % (Math.PI * 2) - Math.PI;
  renderedRobot.heading += turn * blend;

  const moving = robot.motorSpeed > 0;
  const x = renderedRobot.x;
  const y = renderedRobot.y;
  const scale = Math.min(scaleX, scaleY);
  context.save();
  context.translate(x, y);
  context.rotate(renderedRobot.heading);
  if (moving) {
    context.fillStyle = "#42bad55c";
    for (const side of [-1, 1]) {
      context.beginPath();
      context.ellipse(side * 13 * scale, 25 * scale, 4 * scale, 8 * scale, 0, 0, Math.PI * 2);
      context.fill();
    }
  }
  context.shadowColor = "#33c1e666";
  context.shadowBlur = 17;
  context.fillStyle = "#244859";
  context.strokeStyle = "#92e3f3";
  context.lineWidth = 2;
  context.beginPath();
  context.roundRect(-17 * scale, -21 * scale, 34 * scale, 43 * scale, 9 * scale);
  context.fill();
  context.stroke();
  context.shadowBlur = 0;
  context.fillStyle = "#54c2dc";
  context.beginPath();
  context.moveTo(0, -29 * scale);
  context.lineTo(8 * scale, -15 * scale);
  context.lineTo(-8 * scale, -15 * scale);
  context.closePath();
  context.fill();
  context.fillStyle = robot.pump ? "#ffbd69" : "#b6f3ff";
  context.beginPath();
  context.arc(0, -4 * scale, 4 * scale, 0, Math.PI * 2);
  context.fill();
  context.restore();

  context.font = "600 10px 'DM Sans', sans-serif";
  context.textAlign = "center";
  context.fillStyle = "#e2f5fa";
  context.shadowColor = "#071016";
  context.shadowBlur = 4;
  context.fillText("ROBOT", x, y + 34 * scale);
  context.shadowBlur = 0;
}

function draw(now) {
  const bounds = canvas.getBoundingClientRect();
  const width = bounds.width;
  const height = bounds.height;
  drawGrid(width, height);
  if (latest) {
    const scaleX = width / latest.room.width;
    const scaleY = height / latest.room.height;
    for (const fire of latest.fires) if (fire.active) drawFire(fire, scaleX, scaleY, now);
    drawRobot(latest.robot, scaleX, scaleY, now);
  }
  lastFrameAt = now;
  requestAnimationFrame(draw);
}

function canvasPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) / rect.width * (latest?.room.width ?? 1200),
    y: (event.clientY - rect.top) / rect.height * (latest?.room.height ?? 760),
  };
}

document.getElementById("spawnButton").addEventListener("click", () => {
  placingFire = true;
  elements.hint.textContent = "＋ Click in the room to place a simulated fire";
  elements.hint.classList.remove("hidden");
});
document.getElementById("startMissionButton").addEventListener("click", () => {
  placingFire = false;
  send("START_MISSION");
});
for (const button of document.querySelectorAll("[data-signal-demo]")) {
  button.addEventListener("click", () => {
    placingFire = false;
    send("START_SIGNAL_DEMO", { zone: button.dataset.signalDemo });
  });
}
document.getElementById("autoSignalTestButton").addEventListener("click", () => {
  placingFire = false;
  send(latest?.signalTest?.enabled ? "STOP_AUTO_SIGNAL_TEST" : "START_AUTO_SIGNAL_TEST");
});
document.getElementById("robotLinkForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = document.getElementById("robotIdInput");
  const status = document.getElementById("robotLinkStatus");
  const robotId = input.value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(robotId)) {
    robotLinkError = "Use 1–32 letters, numbers, '.', '_' or '-'; start with a letter or number.";
    status.classList.add("error");
    status.textContent = robotLinkError;
    return;
  }
  robotLinkError = "";
  pendingRobotId = robotId;
  status.classList.remove("error");
  status.textContent = `Checking configured device token for ${robotId}…`;
  send("SET_ROBOT_ID", { robotId });
});
canvas.addEventListener("click", (event) => {
  const point = canvasPoint(event);
  if (placingFire) {
    send("ADD_FIRE", point);
    placingFire = false;
  } else if (event.detail === 2) {
    send("ADD_FIRE", point);
  }
});
document.getElementById("clearButton").addEventListener("click", () => send("CLEAR_FIRES"));
document.getElementById("resetButton").addEventListener("click", () => send("RESET"));
document.getElementById("manualMode").addEventListener("click", () => send("SET_MODE", { mode: "MANUAL" }));
document.getElementById("autoMode").addEventListener("click", () => send("SET_MODE", { mode: "AUTOPILOT" }));
document.getElementById("stopButton").addEventListener("click", () => send("STOP"));
document.getElementById("pumpToggle").addEventListener("click", () => {
  send(latest?.robot.pump ? "PUMP_OFF" : "PUMP_ON");
});

const sensorOffsets = { right: Math.PI / 2, front: 0, left: -Math.PI / 2 };
for (const button of document.querySelectorAll("[data-zone-test]")) {
  button.addEventListener("click", () => {
    if (!latest || mode !== "AUTOPILOT") return;
    const angle = latest.robot.heading + sensorOffsets[button.dataset.zoneTest];
    send("CLEAR_FIRES");
    send("ADD_FIRE", {
      x: latest.robot.x + Math.sin(angle) * 140,
      y: latest.robot.y - Math.cos(angle) * 140,
    });
  });
}

for (const button of document.querySelectorAll("[data-drive]")) {
  const start = (event) => {
    event.preventDefault();
    if (mode !== "MANUAL") return;
    button.setPointerCapture?.(event.pointerId);
    send(button.dataset.drive);
  };
  const stop = () => {
    if (mode === "MANUAL") send("STOP");
  };
  button.addEventListener("pointerdown", start);
  button.addEventListener("pointerup", stop);
  button.addEventListener("pointercancel", stop);
  button.addEventListener("lostpointercapture", stop);
}

window.addEventListener("keydown", (event) => {
  if (mode !== "MANUAL" || event.repeat || event.target instanceof HTMLInputElement) return;
  const keys = { ArrowUp: "FORWARD", w: "FORWARD", ArrowDown: "BACKWARD", s: "BACKWARD", ArrowLeft: "LEFT", a: "LEFT", ArrowRight: "RIGHT", d: "RIGHT" };
  const command = keys[event.key] ?? keys[event.key.toLowerCase()];
  if (command) {
    event.preventDefault();
    send(command);
  }
});
window.addEventListener("keyup", (event) => {
  const keys = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "w", "a", "s", "d"];
  if (mode === "MANUAL" && keys.includes(event.key)) send("STOP");
});
window.addEventListener("blur", () => send("STOP"));

new ResizeObserver(resizeCanvas).observe(canvas);
resizeCanvas();
connect();
requestAnimationFrame(draw);
