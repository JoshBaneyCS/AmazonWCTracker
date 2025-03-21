// server.js - Complete Version with all functionalities
require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
// For Node 18+ + CommonJS, use node-fetch@2 (installed as node-fetch@2)
const fetch = require("node-fetch");
const mysql = require("mysql2/promise");
const path = require("path");
const cron = require("node-cron");

// For file uploads and sending file to S3/Slack
const multer = require("multer");
const FormData = require("form-data");
const axios = require("axios");

// AWS SDK setup for S3 file upload
const AWS = require("aws-sdk");
AWS.config.update({
  region: process.env.AWS_REGION, 
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
});
const s3 = new AWS.S3();

// Use multer memory storage so files are not saved to disk
const upload = multer({ storage: multer.memoryStorage() });

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Serve static files from "public" directory
app.use(express.static("public"));

// Default route to active-accommodations.html
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "active-accommodations.html"));
});

// Database configuration
const dbConfig = {
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASS || "",
  database: process.env.DB_NAME || "myaccommodationsdb"
};

// Slack configuration from .env
const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL || "";
const slackBotToken = process.env.SLACK_BOT_TOKEN || "";
const slackChannelId = process.env.SLACK_CHANNEL_ID || "";

// SHIFT mapping for seat counting
const SHIFT_DAYS = {
  FHD: ["Sunday", "Monday", "Tuesday", "Wednesday"],
  FHN: ["Sunday", "Monday", "Tuesday", "Wednesday"], // nights
  BHD: ["Wednesday", "Thursday", "Friday", "Saturday"],
  BHN: ["Wednesday", "Thursday", "Friday", "Saturday"], // nights
  FLEX: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
};

/**
 * parseShiftPattern(s)
 * Returns one of: "FHD", "FHN", "BHD", "BHN", "FLEX", or "unknown"
 */
function parseShiftPattern(s) {
  if (!s) return "unknown";
  const up = s.toUpperCase();
  if (up.includes("DA")) return "FHD";
  if (up.includes("DB")) return "BHD";
  if (up.includes("DC")) return "FHD"; // Customize as needed
  if (up.includes("NA")) return "FHN";
  if (up.includes("NB")) return "BHN";
  if (up.includes("RTN")) return "BHN";
  if (up.includes("RT"))  return "BHD";
  if (up.includes("FLEX")) return "FLEX";
  return "unknown";
}
cron.schedule('0 0 * * *', async () => {
  try {
    const conn = await mysql.createConnection(dbConfig);
    await conn.execute(`
      UPDATE accommodations
      SET status = 'Pending updated Restrictions'
      WHERE endDate < CURDATE() AND status != 'Pending updated Restrictions'
    `);
    await conn.end();
    console.log("Automatically updated restrictions status for expired records.");
  } catch (err) {
    console.error("Error updating restrictions status:", err);
  }
});
/**
 * sendSlackMessage: Sends raw data to Slack.
 * The payload includes fields such as associateName, homePath, shiftPattern, etc.
 * Slack's workflow will format the final message.
 */
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
  seatedTotal,
  fileUrl // S3 file URL
}) {
  if (!slackWebhookUrl) {
    console.warn("No Slack webhook URL set. Not sending message.");
    return;
  }

  // Build the payload containing only raw data variables.
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
    seatedTotal,
    fileUrl
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

// GET /api/accommodations: Return all accommodations.
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

// GET /api/accommodations/:id: Return single record by ID.
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

// DELETE /api/accommodations/:id: Delete a record.
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

// PATCH /api/accommodations/:id: Update accommodationRole and status.
app.patch("/api/accommodations/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const accommodationRole = req.body.accommodationRole ?? "";
    const status = req.body.status ?? "Pending";
    const conn = await mysql.createConnection(dbConfig);
    await conn.execute(
      "UPDATE accommodations SET accommodationRole = ?, status = ? WHERE id = ?",
      [accommodationRole, status, id]
    );
    await conn.end();
    res.json({ message: "Accommodation updated." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/seatCounts
 * Returns an object with:
 *  - dayGrid: daily coverage (each row can count multiple times)
 *  - distinctCounts: count of distinct records per shift code (for "Total" column)
 */
app.get("/api/seatCounts", async (req, res) => {
  try {
    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const shiftCodes = ["FHD", "FHN", "BHD", "BHN", "FLEX"];

    // Initialize day grid: for each day, count coverage
    let dayGrid = {};
    days.forEach(day => {
      dayGrid[day] = {};
      shiftCodes.forEach(code => {
        dayGrid[day][code] = 0;
      });
    });

    const conn = await mysql.createConnection(dbConfig);
    // Fetch all records that are Approved and marked as seated
    const [rows] = await conn.execute(`
      SELECT shiftPattern, shiftType
      FROM accommodations
      WHERE status='Approved' AND isSeated=1
    `);
    rows.forEach(r => {
      let st = r.shiftType || parseShiftPattern(r.shiftPattern);
      if (!SHIFT_DAYS[st]) return;
      SHIFT_DAYS[st].forEach(day => {
        dayGrid[day][st] += 1;
      });
    });

    // For "Total": count distinct records per shift code.
    const [approvedRows] = await conn.execute(`
      SELECT shiftPattern, shiftType
      FROM accommodations
      WHERE status='Approved' AND isSeated=1
    `);
    await conn.end();

    let distinctCounts = { FHD: 0, FHN: 0, BHD: 0, BHN: 0, FLEX: 0 };
    approvedRows.forEach(r => {
      let st = r.shiftType || parseShiftPattern(r.shiftPattern);
      if (distinctCounts[st] !== undefined) distinctCounts[st] += 1;
    });

    res.json({ dayGrid, distinctCounts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/restrictions
 * Inserts or updates an accommodation record.
 * - If isNew === "yes", checks if an entry with the same Claim# exists.
 *   - If yes, updates the record.
 *   - Otherwise, inserts a new record.
 * - Handles file upload in memory, uploads file to S3, and gets public URL.
 * - Sends raw data (including S3 file URL) to Slack.
 */
app.post("/api/restrictions", upload.single("supportingDocument"), async (req, res) => {
  try {
    // Provide default values to avoid undefined.
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

    // Ensure file is uploaded
    if (!req.file) {
      return res.status(400).json({ error: "File upload is required." });
    }

    const site = "BWI2";
    const status = "Pending";

       // Upload file to S3
    const s3Params = {
      Bucket: process.env.AWS_S3_BUCKET,
      Key: Date.now() + "_" + req.file.originalname,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
      // ACL is omitted because your bucket blocks ACLs
    };
    const s3Result = await s3.upload(s3Params).promise();
    
    // Generate a pre-signed URL that expires in 4 days (345600 seconds)
    const fileUrl = s3.getSignedUrl('getObject', {
      Bucket: process.env.AWS_S3_BUCKET,
      Key: s3Params.Key,
      Expires: 345600
    });
    
    // Use fileUrl for your Slack payload
    const conn = await mysql.createConnection(dbConfig);
    let newId;

    if (isNew === "yes") {
      // Check for duplicate Claim#
      let [existing] = await conn.execute("SELECT * FROM accommodations WHERE claimNumber=?", [claimNumber]);
      if (existing.length > 0) {
        newId = existing[0].id;
        await conn.execute(`
          UPDATE accommodations
          SET associateLogin = ?, associateName = ?, managerLogin = ?, associateHomePath = ?,
              shiftPattern = ?, startDate = ?, endDate = ?, status = ?, site = ?,
              accommodationRole = ?, isSeated = ?
          WHERE id = ?
        `, [
          associateLogin, associateName, managerLogin, associateHomePath,
          shiftPattern, startDate, endDate, status, site,
          accommodationRole, isSeatedVal,
          newId
        ]);
      } else {
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
          accommodationRole, isSeatedVal
        ]);
        newId = ins.insertId;
      }
    } else {
      // isNew === "no": update existing record
      if (!existingRecordId) {
        await conn.end();
        return res.status(400).json({ error: "No existingRecordId provided." });
      }
      let [old] = await conn.execute("SELECT * FROM accommodations WHERE id=?", [existingRecordId]);
      if (!old.length) {
        await conn.end();
        return res.status(400).json({ error: "No existing record found for the given ID." });
      }
      let oldPat = old[0].shiftPattern ?? "";
      let shiftType = parseShiftPattern(oldPat);
      await conn.execute(`
        UPDATE accommodations
        SET claimNumber = ?, associateLogin = ?, associateName = ?, managerLogin = ?,
            associateHomePath = ?, startDate = ?, endDate = ?, status = ?, site = ?,
            accommodationRole = ?, isSeated = ?
        WHERE id = ?
      `, [
        claimNumber, associateLogin, associateName, managerLogin,
        associateHomePath, startDate, endDate, status, site,
        accommodationRole, isSeatedVal,
        existingRecordId
      ]);
      newId = existingRecordId;
    }

    // For Slack message, fetch final record
    let [finalRow] = await conn.execute("SELECT * FROM accommodations WHERE id=?", [newId]);
    let rec = finalRow[0];
    const finalShiftType = parseShiftPattern(rec.shiftPattern);
    let [s1] = await conn.execute(`
      SELECT COUNT(*) as seatCount
      FROM accommodations
      WHERE status='Approved' AND isSeated=1 AND shiftType=?
    `, [finalShiftType]);
    let seatCount = s1[0].seatCount;
    let [s2] = await conn.execute(`
      SELECT COUNT(*) as totalSeated
      FROM accommodations
      WHERE status='Approved' AND isSeated=1
    `);
    let totalSeated = s2[0].totalSeated;
    await conn.end();

    // Send Slack raw data with fileUrl
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
      seatedTotal: totalSeated,
      fileUrl
    });

    res.json({ message: "Restrictions saved, file sent to Slack." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
