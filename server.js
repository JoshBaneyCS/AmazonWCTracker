require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const fetch = require("node-fetch"); // node-fetch@2 for CommonJS
const mysql = require("mysql2/promise");
const path = require("path");

// 1. Install & require these for file uploads + sending to Slack
const multer = require("multer");
const FormData = require("form-data");
const axios = require("axios");

// 2. Use memory storage so we don't store the file on disk
const upload = multer({ storage: multer.memoryStorage() });

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.use(express.static("public"));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "active-accommodations.html"));
});

// Database config
const dbConfig = {
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASS || "",
  database: process.env.DB_NAME || "myaccommodationsdb"
};

// Slack config
const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL || "";
const slackBotToken = process.env.SLACK_BOT_TOKEN || "";
const slackChannelId = process.env.SLACK_CHANNEL_ID || "";

// SHIFT map
const SHIFT_DAYS = {
  FHD: ["Sunday","Monday","Tuesday","Wednesday"],
  FHN: ["Sunday","Monday","Tuesday","Wednesday"], // nights
  BHD: ["Wednesday","Thursday","Friday","Saturday"],
  BHN: ["Wednesday","Thursday","Friday","Saturday"], // nights
  FLEX: ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"]
};

// parseShiftPattern => FHD, FHN, BHD, BHN, FLEX, unknown
function parseShiftPattern(s) {
  if (!s) return "unknown";
  let up = s.toUpperCase();
  if (up.includes("DA")) return "FHD";
  if (up.includes("DB")) return "BHD";
  if (up.includes("DC")) return "FHD"; 
  if (up.includes("NA")) return "FHN";
  if (up.includes("NB")) return "BHN";
  if (up.includes("RTN"))return "BHN";
  if (up.includes("RT"))  return "BHD";
  if (up.includes("FLEX"))return "FLEX";
  return "unknown";
}

// Only raw data is sent to Slack
async function sendSlackMessage({
  associateName,
  associateLogin,
  homePath,
  shiftPattern,
  managerLogin,
  aaRestrictions,
  accommodationRole,
  requestorLogin,
  shiftCount,
  seatedTotal
}) {
  if (!slackWebhookUrl) {
    console.warn("No Slack webhook URL set. Not sending message.");
    return;
  }

  // We are only sending the raw data for Slack's own formatting
  const payload = {
    associateName,
    associateLogin,
    homePath,
    shiftPattern,
    managerLogin,
    aaRestrictions,
    accommodationRole,
    requestorLogin,
    shiftCount,
    seatedTotal
  };

  try {
    const response = await fetch(slackWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      console.error("Slack responded with error:", await response.text());
    }
  } catch (err) {
    console.error("Error sending Slack message:", err);
  }
}

// GET /api/accommodations
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

// GET /api/accommodations/:id
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

// DELETE /api/accommodations/:id
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

// PATCH /api/accommodations/:id (update accommodationRole + status)
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
 * Returns { dayGrid, distinctCounts }
 * dayGrid => daily coverage
 * distinctCounts => how many distinct rows are Approved + isSeated=1
 */
app.get("/api/seatCounts", async (req, res) => {
  try {
    const days = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
    const shiftCodes = ["FHD","FHN","BHD","BHN","FLEX"];

    // Build day coverage
    let dayGrid = {};
    days.forEach(d => {
      dayGrid[d] = {};
      shiftCodes.forEach(sc => {
        dayGrid[d][sc] = 0;
      });
    });

    const conn = await mysql.createConnection(dbConfig);
    // daily coverage for each row
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

    // distinct counts
    const [approvedRows] = await conn.execute(`
      SELECT shiftPattern, shiftType
      FROM accommodations
      WHERE status='Approved'
        AND isSeated=1
    `);
    await conn.end();

    let distinctCounts = { FHD:0, FHN:0, BHD:0, BHN:0, FLEX:0 };
    approvedRows.forEach(r => {
      let st = r.shiftType || parseShiftPattern(r.shiftPattern);
      if (distinctCounts[st] !== null) {
        distinctCounts[st] += 1;
      }
    });

    res.json({ dayGrid, distinctCounts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. The main difference: memory file upload + Slack file
app.post("/api/restrictions", upload.single("supportingDocument"), async (req, res) => {
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

    if (!req.file) {
      return res.status(400).json({ error: "File upload is required." });
    }

    const isSeatedVal = (isSeated === "yes") ? 1 : 0;
    const site = "BWI2";
    const status = "Pending";
    let newId;

    // Connect to DB
    const conn = await mysql.createConnection(dbConfig);

    if (isNew === "yes") {
      let shiftType = parseShiftPattern(shiftPattern);
      let [ins] = await conn.execute(`
        INSERT INTO accommodations
          (claimNumber, associateLogin, associateName, managerLogin, associateHomePath,
           shiftPattern, shiftType, site,
           startDate, endDate, status,
           accommodationRole, isSeated)
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
        SET claimNumber=?, associateLogin=?, associateName=?, managerLogin=?,
            associateHomePath=?, startDate=?, endDate=?, status=?, site=?,
            accommodationRole=?, isSeated=?
        WHERE id=?
      `, [
        claimNumber, associateLogin, associateName, managerLogin, associateHomePath,
        startDate, endDate, status, site,
        accommodationRole||"", isSeatedVal,
        existingRecordId
      ]);
      newId = existingRecordId;
    }

    // Slack: first upload the file to Slack using Slack's "files.upload"
    if (!slackBotToken) {
      console.warn("No Slack Bot Token set (SLACK_BOT_TOKEN). Can't upload file.");
    } else {
      // Build formData for Slack file upload
      const formData = new FormData();
      formData.append("file", req.file.buffer, req.file.originalname);
      formData.append("channels", slackChannelId);
      formData.append("filename", req.file.originalname);
      formData.append("initial_comment", "Supporting Document Uploaded");

      try {
        const fileResp = await axios.post("https://slack.com/api/files.upload", formData, {
          headers: {
            ...formData.getHeaders(),
            Authorization: `Bearer ${slackBotToken}`
          }
        });
        if (!fileResp.data.ok) {
          console.error("Slack File Upload Error:", fileResp.data);
        }
      } catch (err) {
        console.error("Error uploading file to Slack:", err);
      }
    }

    // Now send your raw data approach to Slack
    let [finalRow] = await conn.execute("SELECT * FROM accommodations WHERE id=?", [newId]);
    let rec = finalRow[0];

    // seat counting
    let finalShiftType = parseShiftPattern(rec.shiftPattern);
    let [s1] = await conn.execute(`
      SELECT COUNT(*) as seatCount
      FROM accommodations
      WHERE status='Approved'
        AND isSeated=1
        AND shiftType=?
    `, [finalShiftType]);
    let seatCount = s1[0].seatCount;

    let [s2] = await conn.execute(`
      SELECT COUNT(*) as totalSeated
      FROM accommodations
      WHERE status='Approved'
        AND isSeated=1
    `);
    let totalSeated = s2[0].totalSeated;

    await conn.end();

    // Slack raw data
    await sendSlackMessage({
      associateName: rec.associateName,
      associateLogin: rec.associateLogin,
      homePath: rec.associateHomePath,
      shiftPattern: rec.shiftPattern,
      managerLogin: rec.managerLogin,
      aaRestrictions,
      accommodationRole: rec.accommodationRole,
      requestorLogin,
      shiftCount: finalShiftType,
      seatedTotal: totalSeated
    });

    res.json({ message: "Restrictions saved, file sent to Slack." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Listen
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
