"use client";

import { Globe, LocateFixed, RotateCw, Search } from "lucide-react";
import { memo, useEffect, useRef, useState, type FormEvent } from "react";
import type { TelemetryUpdate } from "@/lib/protocol";

interface CesiumMapProps {
  telemetry: TelemetryUpdate | null;
  theme: "dark" | "light";
  robotAddress: string;
  controlsVisible: boolean;
}

interface Coordinates {
  latitude: number;
  longitude: number;
}

interface PlaceResult extends Coordinates {
  label: string;
}

const GLOBE_ROTATION_RADIANS_PER_SECOND = 0.01;
const NAVIGATION_TERRAIN_ERROR = 24;
const IDLE_TERRAIN_ERROR = 10;
const FOLLOW_TERRAIN_ERROR = 6;
const MAP_POSITION_UPDATE_DISTANCE_METERS = 5;
const FOLLOW_ROTATION_RADIANS_PER_SECOND = 0.06;
const FOLLOW_CAMERA_RANGE = 900;
const FOLLOW_MIN_CAMERA_RANGE = 300;
const FOLLOW_MAX_CAMERA_RANGE = 12_000;
const FOLLOW_CAMERA_PITCH = -68;
const ROBOT_MARKER_SIZE = 48;
const ROBOT_MARKER_PULSE_PERIOD_MS = 1600;
const FOLLOW_STATUS_MESSAGE = "Following the robot from an orbiting drone view.";
const BUILDINGS_MAX_CAMERA_HEIGHT = 35_000;
const INITIAL_LOCATION = { longitude: 91.81903705, latitude: 22.35739545 };
const INITIAL_CAMERA_HEIGHT = 206_395;
const INITIAL_CAMERA_DISTANCE = 68_798;
const INITIAL_CAMERA_HEADING = 305.22025577;
const INITIAL_CAMERA_PITCH = -30;
const TERRAIN_SERVICE_URL =
  "https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer";
const WORLD_IMAGERY_MISSING_TILE_URL =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/20/457448/791730";
const LABEL_TILE_URL =
  "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}";

function isValidCoordinates(latitude: number, longitude: number): boolean {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

function parseCoordinates(query: string): Coordinates | null {
  const match = query.trim().match(/^(-?\d+(?:\.\d+)?)\s*[,;]\s*(-?\d+(?:\.\d+)?)$/);
  if (!match) return null;

  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  return isValidCoordinates(latitude, longitude) ? { latitude, longitude } : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readPlaceResults(payload: unknown): PlaceResult[] {
  const response = asRecord(payload);
  if (!Array.isArray(response?.features)) return [];

  const results: PlaceResult[] = [];
  for (const feature of response.features) {
    const featureRecord = asRecord(feature);
    const geometry = asRecord(featureRecord?.geometry);
    const coordinates = geometry?.coordinates;
    if (
      !Array.isArray(coordinates) ||
      typeof coordinates[0] !== "number" ||
      typeof coordinates[1] !== "number"
    ) {
      continue;
    }

    const longitude = coordinates[0];
    const latitude = coordinates[1];
    if (!isValidCoordinates(latitude, longitude)) continue;

    const properties = asRecord(featureRecord?.properties);
    const labelParts = [
      properties?.name,
      properties?.street,
      properties?.housenumber,
      properties?.locality,
      properties?.city,
      properties?.state,
      properties?.country,
    ]
      .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
      .map((part) => part.trim());

    results.push({
      latitude,
      longitude,
      label: [...new Set(labelParts)].join(", ") || "Selected place",
    });
  }

  return results;
}

function shouldSkipMapRender(previous: CesiumMapProps, next: CesiumMapProps): boolean {
  if (
    previous.theme !== next.theme ||
    previous.telemetry?.robotId !== next.telemetry?.robotId ||
    previous.robotAddress !== next.robotAddress ||
    previous.controlsVisible !== next.controlsVisible
  ) {
    return false;
  }

  const previousLatitude = previous.telemetry?.gps.latitude;
  const previousLongitude = previous.telemetry?.gps.longitude;
  const nextLatitude = next.telemetry?.gps.latitude;
  const nextLongitude = next.telemetry?.gps.longitude;
  if (
    typeof previousLatitude !== "number" ||
    typeof previousLongitude !== "number"
  ) {
    return typeof nextLatitude !== "number" || typeof nextLongitude !== "number";
  }
  if (typeof nextLatitude !== "number" || typeof nextLongitude !== "number") {
    return false;
  }

  const meanLatitude = ((previousLatitude + nextLatitude) / 2) * (Math.PI / 180);
  const latitudeDistance = (nextLatitude - previousLatitude) * 111_320;
  const longitudeDistance =
    (nextLongitude - previousLongitude) * 111_320 * Math.cos(meanLatitude);
  return Math.hypot(latitudeDistance, longitudeDistance) < MAP_POSITION_UPDATE_DISTANCE_METERS;
}

function CesiumMap({ telemetry, theme, robotAddress, controlsVisible }: CesiumMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<import("cesium").Viewer | null>(null);
  const cesiumRef = useRef<typeof import("cesium") | null>(null);
  const markerRef = useRef<import("cesium").Entity | null>(null);
  const followTargetRef = useRef<Coordinates | null>(null);
  const followingRef = useRef(false);
  const selectedLocationRef = useRef<import("cesium").Entity | null>(null);
  const initialPositionHandledRef = useRef(false);
  const userNavigatedRef = useRef(false);
  const worldViewRef = useRef(true);
  const lastSearchAtRef = useRef(0);
  const [globeReady, setGlobeReady] = useState(false);
  const [globeError, setGlobeError] = useState(false);
  const [terrainStatus, setTerrainStatus] = useState("Loading");
  const [buildingStatus, setBuildingStatus] = useState(
    process.env.NEXT_PUBLIC_CESIUM_ION_ACCESS_TOKEN?.trim() ? "Loading" : "Token required",
  );
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);
  const [suggestions, setSuggestions] = useState<PlaceResult[]>([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [suggestionError, setSuggestionError] = useState("");
  const [following, setFollowing] = useState(false);
  const [autoRotate, setAutoRotate] = useState(false);
  const [viewMode, setViewMode] = useState<"2D" | "3D">("3D");
  const [modeTransitioning, setModeTransitioning] = useState(false);
  const [searchMessage, setSearchMessage] = useState("");
  const latitude = telemetry?.gps.latitude;
  const longitude = telemetry?.gps.longitude;
  const robotCoordinates =
    typeof latitude === "number" && typeof longitude === "number"
      ? `LAT ${latitude.toFixed(6)} · LON ${longitude.toFixed(6)}`
      : "GPS coordinates unavailable";
  const searchQuery = query.trim();
  const searchIsCoordinates =
    !!parseCoordinates(searchQuery) ||
    /^-?\d+(?:\.\d+)?\s*[,;]\s*-?\d+(?:\.\d+)?$/.test(searchQuery);

  useEffect(() => {
    const searchTerm = query.trim();
    setSuggestions([]);
    setSuggestionError("");
    if (
      !searchFocused ||
      searchTerm.length < 3 ||
      parseCoordinates(searchTerm) ||
      /^-?\d+(?:\.\d+)?\s*[,;]\s*-?\d+(?:\.\d+)?$/.test(searchTerm)
    ) {
      setSuggestionsLoading(false);
      return;
    }

    const controller = new AbortController();
    let disposed = false;
    let timedOut = false;
    setSuggestionsLoading(true);
    const debounce = window.setTimeout(() => {
      const requestTimeout = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, 6000);
      void (async () => {
        try {
          const response = await fetch(
            `https://photon.komoot.io/api/?q=${encodeURIComponent(searchTerm)}&limit=5&lang=en`,
            { headers: { Accept: "application/json" }, signal: controller.signal },
          );
          if (!response.ok) {
            throw new Error(`Place suggestions returned HTTP ${response.status}.`);
          }

          const results = readPlaceResults(await response.json());
          if (controller.signal.aborted) return;
          setSuggestions(results);
          if (results.length === 0) setSuggestionError("No places found. Try a different search.");
        } catch (error: unknown) {
          if (disposed) return;
          if (timedOut) {
            setSuggestionError("Place suggestions timed out. Press Go to search anyway.");
          } else if (!controller.signal.aborted) {
            console.error("Unable to load place search suggestions.", error);
            setSuggestionError("Suggestions unavailable. Press Go to search anyway.");
          }
        } finally {
          window.clearTimeout(requestTimeout);
          if (!disposed && (!controller.signal.aborted || timedOut)) {
            setSuggestionsLoading(false);
          }
        }
      })();
    }, 350);

    return () => {
      disposed = true;
      window.clearTimeout(debounce);
      controller.abort();
    };
  }, [query, searchFocused]);

  useEffect(() => {
    let disposed = false;
    let removeResolutionListener: (() => void) | null = null;

    async function createGlobe() {
      if (!containerRef.current) return;

      const globalWithCesium = globalThis as typeof globalThis & {
        CESIUM_BASE_URL?: string;
      };
      globalWithCesium.CESIUM_BASE_URL = "/cesium/";

      const Cesium = await import("cesium");
      if (disposed || !containerRef.current) return;

      const ionToken = process.env.NEXT_PUBLIC_CESIUM_ION_ACCESS_TOKEN?.trim();
      if (ionToken) Cesium.Ion.defaultAccessToken = ionToken;
      cesiumRef.current = Cesium;
      const getResolutionCap = () =>
        window.matchMedia("(max-width: 820px)").matches ? 1 : 1.25;
      const viewer = new Cesium.Viewer(containerRef.current, {
        baseLayer: false,
        baseLayerPicker: false,
        terrainProvider: new Cesium.EllipsoidTerrainProvider(),
        sceneMode: Cesium.SceneMode.SCENE3D,
        requestRenderMode: true,
        maximumRenderTimeChange: Number.POSITIVE_INFINITY,
        targetFrameRate: 60,
        animation: false,
        timeline: false,
        geocoder: false,
        homeButton: false,
        sceneModePicker: false,
        navigationHelpButton: false,
        fullscreenButton: false,
        infoBox: false,
        selectionIndicator: false,
        creditContainer: document.createElement("div"),
      });
      const updateResolutionScale = () => {
        if (viewer.isDestroyed()) return;
        const resolutionScale = Math.min(
          Math.max(window.devicePixelRatio || 1, 1),
          getResolutionCap(),
        );
        if (viewer.resolutionScale === resolutionScale) return;
        viewer.resolutionScale = resolutionScale;
        viewer.scene.requestRender();
      };
      updateResolutionScale();
      window.addEventListener("resize", updateResolutionScale, { passive: true });
      removeResolutionListener = () =>
        window.removeEventListener("resize", updateResolutionScale);
      viewer.scene.globe.depthTestAgainstTerrain = true;
      viewer.scene.globe.tileCacheSize = 256;
      viewer.scene.screenSpaceCameraController.minimumZoomDistance = 250;
      viewer.scene.screenSpaceCameraController.zoomFactor = 4;
      viewer.scene.screenSpaceCameraController.inertiaZoom = 0.6;
      viewer.scene.globe.maximumScreenSpaceError = IDLE_TERRAIN_ERROR;
      viewer.camera.moveStart.addEventListener(() => {
        if (viewer.isDestroyed()) return;
        viewer.scene.globe.maximumScreenSpaceError = followingRef.current
          ? FOLLOW_TERRAIN_ERROR
          : NAVIGATION_TERRAIN_ERROR;
      });
      viewer.camera.moveEnd.addEventListener(() => {
        if (viewer.isDestroyed()) return;
        viewer.scene.globe.maximumScreenSpaceError = followingRef.current
          ? FOLLOW_TERRAIN_ERROR
          : IDLE_TERRAIN_ERROR;
        viewer.scene.requestRender();
      });
      viewer.imageryLayers.addImageryProvider(
        new Cesium.UrlTemplateImageryProvider({
          url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
          tilingScheme: new Cesium.WebMercatorTilingScheme(),
          credit: "Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community",
          maximumLevel: 19,
          tileDiscardPolicy: new Cesium.DiscardMissingTileImagePolicy({
            missingImageUrl: WORLD_IMAGERY_MISSING_TILE_URL,
            pixelsToCheck: [
              new Cesium.Cartesian2(119, 108),
              new Cesium.Cartesian2(69, 110),
              new Cesium.Cartesian2(135, 110),
              new Cesium.Cartesian2(183, 112),
            ],
          }),
        }),
      );
      const labelLayer = viewer.imageryLayers.addImageryProvider(
        new Cesium.UrlTemplateImageryProvider({
          url: LABEL_TILE_URL,
          tilingScheme: new Cesium.WebMercatorTilingScheme(),
          credit: "Labels © Esri, HERE, Garmin, OpenStreetMap contributors, and the GIS user community",
          maximumLevel: 16,
        }),
      );
      labelLayer.alpha = 0.95;
      viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString("#172124");
      viewer.scene.backgroundColor = Cesium.Color.fromCssColorString("#101719");
      viewer.scene.globe.enableLighting = false;
      const initialOrientation = {
        heading: Cesium.Math.toRadians(INITIAL_CAMERA_HEADING),
        pitch: Cesium.Math.toRadians(INITIAL_CAMERA_PITCH),
        roll: 0,
      };
      viewer.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(
          INITIAL_LOCATION.longitude,
          INITIAL_LOCATION.latitude,
          INITIAL_CAMERA_HEIGHT,
        ),
        orientation: initialOrientation,
      });
      viewer.scene.requestRender();
      viewerRef.current = viewer;
      setGlobeReady(true);
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(
          INITIAL_LOCATION.longitude,
          INITIAL_LOCATION.latitude,
          INITIAL_CAMERA_DISTANCE,
        ),
        orientation: initialOrientation,
        duration: 2.4,
        easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
      });
      initialPositionHandledRef.current = true;

      void Cesium.ArcGISTiledElevationTerrainProvider.fromUrl(TERRAIN_SERVICE_URL)
        .then((terrainProvider) => {
          if (disposed || viewer.isDestroyed()) return;
          viewer.terrainProvider = terrainProvider;
          setTerrainStatus("Active");
          viewer.scene.requestRender();
        })
        .catch((error: unknown) => {
          if (disposed) return;
          console.error("Unable to load global terrain; using the ellipsoid globe.", error);
          setTerrainStatus("Unavailable");
        });

      if (ionToken) {
        void Cesium.createOsmBuildingsAsync()
          .then((buildings) => {
            if (disposed || viewer.isDestroyed()) {
              buildings.destroy();
              return;
            }
            buildings.maximumScreenSpaceError = 12;
            buildings.dynamicScreenSpaceError = false;
            const updateBuildingVisibility = () => {
              buildings.show =
                viewer.camera.positionCartographic.height < BUILDINGS_MAX_CAMERA_HEIGHT;
              viewer.scene.requestRender();
            };
            updateBuildingVisibility();
            viewer.camera.moveEnd.addEventListener(updateBuildingVisibility);
            viewer.scene.primitives.add(buildings);
            setBuildingStatus("Active");
            viewer.scene.requestRender();
          })
          .catch((error: unknown) => {
            if (disposed) return;
            console.error("Unable to load Cesium OSM buildings.", error);
            setBuildingStatus("Unavailable");
          });
      }
    }

    void createGlobe().catch((error: unknown) => {
      if (disposed) return;
      console.error("Unable to initialize the Cesium globe.", error);
      setGlobeError(true);
      setTerrainStatus("Unavailable");
    });
    return () => {
      disposed = true;
      removeResolutionListener?.();
      viewerRef.current?.destroy();
      viewerRef.current = null;
      cesiumRef.current = null;
      markerRef.current = null;
      selectedLocationRef.current = null;
      initialPositionHandledRef.current = false;
      userNavigatedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const viewer = viewerRef.current;
    const Cesium = cesiumRef.current;
    if (!viewer || !Cesium || !globeReady || viewer.isDestroyed()) return;

    const updateViewMode = () => {
      setViewMode(viewer.scene.mode === Cesium.SceneMode.SCENE2D ? "2D" : "3D");
      setModeTransitioning(false);
    };
    viewer.scene.morphComplete.addEventListener(updateViewMode);
    return () => {
      if (!viewer.isDestroyed()) {
        viewer.scene.morphComplete.removeEventListener(updateViewMode);
      }
    };
  }, [globeReady]);

  useEffect(() => {
    const viewer = viewerRef.current;
    const Cesium = cesiumRef.current;
    if (!viewer || !Cesium || !globeReady || viewer.isDestroyed()) return;

    viewer.scene.backgroundColor = Cesium.Color.fromCssColorString(
      theme === "light" ? "#e4eaeb" : "#0b1118",
    );
    viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString(
      theme === "light" ? "#f3f0e8" : "#121d29",
    );
    if (markerRef.current?.point) {
      markerRef.current.point.outlineColor = new Cesium.ConstantProperty(
        Cesium.Color.fromCssColorString(
          theme === "light" ? "#fffdf8" : "#0b1118",
        ),
      );
    }

    viewer.scene.requestRender();
  }, [globeReady, theme]);

  useEffect(() => {
    const viewer = viewerRef.current;
    const Cesium = cesiumRef.current;
    const target = followTargetRef.current;
    if (!viewer || !Cesium || !globeReady || !following || !target || viewer.isDestroyed()) {
      return;
    }

    followingRef.current = true;
    viewer.scene.globe.maximumScreenSpaceError = FOLLOW_TERRAIN_ERROR;
    viewer.trackedEntity = undefined;
    viewer.scene.requestRenderMode = false;
    let disposed = false;
    let active = false;
    let lastFrameTime = performance.now();
    let latitude = target.latitude;
    let longitude = target.longitude;
    let heading = viewer.camera.heading;
    let cameraRange = FOLLOW_CAMERA_RANGE;
    let removeMorphListener: (() => void) | null = null;

    const startFollowFlight = () => {
      if (disposed || viewer.isDestroyed()) return;
      const currentTarget = followTargetRef.current ?? target;
      latitude = currentTarget.latitude;
      longitude = currentTarget.longitude;
      heading = viewer.camera.heading;
      const targetPosition = Cesium.Cartesian3.fromDegrees(
        longitude,
        latitude,
        2,
      );
      viewer.camera.cancelFlight();
      viewer.camera.flyToBoundingSphere(
        new Cesium.BoundingSphere(targetPosition, 12),
        {
          duration: 2.2,
          offset: new Cesium.HeadingPitchRange(
            heading,
            Cesium.Math.toRadians(FOLLOW_CAMERA_PITCH),
            FOLLOW_CAMERA_RANGE,
          ),
          easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
          complete: () => {
            if (disposed || viewer.isDestroyed()) return;
            active = true;
            lastFrameTime = performance.now();
          },
        },
      );
    };

    if (viewer.scene.mode === Cesium.SceneMode.SCENE3D) {
      startFollowFlight();
    } else {
      setModeTransitioning(true);
      removeMorphListener = viewer.scene.morphComplete.addEventListener(() => {
        removeMorphListener?.();
        removeMorphListener = null;
        if (viewer.scene.mode === Cesium.SceneMode.SCENE3D) startFollowFlight();
      });
      viewer.scene.morphTo3D(1);
      viewer.scene.requestRender();
    }

    const removeFollow = viewer.scene.preRender.addEventListener(() => {
      if (disposed || !active || viewer.isDestroyed()) return;
      const currentTarget = followTargetRef.current;
      if (!currentTarget) return;
      const now = performance.now();
      const elapsedSeconds = Math.min((now - lastFrameTime) / 1000, 0.1);
      lastFrameTime = now;
      const smoothing = 1 - Math.exp(-4 * elapsedSeconds);
      latitude = Cesium.Math.lerp(latitude, currentTarget.latitude, smoothing);
      const longitudeDelta =
        ((currentTarget.longitude - longitude + 540) % 360) - 180;
      longitude += longitudeDelta * smoothing;
      if (viewer.scene.globe.tilesLoaded) {
        heading = (heading + FOLLOW_ROTATION_RADIANS_PER_SECOND * elapsedSeconds) %
          (Math.PI * 2);
      }
      const cameraTarget = Cesium.Cartesian3.fromDegrees(longitude, latitude, 1.5);
      const currentCameraRange = Cesium.Cartesian3.distance(
        viewer.camera.positionWC,
        cameraTarget,
      );
      if (Number.isFinite(currentCameraRange)) {
        cameraRange = Cesium.Math.clamp(
          currentCameraRange,
          FOLLOW_MIN_CAMERA_RANGE,
          FOLLOW_MAX_CAMERA_RANGE,
        );
      }
      viewer.camera.lookAt(
        cameraTarget,
        new Cesium.HeadingPitchRange(
          heading,
          Cesium.Math.toRadians(FOLLOW_CAMERA_PITCH),
          cameraRange,
        ),
      );
    });

    return () => {
      disposed = true;
      active = false;
      removeMorphListener?.();
      removeFollow();
      followingRef.current = false;
      if (viewer.isDestroyed()) return;
      viewer.camera.cancelFlight();
      viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
      viewer.scene.globe.maximumScreenSpaceError = IDLE_TERRAIN_ERROR;
      viewer.scene.requestRenderMode = true;
      viewer.scene.requestRender();
    };
  }, [following, globeReady]);

  useEffect(() => {
    const viewer = viewerRef.current;
    const Cesium = cesiumRef.current;
    if (!viewer || !Cesium || !globeReady || viewer.isDestroyed()) return;

    if (following) {
      viewer.scene.requestRenderMode = false;
      return;
    }

    const shouldRotate =
      autoRotate &&
      worldViewRef.current &&
      viewer.scene.mode === Cesium.SceneMode.SCENE3D;
    viewer.scene.requestRenderMode = !shouldRotate;
    if (!shouldRotate) {
      viewer.scene.requestRender();
      return;
    }

    let previousFrameTime = performance.now();
    const rotateGlobe = () => {
      if (viewer.isDestroyed()) return;
      const currentFrameTime = performance.now();
      const elapsedSeconds = Math.min((currentFrameTime - previousFrameTime) / 1000, 0.1);
      previousFrameTime = currentFrameTime;
      if (elapsedSeconds > 0 && viewer.scene.globe.tilesLoaded) {
        viewer.camera.rotate(
          Cesium.Cartesian3.UNIT_Z,
          -GLOBE_ROTATION_RADIANS_PER_SECOND * elapsedSeconds,
        );
      }

    };
    const removeRotationListener = viewer.scene.preRender.addEventListener(rotateGlobe);
    const pauseForNavigation = () => {
      worldViewRef.current = false;
      setAutoRotate(false);
      setSearchMessage("Globe rotation paused for map navigation.");
    };
    viewer.canvas.addEventListener("pointerdown", pauseForNavigation, { passive: true });
    viewer.canvas.addEventListener("wheel", pauseForNavigation, { passive: true });
    viewer.canvas.addEventListener("touchstart", pauseForNavigation, { passive: true });
    viewer.canvas.addEventListener("keydown", pauseForNavigation);

    return () => {
      removeRotationListener();
      viewer.canvas.removeEventListener("pointerdown", pauseForNavigation);
      viewer.canvas.removeEventListener("wheel", pauseForNavigation);
      viewer.canvas.removeEventListener("touchstart", pauseForNavigation);
      viewer.canvas.removeEventListener("keydown", pauseForNavigation);
      if (!viewer.isDestroyed()) {
        viewer.scene.requestRenderMode = true;
        viewer.scene.requestRender();
      }
    };
  }, [autoRotate, following, globeReady]);

  useEffect(() => {
    const viewer = viewerRef.current;
    const Cesium = cesiumRef.current;
    const latitude = telemetry?.gps.latitude;
    const longitude = telemetry?.gps.longitude;
    followTargetRef.current =
      typeof latitude === "number" && typeof longitude === "number"
        ? { latitude, longitude }
        : null;
    if (
      !viewer ||
      !Cesium ||
      !globeReady ||
      latitude === null ||
      latitude === undefined ||
      longitude === null ||
      longitude === undefined
    ) {
      if (markerRef.current) markerRef.current.show = false;
      return;
    }

    const position = Cesium.Cartesian3.fromDegrees(longitude, latitude, 1.5);
    if (!markerRef.current) {
      markerRef.current = viewer.entities.add({
        name: `Robot ${telemetry?.robotId ?? ""}`,
        position: new Cesium.ConstantPositionProperty(position),
        billboard: {
          image: "/logorobotpng.png",
          width: ROBOT_MARKER_SIZE,
          height: ROBOT_MARKER_SIZE,
          scale: new Cesium.CallbackProperty(
            () => followingRef.current
              ? 1 + 0.08 * (
                0.5 +
                0.5 * Math.sin((performance.now() * Math.PI * 2) / ROBOT_MARKER_PULSE_PERIOD_MS)
              )
              : 1,
            false,
          ),
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: `FIRELINE · ${(telemetry?.robotId ?? "ROBOT").toUpperCase()}`,
          font: "600 13px system-ui, sans-serif",
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.fromCssColorString("#101719"),
          outlineWidth: 3,
          showBackground: true,
          backgroundColor: Cesium.Color.fromCssColorString("#101719").withAlpha(0.82),
          pixelOffset: new Cesium.Cartesian2(0, 24),
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 2_000_000),
          scaleByDistance: new Cesium.NearFarScalar(500, 1, 2_000_000, 0.45),
          disableDepthTestDistance: 100_000,
        },
      });
    } else {
      markerRef.current.show = true;
      markerRef.current.name = `Robot ${telemetry?.robotId ?? ""}`;
      markerRef.current.position = new Cesium.ConstantPositionProperty(position);
      if (markerRef.current.billboard) {
        markerRef.current.billboard.width = new Cesium.ConstantProperty(ROBOT_MARKER_SIZE);
        markerRef.current.billboard.height = new Cesium.ConstantProperty(ROBOT_MARKER_SIZE);
      }
      if (markerRef.current.label) {
        markerRef.current.label.text = new Cesium.ConstantProperty(
          `FIRELINE · ${(telemetry?.robotId ?? "ROBOT").toUpperCase()}`,
        );
      }
    }
    viewer.scene.requestRender();

    if (!initialPositionHandledRef.current) {
      initialPositionHandledRef.current = true;
      worldViewRef.current = false;
      setAutoRotate(false);
      if (!userNavigatedRef.current) {
        viewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(longitude, latitude, 1400),
          duration: 2,
          easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
        });
      }
    }

  }, [globeReady, telemetry?.gps.latitude, telemetry?.gps.longitude, telemetry?.robotId]);

  const flyTo = (coordinates: Coordinates, height: number, label?: string) => {
    const viewer = viewerRef.current;
    const Cesium = cesiumRef.current;
    if (!viewer || viewer.isDestroyed() || !Cesium) {
      setSearchMessage("The 3D globe is still loading. Try again in a moment.");
      return false;
    }

    userNavigatedRef.current = true;
    worldViewRef.current = false;
    setAutoRotate(false);
    viewer.trackedEntity = undefined;
    setFollowing(false);
    if (label) {
      const locationPosition = Cesium.Cartesian3.fromDegrees(
        coordinates.longitude,
        coordinates.latitude,
        35,
      );
      const locationLabel = {
        text: label,
        font: "600 15px system-ui, sans-serif",
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.fromCssColorString("#101719"),
        outlineWidth: 3,
        showBackground: true,
        backgroundColor: Cesium.Color.fromCssColorString("#101719").withAlpha(0.84),
        pixelOffset: new Cesium.Cartesian2(0, -8),
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        heightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 5_000_000),
        scaleByDistance: new Cesium.NearFarScalar(500, 1, 5_000_000, 0.35),
        disableDepthTestDistance: 100_000,
      };
      if (selectedLocationRef.current) {
        selectedLocationRef.current.position = new Cesium.ConstantPositionProperty(locationPosition);
        selectedLocationRef.current.label = new Cesium.LabelGraphics(locationLabel);
      } else {
        selectedLocationRef.current = viewer.entities.add({
          name: label,
          position: new Cesium.ConstantPositionProperty(locationPosition),
          point: {
            pixelSize: 8,
            color: Cesium.Color.fromCssColorString("#ffc56b"),
            outlineColor: Cesium.Color.fromCssColorString("#101719"),
            outlineWidth: 2,
            heightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
          },
          label: locationLabel,
        });
      }
    }
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        coordinates.longitude,
        coordinates.latitude,
        height,
      ),
      duration: 2,
      easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
    });
    return true;
  };

  const searchLocation = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const searchTerm = query.trim();
    if (!searchTerm || searching) return;
    setSearchFocused(false);
    setSuggestions([]);

    const coordinateSearch = parseCoordinates(searchTerm);
    if (coordinateSearch) {
      if (flyTo(coordinateSearch, 1800)) {
        setSearchMessage(
          `Showing ${coordinateSearch.latitude.toFixed(5)}, ${coordinateSearch.longitude.toFixed(5)}.`,
        );
      }
      return;
    }

    if (/^-?\d+(?:\.\d+)?\s*[,;]\s*-?\d+(?:\.\d+)?$/.test(searchTerm)) {
      setSearchMessage("Coordinates are out of range. Latitude must be ±90 and longitude ±180.");
      return;
    }

    const timeSinceLastSearch = Date.now() - lastSearchAtRef.current;
    if (timeSinceLastSearch < 1000) {
      setSearchMessage("Wait a moment before searching for another place.");
      return;
    }

    lastSearchAtRef.current = Date.now();
    setSearching(true);
    setSearchMessage("");
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(
        `https://photon.komoot.io/api/?q=${encodeURIComponent(searchTerm)}&limit=3&lang=en`,
        { headers: { Accept: "application/json" }, signal: controller.signal },
      );
      if (!response.ok) throw new Error(`Place search returned HTTP ${response.status}.`);

      const [result] = readPlaceResults(await response.json());
      if (!result) {
        setSearchMessage("No place found. Try another name or enter latitude, longitude.");
        return;
      }
      if (flyTo(result, 6500, result.label)) {
        setSearchMessage(`Showing ${result.label}.`);
      }
    } catch (error: unknown) {
      console.error("Unable to search for a map location.", error);
      setSearchMessage(
        error instanceof DOMException && error.name === "AbortError"
          ? "Place search timed out. Try again or enter coordinates."
          : "Place search failed. Check your connection or enter coordinates.",
      );
    } finally {
      window.clearTimeout(timeout);
      setSearching(false);
    }
  };

  const selectSuggestion = (result: PlaceResult) => {
    setSearchFocused(false);
    setSuggestions([]);
    setQuery(result.label);
    if (flyTo(result, 6500, result.label)) {
      setSearchMessage(`Showing ${result.label}.`);
    }
  };

  const goToRobot = () => {
    const latitude = telemetry?.gps.latitude;
    const longitude = telemetry?.gps.longitude;
    if (
      latitude === null ||
      latitude === undefined ||
      longitude === null ||
      longitude === undefined
    ) {
      setSearchMessage("Waiting for a valid robot GPS fix.");
      return;
    }
    if (flyTo({ latitude, longitude }, 1400)) {
      setSearchMessage("Showing the robot’s current position.");
    }
  };

  const toggleFollow = () => {
    const viewer = viewerRef.current;
    const Cesium = cesiumRef.current;
    if (!viewer || !Cesium || !followTargetRef.current || viewer.isDestroyed()) {
      setSearchMessage("A robot GPS fix is needed before follow can start.");
      return;
    }

    userNavigatedRef.current = true;
    worldViewRef.current = false;
    setAutoRotate(false);
    if (following) {
      setFollowing(false);
      setSearchMessage("Robot follow paused.");
    } else {
      setModeTransitioning(viewer.scene.mode !== Cesium.SceneMode.SCENE3D);
      setFollowing(true);
      setSearchMessage(FOLLOW_STATUS_MESSAGE);
    }
  };

  const goToWorld = (resumeRotation = false) => {
    const viewer = viewerRef.current;
    const Cesium = cesiumRef.current;
    if (!viewer || viewer.isDestroyed() || !Cesium) return;

    userNavigatedRef.current = true;
    worldViewRef.current = true;
    viewer.trackedEntity = undefined;
    setFollowing(false);
    setAutoRotate(false);
    setSearchMessage("Showing the full globe.");
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(0, 20, 20_000_000),
      duration: 2.4,
      easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
      complete: () => {
        if (!viewer.isDestroyed() && resumeRotation) {
          setAutoRotate(true);
        }
      },
    });
  };

  const toggleGlobeRotation = () => {
    if (autoRotate) {
      setAutoRotate(false);
      setSearchMessage("Globe rotation paused.");
      return;
    }
    goToWorld(true);
  };

  const toggleViewMode = () => {
    const viewer = viewerRef.current;
    const Cesium = cesiumRef.current;
    if (!viewer || viewer.isDestroyed() || !Cesium) return;

    setAutoRotate(false);
    if (following) {
      setFollowing(false);
      viewer.camera.cancelFlight();
      viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    }
    setModeTransitioning(true);
    if (viewer.scene.mode === Cesium.SceneMode.SCENE2D) {
      worldViewRef.current = true;
      setViewMode("3D");
      viewer.scene.morphTo3D(1.2);
      viewer.scene.requestRender();
      setSearchMessage("Switching to the 3D globe.");
      return;
    }

    worldViewRef.current = false;
    setViewMode("2D");
    viewer.scene.morphTo2D(1.2);
    viewer.scene.requestRender();
    setSearchMessage("Switching to the 2D map.");
  };

  return (
    <>
      <div
        ref={containerRef}
        className="cesium-viewport"
        role="img"
        aria-label="Interactive 3D map showing the robot's GPS position"
      />
      <div
        id="map-navigation-controls"
        className="map-navigation"
        aria-label="3D map navigation"
        hidden={!controlsVisible}
      >
        <form
          className="map-search-form"
          onSubmit={searchLocation}
          onBlur={(event) => {
            const nextTarget = event.relatedTarget;
            if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
              setSearchFocused(false);
            }
          }}
        >
          <label className="visually-hidden" htmlFor="map-location-search">
            Search a place or enter latitude, longitude
          </label>
          <input
            id="map-location-search"
            className="map-search-input"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onFocus={() => setSearchFocused(true)}
            placeholder="Place or 23.8103, 90.4125"
            autoComplete="off"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={searchFocused && !searchIsCoordinates}
            aria-controls="map-search-suggestions"
            disabled={!globeReady || searching}
          />
          <button type="submit" className="map-search-button" disabled={!globeReady || searching || !query.trim()}>
            <Search size={15} />
            <span>{searching ? "Searching…" : "Go"}</span>
          </button>
          <div
            id="map-search-suggestions"
            className="map-search-suggestions"
            role="region"
            aria-label="Recommended places"
            hidden={!searchFocused || searchIsCoordinates}
          >
            {searchQuery.length < 3 ? (
              <p className="map-search-suggestion-message" role="status">
                Type 3 or more characters to see recommended places.
              </p>
            ) : suggestionsLoading ? (
              <p className="map-search-suggestion-message" role="status">
                Searching recommended places…
              </p>
            ) : suggestionError ? (
              <p className="map-search-suggestion-message" role="status">
                {suggestionError}
              </p>
            ) : (
              <>
                <p className="map-search-suggestions-heading">Recommended places</p>
                <div role="listbox" aria-label="Place suggestions">
                  {suggestions.map((result) => (
                    <button
                      key={`${result.label}-${result.latitude}-${result.longitude}`}
                      type="button"
                      className="map-search-suggestion"
                      role="option"
                      aria-selected={false}
                      onPointerDown={(event) => event.preventDefault()}
                      onClick={() => selectSuggestion(result)}
                    >
                      {result.label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </form>
        <div className="map-navigation-actions">
          <button
            type="button"
            className={`map-navigation-button ${viewMode === "3D" ? "is-selected" : ""}`}
            onClick={toggleViewMode}
            aria-label={`Switch to ${viewMode === "3D" ? "2D map" : "3D globe"}`}
            title={`Switch to ${viewMode === "3D" ? "2D map" : "3D globe"}`}
            disabled={!globeReady || modeTransitioning}
          >
            <Globe size={15} />
            <span>{viewMode === "3D" ? "3D" : "2D"}</span>
          </button>
          <button type="button" className="map-navigation-button" onClick={goToRobot} disabled={!globeReady}>
            <LocateFixed size={15} />
            <span>Robot</span>
          </button>
          <button
            type="button"
            className={`map-navigation-button ${following ? "is-selected" : ""}`}
            onClick={toggleFollow}
            aria-pressed={following}
            disabled={!globeReady || modeTransitioning}
          >
            <span className="follow-indicator" />
            <span>{following ? "Following" : "Follow"}</span>
          </button>
          <button type="button" className="map-navigation-button" onClick={() => goToWorld()} disabled={!globeReady}>
            <Globe size={15} />
            <span>World</span>
          </button>
          <button
            type="button"
            className={`map-navigation-button ${autoRotate ? "is-selected" : ""}`}
            onClick={toggleGlobeRotation}
            aria-pressed={autoRotate}
            aria-label={autoRotate ? "Pause globe rotation" : "Rotate the full globe"}
            disabled={!globeReady || viewMode !== "3D"}
          >
            <RotateCw size={15} />
            <span>{autoRotate ? "Pause" : "Spin"}</span>
          </button>
        </div>
        <p
          className={`map-navigation-status ${
            following && searchMessage === FOLLOW_STATUS_MESSAGE ? "is-following" : ""
          }`}
          role="status"
          aria-live="polite"
        >
          {searchMessage || (globeError ? "3D map unavailable." : "Search a place or enter GPS coordinates.")}
        </p>
        <div className="map-data-status" aria-label="Map data status">
          <span>Terrain: {terrainStatus}</span>
          <span>3D buildings: {buildingStatus}</span>
        </div>
        <div
          className="map-robot-location"
          role="group"
          aria-live="polite"
          aria-label={`Robot location: ${robotAddress}; ${robotCoordinates}`}
          title={`${robotAddress} · ${robotCoordinates}`}
        >
          <span className="map-robot-address">{robotAddress}</span>
          <span className="map-robot-coordinates">{robotCoordinates}</span>
        </div>
      </div>
      {globeError && (
        <div className="map-overlay map-error-overlay" role="alert">
          <div className="map-overlay-copy">
            <strong>3D map unavailable</strong>
            <span>Check network access, then reload the dashboard.</span>
          </div>
        </div>
      )}
    </>
  );
}

export default memo(CesiumMap, shouldSkipMapRender);
