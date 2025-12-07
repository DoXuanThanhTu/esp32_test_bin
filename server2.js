// server.js - ES Module
import express from "express";
import mqtt from "mqtt";
import dotenv from "dotenv";
import cors from "cors";

dotenv.config();

// ==========================
// CONFIG
// ==========================
const app = express();
app.use(express.json());
app.use(cors());

const DEVICE_ID = process.env.DEVICE_ID || "esp32_wokwi_test_bin";

const options = {
  username: process.env.USER_NAME,
  password: process.env.USER_PASS,
  rejectUnauthorized: false,
  reconnectPeriod: 2000,
};

const broker = process.env.BROKER_URL;

// ==========================
// TOPICS
// ==========================
const TOPIC = {
  data: `devices/${DEVICE_ID}/data`,
  cmd: `devices/${DEVICE_ID}/command`,
  status: `devices/${DEVICE_ID}/status`,
};

// ==========================
// STATE
// ==========================
let deviceState = {
  temp: 0,
  humidity: 0,
  soil: 0,
  pump: false,
};

let threshold = {
  temp: { min: 20, max: 50 },
  humidity: { min: 60, max: 95 },
  soil: { min: 30, max: 80 },
};

// ==========================
// LOG SYSTEM
// ==========================
const logs = [];
function addLog(...msg) {
  const text = msg
    .map((m) => (typeof m === "object" ? JSON.stringify(m) : m))
    .join(" ");

  const entry = { time: new Date().toISOString(), msg: text };
  console.log(entry.time, text);

  logs.push(entry);
  if (logs.length > 5000) logs.shift();
}

// ==========================
// HELPERS
// ==========================

// SENSOR packet = 6 bytes
function decodeSensor(buf) {
  return {
    temp: buf.readInt16LE(0) / 10,
    humidity: buf.readInt16LE(2) / 10,
    soil: buf.readInt16LE(4) / 10,
  };
}

// STATUS packet = 1 byte
function decodeStatus(buf) {
  return {
    pump: buf.readUInt8(0) === 1,
  };
}

function publishCmdBuffer(buf) {
  if (!client.connected) {
    addLog("MQTT DISCONNECTED → ignore command");
    return;
  }
  client.publish(TOPIC.cmd, buf);
}

// ==========================
// PUMP COMMAND
// ==========================
let lastPumpCmd = null;
let lastPumpTime = 0;
const PUMP_DEBOUNCE = 1000;

function sendPumpCmd(on) {
  const now = Date.now();

  if (now - lastPumpTime < PUMP_DEBOUNCE) return;

  if (lastPumpCmd === on) return;

  lastPumpCmd = on;
  lastPumpTime = now;

  const b = Buffer.alloc(2);
  b.writeUInt8(2, 0); // CMD.PUMP = 2
  b.writeUInt8(on ? 1 : 0, 1);

  publishCmdBuffer(b);

  addLog("CMD → Pump", on ? "ON" : "OFF");
}

// ==========================
// AUTO PUMP LOGIC
// ==========================
function autoPump(sensor) {
  const soil = sensor.soil;

  const target = threshold.soil.max - 5;

  // Nếu soil quá cao → tắt luôn
  if (soil > threshold.soil.max) {
    addLog("AUTO: soil above max → pump OFF", soil);
    sendPumpCmd(false);
    return;
  }

  // Nếu soil quá thấp → bật
  if (soil < threshold.soil.min) {
    addLog("AUTO: soil below min → pump ON", soil);
    sendPumpCmd(true);
    return;
  }

  // Nếu đang bơm → kiểm tra xem đã đủ chưa
  if (deviceState.pump) {
    if (soil >= target) {
      addLog("AUTO: reached target → pump OFF", soil);
      sendPumpCmd(false);
    } else {
      addLog("AUTO: pumping until target", soil);
    }
    return;
  }

  // soil trong ngưỡng & pump tắt → không làm gì
  addLog("AUTO: soil within range", soil);
}

// ==========================
// ALERT
// ==========================
function checkAlerts(s) {
  if (s.temp < threshold.temp.min) addLog("Alert: temp below", s.temp);

  if (s.temp > threshold.temp.max) addLog("Alert: temp above", s.temp);

  if (s.humidity < threshold.humidity.min)
    addLog("Alert: hum below", s.humidity);

  if (s.humidity > threshold.humidity.max)
    addLog("Alert: hum above", s.humidity);

  if (s.soil < threshold.soil.min) addLog("Alert: soil below", s.soil);

  if (s.soil > threshold.soil.max) addLog("Alert: soil above", s.soil);
}

// ==========================
// MQTT
// ==========================
const client = mqtt.connect(broker, options);

client.on("connect", () => {
  addLog("MQTT connected");
  client.subscribe(TOPIC.data);
  client.subscribe(TOPIC.status);
});

client.on("error", (e) => addLog("MQTT error:", e.message));

client.on("message", (topic, msg) => {
  // SENSOR = 6 bytes
  if (topic === TOPIC.data && msg.length === 6) {
    const s = decodeSensor(msg);

    deviceState.temp = s.temp;
    deviceState.humidity = s.humidity;
    deviceState.soil = s.soil;

    addLog("Sensor:", s);

    checkAlerts(s);

    autoPump(s); // ✅ logic AUTO bơm

    return;
  }

  // STATUS = 1 byte
  if (topic === TOPIC.status && msg.length === 1) {
    const st = decodeStatus(msg);
    deviceState.pump = st.pump;

    addLog("Status:", st);

    return;
  }

  addLog("Unknown MQTT packet", msg.length);
});

// ==========================
// EXPRESS API
// ==========================
app.get("/", (req, res) => res.send("ESP32 MQTT server ready"));

app.get("/state", (req, res) => res.json(deviceState));

app.get("/threshold", (req, res) => res.json(threshold));

app.post("/threshold", (req, res) => {
  threshold = req.body;
  addLog("Threshold updated", threshold);
  res.json({ ok: true });
});

app.post("/pump", (req, res) => {
  sendPumpCmd(req.body.value === 1);
  res.json({ ok: true });
});

app.get("/logs", (req, res) => res.json(logs));

app.get("/health", (req, res) => res.json({ ok: true }));

// ==========================
// START
// ==========================
const PORT = 4000;

app.listen(PORT, () => addLog("Server started on port", PORT));
