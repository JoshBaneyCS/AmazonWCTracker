# AmazonWCtracker

A Node.js (Express) application to manage accommodations requests, track seated vs. non-seated TLD roles, integrate with Slack for notifications, and display a spreadsheet-like seat count for each shift.

---

## Features

1. **Accommodations Data**  
   - Store or update accommodations (new vs. existing)  
   - Capture shift pattern, job role, start/end dates, etc.

2. **TLD vs. Non-TLD Roles**  
   - “Asset tagging” and “Seated PA role” are counted as seated  
   - Other TLD and non-TLD roles remain stored but do not affect seat counts

3. **Status Updates**  
   - Mark an accommodation as Pending, Approved, or Expired  
   - Only Approved TLD roles count toward seat totals

4. **Slack Integration**  
   - When a new or updated accommodation is saved, a Slack webhook sends a formatted message with restrictions, recommendations, seat counts, and more

5. **Spreadsheet-Style Seat Counts**  
   - The front-end (active-accommodations.html) displays a day × shift code grid (FHD, FHN, BHD, BHN, FLEX) with seat totals for each day

6. **Auto-Fill Existing Records**  
   - If updating an existing request, the UI fetches and pre-fills the data for modification

---

## Project Structure

AmazonWCtracker/
├── .env                  # Environment variables (NOT in source control)
├── README.md             # This file
├── package.json          # Node.js dependencies and scripts
├── server.js             # Main Express server, Slack logic, DB queries
└── public/
    ├── style.css         # CSS for larger, rounder, centered UI
    ├── active-accommodations.html
    └── update-restrictions.html



---

## Installation

1. **Clone the Repository**  
   ```bash
   git clone https://github.com/YourUsername/AmazonWCtracker.git
   cd AmazonWCtracker
2. **Install Dependencies
 ```bash
npm install
```
- Installs packages such as Express, mysql2, node-fetch, dotenv, etc.
  
3. **Set Up the Database (MySQL/MariaDB)
- Create a database, for example myaccommodationsdb.
```bash
CREATE TABLE accommodations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  claimNumber VARCHAR(50) NOT NULL,
  associateLogin VARCHAR(50) NOT NULL,
  associateName VARCHAR(100),
  managerLogin VARCHAR(50),
  associateHomePath VARCHAR(50),
  shiftPattern VARCHAR(50),
  shiftType VARCHAR(10),
  site VARCHAR(10),
  requestingJobPath VARCHAR(100),
  requestorLogin VARCHAR(50),
  startDate DATE,
  endDate DATE,
  status VARCHAR(20) DEFAULT 'Pending',
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
);
```


