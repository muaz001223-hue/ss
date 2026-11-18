"use client";

import dynamic from "next/dynamic";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Activity,
  ChevronLeft,
  ChevronRight,
  Crosshair,
  Flame,
  LockKeyhole,
  LogOut,
  MapPin,
  Moon,
  Radio,
  ShieldAlert,
  Signal,
  Sun,
  Volume2,
  VolumeX,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import {
  type FormEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { io, type Socket } from "socket.io-client";
import type {
  ControlCommand,
  RobotStatus,
  TelemetryUpdate,
} from "@/lib/protocol";

const CesiumMap = dynamic(() => import("@/components/cesium-map"), {
  ssr: false,
  loading: () => <div className="map-loading">Preparing 3D globe…</div>,
});

const TELEMETRY_STALE_MS = 5000;
const TELEMETRY_UI_UPDATE_INTERVAL_MS = 100;
const MAX_EVENT_ENTRIES = 12;
const MAX_SIGNAL_HISTORY_ENTRIES = 50;
const DEFAULT_ROBOT_ID = "sim-robot-1";
const SELECTED_ROBOT_ID_STORAGE_KEY = "fireline-selected-robot-id-v2";
const THEME_STORAGE_KEY = "fireline-dashboard-theme";
const THEME_PREFERENCE_KEY = "fireline-dashboard-theme-user-selected";

type MovementCommand = "FORWARD" | "BACKWARD" | "LEFT" | "RIGHT";
type RobotMode = "manual" | "autopilot" | "unknown";
type RequestedMode = "manual" | "autopilot";
type DashboardTheme = "dark" | "light";
type EventKind = "system" | "telemetry" | "control" | "alert";
type DashboardEvent = {
  id: number;
  time: string;
  message: string;
  kind: EventKind;
};
type SignalHistoryEntry = {
  id: number;
  robotId: string;
  time: string;
  direction: string;
  strength: number;
  sensorValue: number;
};

function formatCoordinate(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : value.toFixed(6);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function getFireSignalStatus(telemetry: TelemetryUpdate | null) {
  if (!telemetry) {
    return {
      direction: "NO DATA",
      strength: 0,
      level: "WAITING",
      detected: false,
      sensors: { left: 0, front: 0, right: 0 },
    };
  }

  const readings = [
    ["LEFT", telemetry.sensors.left],
    ["FRONT", telemetry.sensors.front],
    ["RIGHT", telemetry.sensors.right],
  ] as const;
  const [direction, strongest] = readings.reduce((strongestReading, reading) =>
    reading[1] < strongestReading[1] ? reading : strongestReading,
  );
  const strength = Math.max(0, Math.min(100, ((4095 - strongest) / 4095) * 100));
  const detected = strength >= 25;

  return {
    direction: detected ? direction : "CLEAR",
    strength,
    level: strength < 25 ? "WEAK" : strength >= 70 ? "HIGH" : "MEDIUM",
    detected,
    sensors: {
      left: Math.max(0, Math.min(100, ((4095 - telemetry.sensors.left) / 4095) * 100)),
      front: Math.max(0, Math.min(100, ((4095 - telemetry.sensors.front) / 4095) * 100)),
      right: Math.max(0, Math.min(100, ((4095 - telemetry.sensors.right) / 4095) * 100)),
    },
  };
}

function playFireSignalTone(context: AudioContext): void {
  const tones = [
    { frequency: 880, offset: 0 },
    { frequency: 1174, offset: 0.16 },
  ];
  for (const tone of tones) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const startAt = context.currentTime + tone.offset;
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(tone.frequency, startAt);
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(0.12, startAt + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.14);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(startAt);
    oscillator.stop(startAt + 0.15);
  }
}

function getRobotMode(mode: string | undefined): RobotMode {
  const normalized = mode?.toLowerCase().replace(/[\s_-]/g, "") ?? "";
  if (["auto", "autopilot", "autonomous", "automatic"].some((value) => normalized.startsWith(value))) {
    return "autopilot";
  }
  if (normalized.startsWith("manual")) return "manual";
  return "unknown";
}

function getControlServerConfig(): { url: string; path: string } {
  const configuredUrl = process.env.NEXT_PUBLIC_CONTROL_SERVER_URL?.trim();
  return configuredUrl
    ? { url: configuredUrl, path: "/socket.io" }
    : { url: window.location.origin, path: "/control-socket.io/relay" };
}

export default function Home() {
  const [token, setToken] = useState("");
  const [storedToken, setStoredToken] = useState<string | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [robotStatuses, setRobotStatuses] = useState<RobotStatus[]>([]);
  const [telemetryByRobot, setTelemetryByRobot] = useState<
    Record<string, TelemetryUpdate>
  >({});
  const [selectedRobotId, setSelectedRobotId] = useState(DEFAULT_ROBOT_ID);
  const [robotIdInput, setRobotIdInput] = useState(DEFAULT_ROBOT_ID);
  const [robotIdMasked, setRobotIdMasked] = useState(false);
  const [savedRobotIds, setSavedRobotIds] = useState<string[]>([]);
  const [robotIdsLoaded, setRobotIdsLoaded] = useState(false);
  const [locationName, setLocationName] = useState("Waiting for GPS location");
  const [hasControl, setHasControl] = useState(false);
  const [controlOccupied, setControlOccupied] = useState(false);
  const [message, setMessage] = useState("");
  const [now, setNow] = useState(Date.now());
  const [modeRequest, setModeRequest] = useState<RequestedMode | null>(null);
  const [leftSidebarCollapsed, setLeftSidebarCollapsed] = useState(false);
  const [rightSidebarCollapsed, setRightSidebarCollapsed] = useState(false);
  const [theme, setTheme] = useState<DashboardTheme>("light");
  const [themeLoaded, setThemeLoaded] = useState(false);
  const [mapControlsVisible, setMapControlsVisible] = useState(true);
  const [events, setEvents] = useState<DashboardEvent[]>([]);
  const [signalHistory, setSignalHistory] = useState<SignalHistoryEntry[]>([]);
  const [fireSignalSoundEnabled, setFireSignalSoundEnabled] = useState(true);
  const eventSequenceRef = useRef(0);
  const signalHistorySequenceRef = useRef(0);
  const fireSignalSoundEnabledRef = useRef(true);
  fireSignalSoundEnabledRef.current = fireSignalSoundEnabled;
  const audioContextRef = useRef<AudioContext | null>(null);
  const previousTelemetryRef = useRef(new Map<string, TelemetryUpdate>());
  const lastTelemetryUiUpdateAtRef = useRef(new Map<string, number>());
  const previousRobotConnectedRef = useRef(new Map<string, boolean>());
  const previousFireDetectedRef = useRef(new Map<string, boolean>());
  const [fireSignalCount, setFireSignalCount] = useState(0);
  const fireSignalLatchRef = useRef(false);
  const activeMovement = useRef<MovementCommand | null>(null);
  const activeMovementRobotId = useRef<string | null>(null);
  const movementHeartbeat = useRef<number | null>(null);
  const modeRequestTimeout = useRef<number | null>(null);
  const telemetry = telemetryByRobot[selectedRobotId] ?? null;
  const selectedTelemetryRef = useRef<TelemetryUpdate | null>(telemetry);
  selectedTelemetryRef.current = telemetry;
  const selectedRobotStatus = robotStatuses.find(
    (status) => status.robotId === selectedRobotId,
  );
  const activeRobotCount = robotStatuses.filter((status) => status.connected).length;
  const telemetryFresh =
    !!telemetry && now - telemetry.receivedAt <= TELEMETRY_STALE_MS;
  const robotOnline = !!selectedRobotStatus?.connected && telemetryFresh;
  const robotMode = getRobotMode(telemetry?.mode);
  const fireSignal = getFireSignalStatus(telemetryFresh ? telemetry : null);
  const selectedSignalHistory = signalHistory.filter(
    (entry) => entry.robotId === selectedRobotId,
  );
  const gpsAvailable =
    telemetry?.gps.latitude !== null &&
    telemetry?.gps.latitude !== undefined &&
    telemetry?.gps.longitude !== null &&
    telemetry?.gps.longitude !== undefined;
  const sweepDuration = fireSignal.detected
    ? Math.max(1.2, 3.6 - (fireSignal.strength / 100) * 2)
    : 4.8;
  const radarStyle = {
    "--sweep-duration": `${sweepDuration}s`,
    "--radar-glow": fireSignal.detected
      ? "rgba(239, 134, 82, .24)"
      : "rgba(91, 171, 128, .10)",
  } as CSSProperties;
  const lastSeen =
    !telemetry
      ? "No telemetry received"
      : `${Math.max(0, Math.floor((now - telemetry.receivedAt) / 1000))}s ago`;

  const addEvent = useCallback((message: string, kind: EventKind) => {
    const time = new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const id = ++eventSequenceRef.current;
    setEvents((current) =>
      [{ id, time, message, kind }, ...current].slice(0, MAX_EVENT_ENTRIES),
    );
  }, []);

  const getAudioContext = useCallback(() => {
    if (typeof window.AudioContext !== "function") {
      console.error("Web Audio API is unavailable; fire signal sound cannot play.");
      return null;
    }
    if (!audioContextRef.current || audioContextRef.current.state === "closed") {
      audioContextRef.current = new window.AudioContext();
    }
    return audioContextRef.current;
  }, []);

  const resumeFireSignalAudio = useCallback(() => {
    if (!fireSignalSoundEnabledRef.current) return;
    try {
      const context = getAudioContext();
      if (context && context.state !== "running") {
        void context.resume().catch((error: unknown) => {
          console.error("Unable to enable fire signal notification audio.", error);
        });
      }
    } catch (error: unknown) {
      console.error("Unable to enable fire signal notification audio.", error);
    }
  }, [getAudioContext]);

  const playFireSignalSound = useCallback(() => {
    if (!fireSignalSoundEnabledRef.current) return;
    try {
      const context = getAudioContext();
      if (!context) return;
      if (context.state === "running") {
        playFireSignalTone(context);
      } else {
        void context.resume()
          .then(() => playFireSignalTone(context))
          .catch((error: unknown) => {
            console.error("Unable to play fire signal notification audio.", error);
          });
      }
    } catch (error: unknown) {
      console.error("Unable to play fire signal notification audio.", error);
    }
  }, [getAudioContext]);

  useEffect(() => {
    setStoredToken(window.sessionStorage.getItem("fireline-dashboard-token"));
    const savedRobotIds = (window.localStorage.getItem("fireline-robot-ids") ?? "")
      .split(",")
      .filter((robotId) => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,31}$/.test(robotId));
    setSavedRobotIds(savedRobotIds);
    setRobotIdsLoaded(true);
    const savedRobotId = window.localStorage.getItem(SELECTED_ROBOT_ID_STORAGE_KEY);
    if (savedRobotId && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,31}$/.test(savedRobotId)) {
      setSelectedRobotId(savedRobotId);
      setRobotIdInput(savedRobotId);
      setRobotIdMasked(true);
      setSavedRobotIds((current) =>
        current.includes(savedRobotId) ? current : [...current, savedRobotId],
      );
    }
  }, []);

  useEffect(() => {
    if (robotIdsLoaded) {
      window.localStorage.setItem("fireline-robot-ids", savedRobotIds.join(","));
    }
  }, [robotIdsLoaded, savedRobotIds]);

  useEffect(() => {
    window.localStorage.setItem(SELECTED_ROBOT_ID_STORAGE_KEY, selectedRobotId);
  }, [selectedRobotId]);

  useEffect(() => {
    const savedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
    const hasThemePreference =
      window.localStorage.getItem(THEME_PREFERENCE_KEY) === "true";
    if (
      hasThemePreference &&
      (savedTheme === "light" || savedTheme === "dark")
    ) {
      setTheme(savedTheme);
    }
    setThemeLoaded(true);
  }, []);

  useEffect(() => {
    if (themeLoaded) {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    }
  }, [theme, themeLoaded]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let active = true;
    let busy = false;
    let lastLookup: { latitude: number; longitude: number } | null = null;
    let controller: AbortController | null = null;

    const reverseGeocode = async () => {
      const current = selectedTelemetryRef.current;
      const latitude = current?.gps.latitude;
      const longitude = current?.gps.longitude;
      if (typeof latitude !== "number" || typeof longitude !== "number") {
        setLocationName("Waiting for GPS location");
        return;
      }

      const distanceFromLastLookup = lastLookup
        ? Math.hypot(
            (latitude - lastLookup.latitude) * 111_320,
            (longitude - lastLookup.longitude) *
              111_320 *
              Math.cos((latitude * Math.PI) / 180),
          )
        : Number.POSITIVE_INFINITY;
      if (busy || distanceFromLastLookup < 250) return;

      busy = true;
      lastLookup = { latitude, longitude };
      controller = new AbortController();
      const timeout = window.setTimeout(() => controller?.abort(), 7000);
      try {
        const response = await fetch(
          `https://photon.komoot.io/reverse?lon=${longitude}&lat=${latitude}&limit=1`,
          {
            headers: { Accept: "application/json" },
            signal: controller.signal,
          },
        );
        if (!response.ok) throw new Error(`Reverse geocoding returned HTTP ${response.status}.`);

        const payload = asRecord(await response.json());
        const features = payload?.features;
        const firstFeature = Array.isArray(features) ? asRecord(features[0]) : null;
        const properties = asRecord(firstFeature?.properties);
        const labelParts = [
          properties?.name,
          properties?.locality,
          properties?.city,
          properties?.state,
          properties?.country,
        ].filter((part): part is string => typeof part === "string" && part.length > 0);
        if (active) {
          setLocationName([...new Set(labelParts)].join(", ") || "Location name unavailable");
        }
      } catch (error: unknown) {
        if (active && !(error instanceof DOMException && error.name === "AbortError")) {
          console.error("Unable to resolve the selected robot location.", error);
          setLocationName("Location lookup unavailable");
        }
      } finally {
        window.clearTimeout(timeout);
        busy = false;
      }
    };

    setLocationName("Resolving robot location…");
    void reverseGeocode();
    const interval = window.setInterval(() => void reverseGeocode(), 5000);
    return () => {
      active = false;
      window.clearInterval(interval);
      controller?.abort();
    };
  }, [selectedRobotId]);

  useEffect(() => {
    if (!telemetryFresh || !fireSignal.detected) {
      fireSignalLatchRef.current = false;
      return;
    }
    if (!fireSignalLatchRef.current) {
      fireSignalLatchRef.current = true;
      setFireSignalCount((current) => current + 1);
    }
  }, [fireSignal.detected, telemetry?.receivedAt, telemetryFresh]);

  useEffect(() => {
    if (modeRequest && robotMode === modeRequest) {
      setModeRequest(null);
      setMessage("");
      if (modeRequestTimeout.current !== null) {
        window.clearTimeout(modeRequestTimeout.current);
        modeRequestTimeout.current = null;
      }
    }
  }, [modeRequest, robotMode]);

  const stopMovement = useCallback((sendStop = true) => {
    if (movementHeartbeat.current !== null) {
      window.clearInterval(movementHeartbeat.current);
      movementHeartbeat.current = null;
    }
    const robotId = activeMovementRobotId.current;
    if (activeMovement.current && robotId) {
      activeMovement.current = null;
      activeMovementRobotId.current = null;
      if (sendStop) {
        socketRef.current?.emit("control:command", { robotId, command: "STOP" });
        addEvent(`Command sent: STOP · ${robotId}`, "control");
      }
    }
  }, [addEvent]);

  useEffect(() => {
    if (!storedToken) return;

    const { url: serverUrl, path } = getControlServerConfig();
    const connection = io(serverUrl, {
      auth: { token: storedToken },
      path,
      addTrailingSlash: false,
      transports: ["polling", "websocket"],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5000,
      randomizationFactor: 0.5,
      timeout: 5000,
    });
    socketRef.current = connection;
    setSocket(connection);
    const onReconnectAttempt = (attempt: number) => {
      setMessage(`Reconnecting to control server (attempt ${attempt})…`);
    };
    const onReconnect = () => setMessage("");
    connection.io.on("reconnect_attempt", onReconnectAttempt);
    connection.io.on("reconnect", onReconnect);

    connection.on("connect", () => {
      setConnected(true);
      setMessage("");
      addEvent("Control server connected", "system");
      connection.emit("control:claim");
    });
    connection.on("disconnect", (reason) => {
      setConnected(false);
      setHasControl(false);
      if (reason !== "io client disconnect") {
        addEvent(`Control server disconnected (${reason})`, "alert");
      }
      setRobotStatuses([]);
      setTelemetryByRobot({});
      setModeRequest(null);
      if (modeRequestTimeout.current !== null) {
        window.clearTimeout(modeRequestTimeout.current);
        modeRequestTimeout.current = null;
      }
      stopMovement(false);
      if (reason === "io server disconnect") connection.connect();
      if (reason !== "io client disconnect") {
        setMessage("Control-server connection lost. The dashboard will reconnect automatically.");
      }
    });
    connection.on("connect_error", (error: Error) => {
      setConnected(false);
      setHasControl(false);
      addEvent("Control server connection failed", "alert");
      setModeRequest(null);
      if (modeRequestTimeout.current !== null) {
        window.clearTimeout(modeRequestTimeout.current);
        modeRequestTimeout.current = null;
      }
      if (error.message.toLowerCase().includes("authentication failed")) {
        connection.io.opts.reconnection = false;
        setMessage("Dashboard token rejected. Sign out and sign in with the current dashboard token.");
      } else {
        setMessage(
          `Cannot connect to ${serverUrl}. Check that the server is running, its HOST/CORS settings allow this dashboard, and the URL is reachable.`,
        );
      }
    });
    connection.on("control:granted", () => {
      setHasControl(true);
      setMessage("");
      addEvent("Operator control granted", "system");
    });
    connection.on("control:revoked", () => {
      setHasControl(false);
      addEvent("Operator control released", "alert");
      stopMovement(false);
    });
    connection.on("control:state", (state: { occupied: boolean }) =>
      setControlOccupied(state.occupied),
    );
    connection.on("control:error", (error: { message: string }) => {
      setMessage(error.message);
      addEvent(`Control error: ${error.message}`, "alert");
    });
    connection.on("control:notice", (notice: { message: string }) => {
      setMessage(notice.message);
      addEvent(notice.message, "system");
    });
    connection.on("robots:status", (statuses: RobotStatus[]) => {
      const currentConnections = new Map(
        statuses.map((status) => [status.robotId, status.connected]),
      );
      for (const status of statuses) {
        const previousConnected = previousRobotConnectedRef.current.get(status.robotId);
        if (previousConnected !== status.connected) {
          addEvent(
            `${status.robotId} ${status.connected ? "connected" : "disconnected"}`,
            status.connected ? "system" : "alert",
          );
        }
      }
      for (const [robotId, wasConnected] of previousRobotConnectedRef.current) {
        if (wasConnected && !currentConnections.has(robotId)) {
          addEvent(`${robotId} disconnected`, "alert");
        }
      }
      previousRobotConnectedRef.current = currentConnections;
      setRobotStatuses(statuses);
      setTelemetryByRobot((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([robotId]) =>
            currentConnections.has(robotId),
          ),
        ),
      );
    });
    connection.on("telemetry:update", (update: TelemetryUpdate) => {
      const previous = previousTelemetryRef.current.get(update.robotId);
      const previousDetected =
        previousFireDetectedRef.current.get(update.robotId) ?? false;
      const detected = Math.min(
        update.sensors.left,
        update.sensors.front,
        update.sensors.right,
      ) <= 3071;
      const hasGpsFix =
        update.gps.latitude !== null &&
        update.gps.longitude !== null;
      if (!previous) {
        addEvent(`${update.robotId} telemetry stream started`, "telemetry");
        if (update.pump) addEvent("Water pump turned on", "telemetry");
        if (update.mode) addEvent(`Robot mode: ${update.mode}`, "telemetry");
        if (detected) addEvent("Flame signal detected", "alert");
        if (hasGpsFix) addEvent("GPS fix acquired", "telemetry");
      } else {
        if (previous.pump !== update.pump) {
          addEvent(`Water pump ${update.pump ? "turned on" : "turned off"}`, "telemetry");
        }
        if (previous.mode !== update.mode) {
          addEvent(`Robot mode changed to ${update.mode}`, "telemetry");
        }
        if (detected !== previousDetected) {
          addEvent(
            detected ? "Flame signal detected" : "Flame signal cleared",
            detected ? "alert" : "telemetry",
          );
        }
        const hadGpsFix =
          previous.gps.latitude !== null &&
          previous.gps.longitude !== null;
        if (hasGpsFix !== hadGpsFix) {
          addEvent(hasGpsFix ? "GPS fix acquired" : "GPS fix lost", "telemetry");
        }
      }
      if (detected && !previousDetected) {
        playFireSignalSound();
        const signal = getFireSignalStatus(update);
        const sensorValue = Math.min(
          update.sensors.left,
          update.sensors.front,
          update.sensors.right,
        );
        const historyEntry: SignalHistoryEntry = {
          id: ++signalHistorySequenceRef.current,
          robotId: update.robotId,
          time: new Date(update.receivedAt).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          }),
          direction: signal.direction,
          strength: Math.round(signal.strength),
          sensorValue,
        };
        setSignalHistory((current) =>
          [historyEntry, ...current].slice(0, MAX_SIGNAL_HISTORY_ENTRIES),
        );
      }
      previousFireDetectedRef.current.set(update.robotId, detected);
      previousTelemetryRef.current.set(update.robotId, update);
      const lastUiUpdateAt =
        lastTelemetryUiUpdateAtRef.current.get(update.robotId) ?? 0;
      if (
        update.receivedAt - lastUiUpdateAt >=
        TELEMETRY_UI_UPDATE_INTERVAL_MS
      ) {
        lastTelemetryUiUpdateAtRef.current.set(update.robotId, update.receivedAt);
        setTelemetryByRobot((current) => ({
          ...current,
          [update.robotId]: update,
        }));
      }
    });
    connection.on("telemetry:error", (error: { message: string }) => {
      setMessage(error.message);
      addEvent(`Telemetry error: ${error.message}`, "alert");
    });

    return () => {
      stopMovement(false);
      if (modeRequestTimeout.current !== null) {
        window.clearTimeout(modeRequestTimeout.current);
        modeRequestTimeout.current = null;
      }
      socketRef.current = null;
      connection.io.off("reconnect_attempt", onReconnectAttempt);
      connection.io.off("reconnect", onReconnect);
      connection.disconnect();
    };
  }, [addEvent, playFireSignalSound, storedToken, stopMovement]);

  useEffect(() => {
    window.addEventListener("pointerdown", resumeFireSignalAudio, { once: true });
    window.addEventListener("keydown", resumeFireSignalAudio, { once: true });
    return () => {
      window.removeEventListener("pointerdown", resumeFireSignalAudio);
      window.removeEventListener("keydown", resumeFireSignalAudio);
    };
  }, [resumeFireSignalAudio]);

  useEffect(() => {
    const releaseOnBlur = () => stopMovement();
    window.addEventListener("blur", releaseOnBlur);
    return () => window.removeEventListener("blur", releaseOnBlur);
  }, [stopMovement]);

  const signIn = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleanToken = token.trim();
    if (cleanToken.length < 32) {
      setMessage("Enter the dashboard token printed by the server.");
      return;
    }
    window.sessionStorage.setItem("fireline-dashboard-token", cleanToken);
    setStoredToken(cleanToken);
    setMessage("");
  };

  const signOut = () => {
    stopMovement();
    socket?.emit("control:release");
    socket?.disconnect();
    if (modeRequestTimeout.current !== null) {
      window.clearTimeout(modeRequestTimeout.current);
      modeRequestTimeout.current = null;
    }
    socketRef.current = null;
    window.sessionStorage.removeItem("fireline-dashboard-token");
    setStoredToken(null);
    setSocket(null);
    setHasControl(false);
    setConnected(false);
    setTelemetryByRobot({});
    setRobotStatuses([]);
    setEvents([]);
  };

  const selectRobot = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const robotId = robotIdInput.trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,31}$/.test(robotId)) {
      setMessage("Robot ID must start with a letter or number and contain only letters, numbers, '.', '_' or '-'.");
      return;
    }

    stopMovement();
    setSavedRobotIds((current) =>
      current.includes(robotId) ? current : [...current, robotId],
    );
    setSelectedRobotId(robotId);
    setRobotIdInput(robotId);
    setRobotIdMasked(true);
    setModeRequest(null);
    setMessage(`${robotId} added to your robot list and selected.`);
  };

  const sendCommand = (command: ControlCommand) => {
    if (!socket?.connected) {
      setMessage("Dashboard is disconnected from the control server.");
      return;
    }
    if (command !== "STOP" && !hasControl) {
      setMessage("Claim operator control before sending commands.");
      return;
    }
    socket.emit("control:command", { robotId: selectedRobotId, command });
    addEvent(`${selectedRobotId} command sent: ${command}`, "control");
  };

  const stopRobot = () => {
    if (!socket?.connected) {
      setMessage("Dashboard is disconnected from the control server.");
      return;
    }
    stopMovement(false);
    socket.emit("control:command", { robotId: selectedRobotId, command: "STOP" });
    socket.emit("control:command", { robotId: selectedRobotId, command: "PUMP_OFF" });
    socket.emit("control:command", { robotId: selectedRobotId, command: "MANUAL" });
    addEvent("Emergency stop requested", "alert");
    setModeRequest("manual");
    if (modeRequestTimeout.current !== null) {
      window.clearTimeout(modeRequestTimeout.current);
    }
    modeRequestTimeout.current = window.setTimeout(() => {
      setModeRequest(null);
      setMessage("Robot did not confirm manual mode. Check robot mode-command support and telemetry.");
      modeRequestTimeout.current = null;
    }, 5000);
  };

  const requestMode = (requestedMode: RequestedMode) => {
    if (!socket?.connected || !hasControl || !robotOnline) {
      setMessage("A live robot connection and operator control are required to change mode.");
      return;
    }
    if (robotMode === requestedMode) return;

    stopMovement(false);
    setModeRequest(requestedMode);
    setMessage("");
    if (modeRequestTimeout.current !== null) {
      window.clearTimeout(modeRequestTimeout.current);
    }
    modeRequestTimeout.current = window.setTimeout(() => {
      setModeRequest(null);
      setMessage("Robot did not confirm the requested mode. Check robot mode-command support and telemetry.");
      modeRequestTimeout.current = null;
    }, 5000);
    socket.emit(
      "control:command",
      {
        robotId: selectedRobotId,
        command: requestedMode === "autopilot" ? "AUTOPILOT_ON" : "MANUAL",
      },
    );
    addEvent(`${selectedRobotId} mode change requested: ${requestedMode}`, "control");
  };

  const startMovement = (
    event: PointerEvent<HTMLButtonElement>,
    command: MovementCommand,
  ) => {
    event.preventDefault();
    if (
      !hasControl ||
      !robotOnline ||
      robotMode !== "manual" ||
      modeRequest !== null ||
      activeMovement.current
    ) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    activeMovement.current = command;
    activeMovementRobotId.current = selectedRobotId;
    sendCommand(command);
    movementHeartbeat.current = window.setInterval(
      () => socketRef.current?.emit("control:heartbeat", activeMovementRobotId.current),
      200,
    );
  };

  const onMovementRelease = () => stopMovement();
  const pumpCommand: ControlCommand = telemetry?.pump ? "PUMP_OFF" : "PUMP_ON";

  if (storedToken === null) {
    return (
      <main className="login-screen">
        <form className="login-panel" onSubmit={signIn}>
          <div className="brand-mark"><Flame size={22} strokeWidth={2.2} /></div>
          <p className="eyebrow">FIRELINE · ROBOT OPERATIONS</p>
          <h1>Operator access</h1>
          <p className="login-copy">
            Enter the dashboard token printed when the control server started.
          </p>
          <label htmlFor="access-token">Dashboard token</label>
          <input
            id="access-token"
            autoComplete="current-password"
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            required
          />
          {message && <p className="form-message" role="alert">{message}</p>}
          <button className="primary-button login-submit" type="submit">
            <LockKeyhole size={16} /> Connect to control center
          </button>
          <p className="secure-note"><ShieldAlert size={14} /> Token stays in this browser session.</p>
        </form>
      </main>
    );
  }

  return (
    <main className="earth-shell" data-theme={theme}>
      <header className="earth-topbar">
        <div className="earth-brand">
          <Flame className="earth-brand-logo" size={22} strokeWidth={2.2} />
          <span className="earth-brand-copy"><strong>FIRELINE</strong><span>ROBOT OPERATIONS</span></span>
        </div>
        <div className="earth-view-title"><span>MISSION VIEW</span><strong>3D WORLD TRACKING</strong></div>
        <div className="earth-topbar-right">
          <div className={`connection-pill ${robotOnline ? "is-live" : "is-offline"}`}>
            {robotOnline ? <Wifi size={15} /> : <WifiOff size={15} />}
            <span>{robotOnline ? "ROBOT ONLINE" : "ROBOT OFFLINE"}</span>
          </div>
          <span className={`server-indicator ${connected ? "is-live" : ""}`}>
            <span className="status-dot" /> {connected ? "LINKED" : "NO SERVER"}
          </span>
          <button
            type="button"
            className="theme-toggle"
            aria-label={`Switch to ${theme === "dark" ? "day" : "night"} mode`}
            aria-pressed={theme === "light"}
            title={`Switch to ${theme === "dark" ? "day" : "night"} mode`}
            onClick={() => {
              window.localStorage.setItem(THEME_PREFERENCE_KEY, "true");
              setTheme((current) => current === "dark" ? "light" : "dark");
            }}
          >
            {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <button className="icon-button signout-button" onClick={signOut} aria-label="Sign out" title="Sign out">
            <LogOut size={17} />
          </button>
        </div>
      </header>

      <div className="earth-stage">
        <section className="earth-map" aria-label="3D robot tracking map">
          <CesiumMap
            telemetry={telemetry}
            theme={theme}
            robotAddress={locationName}
            controlsVisible={mapControlsVisible}
          />
          {!gpsAvailable && (
            <div className="map-overlay">
              <span className="map-crosshair"><Crosshair size={17} /></span>
              <div className="map-overlay-copy">
                <strong>Waiting for GPS fix</strong>
                <span>Globe is ready; robot position appears with telemetry.</span>
              </div>
            </div>
          )}
          {gpsAvailable && (
            <div className="map-coordinate-tag"><MapPin size={13} /> ROBOT POSITION</div>
          )}
          <button
            type="button"
            className="map-view-badge"
            onClick={() => setMapControlsVisible((visible) => !visible)}
            aria-expanded={mapControlsVisible}
            aria-controls="map-navigation-controls"
            aria-label={mapControlsVisible ? "Hide map controls" : "Show map controls"}
            title={mapControlsVisible ? "Hide map controls" : "Show map controls"}
          >
            <Radio size={13} />
            <span>LIVE 3D GLOBE</span>
          </button>
          <span className="map-attribution">
            Imagery, terrain &amp; place labels © Esri · Buildings &amp; geocoding © OpenStreetMap contributors · Photon
          </span>
        </section>

        <aside
          className={`side-panel left-panel ${leftSidebarCollapsed ? "is-collapsed" : ""}`}
          aria-label="Robot drive and actuator controls"
        >
          <button
            type="button"
            className="sidebar-toggle"
            aria-label={`${leftSidebarCollapsed ? "Expand" : "Collapse"} robot controls sidebar`}
            aria-expanded={!leftSidebarCollapsed}
            title={`${leftSidebarCollapsed ? "Expand" : "Collapse"} robot controls`}
            onClick={() => setLeftSidebarCollapsed((collapsed) => !collapsed)}
          >
            {leftSidebarCollapsed ? <ChevronRight size={19} /> : <ChevronLeft size={19} />}
          </button>
          <div className="robot-card-heading">
            <span className="robot-avatar"><Flame size={18} /></span>
            <div className="robot-title-copy"><span>ACTIVE UNIT · {selectedRobotId}</span><strong>{locationName}</strong></div>
            <span className={`unit-dot ${robotOnline ? "unit-online" : ""}`} />
          </div>

          <form className="robot-selector" onSubmit={selectRobot}>
            <label htmlFor="active-robot-id">Robot ID</label>
            <div className="robot-selector-row">
              <input
                id="active-robot-id"
                className={robotIdMasked || robotIdInput.trim() ? "has-robot-id" : ""}
                list="active-robot-ids"
                value={robotIdMasked ? "******" : robotIdInput}
                onFocus={() => {
                  if (robotIdMasked) {
                    setRobotIdInput("");
                    setRobotIdMasked(false);
                  }
                }}
                onChange={(event) => {
                  setRobotIdInput(event.target.value);
                  setRobotIdMasked(false);
                }}
                maxLength={32}
                pattern={robotIdMasked ? undefined : "[A-Za-z0-9][A-Za-z0-9._-]{0,31}"}
                aria-label={robotIdMasked ? "Selected Robot ID hidden. Focus to enter a different ID." : "Robot ID to select"}
              />
              <datalist id="active-robot-ids">
                {[...new Set([
                  ...savedRobotIds,
                  ...robotStatuses.map((status) => status.robotId),
                ])].map((robotId) => (
                  <option key={robotId} value={robotId} />
                ))}
              </datalist>
              <button type="submit" aria-label="Add Robot ID and select it">ADD</button>
            </div>
            <div className="active-robot-count">
              <span className="status-dot" />
              {activeRobotCount} active {activeRobotCount === 1 ? "robot" : "robots"}
            </div>
          </form>

          <div className={`control-lock ${hasControl ? "control-held" : ""}`}>
            <span className={`control-status-dot ${hasControl ? "active" : ""}`} />
            <span>{hasControl ? "Operator control held" : controlOccupied ? "Another operator is driving" : "Control not held"}</span>
            {!hasControl && connected && !controlOccupied && (
              <button className="claim-button" onClick={() => socket?.emit("control:claim")}>Claim</button>
            )}
          </div>

          <section className="sidebar-section">
            <div className="sidebar-section-heading">
              <h2>Driving mode</h2>
              <span className={`mode-confirmation ${robotMode === "autopilot" ? "mode-auto" : ""}`}>
                {modeRequest ? "SWITCHING…" : robotMode === "unknown" ? "UNKNOWN" : robotMode.toUpperCase()}
              </span>
            </div>
            <div className="mode-switch" role="group" aria-label="Robot driving mode">
              <button
                className={`mode-option ${robotMode === "manual" ? "mode-option-active" : ""}`}
                aria-pressed={robotMode === "manual"}
                disabled={!hasControl || !robotOnline || modeRequest !== null}
                onClick={() => requestMode("manual")}
              >
                <ArrowUp size={17} />
                <span><strong>Manual</strong><small>Operator drives</small></span>
              </button>
              <button
                className={`mode-option ${robotMode === "autopilot" ? "mode-option-active mode-option-auto" : ""}`}
                aria-pressed={robotMode === "autopilot"}
                disabled={!hasControl || !robotOnline || modeRequest !== null}
                onClick={() => requestMode("autopilot")}
              >
                <Crosshair size={17} />
                <span><strong>Autopilot</strong><small>Onboard robot logic</small></span>
              </button>
            </div>
            <p className="mode-note">Mode changes are confirmed by robot telemetry.</p>
          </section>

          <section className="sidebar-section manual-section">
            <div className="sidebar-section-heading">
              <h2>Manual drive</h2>
              <span className="hold-label">HOLD TO MOVE</span>
            </div>
            <div className="dpad" aria-label="Directional controls">
              <span className="dpad-center-label">DRIVE</span>
              <button className="direction-button direction-up" aria-label="Move forward"
                disabled={!hasControl || !robotOnline || robotMode !== "manual" || modeRequest !== null}
                onPointerDown={(event) => startMovement(event, "FORWARD")}
                onPointerUp={onMovementRelease} onPointerLeave={onMovementRelease}
                onPointerCancel={onMovementRelease}
                onContextMenu={(event) => event.preventDefault()}
                onLostPointerCapture={onMovementRelease}><ArrowUp size={22} /></button>
              <button className="direction-button direction-left" aria-label="Turn left"
                disabled={!hasControl || !robotOnline || robotMode !== "manual" || modeRequest !== null}
                onPointerDown={(event) => startMovement(event, "LEFT")}
                onPointerUp={onMovementRelease} onPointerLeave={onMovementRelease}
                onPointerCancel={onMovementRelease}
                onContextMenu={(event) => event.preventDefault()}
                onLostPointerCapture={onMovementRelease}><ArrowLeft size={21} /></button>
              <button className="direction-button direction-right" aria-label="Turn right"
                disabled={!hasControl || !robotOnline || robotMode !== "manual" || modeRequest !== null}
                onPointerDown={(event) => startMovement(event, "RIGHT")}
                onPointerUp={onMovementRelease} onPointerLeave={onMovementRelease}
                onPointerCancel={onMovementRelease}
                onContextMenu={(event) => event.preventDefault()}
                onLostPointerCapture={onMovementRelease}><ArrowRight size={21} /></button>
              <button className="direction-button direction-down" aria-label="Move backward"
                disabled={!hasControl || !robotOnline || robotMode !== "manual" || modeRequest !== null}
                onPointerDown={(event) => startMovement(event, "BACKWARD")}
                onPointerUp={onMovementRelease} onPointerLeave={onMovementRelease}
                onPointerCancel={onMovementRelease}
                onContextMenu={(event) => event.preventDefault()}
                onLostPointerCapture={onMovementRelease}><ArrowDown size={22} /></button>
            </div>
            <button className="stop-button" onClick={stopRobot} disabled={!connected}>
              <span className="stop-square" /> SAFE STOP · ALL ACTUATORS
            </button>
          </section>

          <section className={`pump-control ${telemetry?.pump ? "pump-active" : ""}`}>
            <div className="pump-control-copy">
              <span className={`pump-indicator ${telemetry?.pump ? "pump-on" : ""}`} />
              <div><strong>Water pump</strong><span>{telemetry?.pump ? "Running" : "Off"}</span></div>
            </div>
            <button
              role="switch"
              aria-checked={telemetry?.pump ?? false}
              aria-label="Toggle water pump"
              className={`switch ${telemetry?.pump ? "switch-on" : ""}`}
              disabled={!hasControl || !robotOnline || !telemetry || robotMode !== "manual"}
              onClick={() => sendCommand(pumpCommand)}
            ><span /></button>
          </section>
          <p className="sidebar-safety-note"><ShieldAlert size={13} /> Direction controls are hold-to-run and lease protected.</p>
        </aside>

        <aside
          className={`side-panel right-panel ${rightSidebarCollapsed ? "is-collapsed" : ""}`}
          aria-label="Live robot telemetry"
        >
          <button
            type="button"
            className="sidebar-toggle"
            aria-label={`${rightSidebarCollapsed ? "Expand" : "Collapse"} telemetry sidebar`}
            aria-expanded={!rightSidebarCollapsed}
            title={`${rightSidebarCollapsed ? "Expand" : "Collapse"} telemetry`}
            onClick={() => setRightSidebarCollapsed((collapsed) => !collapsed)}
          >
            {rightSidebarCollapsed ? <ChevronLeft size={19} /> : <ChevronRight size={19} />}
          </button>
          <div className="telemetry-panel-heading">
            <div><span>LIVE DATA</span><h2>Robot telemetry</h2></div>
            <span className={`telemetry-pulse ${telemetryFresh ? "pulse-active" : ""}`} />
          </div>

          <section className={`fire-signal-card ${fireSignal.detected ? "fire-signal-active" : ""}`} aria-label="Live fire signal radar monitor">
            <div className="fire-signal-heading">
              <span><span className="fire-signal-live-dot" /> FIRE SIGNAL MONITOR</span>
              <strong>{fireSignal.detected ? "DETECTED" : fireSignal.direction === "CLEAR" ? "CLEAR" : fireSignal.level}</strong>
            </div>
            <div className="fire-signal-readout">
              <div className="fire-signal-radar" style={radarStyle}>
                <span className="radar-grid" aria-hidden="true" />
                <span className="radar-sweep" aria-hidden="true" />
                <span className="radar-core" aria-hidden="true" />
                <span
                  className={`radar-zone radar-left ${fireSignal.sensors.left >= 25 ? "radar-zone-active" : ""}`}
                  style={{ "--blip-size": `${10 + fireSignal.sensors.left * 0.1}px`, "--blip-opacity": 0.18 + fireSignal.sensors.left / 125 } as CSSProperties}
                  aria-hidden="true"
                />
                <span
                  className={`radar-zone radar-front ${fireSignal.sensors.front >= 25 ? "radar-zone-active" : ""}`}
                  style={{ "--blip-size": `${10 + fireSignal.sensors.front * 0.1}px`, "--blip-opacity": 0.18 + fireSignal.sensors.front / 125 } as CSSProperties}
                  aria-hidden="true"
                />
                <span
                  className={`radar-zone radar-right ${fireSignal.sensors.right >= 25 ? "radar-zone-active" : ""}`}
                  style={{ "--blip-size": `${10 + fireSignal.sensors.right * 0.1}px`, "--blip-opacity": 0.18 + fireSignal.sensors.right / 125 } as CSSProperties}
                  aria-hidden="true"
                />
                <span className="radar-direction-label radar-direction-left" aria-hidden="true">L</span>
                <span className="radar-direction-label radar-direction-front" aria-hidden="true">F</span>
                <span className="radar-direction-label radar-direction-right" aria-hidden="true">R</span>
                <div className="radar-hud" aria-label="Signal status">
                  <span className="radar-hud-count"><b>{String(fireSignalCount).padStart(2, "0")}</b> SIGNALS</span>
                  {fireSignal.detected && (
                    <span className="radar-hud-area" role="status">{fireSignal.direction} AREA</span>
                  )}
                </div>
              </div>
            </div>
            <div className="event-stream-card" aria-label="Event stream">
              <div className="event-stream-heading">
                <span><Activity size={14} /> EVENT STREAM</span>
                <span className={`event-stream-indicator ${connected ? "is-connected" : ""}`} />
              </div>
              <ol className="event-stream-list" aria-live="polite" aria-relevant="additions">
                {events.length === 0 ? (
                  <li className="event-stream-empty">Waiting for events</li>
                ) : events.map((entry) => (
                  <li className={`event-stream-entry event-${entry.kind}`} key={entry.id}>
                    <time>{entry.time}</time>
                    <span>{entry.message}</span>
                  </li>
                ))}
              </ol>
            </div>
          </section>

          <section className="telemetry-section signal-history-section" aria-label="Fire signal notification history">
            <div className="telemetry-section-heading">
              <Flame size={15} />
              <h3>Fire signal history</h3>
              <span>{selectedSignalHistory.length}</span>
              <button
                type="button"
                className="signal-sound-toggle"
                aria-label={fireSignalSoundEnabled ? "Mute fire signal sound" : "Enable fire signal sound"}
                aria-pressed={fireSignalSoundEnabled}
                onClick={() => {
                  const enabled = !fireSignalSoundEnabledRef.current;
                  fireSignalSoundEnabledRef.current = enabled;
                  setFireSignalSoundEnabled(enabled);
                  if (enabled) resumeFireSignalAudio();
                }}
              >
                {fireSignalSoundEnabled ? <Volume2 size={14} /> : <VolumeX size={14} />}
              </button>
            </div>
            <ol className="event-stream-list signal-history-list" aria-live="polite" aria-relevant="additions">
              {selectedSignalHistory.length === 0 ? (
                <li className="event-stream-empty">No fire signals yet</li>
              ) : selectedSignalHistory.map((entry) => (
                <li className="event-stream-entry event-alert" key={entry.id}>
                  <time>{entry.time}</time>
                  <span>{entry.direction} · {entry.strength}% · ADC {entry.sensorValue}</span>
                </li>
              ))}
            </ol>
          </section>

          <section className="telemetry-section">
            <div className="telemetry-section-heading"><Flame size={15} /><h3>Flame sensors</h3><span>RAW ADC</span></div>
            <div className="sensor-list">
              {([
                ["Right", telemetry?.sensors.right],
                ["Front", telemetry?.sensors.front],
                ["Left", telemetry?.sensors.left],
              ] as const).map(([label, value]) => (
                <div className="sensor-row" key={label}>
                  <span className="sensor-name"><span className="sensor-tick" />{label}</span>
                  <strong className="sensor-value">{value ?? "—"}</strong>
                  <span className="sensor-unit">{value === undefined ? "WAIT" : "/ 4095"}</span>
                </div>
              ))}
            </div>
            <p className="sensor-footnote">Raw outputs only; sensor polarity and fire thresholds are hardware-specific.</p>
          </section>

          <section className="telemetry-section gps-section">
            <div className="telemetry-section-heading"><MapPin size={15} /><h3>GPS position</h3>
              <span className={`gps-state ${gpsAvailable ? "fix-live" : ""}`}><i />{gpsAvailable ? "FIX" : "NO FIX"}</span>
            </div>
            <div className="coordinate-grid">
              <div><span>LATITUDE</span><strong>{formatCoordinate(telemetry?.gps.latitude)}</strong></div>
              <div><span>LONGITUDE</span><strong>{formatCoordinate(telemetry?.gps.longitude)}</strong></div>
            </div>
          </section>

          <section className="telemetry-section state-section">
            <div className="telemetry-section-heading"><Signal size={15} /><h3>Actuator state</h3></div>
            <div className="detail-row"><span>Mode reported</span><strong>{telemetry?.mode ?? "—"}</strong></div>
            <div className="detail-row"><span>Water pump</span><strong className={telemetry?.pump ? "value-live" : "value-muted"}>{telemetry?.pump ? "Running" : "Off"}</strong></div>
            <div className="detail-row"><span>Last packet</span><strong className="packet-time">{lastSeen}</strong></div>
          </section>

          <div className="telemetry-panel-footer"><Radio size={13} /> Values update from the robot connection.</div>
        </aside>

        {message && (
          <div className="notice-banner app-notice" role="status">
            <ShieldAlert size={16} /><span>{message}</span>
            <button className="notice-dismiss" onClick={() => setMessage("")} aria-label="Dismiss message"><X size={15} /></button>
          </div>
        )}
      </div>
    </main>
  );
}
