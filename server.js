require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
// If on Node 18+ (CommonJS), ensure node-fetch@2
const fetch = require("node-fetch");
const mysql = require("mysql2/promise");
const path = require("path");

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Serve static files from public/
app.use(express.static("public"));

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

// SHIFT LOGIC
const SHIFT_DAYS = {
  FHD: ["Sunday","Monday","Tuesday","Wednesday"],
  FHN: ["Sunday","Monday","Tuesday","Wednesday"], // nights
  BHD: ["Wednesday","Thursday","Friday","Saturday"],
  BHN: ["Wednesday","Thursday","Friday","Saturday"], // nights
  FLEX: ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"]
};

function parseShiftPattern(shiftString) {
  if (!shiftString) return "unknown";
  const s = shiftString.toUpperCase();
  if (s.includes("DA")) return "FHD";
  if (s.includes("DB")) return "BHD";
  if (s.includes("DC")) return "FHD"; // or special if needed
  if (s.includes("NA")) return "FHN";
  if (s.includes("NB")) return "BHN";
  if (s.includes("RTN"))return "BHN";
  if (s.includes("RT")) return "BHD";
  if (s.includes("FLEX")) return "FLEX";
  return "unknown";
}

// Slack message
async function sendSlackMessage({
  associateName,
  associateLogin,
  homePath,
  aaRestrictions,
  accommodationRole,  // new custom field
  requestorLogin,
  shiftCount,
  seatedTotal
}) {
  if (!slackWebhookUrl) {
    console.warn("No Slack webhook URL set. Not sending message.");
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

// GET all accommodations
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

// GET single
app.get("/api/accommodations/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const conn = await mysql.createConnection(dbConfig);
    const [rows] = await conn.execute(`SELECT * FROM accommodations WHERE id=?`, [id]);
    await conn.end();
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE single
app.delete("/api/accommodations/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const conn = await mysql.createConnection(dbConfig);
    await conn.execute(`DELETE FROM accommodations WHERE id=?`, [id]);
    await conn.end();
    res.json({ message: "Accommodation deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/accommodations/:id
 * - Let user edit "accommodationRole" (text) and "status" from the main table.
 * - We'll store isSeated, start/end date as is, read-only from this page.
 */
app.patch("/api/accommodations/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { accommodationRole, status } = req.body; // from user input
    const conn = await mysql.createConnection(dbConfig);
    // Update only the relevant fields
    await conn.execute(`
      UPDATE accommodations
      SET accommodationRole = ?,
          status = ?
      WHERE id = ?
    `, [accommodationRole, status, id]);
    await conn.end();
    res.json({ message: "Accommodation updated." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// seatCounts: build day×shift code grid from Approved + isSeated=1
app.get("/api/seatCounts", async (req, res) => {
  try {
    const days = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
    const shiftCodes = ["FHD","FHN","BHD","BHN","FLEX"];
    let seatGrid = {};
    days.forEach(d => {
      seatGrid[d] = {};
      shiftCodes.forEach(sc => {
        seatGrid[d][sc] = 0;
      });
    });

    const conn = await mysql.createConnection(dbConfig);
    const [rows] = await conn.execute(`
      SELECT shiftPattern, shiftType 
      FROM accommodations
      WHERE status='Approved' 
        AND isSeated=1
    `);
    await conn.end();

    // Tally day by day
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

/**
 * POST /api/restrictions
 *   Insert or update accommodation 
 *   (See previous code; user chooses isSeated, role, etc.)
 */
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

      accommodationRole,
      isSeated
    } = req.body;

    const conn = await mysql.createConnection(dbConfig);
    const status = "Pending"; 
    const site = "BWI2";
    const isSeatedVal = (isSeated === "yes") ? 1 : 0;
    let newId;

    if (isNew === "yes") {
      let shiftType = parseShiftPattern(shiftPattern);
      let [ins] = await conn.execute(`
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
        accommodationRole||"", isSeatedVal
      ]);
      newId = ins.insertId;
    } else {
      // update existing
      let [old] = await conn.execute(`SELECT shiftPattern FROM accommodations WHERE id=?`, [existingRecordId]);
      let oldPat = old[0]?.shiftPattern || "";
      let shiftType = parseShiftPattern(oldPat);

      await conn.execute(`
        UPDATE accommodations
        SET claimNumber=?,
            associateLogin=?,
            associateName=?,
            managerLogin=?,
            associateHomePath=?,
            startDate=?,
            endDate=?,
            status=?,
            site=?,
            accommodationRole=?,
            isSeated=?
        WHERE id=?
      `, [
        claimNumber, associateLogin, associateName, managerLogin, associateHomePath,
        startDate, endDate, status, site,
        accommodationRole||"", isSeatedVal,
        existingRecordId
      ]);
      newId = existingRecordId;
    }

    // fetch final row => slack
    let [finalRow] = await conn.execute(`SELECT * FROM accommodations WHERE id=?`, [newId]);
    let rec = finalRow[0];

    // seat count logic
    let finalShiftType = parseShiftPattern(rec.shiftPattern);
    let [sc] = await conn.execute(`
      SELECT COUNT(*) as seatCount
      FROM accommodations
      WHERE status='Approved'
        AND isSeated=1
        AND shiftType=?
    `, [finalShiftType]);

    let shiftCount = finalShiftType;
    let seatCount = sc[0].seatCount;

    let [st] = await conn.execute(`
      SELECT COUNT(*) as totalSeated
      FROM accommodations
      WHERE status='Approved'
        AND isSeated=1
    `);
    let totalSeated = st[0].totalSeated;

    await sendSlackMessage({
      associateName: rec.associateName,
      associateLogin: rec.associateLogin,
      homePath: rec.associateHomePath,
      aaRestrictions,
      accommodationRole: rec.accommodationRole,
      requestorLogin,
      shiftCount,
      seatedTotal: totalSeated
    });

    await conn.end();
    res.json({ message: "Restrictions saved, Slack message sent.", newOrUpdatedId: newId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT||3000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
