require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
// For Node18+ + CommonJS, use node-fetch@2 so require() works:
const fetch = require("node-fetch");
const mysql = require("mysql2/promise");
const path = require("path");

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

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

// SHIFT map
const SHIFT_DAYS = {
  FHD: ["Sunday","Monday","Tuesday","Wednesday"],
  FHN: ["Sunday","Monday","Tuesday","Wednesday"], // nights
  BHD: ["Wednesday","Thursday","Friday","Saturday"],
  BHN: ["Wednesday","Thursday","Friday","Saturday"], // nights
  FLEX: ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"]
};

/** parseShiftPattern => FHD, FHN, BHD, BHN, FLEX, unknown */
function parseShiftPattern(s) {
  if (!s) return "unknown";
  let up = s.toUpperCase();
  if (up.includes("DA")) return "FHD";
  if (up.includes("DB")) return "BHD";
  if (up.includes("DC")) return "FHD"; // or special
  if (up.includes("NA")) return "FHN";
  if (up.includes("NB")) return "BHN";
  if (up.includes("RTN"))return "BHN";
  if (up.includes("RT")) return "BHD";
  if (up.includes("FLEX")) return "FLEX";
  return "unknown";
}

/** sendSlackMessage - references accommodationRole as "Recommendation" */
async function sendSlackMessage({
  associateName,
  associateLogin,
  homePath,
  aaRestrictions,
  accommodationRole,
  requestorLogin,
  shiftCount,    // e.g. "FHD"
  seatedTotal
}) {
  if (!slackWebhookUrl) {
    console.warn("No Slack webhook URL set. Not sending message.");
    return;
  }
  let text =
`We have received restrictions for ${associateName} (${associateLogin})
@channel

Home Path: ${homePath}
Restrictions: ${aaRestrictions}
Recommendation: ${accommodationRole}

This is an automated message sent out by: ${requestorLogin}

Current seated spots for ${shiftCount} :
Total Seated accommodations: ${seatedTotal}`;

  try {
    let resp = await fetch(slackWebhookUrl, {
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

// GET /api/accommodations
app.get("/api/accommodations", async (req, res) => {
  try {
    const conn = await mysql.createConnection(dbConfig);
    // We'll do a small date format fix in SQL or let front-end handle it
    // but for simplicity, we just return raw data here
    const [rows] = await conn.execute("SELECT * FROM accommodations ORDER BY id DESC");
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
    const [rows] = await conn.execute("SELECT * FROM accommodations WHERE id=?", [id]);
    await conn.end();
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE
app.delete("/api/accommodations/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const conn = await mysql.createConnection(dbConfig);
    await conn.execute("DELETE FROM accommodations WHERE id=?", [id]);
    await conn.end();
    res.json({ message: "Accommodation deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/accommodations/:id
 * - update accommodationRole + status from active-accommodations table
 */
app.patch("/api/accommodations/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { accommodationRole, status } = req.body;
    const conn = await mysql.createConnection(dbConfig);
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

/**
 * GET /api/seatCounts
 *  Returns:
 *   {
 *     dayGrid: { Sunday: {FHD: #, FHN: #, ...}, Monday: {...}, ... },
 *     distinctCounts: { FHD: #, FHN: #, BHD: #, BHN: #, FLEX: # }
 *   }
 * For daily coverage, we add 1 to each day SHIFT_DAYS[shiftType].
 * For distinct counts, we do a separate query grouped by shiftType
 */
app.get("/api/seatCounts", async (req, res) => {
  try {
    const days = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
    const shiftCodes = ["FHD","FHN","BHD","BHN","FLEX"];

    // Build day grid
    let dayGrid = {};
    days.forEach(d => {
      dayGrid[d] = {};
      shiftCodes.forEach(sc => {
        dayGrid[d][sc] = 0;
      });
    });

    const conn = await mysql.createConnection(dbConfig);
    // 1) daily coverage
    const [rows] = await conn.execute(`
      SELECT shiftPattern, shiftType
      FROM accommodations
      WHERE status='Approved'
        AND isSeated=1
    `);
    rows.forEach(r => {
      let st = r.shiftType || parseShiftPattern(r.shiftPattern);
      if (!SHIFT_DAYS[st]) return;
      SHIFT_DAYS[st].forEach(day => {
        dayGrid[day][st] += 1; 
      });
    });

    // 2) distinct counts
    //   how many distinct DB rows are Approved + isSeated=1 for each shift code
    //   We'll parse shiftPattern if shiftType is blank
    //   easiest is to do it in JS or do SHIFT_DAYS + group in memory
    // For a straightforward approach:
    const [approvedRows] = await conn.execute(`
      SELECT shiftPattern, shiftType
      FROM accommodations
      WHERE status='Approved'
        AND isSeated=1
    `);
    await conn.end();

    // We'll count how many distinct rows for each shift code
    let distinctCounts = { FHD:0, FHN:0, BHD:0, BHN:0, FLEX:0 };
    approvedRows.forEach(r => {
      let st = r.shiftType || parseShiftPattern(r.shiftPattern);
      if (distinctCounts[st] !== undefined) {
        distinctCounts[st] += 1;
      }
    });

    // Return both in a combined object
    res.json({
      dayGrid, 
      distinctCounts
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/restrictions => Insert or update
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
      let [old] = await conn.execute("SELECT shiftPattern FROM accommodations WHERE id=?", [existingRecordId]);
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

    // fetch final
    let [finalRow] = await conn.execute("SELECT * FROM accommodations WHERE id=?", [newId]);
    let rec = finalRow[0];
    // seat count for that shift
    let finalShiftType = parseShiftPattern(rec.shiftPattern);
    // how many for that shift
    let [s1] = await conn.execute(`
      SELECT COUNT(*) as seatCount
      FROM accommodations
      WHERE status='Approved'
        AND isSeated=1
        AND shiftType=?
    `, [finalShiftType]);
    let shiftCount = finalShiftType;
    let seatCount = s1[0].seatCount;
    // total seated
    let [s2] = await conn.execute(`
      SELECT COUNT(*) as totalSeated
      FROM accommodations
      WHERE status='Approved'
        AND isSeated=1
    `);
    let totalSeated = s2[0].totalSeated;

    await conn.end();

    // Slack
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

    res.json({ message: "Restrictions saved, Slack message sent.", newOrUpdatedId: newId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
