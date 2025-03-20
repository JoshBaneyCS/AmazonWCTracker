require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
// For Node18+ + CommonJS, use node-fetch@2 so require() works:
const fetch = require("node-fetch");
const mysql = require("mysql2/promise");
const path = require("path");

// For memory-based file upload + Slack
const multer = require("multer");
const FormData = require("form-data");
const axios = require("axios");

// Multer in-memory storage
const upload = multer({ storage: multer.memoryStorage() });

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

/** parseShiftPattern => FHD, FHN, BHD, BHN, FLEX, unknown */
function parseShiftPattern(s) {
  if (!s) return "unknown";
  const up = s.toUpperCase();
  if (up.includes("DA")) return "FHD";
  if (up.includes("DB")) return "BHD";
  if (up.includes("DC")) return "FHD";
  if (up.includes("NA")) return "FHN";
  if (up.includes("NB")) return "BHN";
  if (up.includes("RTN")) return "BHN";
  if (up.includes("RT"))  return "BHD";
  if (up.includes("FLEX"))return "FLEX";
  return "unknown";
}

// Raw data approach for Slack
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
  // Just send raw data, Slack does final formatting
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

/** GET /api/accommodations => Return all records */
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

/** GET /api/accommodations/:id => Return a single record */
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

/** DELETE /api/accommodations/:id */
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

/** PATCH /api/accommodations/:id => update accommodationRole + status */
app.patch("/api/accommodations/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const accommodationRole = req.body.accommodationRole ?? "";
    const status = req.body.status ?? "Pending";

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
 * GET /api/seatCounts => daily coverage + distinct counts
 * returns { dayGrid, distinctCounts }
 */
app.get("/api/seatCounts", async (req, res) => {
  try {
    const days = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
    const shiftCodes = ["FHD","FHN","BHD","BHN","FLEX"];

    let dayGrid = {};
    days.forEach(d => {
      dayGrid[d] = {};
      shiftCodes.forEach(sc => {
        dayGrid[d][sc] = 0;
      });
    });

    const conn = await mysql.createConnection(dbConfig);
    // daily coverage
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
      if (distinctCounts[st] !== undefined) {
        distinctCounts[st] += 1;
      }
    });

    res.json({ dayGrid, distinctCounts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/restrictions => Insert or update. 
 * file upload + seat logic + Slack
 * We also check if the existing record actually exists if isNew="no"
 */
app.post("/api/restrictions", upload.single("supportingDocument"), async (req, res) => {
  try {
    // Provide default strings for each field
    const isNew = req.body.isNew ?? "yes";
    const associateName = req.body.associateName ?? "";
    const associateLogin = req.body.associateLogin ?? "";
    const managerLogin = req.body.managerLogin ?? "";
    const associateHomePath = req.body.associateHomePath ?? "";
    const shiftPattern = req.body.shiftPattern ?? "";
    const requestorLogin = req.body.requestorLogin ?? "";
    const startDate = req.body.startDate ?? "";
    const endDate = req.body.endDate ?? "";
    const aaRestrictions = req.body.aaRestrictions ?? "";
    const claimNumber = req.body.claimNumber ?? "";
    const existingRecordId = req.body.existingRecordId ?? "";
    const accommodationRole = req.body.accommodationRole ?? "";
    const isSeatedVal = (req.body.isSeated === "yes") ? 1 : 0;

    if (!req.file) {
      return res.status(400).json({ error: "File upload is required." });
    }

    const site = "BWI2";
    const status = "Pending";

    const conn = await mysql.createConnection(dbConfig);
    let newId;

    // =========================
    // Insert or Update
    // =========================
    if (isNew === "yes") {
      // Insert new
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
        accommodationRole, isSeatedVal
      ]);
      newId = ins.insertId;

    } else {
      // "no" => must update existing
      // Check if row actually exists in DB
      if (!existingRecordId) {
        await conn.end();
        return res.status(400).json({ error: "No existingRecordId provided." });
      }

      let [old] = await conn.execute("SELECT * FROM accommodations WHERE id=?", [existingRecordId]);
      if (!old.length) {
        // record not found
        await conn.end();
        return res.status(400).json({ error: "No existing record found for the given ID." });
      }

      // If record found, do the update
      const oldPat = old[0].shiftPattern ?? "";
      const shiftType = parseShiftPattern(oldPat);

      await conn.execute(`
        UPDATE accommodations
        SET claimNumber=?, associateLogin=?, associateName=?, managerLogin=?,
            associateHomePath=?, startDate=?, endDate=?, status=?, site=?,
            accommodationRole=?, isSeated=?
        WHERE id=?
      `, [
        claimNumber, associateLogin, associateName, managerLogin,
        associateHomePath, startDate, endDate, status, site,
        accommodationRole, isSeatedVal,
        existingRecordId
      ]);
      newId = existingRecordId;
    }

    // Slack: File upload
    if (!slackBotToken) {
      console.warn("No Slack Bot Token. Skipping file upload to Slack.");
    } else {
      try {
        const formData = new FormData();
        formData.append("file", req.file.buffer, req.file.originalname);
        formData.append("channels", slackChannelId);
        formData.append("filename", req.file.originalname);
        formData.append("initial_comment", "Supporting Document Uploaded");

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

    // seat counting for Slack message
    let [finalRow] = await conn.execute("SELECT * FROM accommodations WHERE id=?", [newId]);
    let rec = finalRow[0];
    const finalShiftType = parseShiftPattern(rec.shiftPattern);

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
      associateName: rec.associateName ?? "",
      associateLogin: rec.associateLogin ?? "",
      homePath: rec.associateHomePath ?? "",
      shiftPattern: rec.shiftPattern ?? "",
      managerLogin: rec.managerLogin ?? "",
      aaRestrictions,
      accommodationRole: rec.accommodationRole ?? "",
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
