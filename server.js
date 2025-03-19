require("dotenv").config(); // loads .env if you want to store DB creds there

const express = require("express");
const bodyParser = require("body-parser");
const mysql = require("mysql2/promise");

const app = express();
app.use(bodyParser.urlencoded({ extended: true })); // for Slack urlencoded
app.use(bodyParser.json());                         // in case Slack sends JSON

// Connect to your MySQL database
const dbConfig = {
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASS || "bwi2-amcare!",
  database: process.env.DB_NAME || "myaccommodationsdb"
};

// Example parseShift function
function parseShiftPattern(shiftString) {
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
    return "flex";
  }
  return "unknown";
}

// Endpoint for Slack to POST to
app.post("/slack/webhook", async (req, res) => {
  let payload;

  try {
    // Slack can send data in different formats
    if (req.is("application/json")) {
      payload = req.body;
    } else {
      // If Slack sends urlencoded, parse it
      // Sometimes the real data is in `payload` field
      payload = req.body;
      if (payload.payload) {
        payload = JSON.parse(payload.payload);
      }
    }

    // Extract fields (depending on how your Slack Workflow / slash command is structured)
    const associateLogin = payload.associateLogin || payload.user_name || "unknownLogin";
    const associateName = payload.associateName || "Unknown Name";
    const managerLogin = payload.associateManager || "unknownManager";
    const shiftString = payload.shiftPattern || "";
    const shiftType = parseShiftPattern(shiftString);
    
    const tldRole = payload.tldRole || "";
    // Slack might send isApproved as "true"/"false" or "1"/"0"
    const isApproved = (payload.isApproved === true || payload.isApproved === "true") ? 1 : 0;
    const requestorLogin = payload.requestorLogin || "";
    const approverLogin = payload.approverLogin || "";
    
    const fclmLink = payload.fclmLink || "";
    const rtwLink = payload.rtwLink || "";
    const restrictionsStartDate = payload.restrictionsStartDate || null;
    const restrictionsEndDate = payload.restrictionsEndDate || null;

    // Insert/update in MySQL
    const connection = await mysql.createConnection(dbConfig);

    // Example "upsert" logic:
    //  - If you want to update an existing row with the same associateLogin, do something like:
    await connection.execute(`
      INSERT INTO accommodations 
        (associateLogin, associateName, managerLogin, shiftPattern, shiftType, 
         tldRole, isApproved, requestorLogin, approverLogin, 
         fclmLink, rtwLink, restrictionsStartDate, restrictionsEndDate)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        associateName = VALUES(associateName),
        managerLogin = VALUES(managerLogin),
        shiftPattern = VALUES(shiftPattern),
        shiftType = VALUES(shiftType),
        tldRole = VALUES(tldRole),
        isApproved = VALUES(isApproved),
        requestorLogin = VALUES(requestorLogin),
        approverLogin = VALUES(approverLogin),
        fclmLink = VALUES(fclmLink),
        rtwLink = VALUES(rtwLink),
        restrictionsStartDate = VALUES(restrictionsStartDate),
        restrictionsEndDate = VALUES(restrictionsEndDate)
    `, [
      associateLogin,
      associateName,
      managerLogin,
      shiftString,
      shiftType,
      tldRole,
      isApproved,
      requestorLogin,
      approverLogin,
      fclmLink,
      rtwLink,
      restrictionsStartDate,
      restrictionsEndDate
    ]);

    await connection.end();

    // Respond to Slack
    return res.status(200).json({
      text: `Data stored successfully for ${associateLogin}.`,
    });
  } catch (err) {
    console.error("Error handling Slack webhook:", err);
    return res.status(500).json({
      text: "Server Error",
      error: err.message,
    });
  }
});

// Start your server (listen on port 80 or 443 in production)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server listening on port", PORT);
});
