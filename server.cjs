const http = require("http");

const PORT = 5000;

let latestTelemetry = null;

const server = http.createServer((req, res) => {
  // Allow requests from the React/Vite app
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Handle browser CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // ==========================================================
  // RECEIVE TELEMETRY
  // ==========================================================

  if (req.method === "POST" && req.url === "/api/telemetry") {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk.toString();
    });

    req.on("end", () => {
      try {
        const data = JSON.parse(body);

        latestTelemetry = data;

        console.clear();

        console.log("========================================");
        console.log("     TELEMETRY RECEIVED");
        console.log("========================================");

        console.log(JSON.stringify(data, null, 2));

        console.log("========================================");
        console.log("Time:", new Date().toLocaleTimeString());
        console.log("========================================");

        res.writeHead(200, {
          "Content-Type": "application/json",
        });

        res.end(
          JSON.stringify({
            success: true,
            message: "Telemetry received",
          })
        );
      } catch (error) {
        console.error("Invalid JSON received:", error);

        res.writeHead(400, {
          "Content-Type": "application/json",
        });

        res.end(
          JSON.stringify({
            success: false,
            error: "Invalid JSON",
          })
        );
      }
    });

    return;
  }

  // ==========================================================
  // VIEW LATEST TELEMETRY IN BROWSER
  // ==========================================================

  if (req.method === "GET" && req.url === "/api/telemetry") {
    res.writeHead(200, {
      "Content-Type": "application/json",
    });

    res.end(
      JSON.stringify(
        latestTelemetry || {
          message: "No telemetry received yet",
        },
        null,
        2
      )
    );

    return;
  }

  // ==========================================================
  // SERVER STATUS
  // ==========================================================

  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, {
      "Content-Type": "text/plain",
    });

    res.end("ESP32 / Virtual Engine Telemetry Server is running.");
    return;
  }

  // ==========================================================
  // NOT FOUND
  // ==========================================================

  res.writeHead(404, {
    "Content-Type": "application/json",
  });

  res.end(
    JSON.stringify({
      error: "Not found",
    })
  );
});

// ==========================================================
// START SERVER
// ==========================================================

server.listen(PORT, () => {
  console.log("========================================");
  console.log(" TELEMETRY SERVER STARTED");
  console.log("========================================");
  console.log(`Server: http://localhost:${PORT}`);
  console.log(`API:    http://localhost:${PORT}/api/telemetry`);
  console.log("========================================");
});