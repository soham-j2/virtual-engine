const http = require("http");

// ==========================================================
// RENDER PORT
// ==========================================================
// Render provides the PORT automatically.
// Locally it will use 5000.
const PORT = process.env.PORT || 5000;

let latestTelemetry = null;
let lastUpdated = null;

// ==========================================================
// SERVER
// ==========================================================

const server = http.createServer((req, res) => {
  // --------------------------------------------------------
  // CORS
  // --------------------------------------------------------
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, OPTIONS"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );

  // --------------------------------------------------------
  // CORS PREFLIGHT
  // --------------------------------------------------------

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // ========================================================
  // HEALTH CHECK
  // ========================================================

  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, {
      "Content-Type": "application/json",
    });

    res.end(
      JSON.stringify({
        status: "online",
        service: "Virtual Engine Telemetry Server",
        port: PORT,
        telemetryAvailable: latestTelemetry !== null,
        lastUpdated: lastUpdated,
      })
    );

    return;
  }

  // ========================================================
  // RECEIVE TELEMETRY
  // POST /api/telemetry
  // ========================================================

  if (
    req.method === "POST" &&
    req.url === "/api/telemetry"
  ) {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk.toString();

      // Prevent extremely large requests
      if (body.length > 1024 * 1024) {
        req.destroy();
      }
    });

    req.on("end", () => {
      try {
        const data = JSON.parse(body);

        // Store latest telemetry
        latestTelemetry = data;
        lastUpdated = new Date().toISOString();

        // Server console
        console.log("");
        console.log("========================================");
        console.log("       TELEMETRY RECEIVED");
        console.log("========================================");
        console.log(JSON.stringify(data, null, 2));
        console.log("----------------------------------------");
        console.log("Time:", new Date().toLocaleString());
        console.log("========================================");
        console.log("");

        // Response
        res.writeHead(200, {
          "Content-Type": "application/json",
        });

        res.end(
          JSON.stringify({
            success: true,
            message: "Telemetry received",
            timestamp: lastUpdated,
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

  // ========================================================
  // GET LATEST TELEMETRY
  // GET /api/telemetry
  // ========================================================

  if (
    req.method === "GET" &&
    req.url === "/api/telemetry"
  ) {
    res.writeHead(200, {
      "Content-Type": "application/json",
    });

    res.end(
      JSON.stringify(
        latestTelemetry
          ? {
              ...latestTelemetry,
              _server: {
                lastUpdated: lastUpdated,
              },
            }
          : {
              message: "No telemetry received yet",
            },
        null,
        2
      )
    );

    return;
  }

  // ========================================================
  // SERVER STATUS
  // GET /api/status
  // ========================================================

  if (
    req.method === "GET" &&
    req.url === "/api/status"
  ) {
    res.writeHead(200, {
      "Content-Type": "application/json",
    });

    res.end(
      JSON.stringify({
        online: true,
        telemetryAvailable: latestTelemetry !== null,
        lastUpdated: lastUpdated,
        serverTime: new Date().toISOString(),
      })
    );

    return;
  }

  // ========================================================
  // 404
  // ========================================================

  res.writeHead(404, {
    "Content-Type": "application/json",
  });

  res.end(
    JSON.stringify({
      error: "Not found",
      availableEndpoints: [
        "GET /",
        "GET /api/status",
        "GET /api/telemetry",
        "POST /api/telemetry",
      ],
    })
  );
});

// ==========================================================
// START SERVER
// ==========================================================

server.listen(PORT, "0.0.0.0", () => {
  console.log("");
  console.log("========================================");
  console.log("     VIRTUAL ENGINE TELEMETRY SERVER");
  console.log("========================================");
  console.log(`PORT: ${PORT}`);
  console.log("HOST: 0.0.0.0");
  console.log("----------------------------------------");
  console.log("GET  /");
  console.log("GET  /api/status");
  console.log("GET  /api/telemetry");
  console.log("POST /api/telemetry");
  console.log("========================================");
  console.log("SERVER READY");
  console.log("========================================");
  console.log("");
});
