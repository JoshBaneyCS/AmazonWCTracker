/*************************************************************
 * server.js
 * Key points:
 *  - We have an /api/seatCounts endpoint that calculates how many "Approved"
 *    seated roles exist for each day/shift code (FHD, FHN, BHD, BHN, FLEX).
 *  - We add logic to fetch an existing record for update and auto-fill.
 *  - Slack message format remains the same, ensuring it's sent after POST /api/restrictions.
 *************************************************************/
require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");

// Using node-fetch@2 for CommonJS
const fetch = require("node-fetch");
const mysql = require("mysql2/promise");
const path = require("path");

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Serve static files from "public" directory
app.use(express.static("public"));

// By default, serve active-accommodations.html
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "active-accommodations.html"));
});

const dbConfig = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME
};

// Slack Webhook
const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL || "";

/*************************************************************
 * SHIFT + DAY MAPPINGS
 * We'll map each shift code (FHD, FHN, etc.) to the days it covers.
 * For seat counts:
 *   FHD => Sunday, Monday, Tuesday, Wednesday
 *   FHN => Sunday night, Monday night, Tuesday night, Wednesday night
 *   BHD => Wednesday, Thursday, Friday, Saturday
 *   BHN => Wed night, Thu night, Fri night, Sat night
 *   FLEX => all days or "Flex only"? We'll treat it as its own row for the entire week
 *************************************************************/
const SHIFT_DAYS = {
  FHD: ["Sunday", "Monday", "Tuesday", "Wednesday"],
  FHN: ["Sunday", "Monday", "Tuesday", "Wednesday"], // but at night
  BHD: ["Wednesday", "Thursday", "Friday", "Saturday"],
  BHN: ["Wednesday", "Thursday", "Friday", "Saturday"], // night
  FLEX: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
};

/*************************************************************
 * parseShiftPattern => returns FHD, FHN, BHD, BHN, FLEX, or "unknown"
 * Extended logic for DA -> FHD, DB -> BHD, DC -> ???
 * NA -> FHN, NB -> BHN, RT -> BHD, RTN -> BHN, FLEX...
 *************************************************************/
function parseShiftPattern(shiftString) {
  if (!shiftString) return "unknown";
  const s = shiftString.toUpperCase();

  if (s.includes("DA")) return "FHD";
  if (s.includes("DB")) return "BHD";
  if (s.includes("DC")) return "FHD"; // or "donut" if you'd prefer a special code
  if (s.includes("NA")) return "FHN";
  if (s.includes("NB")) return "BHN";
  if (s.includes("RTN")) return "BHN";
  if (s.includes("RT")) return "BHD";
  if (s.includes("FLEX")) return "FLEX";
  return "unknown";
}

/*************************************************************
 * isSeatedRole => returns true if requestingJobPath is a TLD seated role
 *************************************************************/
function isSeatedRole(role) {
  const seatedRoles = ["Asset tagging", "Seated PA role"];
  return seatedRoles.includes(role);
}

/*************************************************************
 * sendSlackMessage => format your message
 *************************************************************/
async function sendSlackMessage({
                                  associateName,
                                  associateLogin,
                                  homePath,
                                  aaRestrictions,
                                  requestingJobPath,
                                  requestorLogin,
                                  shiftCount,   // e.g. "FHD"
                                  seatedTotal   // numeric total
                                }) {
  if (!slackWebhookUrl) {
    console.warn("No Slack webhook configured. Message not sent.");
    return;
  }
  const text =
      `We have received restrictions for ${associateName} (${associateLogin})
@channel

Home Path: ${homePath}
Restrictions: ${aaRestrictions}
Recommendation: ${requestingJobPath}

This is an automated message sent out by: ${requestorLogin}

Current seated spots for ${shiftCount} :
Total Seated accommodations: ${seatedTotal}`;

  try {
    const resp = await fetch(slackWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    });
    if (!resp.ok) {
      console.error("Slack responded with error:", await resp.text());
    }
  } catch (err) {
    console.error("Error sending Slack message:", err);
  }
}

/*************************************************************
 * GET /api/accommodations => Return all records
 *************************************************************/
app.get("/api/accommodations", async (req, res) => {
  try {
    const conn = await mysql.createConnection(dbConfig);
    const [rows] = await conn.execute("SELECT * FROM accommodations ORDER BY id DESC");
    await conn.end();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/*************************************************************
 * GET /api/accommodations/:id => Return a single record (for auto-fill)
 *************************************************************/
app.get("/api/accommodations/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const conn = await mysql.createConnection(dbConfig);
    const [rows] = await conn.execute("SELECT * FROM accommodations WHERE id = ?", [id]);
    await conn.end();
    if (rows.length === 0) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/*************************************************************
 * PATCH /api/accommodations/:id => update job path, status, etc.
 * After update, we won't send Slack but we can do so if you prefer
 *************************************************************/
app.patch("/api/accommodations/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const { requestingJobPath, status } = req.body;

    const conn = await mysql.createConnection(dbConfig);
    await conn.execute(`
      UPDATE accommodations
      SET requestingJobPath = ?,
          status = ?
      WHERE id = ?
    `, [requestingJobPath, status, id]);
    await conn.end();
    res.json({ message: "Record updated." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/*************************************************************
 * POST /api/restrictions
 * - Insert or update a record
 * - Always site="BWI2"
 * - default status="Pending"
 * - parse shiftPattern -> shiftType
 * - send Slack
 *************************************************************/
app.post("/api/restrictions", async (req, res) => {
  try {
    const {
      isNew,
      associateName,
      associateLogin,
      managerLogin,
      associateHomePath,
      shiftPattern,
      requestingJobPath,
      requestorLogin,
      startDate,
      endDate,
      aaRestrictions,
      claimNumber,
      existingRecordId
    } = req.body;

    const conn = await mysql.createConnection(dbConfig);

    let newOrUpdatedId;
    let status = "Pending"; // default
    let site = "BWI2";

    if (isNew === "yes") {
      const shiftType = parseShiftPattern(shiftPattern);
      // Insert new
      const [result] = await conn.execute(`
        INSERT INTO accommodations
          (claimNumber, associateLogin, associateName, managerLogin, associateHomePath,
           shiftPattern, shiftType, site, requestingJobPath, requestorLogin,
           startDate, endDate, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        claimNumber, associateLogin, associateName, managerLogin, associateHomePath,
        shiftPattern, shiftType, site, requestingJobPath, requestorLogin,
        startDate, endDate, status
      ]);
      newOrUpdatedId = result.insertId;
    } else {
      // Update existing
      // We'll keep shiftPattern & shiftType from DB unless you want to allow changes
      const [old] = await conn.execute("SELECT shiftPattern FROM accommodations WHERE id = ?", [existingRecordId]);
      const oldPattern = old[0]?.shiftPattern || "";
      const shiftType = parseShiftPattern(oldPattern);

      await conn.execute(`
        UPDATE accommodations
        SET requestingJobPath = ?,
            requestorLogin = ?,
            startDate = ?,
            endDate = ?,
            status = ?,
            site = ?
        WHERE id = ?
      `, [
        requestingJobPath, requestorLogin, startDate, endDate, status, site,
        existingRecordId
      ]);
      newOrUpdatedId = existingRecordId;
    }

    // Re-fetch final record to get associateName, shiftPattern, etc.
    const [finalData] = await conn.execute("SELECT * FROM accommodations WHERE id = ?", [newOrUpdatedId]);
    const record = finalData[0];

    // SHIFT_COUNT: how many are Approved with same shiftType + TLD seated role
    const [sc] = await conn.execute(`
      SELECT COUNT(*) as shiftCount
      FROM accommodations
      WHERE shiftType = ?
        AND status = 'Approved'
        AND (requestingJobPath IN ('Asset tagging','Seated PA role'))
    `, [record.shiftType]);
    const shiftCount = record.shiftType; // e.g. "FHD" for message
    const [st] = await conn.execute(`
      SELECT COUNT(*) as seatedTotal
      FROM accommodations
      WHERE status = 'Approved'
        AND (requestingJobPath IN ('Asset tagging','Seated PA role'))
    `);
    const seatedTotal = st[0].seatedTotal;

    // Send Slack
    await sendSlackMessage({
      associateName: record.associateName,
      associateLogin: record.associateLogin,
      homePath: record.associateHomePath,
      aaRestrictions,
      requestingJobPath: record.requestingJobPath,
      requestorLogin,
      shiftCount,
      seatedTotal
    });

    await conn.end();
    res.json({ message: "Restrictions saved, Slack message sent.", newOrUpdatedId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/*************************************************************
 * GET /api/seatCounts
 *   Return a grid of [day][shiftCode] => seatCount
 *   We do this by:
 *    1) SELECT all Approved + TLD roles
 *    2) parse shiftPattern -> shiftType
 *    3) SHIFT_DAYS map which days that shift covers
 *    4) increment seatCounts in that day/shift
 *************************************************************/
app.get("/api/seatCounts", async (req, res) => {
  try {
    // Build day x shift code grid
    const days = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
    const shiftCodes = ["FHD","FHN","BHD","BHN","FLEX"];

    // Initialize result
    let seatGrid = {};
    days.forEach(d => {
      seatGrid[d] = {};
      shiftCodes.forEach(sc => {
        seatGrid[d][sc] = 0;
      });
    });

    const conn = await mysql.createConnection(dbConfig);
    // fetch all "Approved" + TLD seated roles
    const [rows] = await conn.execute(`
      SELECT shiftPattern, shiftType, requestingJobPath
      FROM accommodations
      WHERE status = 'Approved'
        AND (requestingJobPath IN ('Asset tagging','Seated PA role'))
    `);
    await conn.end();

    // For each record, figure out shiftType => which days => increment seatGrid
    for (let r of rows) {
      let stype = r.shiftType;
      // fallback if shiftType is blank, parse from shiftPattern
      if (!stype || stype === "unknown") {
        stype = parseShiftPattern(r.shiftPattern);
      }
      if (!SHIFT_DAYS[stype]) continue; // skip if not recognized

      // SHIFT_DAYS[stype] => array of days
      SHIFT_DAYS[stype].forEach(day => {
        seatGrid[day][stype] += 1;
      });
    }
    res.json(seatGrid);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
