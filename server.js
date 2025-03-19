/*************************************************************
 * server.js
 *************************************************************/
require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const mysql = require("mysql2/promise");
const fetch = require("node-fetch");
const path = require("path");

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// 1) Serve static files from 'public' folder
app.use(express.static("public"));

// 2) Make '/' default to active-accommodations.html
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "active-accommodations.html"));
});

// 3) Database connection config (from .env)
const dbConfig = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME
};

// 4) Slack webhook URL
const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL || "";

/*************************************************************
 * Utility Functions
 *************************************************************/

// Parse shift pattern => shiftType
function parseShiftPattern(shiftString) {
  if (!shiftString) return "unknown";
  const upperShift = shiftString.toUpperCase();
  if (upperShift.includes("DA") || upperShift.includes("DB") || upperShift.includes("DC")) {
    return "FHD";
  } else if (upperShift.includes("NA")) {
    return "FHN";
  } else if (upperShift.includes("RTN") || upperShift.includes("NB")) {
    return "BHN";
  } else if (upperShift.includes("RTD")) {
    return "BHD";
  } else if (upperShift.includes("FLEXRT") || upperShift.includes("FLEXPT")) {
    return "FLEX";
  }
  return "unknown";
}

// Send Slack message via Incoming Webhook
async function sendSlackMessage(text) {
  if (!slackWebhookUrl) {
    console.warn("SLACK_WEBHOOK_URL not set. Slack messages will not be sent.");
    return;
  }
  try {
    await fetch(slackWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    });
  } catch (err) {
    console.error("Error sending Slack message:", err);
  }
}

/*************************************************************
 * Routes
 *************************************************************/

/**
 * GET /api/accommodations
 * Returns active (Pending/Approved) accommodations
 * Optional query params:
 *   ?site=BWI2
 *   ?shift=FHD
 */
app.get("/api/accommodations", async (req, res) => {
  try {
    const { site, shift } = req.query;
    const connection = await mysql.createConnection(dbConfig);

    let query = `SELECT * FROM accommodations WHERE status IN ('Pending','Approved')`;
    let params = [];
    if (site) {
      query += " AND site = ?";
      params.push(site);
    }
    if (shift) {
      query += " AND shiftType = ?";
      params.push(shift);
    }

    const [rows] = await connection.execute(query, params);
    await connection.end();
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/existingClaims?site=BWI2
 * Fetches existing accommodations for a given site that have status 'Pending' or 'Approved'
 * so user can pick them to update restrictions instead of creating a new record.
 */
app.get("/api/existingClaims", async (req, res) => {
  try {
    const { site } = req.query;
    if (!site) {
      return res.json([]); // or return an error if site is required
    }

    const connection = await mysql.createConnection(dbConfig);
    const [rows] = await connection.execute(`
      SELECT id, claimNumber, associateLogin
      FROM accommodations
      WHERE site = ?
        AND status IN ('Pending','Approved')
    `, [site]);

    await connection.end();
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/accommodations/:id
 * Only updates 'requestingJobPath' for the record, used by the spreadsheet view.
 */
app.patch("/api/accommodations/:id", async (req, res) => {
  try {
    const { requestingJobPath } = req.body;
    const { id } = req.params;

    if (!requestingJobPath) {
      return res.status(400).json({ error: "Missing requestingJobPath" });
    }

    const connection = await mysql.createConnection(dbConfig);
    await connection.execute(`
      UPDATE accommodations
      SET requestingJobPath = ?
      WHERE id = ?
    `, [requestingJobPath, id]);

    await connection.end();
    res.json({ message: "Job path updated" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/restrictions
 * Insert or update an accommodation record, set status=Pending, then send Slack message.
 *
 * Body Example:
 *  {
 *   isNew: "yes" | "no",
 *   site: "BWI2",
 *   associateName: "John Doe",
 *   associateLogin: "jdoe",
 *   managerLogin: "manager123",
 *   associateHomePath: "Crossdock",
 *   shiftPattern: "DA5-1830",
 *   requestingJobPath: "Asset tagging",
 *   requestorLogin: "reqUser",
 *   startDate: "2025-01-01",
 *   endDate: "2025-01-10",
 *   aaRestrictions: "Some text not saved in DB",
 *   claimNumber: "AS34F6840001",
 *   existingRecordId: 123  // if isNew="no"
 *  }
 */
app.post("/api/restrictions", async (req, res) => {
  try {
    const {
      isNew,
      site,
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

    // Basic validations
    if (!site || !requestingJobPath || !requestorLogin || !startDate || !endDate) {
      return res.status(400).json({ error: "Missing required fields (site, job path, requestorLogin, start/end date)." });
    }
    if (isNew === "yes") {
      if (!associateName || !associateLogin || !managerLogin || !associateHomePath || !shiftPattern || !claimNumber) {
        return res.status(400).json({ error: "Missing required fields for new request (associateName, associateLogin, managerLogin, homePath, shiftPattern, claimNumber)." });
      }
    } else if (isNew === "no") {
      if (!existingRecordId) {
        return res.status(400).json({ error: "existingRecordId is required for updating an existing accommodation." });
      }
    } else {
      return res.status(400).json({ error: "Invalid isNew value. Must be 'yes' or 'no'." });
    }

    const connection = await mysql.createConnection(dbConfig);
    const status = "Pending";
    let newOrUpdatedId;

    if (isNew === "yes") {
      // Insert new
      const shiftType = parseShiftPattern(shiftPattern);
      const [result] = await connection.execute(`
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
      await connection.execute(`
        UPDATE accommodations
        SET site = ?,
            requestingJobPath = ?,
            requestorLogin = ?,
            startDate = ?,
            endDate = ?,
            status = ?
        WHERE id = ?
      `, [
        site, requestingJobPath, requestorLogin, startDate, endDate, status,
        existingRecordId
      ]);
      newOrUpdatedId = existingRecordId;
    }

    // For Slack message, we might need to retrieve associate fields if updating existing
    let finalAssociateName = associateName;
    let finalAssociateLogin = associateLogin;
    let finalHomePath = associateHomePath;

    if (isNew === "no") {
      const [rows] = await connection.execute(`
        SELECT associateName, associateLogin, associateHomePath, shiftPattern
        FROM accommodations
        WHERE id = ?
      `, [existingRecordId]);
      if (rows.length) {
        finalAssociateName = rows[0].associateName;
        finalAssociateLogin = rows[0].associateLogin;
        finalHomePath = rows[0].associateHomePath;
        // shiftPattern might also be relevant for seat counting
        shiftPattern = rows[0].shiftPattern;
      }
    }

    // Now calculate shiftCount + seatedTotal for Slack
    const shiftType = parseShiftPattern(shiftPattern);
    // Seated roles array
    const seatedRoles = ["Asset tagging", "Seated PA role"];

    // 1) SHIFT_COUNT for that shiftType + status=Approved + job path in seated roles
    const placeholders = seatedRoles.map(() => "?").join(", ");
    const [shiftCountRows] = await connection.execute(`
      SELECT COUNT(*) as shiftCount
      FROM accommodations
      WHERE shiftType = ?
        AND status = 'Approved'
        AND requestingJobPath IN (${placeholders})
    `, [shiftType, ...seatedRoles]);
    const shiftCount = shiftCountRows[0].shiftCount;

    // 2) SEATED_TOTAL across all shift types
    const [seatedTotalRows] = await connection.execute(`
      SELECT COUNT(*) as seatedTotal
      FROM accommodations
      WHERE status = 'Approved'
        AND requestingJobPath IN (${placeholders})
    `, [...seatedRoles]);
    const seatedTotal = seatedTotalRows[0].seatedTotal;

    await connection.end();

    // Compose Slack message
    const slackMessage = 
`We have received restrictions for ${finalAssociateName} (${finalAssociateLogin})
@channel

Home Path: ${finalHomePath}
Restrictions: ${aaRestrictions}
Recommendation: ${requestingJobPath}

This is an automated message sent out by: ${requestorLogin}

Current seated spots for ${shiftType} : ${shiftCount}
Total Seated accommodations: ${seatedTotal}`;

    await sendSlackMessage(slackMessage);

    res.json({
      message: "Restrictions saved and Slack message sent!",
      newOrUpdatedId
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/*************************************************************
 * Start the Server
 *************************************************************/
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
