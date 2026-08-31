import React, { useEffect, useRef, useState, useCallback } from "react";
import * as THREE from "three";

/**
 * VirtualEngine
 *
 * 3D visualization + telemetry engine.
 *
 * DATA FLOW:
 *
 * LIVE HARDWARE / MOCK DATA
 *          ↓
 *    telemetry object
 *          ↓
 *     Fault Injection
 *          ↓
 *     Virtual Engine
 *          ↓
 *     Render API
 *          ↓
 * Prediction Dashboard
 */

// ==========================================================
// RENDER TELEMETRY API
// ==========================================================

const TELEMETRY_API =
  "https://virtual-engine-api.onrender.com/api/telemetry";

const TELEMETRY_SEND_INTERVAL = 200;

// ==========================================================
// REFERENCE RANGES
// ==========================================================

const BASELINE = {
  rpm: [4800, 5300],
  cht_c: [95, 125],
  egt_c: [620, 720],
  oil_press_bar: [2.5, 4.2],
  oil_temp_c: [85, 105],
  fuel_flow_lph: [14, 18],
  vibration_g: [0.05, 0.15],
  battery_v: [13.8, 14.4],
  injection_deg: [20, 25],
};

// ==========================================================
// FAULT TYPES
// ==========================================================

const FAULT_TYPES = [
  { id: "none", label: "Normal" },
  { id: "misfire", label: "Misfire" },
  { id: "injector_abnormality", label: "Injector Fault" },
  { id: "coking_degradation", label: "Coking" },
  { id: "lubrication_issue", label: "Lubrication" },
  { id: "sensor_drift", label: "Sensor Drift" },
  { id: "combustion_instability", label: "Combustion Instability" },
];

// ==========================================================
// MISSION PROFILES
// ==========================================================

const MISSION_PROFILES = [
  { id: "normal_cruise", label: "Normal Cruise" },
  { id: "high_altitude", label: "High Altitude" },
  { id: "hot_weather", label: "Hot Weather" },
  { id: "rapid_throttle", label: "Rapid Throttle" },
];

// ==========================================================
// HARDWARE DATA SOURCE
// ==========================================================

const DEFAULT_HARDWARE_MODE = "live";

const WS_URL = "ws://esp32-sensor.local:81";

// ==========================================================
// HARDWARE FIELD CONFIG
// ==========================================================

const HARDWARE_FIELD_CONFIG = {
  vibration_g: {
    available: true,
    sensor: "MPU6050 (accelerometer, high-frequency component)",
  },
  roll_deg: {
    available: true,
    sensor: "MPU6050 (accelerometer, tilt/gravity vector)",
  },
  pitch_deg: {
    available: true,
    sensor: "MPU6050 (accelerometer, tilt/gravity vector)",
  },
  yaw_deg: {
    available: true,
    sensor:
      "MPU6050 (gyroscope, integrated -- drifts over time, no magnetometer to correct it)",
  },
  rpm: {
    available: true,
    sensor: "IR Wide Optical Slot Sensor (pulse counting on a slotted disc)",
  },
  cht_c: {
    available: true,
    sensor: "LM35 (analog temperature sensor)",
  },
};

const HARDWARE_FIELDS = Object.entries(HARDWARE_FIELD_CONFIG)
  .filter(([, cfg]) => cfg.available)
  .map(([field]) => field);

// ==========================================================
// RAW HARDWARE -> REALISTIC UAV RANGE MAPPING
// ==========================================================

const RAW_HARDWARE_RANGE = {
  rpm: [0, 9000],
  cht_c: [10, 300],
  vibration_g: [0.0306, 1.13],
};

const MAPPED_TARGET_RANGE = {
  rpm: [0, 5500],
  cht_c: [95, 150],
  vibration_g: [0.05, 0.3],
};

const RAW_TO_REALISTIC_FIELDS = ["rpm", "cht_c", "vibration_g"];

function mapRawToRealistic(value, rawRange, targetRange) {
  const [rawLo, rawHi] = rawRange;
  const [targetLo, targetHi] = targetRange;

  if (typeof value !== "number" || Number.isNaN(value)) return targetLo;

  const clamped = Math.max(rawLo, Math.min(rawHi, value));

  const t =
    rawHi - rawLo === 0
      ? 0
      : (clamped - rawLo) / (rawHi - rawLo);

  return targetLo + t * (targetHi - targetLo);
}

// ==========================================================
// DESIGN COLORS
// ==========================================================

const COLORS = {
  bg: "#0a0c10",
  panel: "#12161c",
  panelBorder: "#242c36",
  panelBorderLit: "#33404e",
  textPrimary: "#eef2f6",
  textMuted: "#7c8794",
  cyan: "#5fe3ff",
  violet: "#b18cff",
  green: "#3ee085",
  amber: "#ffb648",
  red: "#ff5b5b",
};

// ==========================================================
// HELPERS
// ==========================================================

function randIn([lo, hi]) {
  return lo + Math.random() * (hi - lo);
}

function gaussianNoise() {
  const u1 = Math.random() || 1e-6;
  const u2 = Math.random();

  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function baseReading() {
  const r = {};

  for (const [k, band] of Object.entries(BASELINE)) {
    r[k] = randIn(band);
  }

  return r;
}

// ==========================================================
// EXISTING FAULT APPLICATION
// ==========================================================
//
// These are the existing simulation effects.
//
// IMPORTANT:
// Misfire is intentionally NOT handled here anymore.
// Snehal's exact Misfire signature is applied later,
// after hardware/mock processing.
// ==========================================================

function applyFault(r, fault, secondsSinceFaultStart) {
  switch (fault) {
    case "injector_abnormality": {
      const expected = 14 + (r.rpm - 4800) / 500;

      r.fuel_flow_lph = Math.max(
        2,
        expected +
          (3 + Math.random() * 3) *
            (Math.random() < 0.5 ? -1 : 1)
      );

      break;
    }

    case "coking_degradation": {
      const drift = Math.min(
        secondsSinceFaultStart * 0.35,
        25
      );

      r.egt_c += drift;
      r.cht_c += drift * 0.3;

      break;
    }

    case "lubrication_issue": {
      const drift = Math.min(
        secondsSinceFaultStart * 0.06,
        2.5
      );

      r.oil_press_bar -= drift;
      r.oil_temp_c += drift * 12;

      break;
    }

    case "sensor_drift": {
      const drift = Math.min(
        secondsSinceFaultStart * 0.6,
        40
      );

      r.egt_c += drift;

      break;
    }

    case "combustion_instability":
      r.vibration_g += Math.abs(
        gaussianNoise() * 0.12
      );

      r.rpm += gaussianNoise() * 120;

      break;

    default:
      break;
  }

  return r;
}

// ==========================================================
// SNEHAL'S PREDICTION FAULT SIGNATURES
// ==========================================================
//
// These values are the actual abnormal sensor readings
// sent to the prediction engine.
//
// MISFIRE:
// RPM        4400 - 4750
// CHT        100  - 135 °C
// EGT        540  - 620 °C
// Vibration  0.18 - 0.40 g
//
// This is the JavaScript equivalent of:
//
// if fault == "misfire":
//     rpm = random.uniform(4400, 4750)
//     cht = random.uniform(100, 135)
//     egt = random.uniform(540, 620)
//     vibration = random.uniform(0.18, 0.40)
// ==========================================================

function applyPredictionFault(r, fault) {
  switch (fault) {
    case "misfire":
      r.rpm = randIn([4400, 4750]);

      r.cht_c = randIn([100, 135]);

      r.egt_c = randIn([540, 620]);

      r.vibration_g = randIn([0.18, 0.40]);

      break;

    default:
      break;
  }

  return r;
}

// ==========================================================
// MISSION PROFILE
// ==========================================================

function applyMissionProfile(r, profile) {
  switch (profile) {
    case "high_altitude":
      r.cht_c += 12;
      r.egt_c += 20;
      r.oil_press_bar -= 0.3;
      break;

    case "hot_weather":
      r.cht_c += 15;
      r.oil_temp_c += 12;
      break;

    case "rapid_throttle":
      r.rpm += gaussianNoise() * 250;
      r.vibration_g += Math.abs(
        gaussianNoise() * 0.08
      );
      break;

    default:
      break;
  }

  return r;
}

// ==========================================================
// NORMALIZE
// ==========================================================

function normalize(val, [lo, hi]) {
  return Math.max(
    0,
    Math.min(1, (val - lo) / (hi - lo))
  );
}

// ==========================================================
// RANDOM WALK
// ==========================================================

function stepWalk(prev, band, stepScale = 0.06) {
  const [lo, hi] = band;
  const range = hi - lo;

  const next =
    prev +
    (Math.random() - 0.5) *
      range *
      stepScale;

  return Math.max(
    lo - range * 0.15,
    Math.min(
      hi + range * 0.15,
      next
    )
  );
}

// ==========================================================
// ACCELEROMETER HELPERS
// ==========================================================

function computeTiltFromAccel(ax, ay, az) {
  const roll_deg =
    (Math.atan2(ay, az) * 180) / Math.PI;

  const pitch_deg =
    (Math.atan2(
      -ax,
      Math.sqrt(ay * ay + az * az)
    ) *
      180) /
    Math.PI;

  return {
    roll_deg,
    pitch_deg,
  };
}

function computeVibrationFromAccelBuffer(
  accelSamples
) {
  if (!accelSamples.length) return 0;

  const magnitudes = accelSamples.map(
    ({ ax, ay, az }) =>
      Math.sqrt(
        ax * ax +
          ay * ay +
          az * az
      )
  );

  const withoutGravity = magnitudes.map(
    (m) => Math.abs(m - 1.0)
  );

  const mean =
    withoutGravity.reduce(
      (a, b) => a + b,
      0
    ) /
    withoutGravity.length;

  return mean;
}

// ==========================================================
// COLOR INTERPOLATION
// ==========================================================

function lerpColor(c1, c2, t) {
  const a = new THREE.Color(c1);
  const b = new THREE.Color(c2);

  return a.lerp(
    b,
    Math.max(0, Math.min(1, t))
  );
}

// ==========================================================
// SEND TELEMETRY TO RENDER
// ==========================================================

async function sendTelemetryToServer(
  telemetry,
  metadata = {}
) {
  try {
    const payload = {
      ...telemetry,

      data_source:
        metadata.data_source ||
        "unknown",

      fault:
        metadata.fault ||
        "none",

      mission_profile:
        metadata.mission_profile ||
        "normal_cruise",

      anomaly_score:
        typeof metadata.anomaly_score ===
        "number"
          ? Number(
              metadata.anomaly_score.toFixed(4)
            )
          : 0,

      status:
        metadata.status ||
        "Normal",

      timestamp:
        new Date().toISOString(),
    };

    const response = await fetch(
      TELEMETRY_API,
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/json",
        },
        body: JSON.stringify(payload),
      }
    );

    if (!response.ok) {
      console.error(
        "Telemetry API error:",
        response.status
      );
    }
  } catch (error) {
    console.error(
      "Could not send telemetry to Render:",
      error
    );
  }
}

// ==========================================================
// MAIN COMPONENT
// ==========================================================

export default function VirtualEngine() {
  const mountRef = useRef(null);

  const threeRef = useRef({});

  const simRef = useRef({
    activeFault: "none",
    missionProfile: "normal_cruise",
    faultStartTime: null,
    anomalyScore: 0,
    scoreHistory: [],
    reading: baseReading(),
  });

  const hardwareRef = useRef({
    rpm: randIn(BASELINE.rpm),
    vibration_g: randIn(
      BASELINE.vibration_g
    ),
    cht_c: randIn(BASELINE.cht_c),
    roll_deg: 0,
    pitch_deg: 0,
    yaw_deg: 0,
  });

  const accelBufferRef = useRef([]);

  const [hardwareMode, setHardwareMode] =
    useState(
      DEFAULT_HARDWARE_MODE
    );

  const [
    dataSourceStatus,
    setDataSourceStatus,
  ] = useState(
    DEFAULT_HARDWARE_MODE === "mock"
      ? "Mock hardware (manual mock mode)"
      : "Connecting to ESP32..."
  );

  const [telemetry, setTelemetry] =
    useState(
      simRef.current.reading
    );

  const [anomalyScore, setAnomalyScore] =
    useState(0);

  const [status, setStatus] =
    useState("Normal");

  const [
    reliability,
    setReliability,
  ] = useState(
    "Stable, no degradation trend detected"
  );

  const [activeFault, setActiveFault] =
    useState("none");

  const [
    missionProfile,
    setMissionProfile,
  ] = useState("normal_cruise");

  const [paused, setPaused] =
    useState(false);

  const [soundOn, setSoundOn] =
    useState(false);

  const soundOnRef =
    useRef(false);

  useEffect(() => {
    soundOnRef.current =
      soundOn;
  }, [soundOn]);

  const audioRef =
    useRef({});

  // ========================================================
  // AUDIO
  // ========================================================

  const initAudio = useCallback(() => {
    if (audioRef.current.ctx)
      return;

    const ctx =
      new (
        window.AudioContext ||
        window.webkitAudioContext
      )();

    const engineOsc =
      ctx.createOscillator();

    engineOsc.type =
      "sawtooth";

    const subOsc =
      ctx.createOscillator();

    subOsc.type =
      "square";

    const filter =
      ctx.createBiquadFilter();

    filter.type =
      "lowpass";

    filter.frequency.value =
      400;

    const engineGain =
      ctx.createGain();

    engineGain.gain.value =
      0.0001;

    engineOsc.connect(filter);
    subOsc.connect(filter);

    filter.connect(
      engineGain
    );

    engineGain.connect(
      ctx.destination
    );

    engineOsc.start();
    subOsc.start();

    const alertOsc =
      ctx.createOscillator();

    alertOsc.type =
      "sine";

    alertOsc.frequency.value =
      880;

    const alertGain =
      ctx.createGain();

    alertGain.gain.value =
      0;

    alertOsc.connect(
      alertGain
    );

    alertGain.connect(
      ctx.destination
    );

    alertOsc.start();

    audioRef.current = {
      ctx,
      engineOsc,
      subOsc,
      filter,
      engineGain,
      alertOsc,
      alertGain,
      beepPhase: 0,
    };
  }, []);

  const toggleSound =
    useCallback(() => {
      initAudio();

      const a =
        audioRef.current;

      if (
        a.ctx?.state ===
        "suspended"
      ) {
        a.ctx.resume();
      }

      setSoundOn((on) => {
        if (a.engineGain) {
          a.engineGain.gain.setTargetAtTime(
            on
              ? 0.0001
              : 0.05,
            a.ctx.currentTime,
            0.15
          );
        }

        return !on;
      });
    }, [initAudio]);

  // ========================================================
  // FAULT CONTROL
  // ========================================================

  const setFault =
    useCallback((id) => {
      simRef.current.activeFault =
        id;

      simRef.current.faultStartTime =
        id === "none"
          ? null
          : Date.now();

      if (id === "none") {
        simRef.current.anomalyScore = 0;
        simRef.current.scoreHistory =
          [];
      }

      setActiveFault(id);
    }, []);

  // ========================================================
  // MISSION CONTROL
  // ========================================================

  const setMission =
    useCallback((id) => {
      simRef.current.missionProfile =
        id;

      setMissionProfile(id);
    }, []);

  // ========================================================
  // HARDWARE DATA SOURCE
  // ========================================================

  useEffect(() => {
    if (
      hardwareMode === "mock"
    ) {
      setDataSourceStatus(
        "Mock hardware (manual mock mode)"
      );

      const walk =
        setInterval(() => {
          const h =
            hardwareRef.current;

          h.rpm =
            stepWalk(
              h.rpm,
              BASELINE.rpm
            );

          h.vibration_g =
            Math.max(
              0,
              stepWalk(
                h.vibration_g,
                BASELINE.vibration_g,
                0.15
              )
            );

          h.cht_c =
            stepWalk(
              h.cht_c,
              BASELINE.cht_c
            );

          h.roll_deg =
            Math.max(
              -25,
              Math.min(
                25,
                h.roll_deg +
                  (Math.random() -
                    0.5) *
                    2
              )
            );

          h.pitch_deg =
            Math.max(
              -25,
              Math.min(
                25,
                h.pitch_deg +
                  (Math.random() -
                    0.5) *
                    2
              )
            );

          h.yaw_deg =
            (h.yaw_deg +
              (Math.random() -
                0.5) *
                3 +
              360) %
            360;
        }, 200);

      return () =>
        clearInterval(walk);
    }

    let ws;
    let reconnectTimer;
    let cancelled = false;

    const connect = () => {
      if (cancelled) return;

      setDataSourceStatus(
        "Connecting to ESP32..."
      );

      try {
        ws =
          new WebSocket(
            WS_URL
          );

        ws.onopen = () => {
          setDataSourceStatus(
            "Live -- ESP32 connected"
          );
        };

        ws.onmessage = (
          evt
        ) => {
          try {
            const msg =
              JSON.parse(
                evt.data
              );

            for (const field of HARDWARE_FIELDS) {
              if (
                typeof msg[field] ===
                "number"
              ) {
                hardwareRef.current[
                  field
                ] = msg[field];
              }
            }

            if (
              typeof msg.ax ===
                "number" &&
              typeof msg.ay ===
                "number" &&
              typeof msg.az ===
                "number"
            ) {
              accelBufferRef.current.push(
                {
                  ax: msg.ax,
                  ay: msg.ay,
                  az: msg.az,
                }
              );

              if (
                accelBufferRef.current
                  .length > 20
              ) {
                accelBufferRef.current.shift();
              }

              const tilt =
                computeTiltFromAccel(
                  msg.ax,
                  msg.ay,
                  msg.az
                );

              if (
                !HARDWARE_FIELD_CONFIG
                  .roll_deg
                  .available
              ) {
                hardwareRef.current.roll_deg =
                  tilt.roll_deg;
              }

              if (
                !HARDWARE_FIELD_CONFIG
                  .pitch_deg
                  .available
              ) {
                hardwareRef.current.pitch_deg =
                  tilt.pitch_deg;
              }

              if (
                !HARDWARE_FIELD_CONFIG
                  .vibration_g
                  .available
              ) {
                hardwareRef.current.vibration_g =
                  computeVibrationFromAccelBuffer(
                    accelBufferRef.current
                  );
              }
            }
          } catch {
            // Ignore malformed packets
          }
        };

        ws.onclose = () => {
          if (cancelled)
            return;

          setDataSourceStatus(
            "Signal lost -- reconnecting... (showing last known values)"
          );

          reconnectTimer =
            setTimeout(
              connect,
              1500
            );
        };

        ws.onerror = () => {
          if (ws) ws.close();
        };
      } catch {
        setDataSourceStatus(
          "ESP32 connection failed -- retrying..."
        );

        reconnectTimer =
          setTimeout(
            connect,
            1500
          );
      }
    };

    connect();

    return () => {
      cancelled = true;

      clearTimeout(
        reconnectTimer
      );

      if (ws) ws.close();
    };
  }, [hardwareMode]);

  // ========================================================
  // SIMULATION + TELEMETRY
  // ========================================================

  useEffect(() => {
    if (paused) return;

    const interval =
      setInterval(() => {
        const s =
          simRef.current;

        let r =
          baseReading();

        const secondsSinceFault =
          s.faultStartTime
            ? (Date.now() -
                s.faultStartTime) /
              1000
            : 0;

        // --------------------------------------------------
        // Existing fault/mission processing
        // --------------------------------------------------

        r = applyFault(
          r,
          s.activeFault,
          secondsSinceFault
        );

        r = applyMissionProfile(
          r,
          s.missionProfile
        );

        // --------------------------------------------------
        // Hardware fields
        // --------------------------------------------------

        const faultTouchesHardwareField =
          s.activeFault ===
            "misfire" ||
          s.activeFault ===
            "combustion_instability";

        for (
          const field of HARDWARE_FIELDS
        ) {
          if (
            faultTouchesHardwareField &&
            field ===
              "vibration_g"
          ) {
            continue;
          }

          if (
            faultTouchesHardwareField &&
            field === "rpm"
          ) {
            continue;
          }

          // Live Hardware:
          // map raw sensor values into realistic
          // UAV-engine-looking ranges.
          if (
            hardwareMode ===
              "live" &&
            RAW_TO_REALISTIC_FIELDS.includes(
              field
            )
          ) {
            r[field] =
              mapRawToRealistic(
                hardwareRef.current[
                  field
                ],
                RAW_HARDWARE_RANGE[
                  field
                ],
                MAPPED_TARGET_RANGE[
                  field
                ]
              );
          } else {
            r[field] =
              hardwareRef.current[
                field
              ];
          }
        }

        // --------------------------------------------------
        // IMPORTANT:
        // Apply Snehal's prediction-engine fault
        // AFTER hardware/mock processing.
        //
        // Therefore:
        //
        // Live Hardware + Misfire
        //          ↓
        // Snehal Misfire ranges
        //
        // Mock + Misfire
        //          ↓
        // Snehal Misfire ranges
        // --------------------------------------------------

        r = applyPredictionFault(
          r,
          s.activeFault
        );

        // --------------------------------------------------
        // ANOMALY SCORE
        // --------------------------------------------------

        let target = 0;

        if (
          s.activeFault !==
          "none"
        ) {
          const egtMid =
            (BASELINE.egt_c[0] +
              BASELINE.egt_c[1]) /
            2;

          const vibMid =
            (BASELINE.vibration_g[0] +
              BASELINE.vibration_g[1]) /
            2;

          const egtDev =
            Math.abs(
              r.egt_c -
                egtMid
            ) / 100;

          const vibDev =
            Math.abs(
              r.vibration_g -
                vibMid
            ) / 0.3;

          target =
            Math.min(
              1,
              (egtDev +
                vibDev) /
                2
            );
        }

        s.anomalyScore +=
          (target -
            s.anomalyScore) *
          0.15;

        const score =
          Math.max(
            0,
            Math.min(
              1,
              s.anomalyScore
            )
          );

        // --------------------------------------------------
        // SCORE HISTORY
        // --------------------------------------------------

        const now =
          Date.now();

        s.scoreHistory.push({
          t: now,
          score,
        });

        while (
          s.scoreHistory.length &&
          now -
            s.scoreHistory[0]
              .t >
            4000
        ) {
          s.scoreHistory.shift();
        }

        // --------------------------------------------------
        // RELIABILITY
        // --------------------------------------------------

        let reliabilityText =
          "Stable, no degradation trend detected";

        if (
          score >= 0.95
        ) {
          reliabilityText =
            "Critical -- immediate attention";
        } else if (
          score >= 0.15 &&
          s.scoreHistory.length >
            1
        ) {
          const t0 =
            s.scoreHistory[0].t;

          const xs =
            s.scoreHistory.map(
              (p) =>
                (p.t - t0) /
                1000
            );

          const ys =
            s.scoreHistory.map(
              (p) =>
                p.score
            );

          const n =
            xs.length;

          const mx =
            xs.reduce(
              (a, b) =>
                a + b,
              0
            ) / n;

          const my =
            ys.reduce(
              (a, b) =>
                a + b,
              0
            ) / n;

          let num = 0;
          let den = 0;

          for (
            let i = 0;
            i < n;
            i++
          ) {
            num +=
              (xs[i] -
                mx) *
              (ys[i] -
                my);

            den +=
              (xs[i] -
                mx) **
                2;
          }

          const rate =
            den > 0
              ? num / den
              : 0;

          if (
            rate > 0.01 &&
            (now - t0) /
              1000 >=
              2.5
          ) {
            const remaining =
              (0.95 -
                score) /
              rate;

            if (
              remaining >=
                0 &&
              remaining <=
                3600
            ) {
              reliabilityText =
                remaining <
                60
                  ? "Estimated <1 min to critical threshold at current degradation rate"
                  : `Estimated ~${Math.round(
                      remaining /
                        60
                    )} min to critical threshold at current degradation rate`;
            }
          }
        }

        // --------------------------------------------------
        // STATUS
        // --------------------------------------------------

        const newStatus =
          score < 0.3
            ? "Normal"
            : score < 0.65
            ? "Warning"
            : "Critical";

        // --------------------------------------------------
        // SAVE READING
        // --------------------------------------------------

        s.reading = r;

        threeRef.current.latest =
          {
            reading: r,
            score,
            fault:
              s.activeFault,
            mission:
              s.missionProfile,
          };

        setTelemetry({
          ...r,
        });

        setAnomalyScore(
          score
        );

        setStatus(
          newStatus
        );

        setReliability(
          reliabilityText
        );

        // --------------------------------------------------
        // SEND TO RENDER
        // --------------------------------------------------

        sendTelemetryToServer(
          r,
          {
            data_source:
              hardwareMode ===
              "live"
                ? "live_hardware"
                : "mock_data",

            fault:
              s.activeFault,

            mission_profile:
              s.missionProfile,

            anomaly_score:
              score,

            status:
              newStatus,
          }
        );

        // --------------------------------------------------
        // AUDIO
        // --------------------------------------------------

        const a =
          audioRef.current;

        if (
          a.ctx &&
          soundOnRef.current
        ) {
          const t0 =
            a.ctx.currentTime;

          const rpmFrac =
            r.rpm / 5500;

          const baseFreq =
            32 +
            rpmFrac *
              95;

          a.engineOsc.frequency.setTargetAtTime(
            baseFreq,
            t0,
            0.08
          );

          a.subOsc.frequency.setTargetAtTime(
            baseFreq *
              1.5,
            t0,
            0.08
          );

          a.filter.frequency.setTargetAtTime(
            300 +
              r.vibration_g *
                2200,
            t0,
            0.1
          );

          a.engineGain.gain.setTargetAtTime(
            0.04 +
              Math.min(
                r.vibration_g,
                0.5
              ) *
                0.08,
            t0,
            0.2
          );

          a.beepPhase +=
            0.2;

          const beepRate =
            newStatus ===
            "Critical"
              ? 0.28
              : newStatus ===
                "Warning"
              ? 0.65
              : null;

          const beepOn =
            beepRate &&
            a.beepPhase %
              beepRate <
              0.12;

          a.alertGain.gain.setTargetAtTime(
            beepOn
              ? newStatus ===
                "Critical"
                ? 0.06
                : 0.035
              : 0,
            t0,
            0.02
          );

          a.alertOsc.frequency.setTargetAtTime(
            newStatus ===
              "Critical"
              ? 1046
              : 880,
            t0,
            0.1
          );
        }
      }, TELEMETRY_SEND_INTERVAL);

    return () =>
      clearInterval(
        interval
      );
  }, [
    paused,
    hardwareMode,
  ]);

  // ========================================================
  // THREE.JS SCENE
  // ========================================================

  useEffect(() => {
    const mount =
      mountRef.current;

    const width =
      mount.clientWidth;

    const height =
      mount.clientHeight;

    const scene =
      new THREE.Scene();

    scene.background =
      new THREE.Color(
        COLORS.bg
      );

    scene.fog =
      new THREE.Fog(
        COLORS.bg,
        12,
        26
      );

    const camera =
      new THREE.PerspectiveCamera(
        42,
        width / height,
        0.1,
        100
      );

    let camTheta =
      0.55;

    let camPhi =
      1.2;

    let camRadius =
      13.5;

    const updateCamera =
      () => {
        camera.position.set(
          camRadius *
            Math.sin(
              camPhi
            ) *
            Math.sin(
              camTheta
            ),

          camRadius *
            Math.cos(
              camPhi
            ),

          camRadius *
            Math.sin(
              camPhi
            ) *
            Math.cos(
              camTheta
            )
        );

        camera.lookAt(
          0,
          0.4,
          0
        );
      };

    updateCamera();

    const renderer =
      new THREE.WebGLRenderer(
        {
          antialias: true,
        }
      );

    renderer.setSize(
      width,
      height
    );

    renderer.setPixelRatio(
      Math.min(
        window.devicePixelRatio,
        2
      )
    );

    mount.appendChild(
      renderer.domElement
    );

    scene.add(
      new THREE.AmbientLight(
        0x3d4a5c,
        0.85
      )
    );

    const key =
      new THREE.DirectionalLight(
        0xd8ecff,
        1.15
      );

    key.position.set(
      5,
      8,
      4
    );

    scene.add(key);

    const rim =
      new THREE.DirectionalLight(
        0x6fb8ff,
        0.5
      );

    rim.position.set(
      -6,
      3,
      -4
    );

    scene.add(rim);

    const fill =
      new THREE.DirectionalLight(
        0xffb87a,
        0.18
      );

    fill.position.set(
      2,
      -2,
      5
    );

    scene.add(fill);

    const grid =
      new THREE.GridHelper(
        20,
        20,
        0x1a222c,
        0x141a22
      );

    grid.position.y =
      -1.6;

    scene.add(grid);

    // ======================================================
    // ENGINE
    // ======================================================

    const engine =
      new THREE.Group();

    scene.add(engine);

    const metalMat =
      new THREE.MeshStandardMaterial(
        {
          color: 0x5c6875,
          metalness: 0.72,
          roughness: 0.32,
        }
      );

    const darkMat =
      new THREE.MeshStandardMaterial(
        {
          color: 0x272e37,
          metalness: 0.5,
          roughness: 0.5,
        }
      );

    const block =
      new THREE.Mesh(
        new THREE.BoxGeometry(
          3.2,
          1.2,
          1.8
        ),
        metalMat
      );

    block.position.set(
      0,
      0,
      0
    );

    engine.add(block);

    const cylMats = [];
    const cylMeshes = [];

    for (
      let i = 0;
      i < 4;
      i++
    ) {
      const mat =
        new THREE.MeshStandardMaterial(
          {
            color: 0x707c8a,
            metalness: 0.55,
            roughness: 0.35,
            emissive: 0x2a1a10,
            emissiveIntensity: 0.4,
          }
        );

      const mesh =
        new THREE.Mesh(
          new THREE.BoxGeometry(
            0.55,
            1.0,
            1.3
          ),
          mat
        );

      mesh.position.set(
        -1.15 +
          i *
            0.77,
        1.1,
        0
      );

      engine.add(mesh);

      cylMats.push(mat);
      cylMeshes.push(mesh);
    }

    const exhaustMat =
      new THREE.MeshStandardMaterial(
        {
          color: 0x363c43,
          metalness: 0.78,
          roughness: 0.25,
          emissive: 0x000000,
        }
      );

    const exhaustPipe =
      new THREE.Mesh(
        new THREE.CylinderGeometry(
          0.14,
          0.14,
          3.0,
          16
        ),
        exhaustMat
      );

    exhaustPipe.rotation.z =
      Math.PI / 2;

    exhaustPipe.position.set(
      0,
      0.35,
      1.15
    );

    engine.add(
      exhaustPipe
    );

    const exhaustBend =
      new THREE.Mesh(
        new THREE.TorusGeometry(
          0.4,
          0.14,
          12,
          24,
          Math.PI
        ),
        exhaustMat
      );

    exhaustBend.position.set(
      1.5,
      0.35,
      0.75
    );

    exhaustBend.rotation.y =
      Math.PI / 2;

    engine.add(
      exhaustBend
    );

    const flywheelMat =
      new THREE.MeshStandardMaterial(
        {
          color: 0x8a95a3,
          metalness: 0.82,
          roughness: 0.22,
        }
      );

    const flywheel =
      new THREE.Mesh(
        new THREE.CylinderGeometry(
          0.85,
          0.85,
          0.22,
          32
        ),
        flywheelMat
      );

    flywheel.rotation.x =
      Math.PI / 2;

    flywheel.position.set(
      -2.0,
      0,
      0
    );

    engine.add(flywheel);

    for (
      let i = 0;
      i < 4;
      i++
    ) {
      const spoke =
        new THREE.Mesh(
          new THREE.BoxGeometry(
            0.08,
            1.5,
            0.1
          ),
          darkMat
        );

      spoke.rotation.z =
        (Math.PI / 4) *
        i;

      flywheel.add(
        spoke
      );
    }

    const sumpMat =
      new THREE.MeshStandardMaterial(
        {
          color: 0x2f5f8a,
          metalness: 0.3,
          roughness: 0.5,
          emissive: 0x000000,
        }
      );

    const sump =
      new THREE.Mesh(
        new THREE.BoxGeometry(
          2.6,
          0.5,
          1.5
        ),
        sumpMat
      );

    sump.position.set(
      0,
      -0.85,
      0
    );

    engine.add(sump);

    const platform =
      new THREE.Mesh(
        new THREE.BoxGeometry(
          4.2,
          0.15,
          2.4
        ),
        darkMat
      );

    platform.position.set(
      0,
      -1.15,
      0
    );

    engine.add(platform);

    engine.position.set(
      -3.4,
      0.2,
      0
    );

    // ======================================================
    // AIRFRAME
    // ======================================================

    const airframe =
      new THREE.Group();

    const skinMat =
      new THREE.MeshStandardMaterial(
        {
          color: 0x8fa4b8,
          transparent: true,
          opacity: 0.13,
          roughness: 0.5,
          side: THREE.DoubleSide,
        }
      );

    const wireMat =
      new THREE.LineBasicMaterial(
        {
          color: 0x4fd8ff,
          transparent: true,
          opacity: 0.35,
        }
      );

    const fuselage =
      new THREE.Mesh(
        new THREE.CylinderGeometry(
          0.55,
          0.32,
          7.5,
          16
        ),
        skinMat
      );

    fuselage.rotation.z =
      Math.PI / 2;

    fuselage.position.set(
      -1.2,
      0.15,
      0
    );

    airframe.add(
      fuselage
    );

    airframe.add(
      new THREE.LineSegments(
        new THREE.EdgesGeometry(
          fuselage.geometry
        ),
        wireMat
      )
    );

    const wingGeo =
      new THREE.BoxGeometry(
        9.5,
        0.09,
        1.1
      );

    const wing =
      new THREE.Mesh(
        wingGeo,
        skinMat
      );

    wing.position.set(
      -1.6,
      0.1,
      0
    );

    airframe.add(wing);

    airframe.add(
      new THREE.LineSegments(
        new THREE.EdgesGeometry(
          wingGeo
        ),
        wireMat
      )
    );

    const boomMat =
      new THREE.MeshStandardMaterial(
        {
          color: 0x6b7684,
          metalness: 0.5,
          roughness: 0.4,
        }
      );

    for (
      const side of [1, -1]
    ) {
      const boom =
        new THREE.Mesh(
          new THREE.CylinderGeometry(
            0.09,
            0.09,
            3.4,
            10
          ),
          boomMat
        );

      boom.rotation.z =
        Math.PI / 2;

      boom.position.set(
        -3.3,
        -0.05,
        side * 1.9
      );

      airframe.add(
        boom
      );

      const finGeo =
        new THREE.BoxGeometry(
          0.06,
          1.3,
          0.75
        );

      const fin =
        new THREE.Mesh(
          finGeo,
          skinMat
        );

      fin.position.set(
        -4.85,
        0.55,
        side * 1.9
      );

      fin.rotation.x =
        side * 0.5;

      airframe.add(fin);
    }

    const turret =
      new THREE.Mesh(
        new THREE.SphereGeometry(
          0.22,
          14,
          14
        ),
        metalMat
      );

    turret.position.set(
      2.5,
      -0.55,
      0
    );

    airframe.add(turret);

    const propHub =
      new THREE.Mesh(
        new THREE.SphereGeometry(
          0.14,
          12,
          12
        ),
        metalMat
      );

    propHub.position.set(
      -4.95,
      0.15,
      0
    );

    const propGroup =
      new THREE.Group();

    propGroup.position.copy(
      propHub.position
    );

    for (
      const a of [
        0,
        Math.PI,
      ]
    ) {
      const blade =
        new THREE.Mesh(
          new THREE.BoxGeometry(
            0.05,
            1.5,
            0.2
          ),
          darkMat
        );

      blade.rotation.x =
        a;

      propGroup.add(
        blade
      );
    }

    engine.add(
      propHub,
      propGroup
    );

    scene.add(
      airframe
    );

    // ======================================================
    // CAMERA DRAG
    // ======================================================

    let dragging = false;

    let lastX = 0;
    let lastY = 0;

    const onDown = (e) => {
      dragging = true;

      lastX =
        e.clientX;

      lastY =
        e.clientY;
    };

    const onUp = () => {
      dragging = false;
    };

    const onMove = (e) => {
      if (!dragging)
        return;

      const dx =
        e.clientX -
        lastX;

      const dy =
        e.clientY -
        lastY;

      camTheta -=
        dx * 0.006;

      camPhi =
        Math.max(
          0.35,
          Math.min(
            1.5,
            camPhi -
              dy * 0.006
          )
        );

      lastX =
        e.clientX;

      lastY =
        e.clientY;

      updateCamera();
    };

    renderer.domElement.addEventListener(
      "pointerdown",
      onDown
    );

    window.addEventListener(
      "pointerup",
      onUp
    );

    window.addEventListener(
      "pointermove",
      onMove
    );

    // ======================================================
    // RESIZE
    // ======================================================

    const onResize = () => {
      const w =
        mount.clientWidth;

      const h =
        mount.clientHeight;

      camera.aspect =
        w / h;

      camera.updateProjectionMatrix();

      renderer.setSize(
        w,
        h
      );
    };

    window.addEventListener(
      "resize",
      onResize
    );

    // ======================================================
    // THREE.JS REFERENCES
    // ======================================================

    threeRef.current = {
      scene,
      camera,
      renderer,
      engine,
      airframe,
      cylMats,
      exhaustMat,
      sumpMat,
      flywheel,
      propGroup,

      latest: {
        reading:
          simRef.current
            .reading,

        score: 0,

        fault: "none",

        mission:
          "normal_cruise",
      },
    };

    // ======================================================
    // ANIMATION
    // ======================================================

    let raf;

    const clock =
      new THREE.Clock();

    const animate = () => {
      raf =
        requestAnimationFrame(
          animate
        );

      const dt =
        clock.getDelta();

      const {
        reading,
        score,
        fault,
        mission,
      } =
        threeRef.current
          .latest;

      const t =
        threeRef.current;

      t.flightT =
        (t.flightT || 0) +
        dt;

      const ft =
        t.flightT;

      let bobAmp =
        0.05;

      let bobSpeed =
        0.6;

      let bankAmp =
        0.03;

      let pitchAmp =
        0.02;

      let driftSpeed =
        0.5;

      if (
        mission ===
        "high_altitude"
      ) {
        bobAmp = 0.03;
        bobSpeed = 0.35;
        bankAmp = 0.015;
      } else if (
        mission ===
        "hot_weather"
      ) {
        bobAmp = 0.11;
        bobSpeed = 0.9;
        bankAmp = 0.05;
      } else if (
        mission ===
        "rapid_throttle"
      ) {
        bobAmp = 0.06;
        bobSpeed = 1.6;
        bankAmp = 0.09;
        pitchAmp = 0.06;
        driftSpeed = 1.3;
      }

      const flyY =
        Math.sin(
          ft * bobSpeed
        ) * bobAmp;

      const flyBank =
        Math.sin(
          ft *
            driftSpeed *
            0.7
        ) * bankAmp;

      const flyPitch =
        Math.cos(
          ft *
            driftSpeed *
            0.5
        ) * pitchAmp;

      [
        t.airframe,
        t.engine,
      ].forEach(
        (obj) => {
          obj.rotation.z =
            flyBank;

          obj.rotation.x =
            flyPitch;
        }
      );

      t.airframe.position.y =
        flyY;

      // ----------------------------------------------------
      // CHT VISUAL
      // ----------------------------------------------------

      const chtT =
        normalize(
          reading.cht_c,
          [100, 150]
        );

      const chtColor =
        lerpColor(
          "#6b7684",
          "#ff5b5b",
          chtT
        );

      const idleGlow =
        new THREE.Color(
          0x2a1a10
        );

      t.cylMats.forEach(
        (m) => {
          m.color.copy(
            chtColor
          );

          m.emissive
            .copy(idleGlow)
            .lerp(
              chtColor,
              Math.max(
                0.25,
                chtT
              )
            )
            .multiplyScalar(
              0.3 +
                chtT *
                  0.5
            );
        }
      );

      // ----------------------------------------------------
      // EGT VISUAL
      // ----------------------------------------------------

      const egtT =
        normalize(
          reading.egt_c,
          [650, 850]
        );

      const egtColor =
        lerpColor(
          "#3a3f45",
          "#ff7a3c",
          egtT
        );

      t.exhaustMat.color.copy(
        egtColor
      );

      t.exhaustMat.emissive
        .copy(egtColor)
        .multiplyScalar(
          egtT * 0.9
        );

      // ----------------------------------------------------
      // OIL VISUAL
      // ----------------------------------------------------

      const oilPressT =
        1 -
        normalize(
          reading.oil_press_bar,
          [1.0, 3.0]
        );

      const oilColor =
        lerpColor(
          "#2f5f8a",
          "#ffb648",
          oilPressT
        );

      t.sumpMat.color.copy(
        oilColor
      );

      t.sumpMat.emissive
        .copy(oilColor)
        .multiplyScalar(
          oilPressT *
            0.5
        );

      // ----------------------------------------------------
      // ROTATION
      // ----------------------------------------------------

      const rpmFrac =
        reading.rpm /
        5500;

      t.flywheel.rotation.y +=
        dt *
        rpmFrac *
        14;

      t.propGroup.rotation.x +=
        dt *
        rpmFrac *
        30;

      // ----------------------------------------------------
      // VIBRATION
      // ----------------------------------------------------

      const vib =
        reading.vibration_g;

      t.engine.position.x =
        (Math.random() -
          0.5) *
        vib *
        1.2;

      t.engine.position.z =
        (Math.random() -
          0.5) *
        vib *
        1.2;

      t.engine.position.y =
        flyY +
        0.2 +
        (Math.random() -
          0.5) *
          vib *
          0.5;

      renderer.render(
        scene,
        camera
      );
    };

    animate();

    return () => {
      cancelAnimationFrame(
        raf
      );

      renderer.domElement.removeEventListener(
        "pointerdown",
        onDown
      );

      window.removeEventListener(
        "pointerup",
        onUp
      );

      window.removeEventListener(
        "pointermove",
        onMove
      );

      window.removeEventListener(
        "resize",
        onResize
      );

      renderer.dispose();

      if (
        mount.contains(
          renderer.domElement
        )
      ) {
        mount.removeChild(
          renderer.domElement
        );
      }

      if (
        audioRef.current
          .ctx
      ) {
        audioRef.current.ctx.close();
      }
    };

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ========================================================
  // STATUS COLOR
  // ========================================================

  const statusColor =
    status === "Normal"
      ? COLORS.green
      : status === "Warning"
      ? COLORS.amber
      : COLORS.red;

  // ========================================================
  // UI
  // ========================================================

  return (
    <div style={styles.wrap}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Inter:wght@400;500;600;700&display=swap');

        html, body, #root {
          margin: 0;
          padding: 0;
          height: 100%;
          width: 100%;
          max-width: none;
          text-align: left;
          overflow: hidden;
        }

        * {
          box-sizing: border-box;
        }

        .egdt-btn {
          font-family: 'Inter', sans-serif;
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0.02em;
          padding: 5px 9px;
          border-radius: 4px;
          border: 1px solid ${COLORS.panelBorder};
          background: #161d25;
          color: ${COLORS.textMuted};
          cursor: pointer;
          transition: all 0.15s ease;
          white-space: nowrap;
        }

        .egdt-btn:hover {
          border-color: ${COLORS.cyan};
          color: ${COLORS.textPrimary};
        }

        .egdt-btn.active {
          background: ${COLORS.cyan};
          color: #06131a;
          border-color: ${COLORS.cyan};
        }

        .egdt-btn.fault-active {
          background: ${COLORS.red};
          color: #1a0606;
          border-color: ${COLORS.red};
        }
      `}</style>

      {/* ================================================== */}
      {/* HEADER */}
      {/* ================================================== */}

      <div style={styles.header}>
        <div>
          <div style={styles.eyebrow}>
            VIRTUAL ENGINE &middot; PROPULSION HEALTH SYSTEM
          </div>

          <div style={styles.title}>
            Aero Piston Engine // Live Telemetry
          </div>

          <div style={styles.subtitle}>
            Reference: Rotax 912 ULS operating limits (RPM 5500 / CHT
            150&deg;C / EGT 900&deg;C / Oil 2&ndash;5 bar)
          </div>
        </div>

        <div
          style={{
            ...styles.statusBadge,
            borderColor:
              statusColor,
            color:
              statusColor,
          }}
        >
          <span
            style={{
              ...styles.statusDot,
              background:
                statusColor,
            }}
          />

          {status.toUpperCase()}
        </div>
      </div>

      {/* ================================================== */}
      {/* MAIN */}
      {/* ================================================== */}

      <div style={styles.main}>
        <div
          ref={mountRef}
          style={
            styles.viewport
          }
        />

        <div
          style={
            styles.sidebar
          }
        >
          {/* DATA SOURCE */}

          <div
            style={{
              display: "flex",
              justifyContent:
                "space-between",
              alignItems:
                "center",
            }}
          >
            <div
              style={
                styles.panelLabel
              }
            >
              DATA SOURCE
            </div>

            <span
              style={{
                fontSize: 9,
                fontWeight: 700,
                letterSpacing:
                  "0.06em",
                color:
                  hardwareMode ===
                  "live"
                    ? COLORS.green
                    : COLORS.amber,
              }}
            >
              {dataSourceStatus.startsWith(
                "Live"
              )
                ? "● LIVE"
                : dataSourceStatus.startsWith(
                    "Signal lost"
                  )
                ? "● SIGNAL LOST"
                : "● MOCK"}
            </span>
          </div>

          <div
            style={{
              fontSize: 9,
              color:
                "#4a5665",
              marginBottom: 5,
            }}
          >
            {dataSourceStatus}
          </div>

          <div
            style={{
              display: "flex",
              gap: 6,
              marginBottom: 8,
            }}
          >
            <button
              className={`egdt-btn${
                hardwareMode ===
                "live"
                  ? " active"
                  : ""
              }`}
              style={{
                flex: 1,
              }}
              onClick={() =>
                setHardwareMode(
                  "live"
                )
              }
            >
              Live Hardware
            </button>

            <button
              className={`egdt-btn${
                hardwareMode ===
                "mock"
                  ? " active"
                  : ""
              }`}
              style={{
                flex: 1,
              }}
              onClick={() =>
                setHardwareMode(
                  "mock"
                )
              }
            >
              Mock Data
            </button>
          </div>

          {/* TELEMETRY */}

          <div
            style={
              styles.panelLabel
            }
          >
            TELEMETRY
          </div>

          <TelemetryRow
            label="RPM"
            value={telemetry.rpm?.toFixed(
              0
            )}
            unit=""
            limit="5500 max"
            source={
              HARDWARE_FIELDS.includes(
                "rpm"
              )
                ? "HW"
                : "SIM"
            }
          />

          <TelemetryRow
            label="CHT"
            value={telemetry.cht_c?.toFixed(
              1
            )}
            unit="°C"
            limit="150 max"
            source={
              HARDWARE_FIELDS.includes(
                "cht_c"
              )
                ? "HW"
                : "SIM"
            }
          />

          <TelemetryRow
            label="EGT"
            value={telemetry.egt_c?.toFixed(
              1
            )}
            unit="°C"
            limit="900 max"
            source="SIM"
          />

          <TelemetryRow
            label="Oil Press"
            value={telemetry.oil_press_bar?.toFixed(
              2
            )}
            unit="bar"
            limit="2.0-5.0"
            source="SIM"
          />

          <TelemetryRow
            label="Oil Temp"
            value={telemetry.oil_temp_c?.toFixed(
              1
            )}
            unit="°C"
            limit="150 max"
            source="SIM"
          />

          <TelemetryRow
            label="Fuel Flow"
            value={telemetry.fuel_flow_lph?.toFixed(
              1
            )}
            unit="L/h"
            limit="ref."
            source="SIM"
          />

          <TelemetryRow
            label="Vibration"
            value={telemetry.vibration_g?.toFixed(
              3
            )}
            unit="g"
            limit="ref."
            source={
              HARDWARE_FIELDS.includes(
                "vibration_g"
              )
                ? "HW"
                : "SIM"
            }
          />

          <TelemetryRow
            label="Roll"
            value={telemetry.roll_deg?.toFixed(
              1
            )}
            unit="°"
            limit="±25 typical"
            source={
              HARDWARE_FIELDS.includes(
                "roll_deg"
              )
                ? "HW"
                : "SIM"
            }
          />

          <TelemetryRow
            label="Pitch"
            value={telemetry.pitch_deg?.toFixed(
              1
            )}
            unit="°"
            limit="±25 typical"
            source={
              HARDWARE_FIELDS.includes(
                "pitch_deg"
              )
                ? "HW"
                : "SIM"
            }
          />

          <TelemetryRow
            label="Yaw"
            value={telemetry.yaw_deg?.toFixed(
              1
            )}
            unit="°"
            limit="drifts, gyro-only"
            source={
              HARDWARE_FIELDS.includes(
                "yaw_deg"
              )
                ? "HW"
                : "SIM"
            }
          />

          <TelemetryRow
            label="Battery"
            value={telemetry.battery_v?.toFixed(
              2
            )}
            unit="V"
            limit="13.8-14.4"
            source="SIM"
          />

          {/* ANOMALY */}

          <div
            style={{
              ...styles.panelLabel,
              marginTop: 12,
            }}
          >
            ANOMALY SCORE
          </div>

          <div
            style={
              styles.scoreBarTrack
            }
          >
            <div
              style={{
                ...styles.scoreBarFill,
                width: `${
                  anomalyScore *
                  100
                }%`,
                background:
                  statusColor,
              }}
            />
          </div>

          <div
            style={{
              fontFamily:
                "'JetBrains Mono', monospace",
              fontSize: 11,
              color:
                statusColor,
              marginTop: 3,
            }}
          >
            {anomalyScore.toFixed(
              3
            )}
          </div>

          {/* RELIABILITY */}

          <div
            style={{
              ...styles.panelLabel,
              marginTop: 12,
            }}
          >
            MISSION RELIABILITY
          </div>

          <div
            style={{
              ...styles.reliabilityText,
              color:
                reliability.startsWith(
                  "Estimated"
                ) ||
                reliability.startsWith(
                  "Critical"
                )
                  ? COLORS.violet
                  : COLORS.textMuted,
            }}
          >
            {reliability}
          </div>
        </div>
      </div>

      {/* ================================================== */}
      {/* CONTROLS */}
      {/* ================================================== */}

      <div
        style={
          styles.controls
        }
      >
        <div
          style={
            styles.controlGroup
          }
        >
          <div
            style={
              styles.controlLabel
            }
          >
            MISSION PROFILE
          </div>

          <div
            style={
              styles.btnRow
            }
          >
            {MISSION_PROFILES.map(
              (m) => (
                <button
                  key={m.id}
                  className={`egdt-btn ${
                    missionProfile ===
                    m.id
                      ? "active"
                      : ""
                  }`}
                  onClick={() =>
                    setMission(
                      m.id
                    )
                  }
                >
                  {m.label}
                </button>
              )
            )}
          </div>
        </div>

        <div
          style={
            styles.controlGroup
          }
        >
          <div
            style={
              styles.controlLabel
            }
          >
            FAULT INJECTION (LIVE DEMO)
          </div>

          <div
            style={
              styles.btnRow
            }
          >
            {FAULT_TYPES.map(
              (f) => (
                <button
                  key={f.id}
                  className={`egdt-btn ${
                    activeFault ===
                    f.id
                      ? f.id ===
                        "none"
                        ? "active"
                        : "fault-active"
                      : ""
                  }`}
                  onClick={() =>
                    setFault(
                      f.id
                    )
                  }
                >
                  {f.label}
                </button>
              )
            )}

            <button
              className="egdt-btn"
              onClick={() =>
                setPaused(
                  (p) => !p
                )
              }
            >
              {paused
                ? "Resume"
                : "Pause"}
            </button>

            <button
              className={`egdt-btn ${
                soundOn
                  ? "active"
                  : ""
              }`}
              onClick={
                toggleSound
              }
            >
              {soundOn
                ? "Sound: On"
                : "Enable Sound"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ==========================================================
// TELEMETRY ROW
// ==========================================================

function TelemetryRow({
  label,
  value,
  unit,
  limit,
  source,
}) {
  return (
    <div
      style={
        styles.telRow
      }
    >
      <span
        style={
          styles.telLabel
        }
      >
        {label}{" "}

        <span
          style={{
            fontSize: 8,
            fontWeight: 700,
            padding:
              "1px 4px",
            borderRadius: 3,
            color:
              source ===
              "HW"
                ? COLORS.green
                : COLORS.textMuted,
            border: `1px solid ${
              source ===
              "HW"
                ? COLORS.green
                : "#2a3542"
            }`,
          }}
        >
          {source}
        </span>
      </span>

      <span
        style={
          styles.telValue
        }
      >
        {value}{" "}

        <span
          style={
            styles.telUnit
          }
        >
          {unit}
        </span>
      </span>

      <span
        style={
          styles.telLimit
        }
      >
        {limit}
      </span>
    </div>
  );
}

// ==========================================================
// STYLES
// ==========================================================

const styles = {
  wrap: {
    fontFamily:
      "'Inter', sans-serif",
    background:
      COLORS.bg,
    color:
      COLORS.textPrimary,
    border: `1px solid ${COLORS.panelBorder}`,
    overflow: "hidden",
    display: "flex",
    flexDirection:
      "column",
    width: "100%",
    height: "100vh",
    maxHeight: "100vh",
  },

  header: {
    display: "flex",
    justifyContent:
      "space-between",
    alignItems:
      "center",
    padding:
      "10px 16px",
    borderBottom: `1px solid ${COLORS.panelBorder}`,
    background:
      "#0d1319",
    flexShrink: 0,
  },

  eyebrow: {
    fontSize: 9.5,
    letterSpacing:
      "0.12em",
    color:
      COLORS.cyan,
    fontWeight: 600,
    marginBottom: 2,
  },

  title: {
    fontSize: 14,
    fontWeight: 700,
    color:
      COLORS.textPrimary,
  },

  subtitle: {
    fontSize: 9,
    color:
      "#4a5665",
    marginTop: 2,
    fontFamily:
      "'JetBrains Mono', monospace",
  },

  statusBadge: {
    display: "flex",
    alignItems:
      "center",
    gap: 6,
    fontFamily:
      "'JetBrains Mono', monospace",
    fontSize: 11,
    fontWeight: 700,
    letterSpacing:
      "0.05em",
    border:
      "1px solid",
    borderRadius: 20,
    padding:
      "4px 10px",
  },

  statusDot: {
    width: 6,
    height: 6,
    borderRadius:
      "50%",
  },

  main: {
    display: "flex",
    flex: 1,
    minHeight: 0,
    overflow:
      "hidden",
  },

  viewport: {
    flex: 1,
    minWidth: 0,
    position:
      "relative",
    cursor: "grab",
  },

  sidebar: {
    width: 225,
    padding:
      "12px 14px",
    borderLeft: `1px solid ${COLORS.panelBorder}`,
    background:
      COLORS.panel,
    overflowY:
      "auto",
    minHeight: 0,
  },

  panelLabel: {
    fontSize: 10,
    letterSpacing:
      "0.1em",
    color:
      COLORS.textMuted,
    fontWeight: 700,
    marginBottom: 6,
  },

  telRow: {
    display: "grid",
    gridTemplateColumns:
      "60px 1fr 54px",
    alignItems:
      "baseline",
    padding:
      "3px 0",
    borderBottom:
      "1px solid #1a222c",
  },

  telLabel: {
    fontSize: 10.5,
    color:
      COLORS.textMuted,
    fontWeight: 500,
  },

  telValue: {
    fontFamily:
      "'JetBrains Mono', monospace",
    fontSize: 12,
    color:
      COLORS.textPrimary,
    fontWeight: 500,
    textAlign:
      "right",
  },

  telUnit: {
    fontSize: 9,
    color:
      COLORS.textMuted,
  },

  telLimit: {
    fontSize: 8.5,
    color:
      "#4a5665",
    textAlign:
      "right",
  },

  scoreBarTrack: {
    width: "100%",
    height: 5,
    borderRadius: 3,
    background:
      "#1a222c",
    overflow:
      "hidden",
  },

  scoreBarFill: {
    height: "100%",
    transition:
      "width 0.2s ease",
  },

  reliabilityText: {
    fontSize: 10.5,
    color:
      COLORS.textMuted,
    lineHeight: 1.4,
  },

  controls: {
    borderTop: `1px solid ${COLORS.panelBorder}`,
    background:
      "#0d1319",
    padding:
      "8px 16px",
    display: "flex",
    flexDirection:
      "column",
    gap: 6,
    flexShrink: 0,
  },

  controlGroup: {
    display: "flex",
    flexDirection:
      "column",
    gap: 4,
  },

  controlLabel: {
    fontSize: 9,
    letterSpacing:
      "0.1em",
    color:
      COLORS.textMuted,
    fontWeight: 700,
  },

  btnRow: {
    display: "flex",
    flexWrap:
      "wrap",
    gap: 5,
  },
};
