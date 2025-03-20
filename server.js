require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
// For Node 18+ CommonJS, ensure node-fetch@2
const fetch = require("node-fetch");
const mysql = require("mysql2/promise");
const path = require("path");

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Serve static files from "public"
app.use(express.static("public"));

// If user visits "/", default to active-accommodations.html
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "active-accommodations.html"));
});

const dbConfig = {
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASS || "",
  database: process.env.DB_NAME || "myaccommodationsdb"
};

const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL || "";

// SHIFT_DAYS to map each shift code => which days it covers
const SHIFT_DAYS = {
  FHD: ["Sunday","Monday","Tuesday","Wednesday"],
  FHN: ["Sunday","Monday","Tuesday","Wednesday"], // nights
  BHD: ["Wednesday","Thursday","Friday","Saturday"],
  BHN: ["Wednesday","Thursday","Friday","Saturday"], // nights
  FLEX: ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"]
};

/*************************************************************
 * parseShiftPattern(shiftString) => returns "FHD","FHN","BHD","BHN","FLEX","unknown"
 *************************************************************/
function parseShiftPattern(shiftString) {
  if (!shiftString) return "unknown";
  const s = shiftString.toUpperCase();
  if (s.includes("DA")) return "FHD";
  if (s.includes("DB")) return "BHD";
  if (s.includes("DC")) return "FHD"; // or special if needed
  if (s.includes("NA")) return "FHN";
  if (s.includes("NB")) return "BHN";
  if (s.includes("RTN")) return "BHN";
  if (s.includes("RT"))  return "BHD";
  if (s.includes("FLEX"))return "FLEX";
  return "unknown";
}

/*************************************************************
 * sendSlackMessage
 *  - references "accommodationRole" as "Recommendation" in the text.
 *************************************************************/
async function sendSlackMessage({
  associateName,
  associateLogin,
  homePath,
  aaRestrictions,
  accommodationRole,
  requestorLogin,
  shiftCount,  // e.g. "FHD"
  seatedTotal
}) {
  if (!slackWebhookUrl) {
    console.warn("Slack webhook not set. Not sending message.");
    return;
  }
  const text =
`We have received restrictions for ${associateName} (${associateLogin})
@channel

Home Path: ${homePath}
Restrictions: ${aaRestrictions}
Recommendation: ${accommodationRole}

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
 * GET /api/accommodations
 *  Return all rows
 *************************************************************/
app.get("/api/accommodations", async (req, res) => {
  try {
    const conn = await mysql.createConnection(dbConfig);
    const [rows] = await conn.execute(`SELECT * FROM accommodations ORDER BY id DESC`);
    await conn.end();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/*************************************************************
 * GET /api/accommodations/:id
 *  Return a single row for editing
 *************************************************************/
app.get("/api/accommodations/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const conn = await mysql.createConnection(dbConfig);
    const [rows] = await conn.execute(`SELECT * FROM accommodations WHERE id = ?`, [id]);
    await conn.end();
    if (rows.length === 0) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/*************************************************************
 * DELETE /api/accommodations/:id
 *  Removes a row from DB
 *************************************************************/
app.delete("/api/accommodations/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const conn = await mysql.createConnection(dbConfig);
    await conn.execute(`DELETE FROM accommodations WHERE id = ?`, [id]);
    await conn.end();
    res.json({ message: "Accommodation deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/*************************************************************
 * POST /api/restrictions
 *  Insert or update an accommodation. Replaces old "requestingJobPath" with:
 *    - accommodationRole (text)
 *    - isSeated (yes/no => 1/0)
 *  SHIFT counts rely on isSeated=1 & status='Approved'.
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
      requestorLogin,
      startDate,
      endDate,
      aaRestrictions,
      claimNumber,
      existingRecordId,

      accommodationRole,  // new
      isSeated            // "yes" or "no"
    } = req.body;

    const conn = await mysql.createConnection(dbConfig);

    const status = "Pending"; // default
    const site = "BWI2";      // as example
    // convert isSeated => 1/0
    const isSeatedVal = (isSeated === "yes") ? 1 : 0;

    let newId;

    if (isNew === "yes") {
      // parse shiftType
      const shiftType = parseShiftPattern(shiftPattern);
      const [inserted] = await conn.execute(`
        INSERT INTO accommodations
          (claimNumber, associateLogin, associateName, managerLogin, associateHomePath,
           shiftPattern, shiftType, site,
           startDate, endDate, status,
           accommodationRole, isSeated
          )
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      `, [
        claimNumber, associateLogin, associateName, managerLogin, associateHomePath,
        shiftPattern, shiftType, site,
        startDate, endDate, status,
        accommodationRole || "", isSeatedVal
      ]);
      newId = inserted.insertId;
    } else {
      // update existing
      // fetch old shiftPattern if needed
      const [rows] = await conn.execute(`SELECT shiftPattern FROM accommodations WHERE id=?`, [existingRecordId]);
      let oldPattern = rows[0]?.shiftPattern || "";
      let shiftType = parseShiftPattern(oldPattern);

      await conn.execute(`
        UPDATE accommodations
        SET claimNumber = ?,
            associateLogin = ?,
            associateName = ?,
            managerLogin = ?,
            associateHomePath = ?,
            startDate = ?,
            endDate = ?,
            status = ?,
            site = ?,
            accommodationRole = ?,
            isSeated = ?
        WHERE id=?
      `, [
        claimNumber, associateLogin, associateName, managerLogin, associateHomePath,
        startDate, endDate, status, site,
        accommodationRole || "", isSeatedVal,
        existingRecordId
      ]);
      newId = existingRecordId;
    }

    // Re-fetch final data to pass to Slack message
    const [finalRows] = await conn.execute(`SELECT * FROM accommodations WHERE id=?`, [newId]);
    const rec = finalRows[0];

    // SHIFT_COUNT => how many "Approved" + isSeated=1 with same shiftType
    // shiftType might come from parseShiftPattern(rec.shiftPattern)
    let finalShiftType = parseShiftPattern(rec.shiftPattern);
    // Count how many
    const [scRows] = await conn.execute(`
      SELECT COUNT(*) as seatCount
      FROM accommodations
      WHERE status='Approved'
        AND isSeated=1
        AND shiftType=?
    `, [finalShiftType]);
    let seatCountCode = finalShiftType; // pass code to Slack
    const seatCount = scRows[0].seatCount;

    // total seated across all shiftTypes
    const [stRows] = await conn.execute(`
      SELECT COUNT(*) as totalSeated
      FROM accommodations
      WHERE status='Approved'
        AND isSeated=1
    `);
    const totalSeated = stRows[0].totalSeated;

    // Slack message references "accommodationRole" in "Recommendation"
    await sendSlackMessage({
      associateName: rec.associateName,
      associateLogin: rec.associateLogin,
      homePath: rec.associateHomePath,
      aaRestrictions,
      accommodationRole: rec.accommodationRole,
      requestorLogin,
      shiftCount: seatCountCode, // e.g. "FHD"
      seatedTotal: totalSeated
    });

    await conn.end();
    res.json({ message: "Restrictions saved, Slack message sent.", newOrUpdatedId: newId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/*************************************************************
 * GET /api/seatCounts
 *  Return a day×shift code grid, counting rows with status='Approved' & isSeated=1
 *************************************************************/
app.get("/api/seatCounts", async (req, res) => {
  try {
    const days = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
    const shiftCodes = ["FHD","FHN","BHD","BHN","FLEX"];
    // build seatGrid
    let seatGrid = {};
    days.forEach(d => {
      seatGrid[d] = {};
      shiftCodes.forEach(sc => {
        seatGrid[d][sc] = 0;
      });
    });

    const conn = await mysql.createConnection(dbConfig);
    // fetch all that are Approved + isSeated=1
    const [rows] = await conn.execute(`
      SELECT shiftPattern, shiftType
      FROM accommodations
      WHERE status='Approved'
        AND isSeated=1
    `);
    await conn.end();

    rows.forEach(r => {
      let st = r.shiftType || parseShiftPattern(r.shiftPattern);
      if (!SHIFT_DAYS[st]) return;
      SHIFT_DAYS[st].forEach(day => {
        seatGrid[day][st] += 1;
      });
    });
    res.json(seatGrid);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
